/**
 * Consumer entry point. Boots `Consumer` against the configured Redis stream
 * and ClickHouse, handles SIGTERM/SIGINT for graceful shutdown.
 */

import { config } from '../config.ts';
import { close as closeCh, insertEvents } from '../db/clickhouse.ts';
import { close as closeRedis, redis } from '../redis/client.ts';
import { Consumer } from './consumer.ts';

async function main(): Promise<void> {
  const consumer = new Consumer({
    redis: redis(),
    insertEvents,
    streamKey: config.redis.streamKey,
    consumerGroup: config.redis.consumerGroup,
    consumerName: config.redis.consumerName,
    batchSize: config.consumer.batchSize,
    blockMs: config.consumer.flushIntervalMs,
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[consumer] received ${signal}, draining…`);
    await consumer.stop();
    await closeRedis();
    await closeCh();
    console.log('[consumer] bye');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('[consumer] starting', {
    environment: config.environment,
    streamKey: config.redis.streamKey,
    consumerGroup: config.redis.consumerGroup,
    consumerName: config.redis.consumerName,
  });

  await consumer.start();
}

void main();
