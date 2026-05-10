CREATE DATABASE IF NOT EXISTS atp_dashboard;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_presence_event_source
(
    event_key String,
    did String,
    collection String,
    created_at DateTime64(6, 'UTC'),
    hour DateTime64(0, 'UTC'),
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(hour)
ORDER BY (ingested_at, hour, event_key);

CREATE MATERIALIZED VIEW IF NOT EXISTS atp_dashboard.analytics_presence_event_source_mv
TO atp_dashboard.analytics_presence_event_source
AS
SELECT
    event_key,
    did,
    collection,
    assumeNotNull(created_at) AS created_at,
    toDateTime64(toStartOfHour(assumeNotNull(created_at)), 0, 'UTC') AS hour,
    ingested_at
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at);

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_hourly_did_presence
(
    hour DateTime64(0, 'UTC'),
    did String,
    observed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(observed_at)
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, did);

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_hourly_collection_presence
(
    hour DateTime64(0, 'UTC'),
    collection String,
    observed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(observed_at)
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, collection);

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_hourly_event_key_presence
(
    hour DateTime64(0, 'UTC'),
    event_key String,
    observed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(observed_at)
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, event_key);

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_hourly_event_count
(
    hour DateTime64(0, 'UTC'),
    count UInt64,
    source_max_ingested_at DateTime64(3, 'UTC'),
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
PARTITION BY toYYYYMM(hour)
ORDER BY hour;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_presence_run_status
(
    run_id UUID,
    status Enum8('running' = 1, 'verified' = 2, 'published' = 3, 'failed' = 4, 'rolled_back' = 5),
    phase LowCardinality(String),
    started_at DateTime64(3, 'UTC'),
    verified_at Nullable(DateTime64(3, 'UTC')),
    published_at Nullable(DateTime64(3, 'UTC')),
    completed_at Nullable(DateTime64(3, 'UTC')),
    cutoff_ingested_at DateTime64(3, 'UTC'),
    processed_ingested_at Nullable(DateTime64(3, 'UTC')),
    source_latest_at DateTime64(6, 'UTC'),
    source_latest_hour DateTime64(0, 'UTC'),
    previous_refresh_id Nullable(UUID),
    published_refresh_id Nullable(UUID),
    row_count UInt64,
    error_message Nullable(String),
    updated_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY run_id;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_presence_watermarks
(
    name LowCardinality(String),
    processed_ingested_at DateTime64(3, 'UTC'),
    run_id UUID,
    updated_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY name;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_chart_bucket_values
(
    run_id UUID,
    tool LowCardinality(String),
    days UInt16,
    bucket_days UInt8,
    bucket_index UInt16,
    date Date,
    day_offset Int16,
    active UInt64,
    new UInt64,
    count UInt64,
    source_latest_at DateTime64(6, 'UTC'),
    source_latest_hour DateTime64(0, 'UTC'),
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY (run_id, tool, days, bucket_days, bucket_index);

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_chart_snapshot_shadow
(
    run_id UUID,
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
ORDER BY (run_id, tool, days, bucket_days, bucket_index);
