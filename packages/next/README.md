# @testa-soft/next

Next.js integration for [Testa](https://testa-soft.tech) A/B testing. It gives you two complementary experiment types from one package: **server-side, flicker-free split-URL redirects** driven by a single middleware, and **client-side HTML/DOM experiments** applied by React components with a built-in anti-flicker shield. Both read the same sticky `_testa_exp` cookie, so a visitor is bucketed once — server-side — and stays in the same variation across page loads, soft navigations, and experiment types.

## Install

```bash
npm install @testa-soft/next
```

Peer dependencies (you almost certainly already have these):

- `next` — `>=13.4.0`
- `react` — `>=18` (optional; only required if you render the React components from `@testa-soft/next/server` or `@testa-soft/next/router-guard` — the middleware entry `@testa-soft/next` is react-free)

### Which entry do I import from?

| You want | Import from |
| --- | --- |
| The middleware / proxy (`createTestaProxy`), event bus, `pushEvent` | `@testa-soft/next` |
| `<TestaGuard/>` + `<TestaProvider projectId=.../>` for the root layout | `@testa-soft/next/server` — **the only components you should mount** |
| `<TestaRouterGuard/>` (optional soft-nav safety net) | `@testa-soft/next/router-guard` |

There is exactly **one** `<TestaProvider>` to use in a Next.js app: the one from
`@testa-soft/next/server`. (Not using Next.js? Plain React SPAs use
`@testa-soft/react` instead.) You may see a `./_internal/experiments` path in
the exports map — that is the private client half of the `/server` components,
required by the build for the `"use client"` boundary. Never import it; it has
no semver guarantees.

## Quick start — split-URL redirects

Split-URL tests send a bucketed visitor to a different URL. It's decided server-side and issued as a `307` **before any HTML is sent**, so there is no flicker and no client JS required.

Create `proxy.ts` at your project root (or under `src/`):

```ts
// proxy.ts
import { createTestaProxy } from '@testa-soft/next'

export const proxy = createTestaProxy({ projectId: '3fa85f64e1c2b' })
```

> **Next.js version.** Next 16 renamed the middleware file convention to
> `proxy` — use `proxy.ts` with `export const proxy = …` (above). On **Next
> 13–15**, name the file `middleware.ts` and the export `middleware` instead;
> everything else is identical. `createTestaProxy` is unchanged either way.

That is the whole integration. `projectId` is your **crobot project UUID**. With
just `projectId`, the package fetches your project config from the built-in
config host (`https://config.testa-soft.tech/api/v1/config/{projectId}`).

The proxy is safe on **every** request out of the box: it internally passes
through `/_next/*`, `/api/*`, `/.well-known/*`, static-asset files (images,
fonts, scripts, `robots.txt`, …), **all non-GET/HEAD requests** (Server
Actions and form submits POST to the page URL — redirecting them would break
the action), and **crawlers/scripts/monitors** (Googlebot, curl,
HeadlessChrome, UptimeRobot, … — see `skipBots`) without touching cookies,
fetching config, or emitting exposures — no `matcher` needed for correctness.
Prefetches (App Router `<Link>`, Chrome Speculation Rules) and HEAD requests
get the real redirect but never commit: no cookie is written and no exposure
fires for a page the visitor may never actually see.

### Optional: skip invocations with a `matcher`

A `matcher` saves the middleware **invocation itself** on asset requests (edge
invocations cost money and add latency on some hosts). It's purely a cost
optimization — if the regex is wrong or missing, nothing misbehaves:

```ts
// proxy.ts — optional, saves edge invocations on assets
export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'],
}
```

> Next.js requires `matcher` to be a static literal in **your** file (it's
> parsed at build time), so the package can't provide it for you. Keep it
> conservative: a path the matcher skips is a path Testa can never test on.
> To exclude extra routes from experiments, prefer the `skipPaths` option —
> it lives in one place and takes regexes.

### Inline-config mode

If you'd rather ship the config yourself (local dev, a demo, or a deploy that
resolves config from its own source), pass a `config` object instead of relying
on the config host:

```ts
// proxy.ts  (Next 13–15: middleware.ts, export `middleware`)
import { createTestaProxy } from '@testa-soft/next'
import projectConfig from './testa.config.json'

export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  config: projectConfig, // a ProjectConfig — zero-latency, no network fetch
})
```

You can also point at a custom config host with `host: 'https://config.staging.example.com'`,
supply a `configUrl` to fetch from, or provide an async `loadConfig(projectId)`
resolver (e.g. read Vercel Edge Config). Config caching (`cache` option), shared per server instance:

- `true` (default) — fresh for 60s, then served stale while revalidating in the
  background (never older than 5 min): zero request latency, publishes live in
  ~1 min. `cacheTtlMs` tunes the fresh window.
- `'per-pageload'` — DOCUMENT requests always fetch fresh (a publish is live on
  the very next hard pageview); RSC soft navigations reuse the pinned copy, so
  the config never shifts mid-SPA-session.
There's deliberately no "off" mode — it would add a blocking config fetch to
every matched request (soft navs and prefetches included) with no last-known
fallback; use `'per-pageload'` when testing config changes. If no config can be
resolved, the middleware fails open and passes the request through untouched.

## Composing with your own middleware

Next.js runs **one** middleware and allows **one** response — and request-header
overrides (`NextResponse.next({ request: { headers } })`) travel on that
response as a wholesale set. Two separately-built responses can never be merged
by hand, so if you already have middleware logic (auth, locale, custom headers),
compose it with the proxy in one of two ways.

### Your logic inside the proxy — the `handler` option (recommended)

```ts
export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  handler: (req, event) => {
    // Your middleware logic. `req.headers` already carries x-testa-shield —
    // clone them when overriding request headers, as you normally would:
    const headers = new Headers(req.headers)
    headers.set('x-domain', 'acme.com')
    return NextResponse.next({ request: { headers } })
  },
})
```

Semantics:

- Requests testa bypasses (`/api/*`, assets, `skipPaths`) go **straight to your
  handler**, so your headers still reach API routes.
- A split-URL redirect short-circuits — your handler is not called (nothing
  downstream renders). A redirect **you** return wins on pass-through requests
  and gets testa's cookies.
- On pass-through, testa merges its cookies onto your response and re-patches
  the `x-testa-shield` override even if you return a plain `NextResponse.next()`
  or `undefined`.

### Your logic first, then testa (tail call)

To run your logic **before** testa — short-circuit on auth/maintenance without
testa assigning or tracking anything, or compute request headers testa should
carry — mutate the request and tail-call the proxy. Testa is transparent to
upstream request mutation: headers on the request you hand it are forwarded
downstream on **every** path (pass-through, bypassed `/api/*`/assets, redirects,
fail-open):

```ts
const testa = createTestaProxy({ projectId: '3fa85f64e1c2b' })

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  // Short-circuit BEFORE testa: no exposure fired, no cookies written.
  if (!isAllowed(req)) return NextResponse.redirect(new URL('/login', req.url))

  const headers = new Headers(req.headers)
  headers.set('x-domain', 'acme.com')
  headers.set('x-search', req.nextUrl.search)
  return testa(new NextRequest(req, { headers }), event) // forward `event`!
}
```

### Testa first, then post-process (outer wrapper)

To act on testa's response — add response headers, or request-header overrides
computed after the fact — call the proxy and post-process. Response headers and
cookies merge fine with standard APIs; for **request**-header overrides use the
exported `applyRequestHeaders` (it appends to the proxy's override set instead
of clobbering it):

```ts
import { applyRequestHeaders, createTestaProxy } from '@testa-soft/next'

const testa = createTestaProxy({ projectId: '3fa85f64e1c2b' })

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  if (isMaintenanceMode()) return NextResponse.rewrite(new URL('/down', req.url))

  const res = await testa(req, event) // forward `event` — tracking uses waitUntil
  res.headers.set('x-frame-options', 'DENY') // response headers merge trivially
  return applyRequestHeaders(res, { 'x-domain': 'acme.com' }, req)
}
```

`applyRequestHeaders(res, headers, req)` is a no-op on redirects, appends when
the response already carries an override set, and seeds the full set from
`req.headers` otherwise (pass `req` — override semantics are wholesale, and
seeding only your headers would drop every other request header downstream).

## HTML/DOM experiments

For "same URL, different content" tests, Testa applies **crobot-native DOM
changes** on the client. The split is:

- **Middleware assigns** the visitor server-side and writes the sticky
  `_testa_exp` cookie (add the middleware from the quick start above — DOM
  experiments reuse the exact same assignment).
- **`<TestaProvider/>` renders** that assignment on the client, cookie-first:
  it reads `_testa_exp`, looks up the variation's changes in the config, and
  applies them to the DOM. No re-bucketing happens on the client.

Because DOM changes mutate content the server already rendered (the control),
there's an unavoidable control→variant flash unless the page is hidden until the
variant is applied. `<TestaGuard/>` handles that: it's a synchronous inline
`<head>` script that hides the content **before first paint** (with a hard
timeout fallback so a slow or broken apply can never leave the page blank), and
`<TestaProvider/>` reveals it once the variant is on the page.

Add both in your root layout — the shield as high in `<head>` as possible, and
the experiments component anywhere in the body. Use the **server entry**: the
config is fetched server-side on the first request and cached in the Next data
cache (background-revalidated) — no app-side fetch code:

```tsx
// app/layout.tsx
import { TestaGuard, TestaProvider } from '@testa-soft/next/server'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Self-gating: renders the shield ONLY when the middleware flagged a
            pending DOM change for this request (x-testa-shield header). */}
        <TestaGuard selector="body" timeoutMs={4000} />
      </head>
      <body>
        {children}
        {/* Fetches the config server-side (same id as the proxy), then applies
            the assigned variation's DOM changes client-side. Re-applies on
            App-Router soft navigation. Fails open if config is unreachable. */}
        <TestaProvider projectId="3fa85f64e1c2b" />
      </body>
    </html>
  )
}
```

Managing the config yourself (local fixture, demo, self-managed JSON)? Pass it
inline — the same `/server` components accept a `config` prop, which skips
their fetch entirely: `<TestaProvider config={projectConfig} />`.

Supported change types are crobot-native and applied by the shared DOM engine:

| Change type            | Effect                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| `change_html`          | Set matched elements' `innerHTML` to `content`.                    |
| `css`                  | Inject a `<style>` with `content` (optionally `global`).           |
| `hide_element`         | `display:none` on matched elements.                               |
| `append_html`          | `insertAdjacentHTML('beforeend', content)` on matched elements.    |
| `prepend_html`         | `insertAdjacentHTML('afterbegin', content)` on matched elements.   |
| `move_element_append`  | Move matched elements under the target selector (append).          |
| `move_element_prepend` | Move matched elements under the target selector (prepend).         |

> Split-URL-only deployments don't need `<TestaGuard/>` — the middleware's
> `307` is already flicker-free. The shield only matters when you apply DOM
> changes on top of server-rendered content.

## Preview mode

Editors can preview **unpublished** variation drafts live, without them going to
real visitors. Pass `previewApiUrl` (your crobot backend base URL) to
`<TestaProvider/>`:

```tsx
<TestaProvider config={projectConfig} previewApiUrl="https://new.testa-soft.tech" />
```

Then open any page with the preview query params:

```
https://yoursite.com/pricing?testa_preview=true&testa_preview_token=<token>
```

In preview mode `<TestaProvider/>` **skips normal cookie assignment** and
instead fetches the draft changes for that session from
`{previewApiUrl}/api/preview/{token}` and applies them. The fetched changes are
the same crobot-native `VariationChange` shapes as real variations, so a draft
renders identically to how it will ship. A failed or malformed response applies
nothing and reveals the shield (fail-safe).

## Pages Router

The whole client half is one component — `<TestaProvider/>` from
`@testa-soft/next/pages`, once in `_app.tsx`:

```tsx
// pages/_app.tsx
import { TestaProvider } from '@testa-soft/next/pages'

export default function App({ Component, pageProps }) {
  return (
    <TestaProvider projectId="3fa85f64e1c2b">
      <Component {...pageProps} />
    </TestaProvider>
  )
}
```

It self-wires the client engine, the soft-nav router guard below, and
**anti-flicker on by default** — a JS-free `<style>` server-rendered into
`<head>` through `next/head`, unrendered the moment the variant is applied. That
has to come from the server here: the Pages Router paints its server-rendered
control HTML before React hydrates, so a shield raised from an effect arrives
too late and produces *two* flashes (content → blank → variant) instead of
none. `shield={false}` opts out; an object passes `selector` / `timeoutMs` /
`mode` through. The reveal has a CSS-only fallback at `timeoutMs`, so a broken
bundle can't leave a site hidden.

Optionally add `<TestaGuard/>` to `pages/_document.tsx`. It doesn't change the
shield — it starts the config fetch during HTML parse rather than after
hydration, shortening the window the page spends hidden.

### Soft navigation

Client-side navigations in the **Pages Router** (static `next/link` navs) never
hit the server, so the middleware can't see them. `<TestaRouterGuard/>` closes
that gap; the `/pages` provider above already wires it up, so reach for it
directly only if you want the pieces individually:

```tsx
// pages/_app.tsx
import { TestaRouterGuard } from '@testa-soft/next/router-guard'
import projectConfig from '../testa.config.json'

export default function App({ Component, pageProps }) {
  return (
    <>
      <TestaRouterGuard config={projectConfig} />
      <Component {...pageProps} />
    </>
  )
}
```

It is cookie-first, just like the middleware: it reads the sticky `_testa_exp`
assignment (no re-roll, no config re-fetch) and, on a navigation to a control
URL for a split-URL experiment the visitor is bucketed to a variant of, aborts
the in-flight navigation and `router.replace()`s to the variant before the
control page renders. A visitor gets the same variant whether the middleware or
the guard fires — both read the one cookie.

> App Router users don't need this — `<TestaProvider/>` re-applies DOM
> experiments on soft navigation, and the middleware handles split-URL
> redirects (including a prefetch-safe path for `<Link>` prefetches).

## Behind a proxy / ingress (k8s, istio, CDN)

On Vercel the middleware sees the real public URL. On self-hosted stacks the
ingress/mesh layer (k8s ingress, istio sidecars, a CDN in front) often rewrites
`Host` before the request reaches Next.js, so the middleware sees an internal
URL like `http://10.0.3.17:3000/pricing`. Split-URL rules target **public**
URLs, so experiments would silently never match.

The proxy recovers the public URL through this chain (first valid value wins;
host and scheme resolve independently, and malformed values fall through):

1. **`publicHost` option / `TESTA_PUBLIC_HOST` env** — explicit, always wins.
2. **`x-testa-host`** (+ optional **`x-testa-proto`**) request headers — set
   them at the ingress when it mangles `Host` and you can't change app code.
3. **`Forwarded`** (RFC 7239, `host=`/`proto=` of the first element).
4. **`X-Forwarded-Host`** / **`X-Forwarded-Proto`** (first value of each list).
5. The `Host` header, then the request URL as-is.

**Ports** come from the winning host only. `X-Forwarded-Port` is ignored —
meshes set it to the port they forward *to* (istio sends the app's `:3000`), and
`https://www.acme.com:3000/pricing` matches nothing a dashboard can author. State
a real non-default public port via `publicHost: 'acme.com:8443'`. Matching is
forgiving the same way: a rule authored without a port matches any port; one that
names a port stays strict (`localhost:3200` never matches `localhost:5002`).

Most reverse proxies (nginx ingress, traefik, Cloudflare) already send
`X-Forwarded-Host`/`-Proto`, so usually **it just works with no config**. If
yours doesn't (or istio overwrites them), pin it explicitly:

```ts
export const middleware = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  publicHost: 'https://www.acme.com', // or bare host: 'www.acme.com'
});
```

or per-request (multi-tenant):

```ts
publicHost: (req) => req.headers.get('x-tenant-host'),
```

or with zero code changes, via env (`TESTA_PUBLIC_HOST=https://www.acme.com`)
or by injecting the header at the ingress (istio `VirtualService` example):

```yaml
http:
  - headers:
      request:
        set:
          x-testa-host: www.acme.com
          x-testa-proto: https
```

The resolved public URL drives experiment URL matching, `discoverRootDomain`
cookie discovery, redirect `Location`s, and exposure-tracking URLs.

> Security note: forwarded headers are request headers. An ingress that doesn't
> own `x-testa-host` / `X-Forwarded-Host` should strip client-sent values, as
> proxies conventionally do for forwarded headers.

## Debugging (`debug: true`)

When an experiment doesn't fire and you can't tell why, turn on tracing:

```ts
export const middleware = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  debug: true, // or set TESTA_DEBUG=1 — no code change
});
```

Every request then emits ONE compact JSON decision trace, in two places:

- a **`[testa] {…}` console line** — Vercel function logs, `next start`
  stdout, your pod's logs;
- an **`x-testa-debug` response header** — open the browser network tab (or
  `curl -sI https://acme.com/pricing`) and read the decision right off the
  response, no log access needed.

What it answers:

```jsonc
// why did nothing happen? → the proxy never saw it as a page
{"url":"https://acme.com/pricing","bypass":"method","method":"POST"}
{"url":"https://acme.com/logo.png","bypass":"path"}
{"url":"https://acme.com/pricing","bypass":"bot"}   // crawler/script UA — curl included!
{"url":"https://acme.com/pricing","urlSource":"host","bypass":"no-config"}

// what URL did targeting actually run against, and which mechanism produced it?
{"url":"https://acme.com/pricing","urlSource":"x-forwarded-host",
 "visitor":"9f2…","configHash":"hash-1",
 "applied":[{"experiment":101,"variation":2,"first":true}],
 "redirect":"https://acme.com/pricing-v2"}

// pass-through: assignment + whether the anti-flicker shield was raised
{"url":"https://acme.com/pricing","urlSource":"request-url",
 "applied":[{"experiment":101,"variation":1,"first":false}],"shield":false}
```

`urlSource` is the winning mechanism from
[public-URL resolution](#behind-a-proxy--ingress-k8s-istio-cdn): `option`,
`x-testa-host`, `forwarded`, `x-forwarded-host`, `host`, or `request-url`.

> Don't leave `debug` on in production: the header exposes experiment
> internals (experiment/variation ids, visitor id) to anyone who can see the
> response.

## API reference

### `createTestaProxy(options)`

Returns a Next.js middleware function. Import from `@testa-soft/next`.

| Option               | Type                                          | Default                              | Description                                                                                                    |
| -------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `projectId`          | `string`                                      | —                                    | **Required.** Your project id. Config is fetched from `{host}/api/v1/config/{projectId}`.                     |
| `projectSlug`        | `string`                                      | —                                    | _Deprecated_ alias for `projectId`.                                                                          |
| `config`             | `ProjectConfig`                               | —                                    | Static config object. Zero-latency, no network fetch. Wins over `configUrl` / `loadConfig`.                   |
| `configUrl`          | `string`                                      | —                                    | URL to fetch a `ProjectConfig` JSON from. Cached by TTL.                                                      |
| `loadConfig`         | `(projectId) => Promise<ProjectConfig \| null>` | —                                  | Custom async config resolver (e.g. Edge Config). Cached by TTL.                                               |
| `cacheTtlMs`         | `number`                                       | `30000`                              | Cache lifetime for `configUrl` / `loadConfig` results.                                                       |
| `host`               | `string`                                       | `https://config.testa-soft.tech`     | Config host. Also settable via the `TESTA_CONFIG_HOST` env var. Override for local/staging.                   |
| `secureCookies`      | `boolean`                                      | `true`                               | Emit `Secure` cookies. Set `false` for local http dev.                                                       |
| `cookieDomain`       | `string`                                       | —                                    | Explicit cookie `Domain` for cross-subdomain tracking (e.g. `.example.com`). Wins over `discoverRootDomain`.     |
| `discoverRootDomain` | `boolean`                                      | `false`                              | Auto-derive the registrable domain from the request host for cookies.                                        |
| `publicHost`         | `string \| (req) => string \| null`           | —                                    | The site's **public** host (`'www.acme.com'` or `'https://www.acme.com'`) when your ingress rewrites `Host` — see [Behind a proxy / ingress](#behind-a-proxy--ingress-k8s-istio-cdn). Also settable via the `TESTA_PUBLIC_HOST` env var. |
| `debug`              | `boolean`                                      | `false`                              | Per-request decision trace: a `[testa] {…}` console line + an `x-testa-debug` response header — see [Debugging](#debugging-debug-true). Also settable via the `TESTA_DEBUG=1` env var. |
| `skipBots`           | `boolean`                                      | `true`                               | Skip experiments for crawlers/scripts/monitors (UA-based): clean pass-through, no cookies, no redirect, no exposures. Note `curl` counts as a bot — send a browser UA (`curl -A 'Mozilla/5.0 …'`) to see experiment behavior. |
| `tracking`           | `boolean`                                      | `true`                               | Emit exposures (impressions) so experiment results populate. Set `false` for redirects-only, or if a pixel owns tracking. |
| `trackingHost`       | `string`                                       | `https://new.testa-soft.tech`        | Host for exposure tracking (`{trackingHost}/api/leads`). Also settable via the `TESTA_TRACKING_HOST` env var. |
| `skipPaths`          | `(string \| RegExp)[]`                         | —                                    | Extra paths to pass through untouched, on top of the built-in filter (`/_next/*`, `/api/*`, `/.well-known/*`, asset extensions). Strings match as segment-aligned prefixes (`'/admin'` matches `/admin/users`, not `/administrator`); RegExps test the pathname. |
| `handler`            | `(req, event) => Response \| null \| undefined \| Promise<…>` | —                     | Your own middleware logic, composed inside the proxy — see [Composing with your own middleware](#composing-with-your-own-middleware). |
| `visitorId`          | `string \| ((req) => string \| null)`         | —                                    | Use YOUR visitor id instead of Testa's `_testa_uuid`, so an assignment reported from the edge lands on the person your analytics already knows. A **seed** — a visitor who already has an id keeps it, so nobody is re-bucketed. For an id you must `await`, use `setVisitorId(req, id)` instead. Must be stable per visitor. |
| `onVariationAssigned`| `(event, ctx) => void \| Promise<void>`       | —                                    | **Server-side** hook per assignment, fired BEFORE any split-URL `307`. `ctx.waitUntil(promise)` keeps async work (a warehouse write, a webhook) alive past the response — never delays it. `ctx.request` is the `NextRequest`, so you can key the event to your own analytics' visitor id. Guard on `event.firstAssignment` for once-per-visitor. |
| `tracking`           | `boolean`                                     | `true`                               | Report the exposure to Testa at assignment. This is the only point that counts BOTH arms at the same depth in the funnel — counting from the browser puts the variant a `307` and a page load behind the control and undercounts it (SRM). Set `false` to leave counting to `<TestaProvider/>`. |
| `trackingHost`       | `string`                                      | `TESTA_TRACKING_HOST` \| SDK default  | Base URL for `/api/leads` and the `/log` beacon. |

Exported constants: `DEFAULT_CONFIG_HOST`, `DEFAULT_TRACKING_HOST`, `PUBLIC_HOST_HEADER`, `PUBLIC_PROTO_HEADER`. Exported
type: `VariationAppliedEvent` (the argument to `onVariationAssigned`).

## Analytics events

Two independent surfaces — use either or both:

**Client-side** — the SDK fires **`variation_applied`** in the browser once per
session when a visitor is shown a variation (after the redirect for split-URL, on
the page for DOM). Subscribe with named functions — multiple handlers allowed,
each returning its own unsubscribe:

```tsx
// app/components/TestaAnalytics.tsx
'use client'

import { onVariationApplied } from '@testa-soft/next'
import { useEffect } from 'react'

export function TestaAnalytics(): null {
  // onVariationApplied returns its own unsubscribe, so returning it from the
  // effect is the whole cleanup — without it, Fast Refresh and StrictMode's
  // double mount stack duplicate handlers.
  // `track` is whatever you already use — an analytics SDK, or your own fetch.
  useEffect(() => onVariationApplied((d) => track('Experiment Viewed', d)), [])
  return null
}
// d = { project_id, experiment, variation, uuid, title, url }
```

Render it once under your root layout. Module-scope `testa.onVariationApplied(...)`
also works, but only outside a React tree — a server component has no `window`,
and nothing ever unsubscribes.

A handler registered **after** the event fired still receives it (history
replay), so late-loading analytics don't miss it. `window.testa.onVariationApplied`
is also installed for GTM Custom HTML / non-bundled scripts.

**GTM `dataLayer`** — pushed automatically (no config) on every `variation_applied`:

```js
{ event: 'Analytica', ExperimentId, ExperimentName, VariationId, VariationName }
```
Add a GTM **Custom Event** trigger on `Analytica`.

**Server-side** — for a warehouse, a server-side collector, or webhooks, use the
`onVariationAssigned` proxy option (above) with `ctx.waitUntil`. It's independent
of the client surface — wire up both if you want.

> `variation_assigned` = when the visitor is bucketed (server); `variation_applied`
> = when they're shown it (client, once per session). Both carry the same payload.

### `<TestaProvider>` — from `@testa-soft/next/server` (recommended)

Async server component: fetches the config server-side (Next data cache) and
renders the client applier. Fails open (renders nothing) on any config failure.

| Prop            | Type            | Default                          | Description                                                           |
| --------------- | --------------- | -------------------------------- | --------------------------------------------------------------------- |
| `projectId`     | `string`        | —                                | **Required** (unless `config` given). Same id as `createTestaProxy`.  |
| `config`        | `ProjectConfig` | —                                | Inline config — skips the fetch.                                       |
| `host`          | `string`        | `https://config.testa-soft.tech` | Config host. Also via `TESTA_CONFIG_HOST`.                             |
| `revalidateSec` | `number`        | `30`                             | Next data-cache revalidation window.                                   |
| `previewApiUrl` | `string`        | —                                | Backend base URL; enables `?testa_preview`.                            |
| `trackingHost`  | `string`        | `https://new.testa-soft.tech`    | Backend base URL for goal conversions.                                 |

### `<TestaGuard>` — from `@testa-soft/next/server`

Async server component rendering the anti-flicker shield. **Self-gating**:
renders only when the middleware set `x-testa-shield: 1` for this request.
Outside a request scope (static generation) it renders nothing.

| Prop        | Type                        | Default     | Description                                                                                   |
| ----------- | --------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `selector`  | `string`                    | `'body'`    | CSS selector to hide until reveal.                                                            |
| `timeoutMs` | `number`                    | `4000`      | Hard fallback (ms) after which the shield auto-reveals no matter what.                        |
| `mode`      | `'opacity' \| 'visibility'` | `'opacity'` | How to hide. `opacity` keeps layout (no reflow on reveal).                                    |
| `styleId`   | `string`                    | —           | `<style>` element id — makes raising idempotent and reveal targeted.                          |

`loadTestaConfig({ projectId, host?, revalidateSec? })` is also exported from
`/server` for custom server code — resolves `null` on any failure (fail open).

### `<TestaRouterGuard>` — from `@testa-soft/next/router-guard`

| Prop     | Type            | Default | Description                                                                          |
| -------- | --------------- | ------- | ----------------------------------------------------------------------------------- |
| `config` | `ProjectConfig` | —       | **Required.** The same config the middleware uses.                                  |

## How it works

- **Server-side assignment, cookie-first.** The middleware buckets each visitor
  deterministically and writes the sticky `_testa_exp` cookie (plus a `_testa`
  visitor id). Every surface — middleware, `<TestaProvider/>`,
  `<TestaRouterGuard/>` — reads that one cookie, so a visitor sees the same
  variation everywhere with no re-rolling.
- **Split-URL is a `307` before HTML.** For split-URL experiments the middleware
  redirects at the edge before any markup is sent, so there is no flash and no
  client JS needed. `<Link>` prefetches (RSC requests) are handled specially: the
  prefetch is redirected to warm the variant into the router cache, but no cookie
  is written and no exposure is emitted until a real navigation commits.
- **DOM changes apply on the client, behind a shield.** For same-URL experiments
  `<TestaProvider/>` applies the assigned variation's DOM changes after
  hydration and re-applies on App-Router soft navigation. `<TestaGuard/>` hides
  the page before first paint so control content is never shown before the
  variant, and reveals it once the variant is applied (or after the timeout).
- **Exposures feed results.** When tracking is enabled, the middleware emits one
  exposure per fresh enrollment to the tracking host so experiment results
  populate; it's deduped server-side.
```
