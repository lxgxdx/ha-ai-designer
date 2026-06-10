import type { Request, Response, Router } from 'express';
import express from 'express';
import type { HealthResponse } from '@ha-designer/contracts';

const startedAt = Date.now();
const SERVICE = 'ha-ai-designer-daemon';
const VERSION = '0.1.0';

export function createHealthRouter(): Router {
  const r = express.Router();

  r.get('/api/health', (_req: Request, res: Response) => {
    const body: HealthResponse = {
      service: SERVICE,
      ts: new Date().toISOString(),
      version: VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      subsystems: [
        { name: 'http', ok: true },
        // Future: { name: 'ha', ok: false, detail: 'not connected' },
        // Future: { name: 'llm', ok: false, detail: 'no api key' },
        // Future: { name: 'sqlite', ok: true },
      ],
    };
    res.json(body);
  });

  return r;
}
