/**
 * Pixel-side delivery health counters → `_pixel_health` synthetic event.
 *
 * Counters are module-local and mutated by the outbox + transport modules.
 * Roughly hourly per visitor, the runtime emits a `_pixel_health` event
 * carrying the snapshot:
 *
 *   { queued, sent, dropped, retried, oldest_age_ms }
 *
 * Dashboards alert on per-project drop rate. See architecture grilling
 * decision Q5 (memory: architecture_event_dedup.md context).
 *
 * Out of scope for this file: actually firing the event into the outbox.
 * That's a one-line add in the lifecycle's hourly tick.
 */

interface HealthCounters {
  /** Events written to the IDB outbox (lifetime within this tab session). */
  queued: number;
  /** Events successfully POSTed to /track and removed from outbox. */
  sent: number;
  /** Events dropped after a 4xx response from the edge (poison). */
  dropped: number;
  /** Retry attempts after 5xx / network failures. */
  retried: number;
}

const _counters: HealthCounters = {
  queued: 0,
  sent: 0,
  dropped: 0,
  retried: 0,
};

export function recordQueued(n = 1): void {
  _counters.queued += n;
}

export function recordSent(n = 1): void {
  _counters.sent += n;
}

export function recordDropped(n = 1): void {
  _counters.dropped += n;
}

export function recordRetried(n = 1): void {
  _counters.retried += n;
}

/**
 * Snapshot the counters as the props payload for a `_pixel_health` event.
 * `oldest_age_ms` comes from the outbox (caller passes it in — keeps this
 * file dependency-free).
 */
export function snapshot(oldest_age_ms: number): Record<string, number> {
  return {
    queued: _counters.queued,
    sent: _counters.sent,
    dropped: _counters.dropped,
    retried: _counters.retried,
    oldest_age_ms,
  };
}

export function __resetForTests(): void {
  _counters.queued = 0;
  _counters.sent = 0;
  _counters.dropped = 0;
  _counters.retried = 0;
}
