/**
 * Collector HTTP server (Bun + Hono).
 *
 * Routes:
 *   POST /_ingest                 HMAC-signed batch from edge worker
 *   GET  /api/v1/metrics/:metric  pre-aggregated metric summaries (Phase 4.1)
 *   GET  /_internal/fx-rates      CH dictionary source (Phase 1.6)
 *   GET  /_internal/health        liveness + Redis/CH ping
 */

import { Hono } from 'hono';
import { config } from './config.ts';
import { ping as pingCh } from './db/clickhouse.ts';
import { makeIngestHandler } from './ingest/route.ts';
import { ping as pingRedis, redis } from './redis/client.ts';

const app = new Hono();

app.get('/_internal/health', async (c) => {
  const [redisOk, chOk] = await Promise.all([pingRedis(), pingCh().catch(() => false)]);
  const ok = redisOk && chOk;
  return c.json(
    {
      ok,
      service: 'collector',
      environment: config.environment,
      version: config.version,
      checks: { redis: redisOk, clickhouse: chOk },
    },
    ok ? 200 : 503,
  );
});

app.post('/_ingest', makeIngestHandler({ getRedis: () => redis() }));

app.get('/api/v1/metrics/:metric', (c) => c.text('not implemented', 501)); // Phase 4.1

app.get('/_internal/fx-rates', (c) => c.text('not implemented', 501)); // Phase 1.6

const port = config.port;

console.log(`[collector] starting on :${port} (${config.environment})`);

export default {
  port,
  fetch: app.fetch,
};
