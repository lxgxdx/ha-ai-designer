# Changelog

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
