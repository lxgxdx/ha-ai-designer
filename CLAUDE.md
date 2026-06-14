# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目一句话

本地优先的 Home Assistant Lovelace 仪表板 AI 设计工具。**v0.5.0 桌面 .exe 主推**：brief → LLM → LovelaceConfig YAML → 推 HA → 自动备份 → 一键回滚，端到端已跑通。RAG 知识库（hha-knowledge）已 bake 进桌面安装包。

**v0.5.0 起仅维护桌面 .exe 路径**（`apps/desktop/`，Electron 包装 daemon + web，跟 open-design 同路线）。不再维护 HA add-on / Docker 路径。

设计思路参考 [nexu-io/open-design](https://github.com/nexu-io/open-design)：SKILL.md / DESIGN.md / 沙箱预览范式，**目标域是 HA 卡片 YAML 而非通用 HTML**。open-design 的桌面打包（Electron）也是我们 v0.5.0 的参考实现。

**agent 阅读顺序**：本文件 → `AGENTS.md`（开发规约、命名、security 模型、TypeScript 风格）。`README.md` 是用户视角快速开始。

## 仓库拓扑

```
ha-ai-designer/
├── apps/daemon/      Express + ws + pino 守护进程（5 子系统：REST/WS/LLM/orchestrator/preview-session）
├── apps/web/         Next.js 15 App Router（/, /chat, /setup 三页）
├── apps/desktop/     ★ v0.5.0: Electron 壳（spawn daemon + web，open BrowserWindow）
├── packages/contracts/ 共享 TypeScript DTO（纯 TS — 不许 import Node/Express/Next）
├── tools/dev/        pnpm tools-dev lifecycle CLI
├── skills/           HA 场景技能（SKILL.md + assets + references）
├── design-systems/   HA 主题（DESIGN.md，9-section schema）
├── craft/            通用 HA 美学工艺
├── data/             运行时（gitignore）— config.json / backups/lovelace/ / logs/
└── .github/workflows/
    └── build-desktop.yml ★ v0.5.0: tag → build Windows .exe + macOS .app
```

## 进程分工

| 进程 | 端口 | 职责 |
|---|---|---|
| `daemon` | 7456 | HA REST + WS 客户端、LLM（OpenAI 兼容）、orchestrator、preview-session、**所有写操作护栏** |
| `web` | 3000 | Next.js；**只通过 server-side fetch 调 daemon**，不直接暴露 daemon 给浏览器 |
| `desktop` (Electron) | — | v0.5.0: spawn daemon + web 子进程，开 BrowserWindow 加载 http://127.0.0.1:3000 |

## Lifecycle（**唯一入口 `pnpm tools-dev`**，根 `package.json` 没注册 `pnpm dev` 等别名）

```bash
pnpm install                       # 装依赖
pnpm typecheck                     # 仓库级类型检查
pnpm build                         # 仓库级构建（daemon tsc + web next build）
pnpm tools-dev run web             # 前台起 daemon + web（开发推荐，可单独配 Electron desktop:dev）
pnpm tools-dev start               # 后台起，写 data/.runtime.json
pnpm tools-dev stop / status / check
pnpm tools-dev logs --daemon|--web
# v0.5.0: 桌面 .exe
pnpm desktop:dev                   # 起 Electron 加载 http://127.0.0.1:3000（需先 tools-dev run web）
pnpm desktop:build                 # 出 Windows .exe (NSIS installer)
pnpm desktop:package               # 出 macOS .app + .dmg
```

生产跑（脱 tsx）：`cd apps/daemon && node dist/server.js`；web 走 `cd apps/web && node node_modules/.bin/next start -p 3000`。v0.5.0 起用户**不应**直接跑这两个——用 `pnpm desktop:dev` 或 `.exe`。

## 部署模式

v0.5.0 起**只有一条主推路径**：

| 路径 | 状态 | 命令 | 适用场景 |
|---|---|---|---|
| **桌面 .exe** | ✅ v0.5.0 唯一 | `pnpm desktop:build` → `apps/desktop/dist/HA AI Designer-Setup-x.y.z.exe` | Windows / macOS / Linux 桌面用户（HA 运维在工位 PC） |
| 本地 dev 服务 | ✅ dev 入口 | `pnpm tools-dev run web` | 开发者本地调试（不打包） |

## 关键事实 / 不变量

- **HA 版本**：2026.6.0，REST 删了 dashboard 端点
- **HA 实例**：`http://192.168.88.183:8123`，1499 实体
- **HA token + LLM key** 都在桌面 userData 下的 `config.json`（gitignore，mode 0600），端点响应**只 mask 不回显**
- **桌面 .exe 调试入口**：`%APPDATA%\ha-ai-designer\logs\`（Windows）/ `~/Library/Logs/ha-ai-designer/`（macOS）下的 `daemon.log` + `web.log`；或在开发模式 `pnpm desktop:dev` 直接看终端输出
- **Windows 坑**（AGENTS.md 也有，这里只列和 build 相关的）：
  - `pnpm scripts` 字段不展开 `${VAR:-default}` → `apps/web/scripts/{dev,start}.mjs` Node wrapper
  - `spawn('pnpm')` ENOENT → `tools/dev/src/ports.ts` 的 `spawnPnpm`（`shell: true` + 显式 PATH）
  - daemon cwd 是 `apps/daemon`，`./data` 错位 → tools-dev spawn 时设 `HA_DATA_DIR=仓库根/data`
  - Next.js standalone 在 Windows build 报 EPERM symlink → **必须 Linux 容器 build**（GitHub Actions windows-latest runner 上跑产线也行，但本地开发 macOS / Linux runner 更快）

## 仓库内规则文件

- `AGENTS.md` — 开发规约（命名、lifecycle、TypeScript 风格、security 模型）。**改包结构 / 加新命令 / 提 PR 之前必看**。
- `README.md` — 用户视角快速开始
- `apps/desktop/README.md` — 桌面 .exe 安装 / 使用 / build / 排错
- `E:\Claude\hha-knowledge\` — LLM 用的 HA 知识库（karpathy-llm-wiki 协议）

## HA 端点行为（实测 HA 2026.6.0）

| 操作 | 走 REST | 走 WS |
|---|---|---|
| `/api/states` `/api/services` `/api/config` `/api/calendars` `/api/history` | ✅ | — |
| Dashboard config 读 / 推 / 列 | ❌（已删） | ✅（`lovelace/config`、`lovelace/dashboards/list`、`lovelace/config/save`） |
| 调 service 改实体 | ✅ | ✅ |

## 写操作护栏（**硬性**，AGENTS.md 也有但这条最常踩）

任何 push / service 调用**同时**满足：
1. `__confirmed_by_user: true` 在 body 里
2. `intent` 字段必填
3. daemon 日志打印即将做什么（pino INFO 级）
4. preview push **自动**先 `lovelace/config` 抓快照到 `data/backups/lovelace/<ts>.json`

## daemon 路由表（`apps/daemon/src/server.ts` 注册顺序敏感）

```
health       /api/health
preview      /api/ha/dashboards/preview/{url,...}    ← 必须在 ha 之前注册
ha           /api/ha/{ping,entities,dashboards,config}
llm         /api/llm/{config,providers,test}
chat        /api/chat
```

`POST /api/ha/dashboards/preview` 路径匹配 `ha.ts` 的 `/api/ha/dashboards/:urlPath` 通配（"preview" 被当 urlPath），所以 preview 必须先注册。

## LLM 流程（`apps/daemon/src/llm-orchestrator.ts`）

1. system prompt: SKILL.md body + (DESIGN.md if any) + 实体摘要（**过滤 sensor 之外的冗余**）
2. user: brief
3. LLM 输出 ```yaml ... ``` 块
4. extractYamlBlock → js-yaml 解析 → 校验 entity_id 存在
5. 返回 `warnings: string[]`（找不到的 entity / 编造的 entity）

**用 YAML content 输出，不用 tool_call** — 绕开 MiniMax 端点 940 token cap。`MiniMax m3` = `MiniMax-Text-01` model id，baseUrl `https://api.minimaxi.com/v1`。

## 变更落点判断树

- 加 HA 端点 → `apps/daemon/src/routes/<feature>.ts`（`create<Feature>Router()` 风格）+ `packages/contracts/src/api/<feature>.ts`（DTO）
- 加 LLM 相关 → `apps/daemon/src/{llm-client,llm-orchestrator}.ts`
- 加 WebSocket 调用 → `apps/daemon/src/ha-ws-client.ts`（已有 `haWsRequest<T>` helper）
- 加前端页面 → `apps/web/src/app/<route>/page.tsx`
- 加新 SKILL/DESIGN/craft → 各自顶层目录的子文件夹
- 加桌面 .exe 行为 → `apps/desktop/src/main/main.ts`（spawn lifecycle + BrowserWindow config）
- 加新 desktop 子命令 → `tools/dev/src/ports.ts` + `tools/dev/src/index.ts` 的 switch
- 更新 HA 知识库 → `E:\Claude\hha-knowledge\`（karpathy-llm-wiki 协议）
