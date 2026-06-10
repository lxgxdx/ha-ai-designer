# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目一句话

本地优先的 Home Assistant Lovelace 仪表板 AI 设计工具。设计思路参考 [nexu-io/open-design](https://github.com/nexu-io/open-design)（SKILL.md / DESIGN.md / 沙箱预览范式），目标域是 HA 卡片 YAML 而非通用 HTML。**当前已跑通端到端**：brief → MiniMax m3 → LovelaceConfig YAML → WebSocket 推到用户 HA → 自动备份 → 一键回滚。**两条部署路径**都已准备好：本地 `pnpm tools-dev run web`、HA Add-on `addons/ha-ai-designer/`。

## 常用命令

**唯一 lifecycle 入口是 `pnpm tools-dev`**（根 `package.json` 没注册 `pnpm dev` / `pnpm start` / `pnpm daemon` 这种别名）：

```bash
pnpm install                              # 装依赖
pnpm typecheck                            # 仓库级类型检查（遍历所有包）
pnpm build                                # 仓库级构建（daemon tsc + web next build）
pnpm tools-dev run web                    # 前台起 daemon + web（开发推荐，Ctrl-C 杀）
pnpm tools-dev start                      # 后台起，写 data/.runtime.json
pnpm tools-dev stop                       # 停后台
pnpm tools-dev status                     # 看状态 + 探 /api/health
pnpm tools-dev check                      # 探 /api/health，exit 0/1
pnpm tools-dev logs --daemon | --web      # 看日志
```

**单包命令**：

```bash
pnpm --filter @ha-designer/daemon typecheck
pnpm --filter @ha-designer/daemon build       # tsc → apps/daemon/dist/
pnpm --filter @ha-designer/web typecheck
pnpm --filter @ha-designer/web build          # next build → .next/standalone/
pnpm --filter @ha-designer/daemon dev        # 单跑 daemon
pnpm --filter @ha-designer/web dev           # 单跑 web
```

**生产跑（脱 tsx）**：

```bash
# daemon
cd apps/daemon && node dist/server.js

# web（standalone 产物）
cd apps/web && node .next/standalone/apps/web/server.js
```

**端口**：`daemon=7456` / `web=3000`（通过 `HA_DAEMON_PORT` / `HA_WEB_PORT` env 改）。

**没有 lint / format / test 工具链** — `tsc --noEmit` 是唯一静态检查。

## 高层架构

```
ha-ai-designer/
├── apps/
│   ├── daemon/         Express + ws + pino（5 个子系统：REST / WS / LLM / orchestrator / preview-session）
│   └── web/            Next.js 14 App Router（2 个页面：/, /chat）
├── packages/contracts/ 共享 TypeScript DTO（**纯 TS** — 不许 import Node/Express/Next）
├── tools/dev/         pnpm tools-dev lifecycle CLI
├── skills/             HA 场景技能（SKILL.md + assets + references）
├── design-systems/    HA 主题（DESIGN.md，9-section schema）
├── craft/              通用 HA 美学工艺
├── addons/ha-ai-designer/  ★ HA Add-on 打包（7 文件：config/build/Dockerfile/run/CHANGELOG/README/zh-Hans）
├── deploy/             早期 docker-compose（**已被 add-on 路线取代，可删**）
├── data/               运行时（gitignore）— config.json / backups/lovelace/ / logs/
└── hha-knowledge/      LLM 用的 HA 知识库（gitignore；karpathy-llm-wiki 协议）
```

### 进程分工

| 进程 | 端口 | 职责 |
|---|---|---|
| `daemon` | 7456 | HA REST + WebSocket 客户端、LLM（OpenAI 兼容）、orchestrator、preview-session（备份/推送/回滚）、所有写操作护栏 |
| `web` | 3000 | Next.js 14 静态 + SSR；**只通过 server-side fetch** 调 daemon，不直接暴露 daemon 给浏览器 |

### daemon 内部子系统（**新 agent 必看**）

| 子系统 | 文件 | 关键点 |
|---|---|---|
| **REST 客户端** | `src/ha-client.ts` | `loadHaConfig()` 读 `data/config.json` 的 `ha` 段；写操作必须 `{confirm: true}` |
| **WebSocket 客户端** | `src/ha-ws-client.ts` | 单例 + 自动重连 + 命令排队；**HA 2026.6.0 已删除 `/api/lovelace/*` REST，所有 dashboard 操作走这里** |
| **LLM 客户端** | `src/llm-client.ts` | OpenAI 兼容（`/chat/completions` + tool calling + streaming）；**MiniMax m3 = `MiniMax-Text-01` model id**；apiKey 永不进日志 |
| **LLM 编排器** | `src/llm-orchestrator.ts` | 拼 system prompt（SKILL + DESIGN + 1499 实体摘要）+ 调 LLM + js-yaml 解析 + 校验；**用 YAML content 输出（不用 tool_call，绕开 MiniMax 端点 940 token cap）** |
| **preview-session** | `src/preview-session.ts` | 推前自动 `lovelace/config` → `data/backups/lovelace/<ts>.json`；`restoreBackup` 自动 unwrap 旧包装格式（兼容 v0.5e 之前存的） |

### 路由表（`apps/daemon/src/server.ts` 注册顺序敏感）

```
health       /api/health
preview      /api/ha/dashboards/preview/{url,...}    ← 必须在 ha 之前注册
ha           /api/ha/{ping,entities,dashboards,config}
llm         /api/llm/{config,providers,test}
chat        /api/chat
```

**顺序原因**：`POST /api/ha/dashboards/preview` 路径匹配 `ha.ts` 的 `/api/ha/dashboards/:urlPath` 通配（"preview" 被当 urlPath），所以 preview 路由必须先注册。

### HA 端点行为（实测 HA 2026.6.0）

| 操作 | 走 REST | 走 WS |
|---|---|---|
| `/api/states` `/api/services` `/api/config` `/api/calendars` `/api/history` | ✅ | — |
| Dashboard config 读 / 推 / 列 | ❌（已删） | ✅（`lovelace/config`、`lovelace/dashboards/list`、`lovelace/config/save`） |
| 调 service 改实体 | ✅ | ✅ |

### 写操作护栏（**硬性**）

任何 push / service 调用必须**同时**满足：
1. `__confirmed_by_user: true` 在 body 里
2. `intent` 字段必填
3. daemon 日志打印即将做什么（pino INFO 级）
4. preview push **自动**先 `lovelace/config` 抓快照到 `data/backups/lovelace/<ts>.json`

### LLM 输出流程

1. system prompt: SKILL.md body + (DESIGN.md if any) + 1499 实体摘要（**过滤**了 sensor 之外的冗余）
2. user: brief
3. LLM 输出 ```yaml ... ``` 块
4. extractYamlBlock 正则 → js-yaml 解析 → 校验 entity_id 存在
5. 校验器返回 `warnings: string[]`（找不到的 entity / 编造的 entity）

### 前端 `/chat` 页面（`apps/web/src/app/chat/ChatPane.tsx`）

- brief textarea → /api/chat → 显示 yaml + warnings
- ⚠ 推按钮 → /api/ha/dashboards/preview（自动备份 + push）
- 推送成功后：探测 `/api/ha/dashboards/preview/iframe-policy`（X-Frame-Options）
  - 允许 → 显示 iframe 嵌入
  - 拒绝 → 显示"在新窗口打开 HA 预览"大按钮 + 反向嵌入 HA 教程
- 历史备份列表 + intent 输入 + ↶ 恢复按钮

## HA Add-on 打包（`addons/ha-ai-designer/`）

**完整 HA Add-on**：
- `config.yaml` — slug `ha_ai_designer`，ingress、homeassistant_api、5 架构（amd64/aarch64/armv7/armhf/i386）
- `build.yaml` — 用 `ghcr.io/hassio-addons/base:16.3.2` 基础镜像
- `Dockerfile` — **多阶段**：node:24-alpine 编译（`pnpm install` + `daemon tsc` + `web next build standalone`）→ hassio base 复制
- `run.sh` — bashio 入口；`homeassistant_api: true` 让 supervisor 注入 `SUPERVISOR_TOKEN`，**用户不用配 long-lived token**
- `translations/zh-Hans.json` — 6 个选项的中文翻译
- `README.md` — 安装 + 使用 + build（Docker 本机 + GitHub Actions 模板）+ 排错

**装到 HA 后解决 3 个老问题**：
- 跨域：supervisor 反代（同源）
- X-Frame-Options：工具在 HA 内部，iframe 不再需要
- Token：supervisor 自动注入 `SUPERVISOR_TOKEN`

## 关键事实 / 不变量

- **HA 版本**：2026.6.0（"2026 年 6 月"版），REST 删了 dashboard 端点
- **HA 实例**：`http://192.168.88.183:8123`，1499 实体，重度玩家型（682 sensor + 183 switch + 48 light + 4 个 dashboard）
- **HA token + LLM key** 都在 `data/config.json`（gitignore，mode 0600），端点响应里**只 mask 不回显**
- **MiniMax m3** = `MiniMax-Text-01` model id，baseUrl `https://api.minimaxi.com/v1`
- **Windows 坑**（已踩过）：
  - pnpm scripts 字段不展开 `${VAR:-default}` → 用 `apps/web/scripts/{dev,start}.mjs` Node wrapper
  - `spawn('pnpm')` ENOENT → 用 `tools/dev/src/ports.ts` 的 `spawnPnpm`（`shell: true` + 显式 PATH）
  - daemon cwd 是 `apps/daemon`，`./data` 错位 → tools-dev spawn 时设 `HA_DATA_DIR=仓库根/data`
  - Next.js standalone 在 Windows build 报 EPERM symlink → **必须在 Linux 容器里 build**（Dockerfile 多阶段处理）
- **daemon 没装**（用户机器）— Docker Desktop 推荐 + GitHub Actions 兜底

## 仓库内现有规则文件

- `AGENTS.md` — 仓库开发规约（命名、lifecycle、TypeScript 风格、security 模型）。**改包结构 / 加新命令 / 提 PR 之前必看**。
- `README.md` — 用户视角的快速开始。
- `addons/ha-ai-designer/README.md` — Add-on 安装 / 使用 / build / 排错完整文档。
- `addons/ha-ai-designer/CHANGELOG.md` — Add-on 版本变更。
- `E:\Claude\hha-knowledge\`（在 `MEMORY.md` 旁）— LLM 用的 HA 知识库（karpathy-llm-wiki 协议，6 篇 raw + 5 篇 wiki）。
- `memory/MEMORY.md` — 跨会话 memory（用户语言偏好、Windows pnpm 坑、HA 连接凭证、MiniMax 凭证）。

## 注意事项

- **没有 git 仓库**（`.git` 不存在）。如要 commit / push 触发 GitHub Actions build，自己 `git init`。
- **没有 `.github/`、`.cursorrules`、`.cursor/`** — 团队 / Cursor / Copilot 规约暂未引入。
- **中文文档 + 英文代码** — README/AGENTS/注释用简体中文；变量名、命令、YAML key 一律英文。
- **HA 凭证安全** — token + LLM key 都在 `data/config.json`（gitignore，0o600）。**禁止** echo 到日志、commit、截图、对话。
- **写操作必须确认** — daemon 调 HA 任何写端点（`/api/services/*`、`lovelace/config/save` 等）必须 `__confirmed_by_user: true` + `intent` + 日志留痕。Agent 调试也禁用真 token 写。
- **变更要落哪一层的判断树**：
  - 加 HA 端点 → `apps/daemon/src/routes/<feature>.ts`（`create<Feature>Router()` 风格）+ `packages/contracts/src/api/<feature>.ts`（DTO）
  - 加 LLM 相关 → `apps/daemon/src/{llm-client,llm-orchestrator}.ts` 或新文件
  - 加 WebSocket 调用 → `apps/daemon/src/ha-ws-client.ts`（已经有 `haWsRequest<T>` helper）
  - 加前端页面 → `apps/web/src/app/<route>/page.tsx`
  - 加新 SKILL/DESIGN/craft → 各自顶层目录的子文件夹
  - 加 add-on → `addons/<slug>/` 复制 `ha-ai-designer/` 改 slug
  - 加新 tools-dev 子命令 → `tools/dev/src/ports.ts` + `tools/dev/src/index.ts` 的 switch
  - 更新 HA 知识库 → `E:\Claude\hha-knowledge\`（用 karpathy-llm-wiki 协议）
