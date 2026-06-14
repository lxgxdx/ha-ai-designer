# HA AI Designer

> 本地优先的 **Home Assistant Lovelace 仪表板 AI 设计工具**。用自然语言 / 手绘草图描述需求，工具读你本地 HA 的实体、生成卡片 YAML、实时预览、一键推回 HA。

设计思路参考 [nexu-io/open-design](https://github.com/nexu-io/open-design)（SKILL.md / DESIGN.md / 沙箱预览 / 流式生成），目标域换成 **HA 卡片 YAML**。open-design 的桌面打包（Electron）也是 v0.5.0 起我们主推的部署方式。

---

## 当前状态：v0.4.0 端到端可用，v0.5.0 桌面 .exe 收口

**v0.4.0 已完成（HA add-on 路径）**：
- brief → LLM（MiniMax m3 / OpenAI / Anthropic / Ollama 等 8 家 provider）→ LovelaceConfig YAML → SSE 流式 → WebSocket 推 HA → 自动备份 → 一键回滚
- RAG：hha-knowledge 51+ HA 卡片 + HACS 卡片进 orchestrator prompt
- `/setup` 4 步 wizard：HA → LLM → Embedding（4 选项）→ Done
- feedback loop：👍/👎 → JSONL → `learn.ts` 改 wiki
- 9→2 schema 精简 + 401 / CSRF / nohup env `#` 注释 bug 修复

**v0.5.0（当前开发中）**：桌面 `.exe` 主推。HA add-on 代码保留，进入 maintenance mode。详见 `addons/ha-ai-designer/DEPRECATED.md`。

---

## 快速开始

### 用户（桌面 .exe，推荐）

> v0.5.0-alpha 发布后可用

1. 打开 [Releases](https://github.com/lxgxdx/ha-ai-designer/releases) 下载 `ha-ai-designer-Setup-x.y.z.exe`
2. 双击安装 → 双击桌面图标启动
3. 浏览器自动打开 <http://localhost:3000>（或 Electron 内嵌窗口）
4. /setup 走 4 步：填 HA URL + 长期令牌 → 选 LLM provider → 选 Embedding → Done
5. 开始用 chat 生成 dashboard

### 开发者（本地 dev 服务）

#### 1. 准备环境

- Node `>=20`（推荐 `24`）
- pnpm `10.33.2`

```bash
npm install -g pnpm@10.33.2
```

> Windows 上 `corepack enable` 会 EPERM，请用 `npm install -g pnpm@10.33.2`。

#### 2. 装依赖 + 跑

```bash
cd ha-ai-designer
pnpm install
pnpm tools-dev run web
```

然后浏览器打开 <http://localhost:3000>，daemon 健康检查在 <http://localhost:7456/api/health>。

#### 3. 开发 Electron 桌面壳

```bash
# 终端 1：起 daemon + web
pnpm tools-dev run web

# 终端 2：起 Electron 包装
pnpm desktop:dev
```

#### 4. 打 Windows .exe

```bash
pnpm desktop:build
# 产物在 apps/desktop/dist/
```

---

## 目录结构

```
ha-ai-designer/
├── apps/
│   ├── daemon/     # Express 本地守护进程（5 子系统：REST/WS/LLM/orchestrator/preview-session）
│   ├── web/        # Next.js 15 前端
│   └── desktop/    # ★ v0.5.0: Electron 壳（spawn daemon + web，open BrowserWindow）
├── packages/
│   └── contracts/  # 共享 TypeScript 类型
├── tools/
│   └── dev/        # pnpm tools-dev lifecycle 控制平面
├── skills/         # HA 场景技能（SKILL.md）
├── design-systems/ # HA 主题（DESIGN.md）
├── craft/          # 通用 HA 美学工艺
├── addons/         # ⚠️ Maintenance mode: HA add-on 代码（v0.4.0 最后一版）
├── data/           # 运行时数据（gitignore）
└── docs/           # 架构、协议、schema 文档
```

---

## 路线图

- [x] v0.1 骨架：workspace + lifecycle + 空 web/daemon
- [x] v0.2 HA 接入 + LLM 接入 + push dashboard + 自动备份 + 回滚
- [x] v0.3 RAG：hha-knowledge 51+ HA 卡片 + HACS 卡片入 orchestrator
- [x] v0.4 4 步 wizard + feedback loop + 9→2 schema + bug 修链
- [ ] **v0.5 Electron 桌面 .exe**（当前）
- [ ] v0.6 macOS .app / Linux .AppImage + 代码签名 + 自动更新
- [ ] v0.7 i18n + HACS 商店上架（可选）
- [ ] v1.0 GA
