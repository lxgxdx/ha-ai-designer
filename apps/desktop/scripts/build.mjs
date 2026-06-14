#!/usr/bin/env node
/**
 * pnpm desktop:build — tsc the main + preload, leave the
 * actual packaging to `pnpm desktop:package` (which calls
 * electron-builder). We split them so the dev iteration loop
 * is fast (just tsc, no electron-builder overhead).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, '..');

const tsc = spawn(
  process.execPath,
  [join(desktopDir, 'node_modules', 'typescript', 'bin', 'tsc')],
  { cwd: desktopDir, stdio: 'inherit' },
);

tsc.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[build] tsc failed with code ${code}`);
    process.exit(code ?? 1);
  }
  console.log('[build] OK. Next: `pnpm desktop:package` to make the .exe');
});
