/**
 * Preview session — push a generated LovelaceConfig to the user's HA,
 * and back up the previous one so they can revert with one click.
 *
 * v0.5 design: we always target the default `lovelace` dashboard because
 * that is the only one `lovelace/config/save` can write. Before pushing
 * we snapshot the current config to data/backups/lovelace/<timestamp>.json
 * so the UI can offer a "revert" button without needing HA history.
 *
 * If the user later wants a sandboxed preview (a separate dashboard
 * that doesn't touch `lovelace`), v0.5b can add that via
 * `lovelace/dashboards/create` (requires admin).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { haWsRequest } from './ha-ws-client.js';
import type { LovelaceConfig } from '@ha-designer/contracts';
import { logger } from './logger.js';

export interface PreviewSession {
  sessionId: string;
  urlPath: string;
  previewUrl: string;
  backupPath: string; // absolute path to the snapshot file
  hasBackup: boolean;
  createdAt: string;
}

const URL_PATH = 'lovelace';

function backupDir(): string {
  const base = resolve(process.env.HA_DATA_DIR ?? './data');
  return join(base, 'backups', 'lovelace');
}

function ensureBackupDir(): void {
  mkdirSync(backupDir(), { recursive: true });
}

function tsSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

/**
 * Snapshot the current lovelace config to data/backups/lovelace/<ts>.json
 * and then push the new config via WebSocket.
 */
export async function createPreviewSession(
  config: LovelaceConfig,
): Promise<PreviewSession> {
  ensureBackupDir();
  const sessionId = tsSlug();
  const backupPath = join(backupDir(), `${sessionId}.json`);

  // 1. Try to back up the existing config (best-effort)
  let hasBackup = false;
  try {
    const current = await haWsRequest<LovelaceConfig>(
      'lovelace/config',
      {},
      'snapshot existing lovelace config',
    );
    if (current && typeof current === 'object') {
      writeFileSync(
        backupPath,
        JSON.stringify(current, null, 2),
        { encoding: 'utf8' },
      );
      hasBackup = true;
      logger.info({ backupPath, bytes: JSON.stringify(current).length }, 'backup taken');
    } else {
      logger.warn('current lovelace config is null/empty; skipping backup');
    }
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      'failed to snapshot current config — proceeding without backup',
    );
  }

  // 2. Push the new config
  logger.info(
    { urlPath: URL_PATH, cards: countCards(config) },
    '→ HA preview push — user has approved',
  );
  const result = await haWsRequest<unknown>(
    'lovelace/config/save',
    { config },
    `preview session ${sessionId} → push to ${URL_PATH}`,
  );
  logger.info(
    { result: typeof result === 'object' ? Object.keys(result ?? {}) : result },
    '← HA preview push ok',
  );

  return {
    sessionId,
    urlPath: URL_PATH,
    previewUrl: `/lovelace/${URL_PATH}`,
    backupPath,
    hasBackup,
    createdAt: new Date().toISOString(),
  };
}

export function listBackups(): Array<{ sessionId: string; backupPath: string; sizeBytes: number; createdAt: string }> {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  const fs = require('node:fs') as typeof import('node:fs');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files
    .map((f) => {
      const p = join(dir, f);
      const stat = fs.statSync(p);
      return {
        sessionId: f.replace(/\.json$/, ''),
        backupPath: p,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Restore a backup — push the snapshot back to the user's lovelace.
 * Used by the "revert" button.
 *
 * The backup file is expected to contain a LovelaceConfig directly. If
 * it has the old wrapped format `{urlPath, mode, yaml, config: {...}}`
 * (from before v0.5e), we unwrap it on the way out — so legacy backups
 * still work, but new backups store the bare config.
 */
export async function restoreBackup(sessionId: string): Promise<LovelaceConfig> {
  const p = join(backupDir(), `${sessionId}.json`);
  if (!existsSync(p)) {
    throw new Error(`Backup not found: ${p}`);
  }
  const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
  // Normalize: legacy wrapped backups have a nested `config` field.
  const config: LovelaceConfig =
    raw && typeof raw === 'object' && 'config' in (raw as Record<string, unknown>) &&
    (raw as { config?: unknown }).config &&
    typeof (raw as { config: unknown }).config === 'object'
      ? ((raw as { config: LovelaceConfig }).config)
      : (raw as LovelaceConfig);
  logger.info(
    { sessionId, bytes: JSON.stringify(config).length, unwrapped: raw !== config },
    '→ HA revert — restoring backup',
  );
  await haWsRequest<unknown>(
    'lovelace/config/save',
    { config },
    `revert session ${sessionId} → push to ${URL_PATH}`,
  );
  return config;
}

function countCards(config: LovelaceConfig): number {
  let n = 0;
  walk(config, (card) => {
    if (typeof (card as { type?: unknown }).type === 'string') n++;
  });
  return n;
}

function walk(node: unknown, visit: (c: unknown) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) walk(x, visit);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === 'string') visit(obj);
  for (const k of ['cards', 'sections', 'views', 'entities', 'badges']) {
    if (obj[k] !== undefined) walk(obj[k], visit);
  }
}
