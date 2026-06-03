import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import IORedis, { type Redis } from 'ioredis';
import { enqueue } from '../../ingest/stream.ts';
import { Consumer } from '../consumer.ts';

const liveRedis = process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS;
const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
const TEST_DB = 9;

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

const STREAM = 'test:events';
const GROUP = 'test:group';

function makeEvent(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    event_name: 'page_view',
    client_ts: 1730902400000,
    project_id: 1,
    visitor_id: 'v1',
    session_id: 's1',
    url: 'https://example.com/',
    consent_state: 'granted',
    tracker_version: '4.0.0',
    viewport_w: 0,
    viewport_h: 0,
    server_ts: 1730902400500,
    country: 'US',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: '',
    os: '',
    is_bot: 0,
    ...overrides,
  };
}

describe.skipIf(!liveRedis)('Consumer (live Redis, mocked CH)', () => {
  it('reads, inserts, and ACKs a batch', async () => {
    const redis = getClient();
    const inserted: object[][] = [];
    const consumer = new Consumer({
      redis,
      insertEvents: async (rows) => {
        inserted.push([...rows]);
      },
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 100,
      log: () => undefined,
    });

    await consumer.ensureGroup();
    await enqueue(makeEvent(), {
      redis,
      streamKey: STREAM,
      streamMaxLen: 1000,
      dedupNames: ['purchase'],
      dedupTtlSec: 60,
    });
    await enqueue(makeEvent(), {
      redis,
      streamKey: STREAM,
      streamMaxLen: 1000,
      dedupNames: ['purchase'],
      dedupTtlSec: 60,
    });

    const tick = await consumer.tick();
    expect(tick).toEqual({ flushed: 2, failed: false });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(2);

    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as [number])[0]).toBe(0);
  });

  it('does not ACK on insert failure (entries stay in PEL)', async () => {
    const redis = getClient();
    const consumer = new Consumer({
      redis,
      insertEvents: async () => {
        throw new Error('CH down');
      },
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 100,
      log: () => undefined,
    });
    await consumer.ensureGroup();
    await enqueue(makeEvent(), {
      redis,
      streamKey: STREAM,
      streamMaxLen: 1000,
      dedupNames: ['purchase'],
      dedupTtlSec: 60,
    });

    const tick = await consumer.tick();
    expect(tick.failed).toBe(true);
    expect(tick.flushed).toBe(0);

    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as [number])[0]).toBe(1);
  });

  it("drops unparseable entries (ACKs them so we don't loop)", async () => {
    const redis = getClient();
    const consumer = new Consumer({
      redis,
      insertEvents: async () => undefined,
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 100,
      log: () => undefined,
    });
    await consumer.ensureGroup();
    await redis.xadd(STREAM, '*', 'ev', 'not-json{');
    const tick = await consumer.tick();
    expect(tick.flushed).toBe(0);
    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as [number])[0]).toBe(0);
  });
});
