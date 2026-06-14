#!/usr/bin/env node
/**
 * pnpm desktop:dev — build the Electron main + preload, then
 * spawn Electron pointing at them. We don't watch files; the
 * web dev server (which `pnpm tools-dev run web` already starts
 * in a separate terminal) handles HMR. The Electron rebuilds
 * are fast enough that you Ctrl-C + rerun when changing main.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, '..');

console.log('[dev] compiling main + preload…');
const tsc = spawn(
  process.execPath,
  [join(desktopDir, 'node_modules', 'typescript', 'bin', 'tsc')],
  { cwd: desktopDir, stdio: 'inherit' },
);

tsc.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[dev] tsc failed with code ${code}`);
    process.exit(code ?? 1);
  }
  console.log('[dev] launching Electron…');
  const electron = spawn(
    process.execPath,
    [join(desktopDir, 'node_modules', 'electron', 'cli.js'), '.'],
    {
      cwd: desktopDir,
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_DEV: '1' },
    },
  );
  electron.on('exit', (ec) => process.exit(ec ?? 0));
});
