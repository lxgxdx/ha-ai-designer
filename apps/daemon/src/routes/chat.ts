/**
 * /api/chat — orchestrate a brief into a LovelaceConfig.
 *
 * v0.2.0: SSE streaming response. Each orchestrator progress event is
 * forwarded as an `event: <type>` SSE frame. The web client closes the
 * connection after receiving `event: done` (or `event: error`).
 *
 * SSE headers set here are tuned for HA ingress — the supervisor's
 * reverse proxy buffers responses by default, so we set
 * `X-Accel-Buffering: no` to keep chunks flowing. `Cache-Control:
 * no-cache, no-transform` blocks the proxy from caching or rewriting
 * the stream.
 *
 * The legacy non-streaming JSON response is preserved under
 * `?stream=0` for the smoke test and the curl-based verification
 * scripts. The web client always uses the streaming path (default).
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import { orchestrate, orchestrateStream, OrchestrateRequest, OrchestrateStreamEvent } from '../llm-orchestrator.js';
import { logger } from '../logger.js';
import { HaConfigError } from '../ha-client.js';

export function createChatRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  /**
   * POST /api/chat
   * Body: { brief, skillName?, designSystemName? }
   * Default: SSE streaming response.
   * `?stream=0` (or `Accept: application/json`): legacy non-streaming JSON.
   */
  r.post('/api/chat', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<OrchestrateRequest>;
    if (!body.brief || typeof body.brief !== 'string') {
      return res.status(400).json({ ok: false, message: 'brief is required' });
    }
    if (body.brief.length > 4000) {
      return res.status(400).json({ ok: false, message: 'brief is too long (max 4000 chars)' });
    }
    // v0.2.0 input validation: skillName and designSystemName are
    // spliced into a filesystem path by loadSkillText / loadDesignText
    // (`<repoRoot>/skills/<skillName>/SKILL.md`). Even though path.join
    // normalises ".." segments, narrow the input to a safe identifier
    // alphabet so a hostile brief can never reference files outside
    // the skills/ or design-systems/ trees.
    const SAFE_SLUG = /^[a-z0-9_-]+$/;
    if (body.skillName !== undefined && (typeof body.skillName !== 'string' || !SAFE_SLUG.test(body.skillName))) {
      return res.status(400).json({ ok: false, code: 'INVALID_SKILL_NAME', message: 'skillName must match /^[a-z0-9_-]+$/' });
    }
    if (body.designSystemName !== undefined && (typeof body.designSystemName !== 'string' || !SAFE_SLUG.test(body.designSystemName))) {
      return res.status(400).json({ ok: false, code: 'INVALID_DESIGN_NAME', message: 'designSystemName must match /^[a-z0-9_-]+$/' });
    }

    const accept = String(req.headers.accept || '');
    // Treat any application/json acceptance (or a fetch that doesn't
    // ask for event-stream) as the legacy non-streaming path. Otherwise
    // it's a streaming request.
    const wantsJson = accept.split(',').some((t) => t.trim().startsWith('application/json'));
    const wantStream = !(req.query.stream === '0' || wantsJson);
    if (!wantStream) {
      // Legacy non-streaming JSON path — used by smoke + curl scripts.
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
      return;
    }

    // SSE path. Set headers BEFORE writing the body.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable nginx / HA-ingress response buffering. Without this, the
    // proxy waits for `proxy_buffer_size` worth of data before flushing
    // any of it to the client, which defeats the whole point of
    // streaming and is invisible in unit tests.
    res.setHeader('X-Accel-Buffering', 'no');
    // Compress the LLM yamls on the wire if ingress has gzip on.
    res.flushHeaders?.();
    // v0.2.0.1: Express 4's `flushHeaders?.()` is a no-op stub on the
    // response object (it exists on Node's `http.ServerResponse` but
    // Express 4 doesn't expose it on its `Response` typing). Without a
    // real flush, `curl -N` (and the browser) hang waiting for the
    // first byte even though headers are set, and they time out long
    // before the LLM finishes streaming. Send an SSE comment line
    // (`:` per the SSE spec is a comment, ignored by clients) so the
    // kernel/Node socket buffer is flushed and the client sees the
    // first chunk immediately.
    res.write(':\n\n');

    const writeSse = (event: string, data: unknown): void => {
      // SSE requires \n\n between events. JSON-stringify the payload so
      // multi-line YAML / multi-line error messages don't break the
      // event framing.
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // v0.2.0: active LLM cancellation on client disconnect. Without
    // an AbortController the LLM request would run to completion even
    // after the browser closed the tab — wasting tokens + time.
    // We use an explicit AbortController (instead of `req.signal` —
    // which doesn't exist on Express 4) and wire it to the underlying
    // fetch via the orchestrator.
    //
    // v0.2.0.2: don't hook `req.on('close', ...)`. In Express 4 the
    // 'close' event on the request fires as soon as the response
    // ends, which can race with our own `res.end()` and abort the
    // stream before the first event is written. We instead poll
    // `res.writableEnded` after each chunk and trust the orchestrator's
    // existing `signal?.aborted` checks (it loops over the LLM
    // stream and breaks if signal is set).
    //
    // v0.2.0.5: a per-chunk poll alone is not enough — between
    // LLM chunks the orchestrator blocks on `reader.read()` and
    // emit() doesn't fire, so a client disconnect during a silent
    // gap would NOT abort until the next chunk arrived. Add a 500ms
    // interval heartbeat that polls `res.writableEnded` (cheap, just
    // a boolean) and triggers `ac.abort()` if the client vanished.
    // The interval is cleared on natural completion (the `done`
    // event handler ends the response).
    const ac = new AbortController();
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        if (!ac.signal.aborted) {
          logger.info('SSE client disconnected (heartbeat) — aborting in-flight LLM stream');
          ac.abort();
        }
      }
    }, 500);

    try {
      await orchestrateStream(
        {
          brief: body.brief,
          skillName: body.skillName,
          designSystemName: body.designSystemName,
          includeEntities: body.includeEntities,
        },
        (e: OrchestrateStreamEvent) => {
          // If the response has been closed by the client (e.g. the
          // browser tab was killed), don't try to write more events
          // — Node will throw ERR_STREAM_DESTROYED. Bail and let the
          // catch block's `ac.abort()` kick in.
          if (res.writableEnded || res.destroyed) {
            if (!ac.signal.aborted) ac.abort();
            return;
          }
          try {
            if (e.type === 'llm-chunk') {
              writeSse('llm-chunk', { chunk: e.chunk });
            } else if (e.type === 'yaml-extracted') {
              writeSse('yaml-extracted', { yaml: e.yaml });
            } else if (e.type === 'validated') {
              writeSse('validated', { warnings: e.warnings, model: e.model, usage: e.usage });
            } else if (e.type === 'done') {
              writeSse('done', { ok: true, ...e.result });
              res.end();
            }
          } catch (writeErr) {
            if (!ac.signal.aborted) {
              logger.warn({ err: (writeErr as Error).message }, 'SSE write failed; aborting LLM stream');
              ac.abort();
            }
          }
        },
        ac.signal,
      );
    } catch (e) {
      if (e instanceof HaConfigError) {
        if (!res.writableEnded) writeSse('error', { ok: false, code: 'HA_NOT_CONFIGURED', message: e.message });
      } else if ((e as Error).name === 'AbortError' || ac.signal.aborted) {
        // Client went away mid-stream. Don't bother writing a final
        // error event — the response is already torn down.
        logger.info('orchestrate stream aborted by client disconnect');
      } else {
        logger.error({ err: (e as Error).message }, 'orchestrate stream failed');
        if (!res.writableEnded) writeSse('error', { ok: false, message: (e as Error).message });
      }
      try { res.end(); } catch { /* already closed */ }
    } finally {
      clearInterval(heartbeat);
    }
  });

  return r;
}
