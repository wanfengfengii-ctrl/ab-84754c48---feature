// 字幕编排模型：输入解析（精确十进制）、可行性判定、多目标动态规划、
// 无可行解时的“最早无法安放单元”诊断。
//
// 优化目标（字典序，逐级决胜）：
//   1. 所有卡片、两种语言的最大阅读压力（字符/秒）最小；
//   2. 卡片之间未承载文字的总间隙最小；
//   3. 各卡末单元输入序号（1 基）组成的元组字典序最小（稳定选定）。
// 约束：恰好 C 张连续卡片，保持原序；每卡 1..m 个单元；
//   卡片显示时长 = 末单元结束 − 首单元开始；
//   任语言字符总数 / 时长 <= 该语言每秒阅读上限（整数交叉相乘判定）。

import {
  parseDecimal,
  rescale,
  fits,
  pressure,
  cmpFrac,
  parsePosInt,
} from './decimal.mjs';

export class InputError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'InputError';
    this.field = field;
  }
}

const ZERO_FRAC = { num: 0n, den: 1n };

/**
 * 解析并归一化原始输入。
 * raw.units: [{ start, end, zh, en }]（字符串或数字）
 */
export function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object') throw new InputError(null, '输入为空');
  const cardCount = parsePosInt(raw.cardCount, '字幕卡数');
  const maxPerCard = parsePosInt(raw.maxPerCard, '每卡最多单元数');

  const unitsRaw = raw.units;
  if (!Array.isArray(unitsRaw)) throw new InputError('units', '缺少语义单元');
  const n = unitsRaw.length;
  if (n < 8 || n > 24) throw new InputError('units', '语义单元数量须为 8 至 24 个');

  const rateZhP = parseDecimal(raw.rateZh);
  const rateEnP = parseDecimal(raw.rateEn);
  if (rateZhP.int === 0n) throw new InputError('rateZh', '中文阅读上限须大于 0');
  if (rateEnP.int === 0n) throw new InputError('rateEn', '英文阅读上限须大于 0');

  const parsed = unitsRaw.map((u, i) => {
    if (!u || typeof u !== 'object') throw new InputError(`unit-${i}`, `单元 ${i + 1} 数据缺失`);
    let s, e;
    try { s = parseDecimal(u.start); } catch { throw new InputError(`unit-${i}-start`, `单元 ${i + 1} 的起始秒数非法`); }
    try { e = parseDecimal(u.end); } catch { throw new InputError(`unit-${i}-end`, `单元 ${i + 1} 的结束秒数非法`); }
    const zh = parseCount(u.zh, `单元 ${i + 1} 中文字符数`);
    const en = parseCount(u.en, `单元 ${i + 1} 英文字符数`);
    return { s, e, zh, en };
  });

  // 公共时间量纲 10^K 秒；阅读上限量纲 10^D（字符/秒）。
  const K = parsed.reduce((mx, u) => Math.max(mx, u.s.dec, u.e.dec), 0);
  const D = Math.max(rateZhP.dec, rateEnP.dec);
  const timeScale = 10n ** BigInt(K);
  const rateScale = 10n ** BigInt(D);

  const starts = parsed.map((u) => rescale(u.s, K));
  const ends = parsed.map((u) => rescale(u.e, K));
  const zhChars = parsed.map((u) => u.zh);
  const enChars = parsed.map((u) => u.en);

  for (let i = 0; i < n; i++) {
    if (ends[i] <= starts[i]) {
      throw new InputError(`unit-${i}-end`, `单元 ${i + 1} 的结束秒数须严格晚于起始秒数`);
    }
    if (i > 0 && starts[i] < ends[i - 1]) {
      throw new InputError(`unit-${i}-start`, `单元 ${i + 1} 的起始早于上一单元结束，单元须按时间排列且不重叠`);
    }
  }

  if (cardCount > n) throw new InputError('cardCount', `字幕卡数（${cardCount}）不能多于单元数（${n}）`);
  if (cardCount * maxPerCard < n) {
    throw new InputError('maxPerCard', `每卡最多 ${maxPerCard} 单元时，${cardCount} 张卡无法容纳 ${n} 个单元（至少需要 ${Math.ceil(n / maxPerCard)} 张）`);
  }

  return {
    n,
    cardCount,
    maxPerCard,
    starts,
    ends,
    zhChars,
    enChars,
    timeScale,
    rateScale,
    rateZh: rescale(rateZhP, D),
    rateEn: rescale(rateEnP, D),
    K,
  };
}

function parseCount(v, label) {
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 0) return v;
    throw new InputError(null, `${label}须为非负整数`);
  }
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s) || BigInt(s) > 9007199254740991n) throw new InputError(null, `${label}须为非负整数`);
  return Number(s);
}

/** 预算区间 [i, j) 的成卡信息；不可行返回 null。 */
function buildGroup(M, i, j) {
  const dur = M.ends[j - 1] - M.starts[i];
  const zh = sum(M.zhChars, i, j);
  const en = sum(M.enChars, i, j);
  // 比较时统一量纲：chars / (dur/timeScale) <= rate/rateScale
  //   <=> chars * timeScale * rateScale <= dur * rate
  const q = M.timeScale * M.rateScale;
  if (!fits(zh, dur, M.rateZh, q)) return null;
  if (!fits(en, dur, M.rateEn, q)) return null;
  return {
    i,
    j,
    dur,
    zh,
    en,
    pZh: pressure(zh, dur, M.timeScale),
    pEn: pressure(en, dur, M.timeScale),
  };
}

function sum(arr, i, j) {
  let t = 0;
  for (let k = i; k < j; k++) t += arr[k];
  return t;
}

function cmpTuple(a, b) {
  const len = Math.min(a.length, b.length);
  for (let k = 0; k < len; k++) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * 主入口。
 * 可行：{ feasible:true, cards, maxPressure, totalGap, boundaries, meta }
 * 不可行：{ feasible:false, cardCount, n, failUnit }（failUnit 为 1 基序号）
 */
export function plan(raw) {
  const M = normalizeInput(raw);
  const { n, cardCount: C, maxPerCard: m } = M;

  // 区间成卡表 group[i][j]（j 排他），仅预算 |j-i|<=m。
  const group = Array.from({ length: n }, () => new Array(n + 1).fill(null));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j <= Math.min(n, i + m); j++) {
      group[i][j] = buildGroup(M, i, j);
    }
  }

  // 相邻单元间的无文字间隙，位于边界 k（单元 k 与 k+1 之间，0 基）。
  const boundaryGap = new Array(n - 1);
  for (let k = 0; k < n - 1; k++) boundaryGap[k] = M.starts[k + 1] - M.ends[k];

  // 可行性前向/后向可达（不可行诊断用，基于原始速率约束）。
  const pref = reachablePrefix(group, n, C, m);
  const suff = reachableSuffix(group, n, C, m);

  if (!pref[C][n]) {
    return {
      feasible: false,
      cardCount: C,
      n,
      failUnit: earliestUnplaceable(pref, suff, group, n, C, m),
    };
  }

  // ---- 阶段 1：最小化全局最大阅读压力 L*（min-max DP）----
  // L1[c][j]：用 c 张可行卡覆盖 [0,j) 时可达到的最小“最大压力分数”。
  const L1 = Array.from({ length: C + 1 }, () => new Array(n + 1).fill(null));
  L1[0][0] = ZERO_FRAC;
  for (let c = 1; c <= C; c++) {
    for (let j = c; j <= n; j++) {
      let best = null;
      for (let i = Math.max(0, j - m); i < j; i++) {
        const prev = L1[c - 1][i];
        const g = group[i][j];
        if (!prev || !g) continue;
        let v = cmpFrac(prev, g.pZh) >= 0 ? prev : g.pZh;
        v = cmpFrac(v, g.pEn) >= 0 ? v : g.pEn;
        if (!best || cmpFrac(v, best) < 0) best = v;
      }
      L1[c][j] = best;
    }
  }
  const Lstar = L1[C][n];

  // 阈值化后每张卡是否“合格”：两种语言压力均 <= L*。
  const allowed = Array.from({ length: n }, () => new Uint8Array(n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j <= Math.min(n, i + m); j++) {
      const g = group[i][j];
      if (g && cmpFrac(g.pZh, Lstar) <= 0 && cmpFrac(g.pEn, Lstar) <= 0) {
        allowed[i][j] = 1;
      }
    }
  }

  // ---- 阶段 2+3：在合格路径上先最小化总间隙，再字典序最小化切分元组 ----
  // 状态值 { G, tuple, back }；同一 (c,j) 仅保留 (G, tuple) 最小者。
  // 正确性：后缀的合格性与代价只依赖当前末位 j；对同一 (c,j) 的两个前缀，
  // 任意共同后缀给二者加上完全相同的后续间隙与后缀元组，
  // 故 (G, 前缀元组) 的字典序顺序在拼接后保持不变，可安全剪枝。
  const layers = new Array(C + 1);
  layers[0] = new Map([[0, { G: 0n, tuple: [], back: -1 }]]);
  for (let c = 1; c <= C; c++) {
    const cur = new Map();
    for (const [i, prev] of layers[c - 1]) {
      for (let j = i + 1; j <= Math.min(n, i + m); j++) {
        if (!allowed[i][j]) continue;
        const gap = c === 1 ? 0n : boundaryGap[i - 1];
        const cand = { G: prev.G + gap, tuple: appendVal(prev.tuple, j), back: i };
        const old = cur.get(j);
        if (!old || better2(cand, old)) cur.set(j, cand);
      }
    }
    layers[c] = cur;
  }

  const finalState = layers[C].get(n);
  if (!finalState) throw new Error('内部错误：阈值路径应存在');

  // ---- 回溯 ----
  const bounds = [n];
  let j = n;
  for (let c = C; c >= 1; c--) {
    j = layers[c].get(j).back;
    bounds.push(j);
  }
  bounds.reverse(); // bounds[c] = 第 c 张卡起始位（0 基），bounds[C]=n

  const cards = [];
  for (let c = 0; c < C; c++) {
    const i = bounds[c];
    const k = bounds[c + 1];
    const g = group[i][k];
    const gapBefore = c === 0 ? 0n : boundaryGap[i - 1];
    cards.push({
      index: c + 1,
      from: i + 1,
      to: k, // 1 基末单元序号
      start: M.starts[i],
      end: M.ends[k - 1],
      dur: g.dur,
      zh: g.zh,
      en: g.en,
      pZh: g.pZh,
      pEn: g.pEn,
      gapBefore,
    });
  }

  return {
    feasible: true,
    cardCount: C,
    n,
    cards,
    boundaries: bounds,
    maxPressure: Lstar,
    totalGap: finalState.G,
    meta: M,
  };
}

function appendVal(tuple, v) {
  const t = tuple.slice();
  t.push(v);
  return t;
}

// 二级字典序决胜：总间隙 -> 各卡末单元序号元组。
function better2(a, b) {
  if (a.G !== b.G) return a.G < b.G;
  return cmpTuple(a.tuple, b.tuple) < 0;
}

// pref[c][j] = 前 j 个单元能否恰由 c 张可行卡覆盖。
function reachablePrefix(group, n, C, m) {
  const pref = Array.from({ length: C + 1 }, () => new Uint8Array(n + 1));
  pref[0][0] = 1;
  for (let c = 1; c <= C; c++) {
    for (let i = 0; i < n; i++) {
      if (!pref[c - 1][i]) continue;
      for (let j = i + 1; j <= Math.min(n, i + m); j++) {
        if (group[i][j]) pref[c][j] = 1;
      }
    }
  }
  return pref;
}

// suff[k][i] = 单元 [i,n) 能否恰由 k 张可行卡覆盖。
function reachableSuffix(group, n, C, m) {
  const suff = Array.from({ length: C + 1 }, () => new Uint8Array(n + 1));
  suff[0][n] = 1;
  for (let k = 1; k <= C; k++) {
    for (let j = 1; j <= n; j++) {
      if (!suff[k - 1][j]) continue;
      for (let i = Math.max(0, j - m); i < j; i++) {
        if (group[i][j]) suff[k][i] = 1;
      }
    }
  }
  return suff;
}

// 最早无法在剩余卡数内安放的单元（返回 1 基序号）：
// 单元 u 可安放 <=> 存在 c、i<=u<j，使 pref[c][i]、区间[i,j)可行、suff[C-c-1][j] 同时成立。
function earliestUnplaceable(pref, suff, group, n, C, m) {
  // 级 (a)：最早不存在任何可行卡可承载的单元（无视卡数预算的根本阻断点）。
  for (let u = 0; u < n; u++) {
    let carriable = false;
    for (let i = Math.max(0, u - m + 1); i <= u; i++) {
      for (let j = u + 1; j <= Math.min(n, i + m); j++) {
        if (group[i][j]) { carriable = true; break; }
      }
      if (carriable) break;
    }
    if (!carriable) return u + 1;
  }
  // 级 (b)：最早不能出现在任何恰用 C 张卡的完整编排中的单元。
  for (let u = 0; u < n; u++) {
    let placeable = false;
    for (let c = 0; c < C && !placeable; c++) {
      for (let i = Math.max(0, u - m + 1); i <= u; i++) {
        if (!pref[c][i]) continue;
        for (let j = u + 1; j <= Math.min(n, i + m); j++) {
          if (group[i][j] && suff[C - c - 1][j]) { placeable = true; break; }
        }
        if (placeable) break;
      }
    }
    if (!placeable) return u + 1;
  }
  return n + 1;
}
