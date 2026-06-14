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
# v0.3.1: data_dir is no longer a user-settable option (CLAUDE.md 14 课
# #11 footgun: a v0.1.20 incident saw users ship "/data " with a trailing
# space, which broke every downstream ${DATA_DIR}/... path. The v0.1.21
# fix was `| xargs` to trim, but the schema field still gave users a way
# to shoot themselves. v0.3.1 removes the field entirely — /data is
# always the add-on's persistent volume, full stop.)
DATA_DIR='/data'
LLM_PROVIDER=$(bashio::config 'llm_provider' '')        || LLM_PROVIDER=''
LLM_BASE_URL=$(bashio::config 'llm_base_url' '')        || LLM_BASE_URL=''
LLM_MODEL=$(bashio::config 'llm_model' '')              || LLM_MODEL=''
LLM_API_KEY=$(bashio::config 'llm_api_key' '')          || LLM_API_KEY=''
# v0.3.1.1: independent RAG embedding endpoint. Optional — when unset,
# the daemon falls back to llm_base_url (for providers that also serve
# /v1/embeddings, e.g. OpenAI / some MiniMax setups). Set both
# embedding_base_url + embedding_model to use a dedicated endpoint
# (recommended: local infinity + BAAI/bge-m3, separate from chat LLM).
EMBEDDING_BASE_URL=$(bashio::config 'embedding_base_url' '' | xargs)  || EMBEDDING_BASE_URL=''
EMBEDDING_MODEL=$(bashio::config 'embedding_model' '' | xargs)        || EMBEDDING_MODEL=''
EMBEDDING_API_KEY=$(bashio::config 'embedding_api_key' '' | xargs)    || EMBEDDING_API_KEY=''

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

# 2. Persist config.json — single block, merge ha/llm/embedding
#    sections. v0.3.1.1 refactor: the v0.1.20 "two if blocks overwrite
#    each other" bug pattern is gone. We read the existing config first,
#    then layer the three optional sections in, then write once. Any
#    section the user didn't set on this restart is PRESERVED from the
#    previous run (this matters when the user clears a field — the old
#    value stays until the user explicitly empties the value AND we
#    re-render the file; for the typical "fill in once and stay" case
#    this is exactly what we want).
#
#    Sections:
#      ha:         { baseUrl, token }   — from SUPERVISOR_TOKEN
#      llm:        { provider, baseUrl, apiKey, model }
#      llm.embed*: { embeddingModel, embeddingBaseUrl?, embeddingApiKey? }
#
#    RAG-only deployments can leave llm.{provider,baseUrl,apiKey,model}
#    empty and only set embedding_* — loadLlmConfig() in the daemon will
#    throw on /api/chat, but the RAG store (loadEmbeddingConfig) indexes
#    just fine.
if [ -n "${SUPERVISOR_TOKEN}" ] || [ -n "${LLM_API_KEY}" ] || [ -n "${EMBEDDING_MODEL}" ]; then
  bashio::log.info "Persisting config to ${DATA_DIR}/config.json (apiKey masked in logs)"

  # Read the existing sections we want to preserve. Default to '{}' so
  # jq-style fallbacks work even on first boot.
  # v0.3.1.1: use jq directly (hassio base 16.3.2 ships jq 1.7.1) instead
  # of bashio::jq, which doesn't pass --arg through correctly and
  # rejects the multi-arg form we use below for the LLM section. The
  # bashio::jq wrapper is convenient for one-arg filters but loses
  # too much on anything more complex.
  EXISTING_HA='{}'
  EXISTING_LLM='{}'
  if [ -f "${DATA_DIR}/config.json" ]; then
    EXISTING_HA=$(jq -r '.ha // {}' "${DATA_DIR}/config.json" 2>/dev/null || echo "{}")
    EXISTING_LLM=$(jq -r '.llm // {}' "${DATA_DIR}/config.json" 2>/dev/null || echo "{}")
  fi

  # Build the ha section
  HA_JSON='{}'
  if [ -n "${SUPERVISOR_TOKEN}" ]; then
    HA_JSON="{\"baseUrl\": \"http://supervisor/core\", \"token\": \"${SUPERVISOR_TOKEN}\"}"
    bashio::log.info "  ha: supervisor token (baseUrl=http://supervisor/core)"
  elif [ "${EXISTING_HA}" != "{}" ]; then
    HA_JSON="${EXISTING_HA}"
    bashio::log.info "  ha: preserving previous config"
  fi

  # Build the llm chat section. We layer: existing LLM first, then
  # overwrite the 4 chat fields if the user supplied them this run.
  LLM_JSON="${EXISTING_LLM}"
  if [ -n "${LLM_API_KEY}" ]; then
    LLM_JSON=$(echo "${LLM_JSON}" | jq \
      --arg provider "${LLM_PROVIDER}" \
      --arg baseUrl "${LLM_BASE_URL}" \
      --arg apiKey  "${LLM_API_KEY}" \
      --arg model   "${LLM_MODEL}" \
      '. + {provider: $provider, baseUrl: $baseUrl, apiKey: $apiKey, model: $model}')
    bashio::log.info "  llm: ${LLM_PROVIDER} ${LLM_MODEL} (apiKey masked)"
  fi

  # Build the embedding sub-section. Independent of LLM chat — user can
  # set embedding_* without touching llm_* and vice versa. We use jq's
  # object-spread trick (`+ {}`) to conditionally include keys so that
  # empty user inputs are NOT written as empty strings (the daemon's
  # `?? null` fallback would not trigger on "" and we'd get a confusing
  # "baseUrl not configured" error).
  #
  # v0.3.1.2: bashio::config for an UNSET option returns the literal
  # string "null" on this hassio base 16.3.2 (NOT empty string). The
  # v0.3.1.1 guard (`if $baseUrl != ""`) was therefore insufficient
  # and the literal `"null"` ended up in config.json — which then made
  # the daemon build URLs like `null/embeddings` and fail embedding
  # probe. Guard against both the empty case AND the literal-"null"
  # case (defensive: "null" in the v0.3.1 base, "null" set in jq
  # output also rejected to be safe).
  if [ -n "${EMBEDDING_MODEL}" ] && [ "${EMBEDDING_MODEL}" != "null" ]; then
    LLM_JSON=$(echo "${LLM_JSON}" | jq \
      --arg model "${EMBEDDING_MODEL}" \
      --arg baseUrl "${EMBEDDING_BASE_URL}" \
      --arg apiKey "${EMBEDDING_API_KEY}" \
      '. + (
        {embeddingModel: $model}
        + (if $baseUrl != "" and $baseUrl != "null" then {embeddingBaseUrl: $baseUrl} else {} end)
        + (if $apiKey  != "" and $apiKey  != "null" then {embeddingApiKey:  $apiKey}  else {} end)
      )')
    bashio::log.info "  llm.embedding: ${EMBEDDING_MODEL} ${EMBEDDING_BASE_URL:+@ ${EMBEDDING_BASE_URL}}"
  fi

  # Write the final config.json. Empty llm block is fine (e.g. user set
  # only embedding_*) — loadLlmConfig() will throw on /api/chat but the
  # RAG store will load from loadEmbeddingConfig() instead.
  if [ "${HA_JSON}" = "{}" ] && [ "${LLM_JSON}" = "{}" ]; then
    bashio::log.warning "No ha or llm config to persist; skipping config.json write"
  else
    if [ "${HA_JSON}" = "{}" ]; then
      cat > "${DATA_DIR}/config.json" <<EOF
{
  "llm": ${LLM_JSON}
}
EOF
    elif [ "${LLM_JSON}" = "{}" ]; then
      cat > "${DATA_DIR}/config.json" <<EOF
{
  "ha": ${HA_JSON}
}
EOF
    else
      cat > "${DATA_DIR}/config.json" <<EOF
{
  "ha": ${HA_JSON},
  "llm": ${LLM_JSON}
}
EOF
    fi
    chmod 0600 "${DATA_DIR}/config.json" 2>/dev/null || true
  fi
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
  # v0.3.3: forward the add-on slug so the web process can build URLs
  # that match what HA ingress proxies (e.g. /hassio/ingress/<slug>/chat).
  # Without this, Next.js basePath hardcoded in next.config.mjs is the
  # only path-resolution path — that's already set, but having the slug
  # in env lets future code (e.g. og:url, redirect targets) compute the
  # same prefix dynamically.
  SUPERVISOR_SLUG="ha_ai_designer" \
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
