import type { EnrichedEvent } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardBatch, signHmacSha256 } from '../ingest.ts';
import type { Env } from '../types.ts';

const SECRET = 'test-shared-secret-min-16-chars';
const ORIGIN = 'https://collector.test';

function makeEnv(): Env {
  return {
    KV_PROJECT_CONFIG: {} as KVNamespace,
    KV_INTEGRATION_BUNDLES: {} as KVNamespace,
    BATCH_BUFFER: {} as DurableObjectNamespace,
    INGEST_SHARED_SECRET: SECRET,
    INGEST_ORIGIN_URL: ORIGIN,
    COOKIE_FALLBACK_DOMAIN: '.testa.com',
    VISITOR_ID_SALT: '',
    ENVIRONMENT: 'test',
  };
}

function makeEvent(i: number): EnrichedEvent {
  return {
    event_id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    event_name: 'page_view',
    client_ts: 1_700_000_000_000,
    project_id: 1,
    visitor_id: 'v1',
    session_id: 's1',
    url: 'https://example.com/',
    consent_state: 'granted',
    tracker_version: '4.0.0',
    viewport_w: 1920,
    viewport_h: 1080,
    server_ts: 1_700_000_000_001,
    country: 'US',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    is_bot: 0,
  } as EnrichedEvent;
}

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('signHmacSha256', () => {
  it('produces a 64-char lowercase hex digest', async () => {
    const sig = await signHmacSha256('hello', SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same body+secret', async () => {
    const a = await signHmacSha256('the body', SECRET);
    const b = await signHmacSha256('the body', SECRET);
    expect(a).toBe(b);
  });

  it('changes when body changes', async () => {
    const a = await signHmacSha256('body a', SECRET);
    const b = await signHmacSha256('body b', SECRET);
    expect(a).not.toBe(b);
  });

  it('changes when secret changes', async () => {
    const a = await signHmacSha256('body', SECRET);
    const b = await signHmacSha256('body', `${SECRET}-other`);
    expect(a).not.toBe(b);
  });
});

describe('forwardBatch — happy path', () => {
  it('POSTs to {origin}/_ingest with the right headers and body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const env = makeEnv();
    const events = [makeEvent(1), makeEvent(2)];

    await forwardBatch(events, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/_ingest`);
    const initObj = init as RequestInit;
    expect(initObj.method).toBe('POST');
    const headers = initObj.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-edge-signature']).toMatch(/^[0-9a-f]{64}$/);

    const sentBody = initObj.body as string;
    const parsed = JSON.parse(sentBody);
    expect(parsed.signed_at).toBeGreaterThan(0);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0].event_id).toBe(events[0]?.event_id);
  });

  it('signature actually verifies against the body sent', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const env = makeEnv();
    await forwardBatch([makeEvent(1)], env);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const initObj = init as RequestInit;
    const body = initObj.body as string;
    const sentSig = (initObj.headers as Record<string, string>)['x-edge-signature'];

    const expected = await signHmacSha256(body, SECRET);
    expect(sentSig).toBe(expected);
  });

  it('empty events is a no-op (no fetch)', async () => {
    await forwardBatch([], makeEnv());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('forwardBatch — failure paths', () => {
  it('5xx → throws (DO retry path)', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));
    await expect(forwardBatch([makeEvent(1)], makeEnv())).rejects.toThrow(/503/);
  });

  it('4xx → resolves (poison batch dropped)', async () => {
    fetchMock.mockResolvedValue(new Response('schema error', { status: 400 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(forwardBatch([makeEvent(1)], makeEnv())).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
      const msg = errSpy.mock.calls.flat().join(' ');
      expect(msg).toMatch(/poison batch/);
      expect(msg).toMatch(/400/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('network error → throws (DO retry path)', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    await expect(forwardBatch([makeEvent(1)], makeEnv())).rejects.toThrow(
      /network error.*connection refused/,
    );
  });
});
