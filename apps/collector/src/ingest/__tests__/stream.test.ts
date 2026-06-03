import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import IORedis, { type Redis } from 'ioredis';
import { enqueue } from '../stream.ts';

const liveRedis = process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS;
const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
const TEST_DB = 8;

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
    viewport_w: 1024,
    viewport_h: 768,
    server_ts: 1730902400500,
    country: 'US',
    region: 'CA',
    region_subdivision: '',
    city: 'San Francisco',
    device_type: 'desktop',
    browser: 'chrome',
    os: 'macos',
    is_bot: 0,
    ...overrides,
  };
}

const STREAM = 'test:events';
const DEPS = (redis: Redis) => ({
  redis,
  streamKey: STREAM,
  streamMaxLen: 10_000,
  dedupNames: ['purchase'],
  dedupTtlSec: 60,
});

describe('enqueue (live Redis)', () => {
  it.skipIf(!liveRedis)('writes a non-dedup event to the stream', async () => {
    const redis = getClient();
    const r = await enqueue(makeEvent(), DEPS(redis));
    expect(r.written).toBe(true);
    expect(r.deduped).toBe(false);
    expect(r.streamId).toMatch(/^\d+-\d+$/);
    const len = await redis.xlen(STREAM);
    expect(len).toBe(1);
  });

  it.skipIf(!liveRedis)('dedups a purchase fired twice with the same event_id', async () => {
    const redis = getClient();
    const ev = makeEvent({ event_name: 'purchase', event_id: 'order-42' });
    const a = await enqueue(ev, DEPS(redis));
    const b = await enqueue(ev, DEPS(redis));
    expect(a.written).toBe(true);
    expect(b.written).toBe(false);
    expect(b.deduped).toBe(true);
    expect(await redis.xlen(STREAM)).toBe(1);
  });

  it.skipIf(!liveRedis)('non-dedup event names are never gated even on repeat ids', async () => {
    const redis = getClient();
    const ev = makeEvent({ event_name: 'page_view', event_id: 'pv-replay' });
    await enqueue(ev, DEPS(redis));
    await enqueue(ev, DEPS(redis));
    expect(await redis.xlen(STREAM)).toBe(2);
  });

  it.skipIf(!liveRedis)('stored payload round-trips as JSON', async () => {
    const redis = getClient();
    const ev = makeEvent({ url: 'https://example.com/page?x=1' });
    await enqueue(ev, DEPS(redis));
    const entries = await redis.xrange(STREAM, '-', '+');
    expect(entries).toHaveLength(1);
    const fields = entries[0]?.[1] ?? [];
    const idx = fields.indexOf('ev');
    expect(idx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(fields[idx + 1] as string);
    expect(parsed).toEqual(ev);
  });
});
