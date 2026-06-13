import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { makeFxRatesHandler } from '../route.ts';
import type { FxRow } from '../store.ts';

function buildApp(rows: FxRow[], captureDays?: (d: number) => void): Hono {
  const app = new Hono();
  app.get(
    '/_internal/fx-rates',
    makeFxRatesHandler({
      recent: async (days) => {
        captureDays?.(days);
        return rows;
      },
    }),
  );
  return app;
}

const SAMPLE: FxRow[] = [
  { date: '2026-05-05', from_ccy: 'USD', to_ccy: 'EUR', rate: 0.924 },
  { date: '2026-05-05', from_ccy: 'USD', to_ccy: 'GBP', rate: 0.793 },
  { date: '2026-05-05', from_ccy: 'USD', to_ccy: 'USD', rate: 1 },
];

async function get(app: Hono, q = ''): Promise<Response> {
  return app.fetch(new Request(`http://test.local/_internal/fx-rates${q}`));
}

describe('GET /_internal/fx-rates', () => {
  it('returns one NDJSON line per row with DateTime-formatted date', async () => {
    const res = await get(buildApp(SAMPLE));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('x-ndjson');

    const lines = (await res.text()).split('\n');
    expect(lines).toHaveLength(3);
    const firstLine = lines[0];
    if (!firstLine) throw new Error('expected at least one NDJSON line');
    const first = JSON.parse(firstLine);
    expect(first).toEqual({
      date: '2026-05-05 00:00:00',
      from_ccy: 'USD',
      to_ccy: 'EUR',
      rate: 0.924,
    });
  });

  it('defaults to 90 days when no query param is given', async () => {
    let seen = -1;
    await get(
      buildApp(SAMPLE, (d) => {
        seen = d;
      }),
    );
    expect(seen).toBe(90);
  });

  it('honors a valid days query param', async () => {
    let seen = -1;
    await get(
      buildApp(SAMPLE, (d) => {
        seen = d;
      }),
      '?days=7',
    );
    expect(seen).toBe(7);
  });

  it('falls back to the default for a non-numeric days param', async () => {
    let seen = -1;
    await get(
      buildApp(SAMPLE, (d) => {
        seen = d;
      }),
      '?days=banana',
    );
    expect(seen).toBe(90);
  });

  it('returns an empty body (not an error) when there are no rows', async () => {
    const res = await get(buildApp([]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('returns 503 when the store throws', async () => {
    const app = new Hono();
    app.get(
      '/_internal/fx-rates',
      makeFxRatesHandler({
        recent: async () => {
          throw new Error('CH down');
        },
      }),
    );
    const res = await get(app);
    expect(res.status).toBe(503);
  });
});
