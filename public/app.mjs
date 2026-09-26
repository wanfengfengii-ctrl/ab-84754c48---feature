// 页面逻辑：草稿（localStorage 持久化）、失效标记、调用精确编排模型、渲染结果。
import { plan, InputError } from '../src/model.mjs';
import { fracToText, unitsToText } from '../src/decimal.mjs';

const STORE_KEY = 'subtitle-planner-draft-v1';

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
}

// ---------------- 编排 ----------------

function runPlan() {
  $('formError').textContent = '';
  const raw = {
    cardCount: draft.params.cardCount,
    maxPerCard: draft.params.maxPerCard,
    rateZh: draft.params.rateZh,
    rateEn: draft.params.rateEn,
    units: draft.units.map((u) => ({ start: u.start, end: u.end, zh: u.zh, en: u.en })),
  };
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
  });
}

renderParams();
renderUnits();
bind();
