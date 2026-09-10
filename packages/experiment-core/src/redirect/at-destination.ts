/**
 * Is the visitor standing at the DESTINATION of a split-URL redirect they are
 * assigned to?
 *
 * `resolveExposures` needs this because an experiment's page rule is written
 * against the CONTROL url. A variant visitor redirected `/question/male/1 →
 * /question/female/1` fails that rule at the destination, and having already
 * left the control page, would produce no exposure anywhere. Being at the
 * destination of a redirect you are assigned to IS the exposure.
 *
 * The comparison has to follow `url_match_type`, because that is what BUILT the
 * destination (see build-url.ts). A single origin+path compare is correct only
 * for `exact`: under `regex` the `to_url` is a TEMPLATE (`/p/$1/checkout`) that
 * never compares equal to a real URL, and under `contains`/`query` the
 * destination keeps the current URL's shape rather than replacing it. Getting
 * any of those wrong drops the whole variant arm out of the exposure count,
 * which reads downstream as a sample ratio mismatch.
 *
 * Only ever consulted when the page rule already FAILED, so a control-page URL
 * never reaches here and cannot be double-counted.
 */

import { resolveMode } from './build-url.ts';
import type { RedirectChange } from './decide.ts';
import { safeUrl } from './url.ts';

/** Does `currentUrl` look like the destination this redirect change produces? */
export function isAtRedirectDestination(change: RedirectChange, currentUrl: string): boolean {
  if (!change.to_url) return false;
  switch (resolveMode(change)) {
    case 'contains':
      return matchesContains(change.to_url, currentUrl);
    case 'query':
      return matchesQuery(change.to_url, currentUrl);
    case 'regex':
      return matchesTemplate(change.to_url, currentUrl);
    default:
      return matchesExact(change.to_url, currentUrl);
  }
}

/**
 * `exact` — the destination replaces origin + pathname wholesale (query params
 * are merged on afterwards, so they are ignored here).
 */
function matchesExact(toUrl: string, currentUrl: string): boolean {
  const destination = safeUrl(toUrl, currentUrl);
  const current = safeUrl(currentUrl);
  if (!destination || !current) return false;
  if (destination.host.toLowerCase() !== current.host.toLowerCase()) return false;
  return trimSlash(destination.pathname) === trimSlash(current.pathname);
}

/**
 * `contains` — the destination is the current href with `from_url` string-
 * replaced by `to_url`, so the visitor is at it exactly when `to_url` is
 * present in the href.
 */
function matchesContains(toUrl: string, currentUrl: string): boolean {
  return currentUrl.includes(toUrl);
}

/**
 * `query` — the destination is the current URL with `to_url`'s pairs SET on it
 * (`buildQuery`), so the visitor is at it when every one of those pairs is
 * present with that value. A pair with no `=` was written as an empty value.
 */
function matchesQuery(toUrl: string, currentUrl: string): boolean {
  const current = safeUrl(currentUrl);
  if (!current) return false;
  let checked = 0;
  for (const pair of toUrl.split('&')) {
    if (!pair) continue;
    const [key, value] = pair.split('=');
    if (!key) continue;
    checked++;
    if (current.searchParams.get(key) !== (value ?? '')) return false;
  }
  return checked > 0;
}

/**
 * `regex` — `to_url` is a template whose `$1..$9` were expanded from the
 * `from_url` capture groups. The captured text is unknowable from the
 * destination alone, so match the template's SHAPE: escape it, widen each
 * backref to `.+`, and prefix-anchor it against the current URL. Query params
 * are merged onto the destination, so only the leading part can be anchored.
 */
function matchesTemplate(toUrl: string, currentUrl: string): boolean {
  const template = stripQuery(toUrl);
  if (!template) return false;
  const body = escapeRegex(template).replace(/\\\$[1-9]/g, '.+');
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^${body}`);
  } catch {
    return false;
  }
  const current = safeUrl(currentUrl);
  if (!current) return false;
  // An absolute template is anchored against the full href; a relative one
  // (`/p/$1/checkout`, what a dashboard editor authors) against the path.
  const target = isAbsolute(template) ? stripQuery(currentUrl) : current.pathname;
  return pattern.test(target) || pattern.test(trimSlash(target));
}

function isAbsolute(url: string): boolean {
  return url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url);
}

function stripQuery(url: string): string {
  return url.split(/[?#]/)[0] ?? '';
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}
