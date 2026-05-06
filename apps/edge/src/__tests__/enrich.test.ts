import type { PixelEvent } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { type EnrichInputs, enrich, truncateIp } from '../enrich.ts';

const UA = {
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ipadSafari:
    'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

function makeEvent(overrides: Partial<PixelEvent> = {}): PixelEvent {
  return {
    event_id: '01923a4f-7000-7d9c-bb8f-1234567890ab',
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
    ...overrides,
  };
}

function makeInputs(
  opts: {
    ua?: string;
    cfCountry?: string;
    cfRegion?: string;
    cfRegionCode?: string;
    cfCity?: string;
  } = {},
): EnrichInputs {
  return {
    userAgent: opts.ua ?? '',
    countryHeader: opts.cfCountry ?? null,
    cf: {
      ...(opts.cfRegion !== undefined ? { region: opts.cfRegion } : {}),
      ...(opts.cfRegionCode !== undefined ? { regionCode: opts.cfRegionCode } : {}),
      ...(opts.cfCity !== undefined ? { city: opts.cfCity } : {}),
    },
  };
}

describe('enrich — UA parsing', () => {
  it('iOS Safari → mobile / Safari / iOS', () => {
    const out = enrich(makeInputs({ ua: UA.iosSafari }), makeEvent());
    expect(out.device_type).toBe('mobile');
    expect(out.browser).toMatch(/Safari/);
    expect(out.os.startsWith('iOS')).toBe(true);
  });

  it('Android Chrome → mobile / Chrome / Android', () => {
    const out = enrich(makeInputs({ ua: UA.androidChrome }), makeEvent());
    expect(out.device_type).toBe('mobile');
    expect(out.browser).toBe('Chrome');
    expect(out.os.startsWith('Android')).toBe(true);
  });

  it('Mac Chrome → desktop / Chrome / macOS', () => {
    const out = enrich(makeInputs({ ua: UA.macChrome }), makeEvent());
    expect(out.device_type).toBe('desktop');
    expect(out.browser).toBe('Chrome');
    expect(out.os.startsWith('macOS') || out.os.startsWith('Mac OS')).toBe(true);
  });

  it('iPad Safari → tablet / Safari', () => {
    const out = enrich(makeInputs({ ua: UA.ipadSafari }), makeEvent());
    expect(out.device_type).toBe('tablet');
    expect(out.browser).toMatch(/Safari/);
  });

  it('empty UA → unknown / "" / ""', () => {
    const out = enrich(makeInputs(), makeEvent());
    expect(out.device_type).toBe('unknown');
    expect(out.browser).toBe('');
    expect(out.os).toBe('');
  });
});

describe('enrich — geo headers', () => {
  it('cf-ipcountry → country uppercased', () => {
    const out = enrich(makeInputs({ ua: UA.macChrome, cfCountry: 'gb' }), makeEvent());
    expect(out.country).toBe('GB');
  });

  it('missing cf-ipcountry → XX default', () => {
    const out = enrich(makeInputs({ ua: UA.macChrome }), makeEvent());
    expect(out.country).toBe('XX');
  });

  it('cf.regionCode preferred over cf.region for `region`', () => {
    const out = enrich(
      makeInputs({
        ua: UA.macChrome,
        cfCountry: 'us',
        cfRegion: 'California',
        cfRegionCode: 'CA',
        cfCity: 'San Francisco',
      }),
      makeEvent(),
    );
    expect(out.region).toBe('CA');
    expect(out.region_subdivision).toBe('California');
    expect(out.city).toBe('San Francisco');
  });

  it('falls back to cf.region when no regionCode', () => {
    const out = enrich(
      makeInputs({
        ua: UA.macChrome,
        cfCountry: 'us',
        cfRegion: 'California',
      }),
      makeEvent(),
    );
    expect(out.region).toBe('California');
  });
});

describe('enrich — passthrough fields', () => {
  it('preserves PixelEvent fields verbatim', () => {
    const ev = makeEvent({
      utm_source: 'google',
      utm_campaign: 'summer',
      value_native: 49.99,
      currency: 'USD',
    });
    const out = enrich(makeInputs({ ua: UA.macChrome }), ev);
    expect(out.event_id).toBe(ev.event_id);
    expect(out.client_ts).toBe(ev.client_ts);
    expect(out.tracker_version).toBe(ev.tracker_version);
    expect(out.viewport_w).toBe(ev.viewport_w);
    expect(out.utm_source).toBe('google');
    expect(out.utm_campaign).toBe('summer');
    expect(out.value_native).toBe(49.99);
  });

  it('stamps server_ts to current time', () => {
    const before = Date.now();
    const out = enrich(makeInputs({ ua: UA.macChrome }), makeEvent());
    const after = Date.now();
    expect(out.server_ts).toBeGreaterThanOrEqual(before);
    expect(out.server_ts).toBeLessThanOrEqual(after);
  });

  it('always sets is_bot=0 (bot filter is Phase 2.4)', () => {
    const out = enrich(makeInputs({ ua: UA.macChrome }), makeEvent());
    expect(out.is_bot).toBe(0);
  });
});

describe('truncateIp', () => {
  it('IPv4: drops last octet', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0');
    expect(truncateIp('192.168.1.255')).toBe('192.168.1.0');
    expect(truncateIp('1.2.3.4')).toBe('1.2.3.0');
  });

  it('IPv4: rejects malformed', () => {
    expect(truncateIp('1.2.3')).toBe('');
    expect(truncateIp('a.b.c.d')).toBe('');
    expect(truncateIp('1.2.3.4.5')).toBe('');
  });

  it('IPv6: drops last 5 hextets, keeps first 3', () => {
    expect(truncateIp('2001:db8:abcd:ef12:1234:5678:90ab:cdef')).toBe('2001:db8:abcd::');
    expect(truncateIp('fe80:0:0:0:1:2:3:4')).toBe('fe80:0:0::');
  });

  it('IPv6: expands :: shorthand', () => {
    expect(truncateIp('2001:db8::1')).toBe('2001:db8:0::');
    expect(truncateIp('::1')).toBe('0:0:0::');
  });

  it('IPv6: rejects malformed', () => {
    expect(truncateIp(':::')).toBe('');
    expect(truncateIp('xyz:db8::')).toBe('');
  });

  it('empty input → empty', () => {
    expect(truncateIp('')).toBe('');
    expect(truncateIp('not an ip')).toBe('');
  });
});
