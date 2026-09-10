# Testa for Next.js (`@testa-soft/next`)

Run Testa A/B experiments in a Next.js app with **one proxy and (optionally) two
components**. You get two kinds of experiments from a single integration:

- **Split-URL redirects** — send a bucketed visitor to a different URL. Decided
  server-side in the proxy and issued as a `307` **before any HTML is sent**, so
  there is zero flicker and no client JavaScript is required.
- **HTML/DOM experiments** — "same URL, different content" changes (edit text,
  styles, show/hide/insert/move elements). Assigned server-side, applied on the
  client, with a built-in anti-flicker shield.

Both read the same sticky `_testa_exp` cookie, so a visitor is **bucketed once —
server-side — and stays in the same variation** across page loads, soft
navigations, and experiment types.

---

## Installation

```bash
npm install @testa-soft/next
```

Peer dependencies (a Next.js app already has these):

- `next` — `>=13.4.0`
- `react` — `>=18` (only needed if you use the client components)

---

## Concepts

**Server assigns, everything else follows.** The proxy runs on every matched
request, buckets the visitor deterministically (a stable hash of their id — never
`Math.random()`, so no sample-ratio mismatch), and writes the sticky `_testa_exp`
cookie. From then on every surface — the proxy, the client components — just
*reads* that cookie. Nobody re-rolls the dice.

**Split-URL is flicker-free by construction.** The redirect happens at the edge
before markup is streamed, so the control page is never painted.

**HTML changes happen on the client, behind a shield.** DOM changes have to mutate
content the server already rendered, so there's an unavoidable control→variant
moment. The shield hides the page until the variant is applied.

---

## Split-URL experiments

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

That is the entire integration for split-URL. `projectId` is your **crobot
project UUID**. With just `projectId`, the package fetches your project config
from the Testa config host (`https://config.testa-soft.tech/api/v1/config/{projectId}`)
and caches it. A bucketed visitor is redirected server-side; everyone else passes
through untouched. If no config can be resolved, the proxy **fails open** and does
nothing.

The proxy filters requests internally: `/_next/*`, `/api/*`, `/.well-known/*`,
and static-asset files (images, fonts, scripts, `robots.txt`, `sitemap.xml`, …)
pass through untouched — no cookies, no config fetch, no exposure. You do **not**
need a `matcher` for correct behavior.

### Optional: a `matcher` to save edge invocations

Without a `matcher`, the middleware function is still *invoked* on every asset
request (a harmless no-op). On hosts that bill per edge invocation, add one to
skip those invocations entirely:

```ts
// proxy.ts — optional cost optimization
export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'],
}
```

Next.js requires `matcher` to be a static literal in your file (it's parsed at
build time), so the package can't own it. Keep it conservative — a path the
matcher skips is a path Testa can never test on. To keep experiments off extra
routes, prefer the `skipPaths` option instead:

```ts
export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  skipPaths: ['/admin', /^\/(de|fr)\//], // prefix strings or pathname regexes
})
```

### Where the config comes from

| Option        | Use it when                                                              |
| ------------- | ----------------------------------------------------------------------- |
| `projectId`   | Default. Fetches from the built-in config host.                         |
| `host`        | Point at a staging/self-hosted config host.                             |
| `configUrl`   | Fetch a `ProjectConfig` JSON from a URL you control.                    |
| `loadConfig`  | Provide an async resolver (e.g. read Vercel Edge Config).               |
| `config`      | Pass a static `ProjectConfig` object — zero latency, no network fetch.  |

Inline example (handy for local dev, demos, or self-managed config):

```ts
// proxy.ts  (Next 13–15: middleware.ts, export `middleware`)
import { createTestaProxy } from '@testa-soft/next'
import projectConfig from './testa.config.json'

export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  config: projectConfig, // a ProjectConfig — zero-latency, no network fetch
})
```

Config caching (`cache` option), shared per server instance:

- `true` (default) — fresh for 60s, then served stale while revalidating in the
  background (never older than 5 min): zero request latency, publishes live in
  ~1 min. `cacheTtlMs` tunes the fresh window.
- `'per-pageload'` — DOCUMENT requests always fetch fresh (a publish is live on
  the very next hard pageview); RSC soft navigations reuse the pinned copy, so
  the config never shifts mid-SPA-session.

There's deliberately no "off" mode — it would add a blocking config fetch to
every matched request (soft navs and prefetches included) with no last-known
fallback. Testing config changes? `'per-pageload'` already fetches fresh on
every hard reload.

### Already have middleware? Composing with your own logic

Next.js runs **one** middleware and forwards **one** response. Request-header
overrides (`NextResponse.next({ request: { headers } })`) ride on that response
as a **wholesale set** — so returning testa's response drops your headers and
vice versa. Never build two responses; compose instead.

**Recommended — your logic inside the proxy** (`handler` option):

```ts
export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  handler: (req, event) => {
    // Standard middleware code. `req.headers` already includes x-testa-shield.
    const headers = new Headers(req.headers)
    headers.set('x-domain', 'acme.com')
    headers.set('x-search', req.nextUrl.search)
    return NextResponse.next({ request: { headers } })
  },
})
```

- Requests testa bypasses (`/api/*`, assets, `skipPaths`) delegate **straight to
  your handler** — your headers still reach API routes.
- A testa split-URL redirect short-circuits (your handler isn't called; nothing
  downstream renders). Your own redirects win on pass-through and carry testa's
  cookies.
- Testa merges its cookies onto whatever you return and re-patches the
  `x-testa-shield` override even if you return a plain `next()` or `undefined`.

**Yours first, then testa (tail call).** To run your logic before testa —
short-circuit on auth/maintenance without testa assigning or tracking anything,
or compute request headers testa should carry — mutate the request and
tail-call the proxy. Testa is transparent to upstream request mutation: headers
on the request you hand it are forwarded downstream on **every** path
(pass-through, bypassed `/api/*`/assets, fail-open):

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

**Testa first, then post-process (outer wrapper).** To act on testa's response,
call the proxy and add request-header overrides via the exported
`applyRequestHeaders` — it appends to the proxy's override set instead of
clobbering it (plain response headers and cookies merge fine with the standard
APIs). It is a no-op on redirect responses and needs `req` to seed the full
override set when the response has none (overrides are wholesale — seeding only
your headers would drop all the others downstream):

```ts
import { applyRequestHeaders, createTestaProxy } from '@testa-soft/next'

const testa = createTestaProxy({ projectId: '3fa85f64e1c2b' })

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const res = await testa(req, event) // forward `event` — exposure tracking uses waitUntil
  res.headers.set('x-frame-options', 'DENY') // response headers merge trivially
  return applyRequestHeaders(res, { 'x-domain': 'acme.com' }, req)
}
```

---

## HTML/DOM experiments

Add two **zero-config server components** to your root layout (App Router):
`<TestaGuard/>` as high in `<head>` as possible, and `<TestaProvider/>` in
the body. Keep the proxy too — DOM experiments reuse its server-side assignment.

```tsx
// app/layout.tsx
import { TestaGuard, TestaProvider } from '@testa-soft/next/server'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Anti-flicker. Self-gating: renders ONLY when the proxy flagged a
            pending DOM change for this request — split-URL-only pages and
            visitors with nothing to apply never get shielded. */}
        <TestaGuard selector="body" timeoutMs={4000} />
      </head>
      <body>
        {children}
        {/* Fetches the same ProjectConfig the proxy resolves — server-side, on
            the first request, cached in the Next data cache (60s background
            revalidation). No app-side fetch code. Then reads _testa_exp and
            applies the assigned variation's DOM changes client-side,
            re-applying on App-Router soft navigation. Fails open (renders
            nothing) if the config host is unreachable. */}
        <TestaProvider projectId="3fa85f64e1c2b" />
      </body>
    </html>
  )
}
```

`projectId` is the same id you pass to `createTestaProxy`. That's the whole
integration — no config fetching, no `headers()` plumbing.

### Inline config

If you manage the config yourself (local dev, demos, self-managed JSON), pass
`config` straight to the same `/server` components — it skips their fetch:

```tsx
import { TestaGuard, TestaProvider } from '@testa-soft/next/server'
import projectConfig from './testa.config.json'
// <TestaGuard/> in <head>, <TestaProvider config={projectConfig}/> in the body.
```

Supported change types:

| Change type            | Effect                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `change_html`          | Set matched elements' `innerHTML`.                           |
| `css`                  | Inject a stylesheet.                                         |
| `hide_element`         | `display:none` on matched elements.                          |
| `append_html`          | Insert HTML at the end of matched elements.                  |
| `prepend_html`         | Insert HTML at the start of matched elements.                |
| `move_element_append`  | Move matched elements under a target selector (append).      |
| `move_element_prepend` | Move matched elements under a target selector (prepend).     |

> Split-URL-only deployments don't need `<TestaGuard/>` — the `307` is already
> flicker-free. The shield only matters when applying DOM changes on top of
> server-rendered content.

### Preview mode (for editors)

Preview **unpublished** variation drafts without exposing them to real visitors.
Pass `previewApiUrl` (your Testa backend base URL) to `<TestaProvider/>`
(works on both the `/server` and `/experiments` variants):

```tsx
<TestaProvider projectId="3fa85f64e1c2b" previewApiUrl="https://new.testa-soft.tech" />
```

Then open any page with the preview query params:

```
https://yoursite.com/pricing?testa_preview=true&testa_preview_token=<token>
```

In preview mode the component **skips normal assignment** and instead fetches the
draft changes for that session and applies them, so a draft renders exactly as it
will ship. A failed or malformed response applies nothing (fail-safe).

---

## Pages Router integration

The proxy is router-agnostic — split-URL redirects work identically on the
Pages Router. The client half comes from `@testa-soft/next/pages`: the same
`<TestaProvider/>` name as the App Router's `@testa-soft/next/server`, one
entry per router (a given app can only ever use one). The complete
integration is one id in two files:

```ts
// middleware.ts — server-side, flicker-free split-URL redirects on every hard load
import { createTestaProxy } from '@testa-soft/next'

export const middleware = createTestaProxy({ projectId: '3fa85f64e1c2b' })
export const config = { matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'] }
```

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

Who does what:

What the provider wires up (all sharing ONE config fetch and the proxy's
cookie contract — assignments made server-side are reused, never re-rolled):

| Traffic | Handled by | How |
| --- | --- | --- |
| Hard loads (ads, search, direct, reloads) | `createTestaProxy` | Server-side 307 — the variant is the first thing painted. |
| Soft navs (`next/link` inside the app) | the built-in router guard | These never reach the server; the guard reads the sticky `_testa_exp` cookie and re-points the navigation at the router-event level, before the control page renders. |
| DOM changes, goals, exposure events | the built-in client engine (`@testa-soft/react`) | Client-side, on mount and on every navigation. |
| Anti-flicker | the built-in head shield | **On by default, no wiring.** The provider server-renders a JS-free `<style>` into `<head>` (via `next/head`) that hides the content, and unrenders it the moment the variant is applied. |

### Anti-flicker on the Pages Router

The Pages Router ships complete server-rendered HTML, so the browser paints the
**control** content long before React hydrates. That makes a client-side shield
useless — an effect can only run after that paint, so raising one there turns
one flash into two (content → blank → variant). The shield therefore has to
exist in the server's markup, which is what `<TestaProvider/>` does for you.

Nothing to add, and nothing to configure. Two knobs if you want them:

```tsx
<TestaProvider projectId="3fa85f64e1c2b" shield={{ selector: '#__next', timeoutMs: 2000 }} />
<TestaProvider projectId="3fa85f64e1c2b" shield={false} />  {/* you own anti-flicker */}
```

The reveal is not JavaScript-dependent: the hide lives in a CSS animation that
flips to visible at `timeoutMs` (default 4s), so a bundle that 404s or a
hydration crash can't leave a site hidden.

**Optional, and worth it:** add `<TestaGuard/>` to `pages/_document.tsx`. It
doesn't change the shield — it starts the **config fetch** during HTML parse
instead of after hydration, which is what shortens the window the page spends
hidden (the shield stays up until the config lands):

```tsx
// pages/_document.tsx
import { Head, Html, Main, NextScript } from 'next/document'
import { TestaGuard } from '@testa-soft/next/pages'

export default function Document() {
  return (
    <Html lang="en">
      <Head><TestaGuard projectId="3fa85f64e1c2b" /></Head>
      <body><Main /><NextScript /></body>
    </Html>
  )
}
```

Want the pieces individually (e.g. split-URL-only, no DOM engine)?
`<TestaRouterGuard/>` is exported standalone from `@testa-soft/next/pages`
(and `/router-guard`) — it takes a resolved `config` object and never fetches,
so you stay in control of when (and whether) the config is loaded.

> **App Router users don't need this section.** `<TestaProvider/>` /
> `<TestaGuard/>` from `@testa-soft/next/server` cover the client half, and the
> proxy sees App-Router soft navs too (they fetch RSC payloads over HTTP,
> including a prefetch-safe path for `<Link>` prefetches).

---

## Goals & conversions

Goals are created in crobot and attached to an experiment; the SDK arms them
client-side (via `<TestaProvider/>`) on every navigation, for every
experiment the visitor is **assigned** to and whose session is live. Goals are
deliberately **not page-gated** — a goal usually completes on a different page
than the experiment runs on. Conversions POST the legacy
`{trackingHost}/api/leads/convert` payload (`goal_id`, `action`, `lead_uuid`,
`variation`, `data`) — identical to the 3.3.3 pixel — so results populate the
same either way. crobot counts each goal **once per visitor**; the client also
guards once per page load.

| Goal type   | Fires when                                                                | Code needed |
| ----------- | ------------------------------------------------------------------------- | ----------- |
| `page_view` | The current URL matches the goal pattern (`exact`/`contains`/`regex`).    | none        |
| `click`     | The **first** element matching the goal's CSS selector is clicked (650ms setup delay + late-render retries, 3.3.3 parity). Prefer specific selectors (`#cta`, `[data-goal=…]`). | none |
| `custom`    | Your code emits a matching event name.                                     | one call    |

Custom events, from bundled code:

```ts
import { pushEvent } from '@testa-soft/next'

pushEvent('signup_completed', { plan: 'pro' })
```

From non-bundled scripts / GTM Custom HTML, the same call is installed as
`window.testa.pushEvent(...)` **and** — for 3.3.3 docs parity —
`window.Analytica.pushEvent(...)` (non-clobbering: a real legacy pixel's own
`pushEvent` is never overwritten, so dual-running sites keep pixel behavior).
Note the globals exist from hydration onward; calls made before hydration are
dropped (same failure mode as the legacy pixel pre-load — fire conversion
events on user actions, or import `pushEvent` from the package).

---

## Analytics events

Testa exposes experiment exposures on **two independent surfaces** — a
**client-side** event bus in the browser, and a **server-side** hook in the proxy.
Use either, or both; they don't depend on each other.

Two events, two moments:

- **`variation_assigned`** — the visitor is **bucketed** (server-side, in the
  proxy). This is the assignment decision.
- **`variation_applied`** — the visitor is **shown** the variation (client-side,
  **once per session**): after the redirect for split-URL, on the page for DOM.

### Client-side (`variation_applied`)

The SDK fires `variation_applied` in the browser once per session when a visitor
is shown a variation. Subscribe with named functions — **multiple handlers are
allowed**, and each call returns an unsubscribe function:

Subscribe from a **client component**, in an effect. `onVariationApplied` returns
its own unsubscribe, so returning it from the effect is the whole cleanup —
without it, Fast Refresh and StrictMode's double mount stack duplicate handlers.

```tsx
// app/components/TestaAnalytics.tsx
'use client'

import { onVariationApplied } from '@testa-soft/next'
import { useEffect } from 'react'

export function TestaAnalytics(): null {
  useEffect(
    () =>
      onVariationApplied((d) => {
        // Hand it to whatever you use — an analytics SDK, your own endpoint.
        track('Experiment Viewed', {
          experiment: d.experiment,
          variation: d.variation,
          title: d.title,
        })
      }),
    [],
  )
  return null
}
```

Render it once under your root layout. Register as many handlers as you like —
each subscription is independent and returns its own unsubscribe:

```tsx
useEffect(() => onVariationApplied((d) => track('Experiment Viewed', d)), [])
useEffect(() => onVariationApplied((d) => console.debug('shown', d.experiment, d.variation)), [])
```

> Module-scope `testa.onVariationApplied(...)` also works, but only outside a
> React tree: in a server component there is no `window`, and nothing ever
> unsubscribes. Use the named import in an effect inside the app, and the
> `testa` namespace (or `window.testa`) outside a bundle.

The payload is:

```ts
d = {
  project_id, // crobot project id (number)
  experiment, // experiment IDENTIFIER (0-based), not the DB pk
  variation,  // variation IDENTIFIER (0 = control)
  uuid,       // visitor id
  title,      // experiment title, when set
  url,        // the URL the variation was applied on
}
```

**History replay.** A handler registered **after** the event already fired still
receives it. Analytics scripts often load late — they won't miss the exposure.
Each handler also sees each unique `(experiment, variation)` event at most once.

**GTM Custom HTML / non-bundled scripts.** The same API is installed on
`window.testa`, so you can subscribe without importing the package:

```html
<script>
  window.testa.onVariationApplied(function (d) {
    // e.g. push to your own analytics
  })
</script>
```

### GTM `dataLayer`

On **every** `variation_applied`, the SDK also pushes to the GTM `dataLayer`
automatically — this is **not configurable**:

```js
{
  event: 'Analytica',
  ExperimentId,   // = experiment identifier
  ExperimentName, // = experiment title (empty string if unset)
  VariationId,    // = variation identifier
  VariationName,  // 'Control' for id 0, else 'Variation<id>'
}
```

In GTM, add a **Custom Event** trigger that fires on the event name `Analytica`,
then wire it to whatever tag you want (GA4 event, a pixel, etc.). The
`{{ExperimentId}}` / `{{VariationId}}` data-layer variables are available on that
trigger.

### Server-side (`variation_assigned`)

For server-side destinations — a data warehouse, a server-side collector, a
webhook — use
the `onVariationAssigned` option on `createTestaProxy`. It fires for each
variation the visitor is assigned on a request:

```ts
// proxy.ts
import { createTestaProxy } from '@testa-soft/next'

export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  onVariationAssigned: (event, ctx) => {
    // Fire once per visitor, not once per request.
    if (!event.firstAssignment) return

    // ctx.waitUntil keeps this fetch alive AFTER the response is sent,
    // without delaying it — edge/runtime-safe.
    ctx.waitUntil(
      fetch(process.env.ANALYTICS_INGEST_URL as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.ANALYTICS_API_KEY,
          event: 'experiment_assigned',
          distinct_id: event.visitorId,
          properties: {
            experiment_id: event.experimentId,
            variation_id: event.variationId,
            title: event.title,
            url: event.url,
          },
        }),
      }),
    )
  },
})
```

The hook signature is `(event, ctx) => void | Promise<void>`. Errors and
rejections are swallowed so a hook can never break the request.

- **`ctx.waitUntil(promise)`** — keeps an async call alive until it completes
  **after** the response has been sent. It never delays the response, so tracking
  latency is invisible to the visitor. Use it for any network call — an analytics
  ingest endpoint, a warehouse, a webhook.
- **`event.firstAssignment`** — `true` only when the visitor was freshly bucketed
  on this request (`false` when served from the sticky cookie). Guard on it for
  **once-per-visitor** semantics.

The server-side `event` (type `VariationAppliedEvent`) uses different field names
from the client payload — document them per surface:

| Field              | Type      | Meaning                                              |
| ------------------ | --------- | ---------------------------------------------------- |
| `experimentId`     | `number`  | Experiment identifier.                               |
| `variationId`      | `number`  | Variation identifier (0 = control).                  |
| `visitorId`        | `string`  | Visitor id (client payload calls this `uuid`).       |
| `title`            | `string?` | Experiment title, when set.                          |
| `url`              | `string`  | The request URL the variation was applied on.        |
| `firstAssignment`  | `boolean` | `true` on a fresh bucketing, `false` from the cookie.|
| `redirected`       | `boolean` | `true` when the assignment triggered a `307`.        |
| `destinationUrl`   | `string?` | The redirect destination, present when `redirected`. |

> **Field names differ by surface.** The **client** payload uses
> `experiment` / `variation` / `uuid`; the **server** event uses
> `experimentId` / `variationId` / `visitorId`. Same concepts, different keys —
> reach for the right ones on each side.

`ctx.request` is the incoming `NextRequest`, for hooks that need to read a
header or cookie of their own.

### One visitor id across Testa and your analytics

An assignment reported from the edge is only useful if it lands on the **same
person** your analytics already knows. Testa's own `_testa_uuid` is shared with
nothing, so an event sent under it creates a user that exists nowhere else, and
the exposure never joins to the behaviour it is meant to explain.

**Give Testa the id you already use.** Either form works:

```ts
// Derivable from the request — a cookie, a header. One line.
createTestaProxy({
  projectId: '3fa85f64e1c2b',
  visitorId: (req) => req.cookies.get('my_visitor_id')?.value ?? null,
})
```

```ts
// Or hand it over per request, when resolving it means awaiting something.
import { createTestaProxy, setVisitorId } from '@testa-soft/next'

const testa = createTestaProxy({ projectId: '3fa85f64e1c2b' })

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  setVisitorId(req, await mySessionLookup(req))
  return testa(req, event)
}
```

The id is mirrored into `_testa_uuid` and its `HttpOnly` backup, so the
browser-side pieces (goal conversions, client exposures, the cold fallback)
keep working — they read that cookie.

> **A supplied id SEEDS a visitor, it never re-keys one.** A visitor who
> already has a `_testa_uuid` keeps it, whatever you pass. Bucketing is
> `hash(visitorId:experimentId)`, so re-keying would move a returning visitor
> to a different variation mid-experiment — possibly while they are standing on
> the page their old variation sent them to. Your id can churn for reasons that
> have nothing to do with experiments (a logout, a rotation, a consent reset),
> and none of them are reasons to re-bucket anyone.
>
> The corollary: **adopt an existing id before minting a new one.** If your own
> cookie is missing but `_testa_uuid` is present, reuse it — minting blindly
> leaves Testa on the old id and your analytics on the new one.

> **Anything you `await` before delegating blocks the redirect.** The `307` is
> not produced until the proxy runs, so a slow lookup there is latency on every
> experiment pageview — the very latency the server-side redirect exists to
> avoid. Resolve the id from the request when you can; treat a network call as
> a real cost.

### Sending the assignment to PostHog

With one shared id, reporting is a plain POST under `event.visitorId`:

```ts
export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  visitorId: (req) => req.cookies.get('my_visitor_id')?.value ?? null,

  onVariationAssigned: (event, ctx) => {
    ctx.waitUntil(
      fetch(`${process.env.POSTHOG_HOST}/i/v0/e/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.NEXT_PUBLIC_POSTHOG_KEY,
          event: 'experiment_assigned',
          distinct_id: event.visitorId,
          properties: {
            experiment_id: event.experimentId,
            variation_id: event.variationId,
            experiment_title: event.title,
            redirected: event.redirected,
            $current_url: event.url,
          },
          timestamp: new Date().toISOString(),
        }),
      }),
    )
  },
})
```

This fires **before** the split-URL `307`. The request is server-to-server, so
the browser navigating away cannot cancel it; `ctx.waitUntil` keeps the runtime
from tearing the invocation down first.

> **Use the capture HTTP API, not `posthog-node`.** The Node client buffers
> events and flushes them on a timer, and a serverless/edge invocation is gone
> long before that timer fires — the events are simply lost. A plain `fetch`
> inside `ctx.waitUntil` has no such gap.

> **Do not try to merge identities afterwards.** Reporting under Testa's id and
> reconciling later with `posthog.alias()` does not work: PostHog has
> deprecated `alias` in favour of `identify` and will not merge an anonymous
> person with it — posthog-js keeps `$user_state: "anonymous"` and the records
> stay separate. Reading PostHog's own id from its cookie server-side is
> correct whenever the cookie exists, but on a visitor's first request
> posthog-js has never run, so there is no id to borrow at the moment the edge
> must decide — which is exactly the visitor an entry-point experiment cares
> about. Sharing one id from the start has neither hole.

Analyse it as a **trend broken down by `variation_id`**. That works on any
PostHog version. Wiring it to PostHog's own Experiments product means giving it
an exposure event it recognises, which depends on your PostHog version — check
before relying on it.


### Which surface should I use?

The two surfaces are **independent**. Client-side (`variation_applied`) is right
for anything that lives in the browser session — a tag manager, or any analytics
SDK already loaded on the page. Server-side (`onVariationAssigned`) is right for
destinations you'd rather not trust to the client — a warehouse, a server-side
collector, a webhook — and it fires even if the visitor has JavaScript disabled. Wire up whichever you
need; wire up both if you want the exposure in two places.

**On a split-URL experiment, prefer the server hook.** The two surfaces do not
fire at the same depth in the funnel: `onVariationAssigned` fires for both arms
at the instant of bucketing, while `variation_applied` fires for the control on
its own page and for the variant only after a `307` **and** a second page load.
Count from the client alone and every visitor who abandons in between is counted
for control and not for variant — which shows up as a sample ratio mismatch that
is an artefact of the measurement, not of the bucketing.

### Sample ratio mismatch (SRM) on a split URL

If the observed split does not match the configured one, check the counting
point before suspecting the bucketing (which is a deterministic hash of
`visitor_id:experiment_id` and is separately unit-tested):

| Cause | What you see | Fix |
| --- | --- | --- |
| Counting only in the browser | Variant consistently **under** control | Leave `tracking` on (default) so the proxy counts at assignment |
| Custom tracking wired to `variation_applied` only | Variant under-reported in **your** analytics, correct in Testa | Send from `onVariationAssigned` instead |
| Visitors losing `_testa_uuid` | Both arms inflated, split roughly even | Inspect `ctx.cookies` — see below |
| `decisions: 'client'` or a permanently cold instance | Client decides; server hook never fires | Use the client `variation_assigned` event too |
| Assignments and sessions on different people in your analytics | Split looks fine in Testa, funnels broken in your tool | Share one id — `visitorId` / `setVisitorId`, never a post-hoc merge |

`ctx.cookies` (a `VisitorCookieState`) is there for the third row. It reports
whether the request carried `_testa_uuid`, the `HttpOnly` backup, an assignment,
**and how many other cookies came with it** — which separates "cookies do not
work for this client at all" (a script or crawler: expect `otherCookies: 0`)
from "cookies work fine and ours is the one missing" (a real browser mid-session
carrying a cart and a consent record). The second population is the one that
gets re-bucketed and can land in the other group.

---

## Targeting (audience rules)

Targeting is **session-scoped and first-touch**, matching crobot 3.3.3. When a
visitor first touches your site, Testa evaluates the experiment's targeting
**site-wide** and **caches the verdict** (eligible or excluded) on the sticky
cookie. That cached verdict is then honored for the rest of the session — so a
UTM (or any other signal) present on the **landing page** keeps the visitor
eligible on a **later page** that no longer carries it.

The session is a **30-minute sliding window** by default (re-touching resets the
expiry); override it with the `sessionLengthSec` option on `createTestaProxy`.
The same window governs the exclusion cooldown for visitors who don't qualify.

Conditions are **grouped by dimension**: **OR within a dimension** (any rule of
that dimension may pass) and **AND across dimensions** (every dimension in the
targeting set must pass). Exclusion rules are the inverse — if **any** exclusion
condition matches, the visitor is excluded.

---

## API reference

### `createTestaProxy(options)`

Returns a Next.js proxy/middleware function. Import from `@testa-soft/next`.

| Option               | Type                                            | Default                          | Description                                                                          |
| -------------------- | ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `projectId`          | `string`                                        | —                                | **Required.** Your crobot project UUID. Config is fetched from `{host}/api/v1/config/{projectId}`. |
| `projectSlug`        | `string`                                        | —                                | *Deprecated* alias for `projectId`.                                                  |
| `config`             | `ProjectConfig`                                 | —                                | Static config. Zero-latency; wins over `configUrl`/`loadConfig`.                     |
| `configUrl`          | `string`                                        | —                                | URL to fetch a `ProjectConfig` JSON from. Cached by TTL.                             |
| `loadConfig`         | `(projectId) => Promise<ProjectConfig \| null>` | —                                | Custom async config resolver (e.g. Edge Config). Cached by TTL.                      |
| `cacheTtlMs`         | `number`                                         | `30000`                          | Cache lifetime for fetched config.                                                   |
| `host`               | `string`                                         | `https://config.testa-soft.tech` | Config host. Also via `TESTA_CONFIG_HOST`.                                            |
| `sessionLengthSec`   | `number`                                         | `1800` (30 min)                  | First-touch targeting cache / session / exclusion-cooldown window, in seconds.       |
| `secureCookies`      | `boolean`                                        | `true`                           | Emit `Secure` cookies. `false` for local http dev.                                   |
| `cookieDomain`       | `string`                                         | —                                | Explicit cookie `Domain` for cross-subdomain tracking (e.g. `.example.com`).         |
| `discoverRootDomain` | `boolean`                                        | `false`                          | Auto-derive the registrable domain for cookies.                                      |
| `legacyCookiesEnabled` | `boolean`                                      | `false`                          | **Temporary, cutover only.** Adopt a returning visitor's legacy 3.x pixel cookies (`_testa_exp_<id>` etc.) before deciding, so a live experiment doesn't re-bucket them. Set the same value on `<TestaProvider>`. |
| `visitorId`          | `string \| ((req) => string \| null)`           | —                                | Use YOUR visitor id instead of Testa's `_testa_uuid`, so assignments land on the person your analytics already knows. A **seed**: a visitor who already has an id keeps it. Must be stable per visitor — a rotating id re-buckets. |
| `onVariationAssigned`| `(event, ctx) => void \| Promise<void>`         | —                                | **Server-side** hook per assignment, fired BEFORE any split-URL `307`. `ctx.waitUntil(promise)` keeps async work alive past the response — never delays it. `ctx.request` is the `NextRequest` (read your own analytics cookie off it). Guard on `event.firstAssignment` for once-per-visitor. |
| `tracking`           | `boolean`                                       | `true`                           | Report the exposure to Testa at assignment — the only point that counts both arms at the same depth in the funnel. Set `false` to leave counting to the browser. |
| `trackingHost`       | `string`                                        | `TESTA_TRACKING_HOST` \| SDK default | Base URL for `/api/leads` and the `/log` beacon. |
| `skipPaths`          | `(string \| RegExp)[]`                           | —                                | Extra paths passed through untouched, on top of the built-in filter (`/_next/*`, `/api/*`, `/.well-known/*`, asset extensions). Strings are segment-aligned prefixes; RegExps test the pathname. |
| `handler`            | `(req, event) => Response \| null \| undefined \| Promise<…>` | —                   | Your own middleware logic, composed inside the proxy — see [Composing with your own logic](#already-have-middleware-composing-with-your-own-logic). |

Exported constants: `DEFAULT_CONFIG_HOST`, `DEFAULT_TRACKING_HOST`,
`SHIELD_HEADER`. Exported helpers: `applyRequestHeaders(res, headers, req?)`
(outer-wrapper composition), `shouldBypassRequest(pathname, skipPaths?)`.
Exported types: `TestaProxy`, `TestaProxyOptions`, `TestaHandler`, `SkipPath`,
`VariationHookContext`, `VariationAppliedEvent` (the server hook's `event`).

### `setVisitorId(request, visitorId)` — `@testa-soft/next`

Use your own visitor id for **this request**, for ids that must be awaited (a
session lookup, a KV read) — the `visitorId` option is a synchronous resolver
and cannot await.

```ts
export async function proxy(req: NextRequest, event: NextFetchEvent) {
  setVisitorId(req, await mySessionLookup(req))
  return testa(req, event)
}
```

Keyed on the request object, not module state: one isolate serves many requests
concurrently, so a parked module-level value would be read by the wrong visitor
and assign them someone else's variation. Pass the same request instance you
hand to the proxy — building a new `NextRequest` produces a different key.

A **seed**, like the `visitorId` option: a visitor who already has a
`_testa_uuid` keeps it. An empty id is ignored.

### Client event bus — `@testa-soft/next`

| Export                          | Signature                                          | Description                                                        |
| ------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `testa.onVariationApplied`      | `(handler) => Unsubscribe`                         | Subscribe to `variation_applied`. Multiple handlers; history replay. |
| `testa.onVariationAssigned`     | `(handler) => Unsubscribe`                         | Subscribe to the client-mirrored `variation_assigned`.            |
| `onVariationApplied`            | `(handler) => Unsubscribe`                         | Standalone equivalent of `testa.onVariationApplied`.              |
| `onVariationAssigned`           | `(handler) => Unsubscribe`                         | Standalone equivalent of `testa.onVariationAssigned`.            |
| `window.testa`                  | `{ onVariationApplied, onVariationAssigned }`      | Same API for GTM Custom HTML / non-bundled scripts.               |

The handler receives a `VariationEvent`: `{ project_id, experiment, variation, uuid, title, url }`.

### `<TestaProvider>` — `@testa-soft/next/server` (recommended)

Async React **Server Component**. Fetches the project config server-side on the
first request and caches it in the Next data cache, then renders the client
applier. Fails open (renders nothing) when the config can't be resolved.

| Prop            | Type            | Default                          | Description                                                          |
| --------------- | --------------- | -------------------------------- | -------------------------------------------------------------------- |
| `projectId`     | `string`        | —                                | **Required** (unless `config` given). Same id as `createTestaProxy`. |
| `config`        | `ProjectConfig` | —                                | Inline config — skips the fetch entirely.                             |
| `host`          | `string`        | `https://config.testa-soft.tech` | Config host. Also via `TESTA_CONFIG_HOST` (matches the proxy).        |
| `revalidateSec` | `number`        | `30`                             | Next data-cache revalidation window for the config fetch.             |
| `previewApiUrl` | `string`        | —                                | Backend base URL; enables `?testa_preview`.                           |
| `trackingHost`  | `string`        | `https://new.testa-soft.tech`    | Backend base URL for goal conversions.                                |
| `legacyCookiesEnabled` | `boolean` | `false`                          | **Temporary, cutover only.** Must match the proxy's value.            |

This is the **only** `<TestaProvider>` to mount in a Next.js app. (The exports
map also contains `./_internal/experiments` — the private client half of these
server components, needed by the build for the `"use client"` boundary. Don't
import it; it has no semver guarantees.)

### `<TestaGuard>` — `@testa-soft/next/server`

Async React **Server Component**, self-gating: renders the anti-flicker script
**only** when the proxy set `x-testa-shield: 1` for this request (i.e. the
visitor has a pending DOM change on this page). Renders nothing outside a
request scope (static generation) — fail open, no shield.

| Prop        | Type                        | Default     | Description                                             |
| ----------- | --------------------------- | ----------- | ------------------------------------------------------ |
| `selector`  | `string`                    | `'body'`    | Selector to hide until reveal.                         |
| `timeoutMs` | `number`                    | `4000`      | Hard fallback before auto-reveal.                      |
| `mode`      | `'opacity' \| 'visibility'` | `'opacity'` | How to hide (`opacity` avoids reflow).                 |
| `styleId`   | `string`                    | —           | `<style>` element id — makes raising idempotent.       |

### `loadTestaConfig(options)` — `@testa-soft/next/server`

The config loader the server components use, exported for custom server code:
`loadTestaConfig({ projectId, host?, revalidateSec? })` → `Promise<ProjectConfig | null>`.
Fail-open: resolves `null` on any network/HTTP/shape failure.

### `<TestaProvider>` — `@testa-soft/next/pages` (Pages Router)

The Pages Router twin of `/server`'s provider — add once in `_app.tsx`. Takes
the `@testa-soft/react` provider props (`projectId` is the only one a normal
integration passes; `config`, `host`, `tracking`, `shield`, cookie options as
documented in [react.md](./react.md)) and self-wires the client engine, the
soft-nav router guard, and the server-rendered anti-flicker shield on one
shared config fetch. Mounted in the App Router by mistake it degrades safely
(guard no-ops with a dev warning, shield doesn't render) — but use `/server`
there.

`shield` here controls the **head** shield: `false` opts out, an object passes
`selector` / `timeoutMs` / `mode` through. An inline `config` with nothing to
hide skips the shield entirely — with only a `projectId` the config hasn't
arrived at first paint, which is when the decision must be made, so it shields.

### `<TestaRouterGuard>` — `@testa-soft/next/router-guard`

| Prop     | Type            | Default | Description                                                                 |
| -------- | --------------- | ------- | --------------------------------------------------------------------------- |
| `config` | `ProjectConfig` | —       | **Required.** The resolved config. The guard never fetches — `<TestaProvider/>` from `/pages` resolves it once per page load and passes it down. |

Mounted without a Pages Router (i.e. in the App Router) it is a no-op with a
dev-time warning — the proxy already sees App-Router soft navs.

---

## Troubleshooting

**Nothing happens at all on a self-hosted stack** — no assignment, no redirect,
no DOM changes, with a config you know is right. Set `TESTA_DEBUG=1` and read the
`x-testa-debug` response header: `url` is what the proxy actually matched against
and `urlSource` says which mechanism produced the host. An internal hostname
there needs `publicHost` / `x-testa-host`. (An internal *port* no longer breaks
matching — `X-Forwarded-Port` is ignored and portless rules match any port.)

**A DOM change flashes control before the variant.** App Router: make sure
`<TestaGuard/>` is in `<head>` (not the body), so it runs before first paint.
Pages Router: the shield is server-rendered by `<TestaProvider/>` and needs no
wiring — check you haven't passed `shield={false}`, and that the provider really
wraps the app in `_app.tsx`. On *soft* navigations there is no shield by design;
the re-apply lands in the same frame as the new page's render.

**Content → blank → variant (two flashes).** That's a client-side shield raised
after the server HTML already painted. On the Pages Router, upgrade to a version
whose `<TestaProvider/>` server-renders the shield (`@testa-soft/next` ≥ 1.3.3);
elsewhere move the shield into `<head>` markup.

**A change is applied then reverted.** React owns the DOM it renders. Prefer `css`
changes (injected into `<head>`, which React never reconciles) for anything
expressible as style; `css` survives every re-render.

**Split-URL loops or doesn't fire.** The redirect only enrolls on the experiment's
target page rule and never re-matches the destination URL. Check the experiment's
page rule and match type.

**No `variation_applied` event.** It fires **once per session** on the applied
page — a soft-nav re-apply or a re-render won't re-fire it. Register handlers
early, but history replay means a late handler still receives an event that
already fired.

**Nothing happens at all.** The proxy fails open when it can't resolve config —
confirm `projectId` (or `config`) is correct. If you added an optional
`config.matcher` or `skipPaths`, confirm neither excludes the route you're
testing on.

---

## How it works (architecture)

`@testa-soft/next` is a thin Next.js adapter over two shared, framework-neutral
packages:

- **`@testa-soft/experiment-core`** — the decision layer: deterministic bucketing,
  the packed `_testa_exp` cookie, split-URL redirect resolution, first-touch
  session targeting.
- **`@testa-soft/dom`** — the render layer: applying DOM changes, the anti-flicker
  shield, and the client-side event bus.

The same two packages back other framework integrations, so bucketing and
rendering behave identically everywhere a visitor might be seen.
