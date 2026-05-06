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
