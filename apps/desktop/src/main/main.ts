/**
 * Electron main process — v0.5.0.
 *
 * Lifecycle:
 *   1. Wait for app.whenReady
 *   2. Spawn the daemon (`ha-ai-designer` CLI from `apps/daemon/bin/`)
 *      with HA_DATA_DIR pointed at `app.getPath('userData')`.
 *   3. Wait for daemon health endpoint (http://127.0.0.1:7456/api/health)
 *   4. Spawn the web (`next start` from `apps/web/`)
 *   5. Wait for web port to be listening
 *   6. Open BrowserWindow → http://127.0.0.1:3000
 *   7. On app quit, kill both child processes
 *
 * Why spawn the daemon ourselves (vs. letting the user start it):
 *   - Single process tree (Electron owns daemon + web lifecycle)
 *   - HA_DATA_DIR is set to OS userData (not project dir) for
 *     proper isolation per user
 *   - On crash, we can restart daemon without losing the window
 *   - HA_DAEMON_URL/HA_DAEMON_TOKEN plumbing is automatic
 *
 * Why spawn web too (vs. embedding Next.js static build):
 *   - Matches open-design's pattern (`od` spawns the local server)
 *   - Lets us reuse the dev workflow (next dev with HMR) when
 *     running desktop:dev
 *   - Web keeps the same /api/daemon/[...path] proxy semantics;
 *     the Electron window is just a thin wrapper
 *   - No "static export loses RSC streaming" trade-off
 *
 * The user closes the window → Electron quits → we SIGTERM the
 * children, wait briefly, then SIGKILL if they're still alive.
 *
 * Data layout on disk (Windows: %APPDATA%\ha-ai-designer):
 *   userData/
 *   ├── config.json          (HA + LLM + Embedding settings)
 *   ├── .daemon-token        (web↔daemon internal auth, mode 0600)
 *   ├── rag.db               (SQLite + sqlite-vec embeddings)
 *   ├── backups/lovelace/    (HA dashboard push backups)
 *   └── logs/
 *       ├── daemon.log
 *       └── web.log
 */
import { app, BrowserWindow, shell, dialog } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DAEMON_PORT = 7456;
const WEB_PORT = 3000;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

let daemonProc: ChildProcess | null = null;
let webProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

function repoRoot(): string {
  // apps/desktop/src/main/main.ts → repo root is ../../../..
  return resolve(__dirname, '..', '..', '..', '..');
}

function daemonBinPath(): string {
  // In dev (pnpm desktop:dev, before packaging), we invoke the
  // prebuilt dist/server.js directly via node — same as the
  // `ha-ai-designer` bin, but skipping the bin shim for speed.
  // In packaged app, the daemon is at resources/daemon/dist/...
  // (produced by `pnpm deploy --prod --legacy` and copied via
  // electron-builder's extraResources — see electron-builder.yml
  // and scripts/bundle-daemon.mjs for the full pipeline).
  if (app.isPackaged) {
    return join(process.resourcesPath, 'daemon', 'dist', 'server.js');
  }
  return join(repoRoot(), 'apps', 'daemon', 'dist', 'server.js');
}

function webNextBinPath(): string {
  // Same pattern as daemon: dev = repo apps/web/node_modules/next,
  // packaged = resources/web/node_modules/next (from pnpm deploy).
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'web',
      'node_modules',
      'next',
      'dist',
      'bin',
      'next',
    );
  }
  return join(
    repoRoot(),
    'apps',
    'web',
    'node_modules',
    'next',
    'dist',
    'bin',
    'next',
  );
}

function webDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'web');
  }
  return join(repoRoot(), 'apps', 'web');
}

function logFilePath(name: string): string {
  return join(app.getPath('logs'), name);
}

function pipeStreamToFile(
  stream: NodeJS.ReadableStream | null,
  file: string,
  prefix: string,
): void {
  if (!stream) return;
  const fd = openSync(file, 'a');
  stream.on('data', (chunk: Buffer) => {
    try {
      // Mirror to file. Errors here are non-fatal.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').writeSync(fd, chunk);
    } catch {
      /* ignore */
    }
    // Also log to Electron's stdout so the user sees it in the
    // dev terminal.
    process.stdout.write(`[${prefix}] ${chunk.toString()}`);
  });
  stream.on('end', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').closeSync(fd);
    } catch {
      /* ignore */
    }
  });
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy(new Error('timeout')));
      });
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${url}: ${String(lastErr)}`,
  );
}

function startDaemon(): ChildProcess {
  const bin = daemonBinPath();
  if (!existsSync(bin)) {
    throw new Error(
      `Daemon not found at ${bin}.\n` +
        `Run \`pnpm --filter @ha-designer/daemon build\` first.`,
    );
  }

  const env = {
    ...process.env,
    HA_DAEMON_PORT: String(DAEMON_PORT),
    HA_WEB_PORT: String(WEB_PORT),
    HA_DATA_DIR: app.getPath('userData'),
    HA_LOG_LEVEL: process.env.HA_LOG_LEVEL ?? 'info',
    HA_LOG_PRETTY: '0',
    NODE_ENV: 'production',
  };

  const proc = spawn(process.execPath, [bin], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  pipeStreamToFile(proc.stdout, logFilePath('daemon.log'), 'daemon');
  pipeStreamToFile(proc.stderr, logFilePath('daemon.log'), 'daemon');
  proc.on('exit', (code) => {
    console.log(`[daemon] exited with code ${code}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('daemon-exit', code);
    }
  });

  return proc;
}

function startWeb(): ChildProcOrNull {
  const nextBin = webNextBinPath();
  if (!existsSync(nextBin)) {
    throw new Error(
      `Next.js entry not found at ${nextBin}.\n` +
        `Run \`pnpm --filter @ha-designer/web build\` first.`,
    );
  }
  const wd = webDir();

  // The web process needs to know how to reach the daemon. We
  // pass HA_DAEMON_URL; the daemon-token is read by the web via
  // HA_DAEMON_TOKEN, but the daemon hasn't generated it yet at
  // this point. The web's first request will 401 and the user
  // will see a CSRF/login error — but the daemon mints the token
  // synchronously at startup, so a refresh picks it up.
  //
  // v0.5.0 TODO: have the daemon write the token BEFORE binding
  // the port, and the Electron main read it back and inject via
  // env. For now we accept the "refresh after a few seconds"
  // UX (the wizard's "test & save" retries are idempotent).
  const env = {
    ...process.env,
    HA_DAEMON_URL: DAEMON_URL,
    HA_DAEMON_PORT: String(DAEMON_PORT),
    HA_WEB_PORT: String(WEB_PORT),
    HA_DATA_DIR: app.getPath('userData'),
    PORT: String(WEB_PORT),
    NODE_ENV: 'production',
  };

  const proc = spawn(process.execPath, [nextBin, 'start', '-p', String(WEB_PORT)], {
    cwd: wd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  pipeStreamToFile(proc.stdout, logFilePath('web.log'), 'web');
  pipeStreamToFile(proc.stderr, logFilePath('web.log'), 'web');
  proc.on('exit', (code) => {
    console.log(`[web] exited with code ${code}`);
  });

  return proc;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'HA AI Designer',
    backgroundColor: '#0b1220',
    show: false, // Don't flash blank window; show after ready-to-show
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // v0.5.0: show window when the page has finished loading. The
  // wizard's gate (page.tsx redirects to /setup if config is
  // missing) handles the first-run UX.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // External links open in the OS browser, not inside Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  await mainWindow.loadURL(WEB_URL);
}

function killChild(proc: ChildProcess | null, name: string): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      console.log(`[${name}] SIGKILL after 3s grace`);
      resolve();
    }, 3000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function shutdown(): Promise<void> {
  await killChild(webProc, 'web');
  await killChild(daemonProc, 'daemon');
}

app.whenReady().then(async () => {
  try {
    console.log(`[main] data dir: ${app.getPath('userData')}`);
    console.log(`[main] logs dir: ${app.getPath('logs')}`);

    // 1. Start daemon, wait for /api/health
    console.log('[main] starting daemon…');
    daemonProc = startDaemon();
    await waitForUrl(`${DAEMON_URL}/api/health`, 30_000);
    console.log('[main] daemon healthy');

    // 2. Start web, wait for the port
    console.log('[main] starting web…');
    webProc = startWeb();
    await waitForUrl(`${WEB_URL}/`, 30_000);
    console.log('[main] web ready');

    // 3. Open window
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (e) {
    console.error('[main] startup failed:', e);
    dialog.showErrorBox(
      'HA AI Designer failed to start',
      `Could not start the local services:\n\n${(e as Error).message}\n\n` +
        `Try \`pnpm tools-dev run web\` from a terminal to see detailed logs.`,
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Standard macOS behavior is to keep the app alive; we always quit
  // because our window IS the app (no menu bar background usage).
  void shutdown().then(() => app.quit());
});

app.on('before-quit', () => {
  void shutdown();
});

// Hard safety net: if Electron itself crashes, kill the children.
process.on('exit', () => {
  try {
    daemonProc?.kill('SIGKILL');
    webProc?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
});

// Dummy type alias for the JSDoc above (avoids an extra import)
type ChildProcOrNull = ChildProcess | null;
