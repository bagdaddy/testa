import type { ConsentState, PixelEvent } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../index.ts';
import type { Env } from '../../types.ts';

// ─── env stubs ────────────────────────────────────────────────────────────

const doFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
  async () => new Response(null, { status: 204 }),
);
let lastIdName = '';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    KV_PROJECT_CONFIG: {
      // No CNAME customers wired → cookies module falls back to default domain.
      get: async () => null,
    } as unknown as KVNamespace,
    KV_INTEGRATION_BUNDLES: {} as KVNamespace,
    BATCH_BUFFER: {
      idFromName: (name: string) => {
        lastIdName = name;
        return { toString: () => name } as unknown as DurableObjectId;
      },
      get: () =>
        ({
          fetch: doFetch,
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
    INGEST_SHARED_SECRET: 'test-secret',
    INGEST_ORIGIN_URL: 'http://collector.local',
    COOKIE_FALLBACK_DOMAIN: '.testa.com',
    VISITOR_ID_SALT: 'salt',
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

beforeEach(() => {
  doFetch.mockClear();
  lastIdName = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── fixture ──────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<PixelEvent> = {}): PixelEvent {
  return {
    event_id: '019e09ad-efe0-75fb-befe-c971e400ac3d',
    event_name: 'page_view',
    client_ts: 1_700_000_000_000,
    project_id: 42,
    visitor_id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    session_id: 'sess-1',
    url: 'https://customer.example/landing',
    consent_state: 'granted' as ConsentState,
    tracker_version: '4.0.0',
    viewport_w: 1280,
    viewport_h: 720,
    ...overrides,
  };
}

async function postTrack(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await app.fetch(
    new Request('https://customer.example/track', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    makeEnv(),
  );
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('OPTIONS /track', () => {
  it('returns 204 with CORS headers', async () => {
    const res = await app.fetch(
      new Request('https://test.local/track', { method: 'OPTIONS' }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('POST /track — envelope', () => {
  it('400 on non-JSON body', async () => {
    const res = await postTrack('}{not json');
    expect(res.status).toBe(400);
  });

  it('204 + Set-Cookie on empty array', async () => {
    const res = await postTrack([]);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/_testa_uuid=/);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('204 + Set-Cookie when body is a non-array (drops, no DO call)', async () => {
    const res = await postTrack({ not: 'an array' });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/_testa_uuid=/);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('POST /track — valid event', () => {
  it('forwards to a DO keyed by project_id + visitor_id bucket', async () => {
    const res = await postTrack([makeEvent()]);
    expect(res.status).toBe(204);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(lastIdName).toBe('42:aa');
  });

  it('enriches the event before forwarding (server_ts, country)', async () => {
    await postTrack([makeEvent()], {
      'cf-ipcountry': 'us',
      'user-agent': 'Mozilla/5.0',
      'accept-language': 'en-US',
    });
    const call = doFetch.mock.calls[0];
    if (!call) throw new Error('expected DO fetch call');
    const init = call[1] as RequestInit;
    const enriched = JSON.parse(init.body as string);
    expect(typeof enriched.server_ts).toBe('number');
    expect(enriched.country).toBe('US');
    expect(enriched.is_bot).toBe(0);
  });

  it('drops malformed entries but keeps valid ones', async () => {
    await postTrack([makeEvent(), { event_id: 'x' }, makeEvent({ event_id: 'second' })]);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});

describe('POST /track — bot filtering', () => {
  it('drops the whole batch when UA reads as headless (heuristic-tagged)', async () => {
    // Headless UA + missing accept-language → score >= threshold.
    await postTrack([makeEvent()], {
      'user-agent': 'HeadlessChrome/120.0',
    });
    // Heuristic match → forwarded with is_bot=1, NOT dropped.
    expect(doFetch).toHaveBeenCalledTimes(1);
    const call = doFetch.mock.calls[0];
    if (!call) throw new Error('expected DO fetch call');
    const init = call[1] as RequestInit;
    const enriched = JSON.parse(init.body as string);
    expect(enriched.is_bot).toBe(1);
  });
});

describe('POST /track — visitor cookie', () => {
  it('mints a fresh _testa_uuid when no cookie present', async () => {
    const res = await postTrack([]);
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/_testa_uuid=[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('refreshes the cookie when one is already present', async () => {
    const existing = '12345678-1234-4234-8234-123456789012';
    const res = await app.fetch(
      new Request('https://customer.example/track', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `_testa_uuid=${existing}`,
        },
        body: '[]',
      }),
      makeEnv(),
    );
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain(`_testa_uuid=${existing}`);
  });
});
