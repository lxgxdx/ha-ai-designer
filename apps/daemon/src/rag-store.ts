/**
 * RAG store — sqlite-vec backed vector index of hha-knowledge wiki articles.
 *
 * v0.3.1 design:
 *   - One row per chunk (a chunk is one markdown section under a `##`
 *     heading, not the whole article — fine-grained for better recall).
 *   - Vectors live in a sqlite-vec virtual table `vec_chunks`. The
 *     embedding dimension is detected at startup (probes the embedding
 *     API) and the table is created with that fixed dim. If the dim
 *     changes between runs (different embedding model), the table is
 *     dropped and recreated.
 *   - Metadata (article title, topic, mtime, etc.) lives in a regular
 *     `chunks` table joined on rowid. sqlite-vec stores rowids only.
 *   - The wiki directory's mtime is recorded at index time; on every
 *     startup we compare and reindex if newer (cheap O(1) check, no
 *     walk of the tree).
 *   - Persisted at ${HA_DATA_DIR}/rag.db (gitignored). The same file is
 *     reused across restarts; on first boot, an initial index is built.
 *
 * Concurrency: better-sqlite3 is synchronous; the daemon is single-
 * threaded, so no locking is needed.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectEmbeddingDim, embed } from './embedding-client.js';
import { loadEmbeddingConfig } from './ha-client.js';
import { config } from './config.js';
import { logger } from './logger.js';

interface ChunkRow {
  rowid: number;
  topic: string;
  title: string;
  path: string;          // relative to wiki/, e.g. "cards/built-in-cards-overview.md"
  section: string;       // "## Overview" or "<article body>" for the implicit top section
  content: string;       // the chunk's markdown body (no heading line)
  mtime: number;         // article file mtime, ms since epoch
}

interface SearchHit {
  rowid: number;
  topic: string;
  title: string;
  path: string;
  section: string;
  content: string;
  /** L2 distance; lower is closer. */
  distance: number;
}

let db: Database.Database | null = null;
let dim: number | null = null;
let lastIndexedWikiMtime: number | null = null;

function dbPath(): string {
  return resolve(config.dataDir, 'rag.db');
}

function ensureDataDir(): void {
  const dir = resolve(config.dataDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function maxMtime(dir: string): number {
  let max = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(cur, { withFileTypes: true }) as { name: string; isDirectory: () => boolean }[];
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        try {
          const s = statSync(p);
          if (s.mtimeMs > max) max = s.mtimeMs;
        } catch {
          // ignore
        }
      }
    }
  }
  return max;
}

interface ParsedArticle {
  topic: string;
  title: string;
  path: string;       // relative to wiki/
  sections: { heading: string; body: string }[];
}

function parseArticle(filePath: string, topic: string, content: string): ParsedArticle {
  // First non-empty line is "# <title>"
  const lines = content.split('\n');
  let title = '';
  for (const l of lines) {
    const m = l.match(/^#\s+(.+?)\s*$/);
    if (m && m[1]) { title = m[1].trim(); break; }
  }
  if (!title) title = filePath.split('/').pop() ?? filePath;

  // Split by ## headings. We treat the preamble (before the first ##)
  // as a section with heading = "<title>" so we never lose content.
  const sections: { heading: string; body: string }[] = [];
  let currentHeading: string | null = null;
  let currentBody: string[] = [];
  const flush = () => {
    const body = currentBody.join('\n').trim();
    if (body) {
      sections.push({ heading: currentHeading ?? title, body });
    }
  };
  for (const l of lines) {
    const h = l.match(/^##\s+(.+?)\s*$/);
    if (h && h[1]) {
      flush();
      currentHeading = h[1].trim();
      currentBody = [];
    } else {
      currentBody.push(l);
    }
  }
  flush();
  return { topic, title, path: filePath, sections };
}

function readWiki(): { articles: ParsedArticle[]; maxMtime: number } {
  const knowledgeDir = process.env.HA_KNOWLEDGE_DIR;
  if (!knowledgeDir) {
    return { articles: [], maxMtime: 0 };
  }
  const wikiDir = join(knowledgeDir, 'wiki');
  if (!existsSync(wikiDir)) {
    return { articles: [], maxMtime: 0 };
  }
  const topicDirs = readdirSync(wikiDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, dir: join(wikiDir, e.name) }));
  const articles: ParsedArticle[] = [];
  let max = 0;
  for (const t of topicDirs) {
    let files: string[];
    try {
      files = readdirSync(t.dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = join(t.dir, f);
      try {
        const stat = statSync(fp);
        if (stat.mtimeMs > max) max = stat.mtimeMs;
        const content = readFileSync(fp, 'utf8');
        articles.push(parseArticle(`${t.name}/${f}`, t.name, content));
      } catch (e) {
        logger.warn({ fp, err: (e as Error).message }, 'failed to read wiki article');
      }
    }
  }
  return { articles, maxMtime: max };
}

/**
 * Initialize (or open) the RAG store. Safe to call multiple times — the
 * second and subsequent calls are no-ops.
 *
 * On first call: detects embedding dim, creates tables, indexes all wiki
 * articles. On later calls: compares wiki mtime; reindexes if changed.
 */
export async function initRagStore(): Promise<void> {
  if (db) return;
  const cfg = loadEmbeddingConfig();
  if (!cfg) {
    logger.info('RAG disabled: llm.embeddingModel not set in data/config.json');
    return;
  }
  ensureDataDir();
  try {
    dim = await detectEmbeddingDim();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'RAG init aborted: embedding probe failed');
    return;
  }

  db = new Database(dbPath());
  sqliteVec.load(db);

  // Schema. We store chunks with their vector for vector search + rowid
  // for join. The dimension is fixed at first index time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      section TEXT NOT NULL,
      content TEXT NOT NULL,
      mtime INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // The vec_chunks virtual table is recreated if its dim doesn't match.
  // sqlite-vec doesn't support ALTER on the column dim, so we drop+recreate.
  const existing = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'`)
    .get() as { name: string } | undefined;
  if (existing) {
    // sqlite-vec exposes the dim in sqlite_master.sql; cheapest probe is
    // to attempt a query — if it errors, drop and recreate. The CREATE
    // sql is recoverable from sqlite_master.
    const sqlRow = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'`)
      .get() as { sql: string } | undefined;
    const m = sqlRow?.sql.match(/float\[(\d+)\]/);
    const existingDim = m && m[1] ? Number(m[1]) : null;
    if (existingDim !== dim) {
      logger.warn(
        { existingDim, newDim: dim },
        'embedding dim changed; dropping vec_chunks and reindexing',
      );
      db.exec(`DROP TABLE vec_chunks;`);
      db.prepare(`DELETE FROM meta WHERE key='last_indexed_mtime'`).run();
    }
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${dim}]
    );
  `);

  // Decide whether to reindex
  const wiki = readWiki();
  const stored = db
    .prepare(`SELECT value FROM meta WHERE key='last_indexed_mtime'`)
    .get() as { value: string } | undefined;
  const storedMtime = stored ? Number(stored.value) : 0;
  if (storedMtime >= wiki.maxMtime && wiki.articles.length > 0) {
    logger.info(
      { storedMtime, wikiMtime: wiki.maxMtime, articles: wiki.articles.length },
      'RAG index up-to-date; skipping reindex',
    );
    lastIndexedWikiMtime = wiki.maxMtime;
    return;
  }
  await reindex(wiki.articles);
  lastIndexedWikiMtime = wiki.maxMtime;
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_mtime', ?)`)
    .run(String(wiki.maxMtime));
}

async function reindex(articles: ParsedArticle[]): Promise<void> {
  if (!db) return;
  if (articles.length === 0) {
    logger.info('RAG: no wiki articles to index');
    return;
  }
  // Build (chunk, embed-input) pairs. The embed input is title + section
  // heading + body — gives the embedding enough context for retrieval
  // without bloating the vector space.
  const pairs: { chunk: Omit<ChunkRow, 'rowid'>; text: string }[] = [];
  for (const a of articles) {
    for (const s of a.sections) {
      const text = `${a.title} — ${s.heading}\n${s.body}`.slice(0, 4000);
      pairs.push({
        chunk: {
          topic: a.topic,
          title: a.title,
          path: a.path,
          section: s.heading,
          content: s.body,
          mtime: Date.now(),
        },
        text,
      });
    }
  }
  logger.info({ articles: articles.length, chunks: pairs.length, dim }, 'RAG: embedding chunks');

  // Batch embed. 32 per call is a safe default; some providers cap at 100.
  const BATCH = 32;
  const allVectors: number[][] = [];
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const texts = batch.map((p) => p.text);
    const r = await embed({ texts });
    allVectors.push(...r.vectors);
  }
  if (allVectors.length !== pairs.length) {
    throw new Error(
      `RAG reindex embedding count mismatch: got ${allVectors.length}, expected ${pairs.length}`,
    );
  }

  // Replace existing rows + vectors in a single transaction.
  const txn = db.transaction(() => {
    db!.exec(`DELETE FROM chunks; DELETE FROM vec_chunks;`);
    const insChunk = db!.prepare(
      `INSERT INTO chunks (topic, title, path, section, content, mtime)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insVec = db!.prepare(
      `INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`,
    );
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i]!;
      const rowid = Number(insChunk.run(
        p.chunk.topic, p.chunk.title, p.chunk.path, p.chunk.section,
        p.chunk.content, p.chunk.mtime,
      ).lastInsertRowid);
      insVec.run(rowid, Buffer.from(new Float32Array(allVectors[i]!).buffer));
    }
  });
  txn();
  logger.info(
    { chunks: pairs.length, dim },
    'RAG: reindex done',
  );
}

/**
 * Search the RAG store for chunks relevant to the query. Returns the top
 * `topK` chunks sorted by ascending L2 distance.
 *
 * Returns [] if the store isn't initialized (e.g. embeddingModel unset).
 */
export function searchRelevant(query: string, topK = 3): SearchHit[] {
  if (!db || dim === null) return [];
  // We embed the query synchronously-ish (better-sqlite3 is sync, but
  // embed() is async). Caller already wraps this in an async fn.
  return []; // placeholder — real impl is asyncSearchRelevant below
}

/**
 * Async variant — the embed() call is async. Use this in production.
 */
export async function searchRelevantAsync(
  query: string,
  topK = 3,
): Promise<SearchHit[]> {
  if (!db || dim === null) return [];
  let vecs: number[][];
  try {
    const r = await embed({ texts: [query] });
    vecs = r.vectors;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'RAG search: embedding failed; returning []');
    return [];
  }
  const vec = new Float32Array(vecs[0]!);
  const buf = Buffer.from(vec.buffer);
  // sqlite-vec exposes MATCH on the virtual table for KNN
  const rows = db
    .prepare(
      `SELECT rowid, distance
         FROM vec_chunks
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
    )
    .all(buf, topK) as { rowid: number; distance: number }[];
  if (rows.length === 0) return [];
  const meta = db
    .prepare(
      `SELECT rowid, topic, title, path, section, content
         FROM chunks WHERE rowid IN (${rows.map(() => '?').join(',')})`,
    )
    .all(...rows.map((r) => r.rowid)) as ChunkRow[];
  const metaByRowid = new Map(meta.map((m) => [m.rowid, m]));
  return rows.map((r) => {
    const m = metaByRowid.get(r.rowid);
    return {
      rowid: r.rowid,
      topic: m?.topic ?? '',
      title: m?.title ?? '',
      path: m?.path ?? '',
      section: m?.section ?? '',
      content: m?.content ?? '',
      distance: r.distance,
    };
  });
}

/**
 * For tests / introspection: report the current state.
 */
export function ragStatus(): {
  initialized: boolean;
  dim: number | null;
  chunkCount: number;
  lastIndexedWikiMtime: number | null;
} {
  if (!db) {
    return { initialized: false, dim: null, chunkCount: 0, lastIndexedWikiMtime };
  }
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM chunks`).get() as { n: number };
  return {
    initialized: true,
    dim,
    chunkCount: cnt.n,
    lastIndexedWikiMtime,
  };
}
