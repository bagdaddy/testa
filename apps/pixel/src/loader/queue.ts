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

export interface TestaQueue {
  /** FIFO of pre-hydration calls. Runtime drains in order. */
  q: QueueCall[];

  track(eventName: string, props?: Record<string, unknown>): void;
  trackPurchase(value: number, currency: string, orderId: string, items?: number): void;
  consent(state: ConsentState): void;
  identify(visitorId: string): void;
  navigate(url: string): void;

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
