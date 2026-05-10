CREATE DATABASE IF NOT EXISTS atp_dashboard;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_daily_activity_rollup
(
    day Date,
    event_count_state AggregateFunction(uniqExact, String),
    active_did_state AggregateFunction(uniqExact, String),
    latest_at_state AggregateFunction(max, DateTime64(6, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY day;

CREATE MATERIALIZED VIEW IF NOT EXISTS atp_dashboard.analytics_daily_activity_rollup_mv
TO atp_dashboard.analytics_daily_activity_rollup AS
SELECT
    toDate(assumeNotNull(created_at), 'UTC') AS day,
    uniqExactState(event_key) AS event_count_state,
    uniqExactState(did) AS active_did_state,
    maxState(assumeNotNull(created_at)) AS latest_at_state
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
GROUP BY day;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_daily_collection_activity_rollup
(
    day Date,
    active_collection_state AggregateFunction(uniqExact, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY day;

CREATE MATERIALIZED VIEW IF NOT EXISTS atp_dashboard.analytics_daily_collection_activity_rollup_mv
TO atp_dashboard.analytics_daily_collection_activity_rollup AS
SELECT
    toDate(assumeNotNull(created_at), 'UTC') AS day,
    uniqExactState(collection) AS active_collection_state
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
  AND did != 'did:web:lexicon.store'
GROUP BY day;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_did_first_seen_state
(
    did String,
    first_seen_state AggregateFunction(min, DateTime64(6, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY did;

CREATE MATERIALIZED VIEW IF NOT EXISTS atp_dashboard.analytics_did_first_seen_state_mv
TO atp_dashboard.analytics_did_first_seen_state AS
SELECT
    did,
    minState(assumeNotNull(created_at)) AS first_seen_state
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
GROUP BY did;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_collection_first_seen_state
(
    collection String,
    first_seen_state AggregateFunction(min, DateTime64(6, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY collection;

CREATE MATERIALIZED VIEW IF NOT EXISTS atp_dashboard.analytics_collection_first_seen_state_mv
TO atp_dashboard.analytics_collection_first_seen_state AS
SELECT
    collection,
    minState(assumeNotNull(created_at)) AS first_seen_state
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
  AND did != 'did:web:lexicon.store'
GROUP BY collection;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_daily_new_did_rollup
(
    day Date,
    new_count UInt64,
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY day;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_daily_new_collection_rollup
(
    day Date,
    new_count UInt64,
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY day;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_hourly_activity_rollup
(
    hour DateTime64(0, 'UTC'),
    event_count_state AggregateFunction(uniqExact, String),
    active_did_state AggregateFunction(uniqExact, String),
    latest_at_state AggregateFunction(max, DateTime64(6, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY hour;

CREATE MATERIALIZED VIEW IF NOT EXISTS atp_dashboard.analytics_hourly_activity_rollup_mv
TO atp_dashboard.analytics_hourly_activity_rollup AS
SELECT
    toDateTime64(toStartOfHour(assumeNotNull(created_at)), 0, 'UTC') AS hour,
    uniqExactState(event_key) AS event_count_state,
    uniqExactState(did) AS active_did_state,
    maxState(assumeNotNull(created_at)) AS latest_at_state
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
GROUP BY hour;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_hourly_collection_activity_rollup
(
    hour DateTime64(0, 'UTC'),
    active_collection_state AggregateFunction(uniqExact, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY hour;

CREATE MATERIALIZED VIEW IF NOT EXISTS atp_dashboard.analytics_hourly_collection_activity_rollup_mv
TO atp_dashboard.analytics_hourly_collection_activity_rollup AS
SELECT
    toDateTime64(toStartOfHour(assumeNotNull(created_at)), 0, 'UTC') AS hour,
    uniqExactState(collection) AS active_collection_state
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
  AND did != 'did:web:lexicon.store'
GROUP BY hour;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_hourly_new_did_rollup
(
    hour DateTime64(0, 'UTC'),
    new_count UInt64,
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY hour;

CREATE TABLE IF NOT EXISTS atp_dashboard.analytics_hourly_new_collection_rollup
(
    hour DateTime64(0, 'UTC'),
    new_count UInt64,
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY hour;

-- Initial backfill order:
-- 1. Create these tables and materialized views without POPULATE.
-- 2. Choose a production cutoff timestamp.
-- 3. Backfill rows before the cutoff into the rollup tables in bounded chunks.
-- 4. Let materialized views handle rows at/after the cutoff.
-- 5. Rebuild daily_new_* rollups from the finalized first_seen state tables.
--
-- The daily_new_* rollups intentionally are not materialized views from raw events:
-- the correct "new" day depends on global first_seen, including late or replayed events.
-- The hourly_* rollups are the intended backend source for rolling chart windows.
-- They keep the visible daily/monthly chart semantics close to the current latest_at
-- windows while allowing the backend data to lag by up to one hour.
--
-- Review before running full-history backfill:
--
-- INSERT INTO atp_dashboard.analytics_daily_activity_rollup
-- SELECT
--     toDate(assumeNotNull(created_at), 'UTC') AS day,
--     uniqExactState(event_key) AS event_count_state,
--     uniqExactState(did) AS active_did_state,
--     maxState(assumeNotNull(created_at)) AS latest_at_state
-- FROM atp_dashboard.collection_events
-- WHERE isNotNull(created_at)
-- GROUP BY day;
--
-- INSERT INTO atp_dashboard.analytics_daily_collection_activity_rollup
-- SELECT
--     toDate(assumeNotNull(created_at), 'UTC') AS day,
--     uniqExactState(collection) AS active_collection_state
-- FROM atp_dashboard.collection_events
-- WHERE isNotNull(created_at)
--   AND did != 'did:web:lexicon.store'
-- GROUP BY day;
--
-- INSERT INTO atp_dashboard.analytics_did_first_seen_state
-- SELECT
--     did,
--     minState(assumeNotNull(created_at)) AS first_seen_state
-- FROM atp_dashboard.collection_events
-- WHERE isNotNull(created_at)
-- GROUP BY did;
--
-- INSERT INTO atp_dashboard.analytics_collection_first_seen_state
-- SELECT
--     collection,
--     minState(assumeNotNull(created_at)) AS first_seen_state
-- FROM atp_dashboard.collection_events
-- WHERE isNotNull(created_at)
--   AND did != 'did:web:lexicon.store'
-- GROUP BY collection;
--
-- INSERT INTO atp_dashboard.analytics_daily_new_did_rollup
-- SELECT
--     toDate(first_seen_at, 'UTC') AS day,
--     count() AS new_count,
--     now64(3, 'UTC') AS refreshed_at
-- FROM
-- (
--     SELECT
--         did,
--         minMerge(first_seen_state) AS first_seen_at
--     FROM atp_dashboard.analytics_did_first_seen_state
--     GROUP BY did
-- )
-- GROUP BY day;
--
-- INSERT INTO atp_dashboard.analytics_daily_new_collection_rollup
-- SELECT
--     toDate(first_seen_at, 'UTC') AS day,
--     count() AS new_count,
--     now64(3, 'UTC') AS refreshed_at
-- FROM
-- (
--     SELECT
--         collection,
--         minMerge(first_seen_state) AS first_seen_at
--     FROM atp_dashboard.analytics_collection_first_seen_state
--     GROUP BY collection
-- )
-- GROUP BY day;
--
-- INSERT INTO atp_dashboard.analytics_hourly_activity_rollup
-- SELECT
--     toDateTime64(toStartOfHour(assumeNotNull(created_at)), 0, 'UTC') AS hour,
--     uniqExactState(event_key) AS event_count_state,
--     uniqExactState(did) AS active_did_state,
--     maxState(assumeNotNull(created_at)) AS latest_at_state
-- FROM atp_dashboard.collection_events
-- WHERE isNotNull(created_at)
-- GROUP BY hour;
--
-- INSERT INTO atp_dashboard.analytics_hourly_collection_activity_rollup
-- SELECT
--     toDateTime64(toStartOfHour(assumeNotNull(created_at)), 0, 'UTC') AS hour,
--     uniqExactState(collection) AS active_collection_state
-- FROM atp_dashboard.collection_events
-- WHERE isNotNull(created_at)
--   AND did != 'did:web:lexicon.store'
-- GROUP BY hour;
--
-- INSERT INTO atp_dashboard.analytics_hourly_new_did_rollup
-- SELECT
--     toDateTime(intDiv(toUnixTimestamp(first_seen_at), 3600) * 3600, 'UTC') AS hour,
--     count() AS new_count,
--     now64(3, 'UTC') AS refreshed_at
-- FROM
-- (
--     SELECT
--         did,
--         minMerge(first_seen_state) AS first_seen_at
--     FROM atp_dashboard.analytics_did_first_seen_state
--     GROUP BY did
-- )
-- GROUP BY hour;
--
-- INSERT INTO atp_dashboard.analytics_hourly_new_collection_rollup
-- SELECT
--     toDateTime(intDiv(toUnixTimestamp(first_seen_at), 3600) * 3600, 'UTC') AS hour,
--     count() AS new_count,
--     now64(3, 'UTC') AS refreshed_at
-- FROM
-- (
--     SELECT
--         collection,
--         minMerge(first_seen_state) AS first_seen_at
--     FROM atp_dashboard.analytics_collection_first_seen_state
--     GROUP BY collection
-- )
-- GROUP BY hour;
