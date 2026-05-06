# Architecture — System diagram

Visual reference for the testa-platform system after all 2026-05-06 grilling decisions. Mermaid renders natively on GitHub; an ASCII fallback for the system overview is provided up top so the doc is readable in any viewer.

If anything in here drifts from the prose docs (`00-overview.md` … `05-rollout.md`) or the project memory entries, the prose / memory wins — this doc is updated to match, not the reverse.

---

## 1. System overview (ASCII)

```
                       ┌─────────────────────────────────────────────────────────┐
                       │                  CUSTOMER'S SITE                         │
                       │                  (their own origin)                      │
                       │                                                          │
                       │   ┌──────────────┐         ┌──────────────────────┐      │
                       │   │  SmartCode   │ awaits  │  Pixel script        │      │
                       │   │ hides <body> ├────────►│  loader + runtime    │      │
                       │   └──────────────┘ load()  │  (audience, redirect,│      │
                       │                            │   bucketing, apply)  │      │
                       │                            └──────┬───────────────┘      │
                       │                                   │                      │
                       └───────────────────────────────────┼──────────────────────┘
                                                           │
              ┌────────────────────────────────────────────┼──────────────┐
              │                                            │              │
              │  GET /projects/{slug}.js                   │  POST /track │
              │  (serve pixel from KV)                     │  (events)    │
              ▼                                            ▼              │
   ┌───────────────────────────────────────────────────────────────┐      │
   │             CLOUDFLARE — per-customer Worker                  │      │
   │             (testa-edge-{slug}, one per customer)             │      │
   │                                                               │      │
   │   • serve pixel from KV (project_config + bundle)             │      │
   │   • enrich /track (geo, region, city, UA, bot filter)         │      │
   │   • set _testa_uuid Set-Cookie (first-party in CNAME mode)    │      │
   │   • DurableObject batch buffer (50 events / 500ms)            │      │
   │   • HMAC-sign + POST /_ingest                                 │      │
   └────────────────────────────┬──────────────────────────────────┘      │
                                │                                         │
                                │  HMAC-signed batch                      │
                                ▼                                         │
   ┌─────────────────────────────────────────────────────────────────┐    │
   │              testa-platform — SHARED INFRA                      │    │
   │                                                                 │    │
   │   ┌──────────────┐    ┌─────────────┐    ┌──────────────────┐   │    │
   │   │ Collector    │    │   Redis     │    │   Consumer       │   │    │
   │   │ Bun + Hono   ├───►│ events      ├───►│   XREADGROUP →   │   │    │
   │   │ POST /_ingest│    │ stream +    │    │   batch INSERT   │   │    │
   │   │ HMAC verify  │    │ dedup keys  │    │   into events_   │   │    │
   │   │ Zod validate │    │ (SETNX 10m) │    │   buffer         │   │    │
   │   │ SETNX dedup  │    └─────────────┘    └────────┬─────────┘   │    │
   │   │ XADD events  │                                │             │    │
   │   └──────┬───────┘                                ▼             │    │
   │          │                              ┌──────────────────┐    │    │
   │          │                              │   ClickHouse     │    │    │
   │          │  GET /api/v1/metrics/*       │   events (raw)   │    │    │
   │          │  (read API, X-Service-Token) │     │            │    │    │
   │          └──────────────────────────────┤     ▼            │    │    │
   │                                         │   5 MVs          │    │    │
   │                                         │   + fx_rates dict│    │    │
   │                                         └────────▲─────────┘    │    │
   │                                                  │              │    │
   └──────────────────────────────────────────────────┼──────────────┘    │
                                                      │                   │
                                       ┌──────────────┴───────────────┐   │
                                       │                              │   │
   ┌───────────────────────────────────┼──────────────────────────────┼───┼──┐
   │                  CROBOT (existing PHP / Laravel)                 │   │  │
   │                                                                  │   │  │
   │  ┌──────────────┐   ┌──────────────────────┐   ┌──────────────┐  │   │  │
   │  │ testa-admin  │──►│ ProjectConfigObserver│──►│ CF KV PUT    │──┼─► (KV)
   │  │ (Filament)   │   │ + Publish job        │   │              │  │   │  │
   │  │   audience,  │   └──────────────────────┘   └──────────────┘  │   │  │
   │  │   freq cap,  │                                                 │   │  │
   │  │   mutex,     │   ┌──────────────────────┐   ┌──────────────┐  │   │  │
   │  │   variations │──►│ ProvisionEdgeWorker  │──►│ wrangler     │──┼───┘  │
   │  └──────┬───────┘   │ (per-customer deploy)│   │  deploy      │  │ (worker)
   │         │           └──────────────────────┘   └──────────────┘  │      │
   │         │                                                         │      │
   │         │           ┌──────────────────────┐                      │      │
   │         │           │ MetricsProxyController├─────────────────────┼──────┘
   │         │           │ /api/experiments/*/   │  (proxy + 60s cache)│
   │         │           │   metrics/*           │
   │         │           └──────┬───────────────┘
   │         ▼                  │
   │   ┌──────────┐              │
   │   │  MySQL   │◄─────────────┘ Vue dashboards
   │   │  (leads, │  (RevenueMetrics.vue, EngagementMetrics.vue, FunnelChart.vue)
   │   │   goals) │
   │   └──────────┘
   │   ▲                                                              │
   │   │ legacy /api/leads, /api/leads/convert, /api/pixel            │
   └───┼──────────────────────────────────────────────────────────────┘
       │
       └── customer's site posts here directly (drop-in compat with 3.6)
```

**Key invariants:**

- Every customer gets their own CF Worker (`testa-edge-{slug}`). Crobot's `ProvisionEdgeWorker` deploys it at signup. No technical rate limiting; crobot's monthly lead quota is the only cap.
- The pixel decides everything — URL match, audience, variation, redirect target. The edge worker is a thin gateway: serve, enrich, batch, HMAC, forward.
- Only the collector talks to ClickHouse. Crobot reads metrics through `MetricsProxyController` → collector read API.
- Customer's site keeps hitting `/api/leads` etc. exactly as today; CH events accumulate alongside, MySQL stays the source of truth for legacy dashboards through the cutover.

---

## 1b. System overview (Mermaid)

Same shape as the ASCII above, just rendered if your viewer supports Mermaid.

```mermaid
flowchart LR
  PIXEL[Pixel] --> EDGE[Edge worker<br/>per-customer]
  SC[SmartCode] -.->|awaits _testa.load| PIXEL
  EDGE --> KV[(KV)]
  EDGE -->|HMAC batch| COL[Collector /_ingest]
  COL -->|SETNX + XADD| RD[(Redis stream)]
  RD --> CN[Consumer]
  CN --> CH[(ClickHouse)]
  ADMIN[testa-admin] --> OBS[Publish job]
  OBS -->|PUT| KV
  ADMIN --> PROV[ProvisionEdgeWorker]
  PROV -.->|wrangler deploy| EDGE
  VUE[Vue dashboards] --> PROXY[MetricsProxy]
  PROXY -->|X-Service-Token| COL
  COL -.->|reads| CH
  PIXEL -.->|legacy /api/leads| MYSQL[(crobot MySQL)]
```

**Key invariants** baked into this diagram:

- **Per-customer Edge Worker.** Every customer gets their own CF Worker (`testa-edge-{slug}`) provisioned at signup. Customer traffic spikes scale their worker only. No technical rate limiting; crobot's monthly lead quota is the cap.
- **Pixel is the system of record for experiment decisions.** URL match, audience targeting, variation selection, and redirect target all run in the pixel — not the edge. Edge is a thin gateway.
- **Collector is the only service that talks to ClickHouse.** crobot does NOT have a CH client; it goes through `MetricsProxyController` → collector's read API.
- **Customer's site keeps hitting the legacy `/api/leads` etc.** crobot routes those to MySQL exactly as today; nothing changes for existing dashboards while CH builds up history alongside.

---

## 2. Write path — events flowing browser → CH

```mermaid
sequenceDiagram
  autonumber
  participant U as User's browser
  participant SC as Customer SmartCode
  participant PR as Pixel runtime
  participant IDB as IndexedDB outbox
  participant EW as Edge worker (per-customer)
  participant DO as BatchBuffer DO
  participant CO as Collector HTTP
  participant RD as Redis (stream + dedup keys)
  participant CN as Consumer process
  participant CH as ClickHouse

  Note over U,SC: SmartCode hides &lt;body&gt;
  U->>EW: GET /projects/{slug}.js
  EW->>EW: KV.get('project_config:{slug}')<br/>KV.get('integration_bundle:4.0:loader')<br/>KV.get('integration_bundle:4.0:runtime')
  EW-->>U: loader inline + runtime &lt;script defer&gt;<br/>+ window.cfPrefill
  U->>PR: loader runs (sync), patches history, queues
  U->>PR: runtime hydrates, evaluates audience+experiments
  PR-->>SC: _testa.load() resolves
  SC->>U: un-hide &lt;body&gt;

  loop on each tracked event
    PR->>PR: build PixelEvent (UUIDv7, viewport, utm, ts)
    PR->>IDB: outbox.enqueue(event)
    PR->>EW: POST /track (fetch keepalive, batched)
    EW->>EW: enrich (CF-IPCountry, region, city)<br/>parse UA<br/>bot filter
    EW->>DO: forward to per-host BatchBuffer
    DO->>DO: buffer, alarm at +500ms or flush at 50
    DO->>CO: POST /_ingest (HMAC-signed batch)
    CO->>CO: verify HMAC + ±5min replay window<br/>Zod-validate
    Note over CO,RD: For events in DEDUP_EVENT_NAMES (default ['purchase']):
    CO->>RD: SET event:seen:{event_id} 1 EX 600 NX
    alt SET succeeds (first time)
      CO->>RD: XADD events * payload
    else SET returns nil (duplicate)
      CO->>CO: skip (no XADD)<br/>log _pixel_health late counter
    end
    CO-->>DO: 204
    DO-->>PR: (via 204 to /track)
    PR->>IDB: outbox.markSent(event_id)
  end

  loop consumer drain
    CN->>RD: XREADGROUP collector-writers > BLOCK 5s COUNT 1000
    RD-->>CN: batch of events
    CN->>CH: INSERT INTO events_buffer (JSONEachRow)
    CH->>CH: Buffer engine flushes to events<br/>materialized views update
    CN->>RD: XACK events
  end
```

**Behaviors not visible in the sequence above** (but covered by it):

- On 5xx from `EW → CO`: BatchBuffer retains events, retries with exp backoff (500 ms → 8 s).
- On `pagehide` / `visibilitychange:hidden`: pixel force-flushes IDB via `sendBeacon` fallback.
- On next pageload: pixel drains leftover IDB entries before sending fresh ones — covers tab-close mid-batch.
- Same `event_id` retried any number of times → dedup via SETNX → only one CH row.

---

## 3. Read path — dashboard query → CH MVs

```mermaid
sequenceDiagram
  autonumber
  participant V as Vue component<br/>(RevenueMetrics.vue)
  participant L as crobot Laravel<br/>MetricsProxyController
  participant C as Collector read API<br/>GET /api/v1/metrics/*
  participant CH as ClickHouse

  V->>L: GET /api/experiments/{id}/metrics/aov?currency=USD
  L->>L: existing user auth + permission middleware<br/>cache 60s in Redis
  alt cache miss
    L->>C: GET /api/v1/metrics/aov?experiment_id=42&report_currency=USD<br/>X-Service-Token: ...
    C->>CH: SELECT FROM mv_aov_daily JOIN fx_rates dict<br/>WHERE project_id=? AND experiment_id=?
    CH-->>C: rows
    C->>C: Welch's t-test for significance<br/>(RPV uses bootstrap CIs)
    C-->>L: AovSummary JSON
    L->>L: cache 60s
  else cache hit
    L-->>L: served from Redis
  end
  L-->>V: { variations: [{ id, aov, ci_low, ci_high, p_value, ... }] }
```

---

## 4. Config publish — admin save → CF KV → edge

```mermaid
sequenceDiagram
  autonumber
  participant A as Admin user
  participant TA as testa-admin<br/>(Filament ProjectResource)
  participant E as Eloquent saved event
  participant O as ProjectConfigObserver
  participant J as PublishProjectConfigToKV<br/>(Horizon job)
  participant CF as Cloudflare KV API
  participant KV as KV: project_config:{slug}
  participant EW as Edge worker

  A->>TA: Save Experiment 17<br/>(audience, freq_cap, mutex_group, variations, goals)
  TA->>E: Eloquent saved event fires
  E->>O: ProjectConfigObserver.saved()
  O->>J: dispatch PublishProjectConfigToKV(project_id=42)
  J->>J: eager-load project + experiments<br/>+ variations + goals + rules<br/>build JSON, compute config_hash
  J->>CF: PUT /accounts/{id}/storage/kv/<br/>namespaces/{ns}/values/project_config:abc
  CF->>KV: write
  Note over CF,EW: ~10s global propagation
  EW->>KV: KV.get('project_config:abc')<br/>(on next /projects/{slug}.js request)
  EW-->>A: customer's site picks up new config<br/>on next pixel cache-bust (config_hash changed)
```

---

## 5. Per-customer worker provisioning

```mermaid
flowchart LR
  SIGN[Customer<br/>signup] --> PROV[ProvisionEdgeWorker job<br/>in crobot]
  PROV -->|"reads"| TPL[wrangler.toml.template<br/>+ apps/edge/dist/]
  PROV -->|"CF API"| DEPLOY[wrangler deploy<br/>testa-edge-{slug}]
  DEPLOY --> WORKER[Per-customer Worker<br/>track.{slug}.testa.com<br/>or CNAMEd track.{customer-domain}]
  CODE[apps/edge/ code change] --> CI[CI build]
  CI --> FANOUT[Fan-out deploy<br/>to all customer workers<br/>via CF API]
  FANOUT --> WORKER
  WORKER -.->|"forwards POST /_ingest<br/>(HMAC-signed)"| COLLECTOR[Shared collector]
```

**Why per-customer:** failure isolation, billing isolation, no noisy-neighbor at the edge. Shared `track.testa.com` deployment exists as the **fallback** for customers without CNAME / pre-onboarding.

---

## 6. Pixel internals (apps/pixel)

Two parts: a thin sync loader and a deferred runtime.

**ASCII tree of source files:**

```
apps/pixel/src/
├── loader.ts                     sync, ~5KB, inline in HTML response
│   ├── queue.ts                  window._testa stub: track/consent/load/navigate
│   └── monkey-patch.ts           history.pushState/replaceState patch (idempotent)
│
└── runtime/                      defer, ~30-40KB, loaded after loader
    ├── index.ts                  composition root
    ├── lifecycle.ts              hydrate queue, run experiment cycle, fire _testa.load()
    ├── cookies.ts                _testa_uuid/_ses/_exp/_excl/_user/_freq_*/_mutex_*
    ├── consent.ts                state machine + cmp:consent-changed listener
    ├── spa.ts                    consume _testa:locationchange, debounce 50ms,
    │                             canonical URL diff, bfcache re-install
    ├── events.ts                 public track/trackPurchase, auto-emit page_view + experiment_view
    ├── network/
    │   ├── outbox.ts             IndexedDB FIFO outbox (~500 events bound)
    │   ├── transport.ts          fetch keepalive + sendBeacon fallback on pagehide
    │   ├── health.ts             _pixel_health synthetic event (hourly)
    │   └── uuid7.ts              UUIDv7 generator for event_id
    ├── rules/
    │   ├── audience.ts           AudienceCondition tree walker (geo/device/time/page/visitor)
    │   ├── custom-js.ts          sandboxed AST evaluator (no eval, fixed context)
    │   └── legacy.ts             3.3.x/3.6 flat targeting[] compat
    ├── experiments/
    │   ├── traffic.ts            xxhash32 bucketing + frequency_cap + mutex_group guards
    │   ├── apply/                css, html, text, attribute, js
    │   └── redirect/             decide, execute, loop-guard, cross-domain, spa-path
    └── legacy.ts                 window.Analytica.* mirroring + legacy /api/leads
```

**Key flow:** loader monkey-patches history early, runtime hydrates queue, runs the experiment cycle (audience eval → bucketing → apply / redirect), fires `_testa.load()`. SPA route changes re-run the experiment cycle (without re-init). Events go through the outbox always.

**Mermaid (simpler view):**

```mermaid
flowchart LR
  LOADER[loader.ts<br/>queue + history patch] --> RUNTIME[runtime/index.ts]
  RUNTIME --> COOKIES[cookies]
  RUNTIME --> CONSENT[consent]
  RUNTIME --> RULES[rules<br/>audience+customJS]
  RULES --> TRAFFIC[traffic<br/>xxhash32 + freq+mutex]
  TRAFFIC --> APPLY[apply<br/>css/html/text/attr/js]
  TRAFFIC --> REDIRECT[redirect<br/>decide+execute+stitch]
  RUNTIME --> NET[network<br/>outbox+transport+health]
  RUNTIME --> LEG[legacy<br/>Analytica.*]
  RUNTIME -.->|fires once| LOAD[_testa.load resolves]
  PATCH[history patch] -.->|_testa:locationchange| SPA[spa.ts] -.->|re-runs cycle| RUNTIME
```

---

## 7. Audience evaluation tree

```mermaid
flowchart TD
  ROOT["AudienceCondition<br/>(per experiment, optional)"]
  ALL["{ all: [...] }<br/>(AND)"]
  ANY["{ any: [...] }<br/>(OR)"]
  NOT["{ not: ... }"]
  LEAF["AudienceLeaf<br/>(typed by `fact`)"]

  ROOT --> ALL
  ROOT --> ANY
  ROOT --> NOT
  ROOT --> LEAF

  subgraph LEAVES["AudienceLeaf variants (Tier 1 + Tier 2)"]
    PAGE["page.url / queryParam / referrer"]
    VISITOR["visitor.cookie / isReturning /<br/>dataLayer / custom (sandboxed JS)"]
    GEO["geo.country / region"]
    DEVICE["device.type / browser / os /<br/>viewportWidth / language"]
    TIME["time.hourOfDay / dayOfWeek / window<br/>(with tz)"]
    EXPERIMENT["experiment.assignedTo<br/>(another experiment exclusion)"]
  end

  LEAF --> PAGE
  LEAF --> VISITOR
  LEAF --> GEO
  LEAF --> DEVICE
  LEAF --> TIME
  LEAF --> EXPERIMENT
```

Implemented in `apps/pixel/src/rules/audience.ts` (Phase 3.7) with exhaustive `switch (leaf.fact)` so adding a dimension forces a TS compile error in the evaluator until handled.

---

## 8. Redirect engine

```mermaid
flowchart TD
  START["URL match for experiment<br/>+ visitor's cached/fresh assignment"]
  POSTBACK{"POST-back guard:<br/>document.referrer matches<br/>source URL within cooldown?"}
  LOOP{"Loop guard:<br/>session already redirected<br/>for this experiment?"}
  COMPUTE["Compute target URL:<br/>preserve query params<br/>preserve hash<br/>append _tu= for cross-domain"]
  KIND{"Kind of redirect?"}
  REPLACE["history.replaceState(target)<br/>(SPA same-app same-origin)"]
  LOC["location.replace(target)<br/>(cross-app or cross-origin)"]
  STITCH["Cross-domain landing:<br/>destination worker reads ?_tu=,<br/>sets _testa_uuid cookie,<br/>history.replaceState strips _tu="]
  LOG["Log to __pixel_debug.redirects<br/>(forensic ring buffer)"]

  START --> POSTBACK
  POSTBACK -- "yes" --> SKIP[Skip redirect this view]
  POSTBACK -- "no" --> LOOP
  LOOP -- "yes" --> SKIP
  LOOP -- "no" --> COMPUTE
  COMPUTE --> KIND
  KIND -- "SPA same-app" --> REPLACE
  KIND -- "Cross-app/origin" --> LOC
  REPLACE --> LOG
  LOC --> STITCH
  STITCH --> LOG
```

Implementation in `apps/pixel/src/runtime/experiments/redirect/` (Phase 3.10). Repro harness across Next 12/13/14 + react-router-dom 6 + plain JS in Phase 3.11.

---

## 9. Data model — what lands in CH

```mermaid
flowchart LR
  EVENTS[("events<br/>MergeTree<br/>partition by toYYYYMM(client_ts)<br/>order by (project_id, event_name, client_ts)<br/>13mo TTL")]
  BUFFER[("events_buffer<br/>Buffer engine<br/>(consumer inserts here)")]

  MV1[("mv_aov_daily<br/>SummingMergeTree<br/>(experiment, variation, currency, day)<br/>+ revenue, orders")]
  MV2[("mv_rpv_revenue_daily<br/>SummingMergeTree")]
  MV3[("mv_rpv_visitors_daily<br/>AggregatingMergeTree<br/>uniqExactState(visitor_id)")]
  MV4[("mv_sessions_daily<br/>AggregatingMergeTree<br/>sessions, page_views,<br/>sessions_with_pageview")]
  MV5[("mv_experiment_summary<br/>AggregatingMergeTree<br/>(parity check vs MySQL leads)")]
  FX[("fx_rates<br/>HTTP-source dictionary<br/>(LIFETIME 86400)")]

  BUFFER --> EVENTS
  EVENTS -.->|"on insert"| MV1
  EVENTS -.->|"on insert"| MV2
  EVENTS -.->|"on insert"| MV3
  EVENTS -.->|"on insert"| MV4
  EVENTS -.->|"on insert"| MV5

  Q1["Read API:<br/>SELECT … FROM mv_aov_daily<br/>JOIN dictGet('fx_rates', …)"] -.-> MV1
  Q1 -.-> FX
```

`_pixel_health` events land only in `events` (filtered out of all 5 MVs). Used for drop-rate dashboards.

Schema as of 2026-05-06 includes `client_ts`, `server_ts`, `viewport_w/h`, `tracker_version`, `utm_source/medium/campaign`, `region_subdivision`, `city`. Full DDL in `docs/reference/clickhouse-schema.md`.

---

## 10. What the diagrams omit (intentionally)

- **HMAC details** — see `docs/reference/hmac-protocol.md`.
- **Cookie semantics** — see `docs/architecture/04-cookies-and-consent.md` and `docs/reference/legacy-globals-inventory.md`.
- **Wire format** — see `docs/reference/event-shape.md` and `docs/reference/clickhouse-schema.md`.
- **Audience JSON shape** — see `docs/reference/audience-schema.md`.
- **Pilot rollout / parity check / rollback** — see `docs/architecture/05-rollout.md`.
- **Phase task corpus** (1.x, 2.x, 3.x) — see `tasks/README.md`.

---

## How to update this doc

When any architectural decision changes (or a new memory entry lands in `~/.claude/projects/.../memory/`), update the relevant diagram here. Keep diagram fidelity as a CI checklist item: any prose change in `02-collector.md`, `03-data-model.md`, `05-rollout.md`, etc. that changes a flow direction or component should also touch this file in the same PR.

To preview Mermaid locally: GitHub renders inline. For local: VS Code's Mermaid preview extension or `mermaid-cli` (`mmdc`).
