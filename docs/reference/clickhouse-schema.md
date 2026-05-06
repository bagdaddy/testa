# Reference — ClickHouse schema (full DDL)

Canonical DDL for the `events` table, materialized views, and dictionaries owned by the collector. The migration files in `apps/collector/db/migrations/` should match this exactly.

## 001_create_events.sql

```sql
CREATE TABLE IF NOT EXISTS events
(
    event_id            UUID,
    client_ts           DateTime64(3, 'UTC'),
    server_ts           DateTime64(3, 'UTC') DEFAULT now64(3),
    project_id          UInt64,
    experiment_id       Nullable(UInt64),
    variation_id        Nullable(UInt64),
    visitor_id          String,
    session_id          String,
    event_name          LowCardinality(String),
    url                 String,
    referrer            String DEFAULT '',
    -- geo (CF-derived; never raw IP)
    country             LowCardinality(String) DEFAULT 'XX',
    region              LowCardinality(String) DEFAULT '',
    region_subdivision  LowCardinality(String) DEFAULT '',
    city                LowCardinality(String) DEFAULT '',
    -- device (UA-derived)
    device_type         LowCardinality(String) DEFAULT 'unknown',
    browser             LowCardinality(String) DEFAULT '',
    os                  LowCardinality(String) DEFAULT '',
    viewport_w          UInt16 DEFAULT 0,
    viewport_h          UInt16 DEFAULT 0,
    -- pixel build
    tracker_version     LowCardinality(String) DEFAULT '',
    is_bot              UInt8 DEFAULT 0,
    consent_state       LowCardinality(String) DEFAULT 'unknown',
    -- traffic source (parsed at the pixel from location.search)
    utm_source          LowCardinality(String) DEFAULT '',
    utm_medium          LowCardinality(String) DEFAULT '',
    utm_campaign        LowCardinality(String) DEFAULT '',
    -- revenue (purchase events)
    value_native        Decimal(18, 4) DEFAULT 0,
    currency            LowCardinality(String) DEFAULT '',
    order_id            String DEFAULT '',
    items_count         UInt16 DEFAULT 0,
    -- generic
    props               Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(client_ts)
ORDER BY (project_id, event_name, client_ts)
TTL toDateTime(client_ts) + INTERVAL 13 MONTH
SETTINGS index_granularity = 8192;
```

## 002_create_buffer.sql

```sql
CREATE TABLE IF NOT EXISTS events_buffer AS events
ENGINE = Buffer(
    currentDatabase(),
    events,
    16,            -- num_layers
    5,             -- min_time (s)
    30,            -- max_time (s)
    10000,         -- min_rows
    100000,        -- max_rows
    10000000,      -- min_bytes
    100000000      -- max_bytes
);
```

The consumer INSERTs into `events_buffer`; CH automatically flushes to `events`.

## 003_mv_aov_daily.sql

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_aov_daily
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, currency, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts)       AS day,
    project_id,
    experiment_id,
    variation_id,
    currency,
    sum(value_native)       AS revenue,
    count()                 AS orders
FROM events
WHERE event_name = 'purchase' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id, currency;
```

Query pattern:

```sql
SELECT
    variation_id,
    sumMerge(orders)        AS orders,
    sumMerge(revenue)       AS revenue_native,
    revenue_native / orders AS aov
FROM mv_aov_daily
WHERE project_id = ?
  AND experiment_id = ?
  AND day BETWEEN ? AND ?
GROUP BY variation_id, currency;
```

(For multi-currency, convert to `report_currency` via the `fx_rates` dictionary before aggregating.)

## 004_mv_rpv_revenue_daily.sql

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rpv_revenue_daily
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, currency, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts) AS day,
    project_id,
    experiment_id,
    variation_id,
    currency,
    sum(value_native) AS revenue
FROM events
WHERE event_name = 'purchase' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id, currency;
```

## 005_mv_rpv_visitors_daily.sql

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rpv_visitors_daily
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts)       AS day,
    project_id,
    experiment_id,
    variation_id,
    uniqExactState(visitor_id) AS visitors
FROM events
WHERE event_name = 'experiment_view' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
```

RPV computed at query time as `sum(revenue) / uniqExactMerge(visitors)`.

## 006_mv_sessions_daily.sql

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sessions_daily
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts)                                  AS day,
    project_id,
    experiment_id,
    variation_id,
    uniqExactState(session_id)                         AS sessions,
    uniqExactStateIf(session_id, event_name = 'page_view') AS sessions_with_pageview,
    countStateIf(event_name = 'page_view')             AS page_views
FROM events
WHERE is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
```

Bounce rate = `1 - sessions_with_pageview / sessions`. Pages-per-session = `page_views / sessions`.

## 007_mv_experiment_summary.sql

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_experiment_summary
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts)           AS day,
    project_id,
    experiment_id,
    variation_id,
    uniqExactState(visitor_id)  AS visitors
FROM events
WHERE event_name = 'experiment_view' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
```

Used by the daily parity check during pilot (compares CH visitor counts to MySQL `leads` row counts).

## 008_create_fx_dictionary.sql

```sql
CREATE DICTIONARY IF NOT EXISTS fx_rates
(
    date     DateTime,
    from_ccy String,
    to_ccy   String,
    rate     Float64
)
PRIMARY KEY date, from_ccy, to_ccy
SOURCE(HTTP(URL 'http://collector:8000/_internal/fx-rates' FORMAT 'JSONEachRow'))
LIFETIME(86400)
LAYOUT(COMPLEX_KEY_HASHED());
```

Lookup at query time:

```sql
SELECT
    dictGet('fx_rates', 'rate', tuple(toDateTime(toStartOfDay(client_ts)), currency, 'USD')) AS rate_to_usd
FROM events;
```

## 009_create_migrations_tracker.sql

```sql
CREATE TABLE IF NOT EXISTS _migrations
(
    filename    String,
    applied_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY filename;
```

`bun run migrate` reads this table to skip already-applied migrations. Migrations run in filename order (sort alphabetically: `001_*.sql` before `002_*.sql`).

## Operational notes

- **Partitioning by `toYYYYMM(ts)` ⟶ TTL-friendly.** Each month is a discrete partition CH can drop atomically when 13 months old.
- **`ORDER BY (project_id, event_name, ts)`.** Every dashboard query starts with `WHERE project_id = X AND event_name = Y AND ts BETWEEN ...` — this ordering means the primary index hits exactly the right granules.
- **`LowCardinality` everywhere we can.** `event_name`, `country`, `device_type`, etc. — dictionary-encoded, tiny on disk.
- **`Decimal(18, 4)` for revenue** — never floats for money.
- **`Map(LowCardinality(String), String)` for `props`** — keys are LowCardinality (the worker normalizes to a small set), values stored as strings (cast at query time).
- **`SETTINGS allow_nullable_key = 1` on all 5 materialized views.** Their `ORDER BY` clauses include `experiment_id` and `variation_id`, both `Nullable(UInt64)` (inherited from `events`). ClickHouse 24.x rejects nullable sort keys without this setting. Keeping the columns nullable preserves the semantic distinction between "no experiment context" (NULL) and "experiment with id 0" — never bucket those together. Verified against CH 24.10 in 2026-05-06 smoke test.

## Storage estimate

At 80 M events/month and ~200 bytes / event after compression:

- Per month: ~16 GB
- 13 months retained: ~210 GB total
- Materialized views: <1 GB total

Single-node CH on a modest box (8 cores, 32 GB RAM, NVMe) handles this easily.
