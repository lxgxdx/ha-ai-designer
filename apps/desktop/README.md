# apps/desktop — Electron shell for HA AI Designer (v0.5.0+)

This is the **recommended** way to run HA AI Designer as of v0.5.0. The Electron shell spawns the daemon + web as child processes and opens a BrowserWindow. The HA add-on path is now in maintenance mode (see `addons/ha-ai-designer/DEPRECATED.md`).

## Quick start

```bash
# Terminal 1: build & start daemon + web
pnpm install
pnpm --filter @ha-designer/daemon build
pnpm --filter @ha-designer/web build
pnpm tools-dev run web
# daemon on 7456, web on 3000

# Terminal 2: build & launch the Electron shell
pnpm desktop:build
pnpm desktop:dev
# A window opens, loads http://127.0.0.1:3000
```

## Build a Windows .exe

```bash
pnpm desktop:package
# Output: apps/desktop/dist/HA AI Designer-Setup-0.5.0-alpha.1.exe
# (NSIS installer, per-user, no admin required)
```

The installer creates:
- `HA AI Designer.exe` shortcut on Desktop and Start Menu
- Per-user install under `%LOCALAPPDATA%\Programs\HA AI Designer\`
- Data dir: `%APPDATA%\ha-ai-designer\` (config.json, rag.db, backups, logs)

## Architecture

```
┌──────────────────────────── Electron Main (this) ─────────────────────────────┐
│                                                                              │
│   1. spawn(daemon)   ─→  dist/server.js (in resources/daemon/)                │
│      wait http://127.0.0.1:7456/api/health                                   │
│                                                                              │
│   2. spawn(web)      ─→  next start -p 3000 (in resources/web/)                │
│      wait http://127.0.0.1:3000                                             │
│                                                                              │
│   3. createWindow()  ─→  BrowserWindow → loadURL(WEB_URL)                      │
│      (contextIsolation: true, sandbox: true, no nodeIntegration)             │
│                                                                              │
│   4. on('window-all-closed')  ─→  SIGTERM daemon + web, then app.quit()       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

The web's `next.config.mjs` `assetPrefix` is **empty** in this build (we don't go through HA ingress anymore). The web's `app.getPath('userData')` becomes the new `${HA_DATA_DIR}` (no `/data` from the add-on world).

## Why a separate app, not just `pnpm tools-dev run web`?

| | `tools-dev run web` | `desktop:dev` / .exe |
|---|---|---|
| User experience | Open browser to localhost:3000 | Native window with icon in taskbar |
| Auto-start on boot | No | Yes (post-v0.5 with NSIS startup shortcut) |
| Single instance lock | No | Yes (post-v0.5) |
| Installer | No | NSIS .exe (per-user, no admin) |
| Discoverability | Bad (hidden terminal) | Good (Start menu, Desktop) |
| Code signing | N/A | Post-v0.5 (Windows SmartScreen) |

For **development**, `tools-dev run web` is faster (no Electron overhead, no rebuild cycle). For **distribution** to non-technical users, the .exe is the right answer.

## File layout

```
apps/desktop/
├── package.json           electron + electron-builder deps
├── tsconfig.json          extends ../../tsconfig.base.json
├── electron-builder.yml   Windows NSIS / macOS DMG / Linux AppImage
├── scripts/
│   ├── dev.mjs            pnpm desktop:dev  (tsc + spawn electron)
│   └── build.mjs          pnpm desktop:build (tsc only)
├── src/
│   ├── main/main.ts       Electron main process
│   └── preload/preload.ts contextBridge API surface
└── dist/                  tsc output (gitignored)
    ├── main/main.js
    └── preload/preload.js
```

## Known limitations (v0.5.0-alpha)

- No code signing — Windows SmartScreen will warn on first install
- No auto-update — users re-download installer for new versions
- No single-instance lock — opening twice spawns two daemons (port collision prevents it but the second window is just an error dialog)
- macOS / Linux builds not yet CI-tested

These are all follow-ups for v0.6.x. The core flow (open window → load wizard → chat → push HA) works today.
