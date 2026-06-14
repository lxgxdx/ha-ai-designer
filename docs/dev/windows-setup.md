# Windows Development Setup (v0.5.0+)

> **Most users can skip this** — the pre-built `ha-ai-designer-Setup-x.y.z.exe` from the GitHub Releases page bundles everything (Electron binary, daemon dist, web build, all node_modules). Double-click to install; no compiler needed.
>
> This doc is for **developers** who want to run `pnpm install` and `pnpm desktop:dev` on Windows.

## TL;DR

```bash
# 1. Install Node 22 LTS (NOT 20 or 24 — see "Why Node 22" below)
winget install OpenJS.NodeJS.22

# 2. Install pnpm
npm install -g pnpm@10.33.2

# 3. (no Visual Studio needed if you stick to Node 22)
#    better-sqlite3 11 has prebuilt win32-x64 binaries for Node 22.

# 4. Then:
git clone https://github.com/lxgxdx/ha-ai-designer.git
cd ha-ai-designer
pnpm install
pnpm --filter @ha-designer/daemon build
pnpm --filter @ha-designer/web build
pnpm desktop:dev
```

## Why Node 22 (not 20, not 24)?

The daemon uses `better-sqlite3@11` for the RAG vector store (sqlite-vec). On Windows, the prebuilt binaries cover **Node 18-22** (x64, arm64). Node 24 is bleeding-edge — better-sqlite3 11.10.0 doesn't ship a Node 24 prebuild for win32, and node-gyp falls through to a source build that fails on `windows-latest` GitHub runners (they have VS 2026 / "v18" which node-gyp 11.5.0 doesn't recognize).

**Electron 35+ ships with Node 22.15.0**, so the .node binary we build for Node 22 is ABI-compatible with the runtime. No mismatch.

## The "I don't want to install anything but the .exe" alternative

If you just want to USE the app, download the pre-built installer:

1. Go to [Releases](https://github.com/lxgxdx/ha-ai-designer/releases)
2. Download `ha-ai-designer-Setup-0.5.0.exe`
3. Double-click, Next-Next-Finish
4. Launch from Start menu

The installer bundles:
- Electron 35 prebuilt (Node 22.15 runtime)
- Compiled `dist/server.js` (better-sqlite3 .node binary for win32-x64)
- Next.js `.next/` build + node_modules
- Everything else

You never need `pnpm install` on your machine.

## Common Windows dev gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `prebuild-install warn No prebuilt binaries found` then `gyp ERR! find VS` | Wrong Node version (24+) | Downgrade to Node 22 LTS |
| `gyp ERR! find VS could not find a version of Visual Studio 2017 or newer` | VS version too new for node-gyp 11.5.0 | Either: (a) downgrade Node to 22 so prebuild wins, or (b) install VS 2022 Build Tools (5GB) |
| `error MSB8036: Could not find WindowsSDKDir` | Old Windows 10 SDK | In VS Installer → Modify → "Windows 11 SDK" |
| `EACCES: permission denied, unlink '...node_modules\...'` | Another process holds a file handle | Close VS Code / Docker / antivirus; retry |
| `gyp ERR! find VS msvs_version not set` | No VS detected | Set `npm config set msvs_version 2022` |
| `node-gyp` hangs at "Looking for Python" | No Python 3 on PATH | `winget install Python.Python.3.12` |
| `corepack enable` EPERM on Windows 11 | corepack permissions bug | Use `npm install -g pnpm@10.33.2` instead |

## Linux / macOS dev

Easier. Just `pnpm install` works out of the box on both:
- Linux: prebuilt `node-gyp` comes with `build-essential`
- macOS: prebuilt `node-gyp` comes with Xcode Command Line Tools (`xcode-select --install`)

## Why we keep Node 22 pinned (not jumping to 24)

- better-sqlite3 11.x prebuilts: Node 18-22 (Node 23+ not yet covered)
- Electron 35-36 ship Node 22 (Electron 37+ plans to switch to Node 24; not stable yet)
- Node 22 is an active LTS until October 2026

Once Electron 37 stabilizes on Node 24, AND better-sqlite3 ships Node 24 prebuilts, we can revisit. Until then, Node 22 is the sweet spot.
