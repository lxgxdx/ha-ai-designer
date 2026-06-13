/**
 * /api/ha/* — Home Assistant adapter (v0.3).
 *
 * Read split:
 *   - entities / services / config / calendars / history / stream → REST (still works in HA 2026.6)
 *   - dashboard (config / dashboards list / config save) → WebSocket (REST /api/lovelace/* was removed)
 *
 * Write gate:
 *   - All non-GET endpoints require { confirm: true } at the haRequest() layer
 *     AND a body-level { __confirmed_by_user: true, intent: "..." } flag for
 *     dashboard pushes. The v0.5 confirmation flow will wire a proper UI prompt.
 *
 * Token is loaded from data/config.json (gitignored).
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import { join, resolve } from 'node:path';
import {
  HaConfigError,
  HaGatedError,
  haRequest,
  clearConfigCache,
} from '../ha-client.js';
import { haWsRequest } from '../ha-ws-client.js';
import { logger } from '../logger.js';
import { ensurePublicBaseUrl } from '../url-safety.js';
import type { HaEntity, LovelaceConfig } from '@ha-designer/contracts';

interface WsDashboardMeta {
  id?: string;
  url_path: string;
  title: string;
  show_in_sidebar: boolean;
  mode: 'storage' | 'yaml' | 'auto' | 'iframe';
  filename?: string;
  icon?: string;
}

export function createHaRouter(): Router {
  const r = express.Router();

  // All /api/ha/* JSON bodies are small.
  r.use(express.json({ limit: '256kb' }));

  /**
   * GET /api/ha/ping
   * Probe HA reachability via REST and open a WebSocket connection
   * (the WS auth handshake itself is the readiness signal — we don't
   * send a follow-up command because HA has no `ping` command).
   */
  r.get('/api/ha/ping', async (_req: Request, res: Response) => {
    try {
      const { data } = await haRequest<{
        message?: string;
        version?: string;
      }>('/api/');
      // Open (or reuse) the WS connection. haWsRequest will trigger the
      // handshake on first call. We don't await a follow-up command.
      const { haWs } = await import('../ha-ws-client.js');
      let wsOk = true;
      try {
        await haWs.request<unknown>('lovelace/dashboards/list', {}, 'ping (dashboards/list)');
      } catch (e) {
        wsOk = false;
        logger.warn({ err: (e as Error).message }, 'HA WS probe failed');
      }
      res.json({
        ok: true,
        haVersion: data?.version ?? 'unknown',
        message: data?.message,
        wsOk,
      });
    } catch (e) {
      if (e instanceof HaConfigError) {
        return res.status(503).json({ ok: false, message: e.message });
      }
      logger.warn({ err: (e as Error).message }, 'ha/ping failed');
      res.status(502).json({ ok: false, message: (e as Error).message });
    }
  });

  /**
   * GET /api/ha/entities?domain=&area=&q=
   * List entities with optional filters (substring matches applied client-side).
   */
  r.get('/api/ha/entities', async (req: Request, res: Response) => {
    const { domain, area, q } = req.query as Record<string, string | undefined>;
    try {
      const { data } = await haRequest<HaEntity[]>('/api/states');
      let entities = data ?? [];
      if (domain) entities = entities.filter((e) => e.entity_id.startsWith(`${domain}.`));
      if (area) {
        const a = area.toLowerCase();
        entities = entities.filter(
          (e) => String(e.attributes?.area ?? '').toLowerCase().includes(a),
        );
      }
      if (q) {
        const qq = q.toLowerCase();
        entities = entities.filter(
          (e) =>
            e.entity_id.toLowerCase().includes(qq) ||
            String(e.attributes?.friendly_name ?? '').toLowerCase().includes(qq),
        );
      }
      res.json({ entities, total: entities.length });
    } catch (e) {
      if (e instanceof HaConfigError) {
        return res.status(503).json({ entities: [], total: 0, error: e.message });
      }
      logger.warn({ err: (e as Error).message }, 'ha/entities failed');
      res.status(502).json({ entities: [], total: 0, error: (e as Error).message });
    }
  });

  /**
   * GET /api/ha/dashboards
   * List all dashboards. v0.3: WebSocket-only (REST /api/dashboards/list was removed in HA 2026).
   */
  r.get('/api/ha/dashboards', async (_req: Request, res: Response) => {
    try {
      const raw = await haWsRequest<unknown>('lovelace/dashboards/list', {}, 'list dashboards');
      const list = normalizeDashboardsList(raw);
      res.json({ dashboards: list, fallback: false });
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn({ err: msg }, 'ha/dashboards list failed');
      // HA older / specific builds may not support the WS command; fall back to a single default.
      if (/not_found|unknown command|Unknown command/i.test(msg)) {
        logger.info('Falling back to synthetic single-dashboard list');
        return res.json({
          dashboards: [
            {
              url_path: 'lovelace',
              title: 'Overview',
              show_in_sidebar: true,
              mode: 'storage' as const,
            },
          ],
          fallback: true,
          fallbackReason: 'lovelace/dashboards/list not supported on this HA version',
        });
      }
      res.status(502).json({ dashboards: [], error: msg });
    }
  });

  /**
   * GET /api/ha/dashboards/:urlPath
   * Fetch a single dashboard's current Lovelace config via WebSocket.
   */
  r.get('/api/ha/dashboards/:urlPath', async (req: Request, res: Response) => {
    const urlPath = req.params.urlPath ?? '';
    if (!urlPath) {
      return res.status(400).json({ ok: false, message: 'urlPath is required' });
    }
    try {
      // Try to list dashboards to determine mode + whether this is a known dashboard.
      let mode: 'storage' | 'yaml' = 'storage';
      let knownDashboard = urlPath === 'lovelace';
      try {
        const raw = await haWsRequest<unknown>('lovelace/dashboards/list', {}, 'list dashboards');
        const list = normalizeDashboardsList(raw);
        const meta = list.find((d) => d.url_path === urlPath);
        if (meta) {
          knownDashboard = true;
          mode = meta.mode === 'yaml' ? 'yaml' : 'storage';
        }
      } catch {
        // ignore — list is best-effort
      }

      if (!knownDashboard && urlPath !== 'lovelace') {
        return res.status(404).json({ ok: false, message: `dashboard "${urlPath}" not found` });
      }

      if (mode === 'storage') {
        // WebSocket: lovelace/config. Without a "url_path" parameter it reads
        // the default ('lovelace') dashboard. Non-default storage dashboards
        // can't be fetched from the API — they have to be edited in the HA UI.
        if (urlPath !== 'lovelace') {
          return res.json({
            urlPath,
            mode,
            yaml: null,
            config: null,
            note: 'Non-default storage dashboards cannot be fetched via the API. Edit in the HA UI.',
          });
        }
        const config = await haWsRequest<LovelaceConfig>(
          'lovelace/config',
          {},
          'read default dashboard config',
        );
        return res.json({ urlPath, mode, yaml: null, config });
      }

      // yaml mode — fetch the file. There's no documented WS command for this
      // in HA 2026; the REST path /api/lovelace/dashboards/:urlPath is also
      // gone. Surface a clear error so the v0.5 work picks it up.
      return res.status(501).json({
        ok: false,
        code: 'NOT_IMPLEMENTED',
        message:
          'YAML-mode dashboard read requires a WebSocket command not present in HA 2026.6. ' +
          'Convert the dashboard to storage mode (Settings → Dashboards → ⋯ → "Take Control") ' +
          'to use this tool, or implement the YAML fetch in a follow-up.',
      });
    } catch (e) {
      logger.warn({ err: (e as Error).message, urlPath }, 'ha/dashboards get failed');
      res.status(502).json({ ok: false, message: (e as Error).message });
    }
  });

  /**
   * POST /api/ha/dashboards/:urlPath
   * GATED. Push a dashboard config. Requires { confirm: true, __confirmed_by_user: true }.
   * v0.3: WebSocket only (lovelace/config/save). Works for the default storage-mode dashboard.
   */
  r.post('/api/ha/dashboards/:urlPath', async (req: Request, res: Response) => {
    const urlPath = req.params.urlPath ?? '';
    if (!urlPath) {
      return res.status(400).json({ ok: false, message: 'urlPath is required' });
    }
    const body = (req.body ?? {}) as {
      yaml?: string;
      config?: LovelaceConfig;
      __confirmed_by_user?: boolean;
      intent?: string;
    };

    if (body.__confirmed_by_user !== true) {
      logger.warn({ urlPath }, 'ha/dashboards push blocked: missing __confirmed_by_user');
      return res.status(409).json({
        ok: false,
        code: 'CONFIRMATION_REQUIRED',
        message:
          'Refusing to push dashboard. Body must include { __confirmed_by_user: true, intent: "<short reason>" }. ' +
          'The UI must show a diff and capture explicit user approval first.',
      });
    }

    if (urlPath !== 'lovelace') {
      return res.status(501).json({
        ok: false,
        code: 'NOT_IMPLEMENTED',
        message:
          'WebSocket lovelace/config/save only writes the default dashboard. ' +
          'Non-default dashboards require a separate WS call (not yet wired in v0.3).',
      });
    }
    if (!body.config) {
      return res.status(400).json({
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Body must include "config" (LovelaceConfig object) for storage-mode push.',
      });
    }

    try {
      logger.info(
        { intent: body.intent ?? 'unspecified', urlPath },
        '→ HA dashboard push — proceeding after user confirmation',
      );
      const result = await haWsRequest<unknown>(
        'lovelace/config/save',
        { config: body.config },
        `push dashboard "${urlPath}"`,
      );
      return res.json({ ok: true, result });
    } catch (e) {
      if (e instanceof HaGatedError) {
        return res.status(409).json({ ok: false, code: e.code, message: e.message });
      }
      logger.error({ err: (e as Error).message, urlPath }, 'ha/dashboards push failed');
      res.status(502).json({ ok: false, message: (e as Error).message });
    }
  });

  /**
   * POST /api/ha/config
   * Replace data/config.json (HA connection settings) and clear the cache.
   * Writes to OUR data dir, not to HA — not gated.
   */
  r.post('/api/ha/config', async (req: Request, res: Response) => {
    const body = req.body as { baseUrl?: string; token?: string } | undefined;
    if (!body?.baseUrl || !body?.token) {
      return res.status(400).json({ ok: false, message: 'baseUrl and token are required' });
    }
    if (!/^https?:\/\//.test(body.baseUrl)) {
      return res.status(400).json({ ok: false, message: 'baseUrl must start with http:// or https://' });
    }
    // v0.2.0 SSRF guard: this endpoint stores a long-lived HA access token
    // and then the daemon forwards that token (as `Authorization: Bearer ...`)
    // to the saved baseUrl on every HA request. Without this guard a user-
    // supplied `http://169.254.169.254/...` (cloud metadata) or
    // `http://attacker.example/...` would exfiltrate the HA token on the
    // very next /api/ha/ping or /api/chat call. validatePublicBaseUrl
    // rejects loopback, link-local, RFC1918, and cloud-metadata IPs.
    {
      const v = await ensurePublicBaseUrl('ha.config', body.baseUrl);
      if (!v.ok) {
        return res.status(400).json({
          ok: false,
          code: 'PRIVATE_HOST_BLOCKED',
          message: `baseUrl rejected: ${v.reason}. ` +
            `Set HA_LLM_ALLOW_PRIVATE_HOSTS=1 to allow (development only).`,
        });
      }
    }
    try {
      const fs = await import('node:fs/promises');
      const path = joinDataConfig();
      await fs.mkdir(joinDataDir(), { recursive: true });
      await fs.writeFile(
        path,
        JSON.stringify({ ha: { baseUrl: body.baseUrl, token: body.token } }, null, 2),
        { mode: 0o600 },
      );
      clearConfigCache();
      logger.info({ baseUrl: body.baseUrl }, 'HA connection config updated');
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'failed to write HA config');
      res.status(500).json({ ok: false, message: (e as Error).message });
    }
  });

  return r;
}

function joinDataDir(): string {
  return resolve(process.env.HA_DATA_DIR ?? './data');
}
function joinDataConfig(): string {
  return join(joinDataDir(), 'config.json');
}

/**
 * HA returns dashboards in different shapes across versions:
 *   - newer WS: array of meta objects
 *   - older REST: object keyed by url_path
 *   - even older: same as REST
 * Normalize to WsDashboardMeta[].
 */
function normalizeDashboardsList(raw: unknown): WsDashboardMeta[] {
  if (Array.isArray(raw)) {
    return raw.filter(isWsDashboardMeta).map((d) => ({
      ...d,
      mode: coerceMode(d.mode),
    }));
  }
  if (raw && typeof raw === 'object') {
    // Treat as a record keyed by url_path.
    return Object.entries(raw as Record<string, unknown>).flatMap(([urlPath, value]) => {
      if (!value || typeof value !== 'object') return [];
      const v = value as Record<string, unknown>;
      const meta: WsDashboardMeta = {
        url_path: urlPath,
        title: typeof v.title === 'string' ? v.title : urlPath,
        show_in_sidebar: Boolean(v.show_in_sidebar),
        mode: coerceMode(v.mode),
        icon: typeof v.icon === 'string' ? v.icon : undefined,
        filename: typeof v.filename === 'string' ? v.filename : undefined,
      };
      if (typeof v.id === 'string') meta.id = v.id;
      return [meta];
    });
  }
  return [];
}

function isWsDashboardMeta(v: unknown): v is WsDashboardMeta {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as Record<string, unknown>).url_path === 'string'
  );
}

function coerceMode(v: unknown): WsDashboardMeta['mode'] {
  return v === 'yaml' || v === 'auto' || v === 'iframe' ? v : 'storage';
}
