# Changelog

## 0.3.0 — 2026-06-14

### Added
- **hha-knowledge wiki binding (RAG-ready)**. The orchestrator now
  reads the user's hha-knowledge wiki at startup and injects two new
  sections into the LLM system prompt:
    1. A lightweight "Available knowledge" summary (every article's
       title + 1-line description, derived from `wiki/index.md`) so
       the LLM knows which card types / APIs / Jinja2 functions are
       KNOWN. Roughly 1k tokens.
    2. A `top-k=3..5` RAG snippet per brief — the chunks most relevant
       to the user's specific request, with full content. This is
       what the LLM actually uses to ground its YAML output.
  Both blocks are empty when `HA_KNOWLEDGE_DIR` is unset, so v0.3.0
  is fully backward compatible — no config needed to upgrade.
- **`feedback` loop** (v0.3.2.3). New `POST /api/chat/feedback` writes
  a one-line JSONL record per dashboard rating to
  `${HA_KNOWLEDGE_DIR}/.feedback/feedback.jsonl`. The web UI shows
  👍 / 👎 / optional-comment buttons after every generation.
  `scripts/learn.ts` (v0.3.2.4, in the hha-knowledge repo) reads
  the negative entries and asks the LLM to rewrite the relevant
  wiki notes, with humans reviewing the candidates before they
  land in `wiki/`.
- **Independent RAG embedding endpoint** (v0.3.1.1). The add-on
  Configuration now accepts `embedding_base_url` / `embedding_model`
  / `embedding_api_key` separately from the chat LLM. Use cases:
  chat via MiniMax + embeddings via a local `infinity` server
  running BAAI/bge-m3; or chat via OpenAI + embeddings via
  `text-embedding-3-small`. Both pieces can be the same provider
  too — leave the embedding baseUrl blank and the daemon falls
  back to `llm.baseUrl`.
- **Soft card-type validation** (v0.3.0). The orchestrator now
  emits a warning when the LLM produces a `type:` that is not in
  the known built-in (51) + HACS (28) set. Catches obvious
  hallucinations like `type: card-list` before they hit HA.
- **hha-knowledge Linter** (v0.3.2.2, in the hha-knowledge repo).
  `scripts/lint.ts` is a deterministic, no-LLM linter that enforces
  800-line-per-article, Sources / Raw link / See Also presence,
  index consistency, conflict-marker rules, mtime freshness. Run
  with `pnpm scripts/lint`. Exits non-zero on FAIL.

### Changed
- `addons/ha-ai-designer/config.yaml` version bumped: `0.2.0` → `0.3.0`.
- New `map: ["share:rw"]` top-level field — the add-on bind-mounts
  the supervisor share root at `/share` so the daemon can read
  `hha-knowledge/` (which lives outside the daemon's git repo and
  therefore can't be COPYed into the build context). User fills
  `knowledge_dir` (default `hha-knowledge`) in the add-on
  Configuration; the daemon reads from `/share/${knowledge_dir}/`.
- `addons/ha-ai-designer/run.sh` exports `HA_KNOWLEDGE_DIR` for
  the orchestrator + RAG store + feedback writer.
- `data/config.json` schema gained `llm.embeddingBaseUrl?`,
  `llm.embeddingApiKey?`, `llm.embeddingModel?` (v0.3.1.1).
- `apps/daemon/src/llm-orchestrator.ts` adds 53 lines of
  `KNOWN_HA_CARD_TYPES` (whitelist) and 91 lines of wiki-summary
  parser. No breaking change to existing orchestrator callers.

### Security
- v0.3.0 RAG never re-invents card types — it asks the LLM to
  cite the wiki, and unknown types surface as warnings. No code-
  execution risk from the wiki content (markdown only).
- `feedback` is gated behind the same internal-auth middleware as
  every other daemon route (X-Addon-Internal-Token). When called
  via the browser it goes through `/api/daemon/[...path]` which
  runs the CSRF Origin check.
- The `HA_KNOWLEDGE_DIR` path the user supplies is NEVER
  shell-expanded by run.sh beyond a `| xargs` trim — Bash 3.x
  command-substitution injection is not a concern.
- The RAG embedding client (`apps/daemon/src/embedding-client.ts`)
  reuses the same SSRF guard as the LLM client: if a future
  `embeddingBaseUrl` is set to a private IP, the daemon will warn
  on startup (or refuse outright if `HA_LLM_ALLOW_PRIVATE_HOSTS`
  is not set).

### Known limitations
- **RAG only triggers if** the LLM BYOK is configured AND an
  embedding model is configured. With neither, the daemon runs in
  v0.2.0-equivalent mode (no wiki awareness).
- **Windows typecheck noise**: `@types/express@4.17.21` ships a
  half-baked namespace merge that `tsc` flags as
  "Property 'path' does not exist on Request" / similar for ~122
  lines under strict mode. These are upstream typing bugs, not
  runtime issues — the code runs fine. v0.4.x should bump to
  `@types/express@5.x` (breaking; deferred to a dedicated PR).
- **No aarch64 build** in CI. The matrix only builds amd64; the
  `arch: [amd64, aarch64]` list in `config.yaml` documents the
  intent. See CLAUDE.md 14 课 #7 for the multi-arch manifest merge
  workaround when we get to it.

## 0.2.0 — 2026-06-13

### Added
- **`/api/chat` SSE streaming** (low-latency UX). Previously the
  endpoint was a non-streaming POST that returned the parsed
  LovelaceConfig only after the full LLM reply landed (2–8 s of
  blank box). v0.2.0 introduces `orchestrateStream()` which forwards
  LLM token deltas as `event: llm-chunk` SSE frames so the browser
  can render output as it's generated, plus `event: yaml-extracted`
  / `event: validated` / `event: done` for the post-processing stages.
  The legacy JSON path is preserved under `?stream=0` for smoke /
  curl scripts.
- **First-run setup wizard** at `/setup`. New `apps/web/src/app/setup/page.tsx`
  walks the user through two forms:
    1. Home Assistant: baseUrl + Long-Lived Access Token — submitted
       via `POST /api/ha/config`, then verified with `GET /api/ha/ping`.
    2. LLM BYOK: provider (8 presets incl. MiniMax / OpenAI /
       Anthropic / Qwen / Zhipu / Moonshot / Ollama / custom) +
       baseUrl + model + apiKey — submitted via `POST /api/llm/config`
       and verified with `POST /api/llm/test`.
  Both steps gate the "next" button on a successful test. The
  home `/` page now redirects to `/setup` whenever the daemon reports
  either LLM or HA as un-configured (or unreachable), so fresh
  installs land on the wizard rather than a confusing blank page.
- **Same-origin daemon proxy**. `apps/web/src/app/api/daemon/[...path]/route.ts`
  is a Next.js catch-all that forwards every browser request to
  `http://127.0.0.1:7456/<path>` with the `X-Addon-Internal-Token`
  header attached. ChatPane.tsx now uses `/api/daemon/api/...` for
  every daemon call instead of trying to reach `127.0.0.1:7456`
  directly from the browser (which never worked — the daemon
  listens on container-internal loopback). The streaming SSE
  pass-through uses the same proxy, with `X-Accel-Buffering: no`
  set on both sides to defeat ingress response buffering.
- **ChatPane streaming UI**. The "生成" button now displays a live
  "⏳ 实时流式生成中…（N 字符已收）" indicator and a scrolling
  `<pre>` panel showing the LLM's accumulating output. After
  `event: done` fires, the result panel + apply-to-main button
  appear as before.

### Security
- **FAILSAFE_SCHEMA for LLM YAML deserialization**. `js-yaml`'s
  default schema accepts `!!js/function` and friends — a prompt-
  injection-via-brief could in principle have the LLM smuggle in
  a YAML tag that runs arbitrary JS at parse time. v0.2.0 changes
  both `yaml.load()` call sites in `llm-orchestrator.ts` to use
  `yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA })`, which only
  accepts the four primitive types (string, number, boolean, null)
  — all a LovelaceConfig ever needs.

### Verified
- v0.1.22 fixes still hold: SSRF guard rejects loopback / IMDS /
  RFC1918, web→daemon auth middleware accepts loopback + correct
  token, health probe exempt.
- New: `POST /api/chat` with `Accept: text/event-stream` returns
  a `text/event-stream` response whose first frame is an
  `event: llm-chunk`; chunks stream in as the LLM produces them;
  the final `event: done` carries the parsed LovelaceConfig +
  yaml + meta + warnings.
- New: visiting `/` on a fresh install (no `data/config.json`)
  redirects to `/setup`; completing the wizard and returning to
  `/` shows the home view.

## 0.1.22 — 2026-06-13

### Security
- **SSRF guard on `/api/llm/{config,test}`** (HIGH → mitigated). The
  LLM BYOK surface accepted an arbitrary `baseUrl` for both write
  (POST /api/llm/config) and the connectivity-test override
  (POST /api/llm/test). A malicious or compromised UI / API caller
  could turn the daemon into an SSRF proxy to:
    - the cloud-metadata IP `169.254.169.254` (AWS / GCP / Azure IMDS),
    - the supervisor proxy `http://supervisor/core/...` (LAN-reachable
      from inside the add-on container, gated by the same SUPERVISOR_TOKEN
      the daemon already holds, so daemon-mediated IMDS→HA
      credential theft was possible),
    - the host's own 127.0.0.1 / link-local / RFC1918 ranges.
  v0.1.22 adds `validatePublicBaseUrl()` which resolves the host
  (via `dns.lookup`) and rejects if ANY resolved address is in:
    - 127/8, ::1 (loopback)
    - 10/8, 172.16/12, 192.168/16, fc00::/7 (RFC1918 + ULA)
    - 169.254/16, fe80::/10 (link-local — includes 169.254.169.254 IMDS)
    - 224/4 (multicast + reserved)
    - 2001:db8::/32 (documentation)
  Both write and test routes call this. Bypass with
  `HA_LLM_ALLOW_PRIVATE_HOSTS=1` (for local ollama / dev only — never
  set in add-on mode). Failure mode: 400 with `code: PRIVATE_HOST_BLOCKED`
  and a clear `reason` field. The bypass is logged at warn level so
  misuse is visible.
- **Internal auth on web↔daemon HTTP** (HIGH → mitigated). Previously
  any process on the same Docker network (or anyone reaching
  127.0.0.1:7456) could call any daemon endpoint — including the
  write paths (`/api/ha/dashboards/preview`, `lovelace/config/save`).
  HA ingress closes the browser→web gap, but the web→daemon hop
  was completely unauthenticated. v0.1.22:
    1. daemon mints a 256-bit random token on first start, writes to
       `${HA_DATA_DIR}/.daemon-token` (mode 0600) and loads it into
       process memory.
    2. daemon middleware `internalAuthMiddleware(token)` runs BEFORE
       all routes and requires:
         (a) `req.hostname` ∈ {127.0.0.1, ::1, localhost} — non-loopback
             callers are rejected regardless of token (defense vs. an
             external attacker who discovers the container port),
         (b) header `X-Addon-Internal-Token` matches the in-memory
             token via constant-time compare. Token mismatch → 401.
       Only `GET /api/health` is exempted (operator / healthcheck).
    3. `run.sh` reads the same token file and exports it to the web
       process as `HA_DAEMON_TOKEN`. The web passes it as
       `X-Addon-Internal-Token` on every server-side fetch
       (currently only `apps/web/src/app/page.tsx`'s health probe).

### Verified
- All v0.1.21 fixes still hold (smoke 8/9 with the known
  smoke-script bug in the health parser).
- New SSRF tests: `baseUrl=http://127.0.0.1:8123` → 400, `baseUrl=
  http://169.254.169.254/...` → 400, `baseUrl=https://api.minimaxi.com/v1`
  → 200.
- New auth tests: missing/incorrect `X-Addon-Internal-Token` → 401,
  correct token → 200.

## 0.1.21 — 2026-06-13

### Fixed
- **Bug A (run.sh, `data_dir` not trimmed).** `bashio::config 'data_dir' '/data'`
  no longer returns the user's literal value (including trailing spaces).
  Added `| xargs` to strip leading/trailing whitespace. Previously a
  user-supplied `data_dir="/data "` (note the trailing space) caused every
  `${DATA_DIR}/...` path to be interpreted as a literal filename with a
  space in the middle — e.g. `/data /config.json` (an actual file in
  `/data  /config.json` under the rootfs `/`). Confirmed in production:
  this left the add-on looking healthy (daemon listening, web up) but
  `/data/config.json` and `/data/logs/*.log` were never created.
- **Bug A (run.sh, LLM block overwritten).** v0.1.20 had two adjacent
  `if` blocks: (1) "if LLM_API_KEY is set, write {ha, llm} to
  config.json", and (2) "if HA_TOKEN_PRESERVED is empty and
  SUPERVISOR_TOKEN is set, write {ha} to config.json". On first boot
  both conditions were true and the second block overwrote the first,
  dropping the `llm` slice — leaving the daemon with HA credentials but
  no LLM config. v0.1.21 reorders the blocks: supervisor token block
  first (writes `{ha}`), then LLM block (reads `{ha}` and merges in
  `{llm}`). The LLM block's `if [ -f config.json ]` guard now sees the
  just-written file so the merge works on first boot too.
- **Bug B (ha-ws-client.ts, WebSocket URL path).** `wsUrl()` was
  computing `${protocol}//${u.host}/api/websocket`, dropping `u.pathname`.
  When the daemon ran in add-on mode with `baseUrl="http://supervisor/core"`,
  this produced `ws://supervisor/api/websocket` — a path that does not
  exist on supervisor (the supervisor reverse-proxies the HA Core
  WebSocket under `/core`, not at the root). Result: every WS connect
  attempt returned `401 Unexpected server response`. v0.1.21 includes
  `u.pathname` so the URL is `ws://supervisor/core/api/websocket`.
- **Bug C (Dockerfile, skills/design-systems/craft not copied).** The
  orchestrator (`apps/daemon/src/llm-orchestrator.ts:loadSkillText`)
  reads `${HA_REPO_ROOT}/skills/<name>/SKILL.md` and
  `${HA_REPO_ROOT}/design-systems/<name>/DESIGN.md` at runtime. v0.1.20
  only COPY'd the built `apps/daemon` and `apps/web` directories into
  the image — the `skills/`, `design-systems/`, and `craft/` source
  trees were never copied. Result: every `/api/chat` call returned
  `502 Skill "..." not found under skills/ or .claude/skills/`. v0.1.21
  adds three `COPY` lines into `/opt/ha-ai-designer/` and sets
  `HA_REPO_ROOT=/opt/ha-ai-designer` in `run.sh` so the orchestrator
  resolves the paths inside the image.

### Verified
- All 3 bugs reproduce on the v0.1.20 add-on container at
  `192.168.88.183:8123` (see `docs/ops/A-task-runbook.md` for the
  end-to-end smoke procedure that surfaced them).

## 0.1.20 — 2026-06-13

### Fixed
- v0.1.19 still had ingress broken because we put `ingress_port: "port"`
  inside the `schema:` block (under `options:`), thinking that's
  where the supervisor would look. Wrong: **the `schema` is for the
  user-facing Options UI, not for the supervisor's add-on config
  parser**. The supervisor reads `ingress_port` from the **top level**
  of config.yaml, defaulting to `8099` if absent.
- Confirmed against the official HA add-on docs and the
  `esphome/home-assistant-addon` config.yaml (which sets
  `ingress_port: 0` at the top level for host_network mode).
- v0.1.20 moves `ingress_port: 3000` to the top level so the
  supervisor knows our web listens on 3000 inside the container.
  The redundant `schema.ingress_port: port` is removed (users
  shouldn't be tweaking this — they can override `llm_*` etc.).
- Run.sh is unchanged (it already starts the web on `-p 3000`).
  The supervisor will now correctly connect to
  `172.30.33.9:3000` (our actual listen port) instead of
  `172.30.33.9:8099` (the default we kept failing to override).

## 0.1.19 — 2026-06-13

### Security
- Reverted v0.1.18's port-mode escape hatch. Port mode + `auth: false`
  exposed the daemon (7456) and web (3000) to anything on the host
  network with no authentication — a CRITICAL issue (any device that
  can reach the host's 3000/7456 can call the daemon, including the
  `/api/ha/dashboards/preview` write path). Back to ingress mode:
  - `ingress: true` — HA's reverse proxy + SSO session guards the UI.
  - `auth: false` is intentional in ingress mode (it means "let HA's
    session handle auth", not "no auth at all").
  - `ports: 3000/tcp + 7456/tcp` set to `null` — no host-port
    exposure.
  - `schema.ingress_port` + `default.ingress_port: 3000` so the
    supervisor knows what port our web listens on inside the
    container (this was the v0.1.17 piece that didn't work; we
    retry with the full set of config keys).
- Known issue carried over from v0.1.17: the supervisor
  `addons info` shows `ingress_port: 8099` (its own host port),
  distinct from the container-side `default.ingress_port: 3000`
  we set. The supervisor should connect to the container via the
  container IP on port 3000 (our actual web listen). If ingress
  still fails on install, the user should `ha supervisor restart`
  before reinstalling to flush stale supervisor-side cache.

## 0.1.18 — 2026-06-13

### Changed
- Back to **port mode** (`ingress: false`, ports 7456 and 3000
  explicitly mapped to host). The v0.1.17 ingress re-enable didn't
  work: supervisor's `addons info` showed `ingress_port: 8099`
  (supervisor's own internal port) and ignored our
  `default.ingress_port: 3000`. Debugging supervisor's ingress
  port assignment behaviour is not worth the time today; port
  mode is verified working and we have a clean way to surface
  the UI in HA via a Webpage card.

### How to use inside HA
1. After install, open `http://<ha-host>:3000/` in any browser
   to use the tool directly.
2. To surface it inside the HA UI: edit any dashboard → **Add
   card → Webpage** → URL `http://<ha-host>:3000` → save. The
   Webpage card embeds the tool as an iframe, with the same
   X-Frame-Options caveats as any external embed.

## 0.1.17 — 2026-06-13

### Changed
- Reverted the v0.1.16 port-mode workaround. Back to ingress mode
  with the schema/default fix from v0.1.15 — but this time
  `ingress_port: 3000` is provided in the schema so the supervisor
  picks the right port (3000) instead of caching a stale 8099.

### User action required after upgrade
1. **Restart supervisor first** (not just the add-on) to clear
   the cached 8099 ingress port from earlier versions:
   ```
   ha supervisor restart
   ```
2. Then `Settings → Add-ons → HA AI Designer → Update` (or
   `Uninstall` then `Install` if the update button is still grey).
3. After install, the "AI Designer" panel should appear in the
   HA left sidebar.

## 0.1.16 — 2026-06-13

### Changed
- Switched the add-on from **ingress mode** to **port mode**:
  - `ingress: false` (was `true`)
  - Ports `7456/tcp` and `3000/tcp` are now explicitly mapped to
    the same host ports (was `null`).
  - Removed the `ingress_port` field from the schema (no longer
    meaningful when ingress is off).

### Why
- v0.1.15 had the supervisor caching a stale ingress port (8099)
  that didn't match what the web UI was actually listening on
  (3000). Even with the schema/default fix, the supervisor's
  `Ingress for ... not available` + `Cannot connect to
  172.30.33.9:8099` errors persisted.
- User verified that the web itself was fully working (HTTP 200,
  ChatPane served, daemon /api/health OK) — it was purely the
  ingress proxy layer failing.
- Port mode is simpler: HA browser just navigates to
  `http://<ha-host>:3000/` directly. The trade-off is no automatic
  X-Frame-Options loosening, but we already document how to access
  the UI and the dev experience is the same.

## 0.1.15 — 202-06-13

### Fixed
- v0.1.14 ran daemon + web fine inside the container, but the
  supervisor kept logging `Option 'schema' does not exist in the
  schema for HA AI Designer` and `Option 'default' does not exist`,
  and `Ingress for c1669d6a_ha_ai_designer not available`. Root
  cause: `config.yaml` had `schema:` and `default:` wrapped inside
  an `options:` block (plus a duplicate top-level `schema:`).
  HA supervisor expects `schema:` and `default:` at the **top
  level** of config.yaml — the `options:` wrapper is a different
  thing entirely.
- Removed the `options:` wrapper, removed the duplicate top-level
  `schema:`, kept the top-level `schema:` only. The user's
  actual schema definition (the second one) was already correct
  in content; the indentation was just wrong.
- This should also clear the `Ingress ... not available` warning
  that was preventing the HA sidebar ingress entry from opening
  with "应用似乎尚未准备就绪".

## 0.1.14 — 2026-06-13

### Fixed
- v0.1.13 got Node 24 working and the runtime started, but two
  issues remained:
  1. **web crashed with `SyntaxError: missing ) after argument list`
     in `node_modules/.bin/next`.** pnpm 9/10's bin shim is a shell
     script that Node tries to parse as JS, crashing on bash syntax.
     (We thought this was a Node 20 vs Node 24 issue — turned out
     to be the shim itself.) Fix: call Next.js's real entry directly,
     `node node_modules/next/dist/bin/next start -p PORT`, bypassing
     the broken shim.
  2. **daemon crashed with `EADDRINUSE` on 7456.** s6 restarts
     `run.sh` on crash, and each iteration left the previous daemon
     bound to the port. Fix: at the start of run.sh, `pkill` any
     `node dist/server.js`, `next start`, and `next-server` processes
     from prior runs before starting new ones.
- v0.1.13 had already delivered the rest (Node 24 + libstdc++ +
  full /usr/local COPY). The remaining issues were all in run.sh.

## 0.1.13 — 2026-06-13

### Fixed
- v0.1.12's `npm install -g npm@10` never even ran — the very first
  `npm --version` crashed with MODULE_NOT_FOUND because the
  `COPY --from=builder /usr/local/bin/npm` step only copied the
  shebang wrapper (`#!/usr/local/bin/node\nrequire('../lib/...')`)
  without the npm package files it requires. The wrapper was
  broken from the moment it landed.
- Take the **entire /usr/local tree** from the builder stage
  (`COPY --from=builder /usr/local/ /usr/local/`) — this brings
  node + npm + npx + their modules in one shot, no relative
  require to break. hassio base's /usr/local is empty so the
  overlay is safe.
- Drop the v0.1.12 `npm install -g npm@10` step (no longer needed).

## 0.1.12 — 2026-06-13

### Fixed
- v0.1.11 got Node 24 working (libstdc++ bump landed) but
  `npm --version` then crashed with `MODULE_NOT_FOUND` — the
  COPY of `/usr/local/lib/node_modules` from the builder stage
  didn't actually carry npm's files (node:24-alpine's npm lives
  under a path buildx doesn't preserve across the multi-stage
  COPY). Reinstall npm globally in the runtime instead:
  `npm install -g npm@10` so the runtime is self-sufficient and
  we no longer depend on the builder's filesystem layout.

## 0.1.11 — 2026-06-13

### Fixed
- v0.1.10 build succeeded but the runtime failed with
  `Error relocating /usr/local/bin/node: _ZTVN10__cxxabiv1... symbol
  not found`. This is a C++ ABI mismatch — hassio base 16.3.2 is
  Alpine 3.24 with libstdc++ 13, but Node 24's binary expects
  symbols from a newer libstdc++ (v14+). Add `apk add libstdc++`
  in the runtime stage to pick up the newer one from Alpine's repo.
- (Side note from v0.1.10 investigation: `hassio-addons/base:16.3.2`
  is in fact Alpine-based, not Debian — so the original "musl vs
  glibc" hypothesis was wrong; this is purely a libstdc++ version
  gap.)

## 0.1.10 — 2026-06-13

### Fixed
- v0.1.8 and v0.1.9 builds both failed at the runtime stage: the
  Node 24 musl tarball URL we used
  (`nodejs.org/dist/v24.0.0/node-v24.0.0-linux-x64-musl.tar.xz`)
  returns 404. Node 24's dist directory no longer ships a
  linux-x64-musl variant — only the glibc `linux-x64.tar.xz`.
- Switched to **copying the Node 24 binary tree from the builder
  stage** (which is `FROM node:24-alpine` and thus has the musl build
  ready) into the runtime. Drop the tarball download entirely. We
  leave the hassio-installed /usr/bin/node (v20) in place; /usr/local/bin
  wins on PATH so the v24 binary takes over.
- Reverted the v0.1.9 `rm -f /usr/bin/node` since it's no longer needed
  and is a slightly risky thing to ship.

## 0.1.9 — 2026-06-13

### Fixed
- v0.1.8 still shipped a runtime with `node --version` reporting
  v20.15.1 — even though we overlaid Node 24 onto /usr/local/bin, the
  apk-installed `/usr/bin/node` from hassio base 16 wins on PATH
  (Alpine puts /usr/bin first by default). Now we explicitly
  `rm -f /usr/bin/node /usr/bin/npm /usr/bin/npx` after the tarball
  overlay so the new Node 24 is the only one on PATH.

## 0.1.8 — 2026-06-13

### Fixed
- v0.1.7's runtime stage was still on Node 20.15.1 — `n 24` failed
  silently (can't write to /usr/local/n on hassio's read-only rootfs),
  so the symlinks to /usr/local/bin/node pointed at nothing. web
  crashed with `SyntaxError: missing ) after argument list` and
  daemon crashed with `EADDRINUSE` from a previous run's orphan.
- Switch to installing Node 24 via the **official musl tarball** from
  nodejs.org, overlaid directly on `/usr/local`. No `n` indirection.
- Also removed a duplicate `COPY --from=builder` block that had crept
  in from earlier edits.

## 0.1.7 — 2026-06-13

### Fixed
- v0.1.6 builder stage failed: `pnpm install --prod` in /out/daemon
  had no lockfile (we only copied package.json). Replaced with
  `pnpm deploy --prod --legacy` (same approach as web) which produces
  a self-contained production tree with package.json + node_modules +
  dist already in place. dist/ is then overwritten with the freshly
  built copy (deploy's own dist is empty since tsc has no scripts key).

## 0.1.6 — 2026-06-13

### Fixed
- **daemon crashes with `ERR_MODULE_NOT_FOUND: 'cors'`** on first run.
  v0.1.5 (and earlier) only copied `dist/` + `package.json` into the
  runtime image, forgetting that tsc does not bundle dependencies.
  Dockerfile now runs `pnpm install --prod` against the copied
  package.json so daemon gets a production node_modules tree.
- **web crashes with `SyntaxError: missing ) after argument list` in
  `.bin/next`.** hassio base 16 ships Node 20.15.1 which mis-parses the
  pnpm 9/10 ESM bin shim. Dockerfile now upgrades the runtime to
  Node 24 (matches the builder stage) via `n 24`.

## 0.1.5 — 2026-06-13

### Fixed
- **The add-on banner hung for 3+ minutes on v0.1.4 because `run.sh` was
  never executed.** s6-overlay (hassio base 16) only runs scripts under
  `/etc/services.d/<name>/run` and `/etc/cont-init.d/<name>/` — it does
  not auto-pick up `/run.sh`. v0.1.4 added `tee /data/logs/run.log` but
  the script was never reached, so `/data/logs/` was never created and
  the user saw no log output at all.
- Dockerfile now symlinks `/run.sh` → `/etc/services.d/ha-ai-designer/run`
  so s6's `legacy-services` actually launches the entry point. Confirmed
  via `docker exec ps -ef` (only s6 processes running on v0.1.4).

## 0.1.4 — 2026-06-11

### Added
- `run.sh` now tees its stdout/stderr to `/data/logs/run.log` (and the
  background daemon/web to `daemon.log` / `web.log`), so when the add-on
  appears stuck on the banner the host operator can read the real
  startup log via `docker exec addon_* cat /data/logs/{run,daemon,web}.log`.
  Intended to make root-cause diagnosis possible without a privileged
  HA shell — but on its own it was not enough, see 0.1.5.

## 0.1.1 — 2026-06-10

### Fixed
- `run.sh` no longer exits the whole container when bashio::config returns
  empty (e.g. user hasn't filled `llm_api_key` yet). Previously the `set -e`
  + unset-option combo caused s6 to loop on "legacy-services stopping/stopped"
  with no clear error.
- `bashio::config` calls now pass explicit defaults so a freshly-installed
  add-on can start before the user fills in any options.
- Background daemon/web processes now run via `nohup` so the run.sh main
  process can still complete (and s6 sees a healthy service).

## 0.1.0 — 2026-06-06

### Added
- Initial HA Add-on packaging of the ha-ai-designer web + daemon stack.
- Two processes managed by the run.sh entry point:
  - `daemon` (Node, port 7456) — REST + WebSocket adapter to your HA,
    BYOK LLM client (OpenAI-compatible), preview/restore/backup store.
  - `web` (Next.js 14, port 3000) — design chat UI.
- Add-on options:
  - `log_level` — pino level (default `info`).
  - `ingress_port` — port supervisor proxies to the web UI (default 3000).
  - `data_dir` — where SQLite, backups, and logs go (default `/data`).
  - `llm_provider` / `llm_base_url` / `llm_model` / `llm_api_key` — BYOK LLM.
- `homeassistant_api: true` — daemon can read/write your HA via
  `http://supervisor/core/api` using the auto-injected `SUPERVISOR_TOKEN`
  on first boot, so you don't have to mint a long-lived access token.
- `ingress: true` — the tool is exposed under
  `https://<ha-host>/a0d7b954_ha_ai_designer`, so iframe embeds in
  HA lose their X-Frame-Options barrier and the cross-origin / token
  workarounds become unnecessary.
