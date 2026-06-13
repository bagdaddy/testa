import { afterAll, describe, expect, it } from 'bun:test';
import { close, command } from '../../db/clickhouse.ts';
import { type FxRow, recentRates, upsertRates } from '../store.ts';

// Requires a live ClickHouse with migration 010 applied (CI applies migrations
// before running collector tests). Skips otherwise.
const liveCh = process.env.CLICKHOUSE_URL ?? process.env.RUN_LIVE_CH;

afterAll(async () => {
  if (liveCh) await close().catch(() => undefined);
});

describe.skipIf(!liveCh)('fx store (live ClickHouse)', () => {
  it('upsert then read round-trips, and re-upsert overwrites (no duplicate)', async () => {
    const today = '2026-05-05';
    const v1: FxRow[] = [{ date: today, from_ccy: 'USD', to_ccy: 'EUR', rate: 0.9 }];
    await upsertRates(v1);

    // Re-run the same day with a new rate — ReplacingMergeTree should collapse.
    const v2: FxRow[] = [{ date: today, from_ccy: 'USD', to_ccy: 'EUR', rate: 0.95 }];
    await upsertRates(v2);

    const rows = await recentRates(3650);
    const eur = rows.filter((r) => r.date === today && r.to_ccy === 'EUR');
    expect(eur).toHaveLength(1);
    const [row] = eur;
    if (!row) throw new Error('expected one EUR row');
    expect(row.rate).toBe(0.95);

    // cleanup so reruns stay deterministic
    await command(`ALTER TABLE fx_rates_history DELETE WHERE date = '${today}'`);
  });
});
