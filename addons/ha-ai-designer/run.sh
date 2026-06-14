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
#
# v0.4.0: schema reduced to 2 fields. LLM (chat + embedding) settings
# are set inside the add-on via the /setup wizard and persisted to
# /data/config.json. run.sh only reads infra/operational knobs.
bashio::log.info "Reading add-on options..."
LOG_LEVEL=$(bashio::config 'log_level' 'info')          || LOG_LEVEL='info'
INGRESS_PORT=$(bashio::config 'ingress_port' '3000')    || INGRESS_PORT='3000'
# v0.3.1: data_dir is no longer a user-settable option (CLAUDE.md 14 课
# #11 footgun: a v0.1.20 incident saw users ship "/data " with a trailing
# space, which broke every downstream ${DATA_DIR}/... path. The v0.1.21
# fix was `| xargs` to trim, but the schema field still gave users a way
# to shoot themselves. v0.3.1 removes the field entirely — /data is
# always the add-on's persistent volume, full stop.)
DATA_DIR='/data'
# v0.3.5: extra allowed origins for the web UI's CSRF guard
# (api/setup/* + api/daemon proxy). Comma-separated list. Used
# when the user exposes the add-on's web port (config.yaml ports:
# {3000: 3000}) and reaches the UI from a hostname or LAN IP that
# isn't HA's ingress. Forwarded to the web process as
# ALLOWED_ORIGINS_EXTRA.
ALLOWED_ORIGINS_EXTRA=$(bashio::config 'allowed_origins_extra' '' | xargs) || ALLOWED_ORIGINS_EXTRA=''

bashio::log.info "  data_dir=${DATA_DIR}  log_level=${LOG_LEVEL}  allowed_origins_extra=${ALLOWED_ORIGINS_EXTRA:-<none>}"

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

# v0.3.1: bake hha-knowledge into the image at build time. The
# Dockerfile `git clone`s it to /opt/hha-knowledge. On every container
# start, we (a) make sure the persistent /data/hha-knowledge exists
# (it's where .feedback/ lives across restarts and re-pushes of the
# add-on image), (b) seed it with the image-bundled wiki on FIRST
# boot only (the .initialized sentinel suppresses re-seeding so we
# never clobber user edits), and (c) replace the image-bundled
# /opt/hha-knowledge with a symlink to /data/hha-knowledge, so the
# daemon's HA_KNOWLEDGE_DIR path stays stable while writes are
# persisted in the supervisor-managed /data volume.
PERSIST_KNOWLEDGE_DIR="${DATA_DIR}/hha-knowledge"
mkdir -p "${PERSIST_KNOWLEDGE_DIR}" 2>/dev/null || true
if [ ! -f "${PERSIST_KNOWLEDGE_DIR}/.initialized" ] && [ -d /opt/hha-knowledge ]; then
  bashio::log.info "  Seeding /data/hha-knowledge from image-bundled wiki (first boot only)..."
  cp -rn /opt/hha-knowledge/. "${PERSIST_KNOWLEDGE_DIR}/" 2>/dev/null || true
  touch "${PERSIST_KNOWLEDGE_DIR}/.initialized"
fi
rm -rf /opt/hha-knowledge 2>/dev/null || true
ln -sf "${PERSIST_KNOWLEDGE_DIR}" /opt/hha-knowledge
export HA_KNOWLEDGE_DIR=/opt/hha-knowledge
bashio::log.info "  hha-knowledge: ${HA_KNOWLEDGE_DIR} (-> ${PERSIST_KNOWLEDGE_DIR})"

# 2. Persist config.json — v0.4.0 simplified: this script only owns
#    the `ha` section (when running as an HA add-on, SUPERVISOR_TOKEN
#    is the source of truth and gets stored here so the daemon can
#    reach HA via http://supervisor/core). The `llm` section is owned
#    by the /setup wizard and is written via POST /api/llm/config
#    from the browser. We PRESERVE any existing llm section on every
#    restart (so the wizard's edits survive a container update).
#
#    Rationale for the split:
#      - HA section: infra, set once by HA, never rotates in practice
#      - LLM section: user secret, rotated via wizard, must not be
#        clobbered by container restarts
#    Splitting ownership makes both flows simpler and harder to break.
if [ -n "${SUPERVISOR_TOKEN}" ]; then
  bashio::log.info "Persisting HA section to ${DATA_DIR}/config.json (add-on mode)"

  # Read existing config to preserve the llm section. Default to '{}'.
  EXISTING='{}'
  if [ -f "${DATA_DIR}/config.json" ]; then
    EXISTING=$(cat "${DATA_DIR}/config.json" 2>/dev/null || echo "{}")
  fi

  # v0.4.0: use jq to merge {ha: <new>} on top of existing. jq is
  # available in hassio base 16.3.2 (1.7.1) — same rationale as v0.3.1.1.
  echo "${EXISTING}" | jq \
    --arg baseUrl "http://supervisor/core" \
    --arg token   "${SUPERVISOR_TOKEN}" \
    '. + {ha: {baseUrl: $baseUrl, token: $token}}' \
    > "${DATA_DIR}/config.json" 2>/dev/null || {
      bashio::log.warning "jq merge failed; writing fresh config.json (LLM config may need re-save)"
      cat > "${DATA_DIR}/config.json" <<EOF
{
  "ha": {"baseUrl": "http://supervisor/core", "token": "${SUPERVISOR_TOKEN}"}
}
EOF
    }
  chmod 0600 "${DATA_DIR}/config.json" 2>/dev/null || true
  bashio::log.info "  ha: supervisor token (baseUrl=http://supervisor/core)"
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
# v0.4.0: SUPERVISOR_SLUG lets the web process build URLs that match
# what HA ingress proxies (e.g. /hassio/ingress/<slug>/chat). Having
# the slug in env lets future code (og:url, redirect targets) compute
# the same prefix dynamically.
#
# v0.3.5: ALLOWED_ORIGINS_EXTRA forwards user-configured extra allowed
# origins for the web UI's CSRF guard. Comma-separated; empty by
# default — ingress + localhost always work.
#
# v0.4.0: previously the inline `#` comments after `\<newline>`
# continuations in this env block were being parsed as shell comments,
# which ate SUPERVISOR_SLUG / ALLOWED_ORIGINS_EXTRA / PORT and the
# `node` command itself (root cause of the v0.3.5 401). Comments now
# live OUTSIDE the env block.
nohup env \
  HOSTNAME=0.0.0.0 \
  HA_DAEMON_URL="http://127.0.0.1:${HA_DAEMON_PORT}" \
  HA_DAEMON_PORT="${HA_DAEMON_PORT}" \
  HA_WEB_PORT="${HA_WEB_PORT}" \
  HA_DATA_DIR="${DATA_DIR}" \
  HA_DAEMON_TOKEN="${HA_DAEMON_TOKEN}" \
  SUPERVISOR_SLUG="ha_ai_designer" \
  ALLOWED_ORIGINS_EXTRA="${ALLOWED_ORIGINS_EXTRA}" \
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
