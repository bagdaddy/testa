CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rpv_visitors_daily
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(ts)              AS day,
    project_id,
    experiment_id,
    variation_id,
    uniqExactState(visitor_id) AS visitors
FROM events
WHERE event_name = 'experiment_view' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
