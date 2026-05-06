import type { ConsentState } from '@testa-platform/shared-types';

/**
 * Consent state machine.
 *
 * Default: `granted` (matches GA4 / VWO / industry baseline).
 *
 * Customer code can flip via:
 *   1. `_testa.consent('granted' | 'denied' | 'unknown')`  — public API
 *   2. dispatching `cmp:consent-changed` with `event.detail` set to one of
 *      the same three strings — wires to standard CMPs (Cookiebot, OneTrust,
 *      Iubenda, etc.) without forcing them through our API.
 *
 * Strict mode (project config: `consent_mode: 'strict'`) holds outbound
 * tracking calls in a side queue until the first explicit `'granted'` flip.
 * On grant, the queue drains in order. On `'denied'` while strict, queued
 * calls are discarded.
 *
 * The consent module owns ONLY the state. Cookie/IP/visitor-id rotation
 * decisions live in the worker (see docs/architecture/04-cookies-and-consent.md).
 */

const DEFAULT_STATE: ConsentState = 'granted';
const VALID_STATES: ReadonlySet<ConsentState> = new Set<ConsentState>([
  'granted',
  'denied',
  'unknown',
]);

const CMP_EVENT = 'cmp:consent-changed' as const;

type Subscriber = (next: ConsentState) => void;

interface ConsentModule {
  getState(): ConsentState;
  setState(next: ConsentState): void;
  subscribe(handler: Subscriber): () => void;
  /** Strict-mode helpers. Pixel runtime calls these. */
  setStrictMode(strict: boolean): void;
  isHeld(): boolean;
  whenAllowed(): Promise<void>;
  /** Test/runtime hard-reset. */
  __resetForTests(): void;
}

let _state: ConsentState = DEFAULT_STATE;
let _strict = false;
const _subscribers: Subscriber[] = [];

let _heldResolvers: (() => void)[] = [];
let _holdPromise: Promise<void> | null = null;

function notifyAll(next: ConsentState): void {
  for (const fn of _subscribers) {
    try {
      fn(next);
    } catch (err) {
      // A broken subscriber must NEVER bring down the pipeline. Log + continue.
      // eslint-disable-next-line no-console
      console.error('[testa] consent subscriber threw:', err);
    }
  }
}

function getState(): ConsentState {
  return _state;
}

function setState(next: ConsentState): void {
  if (!VALID_STATES.has(next)) return;
  if (next === _state) return;
  const prev = _state;
  _state = next;
  notifyAll(next);

  // Strict-mode gating transitions.
  if (_strict && next === 'granted' && prev !== 'granted') {
    drainHold();
  }
}

function subscribe(handler: Subscriber): () => void {
  _subscribers.push(handler);
  return () => {
    const i = _subscribers.indexOf(handler);
    if (i >= 0) _subscribers.splice(i, 1);
  };
}

function setStrictMode(strict: boolean): void {
  _strict = strict;
  // If we're flipping out of strict, release any held callers.
  if (!strict) drainHold();
}

/**
 * `true` when strict mode is on AND state is not 'granted'. Tracking callers
 * (events.ts, network/transport.ts) check this and either drop or hold.
 */
function isHeld(): boolean {
  return _strict && _state !== 'granted';
}

/**
 * Returns a Promise that resolves when consent is no longer held — either
 * state flipped to 'granted' under strict mode, or strict mode was disabled.
 *
 * Already-allowed callers get a pre-resolved Promise (one microtask round-trip).
 */
function whenAllowed(): Promise<void> {
  if (!isHeld()) return Promise.resolve();
  if (_holdPromise === null) {
    _holdPromise = new Promise<void>((resolve) => {
      _heldResolvers.push(resolve);
    });
  }
  return _holdPromise;
}

function drainHold(): void {
  if (_heldResolvers.length === 0) {
    _holdPromise = null;
    return;
  }
  const resolvers = _heldResolvers;
  _heldResolvers = [];
  _holdPromise = null;
  for (const resolve of resolvers) {
    try {
      resolve();
    } catch {
      // ignore — Promise resolves are idempotent in practice
    }
  }
}

function __resetForTests(): void {
  _state = DEFAULT_STATE;
  _strict = false;
  _subscribers.length = 0;
  _heldResolvers = [];
  _holdPromise = null;
}

/**
 * Wire the global `cmp:consent-changed` listener. Called once by the runtime's
 * lifecycle module (Phase 3.2). Idempotent — guarded so re-init doesn't
 * stack listeners.
 */
let _listenerInstalled = false;
function installCmpListener(): void {
  if (_listenerInstalled) return;
  if (typeof window === 'undefined') return;
  window.addEventListener(CMP_EVENT, (event: Event) => {
    const ce = event as CustomEvent<unknown>;
    const detail = ce.detail;
    if (typeof detail === 'string' && VALID_STATES.has(detail as ConsentState)) {
      setState(detail as ConsentState);
    }
  });
  _listenerInstalled = true;
}

export const consent: ConsentModule = {
  getState,
  setState,
  subscribe,
  setStrictMode,
  isHeld,
  whenAllowed,
  __resetForTests,
};

export { CMP_EVENT, DEFAULT_STATE, installCmpListener };
