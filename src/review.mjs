// 逐卡播审引擎（事件溯源，纯函数，无 DOM 依赖）。
//
// 模型：
//   - 启动播审时冻结本次编排的完整卡片快照与来源草稿标识（fingerprintDraft），
//     之后编辑草稿或重新编排都不会改写已冻结的会话；
//   - 会话内的一切动作（开始、暂停、继续、通过、需返工）都是只追加的事件记录，
//     任何时刻的界面状态都由 replay(会话, 当前时刻) 重新推导，
//     因此刷新页面或计时器延迟后重放同一事件日志，仍得到同一当前卡、
//     同一剩余时长与同一逐卡结论；
//   - 每张卡按编排确定的显示时长依次呈现：对当前卡记录“通过/需返工”会立即
//     推进到下一张卡；若显示时长耗尽仍未判定，该卡记为“过期未判定”并自动推进；
//   - 只允许对当前尚未过期的卡记录结论：过期、重复或错位的记录在重放时被忽略，
//     不得改写结果；会话完成后的任何记录同样不改写结果。
//
// 计时：与编排判定同风格，全程整数（BigInt）比较，不引入浮点。
//   内部把墙钟毫秒换算为 tick：1 tick = 1/timeScale 毫秒，
//   卡片时长 durTicks = durUnits * 1000（timeScale 为编排的公共时间量纲），
//   到期判定 elapsed * 1 >= durTicks 为精确整数比较。

import { fracToText, unitsToText } from './decimal.mjs';

export const EVENT_TYPES = ['start', 'pause', 'resume', 'pass', 'rework'];

/** 草稿标识：对规范化后的草稿文本做 53 位散列（仅作标识，不参与判定）。 */
export function fingerprintDraft(raw) {
  const norm = (v) => String(v ?? '').trim();
  const canon = JSON.stringify({
    p: [raw?.cardCount, raw?.maxPerCard, raw?.rateZh, raw?.rateEn].map(norm),
    u: (raw?.units || []).map((u) => [u?.start, u?.end, u?.zh, u?.en].map(norm)),
  });
  return cyrb53(canon).toString(16).padStart(14, '0');
}

// cyrb53 字符串散列（确定性，跨会话稳定）。
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * 从一次可行的编排结果冻结播审会话。
 * planResult：plan() 的可行结果；raw：产生该结果的草稿输入；now：当前毫秒。
 * 快照包含每张卡的显示时段、精确时长（量纲整数）、双语字符数与阅读压力、
 * 以及卡内各原文单元，足以脱离当前草稿独立呈现。
 */
export function createSession({ planResult, raw, now, id }) {
  if (!planResult || !planResult.feasible) throw new Error('仅可对可行编排启动播审');
  const M = planResult.meta;
  const at = Math.trunc(Number(now));
  const cards = planResult.cards.map((c) => {
    const units = [];
    for (let u = c.from; u <= c.to; u++) {
      const idx = u - 1;
      units.push({
        no: u,
        start: unitsToText(M.starts[idx], M.timeScale, M.K),
        end: unitsToText(M.ends[idx], M.timeScale, M.K),
        zh: M.zhChars[idx],
        en: M.enChars[idx],
      });
    }
    return {
      index: c.index,
      from: c.from,
      to: c.to,
      start: unitsToText(c.start, M.timeScale, M.K),
      end: unitsToText(c.end, M.timeScale, M.K),
      dur: unitsToText(c.dur, M.timeScale, M.K),
      durUnits: c.dur.toString(), // 精确量纲整数（字符串保存，回放时转 BigInt）
      zh: c.zh,
      en: c.en,
      pZh: fracToText(c.pZh, 2),
      pEn: fracToText(c.pEn, 2),
      units,
    };
  });
  return {
    version: 1,
    id: id || `r${at.toString(36)}`,
    draftId: fingerprintDraft(raw),
    createdAt: at,
    timeScale: M.timeScale.toString(),
    cardCount: planResult.cardCount,
    n: planResult.n,
    maxPressure: fracToText(planResult.maxPressure, 2),
    totalGap: unitsToText(planResult.totalGap, M.timeScale, M.K),
    rateZh: String(raw?.rateZh ?? ''),
    rateEn: String(raw?.rateEn ?? ''),
    cards,
    events: [{ seq: 1, type: 'start', at }],
  };
}

/** 只追加一条事件记录（不重写历史；有效性由 replay 统一判定）。 */
export function appendEvent(session, type, at, card) {
  if (!session || !Array.isArray(session.events)) throw new Error('播审会话损坏：缺少事件日志');
  const ev = { seq: session.events.length + 1, type, at: Math.trunc(Number(at)) };
  if (type === 'pass' || type === 'rework') ev.card = card;
  session.events.push(ev);
  return ev;
}

/** 会话快照所示草稿与给定草稿是否失配。 */
export function isMismatch(session, raw) {
  return !session || session.draftId !== fingerprintDraft(raw);
}

/**
 * 重放事件日志，推导 nowMs 时刻的完整播审状态（纯函数，不改写会话）。
 * 返回：
 *   status        'idle' | 'playing' | 'paused' | 'done'
 *   currentCard   当前卡序号（1 基；无则为 null）
 *   remaining     当前卡剩余时长（毫秒精确分数 {num, den}；无则为 null）
 *   currentDuration 当前卡显示时长（同量纲；无则为 null）
 *   conclusions   逐卡结论：'pending' | 'passed' | 'rework' | 'expired'
 *   counts        各结论计数；deliverable 可交付卡数（= 通过数）
 *   firstRework   首张需返工字幕卡序号（1 基；无则为 null）
 *   doneAt        完成时刻（毫秒整数；未完成为 null）
 */
export function replay(session, nowMs) {
  const cards = session.cards || [];
  const C = cards.length;
  const timeScale = BigInt(session.timeScale);
  const durTicks = cards.map((c) => BigInt(c.durUnits) * 1000n); // 1 tick = 1/timeScale 毫秒
  const toTicks = (ms) => BigInt(Math.trunc(Number(ms) || 0)) * timeScale;

  const conclusions = new Array(C).fill('pending');
  let started = false;
  let done = C === 0;
  let doneAtTicks = null;
  let cursor = 0;       // 当前卡（0 基）
  let windowStart = 0n; // 当前卡窗口开启时刻（tick）
  let pausedAccum = 0n; // 当前窗口内累计暂停时长（tick）
  let pauseStart = null; // 非 null 表示处于暂停（tick）
  let prevT = null;

  // 当前卡在墙钟 T 的有效已播时长（暂停期间冻结）。
  const elapsedAt = (T) => {
    let e = T - windowStart - pausedAccum;
    if (pauseStart !== null) e -= T - pauseStart;
    return e;
  };

  // 推进已过期卡：仅在播放中时间才流逝；下一张卡窗口自上一张到期时刻开启。
  const advanceExpiries = (T) => {
    while (!done && pauseStart === null && elapsedAt(T) >= durTicks[cursor]) {
      conclusions[cursor] = 'expired';
      const deadline = windowStart + pausedAccum + durTicks[cursor];
      cursor += 1;
      if (cursor === C) {
        done = true;
        doneAtTicks = deadline;
      } else {
        windowStart = deadline;
        pausedAccum = 0n;
      }
    }
  };

  for (const ev of session.events || []) {
    let T = toTicks(ev.at);
    if (prevT !== null && T < prevT) T = prevT; // 时钟回拨容错：单调钳制
    prevT = T;
    if (!started) {
      // 首个事件（应为 start）开启会话；容错：非 start 的首事件视为同时刻开始。
      started = true;
      windowStart = T;
      if (ev.type === 'start') continue;
    }
    advanceExpiries(T);
    if (done) continue; // 完成后的记录一律不改写结果
    switch (ev.type) {
      case 'pause':
        if (pauseStart === null) pauseStart = T;
        break;
      case 'resume':
        if (pauseStart !== null) {
          pausedAccum += T - pauseStart;
          pauseStart = null;
        }
        break;
      case 'pass':
      case 'rework':
        // 仅当前尚未过期的卡可记录（过期已在上面推进）；重复/错位记录忽略。
        if (ev.card === cursor + 1) {
          conclusions[cursor] = ev.type === 'pass' ? 'passed' : 'rework';
          cursor += 1;
          if (cursor === C) {
            done = true;
            doneAtTicks = T;
          } else {
            windowStart = T;
            pausedAccum = 0n;
            if (pauseStart !== null) pauseStart = T; // 暂停中判定：新卡自判定刻起计暂停
          }
        }
        break;
      default:
        break; // 未知类型记录忽略
    }
  }

  let nowT = toTicks(nowMs);
  if (prevT !== null && nowT < prevT) nowT = prevT;
  if (started && !done) advanceExpiries(nowT);

  let status;
  if (!started) status = 'idle';
  else if (done) status = 'done';
  else if (pauseStart !== null) status = 'paused';
  else status = 'playing';

  let remaining = null;
  let currentDuration = null;
  if (status === 'playing' || status === 'paused') {
    const remTicks = durTicks[cursor] - elapsedAt(nowT);
    remaining = { num: remTicks > 0n ? remTicks : 0n, den: timeScale };
    currentDuration = { num: durTicks[cursor], den: timeScale };
  }

  const counts = { passed: 0, rework: 0, expired: 0, pending: 0 };
  for (const c of conclusions) counts[c] += 1;
  const firstReworkIdx = conclusions.indexOf('rework');

  return {
    status,
    currentIndex: started && !done ? cursor : null,
    currentCard: started && !done ? cursor + 1 : null,
    remaining,
    currentDuration,
    conclusions,
    counts,
    deliverable: counts.passed,
    firstRework: firstReworkIdx === -1 ? null : firstReworkIdx + 1,
    doneAt: doneAtTicks === null ? null : Number(doneAtTicks / timeScale),
  };
}

/** 剩余时长精确分数（毫秒）格式化为秒文本：向上取整到 0.1 秒（仅展示用）。 */
export function formatRemaining(remaining) {
  if (!remaining) return '—';
  const { num, den } = remaining;
  const unit = den * 100n; // 0.1 秒 = den*100 个 tick
  const deci = (num + unit - 1n) / unit;
  return `${deci / 10n}.${deci % 10n}`;
}
