/**
 * POST /track — accept events from the pixel, enrich, bot-filter, forward to
 * the BatchBuffer DurableObject for collector hand-off.
 *
 * Pipeline:
 *   1. Parse body as PixelEvent[] (tolerant — drops malformed entries, fails the
 *      whole request only if the envelope itself is unparseable).
 *   2. Read or mint `_testa_uuid` cookie.
 *   3. For each event:
 *        - Use the cookie's visitor_id when the event omits one (rare; pixel
 *          normally fills it from the cookie itself).
 *        - Enrich (geo + UA + server_ts).
 *        - Bot signal: verifiedBot → drop; heuristic hits → tag `is_bot=1`.
 *        - Forward to DO. DO key = `${project_id}:${visitor_id_bucket}` so
 *          events from one visitor stay in order, and load fans out across
 *          DOs at scale.
 *   4. Always respond 204 with Set-Cookie. We never surface backend status to
 *      the pixel — keepalive/sendBeacon don't read response bodies and we
 *      shouldn't leak whether traffic is being filtered.
 */

import type { EnrichedEvent, PixelEvent } from '@testa-platform/shared-types';
import { Hono } from 'hono';
import { botInputsFromRequest, botSignal } from '../bot.ts';
import { getOrCreateVisitorId } from '../cookies.ts';
import { enrich, inputsFromRequest } from '../enrich.ts';
import type { Env } from '../types.ts';

export const track = new Hono<{ Bindings: Env }>();

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
} as const;

const NO_STORE_HEADERS = {
  'cache-control': 'no-store',
} as const;

track.options(
  '/track',
  () =>
    new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    }),
);

track.post('/track', async (c) => {
  const request = c.req.raw;
  const env = c.env;

  // Body — tolerate any shape; reject only on parse failure.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const events = parsePixelEvents(raw);
  // We always set/refresh the cookie regardless of payload validity, so a
  // probe with an empty array still establishes visitor identity.
  const cookie = await getOrCreateVisitorId(request, env);

  const baseHeaders = {
    ...CORS_HEADERS,
    ...NO_STORE_HEADERS,
    'set-cookie': cookie.set_cookie_header,
  };

  if (events.length === 0) {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  const enrichInputs = inputsFromRequest(request);
  const botInputs = botInputsFromRequest(request);
  const botResult = botSignal(botInputs);

  // Verified-bot traffic is dropped wholesale. Pixel still gets 204 + cookie.
  if (botResult.drop) {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  // Forward each event to its routing DO. Errors here are swallowed —
  // a single failed DO add must not poison the whole batch (and the pixel
  // already has retry semantics for 5xx anyway). Real visibility comes from
  // DO-side logs.
  await Promise.allSettled(
    events.map((ev) => forwardOne(env, ev, cookie.visitor_id, enrichInputs, botResult.is_bot)),
  );

  return new Response(null, { status: 204, headers: baseHeaders });
});

async function forwardOne(
  env: Env,
  ev: PixelEvent,
  cookieVisitorId: string,
  enrichInputs: ReturnType<typeof inputsFromRequest>,
  isBot: 0 | 1,
): Promise<void> {
  // Trust the pixel's visitor_id when present (it's read from the cookie at
  // hydrate time) but fall back to the cookie we just minted for first-ever
  // pageloads where the pixel had no id yet.
  const visitor_id = ev.visitor_id || cookieVisitorId;
  const enriched: EnrichedEvent = enrich(enrichInputs, { ...ev, visitor_id });
  if (isBot === 1) enriched.is_bot = 1;

  const id = env.BATCH_BUFFER.idFromName(routingKey(enriched));
  const stub = env.BATCH_BUFFER.get(id);
  await stub.fetch('https://do/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(enriched),
  });
}

/**
 * DO routing key — `${project_id}:${visitor_bucket}`. Visitor bucket is the
 * first byte of `visitor_id` so we get 256-way fan-out per project, which is
 * plenty for v1. Same visitor's events always land on the same DO so the
 * collector sees them in order.
 */
function routingKey(ev: EnrichedEvent): string {
  const bucket = (ev.visitor_id || '00').slice(0, 2).toLowerCase();
  return `${ev.project_id}:${bucket}`;
}

/**
 * Hand-rolled validation. Cheap (no zod runtime in the worker bundle) and
 * tolerant — drops malformed entries instead of failing the whole batch.
 */
function parsePixelEvents(raw: unknown): PixelEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: PixelEvent[] = [];
  for (const entry of raw) {
    const parsed = parseOne(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseOne(raw: unknown): PixelEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.event_id !== 'string' || r.event_id.length === 0) return null;
  if (typeof r.event_name !== 'string' || r.event_name.length === 0) return null;
  if (typeof r.client_ts !== 'number' || !Number.isFinite(r.client_ts)) return null;
  if (typeof r.project_id !== 'number' || !Number.isFinite(r.project_id)) return null;
  if (typeof r.visitor_id !== 'string') return null;
  if (typeof r.session_id !== 'string') return null;
  if (typeof r.url !== 'string') return null;
  if (typeof r.tracker_version !== 'string') return null;
  if (typeof r.consent_state !== 'string') return null;
  if (typeof r.viewport_w !== 'number') return null;
  if (typeof r.viewport_h !== 'number') return null;
  return r as unknown as PixelEvent;
}
