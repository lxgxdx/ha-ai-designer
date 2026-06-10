/**
 * /api/chat — orchestrate a brief into a LovelaceConfig.
 *
 * v0.4a: non-streaming POST. Returns the generated config + yaml +
 * meta + warnings. The client renders the yaml and asks the user to
 * confirm before pushing to HA.
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import { orchestrate, OrchestrateRequest } from '../llm-orchestrator.js';
import { logger } from '../logger.js';
import { HaConfigError } from '../ha-client.js';

export function createChatRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  /**
   * POST /api/chat
   * Body: { brief, skillName?, designSystemName? }
   */
  r.post('/api/chat', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<OrchestrateRequest>;
    if (!body.brief || typeof body.brief !== 'string') {
      return res.status(400).json({ ok: false, message: 'brief is required' });
    }
    if (body.brief.length > 4000) {
      return res.status(400).json({ ok: false, message: 'brief is too long (max 4000 chars)' });
    }
    try {
      const result = await orchestrate({
        brief: body.brief,
        skillName: body.skillName,
        designSystemName: body.designSystemName,
        includeEntities: body.includeEntities,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof HaConfigError) {
        return res.status(503).json({ ok: false, message: e.message });
      }
      logger.error({ err: (e as Error).message }, 'orchestrate failed');
      res.status(502).json({ ok: false, message: (e as Error).message });
    }
  });

  return r;
}
