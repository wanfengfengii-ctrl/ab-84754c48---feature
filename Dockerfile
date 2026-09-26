# 纯前端静态应用镜像：Node 22 零依赖（运行时无需 npm install）。
FROM node:22-alpine

WORKDIR /app

# 先拷贝清单与源码，镜像构建时即产出 dist/。
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

# 构建期语法校验 + 汇总静态产物到 dist/。
RUN node scripts/build.mjs

# Web 服务端口；由 WEB_PORT 决定容器内监听端口（默认 8080）。
ENV WEB_PORT=8080
EXPOSE 8080

# 容器健康检查：轮询 /health，失败则标记 unhealthy（shell 形式以支持管道与变量）。
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -q -O - "http://127.0.0.1:${WEB_PORT}/health" | grep -q '"status":"ok"' || exit 1

CMD ["node", "scripts/server.mjs"]
