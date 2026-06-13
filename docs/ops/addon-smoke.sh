#!/usr/bin/with-contenv bashio
# ==============================================================================
# HA AI Designer — add-on 模式端到端 smoke 脚本
# ==============================================================================
# 在 add-on 容器内跑,验证:
#   1. daemon 进程活着 + /api/health ok
#   2. LLM 凭证就位 (/api/llm/config)
#   3. LLM 真打通 (/api/llm/test,真打一次 chat/completions)
#   4. HA REST 通 (/api/ha/ping)
#   5. HA WebSocket 通 (lovelace/dashboards/list 握手)
#   6. /data/config.json 存在 + 权限 0600 + 字段就位
#   7. /data/backups/lovelace/ 目录就位
#
# 不调用 preview 写接口(那个需要 __confirmed_by_user,留给 UI 流程)
# ------------------------------------------------------------------------------
# 用法 (在 HA host 上):
#   1. 找到 add-on 容器 id:
#        ha addons info local_ha_ai_designer   # 看 "Container" 字段
#        或者:
#        docker ps | grep ha_ai_designer
#   2. 复制脚本进去:
#        docker cp docs/ops/addon-smoke.sh addon_<id>:/tmp/smoke.sh
#   3. 执行:
#        docker exec addon_<id> bash /tmp/smoke.sh
# ==============================================================================

set -uo pipefail

DAEMON="http://127.0.0.1:7456"
PASS=0
FAIL=0

# ---- helpers ---------------------------------------------------------------

# 从 stdin 读 JSON,按 JS 表达式提取字段。
# 例: echo '{"a":1}' | jget "j.a"     -> 1
# 例: echo '[]'       | jget "(j||[]).length" -> 0
jget() {
  node -e '
    let d = "";
    process.stdin.on("data", c => (d += c));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const v = (function(){ return ('"$1"'); })();
        process.stdout.write(v === undefined ? "" : String(v));
      } catch (e) {
        process.stdout.write("PARSE_ERR:" + e.message);
      }
    });
  '
}

step() {
  echo ""
  echo "━━━ $1 ━━━"
}

check() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $name  ($actual)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name  (got=$actual, expected=$expected)"
    FAIL=$((FAIL + 1))
  fi
}

# ---- 1. daemon health ------------------------------------------------------
step "1/7  daemon /api/health"
HEALTH=$(curl -sS -m 5 "$DAEMON/api/health" 2>&1) || HEALTH="curl failed"
echo "  raw: $HEALTH"
OK=$(echo "$HEALTH" | jget "j.ok")
check "daemon.up" "$OK" "true"

# ---- 2. LLM config ---------------------------------------------------------
step "2/7  /api/llm/config (凭证是否就位,apiKey 已 mask)"
LLM=$(curl -sS -m 5 "$DAEMON/api/llm/config" 2>&1) || LLM="curl failed"
echo "  raw: $LLM"
CONFIGURED=$(echo "$LLM" | jget "j.configured")
check "llm.configured" "$CONFIGURED" "true"
if [ "$CONFIGURED" = "true" ]; then
  PROVIDER=$(echo "$LLM" | jget "j.llm.provider")
  BASEURL=$(echo "$LLM" | jget "j.llm.baseUrl")
  MODEL=$(echo "$LLM" | jget "j.llm.model")
  APIKEY_SET=$(echo "$LLM" | jget "j.llm.apiKeySet")
  echo "  provider=$PROVIDER  baseUrl=$BASEURL  model=$MODEL  apiKeySet=$APIKEY_SET"
  if [ "$APIKEY_SET" != "true" ]; then
    echo "  ✗ LLM 凭证 incomplete: apiKey 未设置 (仅在 ollama provider 下可接受)"
    FAIL=$((FAIL + 1))
  fi
fi

# ---- 3. LLM 真打通 ---------------------------------------------------------
step "3/7  /api/llm/test (真打一次 LLM chat/completions)"
echo "  等待响应 (MiniMax 延迟通常 1–5s,Anthropic 略长)..."
TEST=$(curl -sS -m 30 -X POST -H 'Content-Type: application/json' -d '{}' "$DAEMON/api/llm/test" 2>&1) || TEST="curl failed"
echo "  raw: $TEST"
LLMOK=$(echo "$TEST" | jget "j.ok")
check "llm.test.ok" "$LLMOK" "true"
if [ "$LLMOK" = "true" ]; then
  REPLY=$(echo "$TEST" | jget "j.reply")
  LATENCY=$(echo "$TEST" | jget "j.latencyMs")
  USED_MODEL=$(echo "$TEST" | jget "j.model")
  echo "  reply='$REPLY'"
  echo "  latency=${LATENCY}ms  model=$USED_MODEL"
  # 期望 reply 是 "ok" (testChat 用的 prompt 是 "Reply with just 'ok'")
  if [ "$REPLY" != "ok" ]; then
    echo "  ⚠ reply 不是 'ok' — LLM 没遵循极简 prompt,可能是 provider 兼容性问题 (不影响主流程)"
  fi
else
  MSG=$(echo "$TEST" | jget "j.message")
  echo "  ✗ LLM test 失败: $MSG"
  echo "  常见原因:"
  echo "    - baseUrl 拼错路径 (MiniMax = https://api.minimaxi.com/v1,末尾 /v1 必带)"
  echo "    - apiKey 错/过期"
  echo "    - provider 名拼错 (MiniMax 的 id 是 'minimax' 全小写)"
  echo "    - 网络出不去 (add-on 容器 egress 受限?)"
fi

# ---- 4. HA ping (REST) -----------------------------------------------------
step "4/7  /api/ha/ping (REST /api/)"
PING=$(curl -sS -m 10 "$DAEMON/api/ha/ping" 2>&1) || PING="curl failed"
echo "  raw: $PING"
HAOK=$(echo "$PING" | jget "j.ok")
check "ha.ping.rest" "$HAOK" "true"
if [ "$HAOK" = "true" ]; then
  HAVER=$(echo "$PING" | jget "j.haVersion")
  MSGBODY=$(echo "$PING" | jget "j.message")
  echo "  haVersion=$HAVER  apiMessage=$MSGBODY"
fi

# ---- 5. HA WebSocket -------------------------------------------------------
step "5/7  /api/ha/ping 中 wsOk 字段 (WebSocket 握手)"
if [ "$HAOK" = "true" ]; then
  WSOK=$(echo "$PING" | jget "j.wsOk")
  check "ha.ping.ws" "$WSOK" "true"
  if [ "$WSOK" != "true" ]; then
    echo "  ⚠ WebSocket 失败 — preview/list dashboards 会挂"
    echo "  排查: SUPERVISOR_TOKEN 是否在 run.sh 启动时被写到 /data/config.json (看第 6 步)"
  fi
else
  echo "  跳过 (REST 都不通,WS 一定不通)"
fi

# ---- 6. /data/config.json -------------------------------------------------
step "6/7  /data/config.json 静态检查"
if [ -f /data/config.json ]; then
  PERMS=$(stat -c '%a' /data/config.json 2>/dev/null || stat -f '%Lp' /data/config.json)
  SIZE=$(stat -c '%s' /data/config.json 2>/dev/null || stat -f '%z' /data/config.json)
  echo "  path:   /data/config.json"
  echo "  mode:   $PERMS  (期望 600)"
  echo "  size:   $SIZE bytes"
  check "config.perms" "$PERMS" "600"
  echo "  contents (apiKey/token 已 mask):"
  node -e '
    const j = require("/data/config.json");
    const mask = k => (k && k.length > 8 ? k.slice(0,4)+"…"+k.slice(-4) : "***");
    if (j.llm && j.llm.apiKey) j.llm.apiKey = mask(j.llm.apiKey);
    if (j.ha  && j.ha.token)   j.ha.token   = mask(j.ha.token);
    console.log("  " + JSON.stringify(j, null, 2).split("\n").join("\n  "));
  '
  # 字段完整性
  HA_TOKEN=$(node -e 'try{const j=require("/data/config.json"); process.stdout.write(j.ha && j.ha.token ? "yes" : "no");}catch(e){process.stdout.write("no");}')
  LLM_APIKEY=$(node -e 'try{const j=require("/data/config.json"); process.stdout.write(j.llm && j.llm.apiKey ? "yes" : "no");}catch(e){process.stdout.write("no");}')
  LLM_BASEURL=$(node -e 'try{const j=require("/data/config.json"); process.stdout.write(j.llm && j.llm.baseUrl ? "yes" : "no");}catch(e){process.stdout.write("no");}')
  check "config.ha.token"  "$HA_TOKEN"    "yes"
  check "config.llm.apiKey" "$LLM_APIKEY" "yes"
  check "config.llm.baseUrl" "$LLM_BASEURL" "yes"
else
  echo "  ✗ /data/config.json 不存在 — 容器还没初始化?"
  echo "  原因可能是 run.sh 在 [ -z \"\${LLM_API_KEY}\" ] 时没写 LLM 块"
  echo "  而且 SUPERVISOR_TOKEN 也没注入 (你用的是 non-supervisor 模式?)"
  FAIL=$((FAIL + 1))
fi

# ---- 7. backups 目录 -------------------------------------------------------
step "7/7  /data/backups/lovelace/ 目录"
if [ -d /data/backups/lovelace ]; then
  echo "  contents:"
  ls -la /data/backups/lovelace/ 2>/dev/null | sed 's/^/    /' | head -20
  BC=$(ls /data/backups/lovelace/*.json 2>/dev/null | wc -l)
  echo "  backup snapshot count: $BC"
else
  echo "  ⚠ /data/backups/lovelace/ 还没创建 — 还没跑过 preview push"
  echo "  (正常,业务流跑过一次后就会出现)"
fi

# ---- summary ---------------------------------------------------------------
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -eq 0 ]; then
  echo "  ✓ smoke 7/7 全过 — 主流程的前置条件都满足"
  echo "  → 下一步: 在 HA 侧栏 AI Designer 里发 brief,看 LLM 输出 + preview 备份"
  exit 0
else
  echo "  ✗ $FAIL 项失败 — 贴这个输出 + /data/logs/{run,daemon,web}.log 找问题"
  exit 1
fi
