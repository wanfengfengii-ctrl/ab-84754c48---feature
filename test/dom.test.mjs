// 无浏览器环境下的页面逻辑冒烟：用最小 DOM 桩执行 public/app.mjs，
// 真实触发「编排」点击、草稿修改失效、不可行渲染等路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 桩掉页面倒计时定时器：逐卡推进的正确性由 review 模型测试覆盖，
// 同时避免旧页面实例的 interval 在 Node 中跨 boot 重渲染到新文档。
globalThis.setInterval = () => ({ unref() {}, ref() {} });
globalThis.clearInterval = () => {};

function makeElement(id) {
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    listeners: {},
    children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    dispatch(type, ev = {}) {
      for (const fn of this.listeners[type] || []) fn.call(this, { target: this, ...ev });
    },
    appendChild(child) { this.children.push(child); return child; },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

async function boot(storage = {}) {
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, makeElement(id)); return els.get(id); };
  const created = [];
  globalThis.document = {
    getElementById: get,
    createElement: (tag) => { const e = makeElement(tag); created.push(e); return e; },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };

  const appPath = path.join(here, '..', 'public', 'app.mjs');
  await import(pathToFileURL(appPath).href + `?t=${Date.now()}`);
  return { els, created, storage };
}

test('页面启动后点击编排：渲染成功摘要、卡片与切分图', async () => {
  const { els } = await boot();
  // 默认示例草稿应渲染（8 行单元通过 appendChild 挂入表体）。
  assert.equal(els.get('cardCount').value, '4');
  assert.equal(els.get('unitsBody').children.length, 8);

  els.get('planBtn').dispatch('click');
  const body = els.get('resultBody').innerHTML;
  assert.equal(els.get('resultPanel').hidden, false);
  assert.ok(body.includes('编排成功'), body.slice(0, 200));
  assert.ok(body.includes('字幕卡 1'));
  assert.ok(body.includes('字幕卡 4'));
  assert.ok(body.includes('未承载文字的间隙'));
  assert.ok(body.includes('未采用切分'));
  // 恰好 4 张卡
  assert.equal((body.match(/字幕卡 \d/g) || []).length, 4);
});

test('编辑任一草稿后旧编排立即失效（出现失效横幅），重新编排后消失', async () => {
  const { els } = await boot();
  els.get('planBtn').dispatch('click');
  assert.equal(els.get('staleBanner').hidden, true, '初始无横幅');

  // 修改卡片数输入（模拟校对员编辑草稿）
  const cc = els.get('cardCount');
  cc.value = '3';
  cc.dispatch('input');
  assert.equal(els.get('staleBanner').hidden, false, '改草稿后应显示失效横幅');

  // 重新编排（3 卡可行）
  els.get('planBtn').dispatch('click');
  assert.equal(els.get('staleBanner').hidden, true, '重编排后横幅消失');
  assert.equal((els.get('resultBody').innerHTML.match(/字幕卡 \d/g) || []).length, 3);
});

test('非法输入显示错误信息，不产生新结果', async () => {
  const { els } = await boot();
  els.get('planBtn').dispatch('click');
  const cc = els.get('cardCount');
  cc.value = '99';
  cc.dispatch('input');
  els.get('planBtn').dispatch('click');
  assert.ok(els.get('formError').textContent.includes('输入有误'));
});

test('不可行编排稳定指出最早无法安放的单元', async () => {
  // 预置一份草稿：8 单元、4 卡、每卡 2 个，第 3 单元过密。
  const units = [];
  for (let i = 0; i < 8; i++) {
    units.push({ start: String(i * 2), end: String(i * 2 + 1), zh: '1', en: '1' });
  }
  units[2].zh = '999';
  const storage = {
    'subtitle-planner-draft-v1': JSON.stringify({
      params: { cardCount: '4', maxPerCard: '2', rateZh: '10', rateEn: '10' },
      units,
    }),
  };
  const { els } = await boot(storage);
  els.get('planBtn').dispatch('click');
  const body = els.get('resultBody').innerHTML;
  assert.ok(body.includes('无可行编排'));
  assert.ok(body.includes('第 3 单元'), '应指出第 3 单元');
});

test('刷新等价场景：草稿写入 localStorage，重新启动仍可继续修改', async () => {
  const storage = {};
  const s1 = await boot(storage);
  s1.els.get('rateZh').value = '7.5';
  s1.els.get('rateZh').dispatch('input');
  assert.ok(storage['subtitle-planner-draft-v1'].includes('7.5'));
  // 再次“启动”（新模块上下文读取同一 storage）
  const s2 = await boot(storage);
  assert.equal(s2.els.get('rateZh').value, '7.5');
});

// ---- 逐卡播审 ----

const REVIEW_STORE = 'subtitle-planner-reviews-v1';

function clickReview(els, act, extra) {
  els.get('reviewView').dispatch('click', { target: { dataset: { reviewAct: act }, ...extra } });
}

test('播审：可行编排后可启动，逐卡呈现并记录通过，结论即时可见', async () => {
  const { els, storage } = await boot();
  els.get('planBtn').dispatch('click');
  // 启动前没有播审记录，启动行可见。
  assert.equal(els.get('reviewStartRow').hidden, false);
  assert.equal(storage[REVIEW_STORE], undefined);

  els.get('reviewStartBtn').dispatch('click');
  assert.equal(els.get('reviewStartRow').hidden, true, '启动后启动行收起');
  const view1 = els.get('reviewView').innerHTML;
  assert.ok(view1.includes('字幕卡 1'));
  assert.ok(view1.includes('剩余'));
  assert.ok(view1.includes('通过本卡'));
  assert.ok(view1.includes('需返工'));
  assert.ok(storage[REVIEW_STORE], '播审已持久化');

  clickReview(els, 'pass');
  const view2 = els.get('reviewView').innerHTML;
  assert.ok(view2.includes('字幕卡 1') && view2.includes('通过'), '第 1 卡标记通过');
  assert.ok(view2.includes('is-current'), '已推进到下一当前卡');
});

test('播审：记录需返工后首张需返工卡稳定指向该卡', async () => {
  const { els } = await boot();
  els.get('planBtn').dispatch('click');
  els.get('reviewStartBtn').dispatch('click');
  clickReview(els, 'rework');
  const view = els.get('reviewView').innerHTML;
  assert.ok(view.includes('需返工'));
  // 第 1 卡的返工徽标
  assert.ok(/字幕卡 1[\s\S]*?需返工/.test(view));
});

test('播审：暂停出现暂停标记，继续后恢复播放', async () => {
  const { els } = await boot();
  els.get('planBtn').dispatch('click');
  els.get('reviewStartBtn').dispatch('click');

  clickReview(els, 'pause');
  assert.ok(els.get('reviewView').innerHTML.includes('已暂停'));
  assert.ok(els.get('reviewView').innerHTML.includes('继续'));

  clickReview(els, 'resume');
  const view = els.get('reviewView').innerHTML;
  assert.ok(!view.includes('已暂停'));
  assert.ok(view.includes('暂停'));
});

test('播审：编辑草稿后清楚标识失配，但冻结快照与逐卡结论仍可查看', async () => {
  const { els } = await boot();
  els.get('planBtn').dispatch('click');
  els.get('reviewStartBtn').dispatch('click');
  clickReview(els, 'pass'); // 第 1 卡通过

  // 校对员编辑草稿（不重新编排）。
  const rz = els.get('rateZh');
  rz.value = '7.5';
  rz.dispatch('input');

  assert.equal(els.get('reviewMismatch').hidden, false, '显示失配横幅');
  const view = els.get('reviewView').innerHTML;
  assert.ok(view.includes('与当前草稿失配'));
  assert.ok(/字幕卡 1[\s\S]*?通过/.test(view), '历史逐卡结论未被篡改');
  assert.ok(view.includes('剩余'), '冻结快照仍按其确定时长呈现');
});

test('播审：刷新（重启页面）后重放同一当前卡与逐卡结论', async () => {
  const storage = {};
  const s1 = await boot(storage);
  s1.els.get('planBtn').dispatch('click');
  s1.els.get('reviewStartBtn').dispatch('click');
  clickReview(s1.els, 'pass');
  clickReview(s1.els, 'rework'); // 当前为第 2 卡，判返工

  // 新页面上下文从同一 localStorage 恢复（lastResult 为空，仅靠快照渲染）。
  const s2 = await boot(storage);
  const view = s2.els.get('reviewView').innerHTML;
  assert.ok(/字幕卡 1[\s\S]*?通过/.test(view), '第 1 卡通过结论恢复');
  assert.ok(/字幕卡 2[\s\S]*?需返工/.test(view), '第 2 卡返工结论恢复');
  assert.ok(view.includes('is-current'), '当前卡随重放恢复');
});

test('播审：收起当前播审并重新编排后，历史播审保留并标识失配、可重新打开', async () => {
  const { els } = await boot();
  els.get('planBtn').dispatch('click');
  els.get('reviewStartBtn').dispatch('click');
  clickReview(els, 'pass');
  const reviewId = els.get('reviewView').innerHTML.match(/播审 <b>([^<]+)</)[1];

  // 收起当前播审（记录保留）；编排仍可行时启动行重新可用。
  clickReview(els, 'close');

  // 编辑并重新编排（rateZh 6 -> 7 仍可行）。
  const rz = els.get('rateZh');
  rz.value = '7';
  rz.dispatch('input');
  els.get('planBtn').dispatch('click');
  assert.equal(els.get('reviewStartRow').hidden, false, '新编排可启动新播审');

  els.get('reviewStartBtn').dispatch('click');
  // 旧播审进入历史区并标识失配。
  assert.equal(els.get('reviewHistoryWrap').hidden, false);
  const hist = els.get('reviewHistory').innerHTML;
  assert.ok(hist.includes(reviewId), '历史区保留旧播审');
  assert.ok(hist.includes('与当前草稿失配'));

  // 打开旧播审：仍可查看每卡结论（第 1 卡通过）。
  els.get('reviewHistory').dispatch('click', {
    target: { closest: () => ({ dataset: { reviewSwitch: reviewId } }) },
  });
  const view = els.get('reviewView').innerHTML;
  assert.ok(view.includes(reviewId));
  assert.ok(/字幕卡 1[\s\S]*?通过/.test(view), '旧播审每卡结论仍可查看');
  assert.ok(view.includes('与当前草稿失配'));
});

test('未启动播审的旧草稿：播审面板仅给占位提示，不影响既有编排结论', async () => {
  const { els } = await boot();
  els.get('planBtn').dispatch('click');
  assert.equal(els.get('resultPanel').hidden, false);
  assert.ok(els.get('resultBody').innerHTML.includes('编排成功'));
  assert.equal(els.get('reviewStartRow').hidden, false, '可随时启动播审');
});
