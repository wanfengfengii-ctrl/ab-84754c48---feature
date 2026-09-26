// 零依赖静态 Web 服务：托管 dist/（构建产物），提供 /health 健康检查。
// 端口由环境变量 WEB_PORT 配置（默认 8080）；宿主根地址 / 返回 index.html。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.env.WEB_ROOT
  ? path.resolve(process.env.WEB_ROOT)
  : path.join(root, 'dist');
const port = Number(process.env.WEB_PORT || 8080);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`非法 WEB_PORT：${process.env.WEB_PORT}`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    send(res, 200, JSON.stringify({ status: 'ok', port }), 'application/json; charset=utf-8');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }
  // 防路径穿越：规范化后必须仍在 distDir 内。
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = path.normalize(path.join(distDir, rel || 'index.html'));
  if (!filePath.startsWith(distDir + path.sep) && filePath !== distDir) {
    send(res, 403, 'Forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      // 目录不允许列目，回退 404（根路径由上面的 index.html 兜底）。
      send(res, 404, 'Not Found');
      return;
    }
    const data = await readFile(filePath);
    send(res, 200, req.method === 'HEAD' ? '' : data, MIME[path.extname(filePath)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not Found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[web] 静态服务已启动：http://0.0.0.0:${port}/  根目录 ${distDir}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
