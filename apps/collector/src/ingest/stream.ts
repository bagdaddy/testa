/**
 * Redis Stream writer — `XADD events * ev <json>`, with the dedup gate in front.
 *
 * Events that the gate rejects (replay) are NOT written; the route still treats
 * the request as a 204 success because the edge already considers the event
 * delivered.
 */

import type { EnrichedEvent } from '@testa-platform/shared-types';
import type { Redis } from 'ioredis';
import { dedupGate } from './dedup.ts';

export interface EnqueueDeps {
  redis: Redis;
  streamKey: string;
  /** Approximate cap on stream length (XADD MAXLEN ~ N). 0 disables. */
  streamMaxLen: number;
  dedupNames: readonly string[];
  dedupTtlSec: number;
}

export interface EnqueueResult {
  written: boolean;
  deduped: boolean;
  /** Returned XADD id, undefined when deduped. */
  streamId?: string;
}

export async function enqueue(event: EnrichedEvent, deps: EnqueueDeps): Promise<EnqueueResult> {
  const gate = await dedupGate({
    eventId: event.event_id,
    eventName: event.event_name,
    redis: deps.redis,
    dedupNames: deps.dedupNames,
    ttlSec: deps.dedupTtlSec,
  });

  if (!gate.firstSeen) {
    return { written: false, deduped: true };
  }

  const payload = JSON.stringify(event);

  const streamId =
    deps.streamMaxLen > 0
      ? await deps.redis.xadd(deps.streamKey, 'MAXLEN', '~', deps.streamMaxLen, '*', 'ev', payload)
      : await deps.redis.xadd(deps.streamKey, '*', 'ev', payload);

  return streamId ? { written: true, deduped: false, streamId } : { written: true, deduped: false };
}
