-- FX rates storage for query-time currency conversion (value_native → report_currency).
-- Source of truth for the `fx_rates` dictionary (migration 008), which pulls from
-- GET /_internal/fx-rates and refreshes every 24h.
--
-- ReplacingMergeTree: re-running the daily sync for the same (date, from_ccy, to_ccy)
-- overwrites the prior row on merge — read with FINAL to collapse duplicates.
CREATE TABLE IF NOT EXISTS fx_rates_history
(
    date     Date,
    from_ccy LowCardinality(String),
    to_ccy   LowCardinality(String),
    rate     Float64
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (date, from_ccy, to_ccy);
