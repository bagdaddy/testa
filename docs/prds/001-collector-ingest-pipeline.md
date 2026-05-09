# PRD 001 — Collector ingest pipeline

**Status:** needs-triage
**Owner:** unassigned
**Date:** 2026-05-09

## Problem Statement

I can fire an event from the demo page and watch the pixel post it to the
edge worker. The edge enriches it, batches it in a Durable Object, and
HMAC-signs a forward to the collector's `POST /_ingest`. But `/_ingest`
returns `501 not implemented` — events end at the DO buffer's retry loop
and never reach durable storage.

This means I can't query my own data. I can't:
- verify that `experiment_view` counts match my expected exposure rates
  (so I can't compute SRM)
- compute conversion rate per variation
- confirm the SRM-fix sendBeacon path actually delivers under network jitter
- show a customer "here's the row your purchase fired" during a debug call
- run any of the dashboards the architecture doc assumes

The pixel half is production-grade, the edge half forwards reliably. The
gap is a thin layer of wiring between the edge HMAC POST and ClickHouse,
plus the schema migrations that bring up the tables documented in
`docs/reference/clickhouse-schema.md`.

## Solution

Make `POST /_ingest` real. After this PRD lands, every event the demo
emits is queryable in ClickHouse within ~1 s of being fired:

```
pixel → edge /track → DO buffer → collector /_ingest
       → Redis Stream `events`
       → consumer XREADGROUP loop
       → events_buffer (ClickHouse Buffer engine)
       → events (MergeTree)
```

A one-shot `pnpm --filter @testa-platform/collector migrate` brings up a
fresh ClickHouse to match the canonical schema doc. `pnpm dev` orchestrates
docker-compose (Redis + ClickHouse) plus the collector server and consumer.

## User Stories

1. As a developer running the demo, I want events I fire to appear in
   ClickHouse within seconds, so that I can verify the full pipeline works
   end-to-end.
2. As an analyst, I want to run `SELECT event_name, count() FROM events
   GROUP BY 1` on freshly-emitted events, so that I can sanity-check
   distribution before trusting downstream metrics.
3. As an operator, I want a one-shot `migrate` command, so that I can
   stand up a fresh ClickHouse without manually copy-pasting SQL from
   the reference doc.
4. As an operator, I want the migration runner to be idempotent
   (running twice on a populated DB is a no-op), so that re-running is
   safe in CI and during deploys.
5. As an operator, I want the migration runner to track applied
   migrations in a `_schema_migrations` table, so that adding a new
   migration only runs the new one.
6. As an SRE, I want every request to `/_ingest` to require a valid
   HMAC-SHA256 signature against `INGEST_SHARED_SECRET`, so that random
   internet traffic can't write events.
7. As an SRE, I want signature verification to use a constant-time
   comparison, so that timing oracles don't leak the secret.
8. As an SRE, I want the signed-at timestamp in the request body to be
   within ±5 minutes of server time, so that captured-and-replayed
   batches are rejected.
9. As an SRE, I want HMAC mismatches to log with enough context
   (request id, signed_at, my time) to triage rotation issues, but
   without leaking the expected signature, so that I can debug without
   creating a new attack surface.
10. As a backend engineer, I want events to be deduplicated by
    `event_id` for `purchase` events with a 10-minute window, so that
    edge-side retries don't double-count revenue.
11. As a backend engineer, I want the dedup gate to be configurable via
    a `DEDUP_EVENT_NAMES` env var (default `"purchase"`,
    comma-separated), so that I can extend it to email submissions or
    other reserved events later without code changes.
12. As a backend engineer, I want the dedup decision to use Redis
    `SET event_id 1 NX EX 600` *before* writing to the stream, so that
    we never write a duplicate even under race conditions.
13. As a backend engineer, I want `/_ingest` to write each accepted
    event to a Redis Stream `events`, so that the consumer can drain at
    its own pace independent of HTTP timing.
14. As a backend engineer, I want the consumer to use `XREADGROUP` with
    a consumer group, so that horizontal consumer scaling works without
    re-processing.
15. As a backend engineer, I want the consumer to batch reads (default
    1000 events or 1 second wait, whichever first), so that ClickHouse
    insert frequency is bounded and amortized.
16. As a backend engineer, I want events to land in `events_buffer`
    (the Buffer engine table), so that ClickHouse handles flush timing
    and we're not micro-managing inserts.
17. As an SRE, I want the consumer to retry on ClickHouse 5xx with
    exponential backoff (500 ms → 30 s) and only ACK after a successful
    insert, so that transient CH outages don't lose data.
18. As an SRE, I want a Redis Streams Pending Entries List (PEL)
    monitoring story: events stuck unprocessed past N minutes are
    visible somewhere, so that I notice consumer crashes.
19. As an analyst, I want every event to carry `server_ts` set by the
    collector when accepted, so that I can debug client-clock skew by
    comparing `client_ts` to `server_ts`.
20. As an analyst, I want the schema in production to match
    `docs/reference/clickhouse-schema.md` exactly, so that the docs
    don't lie.
21. As an operator, I want `/_internal/health` to report Redis and
    ClickHouse connectivity (not just process liveness), so that
    deploy-tools and load balancers can wait for warmup.
22. As an operator, I want `docker compose up` to give me a working
    pipeline, so that I can iterate without deploying.
23. As a developer, I want `pnpm dev` (or `pnpm --filter
    @testa-platform/collector dev`) to run both the HTTP server and
    the consumer, so that I don't manage two terminals.
24. As a developer running the demo against the real pipeline, I want
    the demo's static server to optionally point its `apiUrl` at a
    running edge worker, so that I can see events flow through edge →
    collector → CH from the same demo flow.
25. As a backend engineer, I want unit-testable HMAC verification (pure
    function, no I/O), so that I can run table-driven tests for
    edge cases (truncated sig, future timestamp, replay window) without
    standing up infrastructure.
26. As a backend engineer, I want integration tests against real Redis
    and ClickHouse via docker-compose-managed CI services, so that
    schema drift, query syntax errors, and dedup-gate edge cases are
    caught.

## Implementation Decisions

### Modules

The work decomposes into five deep modules and one thin orchestrator.

**Deep modules (testable in isolation):**

1. **HMAC verifier** — pure function `verify({body, signature, secret,
   now}) -> {valid, reason?}`. Constant-time signature compare. Reads
   `signed_at` from the parsed body and rejects values outside ±5 min
   of `now`. No I/O.
2. **Schema migration runner** — reads `*.sql` files from a directory in
   alphabetical order; for each, checks `_schema_migrations` and applies
   if absent. Pure orchestration over a CH client. Returns the list of
   newly-applied migrations.
3. **Dedup gate** — `gate({eventId, eventName, redis, dedupNames, ttlSec})
   -> {firstSeen: boolean}`. Calls `SET key 1 NX EX ttl` and decides
   based on the OK/null reply. Skips the call entirely for event names
   not in `dedupNames`.
4. **Stream writer** — `enqueue(event)` runs the dedup gate then `XADD
   events * ev <json>`. Returns `{written, deduped}` so the route can
   record metrics.
5. **Stream consumer** — class `Consumer({redis, ch, batchSize,
   maxWaitMs})` exposes `start()` / `stop()`. Internally runs
   `XREADGROUP` with the configured group, batches, calls
   `insertEvents()`, ACKs only on success. Exp-backoff on CH errors.

**Thin orchestrator:**

6. **Collector `/_ingest` route** — body parse → HMAC verify (401 on
   fail) → per-event call to stream writer → 204. Returns 400 on
   schema/parse failure. Surfaces stream-write failures as 503 (Redis
   down → DO retries on edge side already).

**Other touched surfaces:**

- `/_internal/health` upgraded to Redis ping + CH ping.
- `apps/collector/db/sql/` — extracted from the schema reference doc:
  `001_create_events.sql`, `002_create_events_buffer.sql`,
  `003_create_materialized_views.sql`, `004_create_dictionaries.sql`.
- `package.json` (root) — `pnpm dev` script that boots compose +
  collector + edge + demo concurrently.

### Configuration

All env-driven so tests can override:

- `INGEST_SHARED_SECRET` — must match the edge's value
- `REDIS_URL` — `redis://localhost:6379` default
- `REDIS_STREAM_KEY` — `events` default
- `REDIS_CONSUMER_GROUP` — `collector` default
- `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` /
  `CLICKHOUSE_DATABASE`
- `DEDUP_EVENT_NAMES` — `"purchase"` default, comma-separated
- `DEDUP_TTL_SEC` — `600` default
- `BATCH_SIZE` — `1000` default
- `BATCH_MAX_WAIT_MS` — `1000` default
- `REPLAY_WINDOW_MS` — `300_000` default (5 min)

### API contract — POST /_ingest

Request:
```
POST /_ingest
content-type: application/json
x-edge-signature: <64-char hex of HMAC-SHA256(body, INGEST_SHARED_SECRET)>

{
  "events": [EnrichedEvent, ...],
  "signed_at": <unix ms>
}
```

Responses:
- `204` — every event accepted (written or deduped)
- `400` — body unparseable, missing fields, or schema invalid
- `401` — HMAC missing, mismatched, or `signed_at` outside replay window
- `503` — Redis unreachable; edge retries via DO backoff

Body shape and HMAC protocol already documented in
`docs/reference/hmac-protocol.md`; no contract change there.

### Error semantics

- HMAC failure: log with `signed_at`, request id, my-now (no expected
  signature). Return 401 with body `"unauthorized"`.
- Schema failure: return 400 with the field path that broke. Per-event
  parse errors are tolerated — log + drop the bad entry, continue with
  the rest. (Edge already does the same on inbound.)
- Dedup hit: counted in metrics, response is still 204.
- Redis down: 503; edge backs off and retries the whole batch.
- CH down: consumer parks events in PEL, retries with backoff. Health
  endpoint goes red. No data loss until Redis fills (default 24h
  retention via `XADD MAXLEN ~ N`, configurable; out of scope for
  default tuning).

### Observability

Three counters exposed via the health endpoint payload (or a separate
`/_internal/metrics` JSON):
- `events_accepted` — passed HMAC + parse
- `events_deduplicated` — dedup gate said "second time"
- `events_inserted` — consumer wrote to CH

Plus consumer-lag diagnostic: oldest entry in PEL, pending count.

## Testing Decisions

### What makes a good test

Test external behavior — the inputs you actually pass and the outputs
you actually observe. Don't reach into module internals to assert that
some private helper was called. Don't mock things you can run for real
cheaply (Redis and ClickHouse are both Docker images that boot in
seconds).

A "good test" for this PRD:
- For HMAC: feeds bytes in, asserts boolean out. Multiple cases:
  valid, signature missing, signature wrong-length, signature off by
  one byte, replay window expired, signed_at in the future.
- For migrations: starts with a fresh DB, runs migrate, asserts
  expected tables exist. Runs migrate again, asserts no errors and the
  applied list is empty.
- For dedup: starts with an empty Redis, calls gate twice with same
  event_id, asserts firstSeen flips false. Calls gate with non-dedup
  event name, asserts firstSeen always true.
- For stream + consumer: writes an EnrichedEvent in via the stream
  writer, polls the events table, asserts the row appears within 2 s.
- For `/_ingest`: builds a real signed batch, POSTs it, asserts the
  events show up in CH.

### Modules to test

| Module | Test type | Infrastructure |
|---|---|---|
| HMAC verifier | Unit, table-driven | None |
| Migration runner | Integration | Real CH (CI service) |
| Dedup gate | Integration | Real Redis (CI service) |
| Stream writer | Integration | Real Redis |
| Consumer | Integration | Real Redis + real CH |
| `/_ingest` route | Integration (E2E) | Real Redis + real CH |

### Prior art

- `apps/edge/src/__tests__/ingest.test.ts` — `forwardBatch` HMAC
  signing tests. The verifier here is the inverse pair; mirror the
  fixtures.
- `apps/collector/src/db/__tests__/clickhouse.test.ts` — uses
  `it.skipIf(!liveCh)` to gate live tests behind `CLICKHOUSE_URL`. The
  same gating pattern applies for the new integration tests so they
  don't break local `bun test` runs without docker-compose up.
- `apps/edge/src/routes/__tests__/track.test.ts` — Hono route test
  setup with mocked DO bindings. Adapt for collector route tests
  (mock Redis if you want fast unit tests, real Redis for the e2e).

The test-collector job in `.github/workflows/ci.yml` (currently
disabled because there's nothing real to test) is re-enabled as part of
this PRD with `services: redis, clickhouse` already configured.

## Out of scope

- **Read API** (`GET /api/v1/metrics/*`) — separate PRD.
- **Authentication for the read API** — separate PRD.
- **FX rate dictionary loader** (`/_internal/fx-rates`) — touched
  superficially in the schema (`004_create_dictionaries.sql`) but the
  cron that refreshes rates is a separate PRD.
- **Multi-region / replicated ClickHouse** — single-node per
  `docs/architecture/02-collector.md`.
- **Rate limiting at the collector** — out per project memory
  `architecture_per_client_workers`: each customer gets their own edge
  worker, no technical rate limiting.
- **Bot scoring at the collector** — already done at edge; collector
  trusts the `is_bot` field.
- **Schema versioning beyond append-only migrations** — no down
  migrations in v1.
- **Backpressure from CH to Redis** — if CH falls hopelessly behind,
  Redis stream length grows; we rely on `MAXLEN ~` retention. Tuning
  retention is a tracking issue, not blocking.

## Further notes

- After this lands, the demo's `apiUrl` can be repointed at a real
  edge running locally (`wrangler dev`), and the events the demo fires
  become queryable. That's the "see it work end-to-end" demo the user
  asked for.
- This unblocks weekend e2e testing.
- Bun must be installed locally to run collector tests
  (`brew install bun`); CI already has it via `oven-sh/setup-bun@v2`.
- The disabled `test-collector` CI job is re-enabled as part of this
  PRD.
- `architecture_event_dedup` memory: dedup is purchase-only by default,
  configurable via env var. Honor that — don't dedup everything.
- The Redis Stream choice (vs writing direct to CH) is anchored in the
  `architecture_per_client_workers` memory and the architecture doc.
  Don't deviate.
