// 无浏览器环境下的页面逻辑冒烟：用最小 DOM 桩执行 public/app.mjs，
// 真实触发「编排」点击、草稿修改失效、不可行渲染等路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

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
