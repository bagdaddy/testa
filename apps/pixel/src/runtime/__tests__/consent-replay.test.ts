/**
 * Strict-mode consent replay regression test.
 *
 * Contract:
 *   - In strict mode with state != 'granted', `track()` does NOT enqueue
 *     immediately; it parks the event in a held queue.
 *   - When state flips to 'granted', the held queue drains in original
 *     timestamp order through the normal outbox path (so the events get
 *     their stamped UUIDv7 / PixelEvent shape and reach the network).
 *   - When state flips to 'denied', the held queue is discarded — the
 *     strict contract is "no tracking without explicit grant", and we don't
 *     keep events around to leak later.
 *   - The held queue is bounded; over MAX_HELD_EVENTS, oldest are evicted
 *     and the drop is logged to __pixel_debug.errors.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPixelState } from '../../__test-utils__/reset.ts';
import { installQueue } from '../../loader/queue.ts';
import { consent } from '../consent.ts';
import { __getPendingEventsForTests, hydrate, track } from '../lifecycle.ts';

beforeEach(async () => {
  await resetPixelState();
});

afterEach(async () => {
  await resetPixelState();
});

function strictProject(): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'strict',
    experiments: [],
    published_at: '2026-05-09T00:00:00.000Z',
    config_hash: 'strict-1',
  };
}

describe('strict-mode consent replay', () => {
  it('holds events when state != granted; drains them on grant', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: strictProject() };
    hydrate();

    consent.setState('unknown');
    track('a', { i: 1 });
    track('b', { i: 2 });

    // Held — _pendingEvents (the inspection mirror, written only on emit)
    // should NOT have these yet.
    expect(
      __getPendingEventsForTests().filter((e) => e.name === 'a' || e.name === 'b'),
    ).toHaveLength(0);

    consent.setState('granted');

    // After grant, they drain in order.
    const replayed = __getPendingEventsForTests().filter((e) => e.name === 'a' || e.name === 'b');
    expect(replayed.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('drops held events on denied (strict contract: no leakage)', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: strictProject() };
    hydrate();

    consent.setState('unknown');
    track('a');
    track('b');
    consent.setState('denied');

    expect(
      __getPendingEventsForTests().filter((e) => e.name === 'a' || e.name === 'b'),
    ).toHaveLength(0);

    // A subsequent grant should NOT resurrect the dropped events.
    consent.setState('granted');
    expect(
      __getPendingEventsForTests().filter((e) => e.name === 'a' || e.name === 'b'),
    ).toHaveLength(0);
  });

  it('preserves original timestamp on replayed events', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: strictProject() };
    hydrate();

    consent.setState('unknown');
    const before = Date.now();
    track('a');
    const after = Date.now();
    consent.setState('granted');

    const replayed = __getPendingEventsForTests().find((e) => e.name === 'a');
    expect(replayed).toBeDefined();
    if (!replayed) return;
    expect(replayed.ts).toBeGreaterThanOrEqual(before);
    expect(replayed.ts).toBeLessThanOrEqual(after);
  });

  it('aware mode does NOT hold (events flow through immediately)', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: { ...strictProject(), consent_mode: 'aware' },
    };
    hydrate();

    consent.setState('unknown');
    track('a');

    // Aware mode → never held → emitted with consent_state='unknown' tag.
    expect(__getPendingEventsForTests().some((e) => e.name === 'a')).toBe(true);
  });
});
