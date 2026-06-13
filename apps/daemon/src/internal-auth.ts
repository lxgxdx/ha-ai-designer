/**
 * Internal auth — web↔daemon token + loopback-only guard.
 *
 * v0.1.22: the daemon now requires every HTTP request to carry
 *   X-Addon-Internal-Token: <token>
 * in a header. The token is a 256-bit random secret generated on
 * first start and persisted to ${HA_DATA_DIR}/.daemon-token (mode 0600).
 *
 * The same token is passed to the web process via HA_DAEMON_TOKEN env
 * (set in run.sh) so server-side fetches from Next.js can include it.
 *
 * Two layers of defense:
 *   1. Host check — refuse requests where the Host header is anything
 *      other than 127.0.0.1 / ::1 / localhost. Catches the case where
 *      someone discovers the daemon's container-internal port and tries
 *      to hit it from outside.
 *   2. Token check — even within loopback, refuse requests that don't
 *      present the matching token. Catches the case where some other
 *      container on the same Docker network manages to reach 127.0.0.1
 *      (or the host network is mistakenly enabled).
 *
 * Exceptions: GET /api/health is open (used by run.sh's healthcheck loop
 * and any future operator monitoring; it doesn't expose anything).
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';

const TOKEN_FILENAME = '.daemon-token';
const TOKEN_BYTES = 32; // 256 bits
const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Read the daemon's internal token from disk; if missing, mint a fresh
 * 256-bit secret and write it (mode 0600). The token is the only thing
 * standing between the world and a write-capable /api/ha/dashboards/preview
 * endpoint, so we keep it on disk and never log it.
 */
export function loadOrCreateInternalToken(): string {
  const dataDir = resolve(process.env.HA_DATA_DIR ?? './data');
  const tokenPath = join(dataDir, TOKEN_FILENAME);
  if (existsSync(tokenPath)) {
    try {
      const t = readFileSync(tokenPath, 'utf8').trim();
      if (t.length >= 32) return t;
      logger.warn('daemon token file present but too short; regenerating');
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'failed to read daemon token; regenerating');
    }
  }
  const t = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tokenPath, t, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  } catch (e) {
    // We can still run in-memory — better than refusing all traffic — but
    // log loudly so the operator notices.
    logger.error({ err: (e as Error).message }, 'failed to persist daemon token; using in-memory copy');
  }
  return t;
}

/**
 * Build the Express middleware that enforces:
 *   1. Loopback host only (with one explicit bypass for tests below).
 *   2. Matching X-Addon-Internal-Token (except /api/health).
 *
 * The token is held in a closure — never logged, never put on req.
 */
export function internalAuthMiddleware(token: string): RequestHandler {
  return function internalAuth(req: Request, res: Response, next: NextFunction): void {
    // /api/health is a public status check (run.sh polls it; operators may
    // want to scrape it). It returns no secrets so leaving it open is fine.
    if (req.path === '/api/health') {
      next();
      return;
    }

    // Layer 1: host check. Express's `req.hostname` strips the port and is
    // derived from the Host header (or X-Forwarded-Host if trust proxy is
    // set; we don't set trust proxy, so Host is the source of truth).
    const host = req.hostname;
    if (!ALLOWED_LOOPBACK_HOSTS.has(host)) {
      logger.warn({ host, path: req.path, ip: req.ip }, 'daemon reject: non-loopback host');
      res.status(401).json({ error: 'unauthorized: external access denied' });
      return;
    }

    // Layer 2: token check. Constant-time compare to avoid timing oracles.
    const provided = req.header('x-addon-internal-token');
    if (!provided || !constantTimeEqual(provided, token)) {
      logger.warn({ path: req.path, ip: req.ip }, 'daemon reject: missing or invalid internal token');
      res.status(401).json({ error: 'unauthorized: missing or invalid X-Addon-Internal-Token' });
      return;
    }

    next();
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
