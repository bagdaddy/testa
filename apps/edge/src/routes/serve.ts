import { Hono } from 'hono';
import type { Env } from '../types.ts';

export const serve = new Hono<{ Bindings: Env }>();

serve.get('/projects/:slug{.+\\.js}', (c) => {
  // Implemented in Phase 2.7 — KV-backed bundle assembly.
  return c.text('// pixel placeholder — Phase 2.7\n', 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-store',
  });
});
