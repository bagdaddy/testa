import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  fireEvent,
  installLegacy,
  publishCookieAssignment,
  publishExclusion,
  publishFreq,
  publishLeadSent,
  publishLoaded,
  publishMutex,
  publishRedirecting,
  publishSession,
  publishUrl,
  publishUuid,
} from '../index.ts';

beforeEach(() => {
  __resetForTests();
  // Clear any window-level globals tests poke.
  for (const key of [
    'cfPrefill',
    'cfGeoData',
    'apiUrl',
    'testa_env',
    'crbData',
    '__NEXT_DATA__',
    'testaLoaded',
  ]) {
    (window as unknown as Record<string, unknown>)[key] = undefined;
  }
});

afterEach(() => {
  __resetForTests();
});

const noop = (): void => {};

describe('installLegacy — constants', () => {
  it('puts every constant from the inventory on window.Analytica', () => {
    installLegacy({ pushEvent: noop });
    const a = window.Analytica;
    expect(a?.COOKIE_NAME).toBe('_testa_exp');
    expect(a?.SESSION_COOKIE).toBe('_testa_ses');
    expect(a?.USER_COOKIE).toBe('_testa_user');
    expect(a?.UUID_COOKIE).toBe('_testa_uuid');
    expect(a?.EXCLUDED_COOKIE).toBe('_testa_excl');
    expect(a?.FREQ_COOKIE).toBe('_testa_freq');
    expect(a?.MUTEX_COOKIE).toBe('_testa_mutex');
    expect(a?.CROSS_DOMAIN_PARAM).toBe('_testa_cd');
    expect(a?.SESSION_LENGTH).toBe(60 * 60 * 1000);
    expect(a?.CLICK_SELECTOR_TIMEOUT).toBe(100);
    expect(a?.CLICK_SELECTOR_MAX_TRIES).toBe(3);
    expect(a?.NEXTJS_TIMEOUT_MS).toBe(1000);
    expect(a?.NEXTJS_CHECK_INTERVAL).toBe(50);
    expect(a?.VARIATION_APPLIED_KEY).toBe('variation_applied');
    expect(a?.VARIATION_ASSIGNED_KEY).toBe('variation_assigned');
    expect(a?.headers['Content-Type']).toBe('application/json');
  });
});

describe('installLegacy — configuration sources', () => {
  it('reads domain from cfPrefill.apiUrl when present', () => {
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { apiUrl: 'https://api.testa.com' };
    installLegacy({ pushEvent: noop });
    expect(window.Analytica?.domain).toBe('https://api.testa.com');
  });

  it('falls back to window.apiUrl', () => {
    (window as unknown as { apiUrl: string }).apiUrl = 'https://legacy.api';
    installLegacy({ pushEvent: noop });
    expect(window.Analytica?.domain).toBe('https://legacy.api');
  });

  it('reads geoData from cfGeoData', () => {
    (window as unknown as { cfGeoData: unknown }).cfGeoData = { country: 'DE' };
    installLegacy({ pushEvent: noop });
    expect(window.Analytica?.geoData.country).toBe('DE');
  });

  it('reads project from cfPrefill.project, falling back to crbData', () => {
    (window as unknown as { crbData: unknown }).crbData = { project_id: 99 };
    installLegacy({ pushEvent: noop });
    expect((window.Analytica?.project as { project_id: number }).project_id).toBe(99);
  });

  it('detects Next.js via __NEXT_DATA__', () => {
    (window as unknown as { __NEXT_DATA__: unknown }).__NEXT_DATA__ = { page: '/' };
    installLegacy({ pushEvent: noop });
    expect(window.Analytica?.isNextApp).toBe(true);
  });
});

describe('installLegacy — mutable state initial shape', () => {
  it('initializes empty maps for cookies, ses, usr, excl, freq, mutex, sent', () => {
    installLegacy({ pushEvent: noop });
    const a = window.Analytica;
    expect(a?.cookies).toEqual({});
    expect(a?.ses).toEqual({});
    expect(a?.usr).toEqual({});
    expect(a?.excl).toEqual({});
    expect(a?.freq).toEqual({});
    expect(a?.mutex).toEqual({});
    expect(a?.sent).toEqual({});
  });

  it('isLoaded false initially; isRedirecting false; processing 0', () => {
    installLegacy({ pushEvent: noop });
    expect(window.Analytica?.isLoaded).toBe(false);
    expect(window.Analytica?.isRedirecting).toBe(false);
    expect(window.Analytica?.processing).toBe(0);
  });
});

describe('installLegacy — idempotence preserves customer state', () => {
  it('preserves listeners + eventEmitter across re-install', () => {
    installLegacy({ pushEvent: noop });
    const handler = vi.fn();
    window.Analytica?.eventEmitter.on('variation_applied', handler);

    installLegacy({ pushEvent: noop });
    fireEvent('variation_applied', { variation_id: 100 });
    expect(handler).toHaveBeenCalled();
  });
});

describe('publish* mutators', () => {
  beforeEach(() => installLegacy({ pushEvent: noop }));

  it('publishUuid', () => {
    publishUuid('uuid_abc');
    expect(window.Analytica?.uuid).toBe('uuid_abc');
  });

  it('publishUrl', () => {
    publishUrl('https://example.com/x');
    expect(window.Analytica?.url).toBe('https://example.com/x');
  });

  it('publishCookieAssignment / publishSession / publishExclusion', () => {
    publishCookieAssignment(17, 100);
    publishSession(17, 1234567890);
    publishExclusion(42, true);
    expect(window.Analytica?.cookies[17]).toBe(100);
    expect(window.Analytica?.ses[17]).toBe(1234567890);
    expect(window.Analytica?.excl[42]).toBe(1);
  });

  it('publishFreq stores the counter object', () => {
    publishFreq(17, { count: 2, window_start_ts: 1700000000 });
    expect(window.Analytica?.freq[17]).toEqual({ count: 2, window_start_ts: 1700000000 });
  });

  it('publishMutex / publishLeadSent', () => {
    publishMutex('checkout', 17);
    publishLeadSent(17);
    expect(window.Analytica?.mutex.checkout).toBe(17);
    expect(window.Analytica?.sent[17]).toBe(1);
  });

  it('publishLoaded flips both Analytica.isLoaded and window.testaLoaded', () => {
    publishLoaded();
    expect(window.Analytica?.isLoaded).toBe(true);
    expect(window.testaLoaded).toBe(true);
  });

  it('publishRedirecting toggles', () => {
    publishRedirecting(true);
    expect(window.Analytica?.isRedirecting).toBe(true);
    publishRedirecting(false);
    expect(window.Analytica?.isRedirecting).toBe(false);
  });
});

describe('eventEmitter (3.6 parity)', () => {
  beforeEach(() => installLegacy({ pushEvent: noop }));

  it('emit + on round-trips data', () => {
    const handler = vi.fn();
    window.Analytica?.eventEmitter.on('variation_applied', handler);
    fireEvent('variation_applied', { variation_id: 100 });
    expect(handler).toHaveBeenCalledWith({ variation_id: 100 });
  });

  it('replays history to late subscribers', () => {
    fireEvent('variation_applied', { variation_id: 100 });
    const handler = vi.fn();
    window.Analytica?.eventEmitter.on('variation_applied', handler);
    expect(handler).toHaveBeenCalledWith({ variation_id: 100 });
  });

  it('dedups identical payloads per handler', () => {
    const handler = vi.fn();
    window.Analytica?.eventEmitter.on('variation_applied', handler);
    fireEvent('variation_applied', { variation_id: 100 });
    fireEvent('variation_applied', { variation_id: 100 });
    expect(handler).toHaveBeenCalledTimes(1);
    fireEvent('variation_applied', { variation_id: 200 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('isolates handler errors — other handlers still fire', () => {
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    window.Analytica?.eventEmitter.on('variation_applied', a);
    window.Analytica?.eventEmitter.on('variation_applied', b);
    fireEvent('variation_applied', { x: 1 });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('ignores non-function handlers (3.6 quirk)', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing 3.6's tolerance for bad input
      window.Analytica?.eventEmitter.on('x', 'not a function' as any),
    ).not.toThrow();
  });
});

describe('pushEvent', () => {
  it('delegates to the supplied callback', () => {
    const pushEvent = vi.fn();
    installLegacy({ pushEvent });
    window.Analytica?.pushEvent('signup', { plan: 'pro' });
    expect(pushEvent).toHaveBeenCalledWith('signup', { plan: 'pro' });
  });
});
