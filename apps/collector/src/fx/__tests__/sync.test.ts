import { describe, expect, it } from 'bun:test';
import type { FxRow } from '../store.ts';
import { syncToday } from '../sync.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FIXTURE = {
  amount: 1,
  base: 'USD',
  date: '2026-05-05',
  rates: { EUR: 0.924, GBP: 0.793, JPY: 154.21 },
};

describe('syncToday', () => {
  it('maps Frankfurter rates to USD-base rows + a USD→USD identity', async () => {
    let captured: readonly FxRow[] = [];
    const n = await syncToday({
      fetchFn: async () => jsonResponse(FIXTURE),
      upsert: async (rows) => {
        captured = rows;
      },
    });

    expect(n).toBe(4); // 3 rates + identity
    expect(captured).toHaveLength(4);
    for (const r of captured) {
      expect(r.from_ccy).toBe('USD');
      expect(r.date).toBe('2026-05-05');
    }
    expect(captured.find((r) => r.to_ccy === 'EUR')?.rate).toBe(0.924);
    expect(captured.find((r) => r.to_ccy === 'USD')?.rate).toBe(1);
  });

  it('throws when Frankfurter returns a non-2xx status', async () => {
    await expect(
      syncToday({
        fetchFn: async () => new Response('upstream down', { status: 500 }),
        upsert: async () => undefined,
      }),
    ).rejects.toThrow(/500/);
  });

  it('throws when the payload shape is invalid', async () => {
    await expect(
      syncToday({
        fetchFn: async () => jsonResponse({ date: 'not-a-date', rates: {} }),
        upsert: async () => undefined,
      }),
    ).rejects.toThrow(/invalid/i);
  });

  it('does not persist when the fetch fails', async () => {
    let upsertCalled = false;
    await expect(
      syncToday({
        fetchFn: async () => new Response('', { status: 503 }),
        upsert: async () => {
          upsertCalled = true;
        },
      }),
    ).rejects.toThrow();
    expect(upsertCalled).toBe(false);
  });
});
