/**
 * Read the daemon's internal auth token. Two sources, in order:
 *   1. `HA_DAEMON_TOKEN` env var (preferred — set explicitly by the
 *      launcher in packaged Electron mode, where Electron main reads
 *      the token from disk and injects it via env before spawning
 *      the web subprocess).
 *   2. `${HA_DATA_DIR}/.daemon-token` file (fallback — for dev mode
 *      where `pnpm tools-dev run web` spawns daemon and web in
 *      parallel and doesn't coordinate token handoff via env. Also
 *      catches the case where the packaged mode env injection
 *      silently failed.)
 *
 * The token is cached in memory for 5s to amortize the file read.
 * On cache miss, we re-read; this lets us pick up a freshly
 * minted token if the daemon restarted and rotated the secret.
 *
 * Returns an empty string if neither source is available. Callers
 * should treat empty as "not configured yet" and let the first
 * daemon request 401 — Next.js's auto-retry on the second request
 * will pick up the token after daemon has had a moment to write it.
 *
 * The `getInternalToken` function (not const) is intentional: the
 * Next.js dev server HMRs modules, but the function form also lets
 * a serverless / route handler lazily resolve on each invocation
 * without re-importing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_TTL_MS = 5_000;

let cachedToken: string | null = null;
let cachedAt = 0;

export function getInternalToken(): string {
  // Fast path: env was injected by the launcher.
  const fromEnv = process.env.HA_DAEMON_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  // Cache check.
  const now = Date.now();
  if (cachedToken !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedToken;
  }

  // Slow path: read from the daemon's token file. The path matches
  // the daemon's internal-auth.ts `TOKEN_FILENAME` ('.daemon-token')
  // sitting at the root of `HA_DATA_DIR`.
  const dataDir = process.env.HA_DATA_DIR;
  if (dataDir) {
    const tokenPath = join(dataDir, '.daemon-token');
    if (existsSync(tokenPath)) {
      try {
        const t = readFileSync(tokenPath, 'utf8').trim();
        if (t.length >= 32) {
          cachedToken = t;
          cachedAt = now;
          return t;
        }
      } catch {
        // fall through
      }
    }
  }

  // No source available. Keep the previous cached value if any so
  // a transient read error doesn't lose the token.
  return cachedToken ?? '';
}
