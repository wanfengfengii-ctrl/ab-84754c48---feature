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
    ['播审模块引用已改写', (b) => b.includes("from './src/review.mjs'")],
    ['不再引用上级目录', (b) => !b.includes('../src/')],
  ]);
  await expectFetch('/src/model.mjs', [
    ['含 plan 导出', (b) => b.includes('export function plan')],
  ]);
  await expectFetch('/src/review.mjs', [
    ['含播审重放导出', (b) => b.includes('export function replay')],
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

// 常规用例原始输入（编排冒烟与播审冒烟共用）。
const NORMAL_RAW = {
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
  const normal = plan(NORMAL_RAW);
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

// 播审冒烟：对交付产物核验 ① 事件日志重放（含暂停/继续、过期推进、刷新等价、
// 过期与重复记录不改写）② 草稿失配标识且历史播审不被篡改 ③ 既有编排结论不变。
async function reviewSmoke() {
  const distModel = path.join(root, 'dist', 'src', 'model.mjs');
  const distReview = path.join(root, 'dist', 'src', 'review.mjs');
  const { plan } = await import(pathToFileURL(distModel).href);
  const {
    createSession, appendEvent, replay, fingerprintDraft, isMismatch, formatRemaining,
  } = await import(pathToFileURL(distReview).href);

  const base = plan(NORMAL_RAW);
  if (!base.feasible) fail('播审冒烟：常规用例应可行');

  // ① 启动冻结快照与来源草稿标识。
  const T0 = 1_000_000;
  const s = createSession({ planResult: base, raw: NORMAL_RAW, now: T0, id: 'smoke' });
  if (s.draftId !== fingerprintDraft(NORMAL_RAW)) fail('播审草稿标识与来源草稿不一致');
  if (s.cards.length !== base.cards.length) fail('播审快照卡数与编排结果不一致');
  for (let i = 0; i < s.cards.length; i++) {
    if (BigInt(s.cards[i].durUnits) !== base.cards[i].dur) fail(`快照卡 ${i + 1} 时长与编排结果不一致`);
  }
  const dur0Ms = Number(base.cards[0].dur * 1000n / base.meta.timeScale);

  // ② 重放：通过卡 1 → 暂停 → 继续 → 判定卡 2；序列化往返后重放一致（刷新等价）。
  appendEvent(s, 'pass', T0 + dur0Ms - 100, 1);
  appendEvent(s, 'pause', T0 + dur0Ms + 500);
  appendEvent(s, 'resume', T0 + dur0Ms + 60500); // 暂停 60 秒不计入
  appendEvent(s, 'rework', T0 + dur0Ms + 60500 + 100, 2);
  const st1 = replay(s, T0 + dur0Ms + 60500 + 200);
  const st2 = replay(JSON.parse(JSON.stringify(s)), T0 + dur0Ms + 60500 + 200);
  if (JSON.stringify(st1, (k, v) => (typeof v === 'bigint' ? v.toString() : v))
    !== JSON.stringify(st2, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) {
    fail('刷新等价失败：序列化往返后重放结果不一致');
  }
  if (st1.status !== 'playing' || st1.currentCard !== 3) fail(`重放状态错误：${st1.status} 卡 ${st1.currentCard}`);
  if (st1.conclusions.join(',') !== 'passed,rework,pending,pending') fail('逐卡结论重放不一致');
  if (formatRemaining(st1.remaining) === '—') fail('播放中应有剩余时长');
  console.log(`[smoke] 播审重放通过：当前第 ${st1.currentCard} 张，剩余 ${formatRemaining(st1.remaining)} 秒，结论 ${st1.conclusions}`);

  // ③ 过期与重复记录不得改写结果；完成后记录亦不得改写。
  appendEvent(s, 'pass', T0 + dur0Ms + 60500 + 300, 2); // 重复：卡 2 已判定
  appendEvent(s, 'pass', T0 + dur0Ms + 60500 + 400, 3);
  appendEvent(s, 'pass', T0 + dur0Ms + 60500 + 500, 4);
  const done1 = replay(s, T0 + dur0Ms + 60500 + 500);
  if (done1.status !== 'done') fail('全部判定后播审应完成');
  if (done1.deliverable !== 3) fail(`可交付卡数应为 3，实际 ${done1.deliverable}`);
  if (done1.firstRework !== 2) fail(`首张需返工应为第 2 张，实际 ${done1.firstRework}`);
  appendEvent(s, 'rework', T0 + dur0Ms + 70500, 3); // 完成后记录：不得改写
  const done2 = replay(s, T0 + dur0Ms + 80500);
  if (done2.deliverable !== 3 || done2.firstRework !== 2 || done2.conclusions[2] !== 'passed') {
    fail('完成后的记录改写了播审结果');
  }
  console.log(`[smoke] 播审完成结论稳定：可交付 ${done2.deliverable}/${s.cards.length} 张，首张需返工第 ${done2.firstRework} 张`);

  // ④ 过期推进：另起会话不操作，全部卡过期后可交付 0、首张需返工为无。
  const s2 = createSession({ planResult: base, raw: NORMAL_RAW, now: 0, id: 'smoke2' });
  appendEvent(s2, 'pass', 10 ** 9, 1); // 远晚于到期：不得改写
  const allExpired = replay(s2, 10 ** 9);
  if (allExpired.status !== 'done' || allExpired.deliverable !== 0 || allExpired.firstRework !== null) {
    fail('全部过期会话的结论不正确');
  }
  if (allExpired.conclusions.some((c) => c !== 'expired')) fail('过期记录改写了结论');
  console.log('[smoke] 过期推进通过：全部卡过期未判定，迟到记录未改写结果');

  // ⑤ 失配：编辑草稿后标识变化，历史会话快照与结论保持不变。
  const edited = { ...NORMAL_RAW, rateEn: '9.5' };
  if (!isMismatch(s, edited)) fail('编辑草稿后应标识失配');
  if (isMismatch(s, NORMAL_RAW)) fail('未编辑的草稿不应标识失配');
  const snapshotBefore = JSON.stringify(s.cards);
  const replanned = plan(edited); // 重新编排不得触碰历史会话
  if (JSON.stringify(s.cards) !== snapshotBefore) fail('重新编排篡改了历史播审快照');
  if (replay(s, T0 + dur0Ms + 80500).deliverable !== 3) fail('重新编排篡改了历史播审结论');
  console.log('[smoke] 失配标识通过：历史播审不被编辑/重编排篡改');

  // ⑥ 既有编排结论不变：同一输入重放编排，切分元组稳定一致。
  const again = plan(NORMAL_RAW);
  if (JSON.stringify(again.cards.map((c) => c.to)) !== JSON.stringify(base.cards.map((c) => c.to))) {
    fail('既有编排结论不稳定');
  }
  if (replanned.feasible !== true) fail('放宽上限后应仍可编排');
  console.log('[smoke] 既有编排结果核验通过：结论稳定不变');
}

await httpSmoke();
await businessSmoke();
await reviewSmoke();
console.log('[smoke] 全部冒烟检查通过 ✔');
