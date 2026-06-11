# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目一句话

本地优先的 Home Assistant Lovelace 仪表板 AI 设计工具。**端到端已跑通**：brief → LLM（MiniMax m3）→ LovelaceConfig YAML → WebSocket 推到用户 HA → 自动备份 → 一键回滚。两条部署路径：本地 `pnpm tools-dev run web`、HA Add-on `addons/ha-ai-designer/`（已发布到 `ghcr.io/lxgxdx/ha-ai-designer`）。

设计思路参考 [nexu-io/open-design](https://github.com/nexu-io/open-design)：SKILL.md / DESIGN.md / 沙箱预览范式，**目标域是 HA 卡片 YAML 而非通用 HTML**。

## 仓库拓扑

```
ha-ai-designer/
├── apps/daemon/      Express + ws + pino 守护进程（5 子系统：REST/WS/LLM/orchestrator/preview-session）
├── apps/web/         Next.js 15.1.6 App Router（/, /chat 两页）
├── packages/contracts/ 共享 TypeScript DTO（纯 TS — 不许 import Node/Express/Next）
├── tools/dev/        pnpm tools-dev lifecycle CLI
├── skills/           HA 场景技能（SKILL.md + assets + references）
├── design-systems/   HA 主题（DESIGN.md，9-section schema）
├── craft/            通用 HA 美学工艺
├── addons/ha-ai-designer/  ★ HA Add-on 打包（config/build/Dockerfile/run/CHANGELOG/README/translations/repository.yaml）
├── repository.yaml   ★ HA 商店的根 manifest（缺它 HA 不识别仓库）
├── data/             运行时（gitignore）— config.json / backups/lovelace/ / logs/
└── .github/workflows/build-addon.yml  ★ CI：push master/tag → build multi-arch → push ghcr.io
```

## 进程分工

| 进程 | 端口 | 职责 |
|---|---|---|
| `daemon` | 7456 | HA REST + WS 客户端、LLM（OpenAI 兼容）、orchestrator、preview-session、**所有写操作护栏** |
| `web` | 3000 | Next.js；**只通过 server-side fetch 调 daemon**，不直接暴露 daemon 给浏览器 |

## Lifecycle（**唯一入口 `pnpm tools-dev`**，根 `package.json` 没注册 `pnpm dev` 等别名）

```bash
pnpm install                       # 装依赖
pnpm typecheck                     # 仓库级类型检查
pnpm build                         # 仓库级构建（daemon tsc + web next build）
pnpm tools-dev run web             # 前台起 daemon + web（开发推荐）
pnpm tools-dev start               # 后台起，写 data/.runtime.json
pnpm tools-dev stop / status / check
pnpm tools-dev logs --daemon|--web
```

生产跑（脱 tsx）：`cd apps/daemon && node dist/server.js`；web 走 `cd apps/web && node node_modules/.bin/next start -p 3000`（CI Dockerfile 不用 `output: 'standalone'`，因 Next.js 14/15 `/_error` prerender bug；改用 `pnpm deploy --prod --legacy` 拿生产 runtime + `next start`，详见下文"Docker build 关键教训"）。

## HA Add-on / Docker 部署（CI 自动化）

仓库根有 `repository.yaml` — **HA 商店靠这个文件识别仓库**，缺它 HA 报 "is not a valid app repository"。

**HA 商店"is not a valid app repository"的真实原因（**踩过的坑**）**：
1. 缺根 `repository.yaml`
2. `config.yaml` 的 `url` 字段值不是合法 URL（不能用 `http://[HOST]:[PORT:3000]` 模板）
3. 仓库里**任何子目录**下的 `config.json` / `config.yaml` 都被 HA 扫到当 add-on config；误读会拒绝整个仓库。**`data/config.example.json` 这种 template 文件**必须放仓库外（`docs/`）或者改名成非 `config.*` 模式。
4. `config.yaml` 的 `image` 字段**只支持 `{arch}` 占位符**（`str.format(arch=arch)`），不支持 `{slug}`。写死镜像名（如 `ghcr.io/<owner>/<image>`），不要模板化。
5. **GHCR 包默认私有**，HA 安装需要匿名 pull，**但 GitHub 不允许通过 API 改 package 可见性**。**维护者必须手动**：
   [https://github.com/users/<owner>/packages/container/<image>/settings](https://github.com/users/lxgxdx/packages/container/ha-ai-designer/settings)
   → Danger Zone → Change package visibility → Public

CI（`.github/workflows/build-addon.yml`）：
- push master → build **amd64 only**（matrix 多架构被临时砍，详见"Docker build 关键教训"）→ push `ghcr.io/lxgxdx/ha-ai-designer:{master,latest}`
- push tag `vX.Y.Z` → push `:{X.Y.Z}`（HA 商店用这个 tag 对应 `config.yaml: version`）

**架构只 build amd64**（你的 HA 是 x86 VM 暂够用）。`config.yaml` arch list 还列 aarch64 占位，但 CI matrix 只跑 amd64（多架构矩阵并行 push 会互相覆盖 manifest list）。未来加 aarch64 用 `docker buildx imagetools create` 合并。

## Docker build 关键教训（避免重蹈）

1. **`output: 'standalone'` 触发 Next.js `_error` prerender bug**（14.2.x 和 15.1.x/15.5.x 都有）。当前用 `pnpm deploy --prod --legacy` 拿生产 runtime + `next start` 启动。
2. **`pnpm install --frozen-lockfile || pnpm install`** — 锁文件不匹配时 fallback 自动重写。
3. **`NODE_ENV=production` 必须在 `next build` 之前重置**。Dockerfile 上一步 pnpm install 用了 `NODE_ENV=development`，不重置会走 development 路径触发 `<Html>` prerender 错。
4. **`pnpm deploy` 10.x 必须加 `--legacy`**（ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE）。
5. **CI 需要 `permissions: packages: write`** — 默认 GITHUB_TOKEN 没 packages 写权限。
6. **CI 的 `images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}` 解析后必须带 owner**，否则 push 到 `ghcr.io/<image>` 报 "Create organization package" denied。
7. **多架构 matrix 并行 push 互相覆盖 manifest list**（GHCR 不会自动合并）。当前只 build amd64；多架构要 `docker buildx imagetools create` 合并。
8. **s6-overlay 不把 run.sh stdout 转发到 HA supervisor log**。v0.1.4 起 run.sh 加 `exec > >(tee -a /data/logs/run.log) 2>&1`，从 host 上 `docker exec addon_* cat /data/logs/run.log` 才能看 root cause。

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

## 关键事实 / 不变量

- **HA 版本**：2026.6.0，REST 删了 dashboard 端点
- **HA 实例**：`http://192.168.88.183:8123`，1499 实体
- **HA token + LLM key** 都在 `data/config.json`（gitignore，mode 0600），端点响应**只 mask 不回显**
- **Add-on 模式下不配 HA token**：`addons/ha-ai-designer/config.yaml` 设 `homeassistant_api: true`，supervisor 注入 `SUPERVISOR_TOKEN` 给容器；`addons/ha-ai-designer/run.sh` 首次启动时把 SUPERVISOR_TOKEN 写到 `/data/config.json` 的 `ha.token`，daemon 走 `http://supervisor/core` 调 HA REST+WS。LLM 凭证则必须用户在 add-on Configuration 页填。
- **Add-on 调试入口**：当 HA supervisor log 卡在 banner 不动时，从 HA SSH 终端跑 `docker exec addon_<id> cat /data/logs/{run,daemon,web}.log` 拿真实日志。
- **Windows 坑**（AGENTS.md 也有，这里只列和 build 相关的）：
  - `pnpm scripts` 字段不展开 `${VAR:-default}` → `apps/web/scripts/{dev,start}.mjs` Node wrapper
  - `spawn('pnpm')` ENOENT → `tools/dev/src/ports.ts` 的 `spawnPnpm`（`shell: true` + 显式 PATH）
  - daemon cwd 是 `apps/daemon`，`./data` 错位 → tools-dev spawn 时设 `HA_DATA_DIR=仓库根/data`
  - Next.js standalone 在 Windows build 报 EPERM symlink → **必须 Linux 容器 build**（Dockerfile 多阶段）

## 仓库内规则文件

- `AGENTS.md` — 开发规约（命名、lifecycle、TypeScript 风格、security 模型）。**改包结构 / 加新命令 / 提 PR 之前必看**。
- `README.md` — 用户视角快速开始
- `addons/ha-ai-designer/README.md` — Add-on 安装 / 使用 / build / 排错
- `addons/ha-ai-designer/CHANGELOG.md` — 版本变更
- `E:\Claude\hha-knowledge\` — LLM 用的 HA 知识库（karpathy-llm-wiki 协议）

## 变更落点判断树

- 加 HA 端点 → `apps/daemon/src/routes/<feature>.ts`（`create<Feature>Router()` 风格）+ `packages/contracts/src/api/<feature>.ts`（DTO）
- 加 LLM 相关 → `apps/daemon/src/{llm-client,llm-orchestrator}.ts`
- 加 WebSocket 调用 → `apps/daemon/src/ha-ws-client.ts`（已有 `haWsRequest<T>` helper）
- 加前端页面 → `apps/web/src/app/<route>/page.tsx`
- 加新 SKILL/DESIGN/craft → 各自顶层目录的子文件夹
- 加 add-on → `addons/<slug>/` 复制 `ha-ai-designer/` 改 slug + 更新根 `repository.yaml` 描述
- 加 tools-dev 子命令 → `tools/dev/src/ports.ts` + `tools/dev/src/index.ts` 的 switch
- 更新 HA 知识库 → `E:\Claude\hha-knowledge\`（karpathy-llm-wiki 协议）
