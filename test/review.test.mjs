// 播审引擎（src/review.mjs）测试：重放确定性、暂停/继续、过期推进、
// 过期/重复记录不改写、完成汇总、快照冻结与草稿失配标识。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  appendEvent,
  replay,
  fingerprintDraft,
  isMismatch,
  formatRemaining,
} from '../src/review.mjs';
import { plan } from '../src/model.mjs';

// 手工构造会话：timeScale=10（量纲 0.1 秒），durs 为各卡量纲时长。
// 25 → 2.5 秒 = 2500 毫秒。
function makeSession(durs = ['25', '30', '20'], startAt = 0) {
  return {
    version: 1,
    id: 't1',
    draftId: 'draft-x',
    createdAt: startAt,
    timeScale: '10',
    cardCount: durs.length,
    n: 8,
    maxPressure: '1.00',
    totalGap: '0',
    rateZh: '6',
    rateEn: '9',
    cards: durs.map((d, i) => ({
      index: i + 1,
      from: i + 1,
      to: i + 1,
      start: '0',
      end: '0',
      dur: '0',
      durUnits: d,
      zh: 1,
      en: 1,
      pZh: '0',
      pEn: '0',
      units: [],
    })),
    events: [{ seq: 1, type: 'start', at: startAt }],
  };
}

const remMs = (st) => Number(st.remaining.num / st.remaining.den);

test('启动即冻结：初始为播放中，当前第 1 卡，剩余时长等于该卡显示时长', () => {
  const s = makeSession();
  const st = replay(s, 0);
  assert.equal(st.status, 'playing');
  assert.equal(st.currentCard, 1);
  assert.equal(remMs(st), 2500);
  assert.deepEqual(st.conclusions, ['pending', 'pending', 'pending']);
  assert.equal(st.deliverable, 0);
  assert.equal(st.firstRework, null);
});

test('播放推进：剩余时长随墙钟减少；重放是幂等的', () => {
  const s = makeSession();
  const a = replay(s, 1000);
  assert.equal(remMs(a), 1500);
  // 同一日志、同一时刻重放必然相同（计时器延迟/刷新等价的基础）。
  assert.deepEqual(replay(s, 1000), a);
});

test('通过记录立即推进到下一张卡并重置剩余时长', () => {
  const s = makeSession();
  appendEvent(s, 'pass', 1000, 1);
  const st = replay(s, 1500);
  assert.equal(st.currentCard, 2);
  assert.equal(remMs(st), 2500); // 卡 2 窗口自 1000 开启，已播 500
  assert.deepEqual(st.conclusions, ['passed', 'pending', 'pending']);
});

test('暂停冻结倒计时，继续后从冻结处恢复', () => {
  const s = makeSession();
  appendEvent(s, 'pause', 1000);
  // 暂停期间无论过了多久，剩余时长不变。
  const paused = replay(s, 99999);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.currentCard, 1);
  assert.equal(remMs(paused), 1500);
  appendEvent(s, 'resume', 6000);
  const st = replay(s, 6500);
  assert.equal(st.status, 'playing');
  assert.equal(remMs(st), 1000); // 暂停 5000ms 不计入
});

test('暂停中可对当前未过期卡记录结论，新卡自继续时起计', () => {
  const s = makeSession();
  appendEvent(s, 'pause', 1000);
  appendEvent(s, 'pass', 2000, 1); // 暂停中判定，有效
  appendEvent(s, 'resume', 6000);
  const st = replay(s, 6500);
  assert.equal(st.currentCard, 2);
  assert.equal(remMs(st), 2500); // 卡 2 自 6000 起计，已播 500
  assert.deepEqual(st.conclusions, ['passed', 'pending', 'pending']);
});

test('显示时长耗尽未判定：卡片过期并自动推进，窗口自到期时刻开启', () => {
  const s = makeSession();
  const st = replay(s, 2600);
  assert.equal(st.currentCard, 2);
  assert.equal(st.conclusions[0], 'expired');
  assert.equal(remMs(st), 2900); // 卡 2 窗口自 2500 开启
});

test('全部过期：会话完成，可交付 0，首张需返工为无', () => {
  const s = makeSession();
  const st = replay(s, 100000);
  assert.equal(st.status, 'done');
  assert.deepEqual(st.conclusions, ['expired', 'expired', 'expired']);
  assert.equal(st.deliverable, 0);
  assert.equal(st.firstRework, null);
  assert.equal(st.counts.expired, 3);
});

test('已过期的记录不得改写结果', () => {
  const s = makeSession();
  appendEvent(s, 'pass', 3000, 1); // 卡 1 在 2500 已过期
  const st = replay(s, 3100);
  assert.equal(st.conclusions[0], 'expired');
  assert.equal(st.currentCard, 2);
});

test('重复或错位的记录不得改写结果', () => {
  const s = makeSession();
  appendEvent(s, 'pass', 1000, 1);
  appendEvent(s, 'pass', 1200, 1);   // 重复：卡 1 已离开
  appendEvent(s, 'pass', 1300, 3);   // 错位：当前是卡 2
  appendEvent(s, 'rework', 1500, 2);
  appendEvent(s, 'pass', 1600, 2);   // 重复：卡 2 已判定
  const st = replay(s, 2000);
  assert.deepEqual(st.conclusions, ['passed', 'rework', 'pending']);
  assert.equal(st.currentCard, 3);
});

test('完成后的任何记录不得改写结果', () => {
  const s = makeSession();
  appendEvent(s, 'pass', 1000, 1);
  appendEvent(s, 'rework', 2000, 2);
  appendEvent(s, 'pass', 3000, 3);
  const done = replay(s, 3000);
  assert.equal(done.status, 'done');
  appendEvent(s, 'rework', 4000, 3);
  appendEvent(s, 'pause', 4000);
  assert.deepEqual(replay(s, 5000), done);
});

test('播审完成：稳定给出可交付卡数与首张需返工字幕卡', () => {
  const s = makeSession();
  appendEvent(s, 'rework', 1000, 1);
  appendEvent(s, 'pass', 2000, 2);
  appendEvent(s, 'rework', 3000, 3);
  const st = replay(s, 3000);
  assert.equal(st.status, 'done');
  assert.equal(st.deliverable, 1);
  assert.equal(st.firstRework, 1); // 首张需返工是第 1 张
  assert.equal(st.doneAt, 3000);
  // 同一日志任意晚时刻重放，结论不变。
  assert.deepEqual(replay(s, 10 ** 9), st);
});

test('判定赶在到期前有效，且很久之后重放结论不变（计时器延迟等价）', () => {
  const s = makeSession();
  appendEvent(s, 'pass', 2400, 1); // 卡 1 到期时刻为 2500
  const st = replay(s, 999999);
  assert.equal(st.conclusions[0], 'passed');
  assert.equal(st.conclusions[1], 'expired'); // 卡 2 窗口 2400+3000=5400 过期
  assert.equal(st.conclusions[2], 'expired');
  assert.equal(st.deliverable, 1);
});

test('序列化往返（刷新等价）：JSON 存取后重放结果一致', () => {
  const s = makeSession();
  appendEvent(s, 'pass', 1000, 1);
  appendEvent(s, 'pause', 1500);
  appendEvent(s, 'resume', 8000);
  appendEvent(s, 'rework', 9000, 2);
  const restored = JSON.parse(JSON.stringify(s));
  assert.deepEqual(replay(restored, 9500), replay(s, 9500));
});

test('时钟回拨容错：事件时刻单调钳制，重放仍确定', () => {
  const s = makeSession();
  appendEvent(s, 'pause', 2000);
  appendEvent(s, 'resume', 1500); // 回拨：钳制到 2000，等于没暂停
  const st = replay(s, 3000);
  assert.equal(st.conclusions[0], 'expired');
  assert.equal(st.currentCard, 2);
  assert.equal(remMs(st), 2500);
});

test('formatRemaining 向上取整到 0.1 秒，当前卡不会显示 0.0', () => {
  assert.equal(formatRemaining({ num: 25000n, den: 10n }), '2.5');
  assert.equal(formatRemaining({ num: 1n, den: 10n }), '0.1');
  assert.equal(formatRemaining({ num: 14999n, den: 10n }), '1.5');
  assert.equal(formatRemaining(null), '—');
});

// ---- 与真实编排结果集成 ----

const RAW = {
  cardCount: '4', maxPerCard: '3', rateZh: '6', rateEn: '9',
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

test('createSession 冻结完整卡片快照与来源草稿标识', () => {
  const r = plan(RAW);
  assert.equal(r.feasible, true);
  const s = createSession({ planResult: r, raw: RAW, now: 1000, id: 's1' });
  assert.equal(s.draftId, fingerprintDraft(RAW));
  assert.equal(s.cards.length, r.cards.length);
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0], { seq: 1, type: 'start', at: 1000 });
  for (let i = 0; i < s.cards.length; i++) {
    assert.equal(BigInt(s.cards[i].durUnits), r.cards[i].dur, '快照时长须与编排结果一致');
    assert.equal(s.cards[i].units.length, r.cards[i].to - r.cards[i].from + 1);
  }
  // 快照自包含：不依赖 meta 即可呈现（cards/units 均为可显示文本）。
  assert.equal(typeof s.cards[0].units[0].start, 'string');
});

test('不可行编排不能启动播审', () => {
  const bad = plan({ ...RAW, rateZh: '0.1' });
  assert.equal(bad.feasible, false);
  assert.throws(() => createSession({ planResult: bad, raw: RAW, now: 0 }), /可行编排/);
});

test('草稿标识：编辑草稿即失配，未编辑不失配', () => {
  const r = plan(RAW);
  const s = createSession({ planResult: r, raw: RAW, now: 0 });
  assert.equal(isMismatch(s, RAW), false);
  const edited = { ...RAW, units: RAW.units.map((u, i) => (i === 0 ? { ...u, zh: '11' } : u)) };
  assert.equal(isMismatch(s, edited), true);
  const editedParams = { ...RAW, rateEn: '9.5' };
  assert.equal(isMismatch(s, editedParams), true);
  // 标识稳定：同一草稿多次计算一致。
  assert.equal(fingerprintDraft(RAW), fingerprintDraft(structuredClone(RAW)));
});

test('完整流程：真实编排 + 暂停/继续/判定 + 完成汇总', () => {
  const r = plan(RAW);
  const s = createSession({ planResult: r, raw: RAW, now: 0, id: 's2' });
  const dursMs = r.cards.map((c) => Number(c.dur * 1000n / r.meta.timeScale));
  appendEvent(s, 'pass', dursMs[0] - 100, 1);          // 卡 1 到期前通过
  appendEvent(s, 'pause', dursMs[0] + 500);
  appendEvent(s, 'resume', dursMs[0] + 60500);         // 暂停 60 秒
  appendEvent(s, 'rework', dursMs[0] + 60500 + 100, 2); // 继续后判定卡 2
  appendEvent(s, 'pass', dursMs[0] + 60500 + 200, 3);
  appendEvent(s, 'pass', dursMs[0] + 60500 + 300, 4);
  const st = replay(s, 10 ** 9);
  assert.equal(st.status, 'done');
  assert.deepEqual(st.conclusions, ['passed', 'rework', 'passed', 'passed']);
  assert.equal(st.deliverable, 3);
  assert.equal(st.firstRework, 2);
});
