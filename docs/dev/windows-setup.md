# Windows Development Setup (v0.5.0+)

> **Most users can skip this** — the pre-built `ha-ai-designer-Setup-x.y.z.exe` from the GitHub Releases page bundles everything (Electron binary, daemon dist, web build, all node_modules). Double-click to install; no compiler needed.
>
> This doc is for **developers** who want to run `pnpm install` and `pnpm desktop:dev` on Windows.

## TL;DR

```bash
# 1. Install Node 24 LTS (NOT 20 — better-sqlite3 prebuilds differ)
winget install OpenJS.NodeJS.LTS

# 2. Install pnpm
npm install -g pnpm@10.33.2

# 3. Install Visual Studio Build Tools 2022 (C++ workload)
#    This is the ONLY big download (~5GB) — needed to compile
#    better-sqlite3 from source on Windows. Get the "Build Tools
#    for Visual Studio" installer from
#    https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
#    and check "Desktop development with C++".

# 4. Then:
git clone https://github.com/lxgxdx/ha-ai-designer.git
cd ha-ai-designer
pnpm install
pnpm --filter @ha-designer/daemon build
pnpm --filter @ha-designer/web build
pnpm desktop:dev
```

## Why Visual Studio Build Tools?

The daemon uses `better-sqlite3@11` for the RAG vector store (sqlite-vec). On Windows, the prebuilt binaries cover Node 18-22 (x64, arm64). We're on **Node 24**, so `prebuild-install` can't find a match and falls through to `node-gyp rebuild --release`, which needs MSVC's `cl.exe` and the Windows SDK.

`npm install -g windows-build-tools` (the old way) is **deprecated** and doesn't work on Windows 11 / Node 24.

## The "I don't want to install VS Build Tools" alternative

If you just want to USE the app, download the pre-built installer:

1. Go to [Releases](https://github.com/lxgxdx/ha-ai-designer/releases)
2. Download `ha-ai-designer-Setup-0.5.0-alpha.1.exe`
3. Double-click, Next-Next-Finish
4. Launch from Start menu

The installer bundles:
- Electron 33 prebuilt (no Node version mismatch)
- Compiled `dist/server.js` (no better-sqlite3 compile needed)
- Next.js `.next/` build + node_modules
- Everything else

You never need `pnpm install` on your machine.

## Common Windows dev gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm install` hangs forever on `better-sqlite3 install` | No MSVC | Install VS Build Tools (see above) |
| `error MSB8036: Could not find WindowsSDKDir` | Old Windows 10 SDK | In VS Installer → Modify → "Windows 11 SDK" |
| `EACCES: permission denied, unlink '...node_modules\...'` | Another process holds a file handle | Close VS Code / Docker / antivirus; retry |
| `gyp ERR! find VS msvs_version not set` | No VS detected | Set `npm config set msvs_version 2022` |
| `node-gyp` hangs at "Looking for Python" | No Python 3 on PATH | `winget install Python.Python.3.12` |
| `corepack enable` EPERM on Windows 11 | corepack permissions bug | Use `npm install -g pnpm@10.33.2` instead |

## Linux / macOS dev

Easier. Just `pnpm install` works out of the box on both:
- Linux: prebuilt `node-gyp` comes with `build-essential`
- macOS: prebuilt `node-gyp` comes with Xcode Command Line Tools (`xcode-select --install`)

## Why is this only a Windows problem?

Both the daemon's better-sqlite3 AND electron-builder are prebuilt for Linux x64 + macOS x64/arm64. Only Windows loses the prebuild match for Node 24 (better-sqlite3 ships Node 22 prebuilds for win32, but we're on 24).

**Workaround we're considering for v0.5.x**: switch to Node 22 to match better-sqlite3's prebuild matrix. Tradeoff: lose Node 24 features (some perf improvements, new APIs). Not in v0.5.0-alpha.1 — revisit in v0.6.0 if Windows dev pain continues.
