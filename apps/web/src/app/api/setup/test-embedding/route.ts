/**
 * /api/setup/test-embedding — server-side proxy for POST /api/llm/test-embedding
 * (setup wizard step 3 verification). Same security model as test-llm.
 *
 * v0.4.0: this route is NEW — the embedding step is a v0.4.0 addition
 * to the wizard. Before v0.4.0 there was no separate embedding test
 * endpoint; the daemon's POST /api/llm/test only covered chat.
 */
import { type NextRequest } from 'next/server';

const DAEMON_URL = process.env.HA_DAEMON_URL ?? 'http://127.0.0.1:7456';
const TOKEN = process.env.HA_DAEMON_TOKEN ?? '';

const ALLOWED_ORIGINS = new Set([
  process.env.HA_INGRESS_ORIGIN ?? 'http://homeassistant.local:8123',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // v0.3.5: ALLOWED_ORIGINS_EXTRA from add-on Configuration is
  // merged in here too. See save-ha/route.ts for the rationale.
  ...(process.env.ALLOWED_ORIGINS_EXTRA ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
]);

function csrfCheck(req: NextRequest): { ok: true } | { ok: false; reason: string } {
  const origin = req.headers.get('origin');
  if (!origin) return { ok: false, reason: 'missing Origin' };
  if (!ALLOWED_ORIGINS.has(origin)) return { ok: false, reason: `origin "${origin}" not allowed` };
  return { ok: true };
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  const csrf = csrfCheck(req);
  if (!csrf.ok) {
    return new Response(
      JSON.stringify({ ok: false, code: 'CSRF_REJECTED', message: csrf.reason }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const body = await req.text();
  const upstream = await fetch(`${DAEMON_URL}/api/llm/test-embedding`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Addon-Internal-Token': TOKEN,
    },
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
