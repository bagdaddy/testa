/**
 * FX rates storage layer — reads/writes `fx_rates_history` (migration 010).
 *
 * The table is a ReplacingMergeTree, so writes are idempotent per
 * (date, from_ccy, to_ccy): re-running a day's sync overwrites rather than
 * duplicating. Reads use FINAL to collapse not-yet-merged duplicates.
 */

import { insertRows, query } from '../db/clickhouse.ts';

export interface FxRow {
  /** ISO date, 'YYYY-MM-DD'. */
  date: string;
  from_ccy: string;
  to_ccy: string;
  rate: number;
}

const TABLE = 'fx_rates_history';

/** Upsert rows. ReplacingMergeTree dedups on (date, from_ccy, to_ccy) at merge. */
export async function upsertRates(rows: readonly FxRow[]): Promise<void> {
  await insertRows(TABLE, rows);
}

/**
 * Most recent `days` of rates, newest first. Used by the dictionary endpoint.
 *
 * NB: the output column is aliased `date_str` (not `date`) on purpose — ClickHouse
 * exposes SELECT aliases inside WHERE/ORDER BY, so aliasing `toString(date) AS date`
 * would shadow the real `Date` column and break the `date >= today() - N` comparison.
 */
export async function recentRates(days: number): Promise<FxRow[]> {
  const rows = await query<{
    date_str: string;
    from_ccy: string;
    to_ccy: string;
    rate: number;
  }>(
    `SELECT toString(date) AS date_str, from_ccy, to_ccy, rate
     FROM ${TABLE} FINAL
     WHERE date >= today() - {days:UInt16}
     ORDER BY date DESC, from_ccy, to_ccy`,
    { days },
  );
  return rows.map((r) => ({
    date: r.date_str,
    from_ccy: r.from_ccy,
    to_ccy: r.to_ccy,
    rate: r.rate,
  }));
}
