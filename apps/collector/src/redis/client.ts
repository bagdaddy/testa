/**
 * Lazy Redis singleton (ioredis).
 *
 * Mirrors the shape of `db/clickhouse.ts` — single client, lazy init, test-only
 * setter. Used by the dedup gate, stream writer, and consumer.
 */

import IORedis, { type Redis } from 'ioredis';
import { config } from '../config.ts';

let _redis: Redis | null = null;

export function redis(): Redis {
  if (!_redis) {
    _redis = new IORedis(config.redis.url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableAutoPipelining: true,
    });
  }
  return _redis;
}

/** `PING` — used by /_internal/health. Returns false on any error. */
export async function ping(): Promise<boolean> {
  try {
    return (await redis().ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function close(): Promise<void> {
  if (_redis) {
    await _redis.quit().catch(() => undefined);
    _redis = null;
  }
}

/** Test-only escape hatch — replace the singleton (e.g., with a mock or a Redis pointed at a test DB). */
export function __setRedisForTests(stub: Redis | null): void {
  _redis = stub;
}
