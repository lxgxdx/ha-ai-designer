# HA Add-on 状态：⚠️ Maintenance Mode（v0.5.0 起）

**v0.4.0 是最后一个积极迭代的 add-on 版本**。v0.5.0 起主推路径是桌面 `.exe`（`apps/desktop/`），HA Add-on 代码保留但**不再主动开发**。

## 为什么切到 .exe

过去 6 个迭代（v0.2.0 → v0.4.0）有 **3 个完整版本**（v0.3.0 / v0.3.5 / v0.4.0）专门用来修**部署栈** bug——s6-overlay env 注释、CSRF origin、bashio "null" 字面量、HA core panel 缓存、ingress assetPrefix。这些 bug 跟我们的核心价值（LLM → YAML → 推 HA）**完全无关**，是 Docker + supervisor + HA core 三层之间反复拉扯。

最具体的痛点：**v0.4.0 修完 assetPrefix 后，HA 内部 ingress 仍然 404**——根因是 HA core 自己的 panel session 缓存不刷新，我们改不了 supervisor、改不了 HA core，只能让用户"重装 add-on"这种脏招。详见 v0.4.0 CHANGELOG 的"未解决问题"段。

## 桌面 .exe 路径的优势

| | Add-on | Desktop .exe |
|---|---|---|
| 部署栈 | Docker + s6 + supervisor + HA core | 单个 .exe |
| HA 接入 | supervisor token 注入 + 反代 | 用户填 HA URL + 长期令牌 |
| 配置 schema | 2 字段（`log_level`, `allowed_origins_extra`） | 0 字段（全部在 /setup wizard） |
| 网络问题 | ingress / 端口映射 / 容器内 loopback | `127.0.0.1:3000` |
| 多台 HA 管理 | 每台装一份 add-on | 一台 Windows PC 连多台 |
| 迭代速度 | push → CI 5 分钟 → 拉镜像 | `pnpm desktop:dev` |

## 已知 add-on 未解决（v0.4.0 时状态）

如果以后要复兴 add-on 路径，需要先解决这些：

1. **HA core panel session 缓存不刷新**——用户从 sidebar 打开 add-on 时偶发 404，只能"重装 add-on"或"清 HA 前端缓存"
2. **HA ingress 静态资源**——`assetPrefix` 已 bake，理论应 work，但 HA core 反代可能 strip 行为有变
3. **Bashio env 注入** — 某些 add-on 选项（`allowed_origins_extra`）在 hassio base 16.3.2 上 `bashio::config` 返回字面 `"null"` 字符串，需手动 grep guard
4. **s6-overlay 不传 stdout** — `run.sh` stdout 不进 supervisor log，需 `tee -a /data/logs/run.log`
5. **多架构 manifest 冲突** — GHCR 不自动合并并行 push 的 manifest list，当前只 build amd64
6. **GHCR 私有 → 公开** — GitHub API 不允许改 package visibility，需维护者手动点 UI

## 复兴计划

如果 HA 用户对 add-on 路径有强需求（例如"我就是要在 HA 上跑"），复兴步骤：

1. 修 #1（HA core panel 缓存）—— 可能需要 HA core 社区报 issue，或换 add-on 启动方式
2. 升级 hassio base 16 → 17+（fix #3 bashio "null" 问题）
3. 多架构 build（#5）用 buildx imagetools 合并
4. 加 ARM64 build matrix
5. 端到端跑通：HA install → sidebar 链接 → /chat → 推 HA dashboard → 自动备份
6. 发 v0.5.x-addon.0 tag

预计工作量：1-2 周（核心是 #1 和 #2）。

## 维护期责任

维护期内只修 **blocker 级 bug**：
- Add-on 起不来 / daemon 崩 / 数据丢失
- 安全漏洞

**不修**：
- 已知 ingress 404 缓存问题（已记录，等 HA 社区修）
- 新功能（要新功能走 .exe 路径）

## 怎么回到 add-on 路径发版

```bash
# 1. 改 add-on 代码
vim addons/ha-ai-designer/config.yaml
vim addons/ha-ai-designer/run.sh

# 2. bump add-on 版本
# config.yaml: version: "0.4.0" -> version: "0.5.0-addon.0"

# 3. tag（专用 prefix 避免和 desktop tag 冲突）
git tag addon-v0.5.0-addon.0
git push origin addon-v0.5.0-addon.0
# → CI 跑 build-addon.yml → push :addon-v0.5.0-addon.0 到 GHCR
```

## 引用

- v0.4.0 完整修复链：`addons/ha-ai-designer/CHANGELOG.md`
- 桌面 .exe 文档（v0.5.0 发布后）：`apps/desktop/README.md`（待写）
- 主项目 CLAUDE.md 架构声明：`CLAUDE.md` § 仓库拓扑 / § 部署模式
