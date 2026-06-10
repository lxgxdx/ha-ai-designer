/**
 * /api/ha/dashboards/preview — push a LovelaceConfig to the user's HA
 * and return the previewUrl + backup info.
 *
 * Safety: requires { __confirmed_by_user: true, intent: "..." } in the
 * body. This is a WRITE — it overwrites the user's lovelace dashboard.
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import { createPreviewSession, listBackups, restoreBackup } from '../preview-session.js';
import { haWsRequest } from '../ha-ws-client.js';
import { logger } from '../logger.js';
import type { LovelaceConfig } from '@ha-designer/contracts';

export function createPreviewRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  /**
   * POST /api/ha/dashboards/preview
   * Body: { config: LovelaceConfig, __confirmed_by_user: true, intent: "..." }
   * Response: { sessionId, previewUrl, backupPath, hasBackup, createdAt }
   */
  r.post('/api/ha/dashboards/preview', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      config?: LovelaceConfig;
      __confirmed_by_user?: boolean;
      intent?: string;
    };
    if (body.__confirmed_by_user !== true) {
      logger.warn('preview push blocked: missing __confirmed_by_user');
      return res.status(409).json({
        ok: false,
        code: 'CONFIRMATION_REQUIRED',
        message:
          'Refusing to push. Body must include { __confirmed_by_user: true, intent: "<short reason>" }. ' +
          'The UI must show a preview first and capture explicit user approval.',
      });
    }
    if (!body.config || !body.config.views) {
      return res.status(400).json({
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Body must include a valid LovelaceConfig (with views).',
      });
    }
    try {
      const session = await createPreviewSession(body.config);
      res.json({ ok: true, ...session });
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'preview push failed');
      res.status(502).json({ ok: false, message: (e as Error).message });
    }
  });

  /**
   * GET /api/ha/dashboards/preview/backups
   * List available backup snapshots (so the UI can show a revert menu).
   */
  r.get('/api/ha/dashboards/preview/backups', async (_req: Request, res: Response) => {
    try {
      const list = listBackups();
      res.json({ backups: list });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * POST /api/ha/dashboards/preview/backups/:sessionId/restore
   * Push a saved backup back to the user's HA. Also gated.
   */
  r.post(
    '/api/ha/dashboards/preview/backups/:sessionId/restore',
    async (req: Request, res: Response) => {
      const sessionId = req.params.sessionId ?? '';
      const body = (req.body ?? {}) as { __confirmed_by_user?: boolean; intent?: string };
      if (body.__confirmed_by_user !== true) {
        return res.status(409).json({
          ok: false,
          code: 'CONFIRMATION_REQUIRED',
          message: 'Refusing to revert without __confirmed_by_user: true.',
        });
      }
      try {
        const config = await restoreBackup(sessionId);
        res.json({ ok: true, sessionId, config });
      } catch (e) {
        logger.error({ err: (e as Error).message, sessionId }, 'revert failed');
        res.status(502).json({ ok: false, message: (e as Error).message });
      }
    },
  );

  /**
   * GET /api/ha/dashboards/preview/url
   * Just returns the previewUrl string for the default dashboard. Lets
   * the UI iframe refresh without re-running the whole chat.
   */
  r.get('/api/ha/dashboards/preview/url', async (_req: Request, res: Response) => {
    try {
      const data = await haWsRequest<unknown>(
        'lovelace/dashboards/list',
        {},
        'list dashboards for preview url',
      );
      const known = Array.isArray(data) ? data.find((d: unknown) => {
        const o = d as { url_path?: string };
        return o?.url_path === 'lovelace';
      }) : null;
      res.json({
        previewUrl: '/lovelace/lovelace',
        altPreviewUrl: known ? `/lovelace/${(known as { url_path: string }).url_path}` : null,
        haBaseUrl: process.env.HA_PUBLIC_BASE_URL ?? null,
      });
    } catch (e) {
      res.json({ previewUrl: '/lovelace/lovelace', error: (e as Error).message });
    }
  });

  /**
   * GET /api/ha/dashboards/preview/iframe-policy
   *
   * Probe the user's HA instance to see if an iframe embed will work.
   * HA defaults to `X-Frame-Options: SAMEORIGIN`, so the answer is almost
   * always "no" — but we surface the actual header + a recommendation so
   * the UI can pick the right CTA. Uses the saved HA token (long-lived)
   * to GET /lovelace/lovelace and inspect the response headers.
   */
  r.get('/api/ha/dashboards/preview/iframe-policy', async (_req: Request, res: Response) => {
    const { loadHaConfig } = await import('../ha-client.js');
    let cfg;
    try {
      cfg = loadHaConfig();
    } catch (e) {
      return res.status(503).json({ ok: false, error: (e as Error).message });
    }
    try {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/lovelace/lovelace`;
      const r2 = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cfg.token}` },
        redirect: 'manual',
      });
      // Drain body so socket can close.
      await r2.arrayBuffer().catch(() => {});
      const xfo = r2.headers.get('x-frame-options');
      const csp = r2.headers.get('content-security-policy');
      const cspFrameAncestors = csp
        ? (csp.match(/frame-ancestors[^;]*/i)?.[0]?.trim() ?? null)
        : null;
      const noAncestorRestriction =
        !xfo || xfo.toLowerCase() === 'allowall';
      res.json({
        ok: true,
        haBaseUrl: cfg.baseUrl,
        haPreviewUrl: url,
        xFrameOptions: xfo,
        csp,
        cspFrameAncestors,
        allowsEmbed: noAncestorRestriction,
        recommendation: noAncestorRestriction ? 'iframe' : 'new-tab',
        hint: noAncestorRestriction
          ? null
          : 'HA 默认 X-Frame-Options: SAMEORIGIN 拒绝跨域 iframe。两个绕过办法：' +
            '1) 编辑你的 HA configuration.yaml 加 `http: use_x_forwarded_for: true` + `http: ip_ban_enabled: false` ' +
            '并把 dashboard 配为 panel iframe（让 HA 嵌我们）；' +
            '2) 用下方的"在 HA 中打开预览"大按钮。',
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  });

  return r;
}
