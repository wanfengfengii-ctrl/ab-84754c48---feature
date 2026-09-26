// 逐卡播审模型（纯函数、事件溯源）：
//
// 播审开始时冻结两份不可变信息：
//   1. 本次编排的完整卡片快照（含每张卡的起止、时长、双语字符数与阅读压力）；
//   2. 来源草稿标识 draftId（对编排原始输入做规范化哈希，不修改草稿本身）。
// 之后的一切操作——开始、暂停、继续、通过、需返工——都是只追加事件，
// 当前卡、剩余时长与逐卡结论完全由「快照 + 事件序列 + 查询时刻」重放得到，
// 刷新页面、计时器延迟甚至补发事件都不会改变既有结论：
//   - 只允许对“当前且尚未过期”的卡记录通过/需返工；
//   - 过期后才到达、重复、错卡、错阶段的判定事件一律保留但不产生效果；
//   - 重复/错阶段的暂停、继续同样幂等忽略。
//
// 时间轴以 BigInt 微秒记账，事件时间戳为整数毫秒（Date.now()），全程不使用浮点。

const MICROS_PER_SEC = 1_000_000n;
const MICROS_PER_MS = 1_000n;

export const REVIEW_VERSION = 1;

// ---------------- 来源草稿标识 ----------------

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

// FNV-1a 32 位：短小、稳定、纯字符串确定性，无需加密强度。
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

/** 对编排原始输入计算稳定草稿标识；输入不变则标识不变，任意编辑即改变。 */
export function fingerprint(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('草稿为空，无法计算标识');
  const canon = {
    cardCount: String(raw.cardCount ?? ''),
    maxPerCard: String(raw.maxPerCard ?? ''),
    rateZh: String(raw.rateZh ?? ''),
    rateEn: String(raw.rateEn ?? ''),
    units: (Array.isArray(raw.units) ? raw.units : []).map((u) => ({
      start: String(u?.start ?? ''),
      end: String(u?.end ?? ''),
      zh: String(u?.zh ?? ''),
      en: String(u?.en ?? ''),
    })),
  };
  return 'd-' + fnv1a(stableStringify(canon));
}

// ---------------- 快照冻结 ----------------

function cloneRaw(raw) {
  return {
    cardCount: String(raw.cardCount),
    maxPerCard: String(raw.maxPerCard),
    rateZh: String(raw.rateZh),
    rateEn: String(raw.rateEn),
    units: raw.units.map((u) => ({
      start: String(u.start), end: String(u.end),
      zh: String(u.zh), en: String(u.en),
    })),
  };
}

/**
 * 基于一次成功编排冻结播审快照，并追加 start 事件。
 * raw：送入 plan 的原始输入；result：plan 的可行返回；now：开始时刻（毫秒）。
 */
export function createReview(raw, result, { now, reviewId } = {}) {
  if (!result || result.feasible !== true) {
    throw new Error('只有可行的编排结果才能启动播审');
  }
  const at = Number.isInteger(now) ? now : Date.now();
  const id = reviewId || `r-${at.toString(36)}-${fnv1a(stableStringify(raw) + at)}`;
  return {
    v: REVIEW_VERSION,
    reviewId: id,
    draftId: fingerprint(raw),
    createdAt: at,
    raw: cloneRaw(raw),
    cardCount: result.cardCount,
    n: result.n,
    K: result.meta.K,
    timeScale: result.meta.timeScale,
    rateScale: result.meta.rateScale,
    rateZh: result.meta.rateZh,
    rateEn: result.meta.rateEn,
    units: result.meta.starts.map((s, i) => ({
      start: s,
      end: result.meta.ends[i],
      zh: result.meta.zhChars[i],
      en: result.meta.enChars[i],
    })),
    cards: result.cards.map((c) => ({
      index: c.index,
      from: c.from,
      to: c.to,
      start: c.start,
      end: c.end,
      dur: c.dur,
      zh: c.zh,
      en: c.en,
      pZh: { num: c.pZh.num, den: c.pZh.den },
      pEn: { num: c.pEn.num, den: c.pEn.den },
      gapBefore: c.gapBefore,
    })),
    events: [{ type: 'start', at }],
  };
}

// ---------------- 事件构造（只追加） ----------------

export const startEvent = (at) => ({ type: 'start', at });
export const pauseEvent = (at) => ({ type: 'pause', at });
export const resumeEvent = (at) => ({ type: 'resume', at });
export const verdictEvent = (card, result, at) => ({
  type: 'verdict', card, result, at,
});

/** 卡片显示时长（微秒，BigInt）：量纲整数 dur 表示 dur/timeScale 秒。 */
export function durationMicros(durUnits, timeScale) {
  return BigInt(durUnits) * MICROS_PER_SEC / BigInt(timeScale);
}

// ---------------- 重放 ----------------

const clampIndex = (n) => (Number.isInteger(n) && n >= 1 ? n : -1);

/**
 * 重放快照事件，得到查询时刻 nowMs 下的确定状态。
 * 纯函数：不修改入参，同一 (快照, 事件, 时刻) 永远得到同一结果。
 *
 * 返回：
 *   phase:    'idle'（未开始）| 'playing' | 'paused' | 'done'
 *   current:  当前卡（1 基），无当前卡时为 null
 *   remainingMicros: 当前卡剩余显示时长（BigInt 微秒），无则 null
 *   playedMicros:    已播放时长（BigInt 微秒，不含暂停）
 *   statuses: 每卡结论：'pass' | 'rework' | 'expired' | null（待审）
 *   verdicts: 判定记录 [{card, result, at}]（按追加顺序，仅含有效判定）
 *   deliverable: 通过卡数；firstRework: 首张需返工卡（1 基）或 null
 */
export function replay(review, nowMs) {
  const C = review.cards.length;
  const timeScale = BigInt(review.timeScale);
  const durs = review.cards.map((c) => durationMicros(c.dur, timeScale));
  const statuses = new Array(C).fill(null);
  const verdicts = [];

  let phase = 'idle';      // idle | playing | paused | done
  let playing = false;     // 当前墙钟是否在走
  let played = 0n;         // 截至上次暂停/判定点累计的播放微秒
  let lastResume = 0;      // 最近一次开始/继续的墙钟毫秒
  let cur = 0;             // 当前卡（0 基）
  let cursor = 0n;         // 当前卡窗口起点对应的播放微秒
  let startedAt = null;

  // 某墙钟时刻对应的播放微秒；时钟异常（回拨）时夹回已确认值，不产生负时长。
  const playedAt = (atMs) => {
    if (!playing) return played;
    const p = played + (BigInt(atMs) * MICROS_PER_MS - BigInt(lastResume) * MICROS_PER_MS);
    return p < played ? played : p;
  };

  // 当前卡未判定且显示时长已耗尽：标记过期并把时间轴推进到下一张卡。
  const advanceExpired = (p) => {
    while (cur < C && statuses[cur] === null && p - cursor >= durs[cur]) {
      statuses[cur] = 'expired';
      cursor += durs[cur];
      cur += 1;
    }
    if (cur >= C) {
      phase = 'done';
      playing = false;
      played = p;
    }
  };

  for (const ev of review.events || []) {
    if (!ev || typeof ev.at !== 'number' || !Number.isFinite(ev.at)) continue;

    if (ev.type === 'start') {
      if (phase !== 'idle') continue; // 重复 start 不重启、不改写
      phase = 'playing';
      playing = true;
      lastResume = ev.at;
      startedAt = ev.at;
      played = 0n; cur = 0; cursor = 0n;
      continue;
    }
    if (phase === 'idle' || phase === 'done') continue;

    const p = playedAt(ev.at);
    if (playing) advanceExpired(p);

    if (ev.type === 'pause') {
      if (playing && phase !== 'done') { played = p; playing = false; if (phase === 'playing') phase = 'paused'; }
      continue;
    }
    if (ev.type === 'resume') {
      if (!playing && phase !== 'done') { lastResume = ev.at; playing = true; phase = 'playing'; }
      continue;
    }
    if (ev.type === 'verdict') {
      if (phase !== 'playing' && phase !== 'paused') continue;
      const card = clampIndex(ev.card);
      const result = ev.result === 'pass' || ev.result === 'rework' ? ev.result : null;
      // 必须正是当前卡、尚无结论（重复/错卡/已过期均拒绝）、且窗口尚未耗尽。
      if (
        result && cur < C && card === cur + 1 &&
        statuses[cur] === null && p - cursor < durs[cur]
      ) {
        statuses[cur] = result;
        verdicts.push({ card: cur + 1, result, at: ev.at });
        cur += 1;
        if (cur >= C) {
          phase = 'done';
          playing = false;
          played = p;
        } else {
          cursor = p; // 提前判定：下一张卡立即开始，其完整时长从此刻起算
        }
      }
      continue;
    }
  }

  // 查询时刻的派生状态（自动过期不在日志中留痕，重放即复现）。
  let current = null;
  let remaining = null;
  if (phase === 'playing' || phase === 'paused') {
    const p = playedAt(nowMs);
    if (playing) advanceExpired(p);
    if (cur < C) {
      current = cur + 1;
      const used = p - cursor;
      remaining = used >= durs[cur] ? 0n : durs[cur] - used;
    }
  }

  let deliverable = 0;
  let firstRework = null;
  for (let i = 0; i < C; i++) {
    if (statuses[i] === 'pass') deliverable += 1;
    if (statuses[i] === 'rework' && firstRework === null) firstRework = i + 1;
  }

  return {
    phase,
    current,
    remainingMicros: remaining,
    playedMicros: playedAt(Number.isFinite(nowMs) ? nowMs : 0),
    statuses,
    verdicts,
    deliverable,
    firstRework,
    startedAt,
    totalCards: C,
  };
}

/** 当前是否可对指定卡记录结论（当前卡且尚未过期）。 */
export function canVerdict(state, card) {
  return (state.phase === 'playing' || state.phase === 'paused') &&
    state.current === card && (state.remainingMicros ?? 0n) > 0n;
}

// ---------------- 展示辅助 ----------------

/** 微秒转秒（截断到 digits 位小数，仅用于展示）。 */
export function microsToSeconds(micros, digits = 1) {
  const v = micros < 0n ? 0n : micros;
  const scale = 10n ** BigInt(digits);
  const scaled = v * scale / MICROS_PER_SEC;
  const whole = scaled / scale;
  if (digits === 0) return `${whole}`;
  return `${whole}.${String(scaled % scale).padStart(digits, '0')}`;
}

// ---------------- 持久化（BigInt 安全的 JSON） ----------------

const BIG_TAG = '$big';

export function serializeReview(review) {
  return JSON.stringify(review, (_k, v) => (
    typeof v === 'bigint' ? { [BIG_TAG]: v.toString() } : v
  ));
}

export function deserializeReview(text) {
  try {
    const obj = JSON.parse(text, (_k, v) => (
      v && typeof v === 'object' && typeof v[BIG_TAG] === 'string' && Object.keys(v).length === 1
        ? BigInt(v[BIG_TAG])
        : v
    ));
    if (!obj || obj.v !== REVIEW_VERSION || !Array.isArray(obj.cards) || !Array.isArray(obj.events)) {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}
