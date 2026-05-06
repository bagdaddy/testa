# Architecture — Tracker (pixel + edge worker)

The tracker is the **client-side SDK system**: TS pixel runtime + Cloudflare Worker augmentation. Together they replace today's `crobot/resources/js/integration/3.6/script.js`.

## Integration model — pixel is primary, edge is a thin gateway

~99% of customers integrate by embedding the pixel `<script>` in their HTML. Their site continues to be served from their own origin. **All experiment decisions (URL match, audience targeting, variation selection, redirect target) happen in the pixel.** The edge worker is a thin gateway: serves the pixel from KV, accepts `/track`, sets first-party cookies, bot-filters, HMAC-signs and forwards batches.

A separate **premium CNAME-edge offering** can route customer traffic through our worker (CNAME-based) for zero-flicker first-pageload behavior; that's a side product, not the default. Nothing in the default integration path runs on the edge worker beyond the gateway role above.

**Edge workers are deployed per-customer.** Each customer gets their own Cloudflare Worker (`testa-edge-{customer_slug}`) provisioned at signup; customer-specific traffic spikes scale that customer's worker independently and bill them for it. The shared `track.testa.com` deployment serves customers without CNAME setup (third-party cookies). See `docs/architecture/05-rollout.md` § Edge worker deployment model.

**Anti-flicker is not the pixel's responsibility.** The customer pastes a small SmartCode snippet that hides their `<body>` until the pixel signals readiness via `_testa.load()` (or a configurable timeout, never strand). The pixel never injects opacity/visibility shields itself. This mirrors the VWO / Optimizely SmartCode pattern.

## Two-piece pixel: loader + runtime

The customer embeds **one** script tag pointing at our edge:

```html
<script src="https://track.{customer}.com/projects/{project_slug}.js"></script>
```

The edge worker responds with a **single combined bundle** consisting of:

1. **Loader stub** (~5 KB minified, sync). Creates `window._testa` with a queue. Customer code can call `_testa.track(...)`, `_testa.consent(...)` immediately, even before the runtime has finished loading. The loader queues the calls.
2. **Runtime** (~30 KB minified, executes after loader). Hydrates the queue, applies experiments, fires `_testa.load()`, starts emitting tracking events.

The loader is appended inline; the runtime is appended via `<script defer>` with a content-hashed URL so it can be edge-cached aggressively.

Customer SmartCode (provided as a copy-paste snippet, version-controlled by us, ships separately from the pixel) is responsible for visual gating until `_testa.load()` resolves.

## Public JS API

```ts
// Synchronous (queued before runtime loads)
window._testa.track(event_name: string, props?: Record<string, unknown>): void;
window._testa.trackPurchase(value: number, currency: string, order_id: string, items?: number): void;
window._testa.consent(state: 'granted' | 'denied' | 'unknown'): void;
window._testa.identify(visitor_id: string): void;  // optional override
window._testa.navigate(url: string): void;         // explicit SPA route hint (backstop for monkey-patch)

// Lifecycle signals (consumed by customer SmartCode)
window._testa.load(): Promise<void>;               // resolves when initial experiments resolved + applied

// Auto-emitted by runtime
//   page_view        on every page load AND on SPA route changes (default; configurable)
//   session_start    when _testa_ses cookie is created or refreshed after expiry
//   experiment_view  when a variation is applied (re-fires on SPA route changes that match a different experiment)
//   purchase         only fires on explicit trackPurchase
//   _pixel_health    synthetic event, ~hourly, carries drop / retry / queue counts (reserved name)
```

### `window.Analytica.*` legacy globals

Drop-in compatibility with 3.x customers requires the full `window.Analytica` surface (eventEmitter, UUID_COOKIE, COOKIE_NAME, SESSION_COOKIE, cookies map, etc.) plus `window.crbData`, `window.apiUrl`, `window.testa_env`, plus the legacy `POST /api/leads`, `POST /api/leads/convert`, `GET /api/pixel` calls. **Treat that surface as a frozen API.** See `docs/reference/legacy-pixel-mapping.md` for the full inventory.

## Runtime modules

```
src/loader.ts                   sync stub (Phase 3.1)
src/runtime/
  index.ts                      hydrate queue, init modules, fire _testa.load() (Phase 3.2)
  cookies.ts                    read/write _testa_uuid, _testa_ses, _testa_exp (Phase 3.3)
  consent.ts                    consent state machine; default granted (Phase 3.4)
  spa.ts                        history.pushState/replaceState monkey-patch + popstate + hashchange (Phase 3.5)
  network/
    outbox.ts                   IndexedDB-backed event outbox (durable retry queue)
    transport.ts                fetch-keepalive primary, sendBeacon fallback on pagehide
    health.ts                   _pixel_health synthetic event emitter
  events.ts                     public track/trackPurchase API + auto-emit (Phase 3.6)
  rules/
    audience.ts                 evaluate AudienceCondition tree (page/visitor/geo/device/time facts)
    custom-js.ts                sandboxed expression evaluator for `visitor.custom`
    legacy.ts                   3.3.x/3.6 flat targeting[] evaluator (compat for old projects)
  experiments/
    traffic.ts                  consistent-hash variation assignment
    apply/
      css.ts                    style injection
      html.ts                   DOM swaps
      text.ts                   copy/text replacement
      js.ts                     custom JS injection
      attribute.ts              element attribute set
      redirect/                 state-of-the-art redirect engine (in-scope; see § Redirect engine)
        decide.ts               URL match → variation → target URL
        execute.ts              location.replace timing, query-param preservation, loop guard
        spa.ts                  SPA route-change redirect path
        cross-domain.ts         visitor_id stitching across origins via _tu= param
      cross_domain.ts           cross-domain link tagging (legacy)
  legacy.ts                     window.crbData, window.apiUrl, window.testa_env;
                                window.Analytica.* surface; fires /api/leads + /api/leads/convert (Phase 3.8)
```

## Edge worker

The worker has three responsibilities:

### 1. Serve the pixel from KV

```
GET /projects/:slug.js
  → KV.get('project_config:{slug}')   // experiments + rules + variations + goals
  → KV.get('integration_bundle:{integration_version}')   // loader.min.js + runtime.min.js
  → return loader inline + runtime <script defer>; inject `window.cfPrefill = {...}`
  → Cache-Control: public, max-age=60, stale-while-revalidate=300
```

### 2. Accept events, set first-party cookies

```
POST /track
  → parse + validate (Zod schema match shared-types EventBatch)
  → enrich (CF-IPCountry, CF-Region, ASN, UA parsed via ua-parser-js)
  → bot filter (verifiedBot, headless markers, viewport=0, ASN reputation list)
  → if bot: drop unless config says preserve
  → if denied consent: rotate visitor_id daily (SHA-256 of salt+ua), truncate IP (drop last octet)
  → write to BatchBuffer DurableObject
  → respond Set-Cookie _testa_uuid; Domain=.{customer-domain or fallback}; Max-Age=2y
  → 204
```

### 3. Batch buffer (DurableObject) + forward

```
BatchBuffer.add(event)
  → append to in-memory list
  → set alarm for now+500ms IF not already set
  → if list.length >= 50: flush immediately

BatchBuffer.flush()
  → HMAC-SHA256(events + signed_at) using INGEST_SHARED_SECRET
  → POST to INGEST_ORIGIN_URL/_ingest with X-Edge-Signature header
  → on 5xx: retry with exp backoff up to 3 times
  → on 4xx: log + drop (poison pill)
```

## First-party cookies (ITP / Firefox ETP defeat)

The 7-day Safari ITP cap on `document.cookie` only applies to JS-set cookies. To keep `_testa_uuid` for 2 years, the worker sets it via `Set-Cookie` header **from a first-party context** — meaning the worker must be served from a host that's same-eTLD+1 with the customer's site.

Two modes:

- **Shared domain (default).** `track.testa.com` for everyone. Cookies are third-party from the customer's perspective. Worse than nothing on Safari but works elsewhere.
- **CNAME (opt-in).** Customer adds DNS `track.{customer-domain} → testa-edge.workers.dev`. Worker recognizes the host pattern and sets `Domain=.{customer-domain}`. Cookie is first-party. Survives ITP.

The worker reads the `Host` header and decides which mode based on whether it matches a known customer's `tracking_domain` setting. Customer's `tracking_domain` is published to KV from crobot's `ProjectConfigObserver`.

## Bot filtering — which signals

Free signals only (Cloudflare Bot Management is paid; out of scope):

| Signal | Source | Action |
|---|---|---|
| `cf.botManagement.verifiedBot` | CF (free, basic) | Drop unconditionally |
| Headless markers (`HeadlessChrome`, `PhantomJS`, etc. in UA) | UA string | Drop |
| `accept-language: ` empty / missing | Request header | Mark suspicious |
| `viewport=0` or absurd | Pixel-emitted prop | Mark suspicious |
| ASN reputation (a small static list of known DC ASNs) | `cf.asn` | Mark suspicious |

`is_bot=1` events still land in CH (so dashboards can opt to include them). They're just flagged.

## Consent flow

```
state defaults to 'granted'
  ↓
customer's CMP fires CustomEvent('cmp:consent-changed', { detail: 'denied' })
  ↓
runtime.consent.denied()
  ├─ stop persisting _testa_uuid (cookie marked Max-Age=0)
  ├─ next /track call sends consent_state: 'denied'
  └─ worker rotates visitor_id daily and truncates IP
```

The customer is the data controller. We are the processor (per DPA). We honour their CMP signals; they take responsibility for collecting consent in line with their jurisdiction.

## SPA navigation handling

Single-page apps (Next.js, React Router, Vue Router, plain pushState) need URL re-evaluation without a full pageload. The pixel:

1. **Monkey-patches `history.pushState` and `history.replaceState`** at the earliest possible moment in the loader. The patch is idempotent (`window._testa_patched_v4` guard), reentrant-safe, and dispatches a `_testa:locationchange` CustomEvent **as a microtask** after the original call returns — so the framework's router has updated state before we look at the URL.
2. **Listens for `popstate` and `hashchange`** as additional navigation signals.
3. **Re-installs the patch on `pageshow`** to survive bfcache restores.
4. **Debounces** location-change handling (50 ms) to coalesce React 18 transitions and Next.js double-dispatch (`replaceState` then `pushState` on the same navigation).
5. **Compares canonical URLs** (sorted query keys, strip `_testa_*` params) — same-URL `pushState` (state-only updates) does not re-fire pageviews or re-evaluate experiments.
6. **Public `_testa.navigate(url)` API** for customers who need explicit control or whose framework defeats monkey-patching.
7. On meaningful URL transition: re-fire `page_view`, re-evaluate audience conditions + URL rules, re-fire `experiment_view` if matched experiment changed.

Hash-only changes are a per-project setting (default off — most customers don't want anchor jumps to count as pageviews).

## Redirect engine (split-URL experiments)

The pixel's redirect engine is held to **VWO/ABTasty parity-or-better**. Specifics:

- **Pre-DOM-render redirect path.** When the loader sees a redirect-type variation match the current URL and a cached `_testa_exp` assignment exists, fire `location.replace(target)` synchronously — before the customer's body parses, before any framework hydrates.
- **Loop guard.** A session-scoped `_testa_redirected_in_session` set keyed by `experiment_id` prevents ping-pong when the destination URL also matches a rule.
- **Query parameter + hash preservation.** The destination URL inherits the source's `?utm_*` and any custom params unless explicitly overridden. Anchor (`#fragment`) preserved.
- **`location.replace()`, not `location.href = ...`.** No back-button reentry into the redirect.
- **POST-back guard.** Skip redirects when `document.referrer` matches the experiment's source page within the configured cooldown — prevents form-submission redirect kills.
- **Cross-domain visitor stitching.** When destination is a different eTLD+1, append `?_tu=<short-encoded-visitor-id>` and the destination-side worker honors it on landing, then `history.replaceState` strips it from the address bar.
- **SPA-aware redirect path.** Inside SPAs, redirect uses `history.replaceState` for same-origin same-app routes (preserving the SPA), `location.replace` only when crossing app boundaries.
- **Next.js race-condition fix.** Redirect decisions are computed in a microtask *after* the framework's router has reconciled, never during hydration. Documented breadcrumb log streams every redirect decision + observed landing URL for forensic analysis.

A repro test harness lives in `apps/pixel/test/spa-fixtures/` covering Next 12/13/14, react-router-dom 6, and plain JS — every redirect destination is asserted against query-param fidelity.

## Event delivery — durability

Tracking reliability is a competitive bar; silent event loss is unacceptable.

```
pixel emits event
  ↓
write to IndexedDB outbox (FIFO, bounded ~500 events × ~1 KB = ~500 KB)
  ↓
schedule flush (every 500 ms or every 10 events, whichever first)
  ↓ on flush:
  fetch keepalive POST /track  (lets us see response codes, retry on 5xx)
  ↓
  on 2xx → mark sent, prune from IDB
  on 5xx → leave in IDB; backoff 200 ms → 30 s exp + jitter
  on 4xx → log + drop (poison)

on pagehide / visibilitychange:hidden
  → force-flush via sendBeacon as fallback (fire-and-forget)

on next page load
  → drain leftover IDB entries before sending fresh ones
```

- **`event_id` is UUIDv7** generated client-side, persisted in IDB. Same event retried any number of times → same UUID. Dedup happens at the queue (deterministic Redis stream IDs) so the same UUID never lands in CH twice. See `docs/architecture/02-collector.md` § Idempotency.
- **`_pixel_health`** synthetic event emitted ~hourly per visitor with: queued count, sent count, retried count, dropped count, oldest IDB age. Drop rate per project is dashboarded; alert when any project breaks 0.5%.
- **Late arrivals** land in CH at their original `ts` (so partition-by-month is correct). Materialized views are **best-effort** for the first 24 hours after the event time; documented behavior, not a bug.
- **Fallback to `localStorage`** when IndexedDB is unavailable (Safari Private Mode pre-2022, exotic environments). Same FIFO semantics with a much smaller capacity.

## See also

- `docs/architecture/04-cookies-and-consent.md` — full first-party cookie / consent details
- `docs/reference/event-shape.md` — exact wire format for `/track`
- `docs/reference/audience-schema.md` — `AudienceCondition` for targeting
- `docs/reference/hmac-protocol.md` — HMAC + replay window spec
- `docs/reference/legacy-pixel-mapping.md` — how each 3.6 behavior maps into 4.0 modules
