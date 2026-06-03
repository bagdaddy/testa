/**
 * `POST /_ingest` route handler.
 *
 *   raw body  → HMAC verify (401 on fail)
 *             → JSON parse + zod schema (400 on fail)
 *             → replay-window check (401 on fail)
 *             → per-event enqueue (503 on Redis failure)
 *             → 204
 *
 * Per-event JSON parse failures are NOT possible here — the body is parsed
 * once into a typed batch and individual events are object references after
 * that. Schema-level zod validation surfaces the offending field.
 */

import type { Context } from 'hono';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { config } from '../config.ts';
import { verify } from './hmac.ts';
import { enqueue } from './stream.ts';

const ingestBatchSchema = z.object({
  signed_at: z.number(),
  events: z
    .array(
      z
        .object({
          event_id: z.string().min(1),
          event_name: z.string().min(1),
          client_ts: z.number(),
          server_ts: z.number(),
          project_id: z.number(),
          visitor_id: z.string(),
          session_id: z.string(),
          url: z.string(),
          consent_state: z.string(),
          tracker_version: z.string(),
          viewport_w: z.number(),
          viewport_h: z.number(),
          country: z.string(),
          region: z.string(),
          region_subdivision: z.string(),
          city: z.string(),
          device_type: z.string(),
          browser: z.string(),
          os: z.string(),
          is_bot: z.union([z.literal(0), z.literal(1)]),
        })
        .passthrough(),
    )
    .max(10_000),
});

export interface IngestRouteDeps {
  /** Resolved lazily so importing the module doesn't open a connection. */
  getRedis: () => Redis;
  /** Override `Date.now` for tests. */
  now?: () => number;
}

export function makeIngestHandler(deps: IngestRouteDeps) {
  const now = deps.now ?? (() => Date.now());

  return async (c: Context): Promise<Response> => {
    const signature = c.req.header('x-edge-signature');
    const rawBody = await c.req.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.text('invalid json', 400);
    }

    const result = ingestBatchSchema.safeParse(parsed);
    if (!result.success) {
      return c.json(
        { error: 'schema validation failed', issues: result.error.issues.slice(0, 5) },
        400,
      );
    }
    const batch = result.data;

    const v = verify({
      rawBody,
      signature,
      secret: config.ingest.sharedSecret,
      signedAtMs: batch.signed_at,
      nowMs: now(),
      replayWindowMs: config.ingest.replayWindowSec * 1000,
    });
    if (!v.valid) {
      console.warn(
        `[ingest] auth fail reason=${v.reason} signed_at=${batch.signed_at} now=${now()}`,
      );
      return c.text('unauthorized', 401);
    }

    let accepted = 0;
    let deduped = 0;
    try {
      const redis = deps.getRedis();
      for (const ev of batch.events) {
        const r = await enqueue(ev as never, {
          redis,
          streamKey: config.redis.streamKey,
          streamMaxLen: config.redis.streamMaxLen,
          dedupNames: config.dedup.eventNames,
          dedupTtlSec: config.dedup.ttlSec,
        });
        accepted += 1;
        if (r.deduped) deduped += 1;
      }
    } catch (err) {
      console.error('[ingest] redis write failed', { err: (err as Error).message });
      return c.text('redis unavailable', 503);
    }

    c.header('x-events-accepted', String(accepted));
    c.header('x-events-deduplicated', String(deduped));
    return c.body(null, 204);
  };
}
