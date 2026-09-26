// 业务 + HTTP 冒烟：
//  1) 轮询 /health，要求 200 且 JSON status=ok；
//  2) 通过 HTTP 拉取首页与编排脚本/算法模块，验证构建产物完整、引用已改写；
//  3) 对“实际交付的 dist 产物”执行编排冒烟：
//     - 临界合格（3 字符/0.3 秒 vs 上限 10，浮点会误判，必须判可行）；
//     - 常规用例验证卡数与最优性字段存在；
//     - 不可行用例稳定指出最早无法安放的单元。
// 全部通过则以退出码 0 报告，否则非 0。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const base = process.env.SMOKE_BASE || `http://127.0.0.1:${process.env.SMOKE_PORT || process.env.WEB_PORT || 8099}`;

function fail(msg) {
  console.error(`[smoke] 失败：${msg}`);
  process.exit(1);
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200) {
        const j = await jsonOrText(res);
        if (j && j.status === 'ok') {
          console.log(`[smoke] /health 200 ${JSON.stringify(j)}`);
          return;
        }
        lastErr = new Error(`health 内容异常：${JSON.stringify(j)}`);
      } else {
        lastErr = new Error(`HTTP ${res.status}`);
      }
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`健康检查未通过：${lastErr?.message}`);
}

async function jsonOrText(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

async function expectFetch(route, checks) {
  const res = await fetch(`${base}${route}`);
  if (res.status !== 200) fail(`GET ${route} 返回 ${res.status}`);
  const body = await res.text();
  for (const [label, test] of checks) {
    if (!test(body)) fail(`GET ${route} 未通过校验：${label}`);
  }
  console.log(`[smoke] GET ${route} 200（${body.length} 字节）`);
  return body;
}

async function httpSmoke() {
  await waitForHealth();
  await expectFetch('/', [
    ['包含标题', (b) => b.includes('口述史双语字幕卡编排')],
    ['引用 app.mjs', (b) => b.includes('./app.mjs')],
  ]);
  const app = await expectFetch('/app.mjs', [
    ['产物引用已改写为 ./src/', (b) => b.includes("from './src/model.mjs'")],
    ['不再引用上级目录', (b) => !b.includes('../src/')],
  ]);
  await expectFetch('/src/model.mjs', [
    ['含 plan 导出', (b) => b.includes('export function plan')],
  ]);
  await expectFetch('/src/review.mjs', [
    ['含播审重放导出', (b) => b.includes('export function replay')],
    ['快照只追加事件', (b) => b.includes("type: 'verdict'")],
  ]);
  await expectFetch('/src/decimal.mjs', [
    ['含精确判定', (b) => b.includes('BigInt(chars) * q <= durUnits * rateUnits')],
  ]);
  await expectFetch('/styles.css', [['含样式', (b) => b.includes('.card-block')]]);
  // 静态服务不应被路径穿越。
  const evil = await fetch(`${base}/..%2f..%2fpackage.json`);
  if (evil.status !== 403 && evil.status !== 404) fail(`路径穿越防护失效：${evil.status}`);
  console.log('[smoke] 静态资源与路径防护核验通过');
  return app;
}

async function businessSmoke() {
  // 直接从交付产物 dist/ 加载，确保被验证的就是上线代码。
  const distModel = path.join(root, 'dist', 'src', 'model.mjs');
  const { plan } = await import(pathToFileURL(distModel).href);

  // (a) 临界合格：每单元 0.3 秒 3 字符，单单元卡压力恰等于上限 10。
  const criticalUnits = Array.from({ length: 8 }, (_, i) => ({
    start: (i * 2 * 0.3).toFixed(1),
    end: (i * 2 * 0.3 + 0.3).toFixed(1),
    zh: '3', en: '3',
  }));
  const crit = plan({ cardCount: '8', maxPerCard: '1', rateZh: '10', rateEn: '10', units: criticalUnits });
  if (!crit.feasible) fail('临界合格用例被误判为不可行（浮点近似风险）');
  if (crit.cards.length !== 8) fail('临界用例卡数不为 8');
  console.log('[smoke] 临界合格用例通过：3 字符 / 0.3 秒 = 上限 10，判定可行');

  // (b) 常规用例：4 卡、8 单元。
  const normal = plan({
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
  });
  if (!normal.feasible) fail('常规用例应可行');
  if (normal.cards.length !== 4) fail('常规用例卡数不为 4');
  if (typeof normal.totalGap !== 'bigint') fail('总间隙应为精确整数');
  if (normal.maxPressure.num === undefined) fail('最大压力应为精确分数');
  const tuples = normal.cards.map((c) => c.to);
  if (tuples[3] !== 8) fail('末卡须覆盖到第 8 单元');
  console.log(`[smoke] 常规编排通过：切分末单元序号 ${tuples.join(' | ')}，总间隙（量纲整数）${normal.totalGap}`);

  // (c) 不可行：第 3 单元过密，任何卡都放不下，须稳定报第 3 单元。
  const bad = [
    { start: '0', end: '1', zh: '1', en: '1' },
    { start: '2', end: '3', zh: '1', en: '1' },
    { start: '4', end: '5', zh: '999', en: '1' },
    { start: '6', end: '7', zh: '1', en: '1' },
    { start: '8', end: '9', zh: '1', en: '1' },
    { start: '10', end: '11', zh: '1', en: '1' },
    { start: '12', end: '13', zh: '1', en: '1' },
    { start: '14', end: '15', zh: '1', en: '1' },
  ];
  const inf = plan({ cardCount: '4', maxPerCard: '2', rateZh: '10', rateEn: '10', units: bad });
  if (inf.feasible) fail('过密用例应不可行');
  if (inf.failUnit !== 3) fail(`不可行诊断应指向第 3 单元，实际 ${inf.failUnit}`);
  console.log('[smoke] 不可行诊断通过：稳定指向第 3 单元');
}

async function reviewSmoke() {
  // 直接从交付产物 dist/ 加载播审模型，核验重放、失配与既有编排结果共存。
  const distReview = path.join(root, 'dist', 'src', 'review.mjs');
  const distModel = path.join(root, 'dist', 'src', 'model.mjs');
  const {
    createReview, replay, fingerprint, verdictEvent, pauseEvent, resumeEvent,
    serializeReview, deserializeReview,
  } = await import(pathToFileURL(distReview).href);
  const { plan } = await import(pathToFileURL(distModel).href);

  // 8 单元、4 卡（每卡 2 单元、每单元 1 秒）=> 每卡确定显示 2 秒。
  const raw = {
    cardCount: '4', maxPerCard: '2', rateZh: '100', rateEn: '100',
    units: Array.from({ length: 8 }, (_, i) => ({
      start: String(i), end: String(i + 1), zh: '1', en: '1',
    })),
  };
  const result = plan(raw);
  if (!result.feasible) fail('播审冒烟：编排应可行');

  // (1) 启动冻结快照与来源草稿标识。
  const review = createReview(raw, result, { now: 0 });
  if (review.cardCount !== 4) fail('快照卡数应为 4');
  if (review.draftId !== fingerprint(raw)) fail('快照须携带来源草稿标识');
  if (review.events.length !== 1 || review.events[0].type !== 'start') fail('启动仅追加 start 事件');

  // (2) 重放：第 1 卡在 1 秒时通过；暂停后剩余冻结；继续；第 2 卡返工；
  //     第 3 卡不判而过期；刷新等价（序列化往返）后结论一致。
  review.events.push(verdictEvent(1, 'pass', 1000));
  review.events.push(pauseEvent(1500));
  let st = replay(review, 50000);
  if (st.current !== 2) fail(`暂停中当前卡应为 2，实际 ${st.current}`);
  if (st.remainingMicros !== 1_500_000n) fail(`暂停冻结剩余时长，期望 1.5 秒，实际 ${st.remainingMicros}`);
  review.events.push(resumeEvent(60000));
  review.events.push(verdictEvent(2, 'rework', 60500)); // 第 2 卡刚开始即返工
  review.events.push(verdictEvent(3, 'pass', 999999));  // 迟到事件（第 3 卡早已过期），必须无效
  st = replay(deserializeReview(serializeReview(review)), 70000);
  if (st.statuses[0] !== 'pass' || st.statuses[1] !== 'rework') fail('逐卡结论重放错误');
  if (st.statuses[2] !== 'expired') fail(`第 3 卡应已过期，实际 ${st.statuses[2]}`);
  if (st.verdicts.length !== 2) fail('迟到/重复事件不得产生判定');
  if (st.firstRework !== 2) fail(`首张需返工卡应为 2，实际 ${st.firstRework}`);

  // (3) 失配：编辑草稿（不改历史播审），标识应翻转且历史结论不变。
  const edited = structuredClone(raw);
  edited.units[0].zh = '2';
  if (fingerprint(edited) === review.draftId) fail('编辑草稿后标识必须改变（失配）');
  const st2 = replay(review, 70000);
  if (st2.statuses.join(',') !== st.statuses.join(',')) fail('失配不得篡改历史播审结论');

  // (4) 完成后稳定给出可交付卡数与首张返工卡。
  const done = createReview(raw, result, { now: 0 });
  done.events.push(verdictEvent(1, 'pass', 100));
  done.events.push(verdictEvent(2, 'rework', 200));
  done.events.push(verdictEvent(3, 'pass', 300));
  done.events.push(verdictEvent(4, 'pass', 400));
  const ds = replay(done, 400);
  if (ds.phase !== 'done') fail('全部判定后应完成');
  if (ds.deliverable !== 3) fail(`可交付卡数应为 3，实际 ${ds.deliverable}`);
  if (ds.firstRework !== 2) fail(`首张需返工卡应为 2，实际 ${ds.firstRework}`);
  console.log('[smoke] 播审重放/失配/完成汇总核验通过：可交付 3 张，首张返工第 2 张');
}

await httpSmoke();
await businessSmoke();
await reviewSmoke();
console.log('[smoke] 全部冒烟检查通过 ✔');
