/**
 * Daily FX rate sync from Frankfurter (https://www.frankfurter.app).
 *
 * Pulls USD-base rates once a day and persists them to `fx_rates_history`.
 * Cross-rates (e.g. EUR→GBP) are computed at query time from the USD legs, so
 * we only store USD→X. A USD→USD identity row is added so dashboards never
 * special-case the base currency.
 *
 * `fetchFn` and `upsert` are injectable for unit testing without network or CH.
 */

import { z } from 'zod';
import { config } from '../config.ts';
import { type FxRow, upsertRates } from './store.ts';

const frankfurterSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  rates: z.record(z.string(), z.number()),
});

export interface SyncDeps {
  fetchFn?: typeof fetch;
  upsert?: (rows: readonly FxRow[]) => Promise<void>;
}

/**
 * Pull today's rates and persist them. Returns the number of rows written
 * (including the USD→USD identity row). Throws on network or schema failure.
 */
export async function syncToday(deps: SyncDeps = {}): Promise<number> {
  const fetchFn = deps.fetchFn ?? fetch;
  const upsert = deps.upsert ?? upsertRates;

  const url = `${config.fxApiUrl}/latest?from=USD`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Frankfurter responded ${res.status} for ${url}`);
  }

  const parsed = frankfurterSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`Frankfurter payload invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const { date, rates } = parsed.data;

  const rows: FxRow[] = Object.entries(rates).map(([to, rate]) => ({
    date,
    from_ccy: 'USD',
    to_ccy: to,
    rate,
  }));
  rows.push({ date, from_ccy: 'USD', to_ccy: 'USD', rate: 1 });

  await upsert(rows);
  console.log(`[fx] synced ${rows.length} USD-base rates for ${date}`);
  return rows.length;
}
