// 零依赖构建：语法校验全部 JS 模块，然后把 public/ 与 src/ 汇总到 dist/。
// dist/ 即静态 Web 根：app.mjs 在 dist 根、算法模块在 dist/src/，
// 因此把 app.mjs 里的 '../src/' 引用改写为 './src/'。
import { cp, rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

function checkSyntax(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

async function main() {
  // 1) 语法校验。
  for (const f of ['src/decimal.mjs', 'src/model.mjs', 'src/review.mjs', 'public/app.mjs']) {
    checkSyntax(path.join(root, f));
  }
  // 算法模块再实际加载一次，确保导入与顶层代码无误。
  await import(path.join(root, 'src', 'model.mjs'));
  await import(path.join(root, 'src', 'review.mjs'));

  // 2) 复制产物。
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, 'public'), dist, { recursive: true });
  await cp(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true });

  // 3) 改写产物中的相对引用。
  const appPath = path.join(dist, 'app.mjs');
  const appSrc = await readFile(appPath, 'utf8');
  await writeFile(appPath, appSrc.replaceAll('../src/', './src/'));
  checkSyntax(appPath);

  const files = await readdir(dist);
  if (!files.includes('index.html')) throw new Error('构建失败：index.html 缺失');
  if (!files.includes('src')) throw new Error('构建失败：src/ 缺失');
  console.log('[build] dist/ 已生成：', files.join(', '));
}

main().catch((e) => {
  console.error('[build] 失败：', e.stderr?.toString() || e.message);
  process.exit(1);
});
