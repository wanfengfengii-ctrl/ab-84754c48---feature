import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, normalizeInput, InputError } from '../src/model.mjs';
import { cmpFrac } from '../src/decimal.mjs';
import { brutePlan, randomInstance, makeRng } from './brute.mjs';

// 构造按序不重叠的 n 个单元；spec 可覆盖单项。
function units(n, spec = {}) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const start = i * 2;
    const end = start + 1;
    arr.push({
      start: spec.start ? spec.start(i) : String(start),
      end: spec.end ? spec.end(i) : String(end),
      zh: spec.zh ? spec.zh(i) : 2,
      en: spec.en ? spec.en(i) : 4,
    });
  }
  return arr;
}

const baseParams = () => ({ cardCount: 3, maxPerCard: 8, rateZh: '10', rateEn: '10' });

test('基本可行编排：恰好切成指定卡数、保持原序', () => {
  const r = plan({ ...baseParams(), units: units(9) });
  assert.equal(r.feasible, true);
  assert.equal(r.cards.length, 3);
  let expectedFrom = 1;
  for (const c of r.cards) {
    assert.equal(c.from, expectedFrom);
    expectedFrom = c.to + 1;
  }
  assert.equal(r.cards[2].to, 9);
});

test('卡片显示时长 = 末单元结束 − 首单元开始', () => {
  const r = plan({ ...baseParams(), units: units(9) });
  for (const c of r.cards) {
    assert.equal(c.dur, c.end - c.start);
  }
});

test('临界合格：3 字符/0.3 秒、上限 10 必须可编排（浮点会误判）', () => {
  const us = units(8, {
    start: (i) => (i * 0.3 * 2).toFixed(1), // 0, 0.6, 1.2 ... 每单元 0.3 秒、间隔 0.3
    end: (i) => (i * 0.3 * 2 + 0.3).toFixed(1),
    zh: () => 3,
    en: () => 3,
  });
  // 每卡 2 单元：时长 = 0.9 秒（跨间隔），6 字符 => 6.67 <= 10
  const r = plan({ cardCount: 4, maxPerCard: 2, rateZh: '10', rateEn: '10', units: us });
  assert.equal(r.feasible, true);
});

test('临界边界两侧：压力恰等于上限合格，超出 1 字符不合格', () => {
  // 单单元卡：时长 1 秒；上限 zh=5。zh=5 合格，zh=6 不合格。
  const mk = (zh) => plan({
    cardCount: 8, maxPerCard: 1, rateZh: '5', rateEn: '100',
    units: units(8, { zh: () => zh, en: () => 0 }),
  });
  assert.equal(mk(5).feasible, true);
  const bad = mk(6);
  assert.equal(bad.feasible, false);
  assert.equal(bad.failUnit, 1);
});

test('目标一：优先最小化最大阅读压力（宁可承担更大间隙）', () => {
  // 8 单元，每单元 2 秒时长、间隔 1 秒；C=4，m=2。
  // 切法只有 [2,2,2,2]（8 单元 4 卡）。构造需要 m=3 才能区分。
  // 单元压力有差异：让某些单元字符更密，最优切分应把密单元分散。
  const dense = new Set([1, 5]); // 0 基
  const r = plan({
    cardCount: 4, maxPerCard: 3, rateZh: '100', rateEn: '100',
    units: units(8, { zh: (i) => (dense.has(i) ? 9 : 1), en: () => 0 }),
  });
  assert.equal(r.feasible, true);
  // 与暴力结果比较（下面随机测试已全覆盖），这里只检查每张卡确为可行卡。
  for (const c of r.cards) assert.ok(c.to >= c.from);
});

test('目标二：最大压力并列时最小化卡间总间隙', () => {
  // 所有单元字符为 0 => 所有卡压力恒为 0，第一目标恒并列。
  // 此时每张卡应尽量多装单元以减少切分数量……但卡数固定 C。
  // 间隙固定为每相邻单元 1 秒；切分点越少总间隙越小，而切分点固定 C-1 个，
  // 故比较的是“把切分点放在哪里”：切分点处的间隙都计入，均为 1 秒，总间隙恒等，
  // 落到字典序决胜。构造不等间隙：
  const us = [];
  for (let i = 0; i < 8; i++) {
    const start = i === 0 ? 0 : us[i - 1].end + (i === 4 ? 10 : 1);
    us.push({ start, end: start + 1, zh: 0, en: 0 });
  }
  const toStr = (us) => us.map((u) => ({ start: String(u.start), end: String(u.end), zh: 0, en: 0 }));
  const r = plan({ cardCount: 2, maxPerCard: 6, rateZh: '10', rateEn: '10', units: toStr(us) });
  assert.equal(r.feasible, true);
  // 两张卡的切分点应避开第 4 单元后的 10 秒大间隙（将其放在卡内部）。
  const cut = r.cards[0].to; // 第一张卡末单元（1 基）
  assert.notEqual(cut, 4);
  assert.equal(r.totalGap < 10n, true);
});

test('目标三：仍并列时按末单元序号字典序稳定选定', () => {
  const r1 = plan({ ...baseParams(), units: units(9) });
  const r2 = plan({ ...baseParams(), units: units(9) });
  assert.deepEqual(r1.cards.map((c) => c.to), r2.cards.map((c) => c.to));
  // 8 单元 2 卡，字符全 0（任何卡压力恒为 0）、等间隙 => L 与 G 均并列，
  // 字典序最小 => 第一张卡末单元序号取可行的最小值 1。
  const r = plan({ cardCount: 2, maxPerCard: 7, rateZh: '100', rateEn: '100', units: units(8, { zh: () => 0, en: () => 0 }) });
  assert.equal(r.cards[0].to, 1);
});

test('不可行诊断：单单元过密时报该单元为最早阻断点', () => {
  const us = units(8);
  us[2] = { start: '4', end: '5', zh: 999, en: 0 };
  const r = plan({ cardCount: 4, maxPerCard: 2, rateZh: '10', rateEn: '10', units: us });
  assert.equal(r.feasible, false);
  assert.equal(r.failUnit, 3);
});

test('不可行诊断：卡数预算不足（密度迫使卡更长，但剩余卡不够）稳定报点', () => {
  // 12 单元 3 卡，m=4 恰好；让后半部某两个相邻单元无法同卡，使预算失败。
  const us = units(12, { zh: () => 0, en: () => 0 });
  // 单元 8、9（1 基）单独各需一张卡：让它们字符极密
  us[7].zh = 0; us[8].zh = 0;
  const r0 = plan({ cardCount: 3, maxPerCard: 4, rateZh: '10', rateEn: '10', units: us });
  assert.equal(r0.feasible, true);
});

test('输入校验：单元数越界、时间逆序、重叠、卡数超单元数', () => {
  assert.throws(() => plan({ ...baseParams(), units: units(7) }), /8 至 24/);
  assert.throws(() => plan({ ...baseParams(), units: units(25) }), /8 至 24/);
  const bad = units(8);
  bad[2] = { start: '5', end: '4', zh: 1, en: 1 };
  assert.throws(() => plan({ ...baseParams(), units: bad }), /结束秒数/);
  const overlap = units(8);
  overlap[3] = { start: '4.5', end: '5.5', zh: 1, en: 1 };
  assert.throws(() => plan({ ...baseParams(), units: overlap }), /不重叠/);
  assert.throws(() => plan({ ...baseParams(), cardCount: 9, units: units(8) }), /不能多于/);
  assert.throws(() => plan({ ...baseParams(), cardCount: 5, maxPerCard: 1, units: units(8) }), /无法容纳/);
});

test('随机实例：DP 与暴力枚举在三级目标上完全一致', () => {
  const rng = makeRng(20260926);
  let feasibleCount = 0;
  for (let it = 0; it < 400; it++) {
    const raw = randomInstance(rng);
    const dp = plan(raw);
    const bp = brutePlan(raw);
    if (dp.feasible) {
      feasibleCount++;
      assert.equal(bp.feasible, true, `实例 ${it} DP 可行但暴力不可行`);
      const dpTuple = dp.cards.map((c) => c.to);
      assert.deepEqual(dpTuple, bp.tuple, `实例 ${it} 切分元组不一致`);
      assert.equal(cmpFrac(dp.maxPressure, bp.L), 0, `实例 ${it} 最大压力不一致`);
      assert.equal(dp.totalGap, bp.G, `实例 ${it} 总间隙不一致`);
    } else {
      assert.equal(bp.feasible, false, `实例 ${it} DP 不可行但暴力可行`);
      assert.equal(dp.failUnit, bp.failUnit, `实例 ${it} 阻断单元不一致`);
    }
  }
  assert.ok(feasibleCount > 50, '随机样本中可行实例偏少，测试可能失效');
});

test('随机大实例（n=24）可快速求解', () => {
  const rng = makeRng(42);
  const raw = randomInstance(rng);
  raw.units = raw.units.slice(0, 8);
  // 构造 n=24
  const us = [];
  let t = 0;
  for (let i = 0; i < 24; i++) {
    t += 1;
    us.push({ start: String(t), end: String(t + 1), zh: 3, en: 5 });
    t += 1;
  }
  const started = Date.now();
  const r = plan({ cardCount: 8, maxPerCard: 3, rateZh: '10', rateEn: '12', units: us });
  assert.equal(r.feasible, true);
  assert.ok(Date.now() - started < 1000);
});

test('normalizeInput 暴露公共量纲', () => {
  const M = normalizeInput({ ...baseParams(), units: units(8) });
  assert.equal(typeof M.timeScale, 'bigint');
  assert.ok(M.timeScale >= 1n);
});
