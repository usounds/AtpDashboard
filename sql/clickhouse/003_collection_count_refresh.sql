CREATE DATABASE IF NOT EXISTS atp_dashboard;

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_refresh_manifest
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
-- - Only status = 'completed' refresh_id values are visible to the Hono API.
-- - running/failed refreshes must never be selected for dashboard responses.
-- - Worker should create a globally unique refresh_id per refresh attempt.

-- Latest completed refresh:
-- SELECT refresh_id, completed_at, row_count
-- FROM atp_dashboard.collection_count_refresh_manifest
-- WHERE status = 'completed'
-- ORDER BY completed_at DESC
-- LIMIT 1;

-- Orphaned running refreshes for operator review:
-- SELECT refresh_id, started_at, updated_at
-- FROM atp_dashboard.collection_count_refresh_manifest
-- WHERE status = 'running'
--   AND started_at < now() - INTERVAL 1 HOUR
-- ORDER BY started_at;
