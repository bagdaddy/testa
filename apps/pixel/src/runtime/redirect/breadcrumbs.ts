/**
 * Structured breadcrumb log for redirect decisions.
 *
 * Customer-side debugging hook: every decision the redirect engine makes
 * (matched, skipped, fired, deduped) lands in `window.__pixel_debug.redirects`
 * as a ring buffer. Crobot can pull this for support escalations; customer
 * SmartCode can read it via `_testa.debug()`.
 *
 * Why this exists at all: we have a known SPA / Next.js redirect bug we
 * cannot reproduce locally (memory: known_pixel_spa_bug). The only way to
 * ship a fix that's actually a fix is to instrument every decision so we
 * can correlate symptoms with breadcrumbs from real customer pages.
 */

const MAX_ENTRIES = 50;

export type RedirectPhase =
  | 'evaluate'
  | 'match'
  | 'no_match'
  | 'already_redirected'
  | 'fired'
  | 'skipped_same_url'
  | 'aborted_invalid_target';

export interface RedirectBreadcrumb {
  ts: number;
  phase: RedirectPhase;
  experiment_id: number | string;
  variation_id: number | string;
  from?: string;
  to?: string;
  message?: string;
}

interface PixelDebug {
  redirects?: RedirectBreadcrumb[];
}

export function logRedirect(entry: RedirectBreadcrumb): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __pixel_debug?: PixelDebug };
  if (!w.__pixel_debug) w.__pixel_debug = {};
  if (!Array.isArray(w.__pixel_debug.redirects)) w.__pixel_debug.redirects = [];
  const log = w.__pixel_debug.redirects;
  log.push(entry);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
}

export function readBreadcrumbs(): readonly RedirectBreadcrumb[] {
  if (typeof window === 'undefined') return [];
  const w = window as unknown as { __pixel_debug?: PixelDebug };
  return w.__pixel_debug?.redirects ?? [];
}

export function __resetForTests(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __pixel_debug?: PixelDebug };
  if (w.__pixel_debug) w.__pixel_debug.redirects = [];
}
