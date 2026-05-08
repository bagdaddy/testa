import { describe, expect, it } from 'vitest';
import { isUuidv7, uuidv7 } from '../uuid7.ts';

describe('uuidv7 — format', () => {
  it('produces a canonical 36-char UUID string', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.length).toBe(36);
  });

  it('isUuidv7 accepts our own output and rejects v4', () => {
    expect(isUuidv7(uuidv7())).toBe(true);
    // A v4 UUID has version=4 in the right place.
    expect(isUuidv7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isUuidv7('not-a-uuid')).toBe(false);
  });
});

describe('uuidv7 — timestamp encoding', () => {
  it('embeds the supplied timestamp in the first 48 bits', () => {
    const fixedNow = 1_700_000_000_000; // arbitrary but non-zero
    const id = uuidv7(fixedNow);
    const hex = id.slice(0, 8) + id.slice(9, 13);
    expect(Number.parseInt(hex, 16)).toBe(fixedNow);
  });

  it('two calls in the same ms produce different IDs (random tail)', () => {
    const t = 1_700_000_000_000;
    const a = uuidv7(t);
    const b = uuidv7(t);
    expect(a).not.toBe(b);
    // First 13 chars (timestamp) match; tail differs.
    expect(a.slice(0, 13)).toBe(b.slice(0, 13));
    expect(a.slice(13)).not.toBe(b.slice(13));
  });

  it('later timestamps produce lexicographically-greater IDs', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(b > a).toBe(true);
  });
});
