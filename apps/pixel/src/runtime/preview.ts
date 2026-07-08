/**
 * Preview mode — 3.3.3 parity for the visual-editor preview flow.
 *
 * When the page is opened with `?testa_preview=true&testa_preview_token=<t>`,
 * the pixel does NOT run the normal experiment cycle. Instead it fetches the
 * draft changes for that preview session from the backend and applies them,
 * so an editor can see un-published variation changes live.
 *
 * Reference: 3.3.3 `script.js` bottom IIFE guard (~1064-1074) + `handleCopyFields`.
 */

import type { VariationChange } from '@testa-platform/shared-types';

const PREVIEW_FLAG = 'testa_preview';
const PREVIEW_TOKEN = 'testa_preview_token';
/** Synthetic variation id for applied preview changes (never a real variation). */
const PREVIEW_VARIATION_ID = -1;

export interface PreviewDeps {
  /** Backend base URL (`cfPrefill.apiUrl`). */
  apiUrl: string | undefined;
  /** Applies the fetched changes (the lifecycle passes its `applyVariation`). */
  apply: (variationId: number, changes: VariationChange[]) => void;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** True when the current URL requests preview mode. */
export function isPreviewRequested(): boolean {
  if (typeof location === 'undefined') return false;
  const params = new URLSearchParams(location.search);
  return params.get(PREVIEW_FLAG) === 'true';
}

/**
 * If preview mode is requested, fetch + apply the draft changes and return
 * `true` (the caller must then SKIP the normal experiment cycle). Returns
 * `false` when preview is not requested. Never throws — a failed preview
 * fetch simply applies nothing.
 */
export function maybeEnterPreviewMode(deps: PreviewDeps): boolean {
  if (!isPreviewRequested()) return false;

  const params = new URLSearchParams(location.search);
  const token = params.get(PREVIEW_TOKEN);
  if (!token || !deps.apiUrl) return true; // preview requested but unfulfillable → still skip normal cycle

  const base = deps.apiUrl.replace(/\/$/, '');
  const doFetch = deps.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!doFetch) return true;

  void loadAndApply(doFetch, `${base}/api/preview/${encodeURIComponent(token)}`, deps.apply);
  return true;
}

async function loadAndApply(
  doFetch: typeof fetch,
  url: string,
  apply: PreviewDeps['apply'],
): Promise<void> {
  try {
    const response = await doFetch(url);
    if (!response.ok) return;
    const json = (await response.json()) as { changes?: unknown };
    const changes = normalizeChanges(json.changes);
    if (changes.length === 0) return;
    runOnLoad(() => apply(PREVIEW_VARIATION_ID, changes));
  } catch {
    // Preview is best-effort; swallow network/parse errors.
  }
}

/** Validate the fetched payload is an array of change-like objects. */
function normalizeChanges(raw: unknown): VariationChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is VariationChange =>
      typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string',
  );
}

/** Run now if the DOM is ready, else on DOMContentLoaded (3.3.3 `runOnLoad`). */
function runOnLoad(cb: () => void): void {
  if (typeof document === 'undefined') {
    cb();
    return;
  }
  if (document.readyState !== 'loading') {
    cb();
    return;
  }
  document.addEventListener('DOMContentLoaded', () => cb());
}
