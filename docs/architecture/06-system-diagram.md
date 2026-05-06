# Architecture — System diagram

Visual reference for the testa-platform system after all 2026-05-06 grilling decisions. Mermaid renders natively on GitHub.

If anything in here drifts from the prose docs (`00-overview.md` … `05-rollout.md`) or the project memory entries, the prose / memory wins — this doc is updated to match, not the reverse.

---

## 1. System overview

```mermaid
flowchart TB
  subgraph CUSTOMER["Customer's site (their own origin)"]
    SC["SmartCode<br/>(sync, hides &lt;body&gt;)"]
    PIXEL["Pixel script<br/>loader + runtime"]
    SC -.->|"awaits _testa.load()"| PIXEL
  end

  subgraph CF["Cloudflare (per-customer worker)"]
    EDGE["Edge worker<br/>testa-edge-{slug}"]
    DO["BatchBuffer<br/>(DurableObject)"]
    KV_PC[("KV: project_config:*")]
    KV_BUNDLE[("KV: integration_bundle:*")]
    EDGE --> DO
    EDGE --> KV_PC
    EDGE --> KV_BUNDLE
  end

  subgraph PLATFORM["testa-platform shared infra"]
    COLLECTOR_HTTP["Collector HTTP<br/>Bun + Hono<br/>POST /_ingest"]
    COLLECTOR_FX["Collector FX sync<br/>(Frankfurter→KV)"]
    REDIS[("Redis<br/>events stream + dedup keys")]
    CONSUMER["Consumer process<br/>XREADGROUP→CH"]
    CH[("ClickHouse<br/>events + 5 MVs + fx_rates dict")]
    COLLECTOR_HTTP --> REDIS
    REDIS --> CONSUMER
    CONSUMER --> CH
    COLLECTOR_FX -.->|"daily pull"| CH
  end

  subgraph CROBOT["crobot (existing PHP / Laravel app)"]
    ADMIN["testa-admin<br/>(Filament ProjectResource)"]
    OBSERVER["ProjectConfigObserver<br/>+ PublishProjectConfigToKV job"]
    PROVISION["ProvisionEdgeWorker job<br/>(per-customer worker deploy)"]
    PROXY["MetricsProxyController<br/>(/api/experiments/*/metrics/*)"]
    LEGACY_API["Legacy /api/leads<br/>/api/leads/convert<br/>/api/pixel"]
    MYSQL[("MySQL<br/>projects, leads, goals")]
    ADMIN --> OBSERVER
    ADMIN --> PROVISION
    ADMIN --> MYSQL
    OBSERVER --> MYSQL
    LEGACY_API --> MYSQL
    PROXY --> MYSQL
  end

  subgraph DASH["Dashboards (Vue inside crobot)"]
    VUE["RevenueMetrics.vue<br/>EngagementMetrics.vue<br/>FunnelChart.vue"]
  end

  CUSTOMER -->|"GET /projects/{slug}.js"| EDGE
  CUSTOMER -->|"POST /track (events)"| EDGE
  CUSTOMER -->|"legacy /api/leads etc."| LEGACY_API
  EDGE -->|"HMAC POST /_ingest"| COLLECTOR_HTTP
  PROVISION -.->|"wrangler deploy"| EDGE
  OBSERVER -->|"PUT KV value"| KV_PC
  VUE --> PROXY
  PROXY -->|"X-Service-Token<br/>GET /api/v1/metrics/*"| COLLECTOR_HTTP
  COLLECTOR_HTTP -.->|"reads MVs + fx_rates"| CH

  classDef customer fill:#e3f2fd,stroke:#1565c0
  classDef cloudflare fill:#fff3e0,stroke:#e65100
  classDef platform fill:#e8f5e9,stroke:#2e7d32
  classDef crobot fill:#f3e5f5,stroke:#6a1b9a
  classDef vue fill:#fce4ec,stroke:#ad1457
  class SC,PIXEL customer
  class EDGE,DO,KV_PC,KV_BUNDLE cloudflare
  class COLLECTOR_HTTP,COLLECTOR_FX,REDIS,CONSUMER,CH platform
  class ADMIN,OBSERVER,PROVISION,PROXY,LEGACY_API,MYSQL crobot
  class VUE vue
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

```mermaid
flowchart TB
  subgraph SYNC["loader.ts (sync, &lt;5KB, inline)"]
    QUEUE["queue stub: window._testa<br/>(track/consent/identify/navigate/load)"]
    PATCH["history.pushState +<br/>replaceState monkey-patch<br/>(idempotent, microtask dispatch)"]
  end

  subgraph DEFER["runtime/index.ts (defer, ~30-40KB)"]
    LIFECYCLE["lifecycle: hydrate queue<br/>fire _testa.load() once ready"]
    COOKIES["cookies.ts<br/>_testa_uuid/_ses/_exp/_excl/_user<br/>+ _testa_freq_*/_testa_mutex_*"]
    CONSENT["consent.ts<br/>state machine"]
    SPA["spa.ts<br/>50ms debounce, canonical URL diff,<br/>bfcache re-install"]
    NETWORK["network/<br/>outbox.ts (IDB FIFO 500)<br/>transport.ts (fetch keepalive)<br/>health.ts (_pixel_health hourly)"]
    EVENTS["events.ts<br/>track, trackPurchase,<br/>auto-emit page_view/exp_view"]
    AUDIENCE["rules/audience.ts<br/>AudienceCondition tree walker<br/>(geo, device, time, page, visitor)"]
    CUSTOMJS["rules/custom-js.ts<br/>sandboxed AST evaluator<br/>(no eval)"]
    LEGACYRULE["rules/legacy.ts<br/>3.3.x/3.6 targeting[] compat"]
    TRAFFIC["experiments/traffic.ts<br/>xxhash32 deterministic bucketing<br/>+ freq_cap + mutex_group guards"]
    APPLY["experiments/apply/<br/>css/html/text/attribute/js"]
    REDIRECT["experiments/redirect/<br/>decide/execute/loop-guard/<br/>cross-domain/spa-path"]
    LEGACY_GLOBAL["legacy.ts<br/>window.Analytica.* mirroring<br/>+ legacy /api/leads calls"]
  end

  QUEUE -.->|"replays into"| EVENTS
  PATCH -.->|"_testa:locationchange"| SPA
  LIFECYCLE --> COOKIES
  LIFECYCLE --> CONSENT
  LIFECYCLE --> NETWORK
  LIFECYCLE --> AUDIENCE
  LIFECYCLE --> TRAFFIC
  LIFECYCLE --> LEGACY_GLOBAL
  AUDIENCE --> CUSTOMJS
  AUDIENCE --> LEGACYRULE
  TRAFFIC --> APPLY
  TRAFFIC --> REDIRECT
  EVENTS --> NETWORK
  REDIRECT -.->|"may dispatch"| SPA
  SPA -.->|"re-runs"| LIFECYCLE
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
