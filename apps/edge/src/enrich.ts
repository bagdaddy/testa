import type { EnrichedEvent, PixelEvent } from '@testa-platform/shared-types';
import { UAParser } from 'ua-parser-js';

/**
 * Geo + UA enrichment for events flowing through the worker.
 *
 * Owns:
 *   - parsing the User-Agent header into device_type / browser / os
 *   - reading CF-set headers (CF-IPCountry, cf.region, cf.city) for geo
 *   - stamping `server_ts` (worker reception time)
 *   - IP truncation helper for denied-consent visitor_id rotation (Phase 2.4)
 *
 * Does NOT own:
 *   - bot scoring (Phase 2.4 — runs after enrich, sets is_bot)
 *   - the visitor_id itself (Phase 2.2 cookies module)
 *   - viewport, utm_*, tracker_version — those are pixel-side fields,
 *     passed through unchanged from the inbound PixelEvent.
 */

export interface CfRequestProperties {
  region?: string;
  regionCode?: string;
  city?: string;
}

export interface EnrichInputs {
  /** Pulled from `request.headers.get('user-agent')` at the route handler. */
  userAgent: string;
  /** Pulled from `request.headers.get('cf-ipcountry')`. Empty / missing → `'XX'`. */
  countryHeader: string | null;
  /** `request.cf` from the Workers runtime. Optional — undefined in tests. */
  cf?: CfRequestProperties | undefined;
}

/**
 * Pure enrichment. The route handler builds `EnrichInputs` from the inbound
 * `Request`; tests construct it directly. This keeps `enrich` independent of
 * the Workers `Request.cf` property (which is read-only and untestable).
 */
export function enrich(inputs: EnrichInputs, ev: PixelEvent): EnrichedEvent {
  const { userAgent, countryHeader, cf } = inputs;
  const parser = new UAParser(userAgent);
  const result = parser.getResult();

  const country = (countryHeader ?? '').toUpperCase() || 'XX';

  const browser = result.browser.name ?? '';
  const osName = result.os.name ?? '';
  const osVersion = result.os.version ?? '';
  const os = osName ? (osVersion ? `${osName} ${osVersion}` : osName) : '';

  return {
    ...ev,
    server_ts: Date.now(),
    country,
    region: cf?.regionCode ?? cf?.region ?? '',
    region_subdivision: cf?.region ?? '',
    city: cf?.city ?? '',
    device_type: mapDeviceType(result.device.type, userAgent),
    browser,
    os,
    is_bot: 0,
  };
}

/**
 * Truncate an IP for privacy:
 *   IPv4: drop the last octet           203.0.113.42 → 203.0.113.0
 *   IPv6: drop the last 80 bits         2001:db8:abcd:ef12:1234:5678:90ab:cdef → 2001:db8:abcd::
 *
 * Returns '' on a clearly malformed input rather than throwing — the caller
 * just won't get a usable bucket for that visitor's daily-rotated id, which
 * is fine for denied-consent semantics.
 */
export function truncateIp(ip: string): string {
  if (!ip) return '';

  // IPv4
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length !== 4) return '';
    if (parts.some((p) => !/^\d+$/.test(p))) return '';
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }

  // IPv6 (supports `::` shorthand by expanding to its first three hextets)
  if (ip.includes(':')) {
    const expanded = expandIpv6(ip);
    if (!expanded) return '';
    const parts = expanded.split(':');
    return `${parts[0]}:${parts[1]}:${parts[2]}::`;
  }

  return '';
}

function expandIpv6(ip: string): string | null {
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return null;

  // Triple-colon (`:::`) and similar artifacts are illegal.
  if (/:::/.test(ip)) return null;

  const sides = ip.split('::');
  if (sides.length > 2) return null;

  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  // Empty hextets in either side mean a leading/trailing single ':' — invalid.
  if (left.some((h) => h === '') || right.some((h) => h === '')) return null;

  const fillCount = 8 - left.length - right.length;
  if (fillCount < 0) return null;
  if (sides.length === 1 && left.length !== 8) return null;
  // `::` alone needs at least one zero to fill.
  if (sides.length === 2 && fillCount < 1) return null;

  const filled = [...left, ...Array(fillCount).fill('0'), ...right];
  if (filled.length !== 8) return null;
  return filled.map((h) => h.toLowerCase()).join(':');
}

function mapDeviceType(
  uaParserType: string | undefined,
  rawUa: string,
): EnrichedEvent['device_type'] {
  if (!rawUa) return 'unknown';
  if (uaParserType === 'mobile' || uaParserType === 'tablet') return uaParserType;
  // ua-parser leaves `device.type` empty for desktop browsers.
  if (!uaParserType) return 'desktop';
  return 'unknown';
}

/**
 * Helper for the route handler: build `EnrichInputs` from a Workers `Request`.
 */
export function inputsFromRequest(request: Request): EnrichInputs {
  return {
    userAgent: request.headers.get('user-agent') ?? '',
    countryHeader: request.headers.get('cf-ipcountry'),
    cf: (request as Request & { cf?: CfRequestProperties }).cf,
  };
}
