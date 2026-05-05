# Architecture — Overview

## What this is

A new analytics pipeline for Testa's experimentation platform. Replaces a single hand-edited `script.js` (1300+ lines, currently in crobot at `resources/js/integration/3.6/script.js`) with three cleanly separated TypeScript components, plus a self-hosted ClickHouse warehouse.

## What lives where

```
testa-platform/                   THIS REPO
├── apps/
│   ├── pixel/                    Client SDK (loader + runtime). Drop-in replacement
│   │                             for 3.6/script.js. Experiment engine + tracking.
│   ├── edge/                     Cloudflare Worker. Serves the pixel from KV.
│   │                             Accepts /track. Sets first-party cookies.
│   │                             Forwards events to collector via HMAC-signed batches.
│   └── collector/                Bun + Hono. /_ingest (write) + Redis-stream consumer
│                                 + /api/v1/metrics/* (read). Owns ClickHouse access.
└── packages/
    └── shared-types/             TS interfaces shared across the three apps.

crobot/                            EXISTING repo, touched MINIMALLY
├── app/Domain/Analytics/          NEW subdomain
│   ├── Services/
│   │   ├── CollectorClient.php    HTTP client for collector's read API
│   │   └── CloudflareKvService.php Publishes config to CF KV
│   ├── Jobs/PublishProjectConfigToKV.php
│   └── Observers/ProjectConfigObserver.php
├── app/Http/Controllers/API/Analytics/MetricsProxyController.php
└── resources/js/pages/experiment-results/{RevenueMetrics,EngagementMetrics,FunnelChart}.vue
```

## Data flow — write

```
Browser (pixel)
  │
  │  POST /track  (sendBeacon / fetch keepalive, batched)
  ▼
CF Worker (apps/edge)
  │  - validate
  │  - enrich (geo, ASN, UA-derived)
  │  - bot-filter (free CF signals + heuristics)
  │  - set first-party Set-Cookie on response
  │  - DurableObject batches ≤500 ms / ≤50 events
  │
  │  POST /_ingest  (HMAC X-Edge-Signature, JSON batch)
  ▼
Collector HTTP (apps/collector)
  │  - verify HMAC + ±5 min replay window
  │  - Zod schema validate
  │  - XADD events * payload  (per event)
  ▼
Redis Stream `events`
  ▼
Collector Consumer (apps/collector — separate Bun process)
  │  - XREADGROUP collector-writers
  │  - batch ≤1000 events / ≤5 s
  │  - INSERT INTO events_buffer
  ▼
ClickHouse (events_buffer flushes to events; materialized views update)
```

## Data flow — read

```
Crobot Vue (RevenueMetrics.vue)
  │
  │  GET /api/experiments/{id}/metrics/aov?currency=USD
  ▼
Crobot Laravel (MetricsProxyController)
  │  - existing user auth + permission middleware
  │  - cache 60s in Redis
  │
  │  GET /api/v1/metrics/aov?experiment_id=42&report_currency=USD
  │       X-Service-Token: <shared>
  ▼
Collector Read API (apps/collector)
  │  SELECT (uses materialized views + fx_rates dictionary)
  ▼
ClickHouse
  │
  ▼
JSON {variations: [{id, aov, ci_low, ci_high, sample_size}]}
```

## Data flow — config publish

```
Admin edits Experiment / Variation / Goal in Filament
  │
  ▼
Eloquent saved event → ProjectConfigObserver
  │
  ▼
PublishProjectConfigToKV job
  │  - build JSON config (experiments + rules + variations + goals + integration_version)
  │  - PUT to CF KV via API
  ▼
CF KV namespace: project_config
  │
  ▼ (cached at edge, ~10s global propagation)
Worker reads on next /projects/{slug}.js request
```

## Stack

| Component | Stack |
|---|---|
| Pixel | TypeScript, esbuild, Vitest (happy-dom), Playwright |
| Edge worker | TypeScript, Cloudflare Workers, Hono, Durable Objects, KV, miniflare for tests |
| Collector | Bun, Hono, `@clickhouse/client`, `ioredis`, `zod`, `bun:test` |
| Shared types | TypeScript (type-only) |
| Storage | ClickHouse 24.x (single node, ZK-less, MergeTree + Buffer + materialized views, 13-month TTL) |
| Queue | Redis Stream `events` |
| Lint/format | Biome 1.9 |

## Key constraints

- **Drop-in compatibility.** The pixel must replace 3.6/script.js without customers changing their HTML. Same `<script src="...">` URL pattern, same `window.crbData`/`window.apiUrl`/`window.testa_env` globals, same legacy `/api/leads` + `/api/leads/convert` calls. New behavior is purely additive.
- **1:1 port of 3.6.** Bug-for-bug identical experiment runtime. Known issues with redirects and copy-tests are intentionally preserved; fixes ship as separate post-pilot tracked follow-ups.
- **Crobot stays unchanged on the hot path.** No ClickHouse client in crobot. No Redis Stream code in crobot. Existing `app/Domain/Experimentation/` is read-only for v1.
- **Privacy.** Default consent = `granted` (matches GA4). On `consent('denied')`: visitor_id rotates daily (hashed), IP truncated at the worker. 13-month raw retention.
- **No paid CF Bot Management.** Free signals + custom heuristics from `crobot/docs/bot-detection-plan.md`.

## Out of scope

See `docs/architecture/05-rollout.md` for the full out-of-scope list. Highlights: edge variation assignment (v2), CH replication/HA, customer-configurable retention, generic web-analytics surface.
