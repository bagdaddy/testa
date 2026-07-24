/**
 * Phase 2 end-to-end integration test.
 *
 * What this proves:
 *   - POST /track with 50 events → BatchBuffer count-based flush → forwardBatch
 *     → signed POST captured by fetch mock → HMAC closes the contract.
 *   - POST /track with 5 events → alarm() → alarm-based flush → same HMAC proof.
 *   - POST /track with verifiedBot CF property → 204, zero DO calls.
 *   - GET /projects/:slug.js with KV seeded → 200 + cfPrefill + Set-Cookie.
 *
 * No real network. globalThis.fetch is swapped for a vi.fn() that returns 204.
 * The real forwardBatch + signHmacSha256 run in the worker; we re-sign in the
 * test and compare — proving the HMAC contract closes end-to-end.
 */

import type { PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchBuffer, FLUSH_AT_COUNT } from '../batch.ts';
import app from '../index.ts';
import { signHmacSha256 } from '../ingest.ts';
import type { Env } from '../types.ts';

// ─── constants ─────────────────────────────────────────────────────────────

const SHARED_SECRET = 'integ-test-secret-min-16-chars';
const INGEST_ORIGIN = 'http://collector.local';

// ─── fetch mock ────────────────────────────────────────────────────────────

const fetchMock = vi.fn<typeof fetch>();
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ─── helpers ───────────────────────────────────────────────────────────────

function makeState(): DurableObjectState {
  let alarm: number | null = null;
  return {
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (n: number | Date) => {
        alarm = typeof n === 'number' ? n : n.getTime();
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
  } as unknown as DurableObjectState;
}

function makeBatchBufferNamespace(buf: BatchBuffer): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    // Explicitly create a Request so buf.fetch(request: Request) gets the right type —
    // the route calls stub.fetch(urlString, init) but buf.fetch expects a Request object.
    get: () =>
      ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
          buf.fetch(new Request(input, init)),
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

const baseEnv: Env = {
  KV_PROJECT_CONFIG: { get: async () => null } as unknown as KVNamespace,
  KV_INTEGRATION_BUNDLES: { get: async () => null } as unknown as KVNamespace,
  BATCH_BUFFER: {} as DurableObjectNamespace,
  INGEST_SHARED_SECRET: SHARED_SECRET,
  INGEST_ORIGIN_URL: INGEST_ORIGIN,
  COOKIE_FALLBACK_DOMAIN: '.testa.com',
  VISITOR_ID_SALT: 'salt',
  ENVIRONMENT: 'test',
};

function makePixelEvent(i: number): PixelEvent {
  return {
    event_id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    event_name: 'page_view',
    client_ts: 1_700_000_000_000 + i,
    project_id: 42,
    visitor_id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    session_id: 'integ-session-1',
    url: 'https://example.com/integration-test',
    consent_state: 'granted',
    tracker_version: '4.0.0',
    viewport_w: 1280,
    viewport_h: 720,
  };
}

async function postTrack(
  events: PixelEvent[],
  env: Env,
  cfOverrides?: Record<string, unknown>,
): Promise<Response> {
  return app.fetch(
    new Request('https://customer.example/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(events),
      // cf is a miniflare/CF Workers RequestInit extension; TypeScript doesn't
      // know about it but miniflare reads it and makes it available as request.cf.
      ...(cfOverrides ? { cf: cfOverrides } : {}),
    } as RequestInit & { cf?: Record<string, unknown> }),
    env,
  );
}

// ─── count-based flush (50 events) ────────────────────────────────────────

describe('POST /track → BatchBuffer → collector (count-based flush)', () => {
  it('50 events → one collector POST with valid HMAC containing 50-event batch', async () => {
    const buf = new BatchBuffer(makeState(), baseEnv);
    const env: Env = { ...baseEnv, BATCH_BUFFER: makeBatchBufferNamespace(buf) };

    // All events share the same project_id + visitor_id prefix so they route
    // to the same BatchBuffer instance (routing key = "42:aa").
    const events = Array.from({ length: FLUSH_AT_COUNT }, (_, i) => makePixelEvent(i));
    const res = await postTrack(events, env);
    expect(res.status).toBe(204);

    // Reaching FLUSH_AT_COUNT triggers a synchronous flush inside add().
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${INGEST_ORIGIN}/_ingest`);

    const initObj = init as RequestInit;
    expect(initObj.method).toBe('POST');

    const headers = initObj.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');

    const body = initObj.body as string;
    const parsed = JSON.parse(body);
    expect(parsed.events).toHaveLength(FLUSH_AT_COUNT);

    // HMAC contract: re-sign the captured body with the same secret and verify
    // that the edge produced the identical signature.
    const expectedSig = await signHmacSha256(body, SHARED_SECRET);
    expect(headers['x-edge-signature']).toBe(expectedSig);
  });
});

// ─── alarm-based flush (5 events) ─────────────────────────────────────────

describe('POST /track → BatchBuffer → collector (alarm-based flush)', () => {
  it('5 events + alarm() → one collector POST with 5 events and valid HMAC', async () => {
    const buf = new BatchBuffer(makeState(), baseEnv);
    const env: Env = { ...baseEnv, BATCH_BUFFER: makeBatchBufferNamespace(buf) };

    const events = Array.from({ length: 5 }, (_, i) => makePixelEvent(i));
    const res = await postTrack(events, env);
    expect(res.status).toBe(204);

    // Below FLUSH_AT_COUNT — no flush yet.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buf.__bufferLengthForTests()).toBe(5);

    // Simulate the alarm firing (replaces the 500 ms wall-clock wait in prod).
    await buf.alarm();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const initObj = init as RequestInit;
    const body = initObj.body as string;
    const parsed = JSON.parse(body);
    expect(parsed.events).toHaveLength(5);

    const headers = initObj.headers as Record<string, string>;
    const expectedSig = await signHmacSha256(body, SHARED_SECRET);
    expect(headers['x-edge-signature']).toBe(expectedSig);

    // Buffer drained after flush.
    expect(buf.__bufferLengthForTests()).toBe(0);
  });
});

// ─── verifiedBot drop ─────────────────────────────────────────────────────

describe('POST /track — verifiedBot drop', () => {
  it('verifiedBot=true → 204, event never reaches BatchBuffer or collector', async () => {
    const buf = new BatchBuffer(makeState(), baseEnv);
    const env: Env = { ...baseEnv, BATCH_BUFFER: makeBatchBufferNamespace(buf) };

    const res = await postTrack([makePixelEvent(1)], env, {
      botManagement: { verifiedBot: true },
    });

    expect(res.status).toBe(204);
    expect(buf.__bufferLengthForTests()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── KV serve ─────────────────────────────────────────────────────────────

describe('GET /projects/:slug.js — KV seeded', () => {
  it('returns 200 with cfPrefill block and Set-Cookie', async () => {
    const config: ProjectConfig = {
      project_id: 99,
      slug: 'integ-slug',
      integration_version: '4.0',
      consent_mode: 'aware',
      experiments: [],
      published_at: '2026-01-01T00:00:00.000Z',
      config_hash: 'abc123',
    };
    const bundle = '/* integ bundle */ void 0;';

    const get = vi.fn(async (key: string): Promise<string | null> => {
      if (key === 'project_config:integ-slug') return JSON.stringify(config);
      if (key === 'integration_bundle:4.0') return bundle;
      return null;
    });

    const env: Env = {
      ...baseEnv,
      KV_PROJECT_CONFIG: { get } as unknown as KVNamespace,
      KV_INTEGRATION_BUNDLES: { get } as unknown as KVNamespace,
    };

    const res = await app.fetch(new Request('https://track.testa.com/projects/integ-slug.js'), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('set-cookie')).toMatch(/_testa_uuid=/);

    const body = await res.text();
    expect(body).toContain('window.cfPrefill');
    expect(body).toContain('"project_id":99');
    expect(body).toContain(bundle);
  });
});
