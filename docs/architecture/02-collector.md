# Architecture — Collector

The **collector** is a Bun + Hono service that:

1. Accepts HMAC-signed batches of events from the edge worker (`POST /_ingest`).
2. Pushes each event onto a Redis Stream (`events`).
3. A separate Bun process drains the stream and INSERTs into ClickHouse.
4. Exposes a small read API (`GET /api/v1/metrics/*`) that returns pre-aggregated metric summaries to crobot.

The collector is the **only service that talks to ClickHouse**. Crobot does NOT have a CH client.

## Two processes from one source

```
apps/collector/
├── src/
│   ├── index.ts            HTTP server entry (Hono)
│   ├── consumer/main.ts    Consumer process entry (no HTTP server)
│   ├── config.ts           Zod-validated env
│   ├── ingest/             POST /_ingest implementation (Phase 1.4)
│   ├── consumer/           XREADGROUP loop, batch INSERT (Phase 1.5)
│   ├── metrics/            GET /api/v1/metrics/* (Phase 4)
│   ├── fx/                 Frankfurter sync, /_internal/fx-rates (Phase 1.6)
│   ├── db/                 ClickHouse client + migrations (Phase 1.1-1.3)
│   └── auth/               HMAC verify + service token verify
```

Run as two separate Bun processes (Docker containers / systemd units in production):

```sh
bun run dev:server      # or production: bun src/index.ts
bun run dev:consumer    # or production: bun src/consumer/main.ts
```

This split means write throughput (server) and CH write rate (consumer) scale independently.

## /_ingest write path

```
POST /_ingest
Headers:
  Content-Type: application/json
  X-Edge-Signature: <hex-encoded HMAC-SHA256 of `${signed_at}.${body}` using INGEST_SHARED_SECRET>

Body (matches IngestBatch from shared-types):
{
  "signed_at": 1730902400123,
  "events": [
    { "event_id": "uuid", "event_name": "page_view", ... },
    ...
  ]
}

Response: 204 on success, 401 on bad signature, 400 on schema/replay-window failure
```

Handler:

```ts
1. Parse `signed_at` from body. Reject if |now - signed_at| > INGEST_REPLAY_WINDOW.
2. Compute HMAC-SHA256(`${signed_at}.${rawBody}`, INGEST_SHARED_SECRET).
   Compare via timing-safe equal to X-Edge-Signature. Reject 401 on mismatch.
3. Zod-validate body.events against IngestBatch.events schema. Reject 400 on fail.
4. For each event:
     if event.event_name in INGEST_DEDUP_EVENT_NAMES:
       SET event:seen:<event_id> 1 EX 600 NX
       if reply == nil: skip (duplicate)
     XADD events * <payload>
5. Return 204.
```

## Idempotency

Pixel-side IDB outbox means a given `event_id` (UUIDv7, generated at the pixel) may be POSTed multiple times: edge retries on 5xx, the entire batch retries when the pixel hasn't seen a success yet, etc. Without dedup, duplicates would inflate `sum()` and `count()` aggregates: total revenue, orders count, page views count, RPV all over-stated. AOV is robust by construction (proportional cancellation in numerator and denominator) but RPV and absolute revenue are not.

The dedup mechanism is **Redis `SET ... NX EX 600` before `XADD`**, applied only to event names in a configurable allow-list (`INGEST_DEDUP_EVENT_NAMES`, default `['purchase']`):

```
on /_ingest, for each event:
  if event.event_name in DEDUP_EVENT_NAMES:
    SET event:seen:<event_id> 1 EX 600 NX
    if reply == nil:
      skip (duplicate; do NOT XADD)
      log _pixel_health late-arrival counter
  XADD events * payload   -- always for events that pass the dedup check
```

Why this design:

- **`SETNX` semantics fit perfectly**: only the first observer of an `event_id` gets a successful reply; retries fail loudly and are skipped.
- **Allow-list, not all-events**: Most event types are immune to duplication anyway (sessions, visitor counts use `uniqExact`). Only `purchase` events directly inflate `sum(value_native)` and `count()` in the aggregates customers reconcile against external systems. Other event types can be opted-in later by extending the env var (e.g. `purchase,email_submit`).
- **10-min TTL** comfortably covers the 5-min HMAC replay window and gives slack for IDB outbox flushes that spent extra time on a slow network.
- **Pipelined**: `(SET, XADD)` for each event in one Redis pipeline — single round trip per batch.
- **Memory cost**: at 250 ev/s × ~10% purchase mix × 600 s ≈ 15k keys ≈ ~1 MB. Negligible.

CH `events` table stays a plain `MergeTree`. No `ReplacingMergeTree`, no `FINAL`, no schema disruption. Dedup is entirely upstream.

> **Why not deterministic stream entry IDs (`XADD events <event_id>-...`)?** Earlier drafts of this doc proposed that. It doesn't work: Redis Streams require strictly monotonically increasing IDs *across the entire stream*, so you can't reliably encode a per-event-id dedup key into the stream entry ID. Out-of-order producers would fail. `SETNX`-before-`XADD` is the standard Redis dedup pattern.

Throughput target at peak: **250 batched req/s** (assuming ~100 events/batch). Each request does N XADDs (N up to 100). Bun + ioredis comfortably exceeds this.

## Consumer

Long-running Bun process. Single instance for v1 (Redis Streams support consumer groups, so we can scale horizontally later).

```
loop forever:
  results = await redis.xreadgroup(
    'GROUP', 'collector-writers', consumerName,
    'COUNT', batchSize,                                    // 1000
    'BLOCK', flushIntervalMs,                              // 5000
    'STREAMS', 'events', '>'
  );

  if (results) {
    rows = results.flatMap(parseEvent);                    // [event_id, ts, ...]
    await ch.insert({ table: 'events_buffer', values: rows, format: 'JSONEachRow' });
    await redis.xack('events', 'collector-writers', ...messageIds);
  }

  // pending recovery: every 60s, claim & retry messages stuck for >30s
```

On CH 5xx: don't XACK. Sleep with exponential backoff. Re-read with `0` instead of `>` to retry the same batch.

On CH 4xx (schema mismatch): log + XACK to drop the batch. Investigate offline.

Graceful shutdown: on SIGTERM, finish current batch, XACK, then exit.

## Read API (Phase 4)

```
GET /api/v1/metrics/aov?experiment_id=42&from=2026-04-01&to=2026-05-01&report_currency=USD
Headers:
  X-Service-Token: <SERVICE_TOKEN env>

Response (matches AovSummary from shared-types):
{
  "experiment_id": 42,
  "report_currency": "USD",
  "from": "2026-04-01",
  "to": "2026-05-01",
  "variations": [
    { "variation_id": 100, "aov": 49.99, "ci_low": 47.10, "ci_high": 52.88,
      "sample_size": 1234, "total_revenue": 61687.66, "orders": 1234 }
  ],
  "significance": [
    { "reference_variation_id": 100, "compared_variation_id": 101,
      "delta": 4.21, "delta_relative": 0.084, "p_value": 0.024, "is_significant": true }
  ]
}
```

Uses materialized view `mv_aov_daily` + `fx_rates` dictionary for currency conversion. Welch's t-test for significance (RPV uses bootstrap CIs).

The collector does not enforce per-experiment authorization — it only checks that `X-Service-Token` matches. Crobot's `MetricsProxyController` enforces user-level permissions before proxying.

## ClickHouse interaction

- HTTP interface (`@clickhouse/client`), not native TCP. Simpler, fine for our throughput.
- Inserts go to `events_buffer` (a `Buffer`-engine table that flushes to `events` automatically). Smooths microbursts and reduces small-part count.
- Migrations are versioned SQL files in `db/migrations/`, applied by `bun run migrate`. Track applied migrations in `_migrations` table on CH itself.

## See also

- `docs/architecture/03-data-model.md` — full CH schema
- `docs/reference/clickhouse-schema.md` — DDL
- `docs/reference/api-endpoints.md` — endpoint specs (request/response)
- `docs/reference/hmac-protocol.md` — HMAC details
