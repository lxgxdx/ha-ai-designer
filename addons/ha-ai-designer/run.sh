#!/usr/bin/with-contenv bashio
# ==============================================================================
# HA AI Designer — supervisor-managed entry point
# ==============================================================================
# Starts the daemon (port 7456) and the web UI (port 3000) in the background,
# and tail -F the logs so supervisor picks them up.
# ------------------------------------------------------------------------------
# IMPORTANT: do NOT use `set -e` here. A single failed `mkdir` or
# `bashio::config` (e.g. a freshly-added option the user hasn't filled in)
# would otherwise tear down the whole add-on container and s6 would loop on
# "legacy-services stopping/stopped" without a clear error in stdout.  Every
# step is guarded and logged explicitly below.
# ------------------------------------------------------------------------------
# NOTE: s6-overlay (used by hassio base 16) does NOT forward this script's
# stdout to the HA supervisor log view.  We tee everything to
# /data/logs/run.log so the user can read it from the host if needed, and
# the daemon / web process logs go to /data/logs/{daemon,web}.log.
#
# Make sure /data/logs exists BEFORE the first tee (otherwise some s6 services
# start this script with a non-writable /data).
mkdir -p /data/logs 2>/dev/null || true
# Mirror every stdout/stderr line to /data/logs/run.log.
exec > >(tee -a /data/logs/run.log) 2>&1

# 1. Read user-supplied options (set as env vars by supervisor).
#    Tolerate missing options by defaulting to empty — supervisor sometimes
#    doesn't pass the key if the user cleared the field.
bashio::log.info "Reading add-on options..."
LOG_LEVEL=$(bashio::config 'log_level' 'info')          || LOG_LEVEL='info'
INGRESS_PORT=$(bashio::config 'ingress_port' '3000')    || INGRESS_PORT='3000'
# v0.1.21: trim trailing whitespace from user-supplied paths. Users have
# shipped data_dir="/data " (trailing space) in past incidents, which
# caused every subsequent ${DATA_DIR}/... path to be interpreted as a
# literal filename with a space in the middle (e.g. "/data /config.json").
DATA_DIR=$(bashio::config 'data_dir' '/data' | xargs)   || DATA_DIR='/data'
LLM_PROVIDER=$(bashio::config 'llm_provider' '')        || LLM_PROVIDER=''
LLM_BASE_URL=$(bashio::config 'llm_base_url' '')        || LLM_BASE_URL=''
LLM_MODEL=$(bashio::config 'llm_model' '')              || LLM_MODEL=''
LLM_API_KEY=$(bashio::config 'llm_api_key' '')          || LLM_API_KEY=''

bashio::log.info "  data_dir=${DATA_DIR}  log_level=${LOG_LEVEL}  llm_provider=${LLM_PROVIDER}"

mkdir -p "${DATA_DIR}"           || bashio::exit.nok "mkdir ${DATA_DIR} failed"
mkdir -p "${DATA_DIR}/backups/lovelace" 2>/dev/null || true
mkdir -p "${DATA_DIR}/logs"             2>/dev/null || true

export HA_DAEMON_PORT=7456
export HA_WEB_PORT="${INGRESS_PORT}"
export HA_DATA_DIR="${DATA_DIR}"
export HA_LOG_LEVEL="${LOG_LEVEL}"
export HA_LOG_PRETTY=0
export NODE_ENV=production
# v0.1.21: tell the orchestrator where to find skills/, design-systems/,
# and craft/ at runtime. The Dockerfile copies these into
# /opt/ha-ai-designer/ alongside apps/.
export HA_REPO_ROOT=/opt/ha-ai-designer

# 2. Pre-warm the HA token FIRST: if homeassistant_api: true and
#    SUPERVISOR_TOKEN is set, write a ha-only config.json so the daemon
#    can call HA via the supervisor proxy without a long-lived user token.
#
#    v0.1.21: this block runs BEFORE the LLM block (it used to run after).
#    In v0.1.20 the two blocks were not mutually exclusive: the LLM block
#    wrote {ha, llm} but then immediately the supervisor block re-wrote
#    {ha}-only, dropping the llm block. Reordering means the LLM block
#    (step 3) can now read the just-written ha block and merge it in.
if [ -n "${SUPERVISOR_TOKEN}" ]; then
  bashio::log.info "Persisting HA token (supervisor) to ${DATA_DIR}/config.json"
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
  chmod 0600 "${DATA_DIR}/config.json" 2>/dev/null || true
fi

# 3. LLM config: if user provided, merge into data/config.json so the
#    daemon can pick it up via loadLlmConfig(). Reads the existing ha
#    block (just written by step 2) and preserves it.
if [ -n "${LLM_API_KEY}" ]; then
  bashio::log.info "Persisting LLM config to ${DATA_DIR}/config.json (apiKey masked in logs)"
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
  chmod 0600 "${DATA_DIR}/config.json" 2>/dev/null || true
fi

# 3.5. Kill any previous run's daemon/web processes. s6 restarts run.sh on
#      crash, and each iteration would otherwise leave the previous
#      daemon bound to 7456, causing EADDRINUSE on the next attempt.
bashio::log.info "Cleaning up any previous daemon/web processes..."
pkill -f 'node dist/server.js' 2>/dev/null || true
pkill -f 'next start'         2>/dev/null || true
pkill -f 'next-server'        2>/dev/null || true
sleep 1

# 4. Start the daemon (compiled JS — no tsx in production)
bashio::log.info "Starting daemon on port ${HA_DAEMON_PORT}..."
cd /opt/ha-ai-designer/apps/daemon || bashio::exit.nok "daemon dir missing"
nohup node dist/server.js \
  >> "${DATA_DIR}/logs/daemon.log" 2>&1 &
DAEMON_PID=$!
echo "${DAEMON_PID}" > "${DATA_DIR}/.pid.daemon" 2>/dev/null || true
bashio::log.info "  daemon pid=${DAEMON_PID}"

# 5. Start the web UI (Next.js default server).
#    NOTE: we call `next` via its real entry (node_modules/next/dist/bin/next)
#    rather than the .bin/next shim, because pnpm 9/10 generates the shim
#    as a shell script that Node tries to parse as JS, which crashes with
#    'SyntaxError: missing ) after argument list'. Using the dist entry
#    directly bypasses the broken shim.
bashio::log.info "Starting web UI on port ${HA_WEB_PORT}..."
cd /opt/ha-ai-designer/apps/web || bashio::exit.nok "web dir missing"
NEXT_ENTRY="/opt/ha-ai-designer/apps/web/node_modules/next/dist/bin/next"
if [ ! -f "${NEXT_ENTRY}" ]; then
  bashio::exit.nok "Next.js entry not found at ${NEXT_ENTRY}"
fi
# v0.1.22: pass the daemon's internal auth token to the web process so
# server-side fetches (page.tsx) can authenticate. The daemon mints this
# token on first boot and writes it to ${DATA_DIR}/.daemon-token (mode 0600).
# If the file is missing (e.g. the daemon hasn't started yet) we leave
# HA_DAEMON_TOKEN unset; the web will fall back to the env-less path and
# daemon will reject those calls with 401 — that failure mode is loud and
# obvious, which is the right behavior.
HA_DAEMON_TOKEN=""
if [ -f "${DATA_DIR}/.daemon-token" ]; then
  HA_DAEMON_TOKEN=$(cat "${DATA_DIR}/.daemon-token" 2>/dev/null || true)
fi
nohup env \
  HOSTNAME=0.0.0.0 \
  HA_DAEMON_URL="http://127.0.0.1:${HA_DAEMON_PORT}" \
  HA_DAEMON_PORT="${HA_DAEMON_PORT}" \
  HA_WEB_PORT="${HA_WEB_PORT}" \
  HA_DATA_DIR="${DATA_DIR}" \
  HA_DAEMON_TOKEN="${HA_DAEMON_TOKEN}" \
  PORT="${HA_WEB_PORT}" \
  node "${NEXT_ENTRY}" start -p "${HA_WEB_PORT}" \
  >> "${DATA_DIR}/logs/web.log" 2>&1 &
WEB_PID=$!
echo "${WEB_PID}" > "${DATA_DIR}/.pid.web" 2>/dev/null || true
bashio::log.info "  web pid=${WEB_PID}"

# 6. Tail both logs to stdout so supervisor picks them up
bashio::log.info "Tailing logs from ${DATA_DIR}/logs/{daemon,web}.log..."
touch "${DATA_DIR}/logs/daemon.log" 2>/dev/null || true
touch "${DATA_DIR}/logs/web.log"     2>/dev/null || true
tail -F \
  "${DATA_DIR}/logs/daemon.log" \
  "${DATA_DIR}/logs/web.log" &
TAIL_PID=$!

# 7. Wait for either child to exit, then tear down
wait -n "${DAEMON_PID}" "${WEB_PID}" "${TAIL_PID}"
EXIT_CODE=$?
bashio::log.warning "A process exited (code=${EXIT_CODE}); shutting down..."
kill "${TAIL_PID}" "${DAEMON_PID}" "${WEB_PID}" 2>/dev/null || true
exit "${EXIT_CODE}"
