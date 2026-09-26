# 口述史双语字幕卡编排（纯前端）

文献数字化中心为口述史片段制作双语字幕时使用的编排工具。校对员在浏览器录入
**8–24 个不可拆分语义单元**的起止秒数与中英文字符数，以及成片参数
（字幕卡数、每卡最多单元数、中英每秒阅读上限），点击「编排」后，应用把全部单元
**按原顺序恰好切成指定数量的连续字幕卡**，并按三级目标选出唯一稳定方案。

## 优化与约束

- 卡片显示时长 = 该卡末单元结束 − 首单元开始；
- 每种语言的字符总数 / 显示时长 不得超过对应每秒阅读上限；
- 判定全程使用十进制整数（BigInt 交叉相乘），**不引入浮点**，
  临界合格（如 `3 字符 / 0.3 秒` 恰等于上限 `10`）不会被近似翻转；
- 方案按以下字典序决胜：
  1. 所有卡片中两种语言的**最大阅读压力**最小（min-max DP）；
  2. 卡片之间**未承载文字的总间隙**最小（阈值化后第二阶段 DP）；
  3. 仍并列时，按各卡末单元输入序号元组的**字典序**稳定选定；
- 无可行编排时，稳定指出**最早无法在剩余卡数内安放的单元**（1 基序号）。

草稿保存在浏览器 `localStorage`：编辑任一内容后旧编排立即标记失效，
刷新页面仍可继续修改草稿并重新编排。

## 目录

```
src/decimal.mjs     精确十进制解析、整数量纲、压力分数比较
src/model.mjs       输入校验、三阶段动态规划、不可行诊断
public/             静态页面（index.html / styles.css / app.mjs）
scripts/build.mjs   零依赖构建：语法校验并汇总到 dist/
scripts/server.mjs  静态 Web 服务，含 /health 健康检查（端口取 WEB_PORT）
scripts/smoke.mjs   HTTP 健康核验 + 字幕编排业务冒烟
scripts/verify.sh   测试 → 构建 → 健康核验 → 业务冒烟，退出码报告结果
test/               node:test 测试（含暴力枚举对照与页面 DOM 桩测试）
```

## 本地运行（无需 npm install，Node ≥ 22）

```sh
node scripts/build.mjs
WEB_PORT=8080 node scripts/server.mjs
# 打开 http://localhost:8080/
```

一键自检：

```sh
sh scripts/verify.sh          # 自行启动临时服务并核验，退出码 0 表示全部通过
```

## Docker

```sh
# 构建并启动常驻 Web 服务（宿主机端口由 WEB_PORT 配置，默认 8080）
WEB_PORT=8080 docker compose up --build web

# 一次性校验服务：测试、构建、静态 HTTP 健康核验、字幕编排业务冒烟，
# 以退出码报告结果
docker compose up --build verify
```

- `web` 提供容器内健康检查（`GET /health` → `{"status":"ok"}`）；
- `verify` 等待 `web` 健康后，跨容器对其做 HTTP 核验，并直接对
  构建产物 `dist/src/model.mjs` 运行业务冒烟（临界合格、常规编排、不可行诊断）。

## 测试

```sh
node --test test/*.test.mjs
```

- `decimal.test.mjs`：精确十进制与临界约束；
- `model.test.mjs`：约束、三级目标、不可行诊断、n=24 性能；
- `brute.mjs` + 随机对照：DP 与全部切分的暴力枚举在数千随机实例上逐一一致；
- `dom.test.mjs`：最小 DOM 桩下真实执行页面编排、失效标记、持久化路径。
