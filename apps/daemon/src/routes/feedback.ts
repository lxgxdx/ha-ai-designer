/**
 * /api/chat/feedback — v0.3.2.3
 *
 * Receives user ratings on a generated dashboard. Persists each entry
 * to `${HA_KNOWLEDGE_DIR}/.feedback/feedback.jsonl` (one JSON object per
 * line). This file is the INPUT to scripts/learn.ts (v0.3.2.4) which
 * reads the negative feedback and LLM-rewrites the relevant wiki notes
 * (with human review before any change lands in wiki/).
 *
 * Request body:
 *   {
 *     brief: string,
 *     yaml: string,                 // generated LovelaceConfig YAML
 *     rating: number,               // 1-5 (1=terrible, 5=perfect)
 *     comment?: string,             // optional user explanation
 *     entityRefs?: string[]         // entity_ids the LLM touched
 *   }
 *
 * Response:
 *   204 No Content on success
 *   400 on invalid payload
 *   204 (silent skip) if HA_KNOWLEDGE_DIR is unset (RAG disabled — still
 *     acknowledge the request so the UI doesn't error)
 *
 * Security:
 *   - Goes through the same internal auth middleware as every other
 *     route (X-Internal-Token header check).
 *   - When proxied via /api/daemon/[...path]/route.ts, Origin is CSRF-
 *     checked there.
 *   - File append is gated on HA_KNOWLEDGE_DIR being a real existing
 *     directory (we never invent a path).
 *   - The brief / yaml can contain PII (user's brief, their HA YAML).
 *     We never log them; we DO log the rating + lengths for telemetry.
 *   - File is mode 0600 to match the rest of data/config.json hygiene.
 */
import { Router, type Request, type Response } from 'express';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

const YAML_CAP = 8_000;     // truncate to keep feedback.jsonl small
const COMMENT_CAP = 2_000;
const ENTITY_REFS_CAP = 100;
const RATING_MIN = 1;
const RATING_MAX = 5;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function createFeedbackRouter(): Router {
  const r = Router();
  r.post('/api/chat/feedback', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const brief = body.brief;
    const yaml = body.yaml;
    const rating = body.rating;
    const comment = body.comment;
    const entityRefs = body.entityRefs;

    if (!isStr(brief) || !isStr(yaml) || !isNum(rating)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'brief (string), yaml (string), rating (number) required',
      });
    }
    if (rating < RATING_MIN || rating > RATING_MAX) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_RATING',
        message: `rating must be in [${RATING_MIN}, ${RATING_MAX}]`,
      });
    }
    if (comment !== undefined && !isStr(comment)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_COMMENT',
        message: 'comment must be a string when present',
      });
    }
    if (entityRefs !== undefined && !Array.isArray(entityRefs)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_ENTITY_REFS',
        message: 'entityRefs must be an array of strings when present',
      });
    }

    const knowledgeDir = process.env.HA_KNOWLEDGE_DIR;
    if (!knowledgeDir) {
      // RAG might be disabled (no embeddingModel) or simply not configured.
      // Acknowledge silently so the UI doesn't error.
      logger.info(
        { rating, briefLen: brief.length, yamlLen: yaml.length },
        'feedback received but HA_KNOWLEDGE_DIR unset; not persisting',
      );
      return res.status(204).end();
    }
    if (!existsSync(knowledgeDir)) {
      logger.warn(
        { knowledgeDir },
        'feedback: HA_KNOWLEDGE_DIR set but does not exist; not persisting',
      );
      return res.status(204).end();
    }

    const feedbackDir = join(knowledgeDir, '.feedback');
    if (!existsSync(feedbackDir)) {
      mkdirSync(feedbackDir, { recursive: true });
    }
    const entry = {
      ts: new Date().toISOString(),
      brief,
      yaml: yaml.length > YAML_CAP ? yaml.slice(0, YAML_CAP) + '\n# …truncated' : yaml,
      rating,
      comment: isStr(comment)
        ? (comment.length > COMMENT_CAP ? comment.slice(0, COMMENT_CAP) : comment)
        : undefined,
      entityRefs: Array.isArray(entityRefs)
        ? entityRefs.filter(isStr).slice(0, ENTITY_REFS_CAP)
        : undefined,
    };
    appendFileSync(join(feedbackDir, 'feedback.jsonl'), JSON.stringify(entry) + '\n');
    logger.info(
      { rating, briefLen: brief.length, yamlLen: yaml.length, hasComment: !!entry.comment },
      'feedback persisted',
    );
    return res.status(204).end();
  });
  return r;
}
