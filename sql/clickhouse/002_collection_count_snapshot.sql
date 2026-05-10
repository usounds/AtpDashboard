CREATE DATABASE IF NOT EXISTS atp_dashboard;

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_snapshot
(
    refresh_id UUID,
    collection String,
    unique_did UInt64,
    unique_rkey UInt64,
    total_count UInt64,
    recent_count UInt64,
    min_created_at Nullable(DateTime64(6, 'UTC')),
    max_created_at Nullable(DateTime64(6, 'UTC')),
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY (refresh_id, collection);

ALTER TABLE atp_dashboard.collection_count_snapshot
    ADD COLUMN IF NOT EXISTS unique_did UInt64 AFTER collection;

ALTER TABLE atp_dashboard.collection_count_snapshot
    ADD COLUMN IF NOT EXISTS unique_rkey UInt64 AFTER unique_did;

-- Snapshot retention policy:
-- - API reads only refresh_id values marked completed in collection_count_refresh_manifest.
-- - Keep recent completed snapshot generations for rollback/debugging.
-- - Physical cleanup is an operational task; do not delete the only completed snapshot.
--
-- Example cleanup candidate query, review before executing:
-- SELECT refresh_id, max(refreshed_at) AS refreshed_at, count() AS rows
-- FROM atp_dashboard.collection_count_snapshot
-- GROUP BY refresh_id
-- ORDER BY refreshed_at DESC;

-- Storage observation query:
-- SELECT
--     database,
--     table,
--     formatReadableSize(sum(bytes_on_disk)) AS bytes_on_disk,
--     sum(rows) AS rows
-- FROM system.parts
-- WHERE active AND database = 'atp_dashboard' AND table = 'collection_count_snapshot'
-- GROUP BY database, table;
