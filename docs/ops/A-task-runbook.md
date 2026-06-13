# A 任务 — 用户执行清单

> 目标: 验证 v0.1.20 在 add-on 模式下,主流程(brief → LLM → LovelaceConfig → WebSocket push → 自动备份)**真能跑通**,不只是 UI 起来。
>
> 跑之前确认: **v0.1.20 镜像已安装,HA 侧栏能打开 AI Designer 页面**。

---

## Step 1 — 填 LLM 凭证(add-on Configuration tab)

1. HA 侧栏 → **Settings → Add-ons → HA AI Designer → Configuration**
2. 填:
   - `llm_provider`: `minimax`(全小写,这是 provider id,不是公司名)
   - `llm_base_url`: `https://api.minimaxi.com/v1`(末尾 `/v1` 必带,这是 OpenAI 兼容路径)
   - `llm_model`: `MiniMax-Text-01`(MiniMax m3 系列的 model id)
   - `llm_api_key`: 你的 MiniMax API key
3. 其他字段先保持默认,保存
4. **重启 add-on**(Configuration tab 没有 restart 按钮,去 Info tab → Restart)

> **为什么重启**? 容器启动时 `run.sh` 会把 add-on options 写到 `/data/config.json`。改完不重启,daemon 读不到新凭证。

---

## Step 2 — 把 smoke 脚本复制到容器内

在 HA host 上开一个 SSH 会话(或者从 HA 终端走):

```bash
# 找到 add-on 容器 id
docker ps | grep ha_ai_designer
# 输出长这样:  abc123...  ghcr.io/lxgxdx/ha-ai-designer:0.1.20  ...
# 提取容器名 (一般是 addon_<slug>_<id> 模式)
CONTAINER=$(docker ps --format '{{.Names}}' | grep ha_ai_designer)
echo "container = $CONTAINER"

# 复制脚本
docker cp E:/Claude/ha-ai-designer/docs/ops/addon-smoke.sh "${CONTAINER}:/tmp/smoke.sh"
# Windows 路径转换: 如果上面不行,改成:
#   docker cp 'E:\Claude\ha-ai-designer\docs\ops\addon-smoke.sh' "${CONTAINER}:/tmp/smoke.sh"
```

> **为什么要 docker cp 不用 `bash <(curl ...)`**? 容器内 curl 出不去(没镜像源)也未必有网络。直接 cp 最稳。

---

## Step 3 — 跑 smoke 诊断(7 项,1–2 分钟)

```bash
CONTAINER=$(docker ps --format '{{.Names}}' | grep ha_ai_designer)
docker exec "${CONTAINER}" bash /tmp/smoke.sh
```

**预期输出**(7 项全过):

```
━━━ 1/7  daemon /api/health ━━━
  raw: {"ok":true,"uptime":...}
  ✓ daemon.up  (true)

━━━ 2/7  /api/llm/config (凭证是否就位,apiKey 已 mask) ━━━
  raw: {"configured":true,"llm":{"provider":"minimax","baseUrl":"https://api.minimaxi.com/v1","model":"MiniMax-Text-01","apiKeyMasked":"sk-c…0iFW","apiKeySet":true}}
  ✓ llm.configured  (true)
  provider=minimax  baseUrl=https://api.minimaxi.com/v1  model=MiniMax-Text-01  apiKeySet=true

━━━ 3/7  /api/llm/test (真打一次 LLM chat/completions) ━━━
  等待响应 (MiniMax 延迟通常 1–5s,Anthropic 略长)...
  raw: {"ok":true,"latencyMs":1234,"model":"MiniMax-Text-01","reply":"ok","usage":{...}}
  ✓ llm.test.ok  (true)
  reply='ok'  latency=1234ms  model=MiniMax-Text-01

━━━ 4/7  /api/ha/ping (REST /api/) ━━━
  raw: {"ok":true,"haVersion":"2026.6.0","message":"API running.","wsOk":true}
  ✓ ha.ping.rest  (true)
  haVersion=2026.6.0  apiMessage=API running.

━━━ 5/7  /api/ha/ping 中 wsOk 字段 (WebSocket 握手) ━━━
  ✓ ha.ping.ws  (true)

━━━ 6/7  /data/config.json 静态检查 ━━━
  path:   /data/config.json
  mode:   600  (期望 600)
  size:   XXX bytes
  ✓ config.perms  (600)
  contents (apiKey/token 已 mask):
    {
      "ha": { "baseUrl": "http://supervisor/core", "token": "eyJhbGc…xxxx" },
      "llm": { "provider": "minimax", "baseUrl": "https://api.minimaxi.com/v1", "apiKey": "sk-cp…0iFW", "model": "MiniMax-Text-01" }
    }
  ✓ config.ha.token  (yes)
  ✓ config.llm.apiKey  (yes)
  ✓ config.llm.baseUrl  (yes)

━━━ 7/7  /data/backups/lovelace/ 目录 ━━━
  ⚠ /data/backups/lovelace/ 还没创建 — 还没跑过 preview push
  (正常,业务流跑过一次后就会出现)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PASS: 9   FAIL: 0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ smoke 9/9 全过 — 主流程的前置条件都满足
```

**任意一项 FAIL 怎么办**:
- 1 FAIL (daemon up) → run.sh 没拉起。看 `/data/logs/run.log` 末尾。
- 2 FAIL (llm configured) → 没填 option 或 restart 没生效。
- 3 FAIL (llm test) → baseUrl / apiKey / model 拼错。`raw: ...` 里有 HTTP 状态码和错误前 300 字符。
- 4/5 FAIL (ha ping) → SUPERVISOR_TOKEN 没写入。看 step 6 的 `config.ha.token` 是不是 `no`,是的话去 Add-on Configuration tab 切一下什么再保存触发重启。
- 6 FAIL (config.json) → 容器还没初始化,或 `/data` 不可写。add-on 的 `map: [data]` 配置有吗?
- 7 不算 FAIL(业务流跑过一次后才有)。

---

## Step 4 — 在 web UI 发 brief(主流程)

1. HA 侧栏 → **AI Designer**(v0.1.20 那个入口)
2. 在 ChatPane 输入框粘这个 brief(**先用 A1,稳**):

```
做一个最小化的首页。只用一个视图,标题"总览",里面放一个 markdown
卡片,内容写"Hello from ha-ai-designer, smoke test 成功"。

不需要引用任何 entity。
```

3. 等 2–8 秒,对话气泡应该出现一段渲染过的 YAML 代码块

**预期看到的代码块**(LLM 会有差异,这是 orchestrator 实际拿到的):

````yaml
title: 极简首页
views:
  - title: 总览
    path: home
    cards:
      - type: markdown
        content: |
          Hello from ha-ai-designer, smoke test 成功
````

4. 滚动到底部找 **"预览 / Push preview"** 按钮,点一下

**预期**: 
- 按钮下方出现一行小字 "已备份到 data/backups/lovelace/<ts>.json" 或类似
- 出现一个 iframe 或链接 "在 HA 仪表板打开"

---

## Step 5 — 验证 HA 仪表板 + 备份文件

### 5a. HA 仪表板

打开 `http://192.168.88.183:8123/lovelace/lovelace` (或侧栏 **Overview**),应该看到:

- 一个 markdown 卡片,内容是 "Hello from ha-ai-designer, smoke test 成功"

**没有?** 你的 HA 仪表板可能被 LLM 输出的 yaml 整张覆盖了。回到原仪表板:Settings → Dashboards → Overview → 找 "恢复" 按钮(或者直接 `bash` 找 `data/backups/lovelace/`)。

### 5b. 备份文件

```bash
CONTAINER=$(docker ps --format '{{.Names}}' | grep ha_ai_designer)
docker exec "${CONTAINER}" ls -la /data/backups/lovelace/
```

应该看到新文件(看时间戳是刚才):

```
-rw-r--r-- 1 root root  234  Jun 13 22:30  1718305812345.json
```

`cat` 一下,应该是你刚推的 LovelaceConfig。

### 5c. 日志

```bash
CONTAINER=$(docker ps --format '{{.Names}}' | grep ha_ai_designer)
docker exec "${CONTAINER}" tail -50 /data/logs/daemon.log
```

找这两行(说明 push 走完了):

```
{"level":"info","msg":"→ HA dashboard push — proceeding after user confirmation","intent":"preview push from web ui"}
{"level":"info","msg":"HA dashboard push succeeded","sessionId":"..."}
```

---

## Step 6 — 把结果贴回来

把以下贴回对话(我帮你分析):

1. `smoke.sh` 完整输出
2. web UI 显示的 yaml 块(从 ChatPane 复制)
3. `docker exec <id> tail -100 /data/logs/daemon.log` 末尾
4. `docker exec <id> ls -la /data/backups/lovelace/`
5. HA 仪表板截图(看新卡有没有出现)

---

## 万一 preview 写挂了想回滚

```bash
CONTAINER=$(docker ps --format '{{.Names}}' | grep ha_ai_designer)
# 列备份
docker exec "${CONTAINER}" ls /data/backups/lovelace/
# 选一个时间戳最早的回滚(那是原始仪表板)
TIMESTAMP=<挑一个>
curl -X POST -H 'Content-Type: application/json' \
  -d "{\"__confirmed_by_user\":true,\"intent\":\"smoke test rollback\"}" \
  "http://127.0.0.1:7456/api/ha/dashboards/preview/backups/${TIMESTAMP}/restore"
```

或者直接 web UI 的 "回滚" 按钮(如果有)。

---

## 跑完看这里

- 7 项全过 + A1 预览成功 + HA 仪表板有新卡 + 备份文件出现 → **A 完成,主流程 v0.1.20 端到端 OK**,下个任务可以做 B(修剩余 2 个安全 issue)
- 任何一步挂 → 把输出 + log 贴回来,我帮你定位
