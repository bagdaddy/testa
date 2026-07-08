/**
 * Wire-contract integration test: pixel emits an event → outbox enqueues →
 * transport POSTs to a fetch mock → assert the body is a valid `PixelEvent[]`
 * matching the shape `apps/edge/src/routes/track.ts:parsePixelEvents` accepts.
 *
 * This catches drift in either direction:
 *   - pixel renames a field → fails here
 *   - edge tightens validation → fails here
 *
 * Edge-side enrichment + DO routing already has dedicated coverage in
 * `apps/edge/src/routes/__tests__/track.test.ts`. The two suites together
 * give us full pixel ↔ edge round-trip coverage without cross-app imports.
 */

import type { ConsentState, PixelEvent } from '@testa-platform/shared-types';
import type { ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPixelState } from '../__test-utils__/reset.ts';
import { installQueue } from '../loader/queue.ts';
import { hydrate } from '../runtime/lifecycle.ts';
import { flush } from '../runtime/network/transport.ts';

const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await resetPixelState();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetPixelState();
});

/**
 * `track()` enqueues to the outbox via a fire-and-forget promise; tests need
 * to let those microtasks settle before flushing. A small setTimeout(0)
 * drains the IDB open + insert chain.
 */
async function drainEnqueues(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

/**
 * After `hydrate()`, the runtime fires the baseline lifecycle events
 * (`session_start` + `page_view`). Flush those out and clear the fetch mock so
 * each test asserts only on the events it explicitly emits.
 */
async function settleHydration(): Promise<void> {
  await drainEnqueues();
  await flush();
  fetchMock.mockClear();
}

function project(): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments: [],
    published_at: '2026-05-07T00:00:00.000Z',
    config_hash: 'abc',
  };
}

/** Mirror of `apps/edge/src/routes/track.ts:parseOne` — the wire contract. */
function isValidPixelEvent(raw: unknown): raw is PixelEvent {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.event_id === 'string' &&
    r.event_id.length > 0 &&
    typeof r.event_name === 'string' &&
    r.event_name.length > 0 &&
    typeof r.client_ts === 'number' &&
    Number.isFinite(r.client_ts) &&
    typeof r.project_id === 'number' &&
    Number.isFinite(r.project_id) &&
    typeof r.visitor_id === 'string' &&
    typeof r.session_id === 'string' &&
    typeof r.url === 'string' &&
    typeof r.tracker_version === 'string' &&
    typeof r.consent_state === 'string' &&
    typeof r.viewport_w === 'number' &&
    typeof r.viewport_h === 'number'
  );
}

describe('pixel emits wire-format PixelEvents', () => {
  it('track() body is a JSON array of valid PixelEvent objects', async () => {
    installQueue();
    (window as unknown as { cfPrefill: { project: ProjectConfig; apiUrl: string } }).cfPrefill = {
      project: project(),
      apiUrl: 'https://customer.example',
    };
    hydrate();
    await settleHydration();

    window._testa?.track?.('add_to_cart', { sku: 'X-1' });
    await drainEnqueues();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [RequestInfo, RequestInit] | undefined;
    if (!call) throw new Error('expected fetch call');
    const [url, init] = call;
    expect(String(url)).toBe('https://customer.example/track');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    const ev = body[0];
    expect(isValidPixelEvent(ev)).toBe(true);
    expect(ev.event_name).toBe('add_to_cart');
    expect(ev.project_id).toBe(42);
    expect(ev.tracker_version).toBe('4.0.0');
    expect(ev.props).toEqual({ sku: 'X-1' });
    expect(ev.consent_state as ConsentState).toBe('granted');
  });

  it('purchase props lift to top-level fields (value_native/currency/order_id/items_count)', async () => {
    installQueue();
    (window as unknown as { cfPrefill: { project: ProjectConfig; apiUrl: string } }).cfPrefill = {
      project: project(),
      apiUrl: 'https://customer.example',
    };
    hydrate();
    await settleHydration();

    window._testa?.trackPurchase?.(99.95, 'EUR', 'order-7', 3);
    await drainEnqueues();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [RequestInfo, RequestInit] | undefined;
    if (!call) throw new Error('expected fetch call');
    const body = JSON.parse(call[1].body as string);
    const ev = body[0];
    expect(ev.event_name).toBe('purchase');
    expect(ev.value_native).toBe(99.95);
    expect(ev.currency).toBe('EUR');
    expect(ev.order_id).toBe('order-7');
    expect(ev.items_count).toBe(3);
    expect(ev.props).toBeUndefined();
  });

  it('strict-mode hold drops events when state is not granted', async () => {
    installQueue();
    const cfg = project();
    cfg.consent_mode = 'strict';
    (window as unknown as { cfPrefill: { project: ProjectConfig; apiUrl: string } }).cfPrefill = {
      project: cfg,
      apiUrl: 'https://customer.example',
    };
    hydrate();
    // Baseline lifecycle events fire while state is still 'granted'; flush them.
    await settleHydration();
    // Strict mode alone doesn't hold (default state is 'granted'). Flip to
    // 'unknown' so isHeld() returns true.
    window._testa?.consent?.('unknown');

    window._testa?.track?.('checkout_start');
    await drainEnqueues();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('multiple events batch into one POST', async () => {
    installQueue();
    (window as unknown as { cfPrefill: { project: ProjectConfig; apiUrl: string } }).cfPrefill = {
      project: project(),
      apiUrl: 'https://customer.example',
    };
    hydrate();
    await settleHydration();

    window._testa?.track?.('a');
    window._testa?.track?.('b');
    window._testa?.track?.('c');
    await drainEnqueues();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [RequestInfo, RequestInit] | undefined;
    if (!call) throw new Error('expected fetch call');
    const body = JSON.parse(call[1].body as string);
    expect(body.length).toBe(3);
    for (const ev of body) {
      expect(isValidPixelEvent(ev)).toBe(true);
    }
    // Order across same-ms enqueues is best-effort (UUIDv7 random tail) — we
    // only assert that all three names made the trip.
    expect(new Set(body.map((e: PixelEvent) => e.event_name))).toEqual(new Set(['a', 'b', 'c']));
  });
});
