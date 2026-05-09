/**
 * The pre-runtime queue stub for `window._testa`.
 *
 * Customer code can call `_testa.track(...)`, `_testa.consent(...)`, etc.
 * the moment the loader inlines. Each method either:
 *
 *   - drains immediately if the runtime has hydrated and replaced this stub,
 *     OR
 *   - pushes a `[method, ...args]` tuple onto `_testa.q` for the runtime to
 *     replay later.
 *
 * The runtime hydration step (Phase 3.2) replaces every method on
 * `window._testa` with the live implementation, then drains `q` in arrival
 * order. After that the queue stays around but never grows again — calls go
 * straight to live impls.
 *
 * `_testa.load()` returns a Promise that resolves when the runtime calls
 * `_testa._loaded()`. Customer SmartCode awaits this to un-hide their body.
 *
 * This module stays sync, side-effect-free at import time, and has zero
 * dependencies. It's bundled into the inlined loader response (~5 KB cap).
 */

export type ConsentState = 'granted' | 'denied' | 'unknown';

export type QueueCall =
  | ['track', string, Record<string, unknown>?]
  | ['trackPurchase', number, string, string, number?]
  | ['consent', ConsentState]
  | ['identify', string]
  | ['navigate', string];

/**
 * Read-only snapshot returned by `_testa.debug()`. Stable shape — customers
 * may script around it for monitoring. New fields can be added; existing
 * fields should not be renamed without a deprecation window.
 */
export interface TestaDebugSnapshot {
  hydrated: boolean;
  tracker_version: string;
  consent_state: ConsentState;
  consent_strict: boolean;
  visitor_id: string | null;
  session_id: string | null;
  url: string;
  /** From `window.__pixel_debug.cycles`, last 50 entries. */
  cycles: Array<{
    ts: number;
    url: string;
    matchedExperiments: number;
    excludedExperiments: number;
  }>;
  /** From `window.__pixel_debug.errors`, last 50 entries. */
  errors: Array<{ ts: number; phase: string; message: string }>;
  /** From `window.__pixel_debug.redirects`, last 50 entries. */
  redirects: Array<{
    ts: number;
    phase: string;
    experiment_id: number | string;
    from?: string;
    to?: string;
  }>;
  /** Outbox health counters (queued/sent/dropped/retried). */
  network: { queued: number; sent: number; dropped: number; retried: number; pending: number };
}

export interface TestaQueue {
  /** FIFO of pre-hydration calls. Runtime drains in order. */
  q: QueueCall[];

  track(eventName: string, props?: Record<string, unknown>): void;
  trackPurchase(value: number, currency: string, orderId: string, items?: number): void;
  consent(state: ConsentState): void;
  identify(visitorId: string): void;
  navigate(url: string): void;

  /**
   * Snapshot of the runtime's current state — exposed so support / customers
   * can quickly diagnose targeting and tracking issues from the console.
   * Pre-hydration this returns a sentinel; post-hydration the runtime
   * replaces it with a live implementation that reads from
   * `window.__pixel_debug` plus current cookie / consent / experiment state.
   */
  debug(): TestaDebugSnapshot;

  /** Resolves after the runtime has finished its first experiment-resolution cycle. */
  load(): Promise<void>;

  /**
   * Internal: runtime calls this once after first cycle to flip the load Promise.
   * Customers should never call this directly.
   */
  _loaded?: () => void;

  /** Internal: set true after runtime hydration replaces method bodies. */
  _hydrated?: boolean;
}

declare global {
  interface Window {
    _testa?: TestaQueue;
    _testa_patched_v4?: boolean;
  }
}

/**
 * Install the queue stub on `window._testa`. Idempotent — if `_testa_patched_v4`
 * is already truthy (loader ran earlier on this page), this is a no-op so we
 * don't blow away the existing queue or registered handlers.
 */
export function installQueue(): TestaQueue {
  if (window._testa) {
    return window._testa;
  }

  let loadResolve: () => void = () => {};
  const loadPromise = new Promise<void>((r) => {
    loadResolve = r;
  });

  const q: QueueCall[] = [];

  const stub: TestaQueue = {
    q,
    track(eventName, props) {
      q.push(props !== undefined ? ['track', eventName, props] : ['track', eventName]);
    },
    trackPurchase(value, currency, orderId, items) {
      q.push(
        items !== undefined
          ? ['trackPurchase', value, currency, orderId, items]
          : ['trackPurchase', value, currency, orderId],
      );
    },
    consent(state) {
      q.push(['consent', state]);
    },
    identify(visitorId) {
      q.push(['identify', visitorId]);
    },
    navigate(url) {
      q.push(['navigate', url]);
    },
    debug() {
      // Pre-hydration sentinel. Runtime swaps this with a live impl on hydrate.
      return {
        hydrated: false,
        tracker_version: '',
        consent_state: 'unknown' as ConsentState,
        consent_strict: false,
        visitor_id: null,
        session_id: null,
        url: typeof location !== 'undefined' ? location.href : '',
        cycles: [],
        errors: [],
        redirects: [],
        network: { queued: 0, sent: 0, dropped: 0, retried: 0, pending: 0 },
      };
    },
    load() {
      return loadPromise;
    },
    _loaded() {
      loadResolve();
    },
    _hydrated: false,
  };

  window._testa = stub;
  return stub;
}
