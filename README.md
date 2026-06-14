# HA AI Designer

> 本地优先的 **Home Assistant Lovelace 仪表板 AI 设计工具**。用自然语言 / 手绘草图描述需求，工具读你本地 HA 的实体、生成卡片 YAML、实时预览、一键推回 HA。

设计思路参考 [nexu-io/open-design](https://github.com/nexu-io/open-design)（SKILL.md / DESIGN.md / 沙箱预览 / 流式生成），目标域换成 **HA 卡片 YAML**。

---

## 当前状态：v0.2.0 端到端可用

**v0.2.0 已完成**：brief → LLM（MiniMax m3，OpenAI 兼容）→ LovelaceConfig YAML → SSE 流式输出 → WebSocket 推 HA → 自动备份 → 一键回滚。add-on 模式 `ghcr.io/lxgxdx/ha-ai-designer:0.2.0` 在 HA 侧栏已可见并能跑通。

**add-on 端到端** 包含：v0.1.22 修的 SSRF + web↔daemon 内部 auth，v0.2.0 修的 SSE streaming + setup wizard + same-origin proxy + 6 个 v0.2.0 安全 review 修法（IPv4-mapped IPv6 / setup CSRF / query allowlist / abort heartbeat / proxy POST export / non-null assertions）。

**next**：v0.3 RAG 接 hha-knowledge 51 张 HA 卡片；v0.4 实时预览 iframe + Tweaks 滑块。详见 `docs/ops/A-task-runbook.md`（end-to-end 验收步骤） + `AGENTS.md` + `CLAUDE.md` 14 lessons。

---

## 快速开始

### 1. 准备环境

- Node `>=20`（推荐 `24`）
- pnpm `10.33.2`

```bash
npm install -g pnpm@10.33.2
```

> Windows 上 `corepack enable` 会 EPERM，请用 `npm install -g pnpm@10.33.2`。

### 2. 装依赖

```bash
cd ha-ai-designer
pnpm install
```

### 3. 跑骨架

```bash
pnpm tools-dev run web
```

然后浏览器打开 <http://localhost:3000>，daemon 健康检查在 <http://localhost:7456/api/health>。

### 4. 用 Docker 跑（计划中）

```bash
cd deploy
cp .env.example .env
docker compose up -d
```

> Docker 镜像与 `docker-compose.yml` 在 v0.1.0 阶段会先出可跑版本，再做 HA Add-on。

---

## 目录结构

```
ha-ai-designer/
├── apps/
│   ├── web/        # Next.js 14 前端
│   └── daemon/     # Express 本地守护进程
├── packages/
│   └── contracts/  # 共享 TypeScript 类型
├── tools/
│   └── dev/        # pnpm tools-dev lifecycle 控制平面
├── skills/         # HA 场景技能（SKILL.md）— 占位
├── design-systems/ # HA 主题（DESIGN.md）— 占位
├── craft/          # 通用 HA 美学工艺 — 占位
├── data/           # 运行时数据（gitignore）
├── deploy/         # Docker / Add-on 配置
└── docs/           # 架构、协议、schema 文档
```

---

## 路线图

- [x] v0.1 骨架：workspace + lifecycle + 空 web/daemon
- [x] v0.2 HA 接入 + LLM 接入 + push dashboard + 自动备份 + 回滚（v0.2.0 端到端可用）
- [ ] v0.3 RAG：把 `E:\Claude\hha-knowledge\` 51 张 HA 卡片 + HACS 卡片接进 orchestrator prompt
- [ ] v0.4 实时预览 iframe + Tweaks 滑块
- [ ] v0.5 多 dashboard 覆盖（非 default storage / YAML 模式）
- [ ] v0.6 错误恢复 + 离线容忍 + entity 缓存
- [ ] v0.7 HACS / HA 商店上架 + i18n
- [ ] v1.0 GA
