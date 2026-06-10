# HA AI Designer

> 本地优先的 **Home Assistant Lovelace 仪表板 AI 设计工具**。用自然语言 / 手绘草图描述需求，工具读你本地 HA 的实体、生成卡片 YAML、实时预览、一键推回 HA。

设计思路参考 [nexu-io/open-design](https://github.com/nexu-io/open-design)（SKILL.md / DESIGN.md / 沙箱预览 / 流式生成），目标域换成 **HA 卡片 YAML**。

---

## 当前状态：骨架阶段（v0.1.0）

只有**空壳**：daemon 跑通 `/api/health`、web 起一个欢迎页、`pnpm tools-dev` 能起停。下一步是接 HA（读实体 / 推 dashboard）。

详细路线 → `AGENTS.md` 与 `docs/`。

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
- [ ] v0.2 HA 接入：list entities / get dashboard / push dashboard
- [ ] v0.3 RAG：抓 HA 内置 + HACS 主流卡片文档
- [ ] v0.4 LLM 接入：BYOK（OpenAI 兼容 / Ollama）+ 结构化输出
- [ ] v0.5 预览：iframe + 真实 HA 卡片渲染
- [ ] v0.6 Tweaks 面板：grid span / 主题色 / 字号 滑块
- [ ] v0.7 一键 push + 自动备份 + 回滚
- [ ] v1.0 HA Add-on 打包
