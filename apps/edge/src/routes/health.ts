import { Hono } from 'hono';
import type { Env } from '../types.ts';

export const health = new Hono<{ Bindings: Env }>();

health.get('/health', (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));
