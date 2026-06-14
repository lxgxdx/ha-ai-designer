/**
 * /api/daemon/[...path] — Next.js catch-all that forwards a narrow
 * set of GET requests to http://127.0.0.1:7456/<path>, attaching
 * the X-Internal-Token header. The response body is passed
 * through verbatim (ReadableStream — no buffering) so SSE streams
 * from the daemon (e.g. /api/chat) flow through to the browser as-is.
 *
 * v0.2.0 security tightening:
 *   - METHOD allowlist: GET / HEAD only. Write endpoints (POST
 *     /api/llm/config, POST /api/ha/config, POST /api/ha/dashboards/preview)
 *     are NOT proxied through here — the web's server components
 *     hit them directly with their own server-side token. This
 *     stops the browser from being able to drive arbitrary daemon
 *     writes just by forging a same-origin request.
 *   - PATH allowlist: /api/chat, /api/ha/*, /api/llm/*, /api/health.
 *     Anything else is 404. This blocks the proxy from being used
 *     to reach /etc/* style daemon paths or to brute-force other
 *     internal services if any get added later.
 *   - ".." segments are rejected (defense vs. an attacker that
 *     controls a single segment via path manipulation).
 *   - Headers are NOT spread from req.headers. We build a fresh
 *     Headers object with only Accept / Content-Type /
 *     Accept-Encoding / Accept-Language (whitelisted) plus the
 *     internal token. This stops cookies, Authorization, etc. set
 *     by the browser (or another component on the same origin)
 *     from being forwarded to the daemon and potentially affecting
 *     its behavior.
 *
 * Replaces v0.1.x's pattern of having ChatPane fetch the daemon
 * directly at http://127.0.0.1:7456/..., which never actually
 * worked from the browser (the daemon listens on container-internal
 * loopback, not the user's host loopback). v0.2.0 routes everything
 * through this same-origin proxy so ingress can carry the request.
 */
import { type NextRequest } from 'next/server';
import { getInternalToken } from '@ha-designer/contracts';

const DAEMON_URL = process.env.HA_DAEMON_URL ?? 'http://127.0.0.1:7456';
const TOKEN = getInternalToken();

// Path allowlist. /api/chat is matched exactly; the rest are prefix
// matches (so /api/ha/ping, /api/ha/entities, /api/llm/config etc.
// are all proxied).
const ALLOWED_EXACT = new Set(['/api/chat', '/api/chat/feedback', '/api/health']);
const ALLOWED_PREFIXES = ['/api/ha/', '/api/llm/'];

// Per-path method overrides. Most read endpoints accept GET only;
// /api/chat is the one streaming-write surface (POST /api/chat with
// the SSE body response). v0.3.2.3: /api/chat/feedback is also POST
// (user ratings on generated output, writes to .feedback/feedback.jsonl).
// All other writes (POST /api/llm/config, POST /api/ha/config,
// POST /api/ha/dashboards/preview, etc.) must go through server
// components that hit the daemon directly with the server-side token,
// NOT through this browser-reachable proxy.
const ALLOWED_METHODS_FOR_PATH: Record<string, string[]> = {
  '/api/chat': ['GET', 'POST'],
  '/api/chat/feedback': ['POST'],
};

// Headers the browser is allowed to set on the proxied request.
// Anything else (Cookie, Authorization, X-*, etc.) is dropped to
// keep the trust boundary tight: the only credential the daemon
// sees is the X-Internal-Token we set ourselves.
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'accept-encoding', 'accept-language'];

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  // Reject any '..' segment — defense vs. an attacker that escapes
  // out of the /api/* tree (e.g. "../../../etc/passwd"). path.join
  // would normalize but we want to refuse the request, not silently
  // serve something else.
  if (!path || path.some((seg) => seg === '..' || seg === '.' || seg.includes('\0'))) {
    return new Response(
      JSON.stringify({ ok: false, code: 'BAD_PATH', message: 'path traversal refused' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const subPath = '/' + path.join('/');

  if (!ALLOWED_EXACT.has(subPath) && !ALLOWED_PREFIXES.some((p) => subPath.startsWith(p))) {
    return new Response(
      JSON.stringify({ ok: false, code: 'NOT_PROXIED', message: `path "${subPath}" is not exposed via the web proxy` }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Method allowlist. /api/chat is the only write-capable proxy
  // surface (POST with SSE body for streaming). Everything else is
  // GET/HEAD only.
  const allowedMethods = ALLOWED_METHODS_FOR_PATH[subPath] ?? ['GET', 'HEAD'];
  if (!allowedMethods.includes(req.method)) {
    return new Response(
      JSON.stringify({ ok: false, code: 'METHOD_NOT_ALLOWED', message: `method ${req.method} not allowed for ${subPath}` }),
      { status: 405, headers: { 'Content-Type': 'application/json', Allow: allowedMethods.join(', ') } },
    );
  }

  // v0.2.0.3: CSRF guard. For state-changing methods (POST), require the
  // request Origin to match our own (the Next.js server's) origin. This
  // stops a malicious site hosted on a sibling port (or an HA dash-
  // board iframe) from making the user's browser issue a same-origin
  // POST through this proxy to drive a daemon write.
  //
  // v0.3.5: ALLOWED_ORIGINS_EXTRA (comma-separated) adds the user's
  // external hostname or LAN IP. The browser sends the Origin header
  // matching whatever hostname it used to reach the web UI, so the
  // hardcoded localhost:3000/ingress origins don't cover the case
  // where the user exposed the add-on's port (config.yaml ports:
  // {3000: 3000}) and is browsing via http://192.168.x.x:3000.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const allowed = [
      // The HA ingress origin (the browser's view of this app).
      process.env.HA_INGRESS_ORIGIN ?? 'http://homeassistant.local:8123',
      // Direct access via the add-on's own web port (rare; only useful
      // for in-cluster dev work). Listed second so we don't accidentally
      // trust a non-HA origin first.
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      // v0.3.5: user-configured extra origins (set via add-on
      // Configuration's allowed_origins_extra option). Each entry is
      // already trimmed; empty entries are filtered out.
      ...(process.env.ALLOWED_ORIGINS_EXTRA ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ];
    const origin = req.headers.get('origin') ?? '';
    if (origin && !allowed.includes(origin)) {
      return new Response(
        JSON.stringify({ ok: false, code: 'CSRF_REJECTED', message: `origin "${origin}" not allowed` }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // v0.2.0.5: drop the catch-all query-string passthrough. Most
  // daemon endpoints ignore query params entirely; the only one
  // that cares is `/api/chat?stream=0` (legacy non-streaming
  // response for the smoke script). Forwarding arbitrary query
  // strings would let an attacker construct a URL whose query
  // portion the daemon parsed as a parameter (e.g. ?baseUrl=...
  // echoed into logs, or ?token=... reflected to the browser).
  // Allowlist explicitly: only `stream` for /api/chat.
  let search = '';
  if (subPath === '/api/chat') {
    const s = req.nextUrl.searchParams.get('stream');
    if (s === '0' || s === '1') search = `?stream=${s}`;
  }
  const url = `${DAEMON_URL}${subPath}${search}`;

  // Build a fresh Headers object. We do NOT spread `req.headers`
  // because the browser (or another component) can set arbitrary
  // headers — Cookie, Authorization, X-CSRF-Token, etc. — that
  // we don't want the daemon to see. The daemon needs only the
  // content negotiation headers plus our internal token.
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('X-Internal-Token', TOKEN);

  let upstream: Response;
  try {
    // v0.2.0.3: forward the request body for write methods. Without
    // this, POST /api/chat's `brief` never reached the daemon (the
    // orchestrator received an empty body and immediately fell through
    // to res.end() — which is what produced the "SSE 23ms end" symptom).
    // `req.body` is a Web ReadableStream in Next.js 15+; with duplex
    // 'half' Node fetch streams it through to the daemon.
    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: 'manual',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req.body;
      // @ts-expect-error - `duplex` is a Node-fetch extension; not in
      // the DOM lib but Node's fetch honors it.
      init.duplex = 'half';
    }
    upstream = await fetch(url, init);
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, message: `daemon unreachable: ${(e as Error).message}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Pass the response through. We do NOT decode the body — let the
  // browser handle Content-Type (JSON vs SSE) natively. The daemon
  // already sets Cache-Control: no-cache + X-Accel-Buffering: no on
  // /api/chat, but we re-set X-Accel-Buffering here in case ingress
  // strips upstream headers, and we drop any content-encoding so
  // Next.js can transparently re-gzip if it wants to.
  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete('content-encoding');
  outHeaders.set('X-Accel-Buffering', 'no');
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export const GET = handle;
export const HEAD = handle;
// v0.2.0.5: the GET-only allowlist used to omit POST here entirely.
// That made `/api/daemon/api/chat` (which needs POST + SSE) come
// back 405 from Next.js's framework-level handler dispatch (NOT
// from our explicit 405 inside `handle`), which is exactly the
// "23ms end / no LLM streaming" symptom we saw in v0.2.0 smoke.
// Re-add POST so ChatPane's SSE writes can actually reach the
// daemon. The `ALLOWED_METHODS_FOR_PATH` allowlist inside `handle`
// remains the fine-grained gate (per-endpoint method whitelist +
// CSRF Origin check).
export const POST = handle;
