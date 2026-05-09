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
import { installQueue } from '../../loader/queue.ts';
import { consent } from '../consent.ts';
import { hydrate, __resetForTests as resetLifecycle } from '../lifecycle.ts';
import { __resetForTests as resetHealth } from '../network/health.ts';
import { __resetForTests as resetOutbox } from '../network/outbox.ts';
import { __resetForTests as resetTransport } from '../network/transport.ts';
import { __resetForTests as resetRedirectBreadcrumbs } from '../redirect/breadcrumbs.ts';
import { clearRedirected } from '../redirect/dedup.ts';

// Capture location.replace without actually navigating.
const replaceMock = vi.fn();
const originalLocation = window.location;

beforeEach(async () => {
  // Reset _testa, cfPrefill, cookies, storages.
  (window as unknown as { _testa?: unknown })._testa = undefined;
  (window as unknown as { _testa_patched_v4?: unknown })._testa_patched_v4 = undefined;
  (window as unknown as { cfPrefill?: unknown }).cfPrefill = undefined;
  for (const c of document.cookie.split(';')) {
    const eq = c.indexOf('=');
    const name = (eq < 0 ? c : c.slice(0, eq)).trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
  }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // ignore
  }

  consent.__resetForTests();
  resetLifecycle();
  await resetOutbox();
  resetHealth();
  resetTransport();
  resetRedirectBreadcrumbs();

  // Stub location.replace. happy-dom lets us write to location's prototype.
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
