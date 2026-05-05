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
4. For each event: redis.xadd('events', `${ev.event_id}-${ev.ts_ms}`, ...payload).
   Deterministic stream ID — see § Idempotency below. Same event_id retried → same
   stream id → second XADD is a no-op (Redis rejects duplicate IDs).
5. Return 204.
```

## Idempotency

Pixel-side IDB outbox means a given `event_id` (UUIDv7, generated at the pixel) may be POSTed multiple times: edge retries on 5xx, the entire batch retries when the pixel hasn't seen a success yet, etc. Without dedup, duplicates would inflate AOV / RPV / orders — catastrophic for a paid tool.

The dedup happens at the Redis Stream layer using **deterministic stream entry IDs**:

```
XADD events <event_id>-<ts_ms> ...payload
```

Redis Streams require strictly monotonic IDs *within a stream*, but the second arg to `XADD` accepts an explicit `<ms>-<seq>` shape and rejects an ID that's not strictly greater than the previous. We instead use `<event_id_hash>-<seq>` semantics — a 64-bit hash of `event_id` is concatenated with a `ts_ms` suffix to maintain ordering, and the hash collisions (vanishingly rare for UUIDv7) are caught by an explicit `XADD ... NOMKSTREAM` + duplicate detection.

Concretely, the implementation uses the [Redis Streams MINID + custom sequencing pattern](https://redis.io/docs/latest/develop/data-types/streams/) — see the implementation notes in the task file for 1.4. The end result: same `event_id` POSTed N times → only the first reaches the consumer → only one row in ClickHouse per `event_id`.

CH `events` table stays a plain `MergeTree`. No `ReplacingMergeTree`, no `FINAL`, no schema disruption. Dedup is entirely at the queue.

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
