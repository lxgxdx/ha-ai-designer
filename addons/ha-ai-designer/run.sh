#!/usr/bin/with-contenv bashio
# ==============================================================================
# HA AI Designer — supervisor-managed entry point
# ==============================================================================
# Starts the daemon (port 7456) and the web UI (port 3000) in the background,
# and tail -F the logs so supervisor can pick them up.
# ------------------------------------------------------------------------------

set -e

bashio::log.info "HA AI Designer add-on starting..."

# 1. Read user-supplied options (set as env vars by supervisor)
LOG_LEVEL=$(bashio::config 'log_level')
INGRESS_PORT=$(bashio::config 'ingress_port')
DATA_DIR=$(bashio::config 'data_dir')
LLM_PROVIDER=$(bashio::config 'llm_provider')
LLM_BASE_URL=$(bashio::config 'llm_base_url')
LLM_MODEL=$(bashio::config 'llm_model')
LLM_API_KEY=$(bashio::config 'llm_api_key')

mkdir -p "${DATA_DIR}"
mkdir -p "${DATA_DIR}/backups/lovelace"
mkdir -p "${DATA_DIR}/logs"

export HA_DAEMON_PORT=7456
export HA_WEB_PORT=3000
export HA_DATA_DIR="${DATA_DIR}"
export HA_LOG_LEVEL="${LOG_LEVEL}"
export HA_LOG_PRETTY=0
export NODE_ENV=production

# 2. LLM config: if user provided, write to data/config.json so the daemon
#    can pick it up via loadLlmConfig().
if bashio::var.has_value "${LLM_API_KEY}"; then
  bashio::log.info "Persisting LLM config to ${DATA_DIR}/config.json (apiKey masked in logs)"
  # Preserve any existing HA token if previously set
  HA_TOKEN_PRESERVED=""
  if [ -f "${DATA_DIR}/config.json" ]; then
    HA_TOKEN_PRESERVED=$(bashio::jq "${DATA_DIR}/config.json" '.ha // {}' 2>/dev/null || echo "{}")
  fi
  cat > "${DATA_DIR}/config.json" <<EOF
{
  "ha": ${HA_TOKEN_PRESERVED},
  "llm": {
    "provider": "${LLM_PROVIDER}",
    "baseUrl": "${LLM_BASE_URL}",
    "apiKey": "${LLM_API_KEY}",
    "model": "${LLM_MODEL}"
  }
}
EOF
  chmod 0600 "${DATA_DIR}/config.json"
fi

# 3. Pre-warm the HA token: if homeassistant_api: true and SUPERVISOR_TOKEN
#    is set, the daemon can call HA directly using this token (no need for
#    a long-lived user token). We write it to config.json if no HA config
#    exists yet.
if [ -z "${HA_TOKEN_PRESERVED}" ] && [ -n "${SUPERVISOR_TOKEN}" ]; then
  bashio::log.info "First-boot: probing HA via supervisor token (${SUPERVISOR_TOKEN:0:8}…)"
  HA_BASE_URL="http://supervisor/core"
  HA_TOKEN="${SUPERVISOR_TOKEN}"
  cat > "${DATA_DIR}/config.json" <<EOF
{
  "ha": {
    "baseUrl": "${HA_BASE_URL}",
    "token": "${HA_TOKEN}"
  }
}
EOF
  chmod 0600 "${DATA_DIR}/config.json"
fi

# 4. Start the daemon (compiled JS — no tsx in production)
bashio::log.info "Starting daemon on port ${HA_DAEMON_PORT}…"
cd /opt/ha-ai-designer/apps/daemon
node dist/server.js \
  >> "${DATA_DIR}/logs/daemon.log" 2>&1 &
DAEMON_PID=$!
echo $DAEMON_PID > "${DATA_DIR}/.pid.daemon"

# 5. Start the web UI (Next.js default server)
bashio::log.info "Starting web UI on port ${HA_WEB_PORT}…"
cd /opt/ha-ai-designer/apps/web
HOSTNAME=0.0.0.0 \
  HA_DAEMON_URL="http://127.0.0.1:${HA_DAEMON_PORT}" \
  HA_DAEMON_PORT="${HA_DAEMON_PORT}" \
  HA_WEB_PORT="${HA_WEB_PORT}" \
  HA_DATA_DIR="${DATA_DIR}" \
  PORT="${HA_WEB_PORT}" \
  node node_modules/.bin/next start -p "${HA_WEB_PORT}" \
  >> "${DATA_DIR}/logs/web.log" 2>&1 &
WEB_PID=$!
echo $WEB_PID > "${DATA_DIR}/.pid.web"

bashio::log.info "daemon pid=${DAEMON_PID}  web pid=${WEB_PID}"

# 6. Tail both logs to stdout so supervisor picks them up
bashio::log.info "Tailing logs…"
tail -F \
  "${DATA_DIR}/logs/daemon.log" \
  "${DATA_DIR}/logs/web.log" &
TAIL_PID=$!

# 7. Wait for either child to exit, then tear down
wait -n "${DAEMON_PID}" "${WEB_PID}" "${TAIL_PID}"
EXIT_CODE=$?
bashio::log.warning "A process exited (code=${EXIT_CODE}); shutting down…"
kill "${TAIL_PID}" "${DAEMON_PID}" "${WEB_PID}" 2>/dev/null || true
exit "${EXIT_CODE}"
