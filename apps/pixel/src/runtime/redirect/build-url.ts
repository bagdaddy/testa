/**
 * Mode-aware redirect-URL construction — ported for parity with the legacy
 * 3.3.3 `createRedirectUrl` (crobot script.js ~802-847).
 *
 * The construction is driven by `url_match_type` on the redirect change and
 * operates ONLY on the passed-in `currentUrl` snapshot — it never reads
 * `window.location` (deliberate Next.js race-condition fix). Query merging is
 * delegated to `merge-params.ts`.
 *
 * Modes (default `exact`):
 *   - `exact`    → destination origin+pathname, merging current query params
 *                  (destination wins on key conflict, current fills the rest).
 *                  Fragment is dropped, mirroring legacy origin+pathname+search.
 *   - `contains` → first-occurrence string replace of `from_url` → `to_url`
 *                  inside the current href.
 *   - `query`    → keep the current URL, set/overwrite query params parsed
 *                  from `to_url` (an `a=b&c=d` string).
 *   - `regex`    → treat `from_url` as a `RegExp`, expand `$1..$n` backrefs
 *                  (missing groups → '') into `to_url`, then sanitize any
 *                  duplicate `?` (keep the first, join the rest with `&`).
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { mergeParams } from './merge-params.ts';

type RedirectChange = Extract<VariationChange, { type: 'redirect' }>;
export type RewriteMode = NonNullable<RedirectChange['url_match_type']>;

const PLACEHOLDER_BASE = 'https://placeholder.invalid';

/** Resolve the rewrite mode, defaulting to `exact` when unspecified. */
export function resolveMode(change: RedirectChange): RewriteMode {
  return change.url_match_type ?? 'exact';
}

/**
 * Build the final redirect destination from the current URL snapshot and the
 * redirect change, honouring `url_match_type`.
 */
export function buildRedirectUrl(currentUrl: string, change: RedirectChange): string {
  switch (resolveMode(change)) {
    case 'contains':
      return buildContains(currentUrl, change);
    case 'query':
      return buildQuery(currentUrl, change);
    case 'regex':
      return buildRegex(currentUrl, change);
    default:
      return buildExact(currentUrl, change);
  }
}

function buildExact(currentUrl: string, change: RedirectChange): string {
  const merged = mergeParams(currentUrl, change.to_url);
  // Legacy exact keeps only origin + pathname + search — the fragment on the
  // destination content is intentionally dropped.
  try {
    const url = new URL(merged, PLACEHOLDER_BASE);
    url.hash = '';
    return url.toString();
  } catch {
    return merged;
  }
}

function buildContains(currentUrl: string, change: RedirectChange): string {
  // String replace with a string pattern → first occurrence only (legacy parity).
  return currentUrl.replace(change.from_url, change.to_url);
}

function buildQuery(currentUrl: string, change: RedirectChange): string {
  let url: URL;
  try {
    url = new URL(currentUrl, PLACEHOLDER_BASE);
  } catch {
    return currentUrl;
  }

  for (const pair of change.to_url.split('&')) {
    if (!pair) continue;
    const [key, value] = pair.split('=');
    if (!key) continue;
    url.searchParams.set(key, value ?? '');
  }

  return url.toString();
}

function buildRegex(currentUrl: string, change: RedirectChange): string {
  let content = change.to_url;

  let re: RegExp;
  try {
    re = new RegExp(change.from_url, 'g');
  } catch {
    // Bad pattern — expand nothing, just sanitize whatever content we have.
    return sanitizeUrl(content);
  }

  const match = re.exec(currentUrl);
  if (match) {
    for (let i = 1; i < match.length; i++) {
      // First-occurrence replace per backref, mirroring legacy String.replace.
      content = content.replace(`$${i}`, match[i] ?? '');
    }
  }

  return sanitizeUrl(content);
}

/**
 * Collapse duplicate `?` into a single query separator: keep the first `?`,
 * join the remaining segments with `&`. Mirrors legacy `sanitizeUrl`.
 */
function sanitizeUrl(url: string): string {
  const parts = url.split('?');
  if (parts.length > 2) {
    const head = parts.shift() ?? '';
    return `${head}?${parts.join('&')}`;
  }
  return url;
}
