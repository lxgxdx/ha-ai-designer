# Changelog

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
