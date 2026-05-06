/**
 * Cloudflare Worker — testa-edge
 *
 * Routes (Phase 2):
 *   GET  /health              healthcheck
 *   GET  /projects/:slug.js   serve pixel loader+runtime from KV (Phase 2.7)
 *   POST /track               accept events, enrich, batch, forward to collector (Phase 2.2-2.6)
 *   OPTIONS /track            CORS preflight
 *
 * This file is the composition root. Route handlers live under `routes/`.
 * The `BatchBuffer` DurableObject is exported here because Cloudflare's
 * runtime resolves DO classes from the entry module by name.
 */

import { Hono } from 'hono';
import { health } from './routes/health.ts';
import { serve } from './routes/serve.ts';
import { track } from './routes/track.ts';
import type { Env } from './types.ts';

const app = new Hono<{ Bindings: Env }>();

app.route('/', health);
app.route('/', serve);
app.route('/', track);

export default app;

/**
 * Durable Object — buffer + flush. Implementation in `./batch.ts`.
 * Re-exported here because Cloudflare's runtime resolves DO classes from
 * the entry module by name.
 */
export { BatchBuffer } from './batch.ts';
