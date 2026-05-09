/**
 * Transport layer — drains the outbox into HTTP POSTs to the edge worker's
 * `/track` endpoint.
 *
 * Strategy:
 *   - `fetch` with `keepalive: true` for normal flushes. Lets us see response
 *     codes and retry on 5xx / network failures.
 *   - `sendBeacon` fallback on `pagehide` and `visibilitychange:hidden` —
 *     fire-and-forget but actually sends during page unload (which fetch
 *     keepalive sometimes drops on Safari).
 *   - Auto-flush every 500 ms or on every 10 events (whichever first).
 *
 * Outcomes:
 *   - 2xx → markSent, prune from outbox, recordSent
 *   - 5xx / network → leave in outbox, schedule retry with exp backoff
 *     (500 ms → 30 s, jittered), recordRetried
 *   - 4xx → POISON BATCH. markSent (so we stop retrying), recordDropped,
 *     log to __pixel_debug
 */

import { recordDropped, recordRetried, recordSent } from './health.ts';
import { type OutboxEntry, markSent, pending } from './outbox.ts';

const FLUSH_INTERVAL_MS = 500;
const FLUSH_AT_COUNT = 10;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const MAX_BATCH_SIZE = 50;

export interface TransportConfig {
  /** Edge worker `/track` URL — usually same-origin `/track` from the customer's site. */
  endpoint: string;
}

let _config: TransportConfig | null = null;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _backoffMs = 0;
let _enqueueSinceLastFlush = 0;
let _flushing = false;

/**
 * Wire up the transport. Called once by the lifecycle module after init.
 *
 * Installs `pagehide` + `visibilitychange:hidden` listeners that flush via
 * `sendBeacon` so events don't get stranded on tab close.
 */
export function installTransport(config: TransportConfig): void {
  _config = config;
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushSync);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSync();
    });
  }
}

/**
 * Notify the transport that a new event was enqueued. Schedules a flush
 * (immediate at FLUSH_AT_COUNT, otherwise at FLUSH_INTERVAL_MS).
 */
export function notifyEnqueue(): void {
  _enqueueSinceLastFlush += 1;
  if (_enqueueSinceLastFlush >= FLUSH_AT_COUNT) {
    void flush();
    return;
  }
  scheduleFlush(FLUSH_INTERVAL_MS);
}

function scheduleFlush(delayMs: number): void {
  if (_flushTimer !== null) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void flush();
  }, delayMs);
}

/**
 * Async flush via `fetch`. Reads up to MAX_BATCH_SIZE pending events and POSTs
 * them to the edge. On 5xx / network, leaves them in the outbox and schedules
 * exp-backoff retry.
 */
export async function flush(): Promise<void> {
  if (_flushing || !_config) return;
  _flushing = true;
  _enqueueSinceLastFlush = 0;
  try {
    const events = await pending(MAX_BATCH_SIZE);
    if (events.length === 0) {
      _backoffMs = 0;
      return;
    }
    const body = `[${events.map((e) => e.payload).join(',')}]`;
    let res: Response;
    try {
      res = await fetch(_config.endpoint, {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch {
      // Network error — leave in outbox, retry with backoff.
      onTransportFailure(events.length);
      return;
    }

    if (res.status >= 200 && res.status < 300) {
      await markSent(events.map((e) => e.event_id));
      recordSent(events.length);
      _backoffMs = 0;
      // Drain anything that arrived during this flush.
      if ((await pending(1)).length > 0) scheduleFlush(0);
      return;
    }

    if (res.status >= 400 && res.status < 500) {
      // Poison batch. The edge already rejected this body — retrying will
      // keep failing. Drop and move on.
      await markSent(events.map((e) => e.event_id));
      recordDropped(events.length);
      pushDebugError('poison_batch', `status ${res.status}`);
      _backoffMs = 0;
      return;
    }

    // 5xx → retry.
    onTransportFailure(events.length);
  } catch (err) {
    pushDebugError('flush_unexpected', err instanceof Error ? err.message : String(err));
    onTransportFailure(0);
  } finally {
    _flushing = false;
  }
}

function onTransportFailure(eventCount: number): void {
  recordRetried(eventCount);
  _backoffMs = _backoffMs === 0 ? INITIAL_BACKOFF_MS : Math.min(_backoffMs * 2, MAX_BACKOFF_MS);
  // Jitter ±20% so a wave of pixels doesn't hammer the edge in lockstep.
  const jittered = _backoffMs * (0.8 + Math.random() * 0.4);
  scheduleFlush(jittered);
}

/**
 * Synchronously ship a SINGLE event via `navigator.sendBeacon`. Used right
 * before a programmatic redirect to close the SRM gap: if we waited for the
 * normal IDB-backed flush, the page would unload before the `experiment_view`
 * event reached the wire, under-counting redirect-variant exposures.
 *
 * Returns true if the beacon was accepted by the browser. Caller still adds
 * the event to the outbox as a backup — if the beacon was rejected (rare,
 * usually quota-related), the next pageload will pick it up from IDB.
 *
 * Safe to call without `installTransport()` having run (no-op returns false).
 */
export function shipEventSync(payload: string): boolean {
  if (!_config) return false;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
    return false;
  }
  const body = `[${payload}]`;
  try {
    return navigator.sendBeacon(_config.endpoint, new Blob([body], { type: 'application/json' }));
  } catch {
    return false;
  }
}

/**
 * Synchronous-style flush for `pagehide` / `visibilitychange:hidden`.
 *
 * Uses `navigator.sendBeacon` because `fetch keepalive` is unreliable on
 * Safari during unload. Beacon is fire-and-forget — we mark sent
 * optimistically; if the beacon failed silently we'll redrain on next pageload.
 */
function flushSync(): void {
  if (!_config) return;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
  void pending(MAX_BATCH_SIZE).then((events) => {
    if (events.length === 0) return;
    const body = `[${events.map((e) => e.payload).join(',')}]`;
    const ok = navigator.sendBeacon(
      _config?.endpoint ?? '',
      new Blob([body], { type: 'application/json' }),
    );
    if (ok) {
      // Beacon accepted → mark sent. The browser may still drop it; we accept
      // that risk on tab close (this is the last flush before the page dies).
      void markSent(events.map((e) => e.event_id));
      recordSent(events.length);
    }
  });
}

interface PixelDebug {
  errors: Array<{ ts: number; phase: string; message: string }>;
}

function pushDebugError(phase: string, message: string): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __pixel_debug?: PixelDebug };
  if (!w.__pixel_debug) w.__pixel_debug = { errors: [] };
  if (!Array.isArray(w.__pixel_debug.errors)) w.__pixel_debug.errors = [];
  w.__pixel_debug.errors.push({ ts: Date.now(), phase: `transport.${phase}`, message });
}

export function __resetForTests(): void {
  _config = null;
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _backoffMs = 0;
  _enqueueSinceLastFlush = 0;
  _flushing = false;
}

/** Test/runtime hook: read current backoff state. */
export function __getBackoffMsForTests(): number {
  return _backoffMs;
}

/** Re-export for the lifecycle module so it can build a single-event outbox entry. */
export type { OutboxEntry };
