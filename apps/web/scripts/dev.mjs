#!/usr/bin/env node
/**
 * Web dev wrapper — resolves HA_WEB_PORT (or PORT) and spawns `next dev` with
 * the right --port flag.
 *
 * Why this exists: cross-platform. The pnpm `scripts` field doesn't expand
 * POSIX-style ${VAR:-default} on Windows, and using a Node script keeps
 * the port-resolution logic out of the package.json script string.
 */

import { spawn } from 'node:child_process';

const port = process.env.HA_WEB_PORT ?? process.env.PORT ?? '3000';

const child = spawn('next', ['dev', '--port', port], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  windowsHide: true,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
