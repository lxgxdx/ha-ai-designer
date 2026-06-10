# HA AI Designer — Add-on

Local-first AI designer for Home Assistant Lovelace dashboards.
Packaged as a **HA Add-on** so you can install it next to HACS / File
Editor / Terminal — and the supervisor handles ingress, persistence, and
auth.

![Architecture overview](icon.png)

## What this gives you

- A **chat UI** in the HA sidebar (`AI Designer` panel) where you
  describe your dashboard in natural language.
- The tool reads your live HA entities, generates a LovelaceConfig YAML,
  and pushes it to your `lovelace` dashboard.
- Every push is **backed up first**; one click reverts to any previous
  version.
- All LLM calls go through your own API key (BYOK) — the tool never
  sees your entity data.

## Why an Add-on, not just `pnpm tools-dev run web`?

| Concern | Local dev | Add-on |
|---|---|---|
| Cross-origin (tool on `127.0.0.1`, HA on `192.168.x.x`) | you deal with it | supervisor proxies — same origin |
| `X-Frame-Options: SAMEORIGIN` | iframe refuses | moot (you're inside HA now) |
| HA long-lived token | you copy-paste | supervisor injects `SUPERVISOR_TOKEN` |
| Process lifecycle | you `tools-dev start/stop` | supervisor restarts on crash |
| Backups | on your laptop | in HA `/addons/<slug>/data` |

## Install (from local source — the path you'll use first)

> **Prerequisite**: a HA Add-on must be built into a Docker image first.
> Your local Windows machine may not have Docker installed — see
> [Building the image](#building-the-image) below.

1. **Build the image** (one-time). Either:
   - On a Linux/WSL2/Docker Desktop machine:
     ```bash
     docker buildx build \
       --tag ghcr.io/YOUR_GITHUB/ha-ai-designer:0.1.0 \
       --platform linux/amd64 \
       --load \
       --file addons/ha-ai-designer/Dockerfile \
       .
     ```
   - Or push the source to GitHub and let GitHub Actions build it
     automatically (see `.github/workflows/addon.yml` for the workflow).

2. **Add the add-on repository to your HA**:
   - In HA, go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
   - Add the GitHub repo URL (e.g. `https://github.com/YOUR_ORG/ha-ai-designer`).
   - HA will index any `*-<name>/config.yaml` it finds at the repo root
     under `addons/`. (You can also pin a specific tag: `.../tree/v0.1.0`.)

3. **Install**:
   - Refresh the Add-on Store; you'll see **HA AI Designer** listed.
   - Click it, then **Install**. The image is ~250 MB and pulls in
     `node:24-alpine` + the web bundle.

4. **Configure** (the Options tab):
   - **`llm_provider`**: pick your provider (default `minimax`).
   - **`llm_base_url`**: e.g. `https://api.minimaxi.com/v1`.
   - **`llm_model`**: e.g. `MiniMax-Text-01`.
   - **`llm_api_key`**: paste your key. Stored in the addon's `/data`
     with mode `0600`; never logged.
   - **`log_level`**: `info` is fine; `debug` to see WebSocket frames.
   - **`ingress_port`**: keep `3000` unless you're running multiple add-ons
     inside the same HA.

5. **Start** the add-on. Check the **Log** tab — you should see:
   ```
   [INFO] HA AI Designer add-on starting...
   [INFO] Persisting LLM config to /data/config.json
   [INFO] First-boot: probing HA via supervisor token…
   [INFO] Starting daemon on port 7456…
   [INFO] Starting web UI on port 3000…
   [INFO] Tailing logs…
   ```

6. **Open the UI**: in the HA sidebar, click **AI Designer** (the panel
   icon is the supervisor proxy to `http://<addon>:3000`).

## Using the tool

1. Type a brief, e.g. `做一个全屋概览，深蓝主题，控灯光为主。简洁、信息密度高。`
2. Click **生成 dashboard 草稿**. ~30–60 s.
3. The YAML appears, plus a list of warnings (e.g. entity IDs the LLM
   invented that don't exist on your HA).
4. Optional: edit intent, click **⚠ 确认推送到我的 HA**.
5. The tool backs up your current `lovelace` config, pushes the new one,
   and links you to a new tab in HA showing the result.
6. To revert: scroll down to **历史备份**, fill in an intent, click
   `↶ 恢复此备份`.

## Security model

- All pushes to your HA require `__confirmed_by_user: true` in the API
  body. The UI's red button is the only path that sends this.
- Every push and restore is logged with an `intent` string, visible in
  the add-on **Log** tab.
- The backup store is `/data/backups/lovelace/*.json`, mode `0600`.
- The LLM API key is in `/data/config.json`, mode `0600`, and is
  masked in any HTTP response (only first-4 + last-4 are ever shown).
- The add-on uses `homeassistant_api: true` so the daemon can read /
  write your HA via the supervisor proxy — no user-minted long-lived
  token is required.

## Building the image

### Option A — Docker on the same machine (Linux, WSL2, Docker Desktop)

```bash
git clone https://github.com/YOUR_ORG/ha-ai-designer.git
cd ha-ai-designer
docker buildx build \
  --tag ghcr.io/YOUR_ORG/ha-ai-designer:0.1.0 \
  --platform linux/amd64,linux/aarch64 \
  --file addons/ha-ai-designer/Dockerfile \
  --push \
  .
```

### Option B — GitHub Actions (no local Docker required)

A typical workflow (`.github/workflows/addon.yml`) on every push to
`main` or every tag:

```yaml
name: Build add-on
on:
  push:
    tags: ['v*']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build & push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: addons/ha-ai-designer/Dockerfile
          platforms: linux/amd64,linux/aarch64
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
```

## Where the data lives

Inside the HA Add-on container, the data dir is mounted at `/data`:

```
/data/
├── config.json                    HA token + LLM key (mode 0600)
├── backups/lovelace/              <sessionId>.json snapshots
├── logs/daemon.log
├── logs/web.log
└── .pid.{daemon,web}              (transient)
```

To grab a backup file: in HA, **Settings → Add-ons → HA AI Designer →
⋮ → Open Web UI** (terminal-style), or `cat /data/backups/lovelace/<id>.json`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Add-on won't start, log says `data/config.json missing ha.baseUrl or ha.token` | First boot, no SUPERVISOR_TOKEN env (e.g. running on a non-HAOS HA) | Paste a long-lived token in **Options → advanced**, or confirm supervisor is healthy |
| `LLM 401 Unauthorized` in the log | Wrong API key / model | Double-check `llm_api_key` and `llm_model` in the add-on options |
| `LOVELACE /api/lovelace/config 404` (in older HA) | HA < 2024.2 | Upgrade HA; or manually open `/lovelace/0` once to "Take Control" and retry |
| Push succeeds but no change in browser | Cached dashboard | Hard-refresh (Ctrl-Shift-R) in the HA tab |
| Tool shows "X-Frame-Options: SAMEORIGIN" | Your browser's *sees* the tool — X-Frame-Options is irrelevant when you're inside HA via ingress |
| Generated YAML uses card types that don't render | The LLM invented a type name | The tool's hard-coded whitelist in `skills/home-overview-dashboard/SKILL.md` covers this; the warnings will list any violations |

## License

Apache-2.0.
