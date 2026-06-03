/**
 * HMAC verification for `POST /_ingest`.
 *
 * Pair to `apps/edge/src/ingest.ts#signHmacSha256`. The edge worker signs the
 * exact JSON body with `INGEST_SHARED_SECRET`; we recompute and constant-time
 * compare. `signed_at` lives inside the body so it's covered by the signature
 * — no separate header to spoof. See `docs/reference/hmac-protocol.md`.
 *
 * No I/O. Easy to unit-test.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifyReason =
  | 'missing_signature'
  | 'bad_signature_format'
  | 'signature_mismatch'
  | 'replay_window_exceeded';

export interface VerifyInput {
  /** Raw request body — exact bytes the edge signed. */
  rawBody: string;
  /** Signature from `x-edge-signature` header. */
  signature: string | null | undefined;
  /** Shared secret. */
  secret: string;
  /** `signed_at` from the parsed body, Unix milliseconds. */
  signedAtMs: number;
  /** Current wall time, Unix milliseconds. Inject for tests. */
  nowMs: number;
  /** Replay window, milliseconds. */
  replayWindowMs: number;
}

export type VerifyResult = { valid: true } | { valid: false; reason: VerifyReason };

const HEX_64 = /^[0-9a-f]{64}$/;

/** Compute the canonical signature for `body` under `secret`, as 64-char lowercase hex. */
export function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** Constant-time compare of two equal-length hex strings. Returns false on length mismatch. */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = new Uint8Array(Buffer.from(a, 'hex'));
  const bb = new Uint8Array(Buffer.from(b, 'hex'));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify both signature and replay window. Caller has already parsed the body
 * to extract `signedAtMs`; we don't re-parse.
 */
export function verify(input: VerifyInput): VerifyResult {
  const { rawBody, signature, secret, signedAtMs, nowMs, replayWindowMs } = input;

  if (!signature) return { valid: false, reason: 'missing_signature' };
  if (!HEX_64.test(signature)) return { valid: false, reason: 'bad_signature_format' };

  const expected = sign(rawBody, secret);
  if (!constantTimeHexEqual(signature, expected)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  if (Math.abs(nowMs - signedAtMs) > replayWindowMs) {
    return { valid: false, reason: 'replay_window_exceeded' };
  }

  return { valid: true };
}
