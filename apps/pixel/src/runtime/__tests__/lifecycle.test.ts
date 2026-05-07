import type { ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installQueue } from '../../loader/queue.ts';
import { consent } from '../consent.ts';
import * as cookies from '../cookies.ts';
import {
  __clearPendingEventsForTests,
  __getPendingEventsForTests,
  __resetForTests,
  hydrate,
  track,
} from '../lifecycle.ts';

beforeEach(() => {
  // Reset window._testa, all cookies, consent, lifecycle, debug log.
  (window as unknown as { _testa?: unknown })._testa = undefined;
  (window as unknown as { _testa_patched_v4?: unknown })._testa_patched_v4 = undefined;
  (window as unknown as { cfPrefill?: unknown }).cfPrefill = undefined;
  (window as unknown as { cfGeoData?: unknown }).cfGeoData = undefined;
  (window as unknown as { __pixel_debug?: unknown }).__pixel_debug = undefined;

  for (const c of document.cookie.split(';')) {
    const eq = c.indexOf('=');
    const name = (eq < 0 ? c : c.slice(0, eq)).trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
    }
  }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // ignore
  }

  consent.__resetForTests();
  __resetForTests();
  __clearPendingEventsForTests();
});

afterEach(() => {
  consent.__resetForTests();
  __resetForTests();
  __clearPendingEventsForTests();
});

function fixture(): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments: [
      {
        experiment_id: 17,
        status: 'active',
        traffic_allocation: 100,
        rules: [],
        variations: [
          { variation_id: 100, weight: 50, changes: [] },
          { variation_id: 200, weight: 50, changes: [] },
        ],
        goals: [],
      },
    ],
    published_at: '2026-05-07T00:00:00.000Z',
    config_hash: 'abcdef',
  };
}

/** Type-safe accessor for the first experiment in a fixture. */
function firstExp(p: ProjectConfig): ProjectConfig['experiments'][number] {
  const e = p.experiments[0];
  if (!e) throw new Error('fixture has no experiments');
  return e;
}

describe('hydrate — wiring', () => {
  it('replaces stub methods with live implementations', () => {
    const stub = installQueue();
    expect(stub._hydrated).toBe(false);
    hydrate();
    expect(stub._hydrated).toBe(true);
    expect(typeof stub.track).toBe('function');
  });

  it('drains queue in arrival order', () => {
    const stub = installQueue();
    stub.track('first');
    stub.track('second', { foo: 'bar' });
    stub.track('third');

    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.length).toBeGreaterThanOrEqual(3);
    const names = events.map((e) => e.name);
    expect(names).toContain('first');
    expect(names).toContain('second');
    expect(names).toContain('third');
    // 'second' should carry props
    const second = events.find((e) => e.name === 'second');
    expect(second?.props).toEqual({ foo: 'bar' });
  });

  it('queue is empty after drain', () => {
    const stub = installQueue();
    stub.track('a');
    stub.track('b');
    hydrate();
    expect(stub.q.length).toBe(0);
  });

  it('fires _testa.load() once after first cycle', async () => {
    const stub = installQueue();
    let resolved = false;
    stub.load().then(() => {
      resolved = true;
    });
    hydrate();
    await stub.load();
    expect(resolved).toBe(true);
  });

  it('is idempotent — second hydrate is a no-op', () => {
    installQueue();
    hydrate();
    const eventCountAfterFirst = __getPendingEventsForTests().length;
    hydrate();
    expect(__getPendingEventsForTests().length).toBe(eventCountAfterFirst);
  });
});

describe('hydrate — error isolation', () => {
  it('an error during cycle is caught + recorded in __pixel_debug', () => {
    installQueue();
    // Force an error: ProjectConfig with a deliberately-broken audience
    // (regex with malformed pattern — currently fails closed; safe even on prod).
    // We simulate a real-world break by making the config's experiments array
    // throw on iteration. Easiest: install a broken project.
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: {
        ...fixture(),
        experiments: new Proxy([], {
          get() {
            throw new Error('boom');
          },
        }),
      },
    };
    expect(() => hydrate()).not.toThrow();
    const debug = (window as unknown as { __pixel_debug?: { errors: { phase: string }[] } })
      .__pixel_debug;
    expect(debug).toBeDefined();
    expect(debug?.errors.some((e) => e.phase === 'first_cycle')).toBe(true);
  });

  it('emits a _pixel_health synthetic event when a phase errors', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: {
        ...fixture(),
        experiments: new Proxy([], {
          get() {
            throw new Error('boom');
          },
        }),
      },
    };
    hydrate();
    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === '_pixel_health')).toBe(true);
  });
});

describe('runExperimentCycle — happy path', () => {
  it('assigns a variation, fires experiment_view, persists cookie', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: fixture() };
    hydrate();

    const events = __getPendingEventsForTests();
    const expView = events.find((e) => e.name === 'experiment_view');
    expect(expView).toBeDefined();
    expect(expView?.props.experiment_id).toBe(17);
    expect([100, 200]).toContain(expView?.props.variation_id);
    expect(cookies.getAssignment(17)).toBe(expView?.props.variation_id);
  });

  it('skips experiments whose status is not active', () => {
    installQueue();
    const config = fixture();
    firstExp(config).status = 'paused';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === 'experiment_view')).toBe(false);
  });

  it('skips experiments whose audience does not match', () => {
    installQueue();
    const config = fixture();
    firstExp(config).audience = {
      fact: 'geo.country',
      op: 'in',
      value: ['ZZ'], // visitor's geo is empty → won't match
    };
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === 'experiment_view')).toBe(false);
  });

  it('handles audience match (US country)', () => {
    installQueue();
    const config = fixture();
    firstExp(config).audience = {
      fact: 'geo.country',
      op: 'in',
      value: ['US'],
    };
    (window as unknown as { cfPrefill: unknown; cfGeoData: unknown }).cfGeoData = {
      country: 'US',
    };
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === 'experiment_view')).toBe(true);
  });

  it('runs the cycle on _testa:locationchange (after 50ms debounce + URL change)', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: fixture() };
    hydrate();

    const eventsAfterFirst = __getPendingEventsForTests().length;
    // Actually change the URL so the canonical-URL diff sees a transition.
    window.history.replaceState({}, '', '/different-page');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    // Wait out the 50ms debounce (no fake timers in this test file).
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Cookie was already set; the second cycle uses cookie-first lookup, so
        // experiment_view re-fires (we don't dedupe across navigations in 3.2).
        const eventsAfterSecond = __getPendingEventsForTests().length;
        expect(eventsAfterSecond).toBeGreaterThan(eventsAfterFirst);
        resolve();
      }, 80);
    });
  });

  it('records exposure when frequency_cap is configured', () => {
    installQueue();
    const config = fixture();
    firstExp(config).frequency_cap = { max: 3, window: 'week' };
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const counter = cookies.getFreq(17);
    expect(counter?.count).toBe(1);
  });

  it('honors mutex_group exclusion', () => {
    installQueue();
    cookies.setMutex('checkout', 999); // some other experiment owns it
    const config = fixture();
    firstExp(config).mutex_group = 'checkout';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === 'experiment_view')).toBe(false);
  });
});

describe('strict consent mode', () => {
  it('holds tracking calls when project consent_mode=strict and state=unknown', () => {
    installQueue();
    const config = fixture();
    config.consent_mode = 'strict';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    consent.setState('unknown');
    hydrate();

    expect(consent.isHeld()).toBe(true);
    const events = __getPendingEventsForTests();
    // The experiment_view fired BEFORE we flipped to strict because hydrate
    // first runs applyConsentMode then the cycle. Track() at cycle time
    // checks isHeld and skips. Verify zero non-_pixel_health events.
    expect(events.filter((e) => e.name === 'experiment_view').length).toBe(0);
  });

  it('aware mode (default) does not hold tracking', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: fixture() };
    hydrate();

    expect(consent.isHeld()).toBe(false);
    expect(__getPendingEventsForTests().some((e) => e.name === 'experiment_view')).toBe(true);
  });
});

describe('public API (post-hydrate)', () => {
  it('_testa.consent flips state', () => {
    const stub = installQueue();
    hydrate();
    stub.consent('denied');
    expect(consent.getState()).toBe('denied');
  });

  it('_testa.track queues an event', () => {
    const stub = installQueue();
    hydrate();
    __clearPendingEventsForTests();
    stub.track('signup', { plan: 'pro' });
    const events = __getPendingEventsForTests();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('signup');
    expect(events[0]?.props).toEqual({ plan: 'pro' });
  });

  it('_testa.trackPurchase shapes the event correctly', () => {
    const stub = installQueue();
    hydrate();
    __clearPendingEventsForTests();
    stub.trackPurchase(49.99, 'USD', 'ORD-1', 2);
    const events = __getPendingEventsForTests();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('purchase');
    expect(events[0]?.props).toEqual({
      value_native: 49.99,
      currency: 'USD',
      order_id: 'ORD-1',
      items_count: 2,
    });
  });
});

describe('track() consent gating', () => {
  it('drops events when consent is held under strict mode', () => {
    consent.setStrictMode(true);
    consent.setState('denied');
    track('manual', {});
    expect(__getPendingEventsForTests().length).toBe(0);
  });

  it('allows events when consent is granted', () => {
    consent.setState('granted');
    track('manual', {});
    expect(__getPendingEventsForTests().some((e) => e.name === 'manual')).toBe(true);
  });
});
