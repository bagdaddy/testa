import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it, vi } from 'vitest';
import app from '../index.ts';

const FIXTURE_4_0: ProjectConfig = {
  project_id: 42,
  slug: 'foo',
  integration_version: '4.0',
  consent_mode: 'aware',
  experiments: [],
  published_at: '2026-05-07T00:00:00.000Z',
  config_hash: 'abcdef123456',
};

const FIXTURE_3_6: ProjectConfig = {
  ...FIXTURE_4_0,
  slug: 'bar',
  integration_version: '3.6',
  config_hash: 'fedcba654321',
};

const BUNDLE_4_0 = '/* loader+runtime 4.0 */ console.log("4.0");';
const BUNDLE_3_6 = '/* legacy 3.6 */ window.crbData = {};';

function makeEnv(
  opts: {
    configs?: Record<string, ProjectConfig>;
    bundles?: Record<string, string>;
  } = {},
) {
  const configs = opts.configs ?? {};
  const bundles = opts.bundles ?? {};
  const get = vi.fn(async (key: string): Promise<string | null> => {
    if (key.startsWith('project_config:')) {
      const slug = key.slice('project_config:'.length);
      return configs[slug] ? JSON.stringify(configs[slug]) : null;
    }
    if (key.startsWith('integration_bundle:')) {
      const v = key.slice('integration_bundle:'.length);
      return bundles[v] ?? null;
    }
    if (key.startsWith('customer_hosts:')) return null;
    return null;
  });
  return {
    KV_PROJECT_CONFIG: { get } as unknown as KVNamespace,
    KV_INTEGRATION_BUNDLES: { get } as unknown as KVNamespace,
    BATCH_BUFFER: {} as DurableObjectNamespace,
    INGEST_SHARED_SECRET: '',
    INGEST_ORIGIN_URL: '',
    COOKIE_FALLBACK_DOMAIN: '.testa.com',
    VISITOR_ID_SALT: '',
    ENVIRONMENT: 'test',
  } as Parameters<typeof app.fetch>[1];
}

describe('GET /projects/:slug.js — 4.0 happy path', () => {
  it('returns 200 with cfPrefill block and the 4.0 bundle', async () => {
    const env = makeEnv({
      configs: { foo: FIXTURE_4_0 },
      bundles: { '4.0': BUNDLE_4_0 },
    });
    const res = await app.fetch(new Request('https://track.testa.com/projects/foo.js'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('etag')).toBe(`"${FIXTURE_4_0.config_hash}"`);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');

    const body = await res.text();
    expect(body).toContain('window.cfPrefill');
    expect(body).toContain('"project_id":42');
    expect(body).toContain('window.cfPrefill.env = "test"');
    expect(body).toContain(BUNDLE_4_0);
  });
});

describe('GET /projects/:slug.js — 3.6 frozen bundle', () => {
  it('returns the legacy bundle verbatim, no cfPrefill block', async () => {
    const env = makeEnv({
      configs: { bar: FIXTURE_3_6 },
      bundles: { '3.6': BUNDLE_3_6 },
    });
    const res = await app.fetch(new Request('https://track.testa.com/projects/bar.js'), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('cfPrefill');
    expect(body).toBe(BUNDLE_3_6);
  });
});

describe('GET /projects/:slug.js — 304 cache match', () => {
  it('returns 304 when If-None-Match matches the config_hash', async () => {
    const env = makeEnv({
      configs: { foo: FIXTURE_4_0 },
      bundles: { '4.0': BUNDLE_4_0 },
    });
    const res = await app.fetch(
      new Request('https://track.testa.com/projects/foo.js', {
        headers: { 'if-none-match': `"${FIXTURE_4_0.config_hash}"` },
      }),
      env,
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('returns 200 when If-None-Match does not match', async () => {
    const env = makeEnv({
      configs: { foo: FIXTURE_4_0 },
      bundles: { '4.0': BUNDLE_4_0 },
    });
    const res = await app.fetch(
      new Request('https://track.testa.com/projects/foo.js', {
        headers: { 'if-none-match': '"stale"' },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe('GET /projects/:slug.js — error paths', () => {
  it('returns 404 when project_config:slug is missing', async () => {
    const env = makeEnv({ bundles: { '4.0': BUNDLE_4_0 } });
    const res = await app.fetch(new Request('https://track.testa.com/projects/missing.js'), env);
    expect(res.status).toBe(404);
  });

  it('returns 500 when integration_bundle is missing', async () => {
    const env = makeEnv({ configs: { foo: FIXTURE_4_0 } });
    const res = await app.fetch(new Request('https://track.testa.com/projects/foo.js'), env);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('integration bundle missing');
  });

  it('returns 400 when slug contains invalid characters', async () => {
    const env = makeEnv({});
    const res = await app.fetch(new Request('https://track.testa.com/projects/bad..slug.js'), env);
    expect(res.status).toBe(400);
  });
});

describe('GET /projects/:slug.js — XSS-safe cfPrefill', () => {
  it('escapes </script in the project JSON', async () => {
    const env = makeEnv({
      configs: {
        evil: {
          ...FIXTURE_4_0,
          slug: 'evil',
          tracking_domain: 'foo</script><script>alert(1)</script>',
        },
      },
      bundles: { '4.0': BUNDLE_4_0 },
    });
    const res = await app.fetch(new Request('https://track.testa.com/projects/evil.js'), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('</script><script>');
    expect(body).toContain('<\\/script>');
  });
});
