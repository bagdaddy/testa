import type { Env } from './types.ts';

/**
 * First-party cookie module for the edge worker.
 *
 * Owns:
 *   - reading `_testa_uuid` from the inbound `Cookie` header
 *   - generating a fresh UUIDv4 when absent
 *   - deciding the `Domain=` attribute (CNAME mode → customer's domain;
 *     shared mode → COOKIE_FALLBACK_DOMAIN)
 *   - building the refresh `Set-Cookie` header (2-year Max-Age, SameSite=Lax, Secure)
 *
 * Does NOT own:
 *   - denied-consent visitor_id rotation (Phase 2.3 enrich)
 *   - the per-experiment `_testa_exp_*` / `_testa_freq_*` / `_testa_mutex_*` cookies —
 *     those are pixel-side (Phase 3.3), not edge-side.
 *
 * v1 ships without `HttpOnly` because the pixel runtime needs to read `_testa_uuid`.
 */

export const UUID_COOKIE = '_testa_uuid';
export const TWO_YEARS_SECONDS = 63_072_000;

export interface VisitorIdResult {
  visitor_id: string;
  is_new: boolean;
  set_cookie_header: string;
}

/**
 * Read or mint a `_testa_uuid` for this request.
 *
 * On a returning visitor: returns their existing id and a refresh `Set-Cookie`
 * (resets Max-Age, so the cookie keeps rolling forward).
 *
 * On a new visitor: mints a UUIDv4 (`crypto.randomUUID()` is built into the
 * Workers runtime and Node 19+; we never fall back to weak randomness).
 */
export async function getOrCreateVisitorId(request: Request, env: Env): Promise<VisitorIdResult> {
  const cookies = parseCookies(request.headers.get('cookie') ?? '');
  const existing = cookies[UUID_COOKIE];

  let visitor_id: string;
  let is_new: boolean;
  if (existing && isValidUuid(existing)) {
    visitor_id = existing;
    is_new = false;
  } else {
    visitor_id = crypto.randomUUID();
    is_new = true;
  }

  const host = new URL(request.url).hostname;
  const domain = await domainForHost(host, env);
  const set_cookie_header = buildSetCookie(visitor_id, domain, TWO_YEARS_SECONDS);

  return { visitor_id, is_new, set_cookie_header };
}

/**
 * Build a `Set-Cookie` header that EVICTS the `_testa_uuid` cookie on the
 * given domain. Used for denied-consent state (Phase 2.3 enrich will call this).
 */
export function evictUuidCookie(domain: string): string {
  return buildSetCookie('', domain, 0);
}

/**
 * Decide which `Domain=` attribute to set, given the request's host and the
 * KV-backed customer-host index.
 *
 * Logic:
 *   - host is a `*.workers.dev` (CF-default deployment) → fallback domain
 *   - host matches `KV.customer_hosts:<parent>` → `.<parent>` (CNAME mode)
 *   - everything else → fallback
 *
 * The index is populated by crobot's PublishProjectConfigToKV job (Phase 5.4).
 * v1 worker tolerates an empty index and just uses the fallback.
 */
export async function domainForHost(host: string, env: Env): Promise<string> {
  const fallback = env.COOKIE_FALLBACK_DOMAIN || '.testa.com';

  // CF-default *.workers.dev hosts → fallback (no first-party benefit anyway).
  if (host.endsWith('.workers.dev')) return fallback;

  // CNAME mode: caller's host is e.g. `track.acme.com`.
  // Strip any `track.` / `t.` prefix to get the parent eTLD+1 we want to scope to.
  const parent = stripTrackingSubdomain(host);
  if (!parent) return fallback;

  // Check the customer-host index in KV. Missing key → not a CNAME customer.
  const known = await env.KV_PROJECT_CONFIG.get(`customer_hosts:${parent}`);
  if (known === null) return fallback;

  return `.${parent}`;
}

/**
 * Strip a leading tracking subdomain. Returns null if the host doesn't have a
 * recognizable tracking prefix.
 *
 *   track.acme.com    → acme.com
 *   t.acme.com        → acme.com
 *   acme.com          → null
 *   www.acme.com      → null   (we never set a cookie on a customer's www)
 *   track.example.co.uk → example.co.uk    (best effort; PSL not used in v1)
 */
export function stripTrackingSubdomain(host: string): string | null {
  const parts = host.toLowerCase().split('.');
  if (parts.length < 3) return null;
  const prefix = parts[0];
  if (prefix !== 'track' && prefix !== 't') return null;
  return parts.slice(1).join('.');
}

/** Parse a raw `Cookie` header value into a name → value map. Last value wins. */
export function parseCookies(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) out[name] = decodeCookieValue(value);
  }
  return out;
}

function decodeCookieValue(v: string): string {
  // Strip surrounding double quotes that some clients send.
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Build a `Set-Cookie` header string for `_testa_uuid`.
 *
 * Common attributes baked in:
 *   - Path=/  (always cookie-wide)
 *   - SameSite=Lax  (compatible with cross-site GETs from the customer's site)
 *   - Secure  (Workers-served cookies are always over TLS in production)
 *   - no HttpOnly (pixel runtime reads it; revisit per Phase 3.3 if that changes)
 */
function buildSetCookie(value: string, domain: string, maxAgeSec: number): string {
  return [
    `${UUID_COOKIE}=${value}`,
    `Domain=${domain}`,
    `Max-Age=${maxAgeSec}`,
    'Path=/',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(v: string): boolean {
  return UUID_RE.test(v);
}
