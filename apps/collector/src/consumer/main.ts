/**
 * Collector consumer entry point (Bun process).
 *
 * Reads from Redis Stream `events`, batches, INSERTs to ClickHouse `events_buffer`.
 *
 * Phase 0.4 (skeleton). Real implementation in Phase 1.5.
 */

import { config } from '../config.ts';

async function main(): Promise<void> {
  console.log('[consumer] starting', {
    environment: config.environment,
    streamKey: config.redis.streamKey,
    consumerGroup: config.redis.consumerGroup,
  });
  console.log('[consumer] not yet implemented — Phase 1.5');
}

void main();
