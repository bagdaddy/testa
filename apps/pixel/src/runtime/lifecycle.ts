/**
 * Runtime lifecycle — the composition root that wires together all the
 * modules built in earlier Phase 3 tasks (cookies, consent, audience,
 * traffic) into a single hydration sequence.
 *
 * What this owns:
 *   1. Replace `window._testa` stub method bodies with live implementations.
 *   2. Drain `window._testa.q` (calls customers made before the runtime loaded).
 *   3. Listen for `_testa:locationchange` and re-run the experiment cycle on
 *      SPA route changes (without re-doing one-time init).
 *   4. Run the first experiment-resolution cycle and fire `_testa.load()`.
 *
 * What this does NOT own:
 *   - Network transport (Phase 3.6 — `network/transport.ts`). Until that lands,
 *     events go to an in-memory `_pendingEvents` array exported here for
 *     observability. 3.6's hydrate hook will replace the sink.
 *   - Variation application (Phase 3.9 — `experiments/apply/`). For now the
 *     cycle assigns + records the variation_id but doesn't mutate the DOM.
 *   - SPA navigation re-eval semantics beyond "rerun cycle on locationchange"
 *     — full debounce + canonical-URL diff lives in Phase 3.5.
 */

import type {
  AudienceCondition,
  ExperimentConfig,
  ProjectConfig,
} from '@testa-platform/shared-types';
import type { ConsentState } from '@testa-platform/shared-types';
import * as consentMod from './consent.ts';
import * as cookies from './cookies.ts';
import { type Teardown, applyVariation } from './experiments/apply/index.ts';
import {
  type AssignResult,
  type Experiment,
  assign,
  recordExposure,
} from './experiments/traffic.ts';
import { type EvalContext, evaluate } from './rules/audience.ts';
import { installSpaHandler } from './spa.ts';

const LOCATIONCHANGE_EVENT = '_testa:locationchange';

interface PendingEvent {
  name: string;
  props: Record<string, unknown>;
  ts: number;
}

interface CfPrefill {
  project?: ProjectConfig;
  apiUrl?: string;
  env?: string;
}

interface PixelDebug {
  cycles: Array<{
    ts: number;
    url: string;
    matchedExperiments: number;
    excludedExperiments: number;
  }>;
  errors: Array<{ ts: number; phase: string; message: string }>;
}

declare global {
  interface Window {
    cfPrefill?: CfPrefill;
    cfGeoData?: { country?: string; region?: string };
    __pixel_debug?: PixelDebug;
  }
}

const MAX_DEBUG_ENTRIES = 50;
let _pendingEvents: PendingEvent[] = [];
let _alreadyHydrated = false;
/** DOM-watching teardowns from the previous cycle's appliers; disposed at the start of each cycle. */
let _activeTeardowns: Teardown[] = [];

/**
 * Top-level entry. Idempotent. Errors anywhere in the pipeline are
 * caught and routed to `_pixel_health` (a synthetic event the network
 * module will pick up on flush, Phase 3.6).
 */
export function hydrate(): void {
  if (_alreadyHydrated) return;
  _alreadyHydrated = true;

  ensurePixelDebug();
  applyConsentMode();

  guardedInit('cmp_listener', () => consentMod.installCmpListener());
  guardedInit('live_api', installLiveApi);
  guardedInit('spa_listener', installSpaListener);

  // First experiment cycle. Drain queue first so any pre-runtime calls
  // (e.g. `_testa.consent('denied')` set BEFORE the loader fired) win
  // before the cycle reads consent state.
  guardedInit('drain_queue', drainQueue);
  guardedInit('first_cycle', () => {
    runExperimentCycle();
  });

  // Fire load() once. SPA re-evaluations don't re-fire it.
  guardedInit('fire_ready', fireReady);
}

// ─── live API installation ─────────────────────────────────────────────────

function installLiveApi(): void {
  const stub = window._testa;
  if (!stub) return;

  // Replace each queued-by-default method with a live impl. The `_loaded`
  // and `q` properties stay so customers' SmartCode listening for them
  // doesn't break.
  stub.track = (name, props) => {
    track(name, props);
  };
  stub.trackPurchase = (value, currency, orderId, items) => {
    track('purchase', {
      value_native: value,
      currency,
      order_id: orderId,
      ...(items !== undefined ? { items_count: items } : {}),
    });
  };
  stub.consent = (state) => {
    consentMod.consent.setState(state);
  };
  stub.identify = (visitorId) => {
    // Store in a custom-namespaced cookie that Phase 5/6 picks up to merge
    // with the worker-set _testa_uuid. For now: no-op until that flow lands.
    void visitorId;
  };
  stub.navigate = (url) => {
    // Programmatic SPA navigation hint. We don't change history here —
    // customer / framework code does that. We just dispatch the event so
    // re-eval runs on the new URL even if monkey-patch missed it.
    void url;
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
  };
  stub._hydrated = true;
}

// ─── queue draining ────────────────────────────────────────────────────────

function drainQueue(): void {
  const stub = window._testa;
  if (!stub) return;
  const queued = stub.q.slice();
  stub.q.length = 0;
  for (const call of queued) {
    replayCall(call);
  }
}

function replayCall(call: unknown): void {
  if (!Array.isArray(call) || call.length === 0) return;
  const [method, ...args] = call as [string, ...unknown[]];
  switch (method) {
    case 'track':
      track(args[0] as string, args[1] as Record<string, unknown> | undefined);
      break;
    case 'trackPurchase':
      track('purchase', {
        value_native: args[0] as number,
        currency: args[1] as string,
        order_id: args[2] as string,
        ...(args[3] !== undefined ? { items_count: args[3] as number } : {}),
      });
      break;
    case 'consent':
      consentMod.consent.setState(args[0] as ConsentState);
      break;
    case 'identify':
      // no-op for now (see installLiveApi)
      break;
    case 'navigate':
      window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
      break;
  }
}

// ─── tracking ──────────────────────────────────────────────────────────────

/**
 * Live `track()`. Until Phase 3.6 ships network transport, events queue up
 * here for inspection / Phase 3.6 to pick up.
 *
 * Strict-consent gating: when consent.isHeld() is true, drop the event
 * (the strict mode contract is "no tracking without explicit grant").
 * Re-firing on grant is Phase 3.6's responsibility.
 */
export function track(name: string, props?: Record<string, unknown>): void {
  if (consentMod.consent.isHeld()) return;
  _pendingEvents.push({ name, props: props ?? {}, ts: Date.now() });
}

/** Test/Phase 3.6 hook: read the in-memory event queue. */
export function __getPendingEventsForTests(): readonly PendingEvent[] {
  return _pendingEvents;
}

/** Test/Phase 3.6 hook: clear the in-memory event queue. */
export function __clearPendingEventsForTests(): void {
  _pendingEvents = [];
}

// ─── SPA listener (debounce + canonical URL diff via spa.ts) ───────────────

let _spaUninstall: (() => void) | null = null;

function installSpaListener(): void {
  // Idempotent: dispose any prior listener first.
  _spaUninstall?.();
  _spaUninstall = installSpaHandler({
    onTransition: () => {
      guardedInit('spa_cycle', () => {
        runExperimentCycle();
      });
    },
    // TODO(phase 3.x admin UI): wire `spa.hash_routes` per-project setting.
    includeHash: false,
  });
}

// ─── experiment resolution cycle ───────────────────────────────────────────

/**
 * One pass over every experiment in the project config:
 *   1. Build EvalContext from cookies + DOM + cfPrefill.
 *   2. Filter experiments whose audience matches.
 *   3. assign() each match → cookie + variation_id (or excluded).
 *   4. For non-excluded matches: fire `experiment_view`, recordExposure.
 *   5. Variation application (DOM mutations) is deferred to Phase 3.9.
 *
 * Exported for tests + for Phase 3.5's SPA re-entry path.
 */
export function runExperimentCycle(): void {
  const project = readProject();
  if (!project) return;

  // Tear down DOM watchers from the previous cycle (SPA route change leaves
  // stale MutationObservers otherwise).
  for (const t of _activeTeardowns) {
    try {
      t();
    } catch {
      // ignore
    }
  }
  _activeTeardowns = [];

  const ctx = buildEvalContext();
  const stats = { matched: 0, excluded: 0 };

  for (const expConfig of project.experiments) {
    if (expConfig.status !== 'active') continue;

    if (expConfig.audience !== undefined && !evaluate(expConfig.audience, ctx)) {
      stats.excluded += 1;
      continue;
    }

    const exp = toTrafficExperiment(expConfig);
    const result: AssignResult = assign(exp, { visitorId: ctx.visitor.uuidOrSession });

    if (result.isExcluded) {
      stats.excluded += 1;
      continue;
    }

    stats.matched += 1;

    // Bump session cookie + record exposure + emit experiment_view.
    cookies.bumpSession(expConfig.experiment_id);
    recordExposure(exp);
    track('experiment_view', {
      experiment_id: expConfig.experiment_id,
      variation_id: result.variationId,
    });

    // Apply the chosen variation's DOM changes (Phase 3.9). The redirect
    // change type is no-op here — Phase 3.10 owns redirects.
    const variation = expConfig.variations.find((v) => v.variation_id === result.variationId);
    if (variation && variation.changes.length > 0) {
      const teardowns = applyVariation(result.variationId, variation.changes);
      _activeTeardowns.push(...teardowns);
    }
  }

  pushDebug({
    ts: Date.now(),
    url: location.href,
    matchedExperiments: stats.matched,
    excludedExperiments: stats.excluded,
  });
}

// ─── EvalContext construction ─────────────────────────────────────────────

interface BuildVisitorContext {
  isReturning: boolean;
  cookies: Map<string, string>;
  uuidOrSession: string;
  dataLayer?: Record<string, unknown>;
}

function buildEvalContext(): EvalContext & { visitor: BuildVisitorContext } {
  const uuid = cookies.getUuid();
  const isReturning = uuid !== null;
  const visitorId = uuid ?? generateEphemeralVisitorId();

  const cookieMap = new Map<string, string>();
  if (typeof document !== 'undefined' && document.cookie) {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      cookieMap.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }

  const geo = window.cfGeoData ?? {};
  const dl = (window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer;
  const flatDl = Array.isArray(dl) && dl[0] && typeof dl[0] === 'object' ? dl[0] : undefined;

  return {
    page: {
      url: location.href,
      referrer: typeof document !== 'undefined' ? document.referrer : '',
    },
    visitor: {
      isReturning,
      cookies: cookieMap,
      uuidOrSession: visitorId,
      ...(flatDl !== undefined ? { dataLayer: flatDl } : {}),
    },
    geo: {
      country: geo.country ?? '',
      region: geo.region ?? '',
    },
    device: {
      type: detectDeviceType(),
      browser: '',
      os: '',
      viewportWidth: window.innerWidth || 0,
      language: navigator.language || '',
    },
    now: Date.now(),
  };
}

function detectDeviceType(): EvalContext['device']['type'] {
  const ua = navigator.userAgent || '';
  if (!ua) return 'unknown';
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobile|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

function generateEphemeralVisitorId(): string {
  // Used only when `_testa_uuid` is missing AND the worker hasn't set it
  // yet (first ever pageload before a successful /track round-trip).
  // crypto.randomUUID is in every modern browser + jsdom/happy-dom.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ephem-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

// ─── conversions ───────────────────────────────────────────────────────────

function toTrafficExperiment(config: ExperimentConfig): Experiment {
  return {
    experiment_id: config.experiment_id,
    traffic_allocation: config.traffic_allocation,
    variations: config.variations.map((v) => ({
      variation_id: v.variation_id,
      weight: v.weight,
    })),
    ...(config.frequency_cap !== undefined ? { frequency_cap: config.frequency_cap } : {}),
    ...(config.mutex_group !== undefined ? { mutex_group: config.mutex_group } : {}),
  };
}

function readProject(): ProjectConfig | undefined {
  return window.cfPrefill?.project;
}

// ─── consent mode ──────────────────────────────────────────────────────────

function applyConsentMode(): void {
  const project = readProject();
  if (project?.consent_mode === 'strict') {
    consentMod.consent.setStrictMode(true);
  }
}

// ─── lifecycle plumbing ────────────────────────────────────────────────────

function fireReady(): void {
  const stub = window._testa;
  stub?._loaded?.();
}

function ensurePixelDebug(): void {
  if (!window.__pixel_debug) {
    window.__pixel_debug = { cycles: [], errors: [] };
  }
}

function pushDebug(entry: PixelDebug['cycles'][number]): void {
  ensurePixelDebug();
  const log = window.__pixel_debug as PixelDebug;
  log.cycles.push(entry);
  if (log.cycles.length > MAX_DEBUG_ENTRIES) {
    log.cycles.splice(0, log.cycles.length - MAX_DEBUG_ENTRIES);
  }
}

function pushDebugError(phase: string, err: unknown): void {
  ensurePixelDebug();
  const log = window.__pixel_debug as PixelDebug;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log.errors.push({ ts: Date.now(), phase, message });
  if (log.errors.length > MAX_DEBUG_ENTRIES) {
    log.errors.splice(0, log.errors.length - MAX_DEBUG_ENTRIES);
  }
  // Surface as a synthetic event so 3.6's network module picks it up
  // when it lands. No transport yet → just queues.
  _pendingEvents.push({
    name: '_pixel_health',
    props: { error_phase: phase, error_message: message },
    ts: Date.now(),
  });
}

function guardedInit(phase: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    pushDebugError(phase, err);
  }
}

/** Test reset hook. Forgets `_alreadyHydrated`, clears in-memory state. */
export function __resetForTests(): void {
  _pendingEvents = [];
  _alreadyHydrated = false;
  _spaUninstall?.();
  _spaUninstall = null;
  for (const t of _activeTeardowns) {
    try {
      t();
    } catch {
      // ignore
    }
  }
  _activeTeardowns = [];
}

// Audience type re-export for callers that don't want to depend on
// shared-types directly.
export type { AudienceCondition };
