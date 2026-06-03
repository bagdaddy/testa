import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EnrichedEvent, IngestBatch } from '@testa-platform/shared-types';
import { Hono } from 'hono';
import IORedis, { type Redis } from 'ioredis';
import { config } from '../../config.ts';
import { sign } from '../hmac.ts';
import { makeIngestHandler } from '../route.ts';

const liveRedis = process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS;
const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
const TEST_DB = 10;

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

function buildApp(): Hono {
  const app = new Hono();
  app.post(
    '/_ingest',
    makeIngestHandler({
      getRedis: () => getClient(),
    }),
  );
  return app;
}

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

async function postBatch(
  app: Hono,
  events: EnrichedEvent[],
  opts: { tamper?: boolean; signedAt?: number } = {},
): Promise<Response> {
  const batch: IngestBatch = { signed_at: opts.signedAt ?? Date.now(), events };
  const body = JSON.stringify(batch);
  const sigBody = opts.tamper ? `${body} ` : body;
  const signature = sign(sigBody, config.ingest.sharedSecret);
  return app.fetch(
    new Request('http://test.local/_ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-signature': signature },
      body,
    }),
  );
}

describe.skipIf(!liveRedis)('POST /_ingest (live Redis)', () => {
  it('accepts a valid signed batch and writes to the configured stream', async () => {
    const app = buildApp();
    const ev = makeEvent();
    const res = await postBatch(app, [ev]);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-events-accepted')).toBe('1');
    expect(res.headers.get('x-events-deduplicated')).toBe('0');

    const len = await getClient().xlen(config.redis.streamKey);
    expect(len).toBe(1);
  });

  it('rejects a tampered body with 401', async () => {
    const res = await postBatch(buildApp(), [makeEvent()], { tamper: true });
    expect(res.status).toBe(401);
  });

  it('rejects a stale signed_at with 401', async () => {
    const tooOld = Date.now() - (config.ingest.replayWindowSec * 1000 + 5_000);
    const res = await postBatch(buildApp(), [makeEvent()], { signedAt: tooOld });
    expect(res.status).toBe(401);
  });

  it('schema-validates events', async () => {
    const app = buildApp();
    const body = JSON.stringify({ signed_at: Date.now(), events: [{ wrong: 'shape' }] });
    const signature = sign(body, config.ingest.sharedSecret);
    const res = await app.fetch(
      new Request('http://test.local/_ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-signature': signature },
        body,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('counts deduped purchase events but still returns 204', async () => {
    const app = buildApp();
    const purchase = makeEvent({ event_name: 'purchase', event_id: 'order-route-1' });
    const r1 = await postBatch(app, [purchase]);
    expect(r1.status).toBe(204);
    expect(r1.headers.get('x-events-deduplicated')).toBe('0');

    const r2 = await postBatch(app, [purchase]);
    expect(r2.status).toBe(204);
    expect(r2.headers.get('x-events-deduplicated')).toBe('1');

    expect(await getClient().xlen(config.redis.streamKey)).toBe(1);
  });
});
