/**
 * Query-param merging for redirects.
 *
 * Customer story: "I'm running a paid ad campaign with `?utm_source=fb&...`
 * — when my redirect experiment fires, I MUST keep those params on the
 * destination URL or my analytics break."
 *
 * Merge rules:
 *   - Start with the destination URL's params.
 *   - Layer the source URL's params on top, EXCEPT where the destination
 *     already specifies that key (destination wins, as it's the experiment
 *     author's explicit intent).
 *   - Drop `_testa_*` params (they're our internal SPA-detection markers).
 *
 * This is the layer that fixes the known Next.js race: we resolve the merge
 * synchronously against `currentUrl` (which the caller has snapshotted at
 * decision time), so framework-driven URL rewrites mid-flight can't corrupt
 * the destination.
 */

const TESTA_PARAM_RE = /^_testa_/;

export function mergeParams(currentUrl: string, targetUrl: string): string {
  let target: URL;
  try {
    target = new URL(targetUrl, 'https://placeholder.invalid');
  } catch {
    return targetUrl;
  }
  let current: URL;
  try {
    current = new URL(currentUrl, 'https://placeholder.invalid');
  } catch {
    return target.toString();
  }

  current.searchParams.forEach((value, key) => {
    if (TESTA_PARAM_RE.test(key)) return;
    if (target.searchParams.has(key)) return;
    target.searchParams.append(key, value);
  });

  return target.toString();
}
