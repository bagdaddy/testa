CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sessions_daily
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(ts)                                         AS day,
    project_id,
    experiment_id,
    variation_id,
    uniqExactState(session_id)                         AS sessions,
    uniqExactStateIf(session_id, event_name = 'page_view') AS sessions_with_pageview,
    countStateIf(event_name = 'page_view')             AS page_views
FROM events
WHERE is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
