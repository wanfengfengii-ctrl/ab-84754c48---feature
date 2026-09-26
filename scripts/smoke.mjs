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

await httpSmoke();
await businessSmoke();
console.log('[smoke] 全部冒烟检查通过 ✔');
