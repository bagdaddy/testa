/**
 * Per-experiment redirect-already-fired guard.
 *
 * Bug we are explicitly avoiding: redirect loops. If `from=/a` → `to=/b`
 * matches and the same experiment is also active on `/b` (because it's
 * still listed under "active"), we'd bounce back. The guard records "this
 * visitor already redirected for experiment X" and skips re-entry.
 *
 * Storage: `_testa_redirected_<expId>` cookie. 30-day TTL — long enough to
 * cover a campaign window, short enough that long-running visitors can
 * re-enter on cookie expiry.
 *
 * Same module shape as cookies.ts so the test harness can clear it the same
 * way (writeValue / readValue / eraseValue from storage.ts).
 */

import { SECONDS_PER_DAY, eraseValue, readValue, writeValue } from '../storage.ts';

export const REDIRECTED_COOKIE = '_testa_redirected';
const REDIRECTED_TTL_SEC = 30 * SECONDS_PER_DAY;

export const redirectedName = (experimentId: number | string): string =>
  `${REDIRECTED_COOKIE}_${experimentId}`;

export function hasRedirected(experimentId: number | string): boolean {
  return readValue(redirectedName(experimentId)) === '1';
}

export function markRedirected(experimentId: number | string): void {
  writeValue(redirectedName(experimentId), '1', { maxAgeSec: REDIRECTED_TTL_SEC });
}

export function clearRedirected(experimentId: number | string): void {
  eraseValue(redirectedName(experimentId));
}
