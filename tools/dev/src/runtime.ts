/**
 * Runtime state on disk.
 *
 * Layout (gitignored):
 *   data/
 *     .runtime.json              # { namespace, daemonPort, webPort, pids, startedAt }
 *     .pids/<ns>/daemon.pid
 *     .pids/<ns>/web.pid
 *     logs/<ns>/daemon.log
 *     logs/<ns>/web.log
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root — tools/dev lives two levels below it. */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export const DATA_DIR = process.env.HA_DATA_DIR
  ? resolve(process.env.HA_DATA_DIR)
  : join(REPO_ROOT, 'data');

export const RUNTIME_FILE = join(DATA_DIR, '.runtime.json');
export const PIDS_DIR = join(DATA_DIR, '.pids');
export const LOGS_DIR = join(DATA_DIR, 'logs');

export function ensureDirs(namespace: string): void {
  for (const dir of [
    DATA_DIR,
    PIDS_DIR,
    join(PIDS_DIR, namespace),
    LOGS_DIR,
    join(LOGS_DIR, namespace),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

export interface RuntimeState {
  namespace: string;
  daemonPort: number;
  webPort: number;
  daemonPid?: number;
  webPid?: number;
  startedAt: string;
}

export function readState(): RuntimeState | null {
  if (!existsSync(RUNTIME_FILE)) return null;
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeState;
  } catch {
    return null;
  }
}

export function writeState(state: RuntimeState): void {
  ensureDirs(state.namespace);
  writeFileSync(RUNTIME_FILE, JSON.stringify(state, null, 2));
}

export function clearState(): void {
  if (existsSync(RUNTIME_FILE)) {
    writeFileSync(RUNTIME_FILE, '{}');
  }
}
