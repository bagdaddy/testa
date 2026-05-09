/**
 * Shared test reset helper.
 *
 * Most pixel test suites need to clear the same set of state before each
 * test: window globals, cookies, web storage, runtime modules. Each suite
 * was rolling its own boilerplate, which drifted (e.g. some forgot to
 * reset the redirect breadcrumbs, others missed the network module).
 *
 * Use this from `beforeEach`:
 *
 *   import { resetPixelState } from '../../__test-utils__/reset.ts';
 *   beforeEach(async () => { await resetPixelState(); });
 */

import { consent } from '../runtime/consent.ts';
import {
  __clearPendingEventsForTests,
  __resetForTests as resetLifecycle,
} from '../runtime/lifecycle.ts';
import { __resetForTests as resetHealth } from '../runtime/network/health.ts';
import { __resetForTests as resetOutbox } from '../runtime/network/outbox.ts';
import { __resetForTests as resetTransport } from '../runtime/network/transport.ts';
import { __resetForTests as resetRedirectBreadcrumbs } from '../runtime/redirect/breadcrumbs.ts';

const WINDOW_KEYS = ['_testa', '_testa_patched_v4', 'cfPrefill', 'cfGeoData', '__pixel_debug'];

export async function resetPixelState(): Promise<void> {
  resetWindowGlobals();
  clearAllCookies();
  clearStorages();
  consent.__resetForTests();
  resetLifecycle();
  __clearPendingEventsForTests();
  resetHealth();
  resetTransport();
  resetRedirectBreadcrumbs();
  await resetOutbox();
}

export function resetWindowGlobals(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  for (const key of WINDOW_KEYS) {
    w[key] = undefined;
  }
}

export function clearAllCookies(): void {
  if (typeof document === 'undefined') return;
  for (const c of document.cookie.split(';')) {
    const eq = c.indexOf('=');
    const name = (eq < 0 ? c : c.slice(0, eq)).trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
  }
}

export function clearStorages(): void {
  try {
    localStorage.clear();
  } catch {
    // ignore — Safari Private Mode etc.
  }
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
}
