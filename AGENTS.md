# AGENTS.md

仓库开发指南。**进入本仓库工作的 agent 必读**。

## 项目定位

**ha-ai-designer** — 本地优先的 Home Assistant Lovelace 仪表板 AI 设计工具。
设计思路参考 [nexu-io/open-design](https://github.com/nexu-io/open-design)（SKILL.md / DESIGN.md / 沙箱预览 / 流式生成范式），目标域是 HA 卡片 YAML 而非通用 HTML。

## 核心文档索引

- `README.md` — 用户视角的快速开始
- `docs/architecture.md` — 整体架构（后续补）
- `docs/skills-protocol.md` — SKILL.md 协议（后续补）
- `docs/lovelace-schema.md` — Lovelace YAML 的结构化 schema（后续补）

## Workspace 目录

来源：`pnpm-workspace.yaml`。

| 路径 | 用途 |
|---|---|
| `apps/web` | Next.js 14 App Router 前端（待建） |
| `apps/daemon` | Express + better-sqlite3 本地守护进程（待建） |
| `packages/contracts` | 共享 TypeScript 类型 / DTO（纯 TS，无运行时依赖） |
| `tools/dev` | 本地 lifecycle 控制平面（`pnpm tools-dev start/stop/run/status/logs`） |

**顶层内容目录**（与 open-design 一致）：

| 路径 | 用途 |
|---|---|
| `skills/` | HA 场景技能（SKILL.md）— `skills/living-room/SKILL.md` 等 |
| `design-systems/` | HA 主题（DESIGN.md）— `design-systems/governance-formal/DESIGN.md` 等 |
| `craft/` | 通用 HA 美学工艺（`craft/ha-spacing.md` 等） |
| `data/` | 运行时数据（gitignore）：SQLite、项目、缓存、会话、artifacts、备份、日志 |
| `deploy/` | Docker / 后续 Add-on 部署产物 |
| `docs/` | 文档 |

## 开发环境

- **Node**：`>=20`，推荐 `24`（与上游 open-design 对齐）。`corepack enable` 在 Windows 会 EPERM，请用 `npm install -g pnpm@10.33.2`。
- **pnpm**：`10.33.2`（与上游对齐，锁文件已 pin）。
- **包管理**：禁止把运行时依赖塞进根 `package.json`；必须放进对应 workspace 包的 `dependencies` / `devDependencies`。
- **TypeScript**：`tsconfig.base.json` 是公共基底；各包用 `extends` 继承，不要复制 compilerOptions。

## Windows 原生注意事项

参考 open-design AGENTS.md，Windows 上：

- `corepack enable` 写 shim 到 `Program Files` 失败 → 用 `npm install -g pnpm`。
- `better-sqlite3` 在 win32/Node 24 没预编译二进制 → 首次 `pnpm install` 会用 node-gyp 源码编译（~2 分钟），需要 Visual Studio Build Tools 2022+。这是预期行为，不是版本不兼容。

## Lifecycle

**唯一入口**：`pnpm tools-dev <subcommand>`。

```bash
pnpm tools-dev start --daemon-port 7456 --web-port 3000   # 启动 daemon + web（后台）
pnpm tools-dev stop                                       # 停掉所有
pnpm tools-dev status                                     # 查看进程状态
pnpm tools-dev run web --daemon-port 7456 --web-port 3000 # 前台运行（推荐开发时）
pnpm tools-dev logs --daemon                              # 尾部日志
pnpm tools-dev check                                      # 健康检查
```

`tools-dev` 会 export `HA_DAEMON_PORT` 和 `HA_WEB_PORT` 给子进程；不要用裸 `pnpm dev` / `pnpm start` / `pnpm daemon`。

## 端口约定

- `daemon`：默认 `7456`（与 open-design 对齐）。所有 `/api/*` 在这上面。
- `web`：默认 `3000`（Next.js 默认）。

## 根命令边界

保留根 `package.json` 里的命令仅做仓库级检查 / 工具入口：

- `pnpm tools-dev`（tools 入口）
- `pnpm typecheck`（仓库级，遍历各包）
- `pnpm build`（仓库级）
- `pnpm guard`（仓库级 lint / 静态检查 — 待补）

**禁止**添加根 `pnpm dev` / `pnpm start` / `pnpm test` 别名。dev/test/build 命令必须落在包内（`pnpm --filter <pkg> ...`）。

## 命名与文件规范

- 文件名用 kebab-case（`ha-tools.ts`），不混 snake_case / camelCase。
- 路由文件：`routes/<feature>.ts`，导出一个 `register(app)` 函数。
- DTO 放在 `packages/contracts/src/api/<feature>.ts`，**纯 TS**，禁止引 Node / 浏览器 / Next / Express / SQLite API。
- 写日志统一用 `pino`（待加），不混 `console.log`。
- 中文注释 / README 用简体中文；代码 / 命令 / 变量名一律英文。

## 验证策略

- 改完一个包必须跑 `pnpm --filter <pkg> typecheck`。
- 改完 `apps/daemon` / `apps/web` 必须跑 `pnpm tools-dev check`。
- 改完 `pnpm-workspace.yaml` 或根 `package.json` 必须 `pnpm install`。

## 安全模型（先记下，后续落实）

- daemon 默认绑 `127.0.0.1`，不暴露外网。
- HA Long-Lived Token 不进 git：写在 `data/config.json`（gitignore），mode 0600。**禁止** echo 到日志、commit message、截图、Issue / PR 描述、对话历史里。
- 渲染预览走 sandboxed iframe（与 open-design 同款 `srcdoc` + sandbox），不直接 embed HA 域名（避免 XSS 跨域）。
- 写回 HA 之前必须给用户 dry-run diff，强制点确认。

## 读写分离护栏（硬性规则）

HA 适配器分两类操作：

- **只读**（GET 类）：`/api/`、`/api/states`、`/api/services`、`/api/lovelace/config`、`/api/dashboards/*`（GET）、`/api/calendars`、`/api/history` — 直接执行，无需确认。
- **写**（POST / PUT / DELETE 类）：`/api/services/<domain>/<service>`（开关灯、调温、调用自动化等）、`/api/lovelace/config/save`（推 dashboard）、任何 `set_state`、任何 `WS lovelace/config/save` 命令 — **必须**先在 daemon 日志里打印人类可读的"即将做什么"，再等用户在终端/前端确认。daemon 自身不要替用户拍板。

这一条同时约束 **agent 写代码时**和 **agent 调试 / 测试时**：

- 给 HA 适配器加新端点时，默认走"读"分支；要写就把分支标记为 `WRITE` 并接到确认流上。
- 跑 e2e / 集成测试时，禁止用真实 token 调写端点；用 HA 的 mock 服务器（`tests/fixtures/ha-mock/`）或者录制的 fixture 替代。
- Claude（无论在 IDE、CLI、还是对话里）**禁止**主动调用写端点，除非用户在同一会话内明确批准。

