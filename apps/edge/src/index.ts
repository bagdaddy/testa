/**
 * Cloudflare Worker — testa-edge
 *
 * Routes (Phase 2):
 *   GET  /projects/:slug.js   serve pixel loader+runtime from KV (Phase 2.7)
 *   POST /track               accept events, enrich, batch, forward to collector (Phase 2.1-2.6)
 *   OPTIONS /track            CORS preflight
 *
 * Phase 0.3 (skeleton). Real implementation across Phase 2.
 */

import { Hono } from 'hono';

interface Env {
  KV_PROJECT_CONFIG: KVNamespace;
  KV_INTEGRATION_BUNDLES: KVNamespace;
  BATCH_BUFFER: DurableObjectNamespace;
  INGEST_SHARED_SECRET: string;
  INGEST_ORIGIN_URL: string;
  COOKIE_FALLBACK_DOMAIN: string;
  VISITOR_ID_SALT: string;
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

app.get('/projects/:slug{.+\\.js}', (c) => {
  // Implemented in Phase 2.7.
  return c.text('// pixel placeholder — Phase 2.7\n', 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-store',
  });
});

app.options('/track', (c) =>
  new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  }),
);

app.post('/track', (c) => {
  // Implemented in Phase 2.1 onwards.
  return c.text('not implemented', 501);
});

export default app;

/**
 * Durable Object stub — implemented in Phase 2.5.
 */
export class BatchBuffer implements DurableObject {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: stub
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
