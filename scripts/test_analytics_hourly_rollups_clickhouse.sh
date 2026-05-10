#!/usr/bin/env bash
set -euo pipefail

CONTAINER="atpdashboard-hourly-rollup-test-$$"
IMAGE="${CLICKHOUSE_TEST_IMAGE:-clickhouse/clickhouse-server:latest}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm \
  --name "$CONTAINER" \
  --ulimit nofile=262144:262144 \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" clickhouse-client --query "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$CONTAINER" clickhouse-client --query "SELECT 1" >/dev/null

ch() {
  docker exec -i "$CONTAINER" clickhouse-client "$@"
}

ch --multiquery <<'SQL'
CREATE DATABASE atp_dashboard;

CREATE TABLE atp_dashboard.collection_events
(
    event_key String,
    did String,
    collection String,
    created_at Nullable(DateTime64(6, 'UTC'))
)
ENGINE = MergeTree
ORDER BY event_key;

CREATE TABLE atp_dashboard.analytics_did_first_seen_state
(
    did String,
    first_seen_state AggregateFunction(min, DateTime64(6, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY did;

CREATE TABLE atp_dashboard.analytics_collection_first_seen_state
(
    collection String,
    first_seen_state AggregateFunction(min, DateTime64(6, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY collection;

CREATE TABLE atp_dashboard.analytics_hourly_new_did_rollup
(
    hour DateTime64(0, 'UTC'),
    new_count UInt64,
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY hour;

CREATE TABLE atp_dashboard.analytics_hourly_new_collection_rollup
(
    hour DateTime64(0, 'UTC'),
    new_count UInt64,
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY hour;

INSERT INTO atp_dashboard.collection_events VALUES
  ('e1', 'did:plc:alpha', 'app.example.post', toDateTime64('2025-01-16 15:28:16.123456', 6, 'UTC')),
  ('e2', 'did:plc:alpha', 'app.example.like', toDateTime64('2025-01-16 16:02:03.000000', 6, 'UTC')),
  ('e3', 'did:plc:beta', 'app.example.post', toDateTime64('2025-01-17 00:59:59.999999', 6, 'UTC')),
  ('e4', 'did:plc:gamma', 'did:web:lexicon.store', toDateTime64('2025-01-17 01:00:00.000000', 6, 'UTC'));

INSERT INTO atp_dashboard.analytics_did_first_seen_state
SELECT
    did,
    minState(assumeNotNull(created_at)) AS first_seen_state
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
GROUP BY did;

INSERT INTO atp_dashboard.analytics_collection_first_seen_state
SELECT
    collection,
    minState(assumeNotNull(created_at)) AS first_seen_state
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
  AND did != 'did:web:lexicon.store'
GROUP BY collection;

INSERT INTO atp_dashboard.analytics_hourly_new_did_rollup
SELECT
    toDateTime(intDiv(toUnixTimestamp(first_seen_at), 3600) * 3600, 'UTC') AS hour,
    count() AS new_count,
    now64(3, 'UTC') AS refreshed_at
FROM
(
    SELECT
        did,
        minMerge(first_seen_state) AS first_seen_at
    FROM atp_dashboard.analytics_did_first_seen_state
    GROUP BY did
)
WHERE first_seen_at <= now64(6, 'UTC')
GROUP BY hour;

INSERT INTO atp_dashboard.analytics_hourly_new_collection_rollup
SELECT
    toDateTime(intDiv(toUnixTimestamp(first_seen_at), 3600) * 3600, 'UTC') AS hour,
    count() AS new_count,
    now64(3, 'UTC') AS refreshed_at
FROM
(
    SELECT
        collection,
        minMerge(first_seen_state) AS first_seen_at
    FROM atp_dashboard.analytics_collection_first_seen_state
    GROUP BY collection
)
WHERE first_seen_at <= now64(6, 'UTC')
GROUP BY hour;
SQL

summary="$(ch --query "
SELECT
  sum(rows) AS rows,
  sum(future_rows) AS future_rows,
  sum(non_hour_rows) AS non_hour_rows,
  min(min_hour) AS min_hour,
  max(max_hour) AS max_hour
FROM
(
  SELECT
    count() AS rows,
    countIf(hour > now()) AS future_rows,
    countIf(toMinute(hour) != 0 OR toSecond(hour) != 0) AS non_hour_rows,
    min(hour) AS min_hour,
    max(hour) AS max_hour
  FROM atp_dashboard.analytics_hourly_new_did_rollup
  UNION ALL
  SELECT
    count() AS rows,
    countIf(hour > now()) AS future_rows,
    countIf(toMinute(hour) != 0 OR toSecond(hour) != 0) AS non_hour_rows,
    min(hour) AS min_hour,
    max(hour) AS max_hour
  FROM atp_dashboard.analytics_hourly_new_collection_rollup
)
FORMAT TSV
")"

IFS=$'\t' read -r rows future_rows non_hour_rows min_hour max_hour <<<"$summary"

if [[ "$rows" != "6" ]]; then
  echo "expected 6 hourly new rows, got $rows" >&2
  exit 1
fi

if [[ "$future_rows" != "0" ]]; then
  echo "expected no future hourly rows, got $future_rows" >&2
  exit 1
fi

if [[ "$non_hour_rows" != "0" ]]; then
  echo "expected all rows to be aligned to hour, got $non_hour_rows non-hour rows" >&2
  exit 1
fi

echo "ok hourly rollup rows=$rows min_hour=\"$min_hour\" max_hour=\"$max_hour\""
