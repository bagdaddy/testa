CREATE TABLE IF NOT EXISTS events
(
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
    referrer        String DEFAULT '',
    country         LowCardinality(String) DEFAULT 'XX',
    region          LowCardinality(String) DEFAULT '',
    device_type     LowCardinality(String) DEFAULT 'unknown',
    browser         LowCardinality(String) DEFAULT '',
    os              LowCardinality(String) DEFAULT '',
    is_bot          UInt8 DEFAULT 0,
    consent_state   LowCardinality(String) DEFAULT 'unknown',
    value_native    Decimal(18, 4) DEFAULT 0,
    currency        LowCardinality(String) DEFAULT '',
    order_id        String DEFAULT '',
    items_count     UInt16 DEFAULT 0,
    props           Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (project_id, event_name, ts)
TTL toDateTime(ts) + INTERVAL 13 MONTH
SETTINGS index_granularity = 8192;
