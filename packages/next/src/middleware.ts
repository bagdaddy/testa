/**
 * `createTestaProxy` — the one-line Next.js integration.
 *
 * This is the ONLY file that imports `next/server` at runtime; all decision
 * logic lives in the host-neutral `engine.ts` + experiment-core, so it stays
 * thin. Usage:
 *
 *   // middleware.ts
 *   import { createTestaProxy } from '@testa/next'
 *   export const middleware = createTestaProxy({ projectId: '3fa85f64e1c2b' })
 *   // Optional cost optimization (correctness never depends on it — see
 *   // request-filter.ts): a matcher skips the edge invocation on assets.
 *   export const config = { matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'] }
 */

import {
  ASSIGNMENT_COOKIE,
  SESSION_LENGTH_SEC,
  UUID_BACKUP_COOKIE,
  UUID_COOKIE,
} from '@testa-soft/experiment-core';
import {
  type LegacyMigrationResult,
  type UrlTraceEvent,
  type VariationAppliedEvent,
  beginUrlTrace,
  endUrlTrace,
  hasPendingDomChange,
  maybeMigrateLegacyCookies,
  runExperiments,
} from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server.js';
import type { NextFetchEvent } from 'next/server.js';
import { isCrawlerUserAgent } from './bot.ts';
import { applyRequestHeaders, isRedirect, toNextResponse } from './compose.ts';
import { ConfigClient, type ConfigSource } from './config.ts';
import { DEFAULT_CONFIG_HOST, DEFAULT_TRACKING_HOST, SHIELD_HEADER, readEnv } from './constants.ts';
import { NextCookieStore } from './cookie-store.ts';
import { type DecisionLog, sendDebugLog, sendDecisionLog } from './debug-log.ts';
import { createDebugEmitter, envDebugEnabled } from './debug.ts';
import { resolveCookieDomain } from './domain.ts';
import {
  type SkipPath,
  isDocumentMethod,
  isNavigationRequest,
  shouldBypassRequest,
} from './request-filter.ts';
import { stripFrameworkParams } from './soft-nav/framework-params.ts';
import { computePrefetchRedirect } from './soft-nav/prefetch-guard.ts';
import { isPrefetchRequest } from './soft-nav/rsc-redirect.ts';
import { emitExposure } from './tracking.ts';
import { type PublicHostOption, resolvePublicUrlDetailed } from './url-resolver.ts';
import { ensureVisitorId } from './uuid.ts';
import { getSuppliedVisitorId } from './visitor-id.ts';

export type { VariationAppliedEvent };

/** Where the bucketing/redirect decision happens. See `decisions`. */
export type ProxyDecisionMode = 'hybrid' | 'server' | 'client';

// Re-exported from `./constants.ts` so the server entry can share them without
// importing this (edge-only) module, while existing imports keep working.
export { DEFAULT_CONFIG_HOST, DEFAULT_TRACKING_HOST, SHIELD_HEADER } from './constants.ts';

export interface TestaProxyOptions extends ConfigSource {
  /**
   * The project's id — the ONLY thing a normal integration passes. Config is
   * fetched from `{host}/api/v1/config/{projectId}`.
   */
  projectId?: string;
  /** @deprecated Alias for `projectId`. */
  projectSlug?: string;
  /**
   * Config host. Defaults to the package's built-in host (`DEFAULT_CONFIG_HOST`),
   * or the `TESTA_CONFIG_HOST` env var. Override here for local/staging.
   */
  host?: string;
  /** Emit `Secure` cookies. Default true; set false for local http dev. */
  secureCookies?: boolean;
  /**
   * Session / exclusion-cooldown window in SECONDS (crobot 3.3.3 model): how long
   * a first-touch targeting verdict is cached and how long a conversion stays
   * attributed. Default 30 min (`SESSION_LENGTH_SEC`).
   */
  sessionLengthSec?: number;
  /**
   * TEMPORARY, for a site cutting over from the legacy crobot pixel while
   * experiments are LIVE. Before deciding anything, adopt a returning visitor's
   * legacy 3.x cookies (`_testa_exp_<id>`, `_testa_excl_<id>`, `_testa_ses_<id>`)
   * into the packed `_testa_exp` cookie this SDK uses.
   *
   * Without it, a visitor the legacy script already assigned looks brand new
   * here and is re-bucketed. 3.x allocated with `Math.random()`, so that re-roll
   * is a coin flip rather than a stable rehash: about half of all returning
   * visitors change variation mid-test, splitting their own conversions across
   * both arms.
   *
   * Leave it OFF for a project that has never run the legacy pixel — there is
   * nothing to adopt, and the flag only makes this SDK read cookies that will
   * never be there.
   *
   * TURN IT OFF once the experiments that were live during the cutover have
   * ended. It stops doing anything on its own at that point (it only looks at
   * experiments in the current config), so the flag is then dead weight rather
   * than a risk — but removing it is what lets the code go too.
   */
  legacyCookiesEnabled?: boolean;
  /**
   * Explicit cookie `Domain` for cross-subdomain tracking (e.g. `.acme.com`).
   * Wins over `discoverRootDomain`.
   */
  cookieDomain?: string;
  /** Auto-derive the registrable domain from the request host for cookies. */
  discoverRootDomain?: boolean;
  /**
   * The site's PUBLIC host, for topologies where the container/ingress layer
   * (k8s, istio) rewrites `Host` before the request reaches Next.js and the
   * proxy would otherwise see an internal URL (`pod-ip:3000`) — which makes
   * split-URL targeting silently never match. Accepts `'www.acme.com'`,
   * a full origin `'https://www.acme.com'`, or a per-request callback (e.g.
   * multi-tenant). Env alternative: `TESTA_PUBLIC_HOST`. When unset, the
   * public URL is recovered from `x-testa-host` / RFC 7239 `Forwarded` /
   * `X-Forwarded-Host` + `X-Forwarded-Proto` headers, then `Host`.
   */
  publicHost?: string | ((req: NextRequest) => string | null | undefined);
  /**
   * Emit a per-request decision trace: a `[testa] {…}` console line AND an
   * `x-testa-debug` response header (readable in the browser network tab /
   * `curl -sI`, no log access needed) carrying the resolved public URL and
   * which mechanism produced it, the bypass reason if any (method / path /
   * no-config), assignments, redirect target, and shield verdict. Also
   * enabled via `TESTA_DEBUG=1`. Off by default — don't leave on in
   * production; the header exposes experiment internals.
   */
  debug?: boolean;
  /**
   * Ship one line per decision to `{trackingHost}/log` — the URL as it arrived,
   * where we sent the visitor, the uuid, and what was applied.
   *
   * Separate from `debug`, and safe to leave on: it adds no response header and
   * no console output, so it exposes nothing to the visitor. Since the proxy
   * stopped creating leads, this is the only record of what the SERVER
   * concluded — without it a lead can only tell you what the browser reported.
   * Also enabled via `TESTA_LOG_DECISIONS=1`.
   */
  logDecisions?: boolean;
  /**
   * WHERE the bucketing/redirect decision is made, and what happens when this
   * server instance has no config in memory yet (a cold start).
   *
   * - `'hybrid'` (default) — decide server-side whenever the config is already
   *   in memory; on a cold instance pass the request through and let the
   *   CLIENT engine decide for that one pageview (it fetches its own config,
   *   and `<TestaGuard/>` hides the page meanwhile). No request ever waits on
   *   the network. Best on serverless, where an isolate that paid a blocking
   *   fetch is often torn down before it can reuse the result.
   * - `'server'` — always decide server-side, awaiting the config on a cold
   *   instance (capped by `fetchTimeoutMs`, default 400ms; on expiry the
   *   request proceeds without experiments). Every visitor gets the
   *   flicker-free redirect, at the cost of latency on cold requests. Best on
   *   long-lived servers, where that cost is paid once and amortised.
   * - `'client'` — never fetch or decide server-side; always pass through with
   *   the shield raised and let the client own everything. Skips the
   *   background refreshes that a sparse-traffic serverless deployment would
   *   otherwise discard unused.
   *
   * Assignment is cookie-pinned in every mode, so switching does not re-bucket
   * anyone — only where and when the decision happens changes.
   */
  decisions?: ProxyDecisionMode;
  /**
   * Latency budget (ms) for the cold fetch under `decisions: 'server'`.
   * Default 400. Other modes never block, so it does not apply.
   */
  fetchTimeoutMs?: number;
  /**
   * Skip experiments for crawlers, scripts, and monitors (user-agent based —
   * Googlebot, curl, HeadlessChrome, UptimeRobot, …). Default true: bots get
   * a clean pass-through — no assignment cookies, no redirects, no exposures —
   * so they never inflate visitor counts or skew results, and search engines
   * consistently see the control. Set false to treat them as visitors.
   * NOTE: this means `curl` shows control unless you send a browser UA
   * (`curl -A 'Mozilla/5.0 …'`); the `debug` trace marks these `bypass: bot`.
   */
  skipBots?: boolean;
  /**
   * Server-side hook, fired for each variation the visitor is assigned on a
   * request (control + variant) — e.g. capture the exposure to PostHog server,
   * a warehouse, or a webhook. `ctx.waitUntil(promise)` keeps an async call alive
   * until it completes AFTER the response is sent (it never delays the response).
   * Guard on `event.firstAssignment` to fire once per visitor, not per request.
   * Errors/rejections are swallowed so a hook never breaks the request.
   */
  onVariationAssigned?: (
    event: VariationAppliedEvent,
    ctx: VariationHookContext,
  ) => void | Promise<void>;
  /**
   * Report the exposure to Testa AT ASSIGNMENT — the moment the visitor is
   * bucketed, before any split-URL 307 leaves. Default true.
   *
   * THIS IS THE ONLY POINT THAT COUNTS BOTH ARMS AT THE SAME INSTANT, which is
   * what keeps the observed split equal to the configured one. Counting from
   * the browser instead puts the two arms at different depths in the funnel: a
   * control visitor is counted when their page renders, a variant visitor only
   * after a 307 AND a second page load, so everyone who abandons in between is
   * counted for control and not for variant. That gap is a sample ratio
   * mismatch produced entirely by where the count is taken.
   *
   * The browser keeps counting too (`<TestaProvider tracking/>`), and the two
   * do not double up: crobot dedups on `(experiment_id, uuid)`. The overlap is
   * deliberate — the browser is the only side that can still name a visitor
   * whose cookie stopped sticking (it recovers the id from its storage mirror),
   * so it covers exactly the traffic the server gets wrong, plus every pageview
   * the proxy never decided (a cold instance, `decisions: 'client'`).
   *
   * The cost of counting here is the converse: a client that will not store a
   * cookie is minted a fresh id on every request and reported as a fresh
   * visitor each time. `skipBots` (default true) removes the bulk of that
   * traffic before it reaches this point, and `ctx.cookies` on
   * `onVariationAssigned` is there to measure the remainder on live traffic.
   * Set false to leave counting entirely to the browser.
   */
  tracking?: boolean;
  /**
   * Base URL for exposure reporting (`/api/leads`) and the `/log` diagnostic
   * beacon. Defaults to `TESTA_TRACKING_HOST`, then the SDK's tracking host.
   */
  trackingHost?: string;
  /**
   * Use YOUR visitor id instead of Testa's own `_testa_uuid`.
   *
   * By default the proxy mints and persists its own id, which no other tool
   * shares. That is the root of every identity-stitching problem: an assignment
   * reported from the edge lands on a person your analytics has never seen, and
   * the browser session that follows lands on a different one. Merging them
   * afterwards is unreliable — PostHog, for instance, has deprecated `alias`
   * and will not merge an anonymous person with it at all.
   *
   * Supplying the id your analytics already keys on removes the problem instead
   * of patching it: both sides are the same person from the FIRST request, with
   * nothing to stitch — including the first-touch visitor who lands straight on
   * an experiment page, the one case merging can never fix (their analytics id
   * does not exist yet at the moment the server has to decide).
   *
   * The resolved id is mirrored into `_testa_uuid` AND the `HttpOnly` backup, so
   * the browser half (goal conversions, client-side exposures, the cold
   * fallback) keeps working — it reads the readable cookie.
   *
   * CONTRACT — the id MUST be stable per visitor and long-lived. Bucketing is
   * `hash(visitorId:experimentId)`, so an id that rotates re-buckets the
   * visitor on every rotation: a fresh coin flip each time. That corrupts
   * ASSIGNMENT, not just counting, and is a worse failure than the one this
   * option exists to fix. A session-scoped id is not usable here.
   *
   * Return `null`/`undefined` (or throw — errors are swallowed) to fall back to
   * Testa's own minting for that request.
   *
   * ```ts
   * createTestaProxy({
   *   projectId: '…',
   *   visitorId: (req) => req.cookies.get('my_visitor_id')?.value ?? null,
   * })
   * ```
   */
  visitorId?: string | ((req: NextRequest) => string | null | undefined);
  /**
   * Extra paths the proxy must pass through untouched, on top of the built-in
   * filter (`/_next/*`, `/api/*`, `/.well-known/*`, static-asset extensions).
   * A string matches as a segment-aligned prefix (`'/admin'` matches `/admin`
   * and `/admin/users`, not `/administrator`); a RegExp is tested against the
   * pathname.
   */
  skipPaths?: ReadonlyArray<SkipPath>;
  /**
   * Your own middleware logic, run INSIDE the proxy so both end up on the ONE
   * response Next.js allows (request-header overrides are wholesale per
   * response — two separately-built responses can't be merged). Semantics:
   * - Bypassed requests (`/api/*`, assets, `skipPaths`) delegate straight to
   *   the handler, so its headers still reach API routes testa skips.
   * - A split-URL redirect short-circuits — the handler is NOT called
   *   (nothing downstream renders).
   * - Otherwise the handler runs with `x-testa-shield` already in
   *   `req.headers`; clone them (`new Headers(req.headers)`) when overriding
   *   request headers. Testa merges its cookies onto the returned response and
   *   re-patches the shield override even if the handler returned a plain
   *   `NextResponse.next()`. Returning `null`/`undefined` means "continue".
   */
  handler?: TestaHandler;
}

/** Customer middleware logic composed inside the proxy — see `handler`. */
export type TestaHandler = (
  req: NextRequest,
  event?: NextFetchEvent,
) => Response | null | undefined | Promise<Response | null | undefined>;

export type TestaProxy = (req: NextRequest, event?: NextFetchEvent) => Promise<NextResponse>;

export function createTestaProxy(options: TestaProxyOptions): TestaProxy {
  const projectId = options.projectId ?? options.projectSlug;
  if (!projectId) {
    throw new Error('createTestaProxy: `projectId` is required');
  }
  const configClient = new ConfigClient(resolveConfigSource(options, projectId));
  const secure = options.secureCookies ?? true;
  // One host for both server-side posts: the `/api/leads` exposure and the
  // `/log` diagnostic beacon.
  const trackingEnabled = options.tracking !== false;
  const trackingHost = (
    options.trackingHost ??
    readEnv('TESTA_TRACKING_HOST') ??
    DEFAULT_TRACKING_HOST
  ).replace(/\/+$/, '');
  const publicHost: PublicHostOption<NextRequest> | undefined =
    options.publicHost ?? readEnv('TESTA_PUBLIC_HOST');
  const debugEnabled = options.debug ?? envDebugEnabled(readEnv('TESTA_DEBUG'));
  const emitDebug = createDebugEmitter(debugEnabled);
  // With debug on, the same trace also goes to crobot's `/log` (3.3.3
  // `sendLog` parity) — the customer's own logs are not ours to read.
  let beaconSeq = 0;
  const decisionLogging = options.logDecisions ?? envDebugEnabled(readEnv('TESTA_LOG_DECISIONS'));
  const skipBots = options.skipBots ?? true;

  /**
   * The proxy proper. Wrapped by `testaMiddleware` below, which guarantees a
   * response even if this throws — an experiment tool must never be able to
   * take a customer's site down.
   */
  /** Mirror a debug trace to crobot `/log`, keeping it alive past the response. */
  const beacon = (trace: unknown, event?: NextFetchEvent): void => {
    if (!debugEnabled) return;
    beaconSeq += 1;
    const pending = sendDebugLog(trackingHost, trace, `${Date.now()}-${beaconSeq}`);
    if (event?.waitUntil) event.waitUntil(pending);
    else void pending;
  };

  /** Ship the decision line, kept alive past the response. Never blocks. */
  const logDecision = (decision: DecisionLog, event?: NextFetchEvent): void => {
    if (!decisionLogging) return;
    beaconSeq += 1;
    const pending = sendDecisionLog(trackingHost, decision, `${Date.now()}-${beaconSeq}`);
    if (event?.waitUntil) event.waitUntil(pending);
    else void pending;
  };

  const decide = async (req: NextRequest, event?: NextFetchEvent): Promise<NextResponse> => {
    // Blackbox safety net, BEFORE any config fetch or cookie work: never treat
    // assets / framework internals / API routes — or non-GET/HEAD requests
    // (Server Actions / form posts hit the page URL with POST) — as pages, so
    // the proxy is correct even with no `config.matcher` at all (the matcher
    // is then purely a cost optimization — it skips the edge invocation).
    if (
      !isDocumentMethod(req.method) ||
      shouldBypassRequest(new URL(req.url).pathname, options.skipPaths)
    ) {
      const res = await delegate(options.handler, req, event);
      emitDebug?.(res, {
        url: req.url,
        bypass: isDocumentMethod(req.method) ? 'path' : 'method',
        method: req.method,
      });
      return res;
    }

    // Crawlers/scripts/monitors are never experiment traffic: no assignment,
    // no redirect, no exposure — they'd inflate visitor counts and skew
    // results, and search engines should consistently see the control.
    if (skipBots && isCrawlerUserAgent(req.headers.get('user-agent'))) {
      const res = await delegate(options.handler, req, event);
      emitDebug?.(res, { url: req.url, bypass: 'bot' });
      return res;
    }

    // The URL the VISITOR requested — `req.url` can carry an internal host on
    // self-hosted container/ingress stacks (istio et al. rewrite `Host`), which
    // would break split-URL targeting, cookie discovery, and redirect bases.
    const { url: resolvedUrl, source: urlSource } = resolvePublicUrlDetailed(req, publicHost);
    // Drop Next's OWN query params (`_rsc` on an App Router soft nav, `__next*`
    // plumbing) before anything matches against this URL or builds a redirect
    // from it. By name only — nothing the visitor typed is ever removed. See
    // framework-params.ts.
    const publicUrl = stripFrameworkParams(resolvedUrl);

    const cookieDomain = resolveCookieDomain(publicUrl.hostname, {
      ...(options.cookieDomain ? { cookieDomain: options.cookieDomain } : {}),
      ...(options.discoverRootDomain ? { discoverRootDomain: true } : {}),
    });
    const cookieState = readCookieState(req, publicUrl);
    const store = new NextCookieStore(req.cookies, {
      secure,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });
    // `decisions: 'client'` — never resolve a config here at all, so no fetch
    // (and no background refresh) is ever issued from the request path.
    const config =
      options.decisions === 'client'
        ? null
        : await configClient.get(
            projectId,
            Date.now(),
            event?.waitUntil ? event.waitUntil.bind(event) : undefined,
            // Document load vs RSC soft-nav/prefetch — drives 'per-pageload' caching.
            req.headers.get('rsc') !== '1',
          );

    // No config in memory (cold instance, or refreshes failing past the stale
    // bound) → pass through — THROUGH the composed handler, so the customer's
    // own middleware still runs — and hand this pageview to the client engine,
    // which fetches its own config and owns the decision, redirect included.
    //
    // The shield is raised PESSIMISTICALLY here: without a config we cannot
    // know whether this page has anything to hide, and a client-side redirect
    // or DOM apply is exactly the case that flashes without one. Hiding costs
    // an invisible paint bounded by the snippet's reveal timeout; not hiding
    // costs a visible flash of the control page. `<TestaGuard/>` reads this
    // header, and `<TestaProvider/>` reveals once it has decided.
    if (!config) {
      // TEMPORARY (legacy cutover) — migrate even here, WITHOUT a config. The
      // visitor's own cookies say which experiments they were in, so a returning
      // 3.x visitor assigned to experiment 103 variation 1 keeps variation 1 on
      // every later visit, including the ones a cold instance serves. The client
      // engine decides this pageview and reads the cookie we set on this very
      // response, so the hand-off is seamless.
      //
      // Speculative loads are excluded: a prefetch must never commit state, and
      // this writes a cookie. Non-navigations are excluded for the same reason
      // the guardrail below excludes them — they are not a pageview.
      const coldMigrated =
        !isPrefetchRequest(req) && req.method !== 'HEAD' && isNavigationRequest(req.headers)
          ? maybeMigrateLegacyCookies(options.legacyCookiesEnabled, migrationCtx(options), store)
          : NO_MIGRATION;

      const requestHeaders = new Headers(req.headers);
      requestHeaders.set(SHIELD_HEADER, '1');
      const res = await resolveDownstream(options.handler, req, requestHeaders, event);
      store.applyTo(res.cookies);
      emitDebug?.(res, {
        url: publicUrl.href,
        urlSource,
        bypass: 'no-config',
        shield: true,
        ...migratedNote(coldMigrated),
      });
      return res;
    }

    // Speculative loads — compute the decision but NEVER commit (no cookie,
    // no exposure), while still returning the redirect:
    //   - prefetches: App Router `<Link>` RSC prefetches AND Speculation-Rules
    //     full-document prefetch/prerenders (Sec-Purpose) — redirecting them
    //     warms the variant so the real navigation is flash-free;
    //   - HEAD: curl -I / uptime monitors see the true redirect behavior
    //     without minting visitors or firing exposures.
    // See soft-nav/prefetch-guard.ts + rsc-redirect.ts.
    const speculative = isPrefetchRequest(req)
      ? ('prefetch' as const)
      : req.method === 'HEAD'
        ? ('head' as const)
        : undefined;
    if (speculative) {
      const redirectTo = computePrefetchRedirect(
        {
          config,
          currentUrl: publicUrl.href,
          visitorId: store.get(UUID_COOKIE),
          now: Date.now(),
          getCookie: (name) => store.get(name),
          ...(req.headers.get('user-agent')
            ? { userAgent: req.headers.get('user-agent') as string }
            : {}),
          ...(geoCountry(req) ? { country: geoCountry(req) as string } : {}),
        },
        store, // written into by the engine, then intentionally discarded (no applyTo)
      );
      const res = redirectTo
        ? NextResponse.redirect(new URL(redirectTo, publicUrl), 307)
        : await delegate(options.handler, req, event);
      emitDebug?.(res, {
        url: publicUrl.href,
        urlSource,
        speculative,
        ...(redirectTo ? { redirect: redirectTo } : {}),
      });
      return res;
    }

    // GUARDRAIL — never mint an identity for a request that is not a page view.
    // A soft nav's data/RSC fetch is a real decision point (the visitor IS going
    // there, and a cookie-pinned redirect must still fire), but it must not
    // CREATE a visitor: when the id can't be read back, each such fetch would
    // mint another one and report another visitor for the same human. With no
    // id we decide nothing here and leave the pageview to the client, which can
    // recover the real id from its storage mirror — see react/cookie-store.ts.
    const navigation = isNavigationRequest(req.headers);
    if (!navigation && !store.get(UUID_COOKIE)) {
      const requestHeaders = new Headers(req.headers);
      requestHeaders.set(SHIELD_HEADER, '0');
      const res = await resolveDownstream(options.handler, req, requestHeaders, event);
      emitDebug?.(res, { url: publicUrl.href, urlSource, bypass: 'not-a-pageview' });
      return res;
    }

    const visitorId = resolveVisitorId(options.visitorId, req, store);

    // TEMPORARY (legacy cutover) — carry a returning 3.x visitor's assignment
    // into the packed cookie BEFORE the engine reads it, so `assign()`'s
    // cookie-first path finds it and never re-buckets them. No-op unless the
    // customer opted in, and inert once the legacy experiments leave the config.
    // See experiment-core/legacy-migration.ts.
    const migrated = maybeMigrateLegacyCookies(
      options.legacyCookiesEnabled,
      migrationCtx(options),
      store,
    );

    // Trace every URL rewrite inside the decision (see experiment-core/trace.ts).
    // Bracketing is safe because `runExperiments` is fully synchronous; the
    // `finally` guarantees the buffer is released even if the engine throws.
    let urlTrace: UrlTraceEvent[] = [];
    if (emitDebug) beginUrlTrace();
    let result: ReturnType<typeof runExperiments>;
    try {
      result = runExperiments(
        {
          config,
          currentUrl: publicUrl.href,
          visitorId,
          now: Date.now(),
          getCookie: (name) => store.get(name),
          ...(req.headers.get('user-agent')
            ? { userAgent: req.headers.get('user-agent') as string }
            : {}),
          ...(geoCountry(req) ? { country: geoCountry(req) as string } : {}),
          ...(options.sessionLengthSec !== undefined
            ? { sessionLengthSec: options.sessionLengthSec }
            : {}),
        },
        store,
      );
    } finally {
      if (emitDebug) urlTrace = endUrlTrace();
    }

    // ASSIGNMENT-TIME reporting — both the customer's hook and Testa's own
    // exposure, fired here so they land BEFORE the split-URL 307 below. See
    // `tracking` for why the count has to be taken at this instant.
    const source = navigation ? 'proxy:document' : 'proxy:data';
    for (const applied of result.applied) {
      fireVariationAssigned(options.onVariationAssigned, applied, event, cookieState, req);
      if (trackingEnabled && config.project_id != null) {
        reportExposure(trackingHost, config.project_id, applied, source, req, event);
      }
    }

    if (result.redirectTo) {
      const res = NextResponse.redirect(new URL(result.redirectTo, publicUrl), 307);
      store.applyTo(res.cookies);
      const trace = {
        url: publicUrl.href,
        urlSource,
        visitor: visitorId,
        configHash: config.config_hash,
        applied: summarizeApplied(result.applied),
        redirect: result.redirectTo,
        rawUrl: req.url,
        urlTrace,
        ...refererParamGap(req, publicUrl),
        ...orphanNote(cookieState),
        ...migratedNote(migrated),
      };
      emitDebug?.(res, trace);
      beacon(trace, event);
      logDecision(
        {
          urlIn: req.url,
          urlOut: result.redirectTo,
          uuid: visitorId,
          applied: summarizeApplied(result.applied),
          nav: navigation ? 'document' : 'data',
          ...pick(refererParamGap(req, publicUrl), 'droppedFromReferer', 'dropped'),
        },
        event,
      );
      return res;
    }

    // Tell the app whether to raise the anti-flicker shield for THIS request:
    // only when the visitor has a pending DOM change on this page. Split-URL-only
    // projects and pages with nothing to change get `0`, so `<TestaGuard/>`
    // never overlays needlessly. Passed as a request header the RSC layout reads
    // via `headers()`. Runs on soft-nav RSC requests too, so it stays per-page.
    const shield = hasPendingDomChange(config, publicUrl.href, store.get(ASSIGNMENT_COOKIE));
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(SHIELD_HEADER, shield ? '1' : '0');

    const res = await resolveDownstream(options.handler, req, requestHeaders, event);
    store.applyTo(res.cookies);
    const trace = {
      url: publicUrl.href,
      urlSource,
      visitor: visitorId,
      configHash: config.config_hash,
      applied: summarizeApplied(result.applied),
      shield,
      rawUrl: req.url,
      urlTrace,
      ...refererParamGap(req, publicUrl),
      ...orphanNote(cookieState),
      ...migratedNote(migrated),
    };
    emitDebug?.(res, trace);
    beacon(trace, event);
    logDecision(
      {
        urlIn: req.url,
        urlOut: null,
        uuid: visitorId,
        applied: summarizeApplied(result.applied),
        nav: navigation ? 'document' : 'data',
        ...pick(refererParamGap(req, publicUrl), 'droppedFromReferer', 'dropped'),
      },
      event,
    );
    return res;
  };

  return async function testaMiddleware(
    req: NextRequest,
    event?: NextFetchEvent,
  ): Promise<NextResponse> {
    try {
      return await decide(req, event);
    } catch (error) {
      // Fail open, loudly. Individual steps already fail open on their own (a
      // config fetch, a hook, an exposure); this covers the ones nobody
      // predicted. The request continues to the customer's own middleware and
      // then to the app, with its request headers intact — the visitor gets an
      // unexperimented pageview instead of a 500.
      console.error('[testa] proxy failed, passing the request through:', error);
      try {
        return await delegate(options.handler, req, event);
      } catch {
        return NextResponse.next({ request: { headers: req.headers } });
      }
    }
  };
}

/**
 * What the BROWSER says the visitor was looking at, versus what this request
 * carries — the only server-side view of a URL the app rewrote on its way here.
 *
 * A same-site `Referer` is the previous page as the user agent saw it, not as
 * application code reconstructed it. So when a navigation arrives with fewer
 * query params than the page it came from, the difference is exactly what the
 * navigation dropped. That is otherwise invisible: by the time the request
 * lands, the intended URL exists nowhere except in the app's own state.
 *
 * Reported, never acted on. Params on the previous page are not params on this
 * one, and inheriting them would invent a URL the visitor never had. This
 * exists to name the phenomenon in a log line, so the fix can be argued from
 * evidence rather than inferred from a missing rule match.
 */
function refererParamGap(
  req: NextRequest,
  publicUrl: URL,
): { referer?: string; droppedFromReferer?: string[] } {
  const raw = req.headers.get('referer');
  if (!raw) return {};
  let from: URL;
  try {
    from = new URL(raw);
  } catch {
    return {};
  }
  if (from.host !== publicUrl.host) return { referer: raw };

  const here = new Set<string>();
  publicUrl.searchParams.forEach((_v, k) => here.add(k));
  const dropped: string[] = [];
  from.searchParams.forEach((_v, k) => {
    if (!here.has(k)) dropped.push(k);
  });
  return { referer: raw, ...(dropped.length > 0 ? { droppedFromReferer: dropped } : {}) };
}

/**
 * Flag the one combination worth chasing: no visitor id of ours, but the request
 * carries other cookies — so cookies work for this client and ours went missing.
 * That visitor is about to be re-bucketed from scratch.
 */
function orphanNote(state: VisitorCookieState): { cookieLoss?: number } {
  if (state.hadVisitorId || state.otherCookies === 0) return {};
  return { cookieLoss: state.otherCookies };
}

/**
 * TEMPORARY (legacy cutover) — surface which experiments adopted 3.x state on
 * this request, and nothing at all when none did. Watching this go quiet is how
 * you know the cutover is finished and `legacyCookiesEnabled` can come off.
 */
/** Shared "nothing happened" result, so the cold path needs no null handling. */
const NO_MIGRATION: LegacyMigrationResult = { assignments: [], verdicts: [] };

/**
 * TEMPORARY (legacy cutover) — the same context both call sites pass. They are
 * identical by design: which experiments get migrated comes from the VISITOR's
 * cookies, never from whether this instance happens to hold a config.
 */
function migrationCtx(options: TestaProxyOptions): {
  nowMs: number;
  sessionLengthSec: number;
} {
  return {
    nowMs: Date.now(),
    sessionLengthSec: options.sessionLengthSec ?? SESSION_LENGTH_SEC,
  };
}

function migratedNote(result: LegacyMigrationResult): { legacyMigrated?: number[] } {
  const ids = [...result.assignments, ...result.verdicts];
  return ids.length > 0 ? { legacyMigrated: ids } : {};
}

/** Rename one optional key, dropping it when absent. Keeps the call sites flat. */
function pick<K extends string>(
  source: { droppedFromReferer?: string[] },
  from: 'droppedFromReferer',
  to: K,
): Partial<Record<K, string[]>> {
  return source[from] ? ({ [to]: source[from] } as Record<K, string[]>) : {};
}

/** Compact per-assignment summary for the debug trace. */
function summarizeApplied(
  applied: ReadonlyArray<VariationAppliedEvent>,
): ReadonlyArray<{ experiment: number; variation: number; first: boolean }> {
  return applied.map((a) => ({
    experiment: a.experimentId,
    variation: a.variationId,
    first: a.firstAssignment,
  }));
}

/**
 * Bypass / no-config / prefetch paths: testa adds nothing of its own, but must
 * stay TRANSPARENT to upstream request mutation — a customer proxy that runs
 * first and tail-calls testa with a mutated `NextRequest` (extra request
 * headers) expects those headers to reach the app on every path. A bare
 * `NextResponse.next()` would forward the ORIGINAL headers instead, silently
 * dropping the mutations, so we always emit `req.headers` as the override set.
 */
async function delegate(
  handler: TestaHandler | undefined,
  req: NextRequest,
  event: NextFetchEvent | undefined,
): Promise<NextResponse> {
  const forward = (): NextResponse => NextResponse.next({ request: { headers: req.headers } });
  if (!handler) return forward();
  const out = await handler(req, event);
  const res = toNextResponse(out, forward);
  // A plain `next()` from the handler still forwards the (possibly mutated)
  // request headers; a handler that set its own overrides keeps them as-is.
  return isRedirect(res) ? res : applyRequestHeaders(res, {}, req);
}

/**
 * Pass-through path: run the composed handler with `x-testa-shield` already in
 * the request headers, then make sure the shield override survives whatever
 * response shape the handler returned (its own overrides, a plain `next()`, a
 * rewrite). Handler redirects are returned as-is — nothing downstream renders.
 */
async function resolveDownstream(
  handler: TestaHandler | undefined,
  req: NextRequest,
  requestHeaders: Headers,
  event: NextFetchEvent | undefined,
): Promise<NextResponse> {
  if (!handler) return NextResponse.next({ request: { headers: requestHeaders } });
  const downstreamReq = new NextRequest(req, { headers: requestHeaders });
  const out = await handler(downstreamReq, event);
  const res = toNextResponse(out, () =>
    NextResponse.next({ request: { headers: requestHeaders } }),
  );
  if (isRedirect(res)) return res;
  return applyRequestHeaders(
    res,
    { [SHIELD_HEADER]: requestHeaders.get(SHIELD_HEADER) ?? '0' },
    downstreamReq,
  );
}

/** Context passed to `onVariationAssigned` — keep an async task alive past the response. */
export interface VariationHookContext {
  /** Run `promise` to completion after the response is sent (never delays it). */
  waitUntil: (promise: Promise<unknown>) => void;
  /** What the request said about this visitor's cookies. See {@link VisitorCookieState}. */
  cookies: VisitorCookieState;
  /**
   * The incoming request — read it to key your event to the SAME person your
   * browser-side analytics knows.
   *
   * `event.visitorId` is Testa's id, and no other tool shares it. A PostHog or
   * GA event sent from here under that id is a DIFFERENT user from the one
   * posthog-js/gtag reports in the browser, so the assignment never joins to
   * the behaviour it is supposed to explain. Their own id is on this request:
   * `ctx.request.cookies.get('ph_<project_api_key>_posthog')` holds a JSON blob
   * with `distinct_id`, `_ga` holds the GA client id. Send under that instead.
   *
   * Also the place to read the visitor's UA, IP, and geo headers — a fetch made
   * from here otherwise reports the runtime's, not the visitor's.
   */
  request: NextRequest;
}

/**
 * The cookie situation as the request arrived — read BEFORE anything is minted.
 *
 * This exists to make cookie loss measurable on live traffic. A visitor whose
 * `_testa_uuid` goes missing is re-bucketed from scratch, so they can appear
 * twice with different ids and even land in the other group; it is intermittent
 * per visitor (a CDN serving a cached response without our `Set-Cookie`, a
 * consent tool removing it, a composed middleware returning a response that
 * dropped it), so it cannot be reproduced by hand — it has to be counted.
 *
 * `otherCookies` is what makes that possible: it separates "cookies do not work
 * for this client at all" (a script, a crawler — expect 0) from "cookies work
 * fine and OURS is the one missing" (a real browser mid-session carrying a cart,
 * a session, a consent record). The second is the population to worry about.
 */
export interface VisitorCookieState {
  /** Did the request carry `_testa_uuid`? False means this pageview mints one. */
  hadVisitorId: boolean;
  /**
   * Did it carry the server-owned `HttpOnly` copy (`_testa_uuid_s`)? The
   * readable cookie can be cleared by a script while this one survives, so a
   * visitor with only the backup is still a visitor we can name.
   */
  hadBackupId: boolean;
  /** Did it carry `_testa_exp`? */
  hadAssignment: boolean;
  /** How many OTHER cookies came with it. */
  otherCookies: number;
  /** Did it come from this same site (`Referer` on the same host)? */
  sameSiteReferer: boolean;
}

/** Read the cookie situation off the request, before the engine touches it. */
function readCookieState(req: NextRequest, publicUrl: URL): VisitorCookieState {
  let otherCookies = 0;
  let hadVisitorId = false;
  let hadBackupId = false;
  let hadAssignment = false;
  for (const cookie of req.cookies.getAll()) {
    if (cookie.name === UUID_COOKIE) hadVisitorId = true;
    else if (cookie.name === UUID_BACKUP_COOKIE) hadBackupId = true;
    else if (cookie.name === ASSIGNMENT_COOKIE) hadAssignment = true;
    else otherCookies++;
  }
  let sameSiteReferer = false;
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      sameSiteReferer = new URL(referer).host === publicUrl.host;
    } catch {
      sameSiteReferer = false;
    }
  }
  return { hadVisitorId, hadBackupId, hadAssignment, otherCookies, sameSiteReferer };
}

/** Invoke the hook without ever letting it break the request; keep async work alive. */
function fireVariationAssigned(
  listener: TestaProxyOptions['onVariationAssigned'],
  event: VariationAppliedEvent,
  fetchEvent: NextFetchEvent | undefined,
  cookies: VisitorCookieState,
  request: NextRequest,
): void {
  if (!listener) return;
  const waitUntil = (promise: Promise<unknown>): void => {
    if (fetchEvent?.waitUntil) fetchEvent.waitUntil(promise.catch(() => undefined));
    else void promise.catch(() => undefined);
  };
  try {
    const r = listener(event, { waitUntil, cookies, request });
    // If the hook itself returned a promise, keep the worker alive for it too.
    if (r && typeof (r as Promise<void>).then === 'function') waitUntil(r as Promise<void>);
  } catch {
    // never break the request on a hook error
  }
}

/**
 * POST the exposure to Testa for one assignment, keeping it alive past the
 * response with `waitUntil`.
 *
 * Called at assignment time — for a split-URL variant that is BEFORE the 307,
 * the only moment both arms are counted at the same depth in the funnel. The
 * request is server-to-server, so the browser navigating away cannot cancel it;
 * `waitUntil` is what stops the runtime tearing the invocation down first.
 *
 * The visitor's UA and IP ride along because this fetch is made BY THE SERVER:
 * without them every server-side exposure is attributed to the runtime's own
 * user agent and the deployment's egress IP, and device/geo reporting is wrong
 * for the entire server-decided population.
 */
function reportExposure(
  trackingHost: string,
  projectId: number,
  applied: VariationAppliedEvent,
  source: string,
  req: NextRequest,
  fetchEvent: NextFetchEvent | undefined,
): void {
  if (!applied.visitorId) return;
  const pending = emitExposure(
    trackingHost,
    {
      project_id: projectId,
      experiment: applied.experimentId,
      variation: applied.variationId,
      uuid: applied.visitorId,
      ...(applied.title ? { title: applied.title } : {}),
      url: applied.url,
      source,
    },
    { userAgent: req.headers.get('user-agent'), clientIp: clientIp(req) },
  );
  if (fetchEvent?.waitUntil) fetchEvent.waitUntil(pending);
}

/**
 * The visitor id for this request.
 *
 * A caller-supplied id (`setVisitorId(req, …)` first, then the `visitorId`
 * option) is a SEED for a visitor who has none yet — `ensureVisitorId` still
 * prefers an id already on the request, so a returning visitor is never
 * re-keyed and never re-bucketed.
 *
 * A resolver that throws or returns nothing falls back to minting rather than
 * failing the request — an identity source of the customer's own is exactly the
 * kind of thing that can be briefly unavailable, and an unexperimented pageview
 * is a far better outcome than a 500.
 */
function resolveVisitorId(
  option: TestaProxyOptions['visitorId'],
  req: NextRequest,
  store: NextCookieStore,
): string {
  // `setVisitorId(req, …)` first: it is the only source that can carry an id
  // the caller had to await, so it is the most deliberate one available.
  let seed: string | null | undefined = getSuppliedVisitorId(req);
  if (!seed) {
    try {
      seed = typeof option === 'function' ? option(req) : option;
    } catch {
      seed = undefined;
    }
  }
  // A SEED, not an override — a visitor who already has an id keeps it.
  return ensureVisitorId(store, seed || undefined);
}

/** The visitor's IP as the edge saw it — first hop of `x-forwarded-for`. */
function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return (forwarded.split(',')[0] ?? '').trim() || null;
  return req.headers.get('x-real-ip');
}

/** Best-effort ISO country from common edge geo headers (Vercel / Cloudflare). */
function geoCountry(req: NextRequest): string | undefined {
  return (req.headers.get('x-vercel-ip-country') ?? req.headers.get('cf-ipcountry') ?? undefined) as
    | string
    | undefined;
}

/**
 * Turn `{ projectId, host? }` into a concrete ConfigSource. An explicit
 * `config` / `loadConfig` / `configUrl` always wins; otherwise the config URL is
 * built from the resolved host + projectId, so the caller only needs projectId.
 */
function resolveConfigSource(options: TestaProxyOptions, projectId: string): ConfigSource {
  // `decisions: 'server'` is the only mode that lets a request wait on a fetch.
  const blockOnCold = options.decisions === 'server';
  if (options.config || options.loadConfig || options.configUrl) return { ...options, blockOnCold };
  const host = (options.host ?? readEnv('TESTA_CONFIG_HOST') ?? DEFAULT_CONFIG_HOST).replace(
    /\/+$/,
    '',
  );
  return { ...options, blockOnCold, configUrl: `${host}/api/v1/config/${projectId}` };
}
