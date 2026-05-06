import type { ProjectConfig } from '@testa-platform/shared-types';
import { Hono } from 'hono';
import { getOrCreateVisitorId } from '../cookies.ts';
import { renderPixel } from '../serve/render.ts';
import type { Env } from '../types.ts';

export const serve = new Hono<{ Bindings: Env }>();

/**
 * GET /projects/{slug}.js
 *
 * Reads project config + the integration_version-matching bundle from KV,
 * inlines `window.cfPrefill`, sets the first-party `_testa_uuid` cookie,
 * returns the combined JS body.
 *
 * Caching: 60s public, 5min stale-while-revalidate. ETag = config_hash so
 * a republish in crobot busts the customer's pixel on next pageview without
 * waiting for max-age expiry.
 */
serve.get('/projects/:slug{.+\\.js}', async (c) => {
  const rawSlug = c.req.param('slug');
  const slug = rawSlug.replace(/\.js$/, '');
  if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) {
    return c.text('// invalid project slug\n', 400, {
      'content-type': 'application/javascript; charset=utf-8',
    });
  }

  const configRaw = await c.env.KV_PROJECT_CONFIG.get(`project_config:${slug}`);
  if (!configRaw) {
    return c.text('// project not found\n', 404, {
      'content-type': 'application/javascript; charset=utf-8',
    });
  }

  let config: ProjectConfig;
  try {
    config = JSON.parse(configRaw) as ProjectConfig;
  } catch {
    return c.text('// project config corrupt\n', 500, {
      'content-type': 'application/javascript; charset=utf-8',
    });
  }

  const bundleKey = `integration_bundle:${config.integration_version}`;
  const bundle = await c.env.KV_INTEGRATION_BUNDLES.get(bundleKey);
  if (!bundle) {
    return c.text('// integration bundle missing\n', 500, {
      'content-type': 'application/javascript; charset=utf-8',
    });
  }

  const etag = `"${config.config_hash}"`;
  const ifNone = c.req.header('if-none-match');
  if (ifNone === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const visitor = await getOrCreateVisitorId(c.req.raw, c.env);
  const body = renderPixel(config, bundle, c.env.ENVIRONMENT);

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=60, stale-while-revalidate=300',
      etag,
      'set-cookie': visitor.set_cookie_header,
    },
  });
});
