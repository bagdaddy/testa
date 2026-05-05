# Architecture — Data model

## Wide events table

Every observable customer-site action lands as a row in `events`. One table, all event types, queried via `event_name`. This is the standard product-analytics shape (Tinybird, PostHog, Plausible all converge here).

```sql
CREATE TABLE events (
  event_id        UUID,
  ts              DateTime64(3, 'UTC'),
  ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),
  project_id      UInt64,
  experiment_id   Nullable(UInt64),
  variation_id    Nullable(UInt64),
  visitor_id      String,
  session_id      String,
  event_name      LowCardinality(String),
  url             String,
  referrer        String,
  country         LowCardinality(String),
  region          LowCardinality(String),
  device_type     LowCardinality(String),
  browser         LowCardinality(String),
  os              LowCardinality(String),
  is_bot          UInt8,
  consent_state   LowCardinality(String),
  -- revenue (zero/empty for non-purchase events)
  value_native    Decimal(18, 4),
  currency        LowCardinality(String),
  order_id        String,
  items_count     UInt16,
  -- generic
  props           Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (project_id, event_name, ts)
TTL toDateTime(ts) + INTERVAL 13 MONTH;
```

### Why this shape

- **Partition by month** — drops 13-month-old partitions cleanly.
- **Order by (project_id, event_name, ts)** — every dashboard query filters on these three. Skip-index reads minimal granules.
- **`LowCardinality` aggressively** — country/event_name/etc are dictionaries; storage is tiny.
- **`Map(LowCardinality(String), String)`** for `props` — generic events don't bloat the schema. `props['add_to_cart_id']`, `props['cta_label']`, etc.
- **Decimal(18,4) for revenue** — never floats for money. 4 dp covers JPY (no decimals) and crypto-precision (overkill but fine).

### Reserved event names

These get first-class metric support (the materialized views below).

| Name | Required props | Use |
|---|---|---|
| `page_view` | url | Bounce, pages/session, traffic |
| `session_start` | (auto-emitted) | Sessions count |
| `experiment_view` | experiment_id, variation_id | Experiment exposure |
| `purchase` | value_native, currency, order_id, [items_count] | AOV, RPV, total revenue |
| `add_to_cart` | (optional value_native+currency) | Add-to-cart funnel step |
| `checkout_start` | (optional value_native+currency) | Checkout abandonment funnel step |

Anything else is a generic event keyed on `event_name`. Custom goals continue to map to the existing crobot `Goal` model (binary conversion in MySQL); rich revenue/funnel work uses CH events.

## Buffer table

```sql
CREATE TABLE events_buffer AS events
ENGINE = Buffer(default, events, 16, 5, 30, 10000, 100000, 10000000, 100000000);
```

Consumer INSERTs go here. Buffer engine batches in-memory (16 partitions, flush at 5–30s or 10k–100k rows or 10M–100M bytes) before writing to `events`. Shields the MergeTree from small parts and absorbs microbursts.

## Materialized views

Computed eagerly on insert; queries against them are cheap.

```sql
-- AOV per (experiment, variation, currency, day)
CREATE MATERIALIZED VIEW mv_aov_daily ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, currency, day) AS
SELECT
  toDate(ts) AS day,
  project_id, experiment_id, variation_id, currency,
  sum(value_native) AS revenue,
  count() AS orders
FROM events
WHERE event_name = 'purchase' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id, currency;

-- RPV: needs visitors which lives across all events, not just purchases.
-- Stored as two MVs and joined at query time, OR a single AggregatingMergeTree.
-- v1 uses two MVs.
CREATE MATERIALIZED VIEW mv_rpv_revenue_daily ...     -- (similar to AOV)
CREATE MATERIALIZED VIEW mv_rpv_visitors_daily ...    -- uniqState(visitor_id) per day

-- Sessions, bounce, pages/session
CREATE MATERIALIZED VIEW mv_sessions_daily ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day) AS
SELECT
  toDate(ts) AS day,
  project_id, experiment_id, variation_id,
  uniqState(session_id) AS sessions,
  countIfState(event_name = 'page_view') AS page_views,
  uniqIfState(session_id, event_name = 'page_view') AS sessions_with_pageview
FROM events
WHERE is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;

-- Experiment summary (legacy parity check vs MySQL leads)
CREATE MATERIALIZED VIEW mv_experiment_summary ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day) AS
SELECT
  toDate(ts) AS day,
  project_id, experiment_id, variation_id,
  uniqState(visitor_id) AS visitors
FROM events
WHERE event_name = 'experiment_view' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
```

## FX rates dictionary

```sql
CREATE DICTIONARY fx_rates (
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

Daily Frankfurter pull populates the source endpoint. Queries convert via `dictGet('fx_rates', 'rate', tuple(toDateTime(day), currency, report_currency))`.

## Retention

- **Raw `events`**: 13-month TTL, drops partition older than that.
- **Materialized views**: indefinite (~1000× smaller than raw).
- **`fx_rates` dictionary source**: 90 days of FX history (more than enough for any 13-month historical query window).

## Why not normalized tables

Considered: `purchases`, `page_views`, `sessions` as separate tables. Rejected because:

- Cross-event queries (funnel from page_view → add_to_cart → purchase) require unions or joins.
- Schema migrations (adding a new event type) become DDL-heavy.
- Wider rows but `LowCardinality` makes the column count irrelevant for storage.

Wide events is the current consensus among CH-based product analytics tools.

## Why not BigQuery / Snowflake

Considered: a true warehouse for ad-hoc analyst queries. Rejected for v1 because customer-facing dashboards need sub-second queries with hot caches; warehouses are tuned for ad-hoc batch and have spin-up latency. Could ship analyst-facing data later via CH → S3 export → external warehouse.

## See also

- `docs/reference/clickhouse-schema.md` — full DDL with materialized view definitions
- `docs/reference/event-shape.md` — wire format details
- `docs/architecture/02-collector.md` — how data flows in
