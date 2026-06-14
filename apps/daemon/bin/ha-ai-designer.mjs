#!/usr/bin/env node
/**
 * ha-ai-designer — daemon CLI entry (v0.5.0).
 *
 * This is a thin launcher. It re-execs the compiled `dist/server.js`
 * (TypeScript output) with the same argv + env. The actual daemon
 * logic lives in `src/server.ts`; this bin just gives us a stable
 * command name (`ha-ai-designer`) that Electron, the desktop
 * shortcut, and the Windows shell can all invoke.
 *
 * Why a launcher and not the server itself?
 *   - `dist/server.js` is the build artifact; the path is stable
 *     but rebuilding moves it. The bin provides a fixed name.
 *   - Spawning a child process lets the bin outlive the daemon
 *     (e.g., wrap with restarts), without changing the daemon
 *     code. For v0.5.0 we just forward exit codes.
 *   - pnpm `bin` field needs a real file with a shebang for
 *     global-install to wire it on PATH. The launcher is that
 *     file.
 *
 * v0.5.0 launch contexts:
 *   1. `pnpm tools-dev run web` — uses `tsx watch` directly, this
 *      bin is unused. Devs edit TS, see hot reload.
 *   2. Electron main process (`apps/desktop/src/main/main.ts`) —
 *      spawns `ha-ai-designer` as a child process with HA_DATA_DIR
 *      pointed at `app.getPath('userData')`.
 *   3. Direct CLI: `ha-ai-designer` (after `npm i -g` or via
 *      `pnpm dlx`). For users who want to run the daemon without
 *      the Electron window.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// bin/ is at apps/daemon/bin/, so dist/ is at apps/daemon/dist/
const distServer = join(__dirname, '..', 'dist', 'server.js');

if (!existsSync(distServer)) {
  console.error(
    `[ha-ai-designer] dist/server.js not found at ${distServer}\n` +
      `              Run \`pnpm --filter @ha-designer/daemon build\` first.`,
  );
  process.exit(1);
}

// Re-exec the compiled server with the user's argv. We use
// process.execPath (the same Node binary) so the child inherits
// the runtime. stdio: 'inherit' so logs flow to the parent's
// terminal / Electron's log capture.
const child = spawn(process.execPath, [distServer, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    // Killed by signal — exit with the conventional 128+signum code.
    const signum = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal];
    process.exit(signum ? 128 + signum : 1);
  }
  process.exit(code ?? 0);
});

// Forward SIGINT/SIGTERM so Ctrl-C kills the child too.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
