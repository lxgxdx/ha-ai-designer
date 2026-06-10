# 部署

## Docker Compose（v0.1 路线）

最简的一键起两个服务。

```bash
cd deploy
cp .env.example .env
docker compose up -d
# web:    http://localhost:3000
# daemon: http://localhost:7456/api/health
```

数据持久化在 `./data`（gitignore）。

### 单服务 vs 拆服务

`docker-compose.yml` 把 web 和 daemon 拆成两个容器：
- **daemon** 单跑 7456 端口，负责所有 `/api/*`、HA 适配、LLM 调用
- **web** 单跑 3000 端口，是 Next.js 14 前端，通过容器内 `http://daemon:7456` 调 daemon

**为什么拆开**：开发时改前端可以 hot-reload，不影响 daemon 状态。生产时也方便把 daemon 部署到能访问 HA 的机器上，web 部署到对外的 Vercel/Cloudflare（与 open-design 的 Topology B 一致）。

### 加 Add-on 路线（计划 v1.0）

HA Add-on 是基于 supervisor 的特殊 Docker 容器：
- 必须跑在 HAOS / Supervised 上
- 用 `hassio-addon` base image（不是普通 node:24）
- 通过 `config.yaml` 声明 schema、端口、schema
- 跑在 `host_network: true` 模式下能直接访问宿主机的 HA Core

到 v1.0 之前，先把 Docker 路线做扎实，Add-on 路线作为最后一步。
