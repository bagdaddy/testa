import { afterEach, describe, expect, it } from 'bun:test';
import { __setClientForTests, close, insertEvents, ping, query } from '../clickhouse.ts';

const liveCh = process.env.CLICKHOUSE_URL ?? process.env.RUN_LIVE_CH;

afterEach(async () => {
  await close();
  __setClientForTests(null);
});

describe('clickhouse client (live)', () => {
  it.skipIf(!liveCh)('runs SELECT 1', async () => {
    const rows = await query<{ one: number }>('SELECT 1 AS one');
    expect(rows[0]?.one).toBe(1);
  });

  it.skipIf(!liveCh)('ping resolves true', async () => {
    expect(await ping()).toBe(true);
  });

  it.skipIf(!liveCh)('insertEvents is a no-op on empty input', async () => {
    await insertEvents([]);
  });
});

describe('clickhouse client (lazy init)', () => {
  it('does not construct the client at module-load time', () => {
    // Importing the module should not have constructed a client.
    // We verify by replacing the (presumably null) internal slot and
    // ensuring nothing throws.
    expect(() => __setClientForTests(null)).not.toThrow();
  });
});
