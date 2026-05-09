/**
 * Redirect engine — the third pillar (alongside tracking and targeting) where
 * we are explicitly trying to beat VWO and ABTasty.
 *
 * Decisions baked in here:
 *   1. Pixel-decided. Edge worker isn't in the redirect path because 99% of
 *      customers integrate via JS pixel (project memory: pixel_is_primary).
 *   2. URL match is canonical (sorted query, lowercased host, dropped
 *      `_testa_*`, stripped trailing slash) — see `match.ts`.
 *   3. Query params from the current URL flow into the destination unless
 *      the destination explicitly overrides them — see `merge-params.ts`.
 *      This is the layer that closes the Next.js race-condition gap: we
 *      snapshot the current URL ONCE at decision time and operate on the
 *      snapshot, so framework-driven rewrites mid-flight can't corrupt the
 *      target.
 *   4. Once-per-experiment dedup via `_testa_redirected_<expId>` cookie —
 *      see `dedup.ts`. Prevents bounce-loops when the same experiment is
 *      "active" on both the from-URL and the to-URL.
 *   5. Same-canonical-URL is a no-op. Prevents pushState() events on the
 *      same URL from re-triggering a redirect.
 *   6. `location.replace()` is used (not `assign()`) so the redirect doesn't
 *      pollute the back-button history.
 *   7. Every decision is logged to `__pixel_debug.redirects[]` — see
 *      `breadcrumbs.ts`. This is how we debug SPA failures we can't repro.
 *
 * NOT handled here (deferred):
 *   - Anti-flicker. Customer SmartCode owns this; pixel just signals readiness.
 *   - Same-page anchor changes (treated as no-op redirects).
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { type RedirectBreadcrumb, logRedirect } from './breadcrumbs.ts';
import { hasRedirected, markRedirected } from './dedup.ts';
import { canonicalize, matchesUrl } from './match.ts';
import { mergeParams } from './merge-params.ts';

export interface RedirectInputs {
  experiment_id: number | string;
  variation_id: number | string;
  /** The redirect change spec from the variation. */
  change: Extract<VariationChange, { type: 'redirect' }>;
  /** Snapshot of the current URL at decision time. */
  currentUrl: string;
}

export interface RedirectOutcome {
  /** True when we actually issued the redirect (page is going away). */
  fired: boolean;
  /** Resolved final destination URL (with merged params), if `fired === true`. */
  finalUrl?: string;
  /** Why we did or didn't redirect — mirrors the breadcrumb phase. */
  reason: RedirectBreadcrumb['phase'];
}

/**
 * Hook the host (lifecycle.ts) calls when a variation contains a `redirect`
 * change. Returns the outcome so the caller can:
 *   - abort the rest of the experiment cycle when fired = true (page is
 *     about to navigate, no point applying more variations)
 *   - log to the experiment_view event so dashboards can correlate
 *
 * In tests, inject a `navigate` function to capture the call without
 * actually navigating happy-dom.
 */
export function evaluateAndApply(
  inputs: RedirectInputs,
  navigate: (url: string) => void = defaultNavigate,
): RedirectOutcome {
  const { experiment_id, variation_id, change, currentUrl } = inputs;
  const base: Pick<RedirectBreadcrumb, 'experiment_id' | 'variation_id' | 'from' | 'to'> = {
    experiment_id,
    variation_id,
    from: currentUrl,
    to: change.to_url,
  };

  logRedirect({ ts: Date.now(), phase: 'evaluate', ...base });

  if (hasRedirected(experiment_id)) {
    logRedirect({ ts: Date.now(), phase: 'already_redirected', ...base });
    return { fired: false, reason: 'already_redirected' };
  }

  if (!change.from_url || !change.to_url) {
    logRedirect({
      ts: Date.now(),
      phase: 'aborted_invalid_target',
      ...base,
      message: 'missing from_url or to_url',
    });
    return { fired: false, reason: 'aborted_invalid_target' };
  }

  if (!matchesUrl(currentUrl, change.from_url)) {
    logRedirect({ ts: Date.now(), phase: 'no_match', ...base });
    return { fired: false, reason: 'no_match' };
  }

  const finalUrl = mergeParams(currentUrl, change.to_url);

  // Same canonical URL → no-op. Prevents history.pushState on the same URL
  // from triggering a redirect that would just re-match.
  if (canonicalize(finalUrl) === canonicalize(currentUrl)) {
    logRedirect({ ts: Date.now(), phase: 'skipped_same_url', ...base, to: finalUrl });
    return { fired: false, reason: 'skipped_same_url' };
  }

  logRedirect({ ts: Date.now(), phase: 'match', ...base, to: finalUrl });
  markRedirected(experiment_id);

  try {
    navigate(finalUrl);
  } catch (err) {
    logRedirect({
      ts: Date.now(),
      phase: 'aborted_invalid_target',
      ...base,
      to: finalUrl,
      message: err instanceof Error ? err.message : String(err),
    });
    return { fired: false, reason: 'aborted_invalid_target' };
  }

  logRedirect({ ts: Date.now(), phase: 'fired', ...base, to: finalUrl });
  return { fired: true, finalUrl, reason: 'fired' };
}

function defaultNavigate(url: string): void {
  if (typeof window === 'undefined') return;
  // location.replace doesn't push a history entry — back-button still works
  // as if the redirect URL was the original landing page.
  window.location.replace(url);
}

export { canonicalize, matchesUrl, mergeParams, hasRedirected, markRedirected };
export type { RedirectBreadcrumb };
