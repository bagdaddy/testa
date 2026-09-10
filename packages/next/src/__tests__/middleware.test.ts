/**
 * End-to-end middleware test through real `next/server` NextRequest/NextResponse
 * — proves the split-URL flow: 307 to the variant + Set-Cookie, control passes
 * through, prefetch is a no-op.
 */

import { ASSIGNMENT_COOKIE, UUID_BACKUP_COOKIE, UUID_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it, vi } from 'vitest';
import { createTestaProxy } from '../middleware.ts';
import { setVisitorId } from '../visitor-id.ts';
import { splitUrlConfig } from './helpers.ts';

function request(
  url: string,
  opts: { cookie?: string; prefetch?: boolean; data?: boolean } = {},
): NextRequest {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.prefetch) headers.set('next-router-prefetch', '1');
  // Next normalizes a data request's URL to the page path before middleware
  // sees it, and marks it with this header.
  if (opts.data) headers.set('x-nextjs-data', '1');
  return new NextRequest(new URL(url), { headers });
}

const mw = () => createTestaProxy({ projectSlug: 'acme', config: splitUrlConfig() });

describe('createTestaProxy', () => {
  it('307-redirects a redirect-variation visitor to the variant', async () => {
    const res = await mw()(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
  });

  it('passes a control-variation visitor through without redirect', async () => {
    const res = await mw()(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
    );
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('mints a _testa_uuid cookie for a fresh visitor', async () => {
    const res = await mw()(request('https://acme.com/home'));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('_testa_uuid=');
  });

  it('warms a prefetch to the variant for an already-assigned visitor, but never commits (no Set-Cookie)', async () => {
    // Soft-nav M1: a sticky (cookie-first) assignment is stable, so we redirect
    // the prefetch to warm the variant RSC — but write nothing.
    const res = await mw()(
      request('https://acme.com/pricing', {
        cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
        prefetch: true,
      }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('passes a fresh visitor’s prefetch through (speculative bucket not committed, no mint)', async () => {
    const res = await mw()(request('https://acme.com/pricing', { prefetch: true }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('fails open (pass-through) when config resolves to null', async () => {
    const mwNoConfig = createTestaProxy({ projectSlug: 'acme', loadConfig: async () => null });
    const res = await mwNoConfig(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
    );
    expect(res.status).not.toBe(307);
  });

  describe('handler composition (customer middleware runs INSIDE the proxy)', () => {
    it('passes x-testa-shield to the handler and keeps its own request overrides', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          const headers = new Headers(req.headers);
          headers.set('x-domain', 'acme.com');
          return NextResponse.next({ request: { headers } });
        },
      });
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      // Handler's own override AND testa's shield both survive on ONE response.
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
      // Testa cookies merge onto the handler's response.
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });

    it('patches the shield override even when the handler returns a plain next()', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: () => NextResponse.next(),
      });
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });

    it('treats a handler returning undefined as pass-through (shield + cookies intact)', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: () => undefined,
      });
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });

    it('delegates bypassed requests (e.g. /api/*) straight to the handler', async () => {
      let sawShield: string | null = 'sentinel';
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          sawShield = req.headers.get('x-testa-shield');
          const headers = new Headers(req.headers);
          headers.set('x-domain', 'acme.com');
          return NextResponse.next({ request: { headers } });
        },
      });
      const res = await proxy(request('https://acme.com/api/leads'));
      // Handler ran and its API-route headers survive; testa stayed out entirely.
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(sawShield).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('skips the handler on a split-URL redirect (nothing downstream renders)', async () => {
      let handlerRan = false;
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: () => {
          handlerRan = true;
          return NextResponse.next();
        },
      });
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.status).toBe(307);
      expect(handlerRan).toBe(false);
    });

    it('delegates to the handler when config fails to resolve (fail open THROUGH the handler)', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => null,
        handler: (req) => {
          const headers = new Headers(req.headers);
          headers.set('x-domain', 'acme.com');
          return NextResponse.next({ request: { headers } });
        },
      });
      const res = await proxy(request('https://acme.com/pricing'));
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
    });

    it('returns a handler redirect as-is, with testa cookies applied', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => NextResponse.redirect(new URL('/login', req.url), 307),
      });
      // Control-assigned visitor → testa passes through, handler's redirect wins.
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/login');
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });
  });

  describe('tail-call composition (customer proxy runs FIRST, then calls testa)', () => {
    // The customer pattern: mutate request headers, then hand testa the
    // mutated request. Testa must forward those headers downstream on EVERY
    // path, so it is transparent to upstream request mutation.
    function mutatedRequest(url: string, opts: { cookie?: string } = {}): NextRequest {
      const base = request(url, opts);
      const headers = new Headers(base.headers);
      headers.set('x-domain', 'acme.com');
      return new NextRequest(base, { headers });
    }

    it('forwards upstream header mutations on the pass-through path', async () => {
      const res = await mw()(
        mutatedRequest('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
    });

    it('forwards upstream header mutations on the bypass path (/api/*)', async () => {
      const res = await mw()(mutatedRequest('https://acme.com/api/leads'));
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('forwards upstream header mutations when config fails to resolve', async () => {
      const proxy = createTestaProxy({ projectId: 'acme', loadConfig: async () => null });
      const res = await proxy(mutatedRequest('https://acme.com/pricing'));
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
    });

    it('forwards upstream header mutations on a prefetch pass-through', async () => {
      const base = request('https://acme.com/pricing', { prefetch: true });
      const headers = new Headers(base.headers);
      headers.set('x-domain', 'acme.com');
      const res = await mw()(new NextRequest(base, { headers }));
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(res.headers.get('set-cookie')).toBeNull(); // prefetch still never commits
    });
  });

  describe('internal request filter (safe without a matcher)', () => {
    /** A loose `contains` page rule that would also match asset URLs like /pricing-hero.png. */
    const looseConfig = () => {
      const cfg = splitUrlConfig();
      const exp = cfg.experiments[0];
      if (!exp) throw new Error('splitUrlConfig produced no experiment');
      return {
        ...cfg,
        experiments: [
          { ...exp, rules: [{ match_type: 'contains' as const, url_pattern: '/pricing' }] },
        ],
      };
    };

    it('never redirects an asset even when a loose experiment rule matches it', async () => {
      const proxy = createTestaProxy({ projectId: 'acme', config: looseConfig() });
      const res = await proxy(
        request('https://acme.com/pricing-hero.png', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('passes /_next/* through untouched (no cookies, no config fetch)', async () => {
      let configFetched = false;
      const proxy = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => {
          configFetched = true;
          return splitUrlConfig();
        },
      });
      const res = await proxy(request('https://acme.com/_next/static/chunks/main.js'));
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(configFetched).toBe(false);
    });

    it('honors custom skipPaths end-to-end', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        skipPaths: ['/pricing'],
      });
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('non-GET requests (Server Actions, form posts) are never experiment traffic', () => {
    // The regression this fixes: a Server Action POSTs to the CURRENT page URL;
    // a matching split-URL rule 307-redirected the POST (307 preserves the
    // method), breaking the action — the visitor just stayed on the page.
    const post = (headers: Record<string, string> = {}): NextRequest =>
      new NextRequest(new URL('https://acme.com/pricing'), {
        method: 'POST',
        headers: new Headers({ cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`, ...headers }),
      });

    it('passes a POST through untouched even when a redirect rule matches (no 307, no cookies)', async () => {
      const res = await mw()(post());
      expect(res.status).not.toBe(307);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('passes a Server Action POST (next-action header) through untouched', async () => {
      const res = await mw()(post({ 'next-action': 'abc123' }));
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('never fetches config for a POST', async () => {
      let configFetched = false;
      const proxy = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => {
          configFetched = true;
          return splitUrlConfig();
        },
      });
      await proxy(post());
      expect(configFetched).toBe(false);
    });

    it('still runs the composed handler on a POST (bypass stays transparent)', async () => {
      let sawMethod: string | undefined;
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          sawMethod = req.method;
          return NextResponse.next();
        },
      });
      await proxy(post());
      expect(sawMethod).toBe('POST');
    });

    it('redirects HEAD for an assigned visitor but never commits (no Set-Cookie)', async () => {
      // curl -I / uptime monitors: show the real redirect, but never mint a
      // visitor or fire an exposure for a request that isn't a real pageview.
      const res = await mw()(
        new NextRequest(new URL('https://acme.com/pricing'), {
          method: 'HEAD',
          headers: new Headers({ cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
        }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('passes a fresh visitor’s HEAD through without minting cookies', async () => {
      const res = await mw()(
        new NextRequest(new URL('https://acme.com/pricing'), { method: 'HEAD' }),
      );
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('speculative loads (Sec-Purpose) and crawlers never commit', () => {
    it('warms a Speculation-Rules prefetch/prerender to the variant without committing', async () => {
      const res = await mw()(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({
            cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
            'sec-purpose': 'prefetch;prerender',
          }),
        }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/pricing-v2');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    const crawlerUa = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

    it('bypasses a crawler entirely: no redirect, no cookies, no config fetch', async () => {
      let configFetched = false;
      const proxy = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => {
          configFetched = true;
          return splitUrlConfig();
        },
      });
      const res = await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({
            cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
            'user-agent': crawlerUa,
          }),
        }),
      );
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(configFetched).toBe(false);
    });

    it('traces the bot bypass when debug is on', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        debug: true,
      });
      const res = await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({ 'user-agent': crawlerUa }),
        }),
      );
      expect(JSON.parse(res.headers.get('x-testa-debug') ?? '{}')).toMatchObject({
        bypass: 'bot',
      });
    });

    it('skipBots: false opts back into treating crawlers as visitors', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        skipBots: false,
      });
      const res = await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({
            cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
            'user-agent': crawlerUa,
          }),
        }),
      );
      expect(res.status).toBe(307);
    });

    it('still runs the composed handler for a crawler (bypass stays transparent)', async () => {
      let sawUa: string | null = null;
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          sawUa = req.headers.get('user-agent');
          return NextResponse.next();
        },
      });
      await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({ 'user-agent': crawlerUa }),
        }),
      );
      expect(sawUa).toBe(crawlerUa);
    });
  });

  describe('debug tracing (`debug: true`)', () => {
    const debugMw = () =>
      createTestaProxy({ projectId: 'acme', config: splitUrlConfig(), debug: true });
    const trace = (res: Response): Record<string, unknown> =>
      JSON.parse(res.headers.get('x-testa-debug') ?? '{}');

    it('emits no header (and no log) by default', async () => {
      const res = await mw()(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.headers.get('x-testa-debug')).toBeNull();
    });

    it('traces a redirect decision: resolved URL, its source, assignment, target', async () => {
      const res = await debugMw()(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.status).toBe(307);
      expect(trace(res)).toMatchObject({
        url: 'https://acme.com/pricing',
        urlSource: 'request-url',
        applied: [{ experiment: 101, variation: 2 }],
        redirect: 'https://acme.com/pricing-v2',
      });
    });

    it('traces a pass-through decision with the shield verdict', async () => {
      const res = await debugMw()(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(trace(res)).toMatchObject({ url: 'https://acme.com/pricing', shield: false });
      expect(trace(res)).not.toHaveProperty('redirect');
    });

    it('traces WHY a request was bypassed — the Server Action POST case', async () => {
      const res = await debugMw()(
        new NextRequest(new URL('https://acme.com/pricing'), { method: 'POST' }),
      );
      expect(trace(res)).toMatchObject({ bypass: 'method', method: 'POST' });
    });

    it('traces a path bypass and a no-config fail-open', async () => {
      const asset = await debugMw()(request('https://acme.com/logo.png'));
      expect(trace(asset)).toMatchObject({ bypass: 'path' });

      const noConfig = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => null,
        debug: true,
      });
      const res = await noConfig(request('https://acme.com/pricing'));
      expect(trace(res)).toMatchObject({ bypass: 'no-config' });
    });

    it('traces the winning URL mechanism behind an ingress', async () => {
      const res = await debugMw()(
        new NextRequest(new URL('http://10.0.3.17:3000/pricing'), {
          headers: new Headers({
            cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
            'x-forwarded-host': 'acme.com',
            'x-forwarded-proto': 'https',
          }),
        }),
      );
      expect(trace(res)).toMatchObject({
        url: 'https://acme.com/pricing',
        urlSource: 'x-forwarded-host',
        redirect: 'https://acme.com/pricing-v2',
      });
    });
  });

  describe('public-URL resolution (container/ingress rewrites Host to an internal one)', () => {
    // The regression this fixes: split-URL rules target PUBLIC URLs, so a
    // request whose Host was rewritten by istio/ingress would never match.
    const internal = (headers: Record<string, string>): NextRequest =>
      new NextRequest(new URL('http://10.0.3.17:3000/pricing'), {
        headers: new Headers({ cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`, ...headers }),
      });

    it('does NOT match on the internal URL without any public-host signal (the bug)', async () => {
      const res = await mw()(internal({}));
      expect(res.status).not.toBe(307);
    });

    it('recovers the public URL from X-Forwarded-Host/Proto and redirects', async () => {
      const res = await mw()(
        internal({ 'x-forwarded-host': 'acme.com', 'x-forwarded-proto': 'https' }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://acme.com/pricing-v2');
    });

    it('recovers the public URL from RFC 7239 Forwarded', async () => {
      const res = await mw()(internal({ forwarded: 'for=192.0.2.60;proto=https;host=acme.com' }));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://acme.com/pricing-v2');
    });

    it('honors the x-testa-host escape hatch over mangled forwarded headers', async () => {
      const res = await mw()(
        internal({
          'x-testa-host': 'acme.com',
          'x-testa-proto': 'https',
          'x-forwarded-host': 'svc.cluster.local',
        }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://acme.com/pricing-v2');
    });

    it('honors the explicit publicHost option with no headers at all', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        publicHost: 'https://acme.com',
      });
      const res = await proxy(internal({}));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://acme.com/pricing-v2');
    });

    it('uses the public hostname (not the internal one) for discoverRootDomain cookies', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        discoverRootDomain: true,
      });
      const res = await proxy(
        internal({ 'x-forwarded-host': 'www.acme.com', 'x-forwarded-proto': 'https' }),
      );
      expect(res.headers.get('set-cookie') ?? '').toContain('Domain=acme.com');
    });
  });

  describe("framework params never touch the visitor's query", () => {
    it('decides a soft nav — it is the only signal a Pages Router site sends', async () => {
      const res = await mw()(
        request('https://acme.com/pricing', {
          cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
          data: true,
        }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/pricing-v2');
    });

    it("keeps everything the visitor has, even when it looks like Next's own", async () => {
      // `slug=pricing` equals a path segment, so a value-based rule would drop
      // it. It might be the visitor's — so it stays.
      const res = await mw()(
        request('https://acme.com/pricing?utm_source=fb&slug=pricing', {
          cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
          data: true,
        }),
      );
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('utm_source=fb');
      expect(location).toContain('slug=pricing');
    });

    it('drops `_rsc` from the redirect it builds', async () => {
      const res = await mw()(
        request('https://acme.com/pricing?_rsc=8f2a1&utm_source=fb', {
          cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
        }),
      );
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('utm_source=fb');
      expect(location).not.toContain('_rsc');
    });

    it('still matches an end-anchored regex rule on a soft nav', async () => {
      // `/pricing$` against `…/pricing?_rsc=8f2a1` is false while the param is
      // there, so the experiment worked on hard loads and nowhere else.
      const config = splitUrlConfig();
      const regexConfig = {
        ...config,
        experiments: config.experiments.map((experiment) => ({
          ...experiment,
          rules: [{ match_type: 'regex' as const, url_pattern: '/pricing$' }],
          variations: experiment.variations.map((variation) => ({
            ...variation,
            changes: variation.changes.map((change) =>
              change.type === 'redirect'
                ? { ...change, from_url: '/pricing$', url_match_type: 'regex' as const }
                : change,
            ),
          })),
        })),
      };
      const proxy = createTestaProxy({ projectSlug: 'acme', config: regexConfig });
      const res = await proxy(
        request('https://acme.com/pricing?_rsc=8f2a1', {
          cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
        }),
      );
      expect(res.status).toBe(307);
    });
  });

  describe('an unexpected failure never takes the site down', () => {
    it('passes the request through when the proxy throws', async () => {
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        // A resolver that explodes stands in for any unforeseen internal fault.
        loadConfig: () => {
          throw new Error('boom');
        },
        decisions: 'server',
      });
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await proxy(request('https://acme.com/pricing'));
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      spy.mockRestore();
    });

    it('still runs the customer handler on that path', async () => {
      const handler = vi.fn(() => NextResponse.next({ headers: { 'x-mine': '1' } }));
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        loadConfig: () => {
          throw new Error('boom');
        },
        decisions: 'server',
        handler,
      });
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await proxy(request('https://acme.com/pricing'));
      expect(handler).toHaveBeenCalled();
      expect(res.headers.get('x-mine')).toBe('1');
      spy.mockRestore();
    });
  });

  describe('the proxy reports the exposure at assignment', () => {
    /** Collect every fetch the proxy makes, with its parsed JSON body. */
    function captureFetch(): Array<{ url: string; body: Record<string, unknown> }> {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(String(init?.body ?? '{}'));
          } catch {
            body = {};
          }
          calls.push({ url: String(url), body });
          return new Response('{}', { status: 200 });
        }),
      );
      return calls;
    }

    const leads = (calls: Array<{ url: string; body: Record<string, unknown> }>) =>
      calls.filter((c) => c.url.includes('/api/leads'));

    // The counting point is what makes the observed split equal the configured
    // one. Both arms are counted here, at the same instant; anything later puts
    // the variant an extra 307 + page load deeper into the funnel than control
    // and undercounts it — which reads downstream as SRM.
    it('counts BOTH arms at assignment — the variant before its 307', async () => {
      const proxy = createTestaProxy({ projectSlug: 'acme', config: splitUrlConfig() });
      const arm = async (assignment: string) => {
        const calls = captureFetch();
        const res = await proxy(
          request('https://acme.com/pricing', {
            cookie: `${UUID_COOKIE}=known-visitor; ${ASSIGNMENT_COOKIE}=${assignment}`,
          }),
        );
        const posted = leads(calls);
        vi.unstubAllGlobals();
        return { status: res.status, posted };
      };

      // Variant: the lead is posted even though the response is a 307 and this
      // page is about to be torn down — the browser never gets a chance here.
      const variant = await arm('101.2.0.0');
      expect(variant.status).toBe(307);
      expect(variant.posted).toHaveLength(1);
      expect(variant.posted[0]?.body).toMatchObject({
        experiment: 101,
        variation: 2,
        uuid: 'known-visitor',
        url: 'https://acme.com/pricing',
        source: 'proxy:document',
      });

      // Control: same instant, same depth in the funnel. Equal counting points
      // on both arms is what keeps the observed split honest.
      const control = await arm('101.1.0.0');
      expect(control.status).not.toBe(307);
      expect(control.posted).toHaveLength(1);
      expect(control.posted[0]?.body).toMatchObject({ experiment: 101, variation: 1 });
    });

    it("forwards the VISITOR user agent and IP, not the runtime's", async () => {
      const headers: Array<Record<string, string>> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).includes('/api/leads')) {
            headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
          }
          return new Response('{}', { status: 200 });
        }),
      );
      const proxy = createTestaProxy({ projectSlug: 'acme', config: splitUrlConfig() });
      await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({
            cookie: `${UUID_COOKIE}=known-visitor`,
            'user-agent': 'Mozilla/5.0 (Macintosh)',
            'x-forwarded-for': '203.0.113.9, 70.41.3.18',
          }),
        }),
      );
      expect(headers[0]?.['user-agent']).toBe('Mozilla/5.0 (Macintosh)');
      expect(headers[0]?.['x-forwarded-for']).toBe('203.0.113.9');
      vi.unstubAllGlobals();
    });

    it('does not count bots or speculative loads', async () => {
      const calls = captureFetch();
      const proxy = createTestaProxy({ projectSlug: 'acme', config: splitUrlConfig() });
      await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({ 'user-agent': 'Googlebot/2.1' }),
        }),
      );
      await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          method: 'HEAD',
          headers: new Headers({ cookie: `${UUID_COOKIE}=known-visitor` }),
        }),
      );
      expect(leads(calls)).toEqual([]);
      vi.unstubAllGlobals();
    });

    it('stays silent when `tracking: false` hands counting to the browser', async () => {
      const calls = captureFetch();
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
      });
      await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({ cookie: `${UUID_COOKIE}=known-visitor` }),
        }),
      );
      expect(leads(calls)).toEqual([]);
      vi.unstubAllGlobals();
    });
  });

  describe('caller-supplied visitor id', () => {
    /** Cookies the response actually sets, name -> value. */
    function setCookies(res: NextResponse): Record<string, string> {
      const out: Record<string, string> = {};
      for (const c of res.cookies.getAll()) out[c.name] = c.value;
      return out;
    }

    it('buckets on the caller id and mirrors it into BOTH cookies', async () => {
      // The readable copy matters as much as the backup: the browser half reads
      // `_testa_uuid` from document.cookie and no-ops on an empty id, so
      // writing only the HttpOnly copy leaves client-side tracking dead.
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        visitorId: () => 'their-own-id',
      });
      let seen: string | undefined;
      const withHook = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        visitorId: () => 'their-own-id',
        onVariationAssigned: (event) => {
          seen = event.visitorId;
        },
      });
      const res = await proxy(request('https://acme.com/pricing'));
      await withHook(request('https://acme.com/pricing'));

      expect(seen).toBe('their-own-id');
      const cookies = setCookies(res);
      expect(cookies[UUID_COOKIE]).toBe('their-own-id');
      expect(cookies[UUID_BACKUP_COOKIE]).toBe('their-own-id');
    });

    it('SEEDS a new visitor but never re-keys a returning one', async () => {
      // Re-keying moves a returning visitor to a different variation
      // mid-experiment — possibly while they are standing on the page their old
      // variation sent them to. The existing id always wins.
      let seen: string | undefined;
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        visitorId: () => 'their-own-id',
        onVariationAssigned: (event) => {
          seen = event.visitorId;
        },
      });
      await proxy(request('https://acme.com/pricing', { cookie: `${UUID_COOKIE}=already-here` }));
      expect(seen).toBe('already-here');
    });

    it('keeps a returning visitor known only by the HttpOnly backup', async () => {
      let seen: string | undefined;
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        visitorId: () => 'their-own-id',
        onVariationAssigned: (event) => {
          seen = event.visitorId;
        },
      });
      await proxy(
        request('https://acme.com/pricing', { cookie: `${UUID_BACKUP_COOKIE}=survived` }),
      );
      expect(seen).toBe('survived');
    });

    it('accepts a plain string as well as a resolver', async () => {
      let seen: string | undefined;
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        visitorId: 'static-id',
        onVariationAssigned: (event) => {
          seen = event.visitorId;
        },
      });
      await proxy(request('https://acme.com/pricing'));
      expect(seen).toBe('static-id');
    });

    it('receives the request, so the id can come off a cookie or header', async () => {
      let seen: string | undefined;
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        visitorId: (req) => req.cookies.get('my_visitor_id')?.value ?? null,
        onVariationAssigned: (event) => {
          seen = event.visitorId;
        },
      });
      await proxy(request('https://acme.com/pricing', { cookie: 'my_visitor_id=from-cookie' }));
      expect(seen).toBe('from-cookie');
    });

    it.each([
      ['returns null', () => null],
      ['returns undefined', () => undefined],
      ['returns empty string', () => ''],
      [
        'throws',
        () => {
          throw new Error('identity service down');
        },
      ],
    ])('falls back to minting when the resolver %s', async (_label, resolver) => {
      let seen: string | undefined;
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        visitorId: resolver as () => string | null | undefined,
        onVariationAssigned: (event) => {
          seen = event.visitorId;
        },
      });
      await proxy(request('https://acme.com/pricing'));
      // A minted uuid, not a crash and not an empty id.
      expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('keeps assignment stable across requests for the same caller id', async () => {
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        visitorId: () => 'stable-visitor',
      });
      const first = await proxy(request('https://acme.com/pricing'));
      const second = await proxy(request('https://acme.com/pricing'));
      // Same id in, same bucketing out — the property the contract depends on.
      expect(first.status).toBe(second.status);
    });
  });

  describe('setVisitorId', () => {
    /** Capture the id the engine actually bucketed on. */
    function proxyCapturing(seen: { id?: string }, options = {}) {
      return createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        onVariationAssigned: (event) => {
          seen.id = event.visitorId;
        },
        ...options,
      });
    }

    it('seeds a NEW visitor, and is ignored for a returning one', async () => {
      const seen: { id?: string } = {};
      const proxy = proxyCapturing(seen);
      const req = request('https://acme.com/pricing', { cookie: `${UUID_COOKIE}=already-here` });
      setVisitorId(req, 'too-late');
      await proxy(req);
      expect(seen.id).toBe('already-here');
    });

    it('uses an id handed over for THIS request', async () => {
      const seen: { id?: string } = {};
      const proxy = proxyCapturing(seen);
      const req = request('https://acme.com/pricing');
      setVisitorId(req, 'awaited-id');
      await proxy(req);
      expect(seen.id).toBe('awaited-id');
    });

    it('supports an id that had to be awaited', async () => {
      const seen: { id?: string } = {};
      const proxy = proxyCapturing(seen);
      const req = request('https://acme.com/pricing');
      // The `visitorId` option is called synchronously inside the decision
      // path and cannot do this — the whole reason this helper exists.
      setVisitorId(req, await Promise.resolve('from-session-lookup'));
      await proxy(req);
      expect(seen.id).toBe('from-session-lookup');
    });

    it('beats the visitorId option (both are only seeds)', async () => {
      const seen: { id?: string } = {};
      const proxy = proxyCapturing(seen, { visitorId: () => 'from-option' });
      const req = request('https://acme.com/pricing');
      setVisitorId(req, 'from-setter');
      await proxy(req);
      expect(seen.id).toBe('from-setter');
    });

    it('does NOT leak between concurrent requests', async () => {
      // The reason this is keyed on the request and not module state: one
      // isolate serves many visitors at once, and a parked value would assign
      // one visitor another's variation.
      const ids: string[] = [];
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        onVariationAssigned: (event) => {
          ids.push(event.visitorId);
        },
      });
      const reqs = ['alice', 'bob', 'carol'].map((name) => {
        const r = request('https://acme.com/pricing');
        setVisitorId(r, name);
        return r;
      });
      await Promise.all(reqs.map((r) => proxy(r)));
      expect(ids.sort()).toEqual(['alice', 'bob', 'carol']);
    });

    it('ignores an empty id and falls through', async () => {
      const seen: { id?: string } = {};
      const proxy = proxyCapturing(seen, { visitorId: () => 'from-option' });
      const req = request('https://acme.com/pricing');
      setVisitorId(req, '');
      await proxy(req);
      expect(seen.id).toBe('from-option');
    });

    it("a request with nothing set still gets Testa's own id", async () => {
      const seen: { id?: string } = {};
      const proxy = proxyCapturing(seen);
      await proxy(request('https://acme.com/pricing'));
      expect(seen.id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('cookie-loss instrumentation', () => {
    function requestWith(cookie: string, referer?: string): NextRequest {
      const headers = new Headers();
      if (cookie) headers.set('cookie', cookie);
      if (referer) headers.set('referer', referer);
      return new NextRequest(new URL('https://acme.com/pricing'), { headers });
    }

    /** Capture what the server hook was told about the request's cookies. */
    async function stateFor(cookie: string, referer?: string) {
      let seen: unknown;
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        onVariationAssigned: (_event, ctx) => {
          seen = ctx.cookies;
        },
      });
      await proxy(requestWith(cookie, referer));
      return seen as {
        hadVisitorId: boolean;
        hadAssignment: boolean;
        otherCookies: number;
        sameSiteReferer: boolean;
      };
    }

    it('separates "cookies do not work here" from "ours went missing"', async () => {
      // A browser mid-session: cart, session, consent — but no id of ours. This
      // visitor is about to be re-bucketed and may land in the other group.
      const lost = await stateFor('cart=abc; sid=9; consent=1', 'https://acme.com/cart');
      expect(lost.hadVisitorId).toBe(false);
      expect(lost.otherCookies).toBe(3);
      expect(lost.sameSiteReferer).toBe(true);

      // A client that stores nothing at all — every request mints a visitor.
      const cookieless = await stateFor('');
      expect(cookieless.hadVisitorId).toBe(false);
      expect(cookieless.otherCookies).toBe(0);
    });

    it('reports a returning visitor as intact', async () => {
      const state = await stateFor(`${UUID_COOKIE}=v1; ${ASSIGNMENT_COOKIE}=101.2.0.0; cart=abc`);
      expect(state.hadVisitorId).toBe(true);
      expect(state.hadAssignment).toBe(true);
      expect(state.otherCookies).toBe(1);
    });

    it('does not count a cross-site referer as same-site', async () => {
      const state = await stateFor('cart=abc', 'https://google.com/search');
      expect(state.sameSiteReferer).toBe(false);
    });

    it('flags the anomaly in the debug trace, and only then', async () => {
      const proxy = createTestaProxy({
        projectSlug: 'acme',
        config: splitUrlConfig(),
        tracking: false,
        debug: true,
      });
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

      const lost = await proxy(requestWith('cart=abc; sid=9'));
      expect(JSON.parse(lost.headers.get('x-testa-debug') ?? '{}').cookieLoss).toBe(2);

      const intact = await proxy(requestWith(`${UUID_COOKIE}=v1; cart=abc`));
      expect(JSON.parse(intact.headers.get('x-testa-debug') ?? '{}').cookieLoss).toBeUndefined();

      const noCookies = await proxy(requestWith(''));
      expect(JSON.parse(noCookies.headers.get('x-testa-debug') ?? '{}').cookieLoss).toBeUndefined();
      spy.mockRestore();
    });
  });

  describe('the visitor id survives a cookie being cleared', () => {
    /** All Set-Cookie values on the response, as a single string. */
    const setCookies = (res: NextResponse): string =>
      [...res.headers.entries()]
        .filter(([name]) => name.toLowerCase() === 'set-cookie')
        .map(([, value]) => value)
        .join('\n');

    function req(cookie: string): NextRequest {
      const headers = new Headers();
      if (cookie) headers.set('cookie', cookie);
      return new NextRequest(new URL('https://acme.com/pricing'), { headers });
    }

    it('writes an HttpOnly copy alongside a freshly minted id', async () => {
      const res = await mw()(req(''));
      const cookies = setCookies(res);
      const id = /_testa_uuid=([^;]+)/.exec(cookies)?.[1];
      expect(id).toBeTruthy();
      // Same value, and only the copy is hidden from scripts.
      expect(cookies).toContain(`${UUID_BACKUP_COOKIE}=${id}`);
      expect(/_testa_uuid_s=[^;]+;[^\n]*HttpOnly/i.test(cookies)).toBe(true);
      expect(/_testa_uuid=[^;]+;[^\n]*HttpOnly/i.test(cookies)).toBe(false);
    });

    it('restores the readable id from the copy instead of minting a second visitor', async () => {
      // What a consent tool leaves behind: the readable cookie gone, the
      // HttpOnly copy untouched because scripts cannot see it.
      const res = await mw()(req(`${UUID_BACKUP_COOKIE}=v-original; cart=abc`));
      expect(setCookies(res)).toContain(`${UUID_COOKIE}=v-original`);
    });

    it('puts the restored visitor back in the SAME variation', async () => {
      // The assignment cookie is gone too, so the engine re-buckets — and lands
      // on the same variation, because the bucket is a hash of the id.
      const withCookies = await mw()(req(`${UUID_COOKIE}=v-original`));
      const restored = await mw()(req(`${UUID_BACKUP_COOKIE}=v-original`));
      const variationOf = (res: NextResponse): string | undefined =>
        /_testa_exp=101\.(\d+)/.exec(setCookies(res))?.[1];
      expect(variationOf(restored)).toBe(variationOf(withCookies));
    });

    it('keeps the readable cookie authoritative when the two disagree', async () => {
      // The client engine minted its own id on a pageview the proxy never saw.
      // Adopting the older server copy would move an active visitor between
      // variations mid-session.
      const res = await mw()(req(`${UUID_COOKIE}=v-client; ${UUID_BACKUP_COOKIE}=v-stale`));
      const cookies = setCookies(res);
      expect(cookies).toContain(`${UUID_BACKUP_COOKIE}=v-client`);
      expect(cookies).not.toContain('v-stale');
    });

    it('leaves both alone when they already agree', async () => {
      const res = await mw()(req(`${UUID_COOKIE}=v1; ${UUID_BACKUP_COOKIE}=v1`));
      expect(setCookies(res)).not.toContain(`${UUID_COOKIE}=v1`);
    });
  });
});
