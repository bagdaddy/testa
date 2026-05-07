/**
 * Legacy `window.Analytica.*` surface — every field 3.6 customers depend on.
 *
 * Reference: `docs/reference/legacy-globals-inventory.md` (full inventory).
 *
 * The 4.0 runtime still owns the canonical state (cookies, consent, transport,
 * etc.). The legacy module mirrors a few of those fields onto `window.Analytica`
 * so customer code that reads them at any lifecycle point sees the right value.
 *
 * Mutators of mirrored state (cookies.setAssignment, etc.) are NOT proxied
 * here — that would couple every module back to legacy. Instead we expose a
 * small `publish*` API that the canonical writers call after their own writes.
 *
 * `eventEmitter` is the most-depended-on customer pattern: integrations call
 * `Analytica.eventEmitter.on('variation_applied', ...)` to push variation
 * fires into GTM / Segment. Phase 3.9 (variation apply) calls
 * `legacy.fireEvent('variation_applied', data)` after each apply so this
 * keeps working unchanged.
 */

import { type AnalyticaEventEmitter, createEventEmitter } from './event-emitter.ts';

// ─── constants (per the inventory; these don't change at runtime) ──────────

const CONST = {
  COOKIE_NAME: '_testa_exp',
  SESSION_COOKIE: '_testa_ses',
  USER_COOKIE: '_testa_user',
  UUID_COOKIE: '_testa_uuid',
  EXCLUDED_COOKIE: '_testa_excl',
  FREQ_COOKIE: '_testa_freq',
  MUTEX_COOKIE: '_testa_mutex',
  CROSS_DOMAIN_PARAM: '_testa_cd',
  SESSION_LENGTH: 60 * 60 * 1000,
  CLICK_SELECTOR_TIMEOUT: 100,
  CLICK_SELECTOR_MAX_TRIES: 3,
  NEXTJS_TIMEOUT_MS: 1000,
  NEXTJS_CHECK_INTERVAL: 50,
  VARIATION_APPLIED_KEY: 'variation_applied',
  VARIATION_ASSIGNED_KEY: 'variation_assigned',
} as const;

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
} as const;

// ─── types matching 3.6's mutable-state shapes ─────────────────────────────

type ExperimentId = number | string;

interface AnalyticaState {
  // Constants
  readonly COOKIE_NAME: typeof CONST.COOKIE_NAME;
  readonly SESSION_COOKIE: typeof CONST.SESSION_COOKIE;
  readonly USER_COOKIE: typeof CONST.USER_COOKIE;
  readonly UUID_COOKIE: typeof CONST.UUID_COOKIE;
  readonly EXCLUDED_COOKIE: typeof CONST.EXCLUDED_COOKIE;
  readonly FREQ_COOKIE: typeof CONST.FREQ_COOKIE;
  readonly MUTEX_COOKIE: typeof CONST.MUTEX_COOKIE;
  readonly CROSS_DOMAIN_PARAM: typeof CONST.CROSS_DOMAIN_PARAM;
  readonly CLICK_SELECTOR_TIMEOUT: number;
  readonly CLICK_SELECTOR_MAX_TRIES: number;
  readonly NEXTJS_TIMEOUT_MS: number;
  readonly NEXTJS_CHECK_INTERVAL: number;
  readonly VARIATION_APPLIED_KEY: string;
  readonly VARIATION_ASSIGNED_KEY: string;
  readonly headers: typeof HEADERS;

  // Configuration (set once in install)
  domain: string;
  environment: string;
  geoData: Record<string, string>;
  project: unknown;
  isNextApp: boolean;
  spa: 0 | 1;
  lsEnabled: 0 | 1;
  nextContentLoaded: boolean;
  SESSION_LENGTH: number;

  // Mutable state — kept in sync via publish* APIs
  uuid: string | null;
  url: string;
  cookies: Record<ExperimentId, ExperimentId>;
  ses: Record<ExperimentId, number>;
  usr: Record<ExperimentId, number>;
  excl: Record<ExperimentId, 0 | 1>;
  freq: Record<ExperimentId, { count: number; window_start_ts: number }>;
  mutex: Record<string, ExperimentId>;
  sent: Record<ExperimentId, 0 | 1>;
  isLoaded: boolean;
  isRedirecting: boolean;
  processing: 0 | 1;

  // Methods / objects
  eventEmitter: AnalyticaEventEmitter;
  listeners: Array<[string, (data: unknown) => void]>;
  pushEvent: (name: string, data?: unknown) => void;
}

declare global {
  interface Window {
    Analytica?: AnalyticaState;
    crbData?: unknown;
    apiUrl?: string;
    testa_env?: string;
    testaLoaded?: boolean;
  }
}

// ─── installer ─────────────────────────────────────────────────────────────

let _emitter: AnalyticaEventEmitter | null = null;

/**
 * Install the legacy surface on `window.Analytica`. Idempotent: a second call
 * preserves the existing emitter / listeners array (so customer handlers
 * registered before runtime hydration aren't dropped).
 *
 * `pushEvent` is wired by the lifecycle module (which knows about goals etc.) —
 * this installer takes a callback so we don't import upward.
 */
export function installLegacy(opts: {
  pushEvent: (name: string, data?: unknown) => void;
}): AnalyticaState {
  const existing = window.Analytica as AnalyticaState | undefined;

  // If a customer's site code has already touched Analytica.listeners or
  // .eventEmitter (rare but possible), preserve those references.
  const carried = existing
    ? { listeners: existing.listeners, eventEmitter: existing.eventEmitter }
    : null;

  const { emitter, listeners } = carried
    ? { emitter: carried.eventEmitter, listeners: carried.listeners }
    : createEventEmitter();
  _emitter = emitter;

  const isNextApp = detectNextApp();

  const state: AnalyticaState = {
    ...CONST,
    headers: HEADERS,

    domain: (window.cfPrefill as { apiUrl?: string } | undefined)?.apiUrl ?? window.apiUrl ?? '',
    environment:
      (window.cfPrefill as { env?: string } | undefined)?.env ?? window.testa_env ?? 'production',
    geoData: (window.cfGeoData as Record<string, string> | undefined) ?? {},
    project: window.cfPrefill?.project ?? window.crbData ?? null,
    isNextApp,
    spa: existing?.spa ?? 0,
    lsEnabled: existing?.lsEnabled ?? 1,
    nextContentLoaded: existing?.nextContentLoaded ?? true,
    SESSION_LENGTH: CONST.SESSION_LENGTH,

    uuid: existing?.uuid ?? null,
    url: typeof location !== 'undefined' ? location.href : '',
    cookies: existing?.cookies ?? {},
    ses: existing?.ses ?? {},
    usr: existing?.usr ?? {},
    excl: existing?.excl ?? {},
    freq: existing?.freq ?? {},
    mutex: existing?.mutex ?? {},
    sent: existing?.sent ?? {},
    isLoaded: existing?.isLoaded ?? false,
    isRedirecting: existing?.isRedirecting ?? false,
    processing: 0,

    eventEmitter: emitter,
    listeners,
    pushEvent: opts.pushEvent,
  };

  window.Analytica = state;
  window.testaLoaded = window.testaLoaded ?? false;
  return state;
}

// ─── publish API for canonical state writers ───────────────────────────────

export function publishUuid(uuid: string | null): void {
  if (window.Analytica) window.Analytica.uuid = uuid;
}

export function publishUrl(url: string): void {
  if (window.Analytica) window.Analytica.url = url;
}

export function publishCookieAssignment(
  experimentId: ExperimentId,
  variationId: ExperimentId,
): void {
  if (window.Analytica) window.Analytica.cookies[experimentId] = variationId;
}

export function publishSession(experimentId: ExperimentId, expiry: number): void {
  if (window.Analytica) window.Analytica.ses[experimentId] = expiry;
}

export function publishExclusion(experimentId: ExperimentId, excluded: boolean): void {
  if (window.Analytica) window.Analytica.excl[experimentId] = excluded ? 1 : 0;
}

export function publishFreq(
  experimentId: ExperimentId,
  counter: { count: number; window_start_ts: number },
): void {
  if (window.Analytica) window.Analytica.freq[experimentId] = counter;
}

export function publishMutex(group: string, experimentId: ExperimentId): void {
  if (window.Analytica) window.Analytica.mutex[group] = experimentId;
}

export function publishLeadSent(experimentId: ExperimentId): void {
  if (window.Analytica) window.Analytica.sent[experimentId] = 1;
}

export function publishLoaded(): void {
  if (window.Analytica) window.Analytica.isLoaded = true;
  window.testaLoaded = true;
}

export function publishRedirecting(active: boolean): void {
  if (window.Analytica) window.Analytica.isRedirecting = active;
}

export function fireEvent(name: string, data?: unknown): void {
  _emitter?.emit(name, data);
}

// ─── Next.js detection (matches 3.6 heuristics) ────────────────────────────

function detectNextApp(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if ((window as unknown as { __NEXT_DATA__?: unknown }).__NEXT_DATA__) return true;
  try {
    if (document.querySelector('#__next')) return true;
    if (document.querySelector('[data-reactroot]')) return true;
    if (document.querySelector('script[src*="/_next/"]')) return true;
  } catch {
    // ignore
  }
  return false;
}

// ─── test reset hook ───────────────────────────────────────────────────────

export function __resetForTests(): void {
  _emitter = null;
  if (typeof window !== 'undefined') {
    (window as unknown as { Analytica?: unknown }).Analytica = undefined;
  }
}
