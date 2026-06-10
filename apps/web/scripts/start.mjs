#!/usr/bin/env node
/**
 * Web start wrapper — same port resolution as dev.mjs, used by `pnpm start`.
 */

import { spawn } from 'node:child_process';

const port = process.env.HA_WEB_PORT ?? process.env.PORT ?? '3000';

const child = spawn('next', ['start', '--port', port], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  windowsHide: true,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
