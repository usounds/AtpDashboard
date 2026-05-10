CREATE DATABASE IF NOT EXISTS atp_dashboard;

-- Pre-cutover DDL is additive only. Do not rename, drop, replace, or shadow the
-- live collection_count_refresh_manifest object until deploy has verified a
-- visible v2 marker and API continuity.

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_refresh_manifest_v2
(
    refresh_id UUID,
    status String,
    updated_at DateTime64(3, 'UTC'),
    completed_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL,
    row_count UInt64 DEFAULT 0,
    refreshed_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC'),
    run_id Nullable(UUID) DEFAULT NULL,
    previous_refresh_id Nullable(UUID) DEFAULT NULL,
    watermark_queued_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL,
    watermark_event_key Nullable(String) DEFAULT NULL,
    watermark_queue_seq String DEFAULT '',
    cutoff_queued_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL,
    cutoff_event_key Nullable(String) DEFAULT NULL,
    cutoff_queue_seq String DEFAULT '',
    snapshot_anchor_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL,
    source_rows UInt64 DEFAULT 0,
    stage_rows UInt64 DEFAULT 0,
    event_seen_row_count UInt64 DEFAULT 0,
    event_conflict_row_count UInt64 DEFAULT 0,
    first_seen_row_count UInt64 DEFAULT 0,
    did_seen_row_count UInt64 DEFAULT 0,
    rkey_seen_row_count UInt64 DEFAULT 0,
    hourly_row_count UInt64 DEFAULT 0,
    snapshot_written UInt8 DEFAULT 0,
    event_seen_written UInt8 DEFAULT 0,
    event_conflict_written UInt8 DEFAULT 0,
    first_seen_written UInt8 DEFAULT 0,
    did_seen_written UInt8 DEFAULT 0,
    rkey_seen_written UInt8 DEFAULT 0,
    hourly_written UInt8 DEFAULT 0,
    cumulative_users_written UInt8 DEFAULT 0,
    validation_passed UInt8 DEFAULT 0,
    queue_backfill_generation UInt64 DEFAULT 0,
    status_version UInt64 DEFAULT 0,
    invalidated_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL,
    invalidated_reason Nullable(String) DEFAULT NULL,
    is_bootstrap_seed UInt8 DEFAULT 0
)
ENGINE = MergeTree
ORDER BY (refresh_id, status_version, updated_at);

CREATE VIEW IF NOT EXISTS atp_dashboard.collection_count_refresh_manifest_v2_compatibility_preview
AS
WITH latest_manifest AS
(
    SELECT
        refresh_id,
        argMax(status, tuple(updated_at, status_version)) AS latest_status,
        argMax(completed_at, tuple(updated_at, status_version)) AS latest_completed_at,
        argMax(row_count, tuple(updated_at, status_version)) AS latest_row_count,
        argMax(refreshed_at, tuple(updated_at, status_version)) AS latest_refreshed_at,
        max(updated_at) AS latest_updated_at,
        argMax(run_id, tuple(updated_at, status_version)) AS latest_run_id,
        argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
        argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
        argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
        argMax(snapshot_anchor_at, tuple(updated_at, status_version)) AS snapshot_anchor_at,
        argMax(snapshot_written, tuple(updated_at, status_version)) AS snapshot_written,
        argMax(event_seen_written, tuple(updated_at, status_version)) AS event_seen_written,
        argMax(event_conflict_written, tuple(updated_at, status_version)) AS event_conflict_written,
        argMax(first_seen_written, tuple(updated_at, status_version)) AS first_seen_written,
        argMax(did_seen_written, tuple(updated_at, status_version)) AS did_seen_written,
        argMax(rkey_seen_written, tuple(updated_at, status_version)) AS rkey_seen_written,
        argMax(hourly_written, tuple(updated_at, status_version)) AS hourly_written,
        argMax(cumulative_users_written, tuple(updated_at, status_version)) AS cumulative_users_written,
        argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
        argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
        argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
    FROM atp_dashboard.collection_count_refresh_manifest_v2
    GROUP BY refresh_id
),
valid_completed_all AS
(
    SELECT *
    FROM latest_manifest
    WHERE latest_status = 'completed'
      AND latest_completed_at IS NOT NULL
      AND invalidated_at IS NULL
      AND is_bootstrap_seed = 0
      AND latest_run_id IS NOT NULL
      AND snapshot_anchor_at IS NOT NULL
      AND cutoff_queued_at IS NOT NULL
      AND cutoff_event_key IS NOT NULL
      AND cutoff_queue_seq != ''
      AND snapshot_written = 1
      AND event_seen_written = 1
      AND event_conflict_written = 1
      AND first_seen_written = 1
      AND did_seen_written = 1
      AND rkey_seen_written = 1
      AND hourly_written = 1
      AND cumulative_users_written = 1
      AND validation_passed = 1
)
SELECT
    refresh_id,
    'completed' AS status,
    latest_completed_at AS completed_at,
    latest_row_count AS row_count,
    CAST(NULL, 'Nullable(String)') AS error_message,
    latest_refreshed_at AS refreshed_at,
    latest_updated_at AS updated_at
FROM valid_completed_all
ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
LIMIT 1;

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_incremental_runs
(
    run_id UUID,
    refresh_id UUID,
    status String,
    previous_refresh_id Nullable(UUID),
    watermark_queued_at Nullable(DateTime64(3, 'UTC')),
    watermark_event_key Nullable(String),
    watermark_queue_seq String DEFAULT '',
    cutoff_queued_at Nullable(DateTime64(3, 'UTC')),
    cutoff_event_key Nullable(String),
    cutoff_queue_seq String DEFAULT '',
    source_rows UInt64 DEFAULT 0,
    stage_rows UInt64 DEFAULT 0,
    error_message Nullable(String) DEFAULT NULL,
    started_at DateTime64(3, 'UTC'),
    updated_at DateTime64(3, 'UTC'),
    completed_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL
)
ENGINE = MergeTree
ORDER BY (run_id, updated_at);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_ingest_queue
(
    event_key String,
    collection String,
    did String,
    rkey String,
    created_at Nullable(DateTime64(6, 'UTC')),
    created_at_key String,
    created_hour Nullable(DateTime64(0, 'UTC')),
    source_ingested_at DateTime64(3, 'UTC'),
    queued_at DateTime64(3, 'UTC'),
    queue_seq String,
    payload_hash UInt64
)
ENGINE = MergeTree
ORDER BY (queued_at, event_key, queue_seq);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_event_existence_log
(
    event_key String,
    payload_hash UInt64,
    collection String,
    did String,
    rkey String,
    created_at Nullable(DateTime64(6, 'UTC')),
    created_at_key String,
    created_hour Nullable(DateTime64(0, 'UTC')),
    source_ingested_at DateTime64(3, 'UTC'),
    written_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (event_key, payload_hash);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_bootstrap_progress
(
    name String,
    last_event_key String,
    updated_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (name, updated_at);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_event_raw_candidate_stage
(
    run_id UUID,
    event_key String,
    collection String,
    did String,
    rkey String,
    created_at Nullable(DateTime64(6, 'UTC')),
    created_at_key String,
    created_hour Nullable(DateTime64(0, 'UTC')),
    source_ingested_at DateTime64(3, 'UTC'),
    queued_at DateTime64(3, 'UTC'),
    queue_seq String,
    payload_hash UInt64
)
ENGINE = MergeTree
ORDER BY (run_id, queued_at, event_key, queue_seq);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_event_stage
(
    run_id UUID,
    event_key String,
    collection String,
    did String,
    rkey String,
    created_at Nullable(DateTime64(6, 'UTC')),
    created_at_key String,
    created_hour Nullable(DateTime64(0, 'UTC')),
    source_ingested_at DateTime64(3, 'UTC'),
    queued_at DateTime64(3, 'UTC'),
    queue_seq String,
    payload_hash UInt64
)
ENGINE = MergeTree
ORDER BY (run_id, event_key);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_event_seen_log
(
    run_id UUID,
    refresh_id UUID,
    event_key String,
    collection String,
    did String,
    rkey String,
    created_at Nullable(DateTime64(6, 'UTC')),
    created_at_key String,
    created_hour Nullable(DateTime64(0, 'UTC')),
    source_ingested_at DateTime64(3, 'UTC'),
    queued_at DateTime64(3, 'UTC'),
    payload_hash UInt64,
    seen_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (event_key, refresh_id, run_id);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_event_conflicts
(
    run_id UUID,
    refresh_id UUID,
    event_key String,
    payload_hash UInt64,
    existing_payload_hash Nullable(UInt64),
    collection String,
    did String,
    rkey String,
    created_at_key String,
    source_ingested_at DateTime64(3, 'UTC'),
    queued_at DateTime64(3, 'UTC'),
    detected_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (event_key, refresh_id, run_id);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_queue_orphans
(
    run_id UUID,
    event_key String,
    queued_at DateTime64(3, 'UTC'),
    queue_seq String,
    payload_hash UInt64,
    detected_at DateTime64(3, 'UTC'),
    resolved_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL,
    resolution Nullable(String) DEFAULT NULL
)
ENGINE = MergeTree
ORDER BY (event_key, queued_at, queue_seq);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_collection_delta
(
    run_id UUID,
    collection String,
    total_count Int64,
    min_created_at Nullable(DateTime64(6, 'UTC')),
    max_created_at Nullable(DateTime64(6, 'UTC')),
    delta_written_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (run_id, collection);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_did_delta
(
    run_id UUID,
    collection String,
    did String,
    delta_written_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (run_id, collection, did);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_rkey_delta
(
    run_id UUID,
    collection String,
    did String,
    rkey String,
    delta_written_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (run_id, collection, did, rkey);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_did_first_seen_delta
(
    run_id UUID,
    collection String,
    did String,
    first_seen_at DateTime64(6, 'UTC'),
    delta_written_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (run_id, collection, did);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_recent_hourly_delta
(
    run_id UUID,
    created_hour DateTime64(0, 'UTC'),
    collection String,
    event_count UInt64
)
ENGINE = MergeTree
ORDER BY (run_id, created_hour, collection);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_did_seen_state
(
    refresh_id UUID,
    run_id UUID,
    collection String,
    did String,
    first_seen_at Nullable(DateTime64(3, 'UTC')),
    created_at_is_null UInt8,
    state_written_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (collection, did, refresh_id);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_rkey_seen_state
(
    refresh_id UUID,
    run_id UUID,
    collection String,
    did String,
    rkey String,
    state_written_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (collection, did, rkey, refresh_id);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_did_first_seen_state
(
    refresh_id UUID,
    run_id UUID,
    collection String,
    did String,
    first_seen_at DateTime64(6, 'UTC'),
    state_written_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (collection, did, first_seen_at, refresh_id);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_recent_hourly_state
(
    refresh_id UUID,
    run_id UUID,
    collection String,
    created_hour DateTime64(0, 'UTC'),
    event_count UInt64,
    state_written_at DateTime64(3, 'UTC')
)
ENGINE = SummingMergeTree(event_count)
PARTITION BY toYYYYMM(created_hour)
ORDER BY (created_hour, collection, refresh_id);

CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_cumulative_users_snapshot
(
    refresh_id UUID,
    collection String,
    day Date,
    new_users UInt64,
    cumulative_users UInt64,
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (refresh_id, collection, day);

CREATE TABLE IF NOT EXISTS atp_dashboard.current_stage_did_keys
(
    run_id UUID,
    collection String,
    did String
)
ENGINE = MergeTree
ORDER BY (run_id, collection, did);

CREATE TABLE IF NOT EXISTS atp_dashboard.current_stage_rkey_keys
(
    run_id UUID,
    collection String,
    did String,
    rkey String
)
ENGINE = MergeTree
ORDER BY (run_id, collection, did, rkey);

CREATE TABLE IF NOT EXISTS atp_dashboard.current_stage_affected_collections
(
    run_id UUID,
    collection String
)
ENGINE = MergeTree
ORDER BY (run_id, collection);

CREATE TABLE IF NOT EXISTS atp_dashboard.current_stage_hour_keys
(
    run_id UUID,
    collection String,
    created_hour DateTime64(0, 'UTC')
)
ENGINE = MergeTree
ORDER BY (run_id, created_hour, collection);

ALTER TABLE atp_dashboard.collection_count_snapshot
    ADD COLUMN IF NOT EXISTS unique_did UInt64 AFTER collection;

ALTER TABLE atp_dashboard.collection_count_snapshot
    ADD COLUMN IF NOT EXISTS unique_rkey UInt64 AFTER unique_did;
