/**
 * Smoke test for POST /_ingest.
 * Builds a batch, HMAC-signs the exact JSON body, posts it, prints the response.
 *
 *   bun run scripts/smoke-ingest.ts
 *
 * Env: PORT (default 8080), INGEST_SHARED_SECRET (default dev secret).
 */
import { createHmac, randomUUID } from 'node:crypto';

const PORT = process.env.PORT ?? '8080';
const SECRET = process.env.INGEST_SHARED_SECRET ?? 'dev-secret-change-me-please-1234';
const now = Date.now();

const base = {
  client_ts: now,
  server_ts: now,
  project_id: 42,
  visitor_id: 'smoke-visitor-1',
  session_id: 'smoke-session-1',
  consent_state: 'granted',
  tracker_version: '4.0.0-smoke',
  viewport_w: 1440,
  viewport_h: 900,
  country: 'LT',
  region: 'EU',
  region_subdivision: 'Vilnius',
  city: 'Vilnius',
  device_type: 'desktop',
  browser: 'chrome',
  os: 'macos',
  is_bot: 0 as const,
};

const batch = {
  signed_at: now,
  events: [
    {
      ...base,
      event_id: randomUUID(),
      event_name: 'experiment_view',
      url: 'https://demo.testa-soft.com/pricing',
      experiment_id: 1001,
      variation_id: 2,
    },
    {
      ...base,
      event_id: randomUUID(),
      event_name: 'purchase',
      url: 'https://demo.testa-soft.com/checkout/success',
      experiment_id: 1001,
      variation_id: 2,
      value_native: 149.99,
      currency: 'EUR',
      order_id: `order-${now}`,
      items_count: 3,
    },
  ],
};

const body = JSON.stringify(batch);
const signature = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

const res = await fetch(`http://localhost:${PORT}/_ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-edge-signature': signature },
  body,
});

console.log('status      :', res.status);
console.log('accepted    :', res.headers.get('x-events-accepted'));
console.log('deduplicated:', res.headers.get('x-events-deduplicated'));
const text = await res.text();
if (text) console.log('body        :', text);
