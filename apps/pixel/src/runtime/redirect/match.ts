/**
 * URL matching for redirect rules.
 *
 * Compares the current page URL to the experiment's `from_url` pattern.
 * Both URLs are canonicalized (lowercased host, sorted query keys, dropped
 * `_testa_*` params, stripped trailing slash) before comparison so visually-
 * equivalent URLs don't fail to match because of cosmetic differences.
 *
 * Matching modes (inferred from the pattern itself; no separate `match_type`
 * field required, mirrors VWO's behavior):
 *   - starts with `regex:`     → JS RegExp on the full URL
 *   - contains a `*` glob      → wildcard match
 *   - otherwise                → exact canonical equality
 */

const TESTA_PARAM_RE = /^_testa_/;

/**
 * Mode-aware match gate for the redirect engine, mirroring legacy `urlMatches`
 * (crobot script.js ~637-656). The rewrite `url_match_type` also selects how
 * `from_url` is matched against the current URL:
 *   - `contains` → substring test on the raw href.
 *   - `regex`    → `from_url` compiled as a `RegExp`, tested against the href.
 *   - `exact` / `query` → canonical exact/glob/regex matching via `matchesUrl`.
 */
export function matchesForMode(
  currentUrl: string,
  fromUrl: string,
  mode: 'exact' | 'contains' | 'query' | 'regex',
): boolean {
  if (!fromUrl) return false;
  if (mode === 'contains') return currentUrl.includes(fromUrl);
  if (mode === 'regex') {
    try {
      return new RegExp(fromUrl).test(currentUrl);
    } catch {
      return false;
    }
  }
  return matchesUrl(currentUrl, fromUrl);
}

export function matchesUrl(currentUrl: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.startsWith('regex:')) {
    const body = pattern.slice('regex:'.length);
    try {
      return new RegExp(body).test(currentUrl);
    } catch {
      // Bad regex — never match rather than throw.
      return false;
    }
  }
  if (pattern.includes('*')) {
    return globMatch(currentUrl, pattern);
  }
  return exactMatch(currentUrl, pattern);
}

/**
 * Exact match — origin + pathname must equal, AND every query param the
 * pattern explicitly specifies must be present on the current URL with the
 * same value.
 *
 * This means `from_url=https://x.com/a` matches `https://x.com/a?utm=fb`
 * (extra params allowed), but `from_url=https://x.com/a?id=1` does NOT match
 * `https://x.com/a` or `https://x.com/a?id=2`.
 */
function exactMatch(currentUrl: string, pattern: string): boolean {
  let cur: URL;
  let pat: URL;
  try {
    cur = new URL(currentUrl, 'https://placeholder.invalid');
    pat = new URL(pattern, 'https://placeholder.invalid');
  } catch {
    return false;
  }

  if (cur.hostname.toLowerCase() !== pat.hostname.toLowerCase()) return false;
  if (normalizePath(cur.pathname) !== normalizePath(pat.pathname)) return false;

  let allMatch = true;
  pat.searchParams.forEach((value, key) => {
    if (!allMatch) return;
    if (cur.searchParams.get(key) !== value) allMatch = false;
  });
  return allMatch;
}

function normalizePath(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

/**
 * Canonical URL form for comparison + breadcrumb logs:
 *   - lowercase host
 *   - drop `_testa_*` query params (they're our own SPA-detection markers)
 *   - sort remaining query keys
 *   - strip trailing slash on path (except for root '/')
 *   - drop fragment by default (redirects don't depend on hash for VWO/ABTasty)
 */
export function canonicalize(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl, 'https://placeholder.invalid');
  } catch {
    return rawUrl;
  }

  url.hostname = url.hostname.toLowerCase();

  const params = new URLSearchParams();
  const entries: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    if (TESTA_PARAM_RE.test(key)) return;
    entries.push([key, value]);
  });
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k, v] of entries) params.append(k, v);
  url.search = params.toString();

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  url.hash = '';

  // Strip the placeholder if the input was relative, otherwise keep origin.
  return url.toString();
}

function globMatch(input: string, pattern: string): boolean {
  // Escape regex specials except `*`, then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(input);
  } catch {
    return false;
  }
}
