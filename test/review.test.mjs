// 逐卡播审（事件溯源重放）测试：快照冻结、草稿标识、播放时间轴、
// 暂停/继续、只允许判定当前未过期卡、过期/重复/错卡事件不可改写结论、
// 刷新等价（序列化后重放一致）、完成后的可交付卡数与首张返工卡。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../src/model.mjs';
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
  durationMicros,
} from '../src/review.mjs';

// 8 单元（每单元 1 秒、首尾相接），4 卡每卡 2 单元 => 每卡显示时长 2 秒。
function raw4x2() {
  return {
    cardCount: '4', maxPerCard: '2', rateZh: '100', rateEn: '100',
    units: Array.from({ length: 8 }, (_, i) => ({
      start: String(i), end: String(i + 1), zh: '1', en: '1',
    })),
  };
}

function startReview(raw = raw4x2(), at = 0) {
  const result = plan(raw);
  assert.equal(result.feasible, true);
  return createReview(raw, result, { now: at });
}

const SEC = 1_000_000n; // 微钟

test('启动即冻结快照：卡数、时长与来源草稿标识不可变', () => {
  const raw = raw4x2();
  const review = startReview(raw, 1000);
  assert.equal(review.cardCount, 4);
  assert.equal(review.cards.length, 4);
  assert.equal(review.draftId, fingerprint(raw));
  for (const c of review.cards) {
    assert.equal(durationMicros(c.dur, review.timeScale), 2n * SEC);
  }
  assert.deepEqual(review.events, [{ type: 'start', at: 1000 }]);
  // 快照持有逐单元数据，失配后仍可查看原文单元。
  assert.equal(review.units.length, 8);
});

test('草稿标识：输入不变则稳定，任一字段编辑即失配', () => {
  const a = raw4x2();
  const b = raw4x2();
  assert.equal(fingerprint(a), fingerprint(b));
  const edited = raw4x2();
  edited.units[0].zh = '2';
  assert.notEqual(fingerprint(a), fingerprint(edited));
  edited.units[0].zh = '1';
  assert.equal(fingerprint(a), fingerprint(edited));
  const reOrderedKeys = raw4x2();
  assert.equal(fingerprint(a), fingerprint(reOrderedKeys)); // 键顺序不影响
});

test('播放中按每卡确定时长依次推进，剩余时间随墙钟递减', () => {
  const review = startReview();
  let s = replay(review, 0);
  assert.equal(s.phase, 'playing');
  assert.equal(s.current, 1);
  assert.equal(s.remainingMicros, 2n * SEC);

  s = replay(review, 1000);
  assert.equal(s.current, 1);
  assert.equal(s.remainingMicros, SEC);

  // 到达第 1 卡边界：自动进入第 2 卡，第 1 卡未判 => 过期。
  s = replay(review, 2000);
  assert.equal(s.current, 2);
  assert.equal(s.statuses[0], 'expired');
  assert.equal(s.remainingMicros, 2n * SEC);
});

test('在未过期窗口内判定通过/返工，立即进入下一张卡并给足完整时长', () => {
  const review = startReview();
  review.events.push(verdictEvent(1, 'pass', 1000));
  let s = replay(review, 1000);
  assert.equal(s.current, 2);
  assert.equal(s.statuses[0], 'pass');
  assert.equal(s.remainingMicros, 2n * SEC); // 下一张卡从判定时刻起算整段

  review.events.push(verdictEvent(2, 'rework', 1500));
  s = replay(review, 1500);
  assert.equal(s.current, 3);
  assert.equal(s.statuses[1], 'rework');
  assert.equal(s.firstRework, 2);
  assert.equal(s.deliverable, 1);
});

test('过期后才到达的判定无效：结论为已过期且不可改写', () => {
  const review = startReview();
  // 第 1 卡 2000ms 到期；3000ms 时补发通过。
  review.events.push(verdictEvent(1, 'pass', 3000));
  const s = replay(review, 3000);
  assert.equal(s.statuses[0], 'expired');
  assert.equal(s.current, 2); // 不因补发而跳卡
  assert.deepEqual(s.verdicts, []);
});

test('错卡与重复判定事件一律无效', () => {
  const review = startReview();
  review.events.push(verdictEvent(2, 'pass', 100));   // 当前是第 1 卡
  review.events.push(verdictEvent(1, 'pass', 200));
  review.events.push(verdictEvent(1, 'rework', 300)); // 重复判定
  const s = replay(review, 300);
  assert.equal(s.statuses[0], 'pass');
  assert.equal(s.current, 2);
  assert.equal(s.verdicts.length, 1);
});

test('暂停冻结剩余时长，继续后从同一剩余值走完；暂停期间仍可判定当前卡', () => {
  const review = startReview();
  review.events.push(pauseEvent(1000)); // 第 1 卡用掉 1 秒
  let s = replay(review, 9000);         // 暂停中任意时刻
  assert.equal(s.phase, 'paused');
  assert.equal(s.remainingMicros, SEC); // 剩余不随墙钟流逝

  review.events.push(verdictEvent(1, 'pass', 9000)); // 暂停期判定有效
  s = replay(review, 9000);
  assert.equal(s.current, 2);
  assert.equal(s.remainingMicros, 2n * SEC);

  review.events.push(resumeEvent(10000));
  s = replay(review, 11000);
  assert.equal(s.phase, 'playing');
  assert.equal(s.current, 2);
  assert.equal(s.remainingMicros, SEC);

  // 重复暂停/继续幂等。
  review.events.push(pauseEvent(11000));
  review.events.push(pauseEvent(11100));
  review.events.push(resumeEvent(12000));
  review.events.push(resumeEvent(12100));
  s = replay(review, 13000); // 12000 继续，到 13000 又走 1 秒：第 2 卡恰好用完
  assert.equal(s.current, 3);
  assert.equal(s.statuses[1], 'expired');
});

test('重复 start 不重启时间轴', () => {
  const review = startReview(raw4x2(), 0);
  review.events.push(verdictEvent(1, 'pass', 500));
  review.events.push({ type: 'start', at: 5000 });
  const s = replay(review, 600);
  assert.equal(s.current, 2);
  assert.equal(s.statuses[0], 'pass');
});

test('全部判定完成：稳定给出可交付卡数与首张需返工卡', () => {
  const review = startReview();
  // 第 1 卡通过、第 2 卡返工、第 3 卡过期（不判，让它走完）、第 4 卡通过。
  review.events.push(verdictEvent(1, 'pass', 100));     // t=0.1，cur=2 窗口 [0.1,2.1)
  review.events.push(verdictEvent(2, 'rework', 200));   // cur=3 窗口 [0.2,2.2)
  // 第 3 卡 2.2 秒（播放微秒）过期；墙钟在暂停中不计入。
  review.events.push(pauseEvent(500));
  review.events.push(resumeEvent(9000));                // 暂停很久不影响
  const p3EndWall = 9000 + (2200 - 500);                // 播放微秒到 2200 的墙钟
  review.events.push(verdictEvent(4, 'pass', p3EndWall + 100));
  const s = replay(review, p3EndWall + 100);
  assert.equal(s.phase, 'done');
  assert.equal(s.statuses.join(','), 'pass,rework,expired,pass');
  assert.equal(s.deliverable, 2);
  assert.equal(s.firstRework, 2);
});

test('无返工完成时首张返工卡为空，可交付卡数为总卡数', () => {
  const review = startReview();
  for (let i = 0; i < 4; i++) review.events.push(verdictEvent(i + 1, 'pass', 100 * (i + 1)));
  const s = replay(review, 400);
  assert.equal(s.phase, 'done');
  assert.equal(s.deliverable, 4);
  assert.equal(s.firstRework, null);
});

test('完全不判定：全部卡依次过期，仍稳定完成并给出 0 可交付', () => {
  const review = startReview();
  const s = replay(review, 8001);
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.statuses, ['expired', 'expired', 'expired', 'expired']);
  assert.equal(s.deliverable, 0);
  assert.equal(s.firstRework, null);
});

test('刷新等价：序列化（含 BigInt）后重放得到同一当前卡、剩余时长与逐卡结论', () => {
  const review = startReview();
  review.events.push(verdictEvent(1, 'pass', 800));
  review.events.push(pauseEvent(1200));
  const before = replay(review, 5000);

  const restored = deserializeReview(serializeReview(review));
  assert.ok(restored);
  const after = replay(restored, 5000);
  assert.equal(after.phase, before.phase);
  assert.equal(after.current, before.current);
  assert.equal(after.remainingMicros, before.remainingMicros);
  assert.deepEqual(after.statuses, before.statuses);
  assert.equal(after.deliverable, before.deliverable);
  assert.equal(after.firstRework, before.firstRework);
  assert.equal(typeof after.remainingMicros, 'bigint');
});

test('损坏的持久化记录安全回退为 null', () => {
  assert.equal(deserializeReview('not-json'), null);
  assert.equal(deserializeReview(JSON.stringify({ v: 99, cards: [], events: [] })), null);
});

test('时钟回拨不产生负剩余时长', () => {
  const review = startReview();
  const s = replay(review, -500);
  assert.equal(s.current, 1);
  assert.equal(s.remainingMicros, 2n * SEC);
});

test('不可行结果不能启动播审', () => {
  const raw = raw4x2();
  const bad = plan({ ...raw, rateZh: '0.0001' });
  assert.equal(bad.feasible, false);
  assert.throws(() => createReview(raw, bad, { now: 0 }), /可行/);
});

test('microsToSeconds 仅用于展示的截断格式', () => {
  assert.equal(microsToSeconds(1_500_000n, 1), '1.5');
  assert.equal(microsToSeconds(1_590_000n, 1), '1.5'); // 截断
  assert.equal(microsToSeconds(0n, 1), '0.0');
});
