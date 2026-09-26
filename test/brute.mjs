// 暴力参考实现：枚举全部 C 段连续切分（每段 1..m 个单元），
// 按与主实现相同的三级字典序选出最优，供测试逐一比对。仅用于测试（n<=12）。

import { normalizeInput } from '../src/model.mjs';
import { pressure, cmpFrac } from '../src/decimal.mjs';

export function brutePlan(raw) {
  let M;
  try {
    M = normalizeInput(raw);
  } catch (e) {
    return { error: e };
  }
  const { n, cardCount: C, maxPerCard: m } = M;
  const q = M.timeScale * M.rateScale;

  const feasibleGroup = (i, k) => {
    const dur = M.ends[k - 1] - M.starts[i];
    let zh = 0, en = 0;
    for (let t = i; t < k; t++) { zh += M.zhChars[t]; en += M.enChars[t]; }
    if (BigInt(zh) * q > dur * M.rateZh) return null;
    if (BigInt(en) * q > dur * M.rateEn) return null;
    return { dur, zh, en };
  };

  const groupOk = Array.from({ length: n }, () => new Uint8Array(n + 1));
  for (let i = 0; i < n; i++) {
    for (let k = i + 1; k <= Math.min(n, i + m); k++) {
      groupOk[i][k] = feasibleGroup(i, k) ? 1 : 0;
    }
  }

  const results = [];
  const sizes = [];
  const evalCut = (sizes) => {
    const ends = [];
    let acc = 0;
    for (const p of sizes) { acc += p; ends.push(acc); }
    let i = 0;
    let L = null;
    let G = 0n;
    for (let c = 0; c < C; c++) {
      const k = ends[c];
      if (!groupOk[i][k]) return;
      const g = feasibleGroup(i, k);
      let v = pressure(g.zh, g.dur, M.timeScale);
      const pe = pressure(g.en, g.dur, M.timeScale);
      if (!L) L = v;
      else { v = cmpFrac(L, v) >= 0 ? L : v; L = v; }
      L = cmpFrac(L, pe) >= 0 ? L : pe;
      if (c > 0) G += M.starts[i] - M.ends[i - 1];
      i = k;
    }
    results.push({ tuple: ends, L, G });
  };

  const gen = (remain, slots) => {
    if (slots === 1) {
      if (remain >= 1 && remain <= m) { sizes.push(remain); evalCut(sizes); sizes.pop(); }
      return;
    }
    for (let x = 1; x <= Math.min(m, remain - (slots - 1)); x++) {
      sizes.push(x);
      gen(remain - x, slots - 1);
      sizes.pop();
    }
  };
  gen(n, C);

  if (results.length === 0) {
    return { feasible: false, failUnit: bruteFailUnit(groupOk, n, C, m) };
  }

  results.sort((a, b) => {
    const cL = cmpFrac(a.L, b.L);
    if (cL) return cL;
    if (a.G !== b.G) return a.G < b.G ? -1 : 1;
    for (let i = 0; i < a.tuple.length; i++) {
      if (a.tuple[i] !== b.tuple[i]) return a.tuple[i] - b.tuple[i];
    }
    return 0;
  });
  return { feasible: true, tuple: results[0].tuple, L: results[0].L, G: results[0].G };
}

// 与主实现 earliestUnplaceable 完全相同的两级定义。
function bruteFailUnit(groupOk, n, C, m) {
  const pref = Array.from({ length: C + 1 }, () => new Uint8Array(n + 1));
  pref[0][0] = 1;
  for (let c = 1; c <= C; c++) {
    for (let i = 0; i < n; i++) {
      if (!pref[c - 1][i]) continue;
      for (let k = i + 1; k <= Math.min(n, i + m); k++) if (groupOk[i][k]) pref[c][k] = 1;
    }
  }
  const suff = Array.from({ length: C + 1 }, () => new Uint8Array(n + 1));
  suff[0][n] = 1;
  for (let c = 1; c <= C; c++) {
    for (let k = 1; k <= n; k++) {
      if (!suff[c - 1][k]) continue;
      for (let i = Math.max(0, k - m); i < k; i++) if (groupOk[i][k]) suff[c][i] = 1;
    }
  }
  for (let u = 0; u < n; u++) {
    let carriable = false;
    for (let i = Math.max(0, u - m + 1); i <= u; i++) {
      for (let k = u + 1; k <= Math.min(n, i + m); k++) if (groupOk[i][k]) { carriable = true; break; }
      if (carriable) break;
    }
    if (!carriable) return u + 1;
  }
  for (let u = 0; u < n; u++) {
    let placeable = false;
    for (let c = 0; c < C && !placeable; c++) {
      for (let i = Math.max(0, u - m + 1); i <= u; i++) {
        if (!pref[c][i]) continue;
        for (let k = u + 1; k <= Math.min(n, i + m); k++) {
          if (groupOk[i][k] && suff[C - c - 1][k]) { placeable = true; break; }
        }
        if (placeable) break;
      }
    }
    if (!placeable) return u + 1;
  }
  return n + 1;
}

// 生成随机实例（一位小数，故意制造临界约束）。
export function randomInstance(rng) {
  for (;;) {
    const n = 8 + Math.floor(rng() * 5); // 8..12
    const C = 2 + Math.floor(rng() * Math.min(4, n - 2));
    const m = 2 + Math.floor(rng() * 4);
    if (C * m < n) continue;
    const units = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      const gap = Math.floor(rng() * 3); // 0..2 整秒间隙
      const dur = [0.3, 0.7, 1, 1.5, 2][Math.floor(rng() * 5)];
      const start = t + gap;
      const end = +(start + dur).toFixed(1);
      t = end;
      units.push({
        start: start.toFixed(1),
        end: end.toFixed(1),
        zh: Math.floor(rng() * 12),
        en: Math.floor(rng() * 20),
      });
    }
    const rateZh = ['3', '4.5', '6', '8.2'][Math.floor(rng() * 4)];
    const rateEn = ['5', '7.5', '9', '11.1'][Math.floor(rng() * 4)];
    return { cardCount: C, maxPerCard: m, rateZh, rateEn, units };
  }
}

// 确定性 LCG 随机源。
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
