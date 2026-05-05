# Reference — HMAC protocol (edge ↔ collector)

The edge worker authenticates batches to the collector via HMAC-SHA256. This is the **only** auth on `/_ingest`.

## The contract

### Request

```
POST /_ingest HTTP/1.1
Content-Type: application/json
X-Edge-Signature: <64-hex-char HMAC-SHA256>

{
  "signed_at": 1730902400123,
  "events": [ ... ]
}
```

`signed_at` is Unix milliseconds. It's INSIDE the body so it's covered by the signature (no separate header you could spoof).

### Signature

```
secret    = INGEST_SHARED_SECRET                  (env, ≥ 16 chars)
body      = exact bytes of the request body       (after JSON serialization, before any
                                                   compression — collector reads .text())
signature = hex( hmac_sha256(secret, body) )
```

The signature covers **the entire JSON body**, which already contains `signed_at`. No need to canonicalize headers or query strings.

### Verification (collector side)

```ts
1. Read raw body as a string (not parsed).
2. Compute expected = hex(hmac_sha256(INGEST_SHARED_SECRET, rawBody)).
3. Constant-time compare expected vs request.headers['x-edge-signature'].
   On mismatch: return 401, do not read body further.
4. Parse body as JSON. Read body.signed_at.
5. If |Date.now() - signed_at| > INGEST_REPLAY_WINDOW * 1000:
     return 400 "replay window exceeded".
6. Zod-validate body against IngestBatch schema.
7. Process events.
```

### Replay window

`INGEST_REPLAY_WINDOW` env (seconds, default 300 = 5 min).

Bounds the window in which a captured request could be replayed. The signed body cannot be tampered with, but a network observer who captured a valid request could replay it. The 5-min window plus optional event_id deduplication at the consumer makes this a no-op in practice.

We do NOT track signature replay across requests (would need shared state). Per-event deduplication is handled by `event_id` UUIDs being unique by definition + a 1-day fast-path dedup at the consumer (using a Redis set with TTL).

## Implementation

### Edge worker side (`apps/edge/src/ingest.ts`)

```ts
async function signAndPost(events: EnrichedEvent[], env: Env): Promise<Response> {
  const body = JSON.stringify({
    signed_at: Date.now(),
    events,
  });

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.INGEST_SHARED_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sig = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return fetch(`${env.INGEST_ORIGIN_URL}/_ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-edge-signature': sig,
    },
    body,
  });
}
```

### Collector side (`apps/collector/src/auth/hmac.ts`)

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyHmac(rawBody: string, signatureHex: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}
```

### Hono middleware (`apps/collector/src/auth/middleware.ts`)

```ts
import { createMiddleware } from 'hono/factory';
import { config } from '../config.ts';
import { verifyHmac } from './hmac.ts';

export const requireEdgeSignature = createMiddleware(async (c, next) => {
  const sig = c.req.header('x-edge-signature') ?? '';
  // Hono lets us read the raw body via .text(), but Hono buffers it once;
  // calling c.req.json() afterwards would re-read — use c.req.raw for
  // unbuffered access if needed, or store text on context.
  const raw = await c.req.text();
  if (!verifyHmac(raw, sig, config.ingest.sharedSecret)) {
    return c.text('invalid signature', 401);
  }
  // pass parsed body via context to avoid re-reading
  c.set('rawBody', raw);
  await next();
});
```

## Secret rotation

`INGEST_SHARED_SECRET` lives as:

- **Worker secret** (set via `wrangler secret put INGEST_SHARED_SECRET`).
- **Collector env** (set via deployment secret manager).

To rotate:

1. Generate a new secret (32+ random bytes, base64 or hex).
2. Set the **collector** to accept BOTH old and new (env: `INGEST_SHARED_SECRET_PRIMARY`, `INGEST_SHARED_SECRET_SECONDARY`). Verify against either.
3. Update the **worker** with the new secret. Deploy.
4. Wait 24h for any in-flight to drain.
5. Remove the old secret from the collector. Deploy.

V1 ships with a single-secret model; secondary support is a follow-up if needed.

## What HMAC does NOT solve

- **Volumetric DoS.** Use Cloudflare DDoS protection + collector-side rate limit (per source IP) for that.
- **Validating event content.** Done by Zod at the same handler.
- **Authorizing per-project.** All events from the worker are trusted; the worker is the only client. Per-project rate limits live at the worker, not the collector.

## Test vectors (for `apps/collector/src/auth/__tests__/hmac.test.ts`)

```
secret = "test-secret-for-vectors-only-do-not-use"
body = '{"signed_at":1730902400123,"events":[]}'
expected_signature = e7c1...  // compute and pin in the test file
```

Generated with:

```sh
echo -n '{"signed_at":1730902400123,"events":[]}' | \
  openssl dgst -sha256 -hmac "test-secret-for-vectors-only-do-not-use"
```

Pin a few vectors in tests; treat them as load-bearing — they catch encoding bugs.
