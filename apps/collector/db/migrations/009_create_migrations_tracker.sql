CREATE TABLE IF NOT EXISTS _migrations
(
    filename    String,
    applied_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY filename;
