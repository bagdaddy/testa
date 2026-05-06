import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installQueue } from '../queue.ts';

beforeEach(() => {
  // happy-dom keeps `window` between tests; reset _testa so installQueue
  // is exercised fresh.
  (window as unknown as { _testa?: unknown })._testa = undefined;
  (window as unknown as { _testa_patched_v4?: unknown })._testa_patched_v4 = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('installQueue', () => {
  it('mounts window._testa with empty q', () => {
    installQueue();
    expect(window._testa).toBeDefined();
    expect(window._testa?.q).toEqual([]);
  });

  it('is idempotent — second call returns the same instance, preserves q', () => {
    const first = installQueue();
    first.track('first');
    const second = installQueue();
    expect(second).toBe(first);
    expect(second.q).toHaveLength(1);
  });

  it('track() pushes a tuple', () => {
    const t = installQueue();
    t.track('page_view');
    t.track('purchase', { value: 49.99 });
    expect(t.q).toEqual([
      ['track', 'page_view'],
      ['track', 'purchase', { value: 49.99 }],
    ]);
  });

  it('trackPurchase() pushes a tuple with optional items', () => {
    const t = installQueue();
    t.trackPurchase(49.99, 'USD', 'ORD-1');
    t.trackPurchase(99.99, 'EUR', 'ORD-2', 3);
    expect(t.q).toEqual([
      ['trackPurchase', 49.99, 'USD', 'ORD-1'],
      ['trackPurchase', 99.99, 'EUR', 'ORD-2', 3],
    ]);
  });

  it('consent() / identify() / navigate() each push a tuple', () => {
    const t = installQueue();
    t.consent('denied');
    t.identify('user_42');
    t.navigate('/checkout');
    expect(t.q).toEqual([
      ['consent', 'denied'],
      ['identify', 'user_42'],
      ['navigate', '/checkout'],
    ]);
  });
});

describe('load() lifecycle', () => {
  it('returns a Promise that resolves only after _loaded() is called', async () => {
    const t = installQueue();
    let resolved = false;
    t.load().then(() => {
      resolved = true;
    });

    await Promise.resolve(); // microtask flush
    expect(resolved).toBe(false);

    t._loaded?.();
    await t.load();
    expect(resolved).toBe(true);
  });

  it('load() is idempotent — same Promise across calls', async () => {
    const t = installQueue();
    const p1 = t.load();
    const p2 = t.load();
    expect(p1).toBe(p2);
    t._loaded?.();
    await p1;
    await p2;
  });
});
