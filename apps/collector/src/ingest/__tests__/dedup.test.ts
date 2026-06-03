import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import IORedis, { type Redis } from 'ioredis';
import { dedupGate, dedupKey } from '../dedup.ts';

const liveRedis = process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS;
const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
// Use a high DB number to avoid trampling other dev keys.
const TEST_DB = 7;

let client: Redis | null = null;

function getClient(): Redis {
  if (!client) {
    client = new IORedis(url, { db: TEST_DB, lazyConnect: false, maxRetriesPerRequest: 1 });
  }
  return client;
}

afterAll(async () => {
  if (client) {
    await client.flushdb().catch(() => undefined);
    await client.quit().catch(() => undefined);
    client = null;
  }
});

beforeEach(async () => {
  if (liveRedis) await getClient().flushdb();
});

describe('dedupGate (live Redis)', () => {
  it.skipIf(!liveRedis)(
    'returns firstSeen=true for non-dedup event names without touching Redis',
    async () => {
      // Use an unconnected mock to prove no I/O.
      const mock = {
        set: async () => {
          throw new Error('should not be called');
        },
      } as unknown as Redis;
      const r = await dedupGate({
        eventId: 'evt-1',
        eventName: 'page_view',
        redis: mock,
        dedupNames: ['purchase'],
        ttlSec: 600,
      });
      expect(r).toEqual({ firstSeen: true });
    },
  );

  it.skipIf(!liveRedis)(
    'returns firstSeen=true on first call, false on second for same id',
    async () => {
      const redis = getClient();
      const args = {
        eventId: 'evt-dup-test',
        eventName: 'purchase' as const,
        redis,
        dedupNames: ['purchase'],
        ttlSec: 60,
      };
      expect(await dedupGate(args)).toEqual({ firstSeen: true });
      expect(await dedupGate(args)).toEqual({ firstSeen: false });
    },
  );

  it.skipIf(!liveRedis)('different event ids do not collide', async () => {
    const redis = getClient();
    expect(
      await dedupGate({
        eventId: 'a',
        eventName: 'purchase',
        redis,
        dedupNames: ['purchase'],
        ttlSec: 60,
      }),
    ).toEqual({ firstSeen: true });
    expect(
      await dedupGate({
        eventId: 'b',
        eventName: 'purchase',
        redis,
        dedupNames: ['purchase'],
        ttlSec: 60,
      }),
    ).toEqual({ firstSeen: true });
  });

  it.skipIf(!liveRedis)('respects TTL — dedup key actually carries the EX', async () => {
    const redis = getClient();
    await dedupGate({
      eventId: 'ttl-test',
      eventName: 'purchase',
      redis,
      dedupNames: ['purchase'],
      ttlSec: 42,
    });
    const ttl = await redis.ttl(dedupKey('purchase', 'ttl-test'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(42);
  });

  it.skipIf(!liveRedis)('extending the dedup list at runtime works', async () => {
    const redis = getClient();
    // First call: not in dedup list, should NOT consume.
    const a = await dedupGate({
      eventId: 'lead-1',
      eventName: 'email_capture',
      redis,
      dedupNames: ['purchase'],
      ttlSec: 60,
    });
    expect(a).toEqual({ firstSeen: true });
    // Now expand the list; this is the first time we actually gate it.
    const b = await dedupGate({
      eventId: 'lead-1',
      eventName: 'email_capture',
      redis,
      dedupNames: ['purchase', 'email_capture'],
      ttlSec: 60,
    });
    expect(b).toEqual({ firstSeen: true });
    // Replay should now be blocked.
    const c = await dedupGate({
      eventId: 'lead-1',
      eventName: 'email_capture',
      redis,
      dedupNames: ['purchase', 'email_capture'],
      ttlSec: 60,
    });
    expect(c).toEqual({ firstSeen: false });
  });
});

describe('dedupKey', () => {
  it('namespaces by event name', () => {
    expect(dedupKey('purchase', 'abc')).toBe('dedup:purchase:abc');
    expect(dedupKey('email_capture', 'abc')).toBe('dedup:email_capture:abc');
  });
});
