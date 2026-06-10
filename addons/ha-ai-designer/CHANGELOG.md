# Changelog

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
