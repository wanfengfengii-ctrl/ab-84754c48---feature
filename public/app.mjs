// 页面逻辑：草稿（localStorage 持久化）、失效标记、调用精确编排模型、渲染结果、
// 逐卡播审（快照冻结 + 只追加事件重放，见 src/review.mjs）。
import { plan, InputError } from '../src/model.mjs';
import { fracToText, unitsToText } from '../src/decimal.mjs';
import {
  createReview,
  replay,
  fingerprint,
  verdictEvent,
  pauseEvent,
  resumeEvent,
  microsToSeconds,
  serializeReview,
  deserializeReview,
} from '../src/review.mjs';

const STORE_KEY = 'subtitle-planner-draft-v1';
const REVIEW_KEY = 'subtitle-planner-reviews-v1';
const REVIEW_LIMIT = 20;

const SAMPLE = {
  params: { cardCount: '4', maxPerCard: '3', rateZh: '6', rateEn: '9' },
  units: [
    { start: '0.0', end: '2.0', zh: '10', en: '15' },
    { start: '2.2', end: '5.0', zh: '14', en: '22' },
    { start: '5.5', end: '8.0', zh: '12', en: '18' },
    { start: '9.0', end: '12.0', zh: '16', en: '24' },
    { start: '12.5', end: '15.0', zh: '11', en: '17' },
    { start: '16.0', end: '19.0', zh: '15', en: '23' },
    { start: '19.5', end: '22.0', zh: '9', en: '14' },
    { start: '23.0', end: '26.0', zh: '13', en: '20' },
  ],
};

const $ = (id) => document.getElementById(id);

let draft = loadDraft();
let lastResult = null;   // 最近一次成功编排的结果
let stale = false;       // 草稿在上次编排后被改过

// 播审：reviews 为只追加历史（新的在前）；activeId 为当前查看/进行中的播审。
let reviews = loadReviews();
let activeId = reviews.length ? reviews[0].reviewId : null;

let timer = null;
let expandedHistory = null; // 展开查看的历史播审 id

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && d.params && Array.isArray(d.units) && d.units.length >= 8) return d;
    }
  } catch { /* 损坏的草稿直接回退示例 */ }
  return structuredClone(SAMPLE);
}

function saveDraft() {
  localStorage.setItem(STORE_KEY, JSON.stringify(draft));
}

function loadReviews() {
  try {
    const raw = localStorage.getItem(REVIEW_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.map((t) => deserializeReview(t)).filter(Boolean);
      }
    }
  } catch { /* 损坏记录忽略，不影响草稿与编排 */ }
  return [];
}

// 播审历史整体重写一次存储，但每条播审内部的事件只追加、绝不改写。
function persistReviews() {
  const list = reviews.slice(0, REVIEW_LIMIT);
  localStorage.setItem(REVIEW_KEY, JSON.stringify(list.map(serializeReview)));
}

function currentDraftId() {
  return fingerprint(rawFromDraft());
}

function rawFromDraft() {
  return {
    cardCount: draft.params.cardCount,
    maxPerCard: draft.params.maxPerCard,
    rateZh: draft.params.rateZh,
    rateEn: draft.params.rateEn,
    units: draft.units.map((u) => ({ start: u.start, end: u.end, zh: u.zh, en: u.en })),
  };
}

function activeReview() {
  return reviews.find((r) => r.reviewId === activeId) || null;
}

// ---------------- 录入区 ----------------

function renderParams() {
  $('cardCount').value = draft.params.cardCount;
  $('maxPerCard').value = draft.params.maxPerCard;
  $('rateZh').value = draft.params.rateZh;
  $('rateEn').value = draft.params.rateEn;
}

function renderUnits() {
  const body = $('unitsBody');
  body.innerHTML = '';
  draft.units.forEach((u, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-idx">${i + 1}</td>
      <td><input data-k="start" data-i="${i}" inputmode="decimal" value="${escapeAttr(u.start)}"></td>
      <td><input data-k="end" data-i="${i}" inputmode="decimal" value="${escapeAttr(u.end)}"></td>
      <td><input data-k="zh" data-i="${i}" inputmode="numeric" value="${escapeAttr(u.zh)}"></td>
      <td><input data-k="en" data-i="${i}" inputmode="numeric" value="${escapeAttr(u.en)}"></td>
      <td class="col-op"><button type="button" class="del-btn" data-del="${i}" title="删除单元"
        ${draft.units.length <= 8 ? 'disabled style="opacity:.3"' : ''}>✕</button></td>`;
    body.appendChild(tr);
  });
  $('unitCountHint').textContent = `共 ${draft.units.length} 个（允许 8–24）`;
  $('addUnit').disabled = draft.units.length >= 24;
}

function escapeAttr(v) {
  return String(v ?? '').replace(/[&"]/g, (c) => ({ '&': '&amp;', '"': '&quot;' }[c]));
}

// 仅用于新增行的默认值预填（不参与任何判定运算）。
function addOneSecond(s) {
  const m = /^(\d+)(\.\d+)?$/.exec(String(s ?? '').trim());
  if (!m) return '1';
  return String(Number(m[1]) + 1) + (m[2] || '');
}

function markEdited() {
  saveDraft();
  if (lastResult && !stale) {
    stale = true;
    $('staleBanner').hidden = false;
  }
  $('formError').textContent = '';
  renderReviewPanel();
}

// ---------------- 编排 ----------------

function runPlan() {
  $('formError').textContent = '';
  const raw = rawFromDraft();
  let result;
  try {
    result = plan(raw);
  } catch (e) {
    if (e instanceof InputError) {
      $('formError').textContent = '输入有误：' + e.message;
      highlightField(e.field);
      return;
    }
    $('formError').textContent = '编排失败：' + e.message;
    return;
  }
  lastResult = { result, raw };
  stale = false;
  $('staleBanner').hidden = true;
  renderResult(result, raw);
  renderReviewPanel();
}

function highlightField(field) {
  document.querySelectorAll('input.invalid').forEach((el) => el.classList.remove('invalid'));
  if (!field) return;
  let el = null;
  const m = /^unit-(\d+)-(start|end|zh|en)$/.exec(field);
  if (m) {
    el = document.querySelector(`#unitsBody input[data-i="${m[1]}"][data-k="${m[2]}"]`);
  } else {
    el = document.getElementById(field);
  }
  if (el) { el.classList.add('invalid'); el.focus(); }
}

// ---------------- 结果渲染 ----------------

function renderResult(r, raw) {
  const panel = $('resultPanel');
  panel.hidden = false;
  if (!r.feasible) {
    $('resultBody').innerHTML = renderInfeasible(r);
    return;
  }
  $('resultBody').innerHTML =
    renderSummary(r) + renderCards(r, raw) + renderCutDiagram(r);
}

function t(M, big) {
  return unitsToText(big, M.timeScale, M.K);
}

function pct(f) { return fracToText(f, 2); }

function renderSummary(r) {
  return `
    <div class="result-summary">
      <span class="big">编排成功 · ${r.cardCount} 张卡</span>
      <span class="item">最优最大阅读压力 <b>${pct(r.maxPressure)}</b> 字符/秒（全部卡片中英双语取最大，第一目标已最小化）</span>
      <span class="item">卡间未承载文字总间隙 <b>${t(r.meta, r.totalGap)}</b> 秒（第二目标已最小化；下方切分图逐处展示）</span>
    </div>`;
}

function renderCards(r, raw) {
  const M = r.meta;
  return r.cards.map((c) => {
    const units = [];
    for (let u = c.from; u <= c.to; u++) {
      const idx = u - 1;
      units.push(`
        <li>
          <span class="u-idx">${u}</span>
          <span class="u-time">${t(M, M.starts[idx])} – ${t(M, M.ends[idx])} 秒</span>
          <span class="u-chars">
            <span class="zh">中 ${M.zhChars[idx]}</span> ·
            <span class="en">英 ${M.enChars[idx]}</span>
          </span>
        </li>`);
    }
    const gapChip = c.index === 1 ? '' : `
      <div class="gap-chip ${c.gapBefore === 0n ? 'zero' : ''}">
        与上一张卡之间未承载文字的间隙：<b>${t(M, c.gapBefore)}</b> 秒
        ${c.gapBefore === 0n ? '（首尾相接，无空白）' : ''}
      </div>`;
    return `
      <div class="card-block">
        <div class="card-head">
          <span class="card-no">字幕卡 ${c.index}</span>
          <span class="card-meta">覆盖原文单元 <b>${c.from}–${c.to}</b>（共 ${c.to - c.from + 1} 个）</span>
          <span class="card-meta">显示时段 <b>${t(M, c.start)} – ${t(M, c.end)}</b> 秒，时长 <b>${t(M, c.dur)}</b> 秒</span>
          <span class="pressure"><span class="lang zh">中文压力 ${pct(c.pZh)}</span> / 上限 ${raw.rateZh}</span>
          <span class="pressure"><span class="lang en">英文压力 ${pct(c.pEn)}</span> / 上限 ${raw.rateEn}</span>
        </div>
        ${gapChip}
        <ul class="card-units">${units.join('')}</ul>
      </div>`;
  }).join('');
}

function renderCutDiagram(r) {
  const M = r.meta;
  const cutSet = new Set(r.cards.slice(0, -1).map((c) => c.to));
  const nodes = [];
  for (let u = 1; u <= r.n; u++) {
    if (u > 1) {
      const boundary = u - 1; // 单元 boundary 与 boundary+1（1 基）之间
      const gap = M.starts[boundary] - M.ends[boundary - 1];
      const adopted = cutSet.has(u - 1);
      nodes.push(`
        <div class="cut-line ${adopted ? 'adopted' : ''}"
          title="单元 ${u - 1}→${u} 之间${adopted ? '采用为卡间切分' : '未采用切分（同卡内）'}；间隙 ${t(M, gap)} 秒"></div>`);
    }
    nodes.push(`<div class="cut-node ${cutSet.has(u) ? 'adopted' : ''}"><span class="n">${u}</span></div>`);
  }
  return `
    <div class="cut-diagram">
      <h3>切分总览：绿色实线为采用的卡间切分，灰色虚线为未采用的切分点</h3>
      <div class="cut-track">${nodes.join('')}</div>
      <div class="cut-legend">
        <span class="swatch yes"></span>采用切分（${r.cardCount - 1} 处）
        <span class="swatch no"></span>未采用切分（同一张卡内部）
      </div>
      <div class="legend-row">
        <span>悬停连线可查看每处相邻单元间隙；只有采用切分处的间隙计入“卡间总间隙”。</span>
      </div>
    </div>`;
}

function renderInfeasible(r) {
  return `
    <div class="infeasible-box">
      <h3>无可行编排</h3>
      <p>
        在给定的 ${r.cardCount} 张字幕卡与每卡单元数上限下，无法把全部 ${r.n} 个单元
        切成连续且满足双语阅读上限的卡片。
      </p>
      <p>
        最早无法在剩余卡数内安放的是
        <span class="fail-tag">第 ${r.failUnit} 单元</span>：
        它之前的单元可以成卡，但从它开始，任何包含它的成卡方式都会违反阅读上限，
        或无法为其后的单元留下足够的卡数。请核对该单元的起止秒数、字符数，或放宽卡数/上限。
      </p>
    </div>`;
}

// ---------------- 逐卡播审 ----------------

const STATUS_TEXT = {
  pass: { label: '通过', cls: 'pass' },
  rework: { label: '需返工', cls: 'rework' },
  expired: { label: '已过期', cls: 'expired' },
};

function renderReviewPanel() {
  const panel = $('reviewPanel');
  panel.hidden = false;
  const curId = currentDraftId();
  const review = activeReview();

  // 启动行：仅当最近一次编排可行且与当前草稿一致时，允许从它启动播审。
  const canStart = !!lastResult && lastResult.result.feasible &&
    (!stale) && fingerprint(lastResult.raw) === curId;
  $('reviewStartRow').hidden = !canStart || !!review;
  $('reviewMismatch').hidden = !(review && review.draftId !== curId);
  if (review) {
    $('reviewView').innerHTML = renderActiveReview(review, curId);
  } else if (canStart) {
    $('reviewView').innerHTML = '';
  } else {
    $('reviewView').innerHTML = '<p class="hint">完成一次与当前草稿一致的可行编排后，可在此启动逐卡播审。未启动播审的草稿与既有编排结论不受影响。</p>';
  }

  renderHistory(curId);
  syncTimer(review);
}

function syncTimer(review) {
  if (timer) { clearInterval(timer); timer = null; }
  // 仅进行中的播审需要定时刷新；失配播审历史不变，也照样播放到期逻辑（结论已不可改）。
  if (review) {
    const st = replay(review, Date.now());
    if (st.phase === 'playing' || (st.phase === 'paused' && st.current !== null)) {
      timer = setInterval(() => renderReviewPanel(), 200);
      // Node 测试环境下不阻止进程退出；浏览器无 unref，可选链跳过。
      if (typeof timer.unref === 'function') timer.unref();
    }
  }
}

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderActiveReview(review, curId) {
  const state = replay(review, Date.now());
  const mismatch = review.draftId !== curId;
  const paused = state.phase === 'paused';
  const done = state.phase === 'done';

  const controls = done ? '' : `
    <div class="review-controls">
      ${paused
        ? '<button type="button" class="btn btn-primary" data-review-act="resume">继续</button>'
        : '<button type="button" class="btn btn-ghost" data-review-act="pause">暂停</button>'}
      <button type="button" class="btn btn-pass" data-review-act="pass"
        ${state.current ? '' : 'disabled'}>通过本卡</button>
      <button type="button" class="btn btn-rework" data-review-act="rework"
        ${state.current ? '' : 'disabled'}>需返工</button>
      <span class="hint" id="verdictHint"></span>
    </div>`;

  const curCard = state.current ? review.cards[state.current - 1] : null;
  const currentBlock = curCard ? renderReviewCard(review, curCard, {
    active: true,
    remaining: state.remainingMicros,
    paused,
    mismatch,
  }) : '';

  const body = done ? '' : `
    <div class="review-stage ${paused ? 'is-paused' : ''}">
      ${paused ? '<div class="review-pause-tag">已暂停</div>' : ''}
      ${currentBlock}
    </div>`;

  return `
    <div class="review-meta">
      <span>播审 <b>${escapeAttr(review.reviewId)}</b></span>
      <span>开始于 ${fmtClock(review.createdAt)}</span>
      <span>快照共 <b>${review.cardCount}</b> 张卡 / ${review.n} 个原文单元</span>
      ${mismatch ? '<span class="mismatch-tag">与当前草稿失配</span>' : '<span class="match-tag">与当前草稿一致</span>'}
      <button type="button" class="btn btn-ghost btn-sm" data-review-act="close">收起（保留记录）</button>
    </div>
    ${controls}
    ${body}
    ${done ? renderDoneSummary(review, state) : ''}
    <div class="review-allcards">${review.cards.map((c) => renderReviewCard(review, c, {
      status: state.statuses[c.index - 1],
    })).join('')}</div>
  `;
}

function renderDoneSummary(review, state) {
  state = state || replay(review, Date.now());
  const reworkLine = state.firstRework === null
    ? '<b>无</b>需返工字幕卡'
    : `首张需返工字幕卡：<span class="fail-tag">第 ${state.firstRework} 张</span>`;
  return `
    <div class="review-done">
      <h3>播审完成</h3>
      <p class="big">可交付卡数：<b>${state.deliverable}</b> / ${state.totalCards}</p>
      <p>${reworkLine}</p>
      <p class="hint">逐卡结论：通过 ${state.deliverable} 张 ·
        需返工 ${state.statuses.filter((s) => s === 'rework').length} 张 ·
        过期未判 ${state.statuses.filter((s) => s === 'expired').length} 张</p>
    </div>`;
}

// 渲染快照中的一张卡（当前卡或历史结论卡），所有数据均来自冻结快照。
function renderReviewCard(review, c, opts = {}) {
  const M = review; // 快照本身携带 timeScale/K/units
  const units = [];
  for (let u = c.from; u <= c.to; u++) {
    const idx = u - 1;
    const un = M.units[idx];
    units.push(`
      <li>
        <span class="u-idx">${u}</span>
        <span class="u-time">${unitsToText(un.start, M.timeScale, M.K)} – ${unitsToText(un.end, M.timeScale, M.K)} 秒</span>
        <span class="u-chars">
          <span class="zh">中 ${un.zh}</span> · <span class="en">英 ${un.en}</span>
        </span>
      </li>`);
  }
  const st = opts.status ? STATUS_TEXT[opts.status] : null;
  const badge = st ? `<span class="verdict-badge ${st.cls}">${st.label}</span>` : '';
  const remain = opts.active && opts.remaining !== undefined
    ? `<span class="remain ${opts.paused ? 'paused' : ''}">剩余 <b>${microsToSeconds(opts.remaining, 1)}</b> 秒（本卡显示时长 ${unitsToText(c.dur, M.timeScale, M.K)} 秒）</span>`
    : `<span class="card-duration">显示时长 <b>${unitsToText(c.dur, M.timeScale, M.K)}</b> 秒</span>`;
  const mismatchWarn = opts.active && opts.mismatch
    ? '<div class="mismatch-note">当前草稿已与该快照失配：播放照常到期，但本卡属于冻结的历史编排。</div>'
    : '';
  return `
    <div class="card-block review-card ${opts.active ? 'is-current' : ''} ${st ? 'has-' + st.cls : ''}">
      <div class="card-head">
        <span class="card-no">字幕卡 ${c.index}</span>
        <span class="card-meta">原文单元 <b>${c.from}–${c.to}</b></span>
        ${remain}
        <span class="pressure"><span class="lang zh">中文压力 ${pct(c.pZh)}</span></span>
        <span class="pressure"><span class="lang en">英文压力 ${pct(c.pEn)}</span></span>
        ${badge}
      </div>
      ${mismatchWarn}
      <ul class="card-units">${units.join('')}</ul>
    </div>`;
}

function renderHistory(curId) {
  const wrap = $('reviewHistoryWrap');
  const others = reviews.filter((r) => r.reviewId !== activeId);
  if (!others.length) { wrap.hidden = true; $('reviewHistory').innerHTML = ''; return; }
  wrap.hidden = false;
  $('reviewHistory').innerHTML = others.map((r) => {
    const st = replay(r, Date.now());
    const mm = r.draftId !== curId;
    const expanded = expandedHistory === r.reviewId;
    return `
      <div class="history-item ${mm ? 'mismatch' : ''}">
        <button type="button" class="history-head" data-review-open="${escapeAttr(r.reviewId)}">
          <span>播审 ${escapeAttr(r.reviewId)}</span>
          <span class="hint">${fmtClock(r.createdAt)} · ${r.cardCount} 张卡 ·
            阶段 ${phaseText(st.phase)} · 通过 ${st.deliverable}${st.firstRework === null ? '' : ` · 首张返工第 ${st.firstRework} 张`}</span>
          <span class="${mm ? 'mismatch-tag' : 'match-tag'}">${mm ? '与当前草稿失配' : '一致'}</span>
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-review-switch="${escapeAttr(r.reviewId)}">打开查看</button>
        ${expanded ? renderExpandedHistory(r, st) : ''}
      </div>`;
  }).join('');
}

function phaseText(p) {
  return ({ idle: '未开始', playing: '播放中', paused: '已暂停', done: '已完成' })[p] || p;
}

function renderExpandedHistory(review, state) {
  return `
    <div class="history-detail">
      ${state.phase === 'done' ? renderDoneSummary(review, state) : `
        <p class="hint">该播审${state.phase === 'paused' ? '已暂停' : '尚未完成'}；逐卡结论与冻结快照仍可查看。</p>`}
      <div class="review-allcards">${review.cards.map((c) => renderReviewCard(review, c, {
        status: state.statuses[c.index - 1],
      })).join('')}</div>
    </div>`;
}

// ---------------- 播审动作（只追加事件） ----------------

function appendReviewEvent(ev) {
  const review = activeReview();
  if (!review) return;
  review.events.push(ev); // 只追加；过期/重复事件在 replay 中自然无效
  persistReviews();
  renderReviewPanel();
}

function startReview() {
  if (!lastResult || !lastResult.result.feasible || stale) return;
  if (activeReview()) return;
  const review = createReview(lastResult.raw, lastResult.result, { now: Date.now() });
  reviews.unshift(review);
  activeId = review.reviewId;
  persistReviews();
  renderReviewPanel();
}

// ---------------- 事件绑定 ----------------

function bind() {
  const paramIds = ['cardCount', 'maxPerCard', 'rateZh', 'rateEn'];
  paramIds.forEach((id) => {
    $(id).addEventListener('input', (e) => {
      draft.params[id] = e.target.value;
      markEdited();
    });
  });

  $('unitsBody').addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    const i = Number(e.target.dataset.i);
    if (!k) return;
    draft.units[i][k] = e.target.value;
    markEdited();
  });

  $('unitsBody').addEventListener('click', (e) => {
    const idx = e.target.dataset.del;
    if (idx === undefined || draft.units.length <= 8) return;
    draft.units.splice(Number(idx), 1);
    saveDraft();
    renderUnits();
    markEdited();
  });

  $('addUnit').addEventListener('click', () => {
    if (draft.units.length >= 24) return;
    const last = draft.units[draft.units.length - 1];
    const start = last?.end ?? '0';
    draft.units.push({ start, end: addOneSecond(start), zh: '0', en: '0' });
    saveDraft();
    renderUnits();
    markEdited();
  });

  $('planBtn').addEventListener('click', runPlan);

  $('resetSample').addEventListener('click', () => {
    draft = structuredClone(SAMPLE);
    saveDraft();
    renderParams();
    renderUnits();
    lastResult = null;
    stale = false;
    $('staleBanner').hidden = true;
    $('resultPanel').hidden = true;
    $('formError').textContent = '';
    renderReviewPanel();
  });

  $('reviewStartBtn').addEventListener('click', startReview);

  // 播审控制（事件委托；禁用/过期判定由 replay 兜底，这里只做前置提示）。
  $('reviewView').addEventListener('click', (e) => {
    const act = e.target.dataset?.reviewAct;
    if (!act) return;
    const review = activeReview();
    if (!review) return;
    if (act === 'close') {
      activeId = null;
      expandedHistory = null;
      renderReviewPanel();
      return;
    }
    const now = Date.now();
    const st = replay(review, now);
    if (act === 'pause') {
      if (st.phase === 'playing') appendReviewEvent(pauseEvent(now));
      return;
    }
    if (act === 'resume') {
      if (st.phase === 'paused') appendReviewEvent(resumeEvent(now));
      return;
    }
    if (act === 'pass' || act === 'rework') {
      if (!st.current) return;
      // 操作对象始终是冻结快照；草稿失配仅改变标识，不篡改本播审。
      if (st.remainingMicros === null || st.remainingMicros <= 0n) return; // 已过期
      appendReviewEvent(verdictEvent(st.current, act, now));
    }
  });

  $('reviewHistory').addEventListener('click', (e) => {
    const sw = e.target.closest?.('[data-review-switch]')?.dataset?.reviewSwitch;
    if (sw) {
      activeId = sw;
      expandedHistory = null;
      renderReviewPanel();
      return;
    }
    const id = e.target.closest?.('[data-review-open]')?.dataset?.reviewOpen;
    if (!id) return;
    expandedHistory = expandedHistory === id ? null : id;
    renderReviewPanel();
  });
}

renderParams();
renderUnits();
if (lastResult) renderResult(lastResult.result, lastResult.raw);
renderReviewPanel();
bind();
