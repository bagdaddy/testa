/**
 * Per-event dedup gate, backed by Redis `SET key 1 NX EX ttl`.
 *
 * Only event names listed in `dedupNames` are gated — everything else passes
 * through with `{firstSeen: true}` and zero Redis traffic. Default list is
 * `['purchase']` (see `architecture_event_dedup` memory).
 *
 * Race-safe: the SET-NX-before-XADD pattern means two concurrent requests for
 * the same `event_id` can't both win the gate.
 */

import type { Redis } from 'ioredis';

export interface DedupGateInput {
  eventId: string;
  eventName: string;
  redis: Redis;
  dedupNames: readonly string[];
  ttlSec: number;
}

export interface DedupGateResult {
  /** True the first time this `event_id` is seen within the TTL window. */
  firstSeen: boolean;
}

/** Build the Redis key. Namespaced by event name so two event types can't collide. */
export function dedupKey(eventName: string, eventId: string): string {
  return `dedup:${eventName}:${eventId}`;
}

export async function dedupGate(input: DedupGateInput): Promise<DedupGateResult> {
  const { eventId, eventName, redis, dedupNames, ttlSec } = input;

  if (!dedupNames.includes(eventName)) {
    return { firstSeen: true };
  }

  const key = dedupKey(eventName, eventId);
  const reply = await redis.set(key, '1', 'EX', ttlSec, 'NX');
  return { firstSeen: reply === 'OK' };
}
