import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { createHealthRouter } from './routes/health.js';
import { createHaRouter } from './routes/ha.js';
import { createLlmRouter } from './routes/llm.js';
import { createChatRouter } from './routes/chat.js';
import { createPreviewRouter } from './routes/preview.js';
import { loadOrCreateInternalToken, internalAuthMiddleware } from './internal-auth.js';

function buildApp(internalToken: string): express.Express {
  const app = express();

  // CORS — only allow the configured web origin (loopback by default).
  app.use(
    cors({
      origin: config.webOrigin,
      credentials: true,
    }),
  );

  // JSON body — keep limit modest; artifacts are written via separate routes.
  app.use(express.json({ limit: '1mb' }));

  // v0.1.22: internal auth — every non-health request must come from
  // loopback AND carry X-Addon-Internal-Token. Mounted BEFORE all route
  // handlers so the gate is uniform regardless of which router registers
  // the endpoint. /api/health is intentionally exempted.
  app.use(internalAuthMiddleware(internalToken));

  // Per-request log line. Keep it terse — pino-pretty handles the rest.
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, path: req.path }, 'request');
    next();
  });

  app.use(createHealthRouter());
  // Preview router must come BEFORE the ha router — otherwise Express
  // matches `POST /api/ha/dashboards/preview` against the generic
  // `:urlPath` route in ha.ts, treating "preview" as a dashboard path.
  app.use(createPreviewRouter());
  app.use(createHaRouter());
  app.use(createLlmRouter());
  app.use(createChatRouter());

  // 404 + error handlers.
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error({ err }, 'unhandled error');
      res.status(500).json({ error: 'internal error' });
    },
  );

  return app;
}

function main(): void {
  // Mint or load the shared secret that lets the web process talk to us.
  // Logged with a short prefix only — never the full token.
  const internalToken = loadOrCreateInternalToken();
  logger.info(
    { tokenPrefix: internalToken.slice(0, 6) + '…' },
    'internal auth token loaded; web must present X-Addon-Internal-Token'
  );

  const app = buildApp(internalToken);
  const server = app.listen(config.port, config.host, () => {
    logger.info(
      { host: config.host, port: config.port, webOrigin: config.webOrigin },
      'ha-ai-designer daemon listening',
    );
  });

  // Graceful shutdown — flush logs, drain in-flight requests.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'error during close');
        process.exit(1);
      }
      process.exit(0);
    });
    // Hard exit if close hangs for 5s.
    setTimeout(() => {
      logger.warn('forcing exit after 5s');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
