// 定点十进制工具：秒数与阅读上限在解析时记录小数位数，
// 求解前把全部时间统一到公共 10^K 秒量纲（整数 BigInt），
// 约束比较走交叉相乘的整数运算，全程不使用浮点，
// 保证临界合格结论不被浮点近似改变。

const ZERO = 0n;

/**
 * 把十进制字符串精确解析为 { int, dec }：数值 = int / 10^dec。
 * 接受 "12"、"12.3"、"12.30"、"0.001" 等；拒绝指数、负数与非法字符。
 */
export function parseDecimal(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('非法数值');
    input = String(input);
  }
  if (typeof input !== 'string') throw new Error('非法数值');
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`非法数值：${input}`);
  const dot = s.indexOf('.');
  if (dot === -1) return { int: BigInt(s), dec: 0 };
  const whole = s.slice(0, dot);
  const frac = s.slice(dot + 1);
  return { int: BigInt((whole || '0') + frac), dec: frac.length };
}

/** 将 {int, dec} 放大到目标小数位数，返回该量纲下的整数 BigInt。 */
export function rescale(parts, targetDec) {
  if (parts.dec > targetDec) throw new Error('量纲只能放大不能缩小');
  let v = parts.int;
  for (let i = parts.dec; i < targetDec; i++) v *= 10n;
  return v;
}

/**
 * 精确判断 chars / (durUnits / timeScale) <= rateUnits / rateScale，
 * 等价于 chars * timeScale * rateScale <= durUnits * rateUnits（整数比较）。
 * q = timeScale * rateScale 由调用方预算后传入。
 */
export function fits(chars, durUnits, rateUnits, q) {
  return BigInt(chars) * q <= durUnits * rateUnits;
}

/** 阅读压力精确分数（字符/秒）：num/den。 */
export function pressure(chars, durationUnits, timeScale) {
  return { num: BigInt(chars) * timeScale, den: durationUnits };
}

/** 比较两个精确分数（den 恒正）：-1 / 0 / 1。 */
export function cmpFrac(a, b) {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs === rhs ? 0 : (lhs < rhs ? -1 : 1);
}

/** 精确分数转显示：整数部分 + digits 位小数（截断，仅用于展示）。 */
export function fracToText(f, digits = 2) {
  if (f.den === ZERO) return '—';
  const scale = 10n ** BigInt(digits);
  const scaled = f.num * scale / f.den;
  const whole = scaled / scale;
  const frac = scaled % scale;
  return `${whole}.${String(frac).padStart(digits, '0')}`;
}

/** 整数量纲值格式化为十进制字符串（用于时间展示）。 */
export function unitsToText(value, timeScale, K) {
  let neg = '';
  let v = value;
  if (v < ZERO) { neg = '-'; v = -v; }
  const whole = v / timeScale;
  if (K === 0) return `${neg}${whole}`;
  const frac = v % timeScale;
  return `${neg}${whole}.${String(frac).padStart(K, '0')}`;
}

/** 正整数解析（字符串/数字）。 */
export function parsePosInt(input, label) {
  if (typeof input === 'number') {
    if (Number.isInteger(input) && input > 0) return input;
    throw new Error(`${label}必须为正整数`);
  }
  const s = String(input ?? '').trim();
  if (!/^\d+$/.test(s) || BigInt(s) > 9007199254740991n) throw new Error(`${label}必须为正整数`);
  const v = Number(s);
  if (v <= 0) throw new Error(`${label}必须为正整数`);
  return v;
}
