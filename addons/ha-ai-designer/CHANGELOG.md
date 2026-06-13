# Changelog

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
