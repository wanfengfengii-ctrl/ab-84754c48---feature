#!/bin/sh
# 一次性校验：代码测试 → 构建 → 静态 HTTP 健康核验 → 字幕编排业务冒烟。
# 任一步失败立即以非 0 退出；退出码即整体结果。
#
# 两种模式：
#   本地运行：未设置 SMOKE_BASE 时，脚本自行在 WEB_PORT 上启动静态服务再核验；
#   Compose：设置 SMOKE_BASE（如 http://web:8080），直接核验已健康的 web 服务容器。
set -eu

cd "$(dirname "$0")/.."

echo "== [1/4] 代码测试 =="
node --test test/*.test.mjs

echo "== [2/4] 构建 =="
node scripts/build.mjs

SERVER_PID=""
if [ -z "${SMOKE_BASE:-}" ]; then
  echo "== [3/4] 启动本地静态服务 =="
  WEB_PORT="${WEB_PORT:-8099}"
  export WEB_PORT
  node scripts/server.mjs &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
  export SMOKE_BASE="http://127.0.0.1:${WEB_PORT}"
else
  echo "== [3/4] 使用外部静态服务：${SMOKE_BASE} =="
fi

echo "== [4/4] 静态 HTTP 健康核验 + 字幕编排业务冒烟 =="
node scripts/smoke.mjs

echo "== verify 全部通过 =="
