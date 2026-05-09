/**
 * `_testa.debug()` snapshot test.
 *
 * Customer support and the customer's own engineers call `_testa.debug()`
 * from the browser console to inspect runtime state. The shape is
 * documented in `loader/queue.ts:TestaDebugSnapshot` and is part of the
 * public contract — adding fields is fine, removing/renaming is not.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPixelState } from '../../__test-utils__/reset.ts';
import { installQueue } from '../../loader/queue.ts';
import { hydrate, track } from '../lifecycle.ts';

beforeEach(async () => {
  await resetPixelState();
});

afterEach(async () => {
  await resetPixelState();
});

function project(): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments: [],
    published_at: '2026-05-09T00:00:00.000Z',
    config_hash: 'd1',
  };
}

describe('_testa.debug() — pre-hydration', () => {
  it('returns a stub snapshot before hydrate()', () => {
    const stub = installQueue();
    const snap = stub.debug();
    expect(snap.hydrated).toBe(false);
    expect(snap.tracker_version).toBe('');
    expect(snap.cycles).toEqual([]);
    expect(snap.errors).toEqual([]);
    expect(snap.redirects).toEqual([]);
    expect(snap.network).toEqual({
      queued: 0,
      sent: 0,
      dropped: 0,
      retried: 0,
      pending: 0,
    });
  });
});

describe('_testa.debug() — post-hydration', () => {
  it('reports hydrated=true with live tracker version', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: project() };
    hydrate();

    const snap = window._testa?.debug();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.hydrated).toBe(true);
    expect(snap.tracker_version).toBe('4.0.0');
  });

  it('exposes session_id once a track() has fired', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: project() };
    hydrate();
    track('page_view');

    const snap = window._testa?.debug();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(typeof snap.session_id).toBe('string');
    expect(snap.session_id?.length).toBeGreaterThan(0);
  });

  it('reflects the current consent state', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: project() };
    hydrate();
    window._testa?.consent('denied');

    const snap = window._testa?.debug();
    expect(snap?.consent_state).toBe('denied');
  });
});
