/**
 * Canonical URL — used by the SPA navigation handler to decide whether a
 * `_testa:locationchange` event represents a *meaningful* navigation that
 * should re-run the experiment cycle.
 *
 * The canonical form drops:
 *   - The fragment (`#anchor`) by default. (Per-project setting `spa.hash_routes`
 *     can flip this on for hash-based routers; out of scope for this file —
 *     the caller decides whether to include the hash before passing in.)
 *   - All `_testa_*` query params we add ourselves (`_testa_cd`, `_tu`, etc.)
 *     so cross-domain redirects don't look like "new" URLs.
 *
 * Query keys are sorted alphabetically so `?b=2&a=1` and `?a=1&b=2` canonicalize
 * to the same string — Next.js routers reorder these freely.
 *
 * Host is lowercased; path keeps its case (paths are case-sensitive on most servers).
 */

const TESTA_PARAM_PREFIX = '_testa_';
const CROSS_DOMAIN_PARAM = '_tu';

export interface CanonicalizeOptions {
  /** Default false — drop the fragment. Set true for projects with `spa.hash_routes`. */
  includeHash?: boolean;
}

/**
 * Canonicalize a URL into a string suitable for equality comparison.
 *
 * Returns the input unchanged if URL parsing fails (malformed input — degrade
 * gracefully rather than throwing).
 */
export function canonicalize(input: string, opts: CanonicalizeOptions = {}): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  // Strip _testa_* params + the cross-domain visitor-id param.
  const keptKeys: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (key.startsWith(TESTA_PARAM_PREFIX)) continue;
    if (key === CROSS_DOMAIN_PARAM) continue;
    if (!keptKeys.includes(key)) keptKeys.push(key);
  }
  keptKeys.sort();

  // Build a deterministic query string from the sorted, filtered keys.
  // Multiple values for the same key are preserved (unlikely in practice
  // but cheap to handle).
  const sortedQuery: [string, string][] = [];
  for (const key of keptKeys) {
    for (const value of url.searchParams.getAll(key)) {
      sortedQuery.push([key, value]);
    }
  }

  const queryString = sortedQuery
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const host = url.host.toLowerCase();
  const port = url.port ? `:${url.port}` : '';
  const protoHostPort = `${url.protocol}//${host}${port === url.host ? '' : ''}`;
  const path = url.pathname;
  const query = queryString ? `?${queryString}` : '';
  const hash = opts.includeHash ? url.hash : '';

  return `${protoHostPort}${path}${query}${hash}`;
}
