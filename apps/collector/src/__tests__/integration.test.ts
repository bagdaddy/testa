/**
 * Phase 1 end-to-end integration test.
 *
 * Requires live Redis + ClickHouse — guarded by REDIS_URL and CLICKHOUSE_URL
 * env vars (both must be set). Tests are skipped otherwise.
 *
 * What this proves:
 *   - A correctly signed ingest batch flows: HTTP POST → Redis stream → Consumer
 *     → ClickHouse events_buffer — all in-process.
 *   - Auth failure modes (bad sig, stale timestamp, schema violation) reject
 *     before touching Redis, so they work even without live deps.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import IORedis from 'ioredis';
import { config } from '../config.ts';
import { Consumer } from '../consumer/consumer.ts';
import { query } from '../db/clickhouse.ts';
import server from '../index.ts';
import { sign } from '../ingest/hmac.ts';
import { close as closeRedis } from '../redis/client.ts';

// ─── live-deps gate ────────────────────────────────────────────────────────

const liveRedis = process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS;
const liveCh = process.env.CLICKHOUSE_URL ?? process.env.RUN_LIVE_CH;
const hasLiveDeps = Boolean(liveRedis && liveCh);

// Unique project_id per test run avoids row pollution across runs.
const TEST_PROJECT_ID = 9_000_000 + (Date.now() % 100_000);

// ─── helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    event_id: crypto.randomUUID(),
    event_name: 'page_view',
    client_ts: Date.now() - 1000,
    server_ts: Date.now(),
    project_id: TEST_PROJECT_ID,
    visitor_id: 'integ-visitor-1',
    session_id: 'integ-session-1',
    url: 'https://example.com/integration-test',
    consent_state: 'granted',
    tracker_version: '4.0.0-test',
    viewport_w: 1280,
    viewport_h: 720,
    country: 'US',
    region: 'CA',
    region_subdivision: '',
    city: 'San Francisco',
    device_type: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    is_bot: 0,
    ...overrides,
  };
}

async function postBatch(
  events: EnrichedEvent[],
  opts: { signedAt?: number; badSig?: boolean } = {},
): Promise<Response> {
  const signedAt = opts.signedAt ?? Date.now();
  const body = JSON.stringify({ signed_at: signedAt, events });
  const sig = opts.badSig ? 'a'.repeat(64) : sign(body, config.ingest.sharedSecret);
  return server.fetch(
    new Request('http://test.local/_ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-signature': sig },
      body,
    }),
  );
}

// ─── auth / schema failure tests (no live deps needed) ────────────────────

describe('POST /_ingest — auth failures (no live deps required)', () => {
  it('rejects a tampered / wrong signature with 401', async () => {
    const res = await postBatch([makeEvent()], { badSig: true });
    expect(res.status).toBe(401);
  });

  it('rejects a replay-window-exceeded batch with 401', async () => {
    const tooOld = Date.now() - (config.ingest.replayWindowSec * 1000 + 10_000);
    const res = await postBatch([makeEvent()], { signedAt: tooOld });
    expect(res.status).toBe(401);
  });

  it('rejects a schema-invalid event with 400', async () => {
    const body = JSON.stringify({ signed_at: Date.now(), events: [{ wrong: 'shape' }] });
    const sig = sign(body, config.ingest.sharedSecret);
    const res = await server.fetch(
      new Request('http://test.local/_ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-signature': sig },
        body,
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ─── end-to-end live test ─────────────────────────────────────────────────

describe.skipIf(!hasLiveDeps)('POST /_ingest → Redis → Consumer → ClickHouse (live)', () => {
  let consumer: Consumer;
  let consumerRedis: IORedis;

  beforeAll(async () => {
    consumerRedis = new IORedis(config.redis.url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });

    consumer = new Consumer({
      redis: consumerRedis,
      insertEvents: async (rows) => {
        // Use the same table as production (events_buffer).
        const { insertRows } = await import('../db/clickhouse.ts');
        await insertRows('events_buffer', rows);
      },
      streamKey: config.redis.streamKey,
      // Unique group per run: avoids picking up events from prior runs.
      consumerGroup: `test-integ-${Date.now()}`,
      consumerName: 'test-consumer-integ',
      batchSize: 200,
      blockMs: 100,
      log: () => undefined,
    });

    // Create the consumer group at the current tail BEFORE we post events.
    await consumer.ensureGroup();

    // Start the consumer loop in background; capture promise for cleanup.
    void consumer.start();

    // Brief pause: let start()'s ensureGroup() (no-op) and first readBatch
    // BLOCK call begin before we post events, so the XREADGROUP response
    // unblocks immediately on first arrival.
    await new Promise((r) => setTimeout(r, 80));
  });

  afterAll(async () => {
    await consumer.stop();
    await consumerRedis.quit().catch(() => undefined);
    await closeRedis();
  });

  it('signed batch of 50 events lands in ClickHouse within 10 s', async () => {
    const events = Array.from({ length: 50 }, () => makeEvent());
    const res = await postBatch(events);

    expect(res.status).toBe(204);
    expect(res.headers.get('x-events-accepted')).toBe('50');

    // Poll events_buffer — Buffer table reads include both buffer and the
    // underlying events table, so rows appear immediately after insert.
    const deadline = Date.now() + 10_000;
    let got = 0;
    while (Date.now() < deadline) {
      const rows = await query<{ c: string }>(
        'SELECT count() AS c FROM events_buffer WHERE project_id = {pid:UInt64}',
        { pid: TEST_PROJECT_ID },
      );
      got = Number(rows[0]?.c ?? 0);
      if (got >= 50) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(got).toBe(50);
  }, 15_000);
});
