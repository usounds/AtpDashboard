CREATE DATABASE IF NOT EXISTS atp_dashboard;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_chart_snapshot
(
    refresh_id UUID,
    tool LowCardinality(String),
    days UInt16,
    bucket_days UInt8,
    bucket_index UInt16,
    date Date,
    day_offset Int16,
    active UInt64,
    new UInt64,
    count UInt64,
    latest_at Nullable(DateTime64(6, 'UTC')),
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY (refresh_id, tool, days, bucket_days, bucket_index);

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_chart_refresh_manifest
(
    refresh_id UUID,
    status Enum8('running' = 1, 'completed' = 2, 'failed' = 3),
    started_at DateTime64(3, 'UTC'),
    completed_at Nullable(DateTime64(3, 'UTC')),
    row_count UInt64,
    error_message Nullable(String),
    updated_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY refresh_id;

-- API publication rule:
-- - Only status = 'completed' refresh_id values are visible to chart endpoints.
-- - running/failed refreshes must never be selected for dashboard responses.
-- - API may return stale completed snapshots, exposing snapshot age in headers.
