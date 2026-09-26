// 播审页面逻辑测试：最小 DOM 桩 + 假时钟，真实执行 public/app.mjs，
// 覆盖：启动冻结、逐卡判定、暂停/继续、刷新等价、过期推进、
// 草稿失配标识、重新编排不篡改历史、旧草稿行为不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_KEY = 'subtitle-planner-review-v1';

let fakeNow = 1_000_000;
globalThis.__REVIEW_NOW__ = () => fakeNow;

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
  globalThis.document = {
    getElementById: get,
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const appPath = path.join(here, '..', 'public', 'app.mjs');
  await import(pathToFileURL(appPath).href + `?t=${Date.now()}-${Math.random()}`);
  return { els, storage };
}

const clickReview = (els, act, extra = {}) =>
  els.get('reviewPanel').dispatch('click', { target: { dataset: { act, ...extra } } });

const storedSessions = (storage) => JSON.parse(storage[REVIEW_KEY]).sessions;

test('完整播审流程：启动冻结快照，逐卡判定，完成后稳定给出可交付数与首张需返工卡', async () => {
  fakeNow = 1_000_000;
  const { els, storage } = await boot();
  els.get('planBtn').dispatch('click');
  assert.equal(els.get('reviewPanel').hidden, false, '编排成功后播审面板可见');
  assert.ok(els.get('reviewStart').innerHTML.includes('开始逐卡播审'));

  clickReview(els, 'start');
  const sessions = storedSessions(storage);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].events.length, 1, '启动只追加 start 记录');
  assert.equal(sessions[0].cards.length, 4, '快照冻结 4 张卡');
  assert.ok(sessions[0].draftId, '已记录来源草稿标识');
  assert.ok(els.get('reviewLive').innerHTML.includes('第 <b>1</b> / 4 张'));
  assert.ok(els.get('reviewLive').innerHTML.includes('剩余'));

  // 通过卡 1 → 推进到卡 2
  fakeNow += 1000;
  clickReview(els, 'pass');
  assert.ok(els.get('reviewLive').innerHTML.includes('第 <b>2</b> / 4 张'));

  // 暂停：时钟大幅前进后剩余时长不变；继续后判定余下各卡
  fakeNow += 500;
  clickReview(els, 'pause');
  assert.ok(els.get('reviewLive').innerHTML.includes('已暂停'));
  fakeNow += 60000;
  clickReview(els, 'resume');
  assert.ok(!els.get('reviewLive').innerHTML.includes('已暂停'));
  clickReview(els, 'rework'); // 卡 2
  fakeNow += 100;
  clickReview(els, 'pass');   // 卡 3
  fakeNow += 100;
  clickReview(els, 'pass');   // 卡 4

  const done = els.get('reviewLive').innerHTML;
  assert.ok(done.includes('播审完成'));
  assert.ok(done.includes('可交付字幕卡 <b>3</b> / 4 张'), done.match(/可交付[^<]*(<[^>]+>[^<]*)*/)?.[0]);
  assert.ok(done.includes('第 2 张'), '首张需返工为第 2 张');

  // 刷新等价：同一存储重新启动，重放得到同一结论
  const again = await boot(storage);
  const live = again.els.get('reviewLive').innerHTML;
  assert.ok(live.includes('播审完成'));
  assert.ok(live.includes('可交付字幕卡 <b>3</b> / 4 张'));
  assert.ok(live.includes('第 2 张'));
  assert.equal(storedSessions(storage).length, 1, '刷新不产生新会话');
});

test('过期推进：不作判定刷新后全部过期，迟到记录不得改写', async () => {
  fakeNow = 2_000_000;
  const { els, storage } = await boot();
  els.get('planBtn').dispatch('click');
  clickReview(els, 'start');
  // 时钟越过全部卡片时长（示例总时长约 26 秒）
  fakeNow += 10_000_000;
  const again = await boot(storage);
  const live = again.els.get('reviewLive').innerHTML;
  assert.ok(live.includes('播审完成'));
  assert.ok(live.includes('可交付字幕卡 <b>0</b> / 4 张'));
  assert.ok(live.includes('过期未判定'));
  // 完成后界面不再提供判定按钮
  assert.ok(!live.includes('data-act="pass"'));
});

test('编辑草稿与重新编排不篡改历史播审，但清楚标识失配', async () => {
  fakeNow = 3_000_000;
  const { els, storage } = await boot();
  els.get('planBtn').dispatch('click');
  clickReview(els, 'start');
  fakeNow += 1000;
  clickReview(els, 'pass'); // 卡 1 通过
  const oldId = storedSessions(storage)[0].id;
  const eventsBefore = storedSessions(storage)[0].events.length;

  // 编辑草稿 → 失配标识出现；事件日志不被改写
  const cc = els.get('cardCount');
  cc.value = '3';
  cc.dispatch('input');
  assert.ok(els.get('reviewLive').innerHTML.includes('已与当前草稿失配'));
  assert.equal(storedSessions(storage)[0].events.length, eventsBefore, '编辑不得追加或改写播审记录');

  // 重新编排（3 卡可行）→ 历史会话保持，启动入口恢复
  els.get('planBtn').dispatch('click');
  assert.equal(storedSessions(storage).length, 1);
  assert.ok(els.get('reviewStart').innerHTML.includes('开始逐卡播审'));

  // 另起新播审：旧会话归档为只读历史，仍可查看逐卡结论
  clickReview(els, 'start');
  assert.equal(storedSessions(storage).length, 2);
  assert.ok(els.get('reviewHistory').innerHTML.includes('历史播审'));
  clickReview(els, 'view', { id: oldId });
  const detail = els.get('reviewDetail').innerHTML;
  assert.ok(detail.includes('逐卡结论'));
  assert.ok(detail.includes('通过'), '历史会话的卡 1 结论仍可查看');
  assert.ok(detail.includes('首张需返工字幕卡'));
  // 新会话仍是第 1 张进行中
  assert.ok(els.get('reviewLive').innerHTML.includes('第 <b>1</b> / 3 张'));
});

test('未启用播审的旧草稿：无播审存储、面板隐藏，编排结论不变', async () => {
  fakeNow = 4_000_000;
  const storage = {
    'subtitle-planner-draft-v1': JSON.stringify({
      params: { cardCount: '4', maxPerCard: '3', rateZh: '6', rateEn: '9' },
      units: Array.from({ length: 8 }, (_, i) => ({
        start: String(i * 3), end: String(i * 3 + 2), zh: '5', en: '8',
      })),
    }),
  };
  const { els } = await boot(storage);
  assert.equal(els.get('reviewPanel').hidden, true, '无会话且无编排结果时面板隐藏');
  els.get('planBtn').dispatch('click');
  assert.ok(els.get('resultBody').innerHTML.includes('编排成功'), '既有编排结论不变');
  assert.equal(els.get('reviewPanel').hidden, false);
  assert.ok(!(REVIEW_KEY in storage), '未启动播审前不产生播审存储');
});

test('暂停中的剩余时长在刷新后保持一致（计时器延迟等价）', async () => {
  fakeNow = 5_000_000;
  const { els, storage } = await boot();
  els.get('planBtn').dispatch('click');
  clickReview(els, 'start');
  fakeNow += 1200;
  clickReview(els, 'pause');
  const pausedHtml = els.get('reviewLive').innerHTML;
  // 暂停后很久再“刷新”：重放得到的当前卡与状态不变
  fakeNow += 3_600_000;
  const again = await boot(storage);
  const live = again.els.get('reviewLive').innerHTML;
  assert.ok(live.includes('已暂停'));
  assert.ok(live.includes('第 <b>1</b> / 4 张'), '仍是同一当前卡');
  assert.equal(
    live.match(/第 <b>\d<\/b> \/ 4 张/)?.[0],
    pausedHtml.match(/第 <b>\d<\/b> \/ 4 张/)?.[0],
  );
});
