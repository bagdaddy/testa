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
