/**
 * xxhash32 — pure JavaScript implementation.
 *
 * Used for deterministic variation bucketing (`traffic.ts`). Picked over
 * Math.random() to eliminate Sample Ratio Mismatch drift and to enable
 * cross-device consistency, QA forcing, and audit (see project memory:
 * architecture_variation_bucketing.md).
 *
 * Reference: https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md
 *
 * **`SEED` is a frozen constant.** Changing it would re-bucket every visitor
 * who doesn't have a cached `_testa_exp_<id>` cookie, instantly de-stabilizing
 * every running A/B test. Don't change it.
 */

export const SEED = 0xab_cd_ef;

const PRIME32_1 = 0x9e_37_79_b1;
const PRIME32_2 = 0x85_eb_ca_77;
const PRIME32_3 = 0xc2_b2_ae_3d;
const PRIME32_4 = 0x27_d4_eb_2f;
const PRIME32_5 = 0x16_5667_b1;

/**
 * Compute xxhash32 of a string. Returns an unsigned 32-bit integer.
 */
export function xxhash32(input: string, seed: number = SEED): number {
  const bytes = new TextEncoder().encode(input);
  return xxhash32Bytes(bytes, seed);
}

function xxhash32Bytes(bytes: Uint8Array, seed: number): number {
  const len = bytes.length;
  let h32: number;
  let i = 0;

  if (len >= 16) {
    let v1 = (seed + PRIME32_1 + PRIME32_2) | 0;
    let v2 = (seed + PRIME32_2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - PRIME32_1) | 0;

    while (i + 16 <= len) {
      v1 = round(v1, readU32LE(bytes, i));
      v2 = round(v2, readU32LE(bytes, i + 4));
      v3 = round(v3, readU32LE(bytes, i + 8));
      v4 = round(v4, readU32LE(bytes, i + 12));
      i += 16;
    }
    h32 = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    h32 = (seed + PRIME32_5) | 0;
  }

  h32 = (h32 + len) | 0;

  while (i + 4 <= len) {
    h32 = mul32(h32 + mul32(readU32LE(bytes, i), PRIME32_3), 1) | 0;
    h32 = mul32(rotl(h32, 17), PRIME32_4);
    i += 4;
  }
  while (i < len) {
    h32 = mul32(h32 + mul32(bytes[i] ?? 0, PRIME32_5), 1) | 0;
    h32 = mul32(rotl(h32, 11), PRIME32_1);
    i += 1;
  }

  // Finalize (avalanche).
  h32 ^= h32 >>> 15;
  h32 = mul32(h32, PRIME32_2);
  h32 ^= h32 >>> 13;
  h32 = mul32(h32, PRIME32_3);
  h32 ^= h32 >>> 16;
  return h32 >>> 0;
}

function round(acc: number, input: number): number {
  let a = (acc + mul32(input, PRIME32_2)) | 0;
  a = rotl(a, 13);
  return mul32(a, PRIME32_1);
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** Multiplication that stays in 32-bit unsigned space. JS multiplies in float64. */
function mul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
