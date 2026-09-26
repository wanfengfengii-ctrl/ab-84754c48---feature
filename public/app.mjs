// 页面逻辑：草稿（localStorage 持久化）、失效标记、调用精确编排模型、渲染结果、
// 逐卡播审（事件溯源：动作只追加记录，界面状态全部由 replay 重放推导）。
import { plan, InputError } from '../src/model.mjs';
import { fracToText, unitsToText } from '../src/decimal.mjs';
import {
  createSession,
  appendEvent,
  replay,
  fingerprintDraft,
  formatRemaining,
} from '../src/review.mjs';

const STORE_KEY = 'subtitle-planner-draft-v1';
const REVIEW_KEY = 'subtitle-planner-review-v1';

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
let reviewStore = loadReviewStore(); // 播审会话（只追加事件，历史会话不可篡改）
let reviewDetailId = null;           // 历史区展开查看的会话 id
let lastTickKey = '';                // 上次渲染的播审状态指纹（避免无谓重绘）

// 测试可注入假时钟；生产环境取 Date.now()。
const now = () => (typeof globalThis.__REVIEW_NOW__ === 'function'
  ? Number(globalThis.__REVIEW_NOW__())
  : Date.now());

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

// ---------------- 播审会话存储 ----------------

function loadReviewStore() {
  try {
    const raw = localStorage.getItem(REVIEW_KEY);
    if (!raw) return { version: 1, sessions: [] };
    const data = JSON.parse(raw);
    const sessions = Array.isArray(data?.sessions) ? data.sessions.filter(okSession) : [];
    return { version: 1, sessions };
  } catch { return { version: 1, sessions: [] }; }
}

// 损坏的会话直接丢弃（不阻塞其余会话与草稿）。
function okSession(s) {
  return s && typeof s.timeScale === 'string' && /^\d+$/.test(s.timeScale)
    && Array.isArray(s.cards) && s.cards.length > 0
    && s.cards.every((c) => c && /^\d+$/.test(String(c.durUnits ?? '')))
    && Array.isArray(s.events)
    && s.events.every((e) => e && typeof e.type === 'string' && Number.isFinite(Number(e.at)));
}

function saveReviewStore() {
  localStorage.setItem(REVIEW_KEY, JSON.stringify(reviewStore));
}

const newestSession = () => reviewStore.sessions[reviewStore.sessions.length - 1] || null;

// 当前草稿的原始输入（与编排、草稿标识共用同一形状）。
function currentRaw() {
  return {
    cardCount: draft.params.cardCount,
    maxPerCard: draft.params.maxPerCard,
    rateZh: draft.params.rateZh,
    rateEn: draft.params.rateEn,
    units: draft.units.map((u) => ({ start: u.start, end: u.end, zh: u.zh, en: u.en })),
  };
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
  renderReview(); // 草稿一变，播审失配标识与启动可用性随之刷新（历史记录不被改写）
}

// ---------------- 编排 ----------------

function runPlan() {
  $('formError').textContent = '';
  const raw = currentRaw();
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
  renderReview(); // 新编排完成：可据其启动播审（历史播审保持不变）
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

const CONCLUSION_LABEL = {
  pending: '待审',
  passed: '通过',
  rework: '需返工',
  expired: '过期未判定',
};
const CONCLUSION_MARK = { pending: '…', passed: '✓', rework: '✕', expired: '⏭' };
const STATUS_LABEL = { idle: '未开始', playing: '进行中', paused: '已暂停', done: '已完成' };

function mismatchChip(s) {
  return s.draftId !== fingerprintDraft(currentRaw())
    ? '<span class="badge badge-warn">已与当前草稿失配</span>'
    : '<span class="badge badge-ok">与当前草稿一致</span>';
}

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 启动播审：冻结本次编排的完整卡片快照与来源草稿标识。
function startReview() {
  if (!lastResult || stale || !lastResult.result.feasible) return;
  const id = `r${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const s = createSession({ planResult: lastResult.result, raw: lastResult.raw, now: now(), id });
  reviewStore.sessions.push(s);
  reviewDetailId = null;
  saveReviewStore();
  renderReview();
}

// 记录播审动作：只追加事件记录；是否有效由 replay 统一判定（此处仅做界面守卫）。
function recordReview(type) {
  const s = newestSession();
  if (!s) return;
  const st = replay(s, now());
  if (type === 'pass' || type === 'rework') {
    if (st.status !== 'playing' && st.status !== 'paused') return;
    appendEvent(s, type, now(), st.currentCard);
  } else if (type === 'pause') {
    if (st.status !== 'playing') return;
    appendEvent(s, type, now());
  } else if (type === 'resume') {
    if (st.status !== 'paused') return;
    appendEvent(s, type, now());
  } else {
    return;
  }
  saveReviewStore();
  renderReview();
}

function renderReview() {
  const panel = $('reviewPanel');
  const s = newestSession();
  const canStart = !!(lastResult && !stale && lastResult.result.feasible);
  if (!s && !(lastResult && lastResult.result.feasible)) {
    panel.hidden = true;
    lastTickKey = '';
    return;
  }
  panel.hidden = false;
  renderReviewLive(s);
  renderReviewStart(canStart, s);
  renderReviewHistory();
  renderReviewDetail();
}

// 最新会话：进行中可操作，完成后给出稳定结论。
function renderReviewLive(s) {
  const box = $('reviewLive');
  if (!s) { box.innerHTML = ''; lastTickKey = ''; return; }
  let st;
  try {
    st = replay(s, now());
  } catch {
    box.innerHTML = '<p class="form-error">最新播审会话数据损坏，无法重放。</p>';
    lastTickKey = '';
    return;
  }
  lastTickKey = `${st.status}|${st.currentCard}|${st.conclusions.join('')}`;
  const C = s.cards.length;
  const head = `
    <div class="review-head">
      <span class="review-title">当前播审 <b>${s.id}</b>（${fmtClock(s.createdAt)} 启动，共 ${C} 张）</span>
      <span class="badge">${STATUS_LABEL[st.status]}</span>
      ${mismatchChip(s)}
      <span class="review-draft">来源草稿标识 <code>${s.draftId}</code></span>
    </div>`;

  let body = '';
  if (st.status === 'playing' || st.status === 'paused') {
    const card = s.cards[st.currentIndex];
    const units = card.units.map((u) => `
      <li>
        <span class="u-idx">${u.no}</span>
        <span class="u-time">${u.start} – ${u.end} 秒</span>
        <span class="u-chars"><span class="zh">中 ${u.zh}</span> · <span class="en">英 ${u.en}</span></span>
      </li>`).join('');
    body = `
      <div class="review-stage">
        <div class="review-progress-row">
          <span class="review-step">第 <b>${st.currentCard}</b> / ${C} 张</span>
          <span class="review-countdown" id="reviewCountdown">${
            st.status === 'paused' ? '已暂停' : `剩余 ${formatRemaining(st.remaining)} 秒`}</span>
        </div>
        <div class="review-progress"><div id="reviewProgressBar"></div></div>
        <div class="card-block review-card">
          <div class="card-head">
            <span class="card-no">字幕卡 ${card.index}</span>
            <span class="card-meta">覆盖原文单元 <b>${card.from}–${card.to}</b></span>
            <span class="card-meta">显示时段 <b>${card.start} – ${card.end}</b> 秒，时长 <b>${card.dur}</b> 秒</span>
            <span class="pressure"><span class="lang zh">中文压力 ${card.pZh}</span> / 上限 ${s.rateZh}</span>
            <span class="pressure"><span class="lang en">英文压力 ${card.pEn}</span> / 上限 ${s.rateEn}</span>
          </div>
          <ul class="card-units">${units}</ul>
        </div>
        <div class="review-actions">
          <button type="button" class="btn btn-primary" data-act="pass">✓ 通过</button>
          <button type="button" class="btn btn-danger" data-act="rework">✕ 需返工</button>
          ${st.status === 'playing'
            ? '<button type="button" class="btn btn-ghost" data-act="pause">⏸ 暂停</button>'
            : '<button type="button" class="btn btn-ghost" data-act="resume">▶ 继续</button>'}
        </div>
        <p class="hint">仅可对当前尚未过期的卡记录结论；显示时长耗尽未判定的卡将记为「过期未判定」并自动推进。</p>
      </div>`;
  } else if (st.status === 'done') {
    body = `
      <div class="review-summary">
        <span class="big">播审完成</span>
        <span class="item">可交付字幕卡 <b>${st.deliverable}</b> / ${C} 张</span>
        <span class="item">首张需返工字幕卡：<b>${st.firstRework === null ? '无' : `第 ${st.firstRework} 张`}</b></span>
        ${st.counts.expired ? `<span class="item">另有 <b>${st.counts.expired}</b> 张过期未判定（不计入可交付）</span>` : ''}
      </div>`;
  }

  box.innerHTML = head + body + renderConclusionStrip(s, st);
}

function renderConclusionStrip(s, st) {
  const chips = s.cards.map((c, i) => {
    const con = st.conclusions[i];
    const cur = i === st.currentIndex ? ' cur' : '';
    return `<span class="st-chip st-${con}${cur}" title="字幕卡 ${c.index}：${CONCLUSION_LABEL[con]}">${c.index} ${CONCLUSION_MARK[con]}</span>`;
  }).join('');
  return `<div class="st-strip" aria-label="逐卡结论">${chips}</div>`;
}

function renderReviewStart(canStart, liveSession) {
  const box = $('reviewStart');
  if (canStart) {
    let liveDone = true;
    if (liveSession) {
      try { liveDone = replay(liveSession, now()).status === 'done'; } catch { liveDone = true; }
    }
    const note = liveSession && !liveDone
      ? '<span class="hint">另起新播审后，当前进行中的播审将归档为只读历史（记录不被改写）。</span>'
      : '';
    box.innerHTML = `
      <div class="review-start">
        <button type="button" class="btn btn-primary" data-act="start">▶ 开始逐卡播审</button>
        <span class="hint">基于当前编排结果冻结快照并逐卡播审。</span>
        ${note}
      </div>`;
  } else if (lastResult && stale) {
    box.innerHTML = '<div class="review-start"><span class="hint">草稿已修改，请重新「编排」后再启动新的播审。</span></div>';
  } else {
    box.innerHTML = '';
  }
}

// 历史会话：只读存档；编辑草稿或重新编排都不会改写，仅标识失配。
function renderReviewHistory() {
  const box = $('reviewHistory');
  const list = reviewStore.sessions.slice(0, -1).reverse(); // 旧的在前排后：最新历史在最上
  if (!list.length) { box.innerHTML = ''; return; }
  const rows = list.map((s) => {
    let st;
    try { st = replay(s, now()); } catch { return ''; }
    const conclusion = st.status === 'done'
      ? `可交付 <b>${st.deliverable}</b> / ${s.cards.length} 张 · 首张需返工 <b>${st.firstRework === null ? '无' : `第 ${st.firstRework} 张`}</b>`
      : `${STATUS_LABEL[st.status]} · 已判定 ${st.counts.passed + st.counts.rework + st.counts.expired} / ${s.cards.length} 张`;
    return `
      <div class="history-row">
        <span class="history-id"><b>${s.id}</b>（${fmtClock(s.createdAt)}）</span>
        <span class="badge">${STATUS_LABEL[st.status]}</span>
        ${mismatchChip(s)}
        <span class="history-conclusion">${conclusion}</span>
        <button type="button" class="btn btn-ghost btn-small" data-act="view" data-id="${s.id}">查看逐卡结论</button>
      </div>`;
  }).join('');
  box.innerHTML = `<h3 class="review-subhead">历史播审（只读存档，编辑草稿或重新编排均不改写）</h3>${rows}`;
}

function renderReviewDetail() {
  const box = $('reviewDetail');
  if (!reviewDetailId) { box.innerHTML = ''; return; }
  const s = reviewStore.sessions.find((x) => x.id === reviewDetailId);
  if (!s) { box.innerHTML = ''; reviewDetailId = null; return; }
  let st;
  try { st = replay(s, now()); } catch { box.innerHTML = ''; return; }
  const rows = s.cards.map((c, i) => {
    const con = st.conclusions[i];
    return `
      <tr>
        <td class="col-idx">${c.index}</td>
        <td>单元 ${c.from}–${c.to}</td>
        <td>${c.start} – ${c.end} 秒（${c.dur} 秒）</td>
        <td><span class="zh">中 ${c.zh}</span> · <span class="en">英 ${c.en}</span></td>
        <td><span class="lang zh">压 ${c.pZh}</span> / <span class="lang en">${c.pEn}</span></td>
        <td><span class="st-chip st-${con}">${CONCLUSION_LABEL[con]}</span></td>
      </tr>`;
  }).join('');
  box.innerHTML = `
    <div class="review-detail">
      <div class="review-head">
        <span class="review-title">播审 <b>${s.id}</b> 的逐卡结论</span>
        ${mismatchChip(s)}
        <button type="button" class="btn btn-ghost btn-small" data-act="closeDetail">收起</button>
      </div>
      <div class="table-wrap">
        <table class="detail-table">
          <thead><tr><th>#</th><th>覆盖单元</th><th>显示时段</th><th>字符数</th><th>阅读压力</th><th>结论</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="review-summary">
        <span class="item">可交付 <b>${st.deliverable}</b> / ${s.cards.length} 张</span>
        <span class="item">首张需返工字幕卡：<b>${st.firstRework === null ? '无' : `第 ${st.firstRework} 张`}</b></span>
      </div>
    </div>`;
}

// 倒计时心跳：只重放推导并刷新显示，绝不改写事件日志；
// 计时器延迟不影响结论（状态是日志与当前时刻的纯函数）。
function tickReview() {
  const panel = $('reviewPanel');
  if (panel.hidden) return;
  const s = newestSession();
  if (!s) return;
  let st;
  try { st = replay(s, now()); } catch { return; }
  const key = `${st.status}|${st.currentCard}|${st.conclusions.join('')}`;
  if (key !== lastTickKey) { renderReview(); return; }
  if (st.status === 'playing') {
    const cd = $('reviewCountdown');
    if (cd) cd.textContent = `剩余 ${formatRemaining(st.remaining)} 秒`;
    const bar = $('reviewProgressBar');
    if (bar && st.currentDuration) {
      const total = Number(st.currentDuration.num) / Number(st.currentDuration.den);
      const rem = Number(st.remaining.num) / Number(st.remaining.den);
      const pct = total > 0 ? Math.max(0, Math.min(100, (1 - rem / total) * 100)) : 0;
      bar.style.width = `${pct}%`;
    }
  }
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

  // 播审面板：事件委托（按钮随重放渲染动态生成）。
  $('reviewPanel').addEventListener('click', (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;
    if (act === 'start') startReview();
    else if (act === 'pass' || act === 'rework' || act === 'pause' || act === 'resume') recordReview(act);
    else if (act === 'view') { reviewDetailId = e.target.dataset.id; renderReview(); }
    else if (act === 'closeDetail') { reviewDetailId = null; renderReview(); }
  });

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
    renderReview(); // 草稿重置：历史播审保留并标识失配，启动入口隐藏
  });
}

renderParams();
renderUnits();
bind();
renderReview();

// 倒计时心跳（node 测试环境下 unref，不阻塞进程退出）。
const reviewTimer = setInterval(tickReview, 250);
if (typeof reviewTimer?.unref === 'function') reviewTimer.unref();
