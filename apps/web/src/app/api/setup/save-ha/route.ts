/**
 * /api/setup/save-ha — server-side proxy for POST /api/ha/config
 * used by the setup wizard (/setup page). Lives OUTSIDE the
 * /api/daemon/[...path] catch-all proxy so the proxy's GET-only
 * method allowlist doesn't block the wizard's write. The web process
 * attaches the X-Addon-Internal-Token here; the browser never sees
 * it.
 *
 * v0.2.0.5: same-origin CSRF guard. The wizard is reachable from
 * HA's ingress origin (the user's HA) and from the in-cluster web
 * server. We reject POSTs whose Origin header doesn't match. Browsers
 * automatically attach Origin on same-origin and cross-origin POSTs;
 * if it's missing entirely, we also reject (curl/Postman without
 * Origin is fine for one-off use, but the wizard always runs in
 * a browser, so this is a safe default).
 */
import { type NextRequest } from 'next/server';

const DAEMON_URL = process.env.HA_DAEMON_URL ?? 'http://127.0.0.1:7456';
const TOKEN = process.env.HA_DAEMON_TOKEN ?? '';

const ALLOWED_ORIGINS = new Set([
  process.env.HA_INGRESS_ORIGIN ?? 'http://homeassistant.local:8123',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // v0.3.5: when the user exposes the add-on's port (config.yaml:
  // ports: {3000: 3000}) and accesses it from an external hostname
  // (or LAN IP) the Origin header is that hostname — not ingress.
  // HA_INGRESS_ORIGIN alone is not enough. ALLOWED_ORIGINS_EXTRA
  // is a comma-separated list of extra origins the user opts in
  // to via the add-on Configuration page. Defaults to empty.
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
  const upstream = await fetch(`${DAEMON_URL}/api/ha/config`, {
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
