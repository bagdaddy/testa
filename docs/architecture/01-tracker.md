# Architecture — Tracker (pixel + edge worker)

The tracker is the **client-side SDK system**: TS pixel runtime + Cloudflare Worker augmentation. Together they replace today's `crobot/resources/js/integration/3.6/script.js`.

## Two-piece pixel: loader + runtime

The customer embeds **one** script tag pointing at our edge:

```html
<script src="https://track.{customer}.com/projects/{project_slug}.js"></script>
```

The edge worker responds with a **single combined bundle** consisting of:

1. **Loader stub** (~5 KB minified, sync). Creates `window._testa` with a queue. Customer code can call `_testa.track(...)`, `_testa.consent(...)` immediately, even before the runtime has finished loading. The loader queues the calls.
2. **Runtime** (~30 KB minified, executes after loader). Hydrates the queue, applies experiments, starts emitting tracking events.

The loader is appended inline; the runtime is appended via `<script defer>` with a content-hashed URL so it can be edge-cached aggressively.

## Public JS API

```ts
// Synchronous (queued before runtime loads)
window._testa.track(event_name: string, props?: Record<string, unknown>): void;
window._testa.trackPurchase(value: number, currency: string, order_id: string, items?: number): void;
window._testa.consent(state: 'granted' | 'denied' | 'unknown'): void;
window._testa.identify(visitor_id: string): void;  // optional override

// Auto-emitted by runtime
//   page_view        on every page load
//   session_start    when _testa_ses cookie is created or refreshed after expiry
//   experiment_view  when a variation is applied
//   purchase         only fires on explicit trackPurchase
```

## Runtime modules

```
src/loader.ts                   sync stub (Phase 3.1)
src/runtime/
  index.ts                      hydrate queue, init modules (Phase 3.2)
  cookies.ts                    read/write _testa_uuid, _testa_ses, _testa_exp (Phase 3.3)
  consent.ts                    consent state machine; default granted (Phase 3.4)
  network.ts                    sendBeacon / fetch keepalive batched POST (Phase 3.5)
  events.ts                     public track/trackPurchase API + auto-emit (Phase 3.6)
  experiments/
    rules.ts                    URL match types: exact, contains, not_contains, regex (Phase 3.7)
    traffic.ts                  consistent-hash variation assignment (Phase 3.7)
    apply/
      css.ts                    style injection (Phase 3.7)
      html.ts                   DOM swaps (Phase 3.7)
      text.ts                   copy/text replacement [1:1 port — bugs preserved] (Phase 3.7)
      js.ts                     custom JS injection (Phase 3.7)
      attribute.ts              element attribute set (Phase 3.7)
      redirect.ts               split URL redirect [1:1 port — bugs preserved] (Phase 3.7)
      cross_domain.ts           cross-domain link tagging (Phase 3.7)
  legacy.ts                     window.crbData, window.apiUrl, window.testa_env;
                                fires legacy /api/leads + /api/leads/convert (Phase 3.8)
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

## See also

- `docs/architecture/04-cookies-and-consent.md` — full first-party cookie / consent details
- `docs/reference/event-shape.md` — exact wire format for `/track`
- `docs/reference/hmac-protocol.md` — HMAC + replay window spec
- `docs/reference/legacy-pixel-mapping.md` — how each 3.6 behavior maps into 4.0 modules
