import type { EnrichedEvent, IngestBatch } from '@testa-platform/shared-types';
import type { Env } from './types.ts';

/**
 * Forward a batch of EnrichedEvents to the collector's `/_ingest` endpoint.
 *
 * Contract (per `docs/reference/hmac-protocol.md`):
 *   - body  = JSON.stringify({ signed_at, events })
 *   - sig   = hex(HMAC-SHA256(INGEST_SHARED_SECRET, body))
 *   - send  = POST {INGEST_ORIGIN_URL}/_ingest with X-Edge-Signature: <sig>
 *
 * Outcomes:
 *   - 2xx              resolve quietly. Caller (DurableObject flush) marks done.
 *   - 4xx              POISON BATCH. Log loudly. Resolve quietly so caller does
 *                      NOT retry — the events would just keep failing.
 *   - 5xx / network    THROW. Caller's exp-backoff alarm path retries.
 *
 * Empty `events` is a no-op.
 */

export async function forwardBatch(events: readonly EnrichedEvent[], env: Env): Promise<void> {
  if (events.length === 0) return;

  const batch: IngestBatch = {
    signed_at: Date.now(),
    events: events as EnrichedEvent[],
  };
  const body = JSON.stringify(batch);
  const signature = await signHmacSha256(body, env.INGEST_SHARED_SECRET);

  let res: Response;
  try {
    res = await fetch(`${env.INGEST_ORIGIN_URL}/_ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-edge-signature': signature,
      },
      body,
    });
  } catch (err) {
    // Network error — treat as 5xx so the DO retries.
    throw new Error(`ingest network error: ${(err as Error).message}`);
  }

  if (res.status >= 500) {
    throw new Error(`collector ${res.status}`);
  }
  if (res.status >= 400) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    console.error(
      `[ingest] poison batch dropped: status=${res.status} events=${events.length} detail=${detail.slice(0, 200)}`,
    );
    return;
  }
  // 2xx — success
}

/**
 * HMAC-SHA256 over `body`, returned as 64-char lowercase hex.
 *
 * Uses the Workers-native `crypto.subtle` (no `node:crypto` import — Workers
 * runtime doesn't ship Node's crypto module by default, even with nodejs_compat).
 */
export async function signHmacSha256(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return bytesToHex(new Uint8Array(sigBuf));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
