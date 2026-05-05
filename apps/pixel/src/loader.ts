/**
 * Tiny synchronous loader stub injected at the top of the served pixel.
 *
 * Responsibilities:
 *   1. Create `window._testa` and a queue (`q`) so customer code can call
 *      `_testa.track(...)`, `_testa.consent(...)`, etc. before the runtime
 *      has finished loading.
 *   2. Async-load the runtime bundle.
 *   3. The runtime, once loaded, drains the queue.
 *
 * Constraint: stays under 5 KB minified. No dependencies.
 *
 * Phase 0.2 (skeleton). Real implementation in Phase 3.1.
 */

declare global {
  interface Window {
    _testa?: TestaQueue;
  }
}

interface TestaQueueCall {
  method: string;
  args: unknown[];
}

interface TestaQueue {
  q: TestaQueueCall[];
  track: (event_name: string, props?: Record<string, unknown>) => void;
  consent: (state: 'granted' | 'denied' | 'unknown') => void;
}

export {};
