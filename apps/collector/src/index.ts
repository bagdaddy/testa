/**
 * Collector HTTP server (Bun + Hono).
 *
 * Routes (Phase 1, 4):
 *   POST /_ingest                accept HMAC-signed batch from edge worker (Phase 1.4)
 *   GET  /api/v1/metrics/:metric  pre-aggregated metric summaries (Phase 4.1)
 *   GET  /_internal/fx-rates      CH dictionary source (Phase 1.6)
 *   GET  /_internal/health        liveness
 *
 * Phase 0.4 (skeleton).
 */

import { Hono } from 'hono';
import { config } from './config.ts';

const app = new Hono();

app.get('/_internal/health', (c) =>
  c.json({
    ok: true,
    service: 'collector',
    environment: config.environment,
    version: config.version,
  }),
);

app.post('/_ingest', (c) => c.text('not implemented', 501)); // Phase 1.4

app.get('/api/v1/metrics/:metric', (c) => c.text('not implemented', 501)); // Phase 4.1

app.get('/_internal/fx-rates', (c) => c.text('not implemented', 501)); // Phase 1.6

const port = config.port;

console.log(`[collector] starting on :${port} (${config.environment})`);

export default {
  port,
  fetch: app.fetch,
};
