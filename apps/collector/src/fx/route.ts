/**
 * `GET /_internal/fx-rates` — source for the ClickHouse `fx_rates` dictionary
 * (migration 008). Emits JSONEachRow (NDJSON) with `date` as a DateTime string
 * so the dictionary's `date DateTime` key matches.
 *
 * `recent` is injectable so the route can be tested without a live ClickHouse.
 */

import type { Context } from 'hono';
import { type FxRow, recentRates } from './store.ts';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 3650;

export interface FxRouteDeps {
  recent?: (days: number) => Promise<FxRow[]>;
}

function clampDays(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_DAYS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(Math.floor(n), MAX_DAYS);
}

export function makeFxRatesHandler(deps: FxRouteDeps = {}) {
  const recent = deps.recent ?? recentRates;

  return async (c: Context): Promise<Response> => {
    const days = clampDays(c.req.query('days'));
    try {
      const rows = await recent(days);
      const body = rows
        .map((r) =>
          JSON.stringify({
            date: `${r.date} 00:00:00`,
            from_ccy: r.from_ccy,
            to_ccy: r.to_ccy,
            rate: r.rate,
          }),
        )
        .join('\n');
      return c.body(body, 200, { 'content-type': 'application/x-ndjson' });
    } catch (err) {
      console.error('[fx] rates endpoint failed', { err: (err as Error).message });
      return c.text('fx rates unavailable', 503);
    }
  };
}
