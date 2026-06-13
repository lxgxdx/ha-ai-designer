/**
 * URL safety — SSRF guard for user-supplied baseUrls.
 *
 * Both /api/llm/config (v0.1.22) and /api/ha/config (v0.2.0) accept
 * user-supplied URLs and then forward the user's long-lived access
 * token (for HA) or BYOK key (for LLM) as a Bearer header to that
 * host. A user-supplied URL like `http://169.254.169.254/...` would
 * let the daemon exfiltrate those credentials to the cloud-metadata
 * service, or probe the user's LAN, or — for HA in particular —
 * use the user's HA token against an attacker-controlled server
 * that simply logs it.
 *
 * validatePublicBaseUrl() is the single shared guard. It resolves
 * hostnames via DNS and rejects if ANY resolved address is in:
 *   - 127/8, ::1 (loopback)
 *   - 10/8, 172.16/12, 192.168/16, fc00::/7 (RFC1918 + ULA)
 *   - 169.254/16, fe80::/10 (link-local — includes 169.254.169.254 IMDS)
 *   - 224/4 (multicast + reserved)
 *   - 2001:db8::/32 (documentation)
 *
 * Dev-only bypass: HA_LLM_ALLOW_PRIVATE_HOSTS=1 (also warn-logged
 * on use so misuse is visible in operator logs).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { logger } from './logger.js';

export interface ValidateResult {
  ok: boolean;
  reason?: string;
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as unknown as [number, number, number, number];
  if (a === 10) return true;                  // 10/8         RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;    // 192.168/16
  if (a === 127) return true;                 // 127/8        loopback
  if (a === 169 && b === 254) return true;    // 169.254/16   link-local + IMDS
  if (a === 0) return true;                   // 0/8          "this network"
  if (a >= 224) return true;                  // 224/4        multicast + reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10  CGNAT (RFC 6598)
  if (a === 198 && b === 18) return true;     // 198.18/15    benchmarking
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lc = ip.toLowerCase().split('%')[0]!;
  if (lc === '::' || lc === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(lc)) return true; // fe80::/10
  if (/^f[cd]/i.test(lc)) return true;           // fc00::/7 ULA
  if (/^ff/i.test(lc)) return true;              // ff00::/8 multicast
  if (/^2001:db8:/i.test(lc)) return true;       // documentation
  // v0.2.0.5: IPv4-mapped IPv6 (::ffff:a.b.c.d) and NAT64 well-known
  // prefix (64:ff9b::/96) — these are valid IPv6 addresses that
  // route to an embedded IPv4 destination. Without explicit handling,
  // ::ffff:127.0.0.1 passes as "public" while it's actually
  // loopback, and ::ffff:169.254.169.254 passes while it routes
  // to the AWS / GCP / Azure instance-metadata service. Pull the
  // embedded IPv4 out and recurse through the IPv4 check.
  //
  // We accept BOTH forms because Node and curl are inconsistent
  // about which form DNS / Node returns:
  //   dotted-decimal: ::ffff:127.0.0.1
  //   hextet:        ::ffff:7f00:1     (127.0.0.1 = 0x7f000001)
  const v4mapped =
    lc.match(/^::ffff:((?:\d+\.){3}\d+)$/i) ??
    lc.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4mapped) {
    const v4 = v4mapped[1]!.includes('.')
      ? v4mapped[1]!
      : `${parseInt(v4mapped[1]!, 16)}.${parseInt(v4mapped[2]!, 16)}`;
    if (isPrivateIPv4(v4)) return true;
  }
  const nat64 =
    lc.match(/^64:ff9b::((?:\d+\.){3}\d+)$/i) ??
    lc.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (nat64) {
    const v4 = nat64[1]!.includes('.')
      ? nat64[1]!
      : `${parseInt(nat64[1]!, 16)}.${parseInt(nat64[2]!, 16)}`;
    if (isPrivateIPv4(v4)) return true;
  }
  return false;
}

function isPrivateOrLoopbackIP(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true;
}

export async function validatePublicBaseUrl(url: string): Promise<ValidateResult> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol: ${u.protocol}` };
  }
  const host = u.hostname;
  if (isIP(host)) {
    return isPrivateOrLoopbackIP(host)
      ? { ok: false, reason: `IP ${host} is in a private/loopback/link-local range` }
      : { ok: true };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (e) {
    return { ok: false, reason: `DNS resolution failed for ${host}: ${(e as Error).message}` };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: `no DNS records for ${host}` };
  }
  for (const a of addrs) {
    if (isPrivateOrLoopbackIP(a.address)) {
      return {
        ok: false,
        reason: `hostname ${host} resolves to ${a.address} (private/loopback/link-local)`,
      };
    }
  }
  return { ok: true };
}

/**
 * Dev-only bypass for the SSRF guard (e.g. local ollama on
 * 127.0.0.1, or a self-hosted HA on a private IP during initial
 * development). Always pair with a `logger.warn` at the call site
 * so misuse is visible in operator logs.
 */
export function isPrivateHostBypassEnabled(): boolean {
  return process.env.HA_LLM_ALLOW_PRIVATE_HOSTS === '1';
}

/** Convenience: reject unless public, with logging. */
export async function ensurePublicBaseUrl(
  label: string,
  url: string,
): Promise<ValidateResult> {
  if (isPrivateHostBypassEnabled()) {
    logger.warn({ label, url }, 'SSRF guard bypassed via HA_LLM_ALLOW_PRIVATE_HOSTS=1');
    return { ok: true };
  }
  const v = await validatePublicBaseUrl(url);
  if (!v.ok) {
    logger.warn({ label, url, reason: v.reason }, 'rejected user-supplied baseUrl (SSRF guard)');
  }
  return v;
}
