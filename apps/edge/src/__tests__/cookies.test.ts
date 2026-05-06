import { describe, expect, it, vi } from 'vitest';
import {
  TWO_YEARS_SECONDS,
  UUID_COOKIE,
  domainForHost,
  evictUuidCookie,
  getOrCreateVisitorId,
  parseCookies,
  stripTrackingSubdomain,
} from '../cookies.ts';
import type { Env } from '../types.ts';

function makeEnv(opts?: {
  customerHosts?: Record<string, string>;
  fallback?: string;
}): Env {
  const hosts = opts?.customerHosts ?? {};
  return {
    KV_PROJECT_CONFIG: {
      get: vi.fn(async (key: string) => {
        if (key.startsWith('customer_hosts:')) {
          const parent = key.slice('customer_hosts:'.length);
          return hosts[parent] ?? null;
        }
        return null;
      }),
    } as unknown as KVNamespace,
    KV_INTEGRATION_BUNDLES: {} as KVNamespace,
    BATCH_BUFFER: {} as DurableObjectNamespace,
    INGEST_SHARED_SECRET: '',
    INGEST_ORIGIN_URL: '',
    COOKIE_FALLBACK_DOMAIN: opts?.fallback ?? '.testa.com',
    VISITOR_ID_SALT: '',
    ENVIRONMENT: 'test',
  };
}

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    expect(parseCookies(`${UUID_COOKIE}=abc-123`)).toEqual({
      [UUID_COOKIE]: 'abc-123',
    });
  });

  it('parses multiple cookies, trims whitespace', () => {
    expect(parseCookies('a=1; b=2;  c=3 ')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('strips surrounding double quotes', () => {
    expect(parseCookies('a="quoted"')).toEqual({ a: 'quoted' });
  });

  it('returns {} on empty input', () => {
    expect(parseCookies('')).toEqual({});
  });

  it('skips malformed pairs (no `=`)', () => {
    expect(parseCookies('a=1; broken; b=2')).toEqual({ a: '1', b: '2' });
  });
});

describe('stripTrackingSubdomain', () => {
  it('strips track.', () => {
    expect(stripTrackingSubdomain('track.acme.com')).toBe('acme.com');
  });

  it('strips t.', () => {
    expect(stripTrackingSubdomain('t.acme.com')).toBe('acme.com');
  });

  it('handles co.uk best-effort', () => {
    expect(stripTrackingSubdomain('track.example.co.uk')).toBe('example.co.uk');
  });

  it('returns null for non-tracking subdomains', () => {
    expect(stripTrackingSubdomain('www.acme.com')).toBeNull();
    expect(stripTrackingSubdomain('app.acme.com')).toBeNull();
  });

  it('returns null for bare domains', () => {
    expect(stripTrackingSubdomain('acme.com')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(stripTrackingSubdomain('Track.Acme.Com')).toBe('acme.com');
  });
});

describe('domainForHost', () => {
  it('returns fallback for *.workers.dev', async () => {
    const env = makeEnv();
    expect(await domainForHost('testa-edge-foo.workers.dev', env)).toBe('.testa.com');
  });

  it('returns fallback when KV has no customer_hosts entry', async () => {
    const env = makeEnv();
    expect(await domainForHost('track.unknown.com', env)).toBe('.testa.com');
  });

  it('returns CNAME domain when KV has the entry', async () => {
    const env = makeEnv({ customerHosts: { 'acme.com': '42' } });
    expect(await domainForHost('track.acme.com', env)).toBe('.acme.com');
  });

  it('returns fallback for hosts without a tracking prefix', async () => {
    const env = makeEnv({ customerHosts: { 'acme.com': '42' } });
    expect(await domainForHost('www.acme.com', env)).toBe('.testa.com');
  });

  it('uses the configured fallback', async () => {
    const env = makeEnv({ fallback: '.custom.test' });
    expect(await domainForHost('track.testa.com', env)).toBe('.custom.test');
  });
});

describe('getOrCreateVisitorId', () => {
  const URL_BASE = 'https://track.testa.com';

  it('mints a UUID for a brand-new visitor', async () => {
    const env = makeEnv();
    const req = new Request(`${URL_BASE}/track`);
    const res = await getOrCreateVisitorId(req, env);
    expect(res.is_new).toBe(true);
    expect(res.visitor_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(res.set_cookie_header).toContain(`${UUID_COOKIE}=${res.visitor_id}`);
    expect(res.set_cookie_header).toContain(`Max-Age=${TWO_YEARS_SECONDS}`);
    expect(res.set_cookie_header).toContain('SameSite=Lax');
    expect(res.set_cookie_header).toContain('Secure');
    expect(res.set_cookie_header).toContain('Domain=.testa.com');
  });

  it('reuses the visitor_id from an inbound Cookie header', async () => {
    const env = makeEnv();
    const id = '01923a4f-7000-7d9c-bb8f-1234567890ab';
    const req = new Request(`${URL_BASE}/track`, {
      headers: { cookie: `${UUID_COOKIE}=${id}; other=ignored` },
    });
    const res = await getOrCreateVisitorId(req, env);
    expect(res.is_new).toBe(false);
    expect(res.visitor_id).toBe(id);
  });

  it('mints a new id when the cookie value is malformed', async () => {
    const env = makeEnv();
    const req = new Request(`${URL_BASE}/track`, {
      headers: { cookie: `${UUID_COOKIE}=not-a-uuid` },
    });
    const res = await getOrCreateVisitorId(req, env);
    expect(res.is_new).toBe(true);
    expect(res.visitor_id).not.toBe('not-a-uuid');
  });

  it('uses CNAME domain when host is a known customer', async () => {
    const env = makeEnv({ customerHosts: { 'acme.com': '42' } });
    const req = new Request('https://track.acme.com/track');
    const res = await getOrCreateVisitorId(req, env);
    expect(res.set_cookie_header).toContain('Domain=.acme.com');
  });
});

describe('evictUuidCookie', () => {
  it('builds a Max-Age=0 Set-Cookie for the given domain', () => {
    const header = evictUuidCookie('.acme.com');
    expect(header).toContain(`${UUID_COOKIE}=`);
    expect(header).toContain('Domain=.acme.com');
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Path=/');
  });
});
