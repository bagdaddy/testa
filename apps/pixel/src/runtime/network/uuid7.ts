/**
 * UUIDv7 generator (RFC 9562 §5.7).
 *
 *   layout: 48-bit unix-ms | 4-bit version (0b0111) | 12-bit random
 *           2-bit variant (0b10) | 62-bit random
 *
 * Why v7 instead of v4:
 *   - Time-prefixed → IDs from the same browser session sort naturally,
 *     which makes IDB outbox FIFO ordering trivial (same as the natural
 *     enqueue order).
 *   - Same uniqueness guarantees as v4 in practice (74 bits of randomness).
 *   - Collector-side dedup uses event_id; same-millisecond collisions are
 *     vanishingly unlikely with 74 bits of entropy.
 *
 * Monotonicity within a millisecond is NOT guaranteed by this implementation —
 * we trust the timestamp ordering at ms resolution and let the random bits
 * shuffle within each ms. Good enough for outbox FIFO; anyone needing strict
 * monotonic ordering should use ts as the secondary sort key.
 */

const VERSION_BITS = 0x70; // 0b01110000 — top nibble of byte 6 (0-indexed)
const VARIANT_BITS = 0x80; // 0b10000000 — top two bits of byte 8

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);

  // 48-bit unix-ms timestamp, big-endian, in bytes [0..6).
  // JS bitwise ops top out at 32 bits, so split into two halves.
  // Use Math.floor in case `now` is fractional (test injection).
  const ms = Math.floor(now);
  const hi = Math.floor(ms / 0x1_00_00_00_00); // top 16 bits of the 48-bit value
  const lo = ms >>> 0; // bottom 32 bits

  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;

  // Random for the rest, then overwrite the version + variant bits.
  fillRandom(bytes.subarray(6, 16));

  // Version 7 in the top nibble of byte 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | VERSION_BITS;
  // RFC 4122 variant (10xxxxxx) in the top two bits of byte 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | VARIANT_BITS;

  return formatUuid(bytes);
}

function fillRandom(buf: Uint8Array): void {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
    return;
  }
  // Fallback for environments without WebCrypto. Math.random isn't
  // cryptographically strong but UUID uniqueness is what matters here.
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
}

function formatUuid(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
  return UUID_RE.test(value);
}
