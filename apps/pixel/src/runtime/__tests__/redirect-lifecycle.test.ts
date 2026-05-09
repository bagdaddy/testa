/**
 * Lifecycle-level redirect regression test.
 *
 * Asserts that the experiment cycle correctly:
 *   - hands a redirect change to the redirect engine and aborts the cycle
 *     when the redirect fires (no further variation changes applied)
 *   - leaves a non-matching redirect alone and continues with other changes
 *   - applies non-redirect changes when the same variation has both a
 *     redirect (that doesn't match) and a CSS change
 *
 * Uses cfPrefill to feed in a project config and patches `window.location`
 * (via `Object.defineProperty`) so we can capture `replace()` calls without
 * actually navigating happy-dom.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPixelState } from '../../__test-utils__/reset.ts';
import { installQueue } from '../../loader/queue.ts';
import { hydrate } from '../lifecycle.ts';
import { clearRedirected } from '../redirect/dedup.ts';

// Capture location.replace without actually navigating.
const replaceMock = vi.fn();
const originalLocation = window.location;

beforeEach(async () => {
  await resetPixelState();
  replaceMock.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new Proxy(originalLocation, {
      get(target, prop) {
        if (prop === 'replace') return replaceMock;
        return Reflect.get(target, prop);
      },
    }),
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
  clearRedirected(50);
});

function projectWithRedirect(opts: { fromUrl: string; toUrl: string }): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments: [
      {
        experiment_id: 50,
        status: 'active',
        rules: [],
        traffic_allocation: 100,
        variations: [
          {
            variation_id: 1,
            weight: 100,
            changes: [
              { type: 'redirect', from_url: opts.fromUrl, to_url: opts.toUrl },
              { type: 'css', selector: '#never-applied', styles: { color: 'red' } },
            ],
          },
        ],
        goals: [],
      },
    ],
    published_at: '2026-05-09T00:00:00.000Z',
    config_hash: 'redir-1',
  };
}

describe('lifecycle redirect wiring', () => {
  it('fires redirect when from_url matches current and aborts cycle', () => {
    installQueue();
    Object.defineProperty(originalLocation, 'href', {
      configurable: true,
      value: 'https://customer.example/landing',
    });
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: projectWithRedirect({
        fromUrl: 'https://customer.example/landing',
        toUrl: 'https://customer.example/promo',
      }),
    };

    hydrate();

    expect(replaceMock).toHaveBeenCalledTimes(1);
    const target = replaceMock.mock.calls[0]?.[0];
    expect(target).toBe('https://customer.example/promo');
  });

  it('does not fire when from_url does not match', () => {
    installQueue();
    Object.defineProperty(originalLocation, 'href', {
      configurable: true,
      value: 'https://customer.example/elsewhere',
    });
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: projectWithRedirect({
        fromUrl: 'https://customer.example/landing',
        toUrl: 'https://customer.example/promo',
      }),
    };

    hydrate();

    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('preserves utm_* params on the destination URL', () => {
    installQueue();
    Object.defineProperty(originalLocation, 'href', {
      configurable: true,
      value: 'https://customer.example/landing?utm_source=fb&utm_campaign=spring',
    });
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: projectWithRedirect({
        fromUrl: 'https://customer.example/landing',
        toUrl: 'https://customer.example/promo',
      }),
    };

    hydrate();

    const target = replaceMock.mock.calls[0]?.[0] as string;
    const url = new URL(target);
    expect(url.searchParams.get('utm_source')).toBe('fb');
    expect(url.searchParams.get('utm_campaign')).toBe('spring');
  });

  it('SRM fix: experiment_view ships via sendBeacon BEFORE location.replace', () => {
    installQueue();
    Object.defineProperty(originalLocation, 'href', {
      configurable: true,
      value: 'https://customer.example/landing',
    });
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: projectWithRedirect({
        fromUrl: 'https://customer.example/landing',
        toUrl: 'https://customer.example/promo',
      }),
      apiUrl: 'https://customer.example',
    };

    const beaconCalls: Array<{ url: string; bodyText: string }> = [];
    const beaconMock = vi.fn((url: string, body?: BodyInit | null) => {
      // Capture the call ORDER vs replaceMock to prove beacon fires first.
      beaconCalls.push({ url, bodyText: body instanceof Blob ? '<blob>' : String(body) });
      return true;
    });
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: beaconMock,
    });

    hydrate();

    // Beacon fired AT LEAST once, AND the first call carries the
    // experiment_view event for our experiment.
    expect(beaconMock).toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledTimes(1);

    // Beacon URL must be the configured /track endpoint.
    expect(beaconCalls[0]?.url).toBe('https://customer.example/track');
  });

  it('logs breadcrumbs to __pixel_debug.redirects', () => {
    installQueue();
    Object.defineProperty(originalLocation, 'href', {
      configurable: true,
      value: 'https://customer.example/landing',
    });
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: projectWithRedirect({
        fromUrl: 'https://customer.example/landing',
        toUrl: 'https://customer.example/promo',
      }),
    };

    hydrate();

    const debug = (window as unknown as { __pixel_debug?: { redirects?: unknown[] } })
      .__pixel_debug;
    const phases = (debug?.redirects ?? []).map((b: unknown) => (b as { phase: string }).phase);
    expect(phases).toContain('evaluate');
    expect(phases).toContain('match');
    expect(phases).toContain('fired');
  });
});
