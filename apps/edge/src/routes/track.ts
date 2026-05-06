import { Hono } from 'hono';
import type { Env } from '../types.ts';

export const track = new Hono<{ Bindings: Env }>();

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
} as const;

track.options(
  '/track',
  () =>
    new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    }),
);

track.post('/track', (c) => {
  // Implemented across Phase 2.2 → 2.6 (cookies, enrich, bot-filter, batch, forward).
  return c.text('not implemented', 501);
});
