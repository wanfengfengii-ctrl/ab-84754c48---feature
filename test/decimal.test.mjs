import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecimal,
  rescale,
  fits,
  pressure,
  cmpFrac,
  fracToText,
  parsePosInt,
} from '../src/decimal.mjs';

test('parseDecimal 精确解析任意位小数', () => {
  assert.deepEqual(parseDecimal('12'), { int: 12n, dec: 0 });
  assert.deepEqual(parseDecimal('12.30'), { int: 1230n, dec: 2 });
  assert.deepEqual(parseDecimal('0.001'), { int: 1n, dec: 3 });
  assert.deepEqual(parseDecimal('1.23456789'), { int: 123456789n, dec: 8 });
  assert.throws(() => parseDecimal('1e2'));
  assert.throws(() => parseDecimal('-1'));
  assert.throws(() => parseDecimal('1.2.3'));
  assert.throws(() => parseDecimal(''));
});

test('临界约束：3 字符 / 0.3 秒 vs 上限 10 字符/秒 必须判定合格', () => {
  // 浮点会算成 3/0.3 = 10.000000000000002 > 10；整数交叉相乘必须判合格。
  const t = parseDecimal('0.3');
  const scale = 10n ** BigInt(t.dec);
  const dur = rescale(t, t.dec);
  const rate = rescale(parseDecimal('10'), parseDecimal('10').dec);
  assert.equal(fits(3, dur, rate, scale), true);
  // 4 字符 / 0.3 秒 = 13.33 > 10，不合格
  assert.equal(fits(4, dur, rate, scale), false);
});

test('其他临界小数不被浮点近似翻转', () => {
  const cases = [
    { chars: 7, dur: '0.7', rate: '10', expect: true },    // 7/0.7 == 10 合格
    { chars: 11, dur: '1.1', rate: '10', expect: true },   // 11/1.1 == 10 合格
    { chars: 1, dur: '0.3', rate: '3.3', expect: false },  // 1/0.3 = 3.333.. > 3.3
    { chars: 33, dur: '10.0', rate: '3.3', expect: true }, // 33/10 = 3.3 == 上限
  ];
  for (const c of cases) {
    const t = parseDecimal(c.dur);
    const ts = 10n ** BigInt(t.dec);
    const rp = parseDecimal(c.rate);
    const rs = 10n ** BigInt(rp.dec);
    assert.equal(
      fits(c.chars, rescale(t, t.dec), rescale(rp, rp.dec), ts * rs),
      c.expect,
      `${c.chars}/${c.dur} vs ${c.rate}`,
    );
  }
});

test('pressure 与 cmpFrac 精确比较', () => {
  // 3/0.3 (=10) 与 10/1 (=10) 必须相等
  const a = pressure(3, 30n, 100n);
  const b = pressure(10, 100n, 100n);
  assert.equal(cmpFrac(a, b), 0);
  assert.equal(fracToText(a, 2), '10.00');
});

test('不同小数位混合量纲：0.30 秒与 0.3 秒等价', () => {
  const t1 = parseDecimal('0.30');
  const t2 = parseDecimal('0.3');
  const K = 2;
  assert.equal(rescale(t1, K), rescale(t2, K));
});

test('parsePosInt', () => {
  assert.equal(parsePosInt('3', 'x'), 3);
  assert.throws(() => parsePosInt('0', 'x'));
  assert.throws(() => parsePosInt('-1', 'x'));
  assert.throws(() => parsePosInt('1.5', 'x'));
});
