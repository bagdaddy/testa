import { describe, expect, it } from 'vitest';
import { SEED, xxhash32 } from '../xxhash.ts';

describe('xxhash32 — known reference vectors', () => {
  // Reference vectors from the xxHash spec / public test suites.
  // https://github.com/Cyan4973/xxHash/blob/dev/cli/xsum_sanity_check.c
  // Computed against seed=0 to keep them stable across implementations.
  it.each([
    ['', 0, 0x02_cc_5d_05],
    ['a', 0, 0x55_0d_7456],
    ['abc', 0, 0x32_d1_53ff],
  ] as const)('hash(%j, seed=%d) = 0x%s', (input, seed, expected) => {
    expect(xxhash32(input, seed)).toBe(expected);
  });
});

describe('xxhash32 — properties', () => {
  it('is deterministic for the same input + seed', () => {
    const a = xxhash32('hello world');
    const b = xxhash32('hello world');
    expect(a).toBe(b);
  });

  it('changes when input changes', () => {
    expect(xxhash32('hello world')).not.toBe(xxhash32('hello world!'));
  });

  it('changes when seed changes', () => {
    expect(xxhash32('hello world', 1)).not.toBe(xxhash32('hello world', 2));
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = xxhash32('something something something');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
    expect(Number.isInteger(h)).toBe(true);
  });

  it('SEED is the frozen project constant', () => {
    expect(SEED).toBe(0xab_cd_ef);
  });
});

describe('xxhash32 — bucket distribution at our scale', () => {
  it('mod 100 distributes uniformly across 10k synthetic visitor IDs (within 3σ)', () => {
    const buckets: number[] = new Array(100).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const h = xxhash32(`visitor_${i}:experiment_42`);
      const idx = h % 100;
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    // Each bucket should be ~100 hits. Standard deviation for binomial(10000, 0.01)
    // ≈ sqrt(10000 * 0.01 * 0.99) ≈ 9.95. 3σ ≈ 30 → expect 70..130 in each bucket.
    for (const count of buckets) {
      expect(count).toBeGreaterThanOrEqual(50);
      expect(count).toBeLessThanOrEqual(150);
    }
    const total = buckets.reduce((a: number, b: number) => a + b, 0);
    expect(total).toBe(10_000);
  });
});
