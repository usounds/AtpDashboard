#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
ENV_FILE="${CLICKHOUSE_ENV_FILE:-/etc/atpdashboard/clickhouse.env}"
CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"
LOOKBACK_DAYS="${ANALYTICS_HOURLY_BACKFILL_DAYS:-370}"

if [[ "${1:-}" != "--confirm" ]]; then
  echo "Usage: $0 --confirm" >&2
  echo "Rebuilds hourly analytics rollups, then publishes a new analytics chart snapshot from hourly rollups." >&2
  echo "This is intended for the stopped-service maintenance window." >&2
  exit 2
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "[hourly-snapshot] APP_DIR does not exist: $APP_DIR" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[hourly-snapshot] env file does not exist: $ENV_FILE" >&2
  exit 1
fi

if ! [[ "$LOOKBACK_DAYS" =~ ^[0-9]+$ ]] || [[ "$LOOKBACK_DAYS" -lt 365 ]]; then
  echo "[hourly-snapshot] ANALYTICS_HOURLY_BACKFILL_DAYS must be an integer >= 365, got: $LOOKBACK_DAYS" >&2
  exit 1
fi

cd "$APP_DIR"

run_clickhouse() {
  docker exec -i "$CONTAINER" clickhouse-client --multiquery
}

query_clickhouse() {
  docker exec -i "$CONTAINER" clickhouse-client --query "$1"
}

echo "[hourly-snapshot] app_dir=$APP_DIR"
echo "[hourly-snapshot] env_file=$ENV_FILE"
echo "[hourly-snapshot] container=$CONTAINER database=$DATABASE lookback_days=$LOOKBACK_DAYS"

echo "[hourly-snapshot] applying ClickHouse rollup DDL"
docker exec -i "$CONTAINER" clickhouse-client --multiquery < sql/clickhouse/005_analytics_chart_rollups.sql

echo "[hourly-snapshot] raw source sanity"
query_clickhouse "
SELECT
  count() AS rows,
  min(created_at) AS min_created_at,
  max(created_at) AS max_created_at,
  countIf(created_at > now64(6, 'UTC')) AS future_rows
FROM ${DATABASE}.collection_events
WHERE isNotNull(created_at)
"

echo "[hourly-snapshot] truncating derived hourly rollups"
run_clickhouse <<SQL
TRUNCATE TABLE ${DATABASE}.analytics_hourly_activity_rollup;
TRUNCATE TABLE ${DATABASE}.analytics_hourly_collection_activity_rollup;
TRUNCATE TABLE ${DATABASE}.analytics_did_first_seen_state;
TRUNCATE TABLE ${DATABASE}.analytics_collection_first_seen_state;
TRUNCATE TABLE ${DATABASE}.analytics_hourly_new_did_rollup;
TRUNCATE TABLE ${DATABASE}.analytics_hourly_new_collection_rollup;
SQL

echo "[hourly-snapshot] rebuilding hourly activity rollup"
run_clickhouse <<SQL
INSERT INTO ${DATABASE}.analytics_hourly_activity_rollup
SELECT
    toDateTime64(toStartOfHour(assumeNotNull(created_at)), 0, 'UTC') AS hour,
    uniqExactState(event_key) AS event_count_state,
    uniqExactState(did) AS active_did_state,
    maxState(assumeNotNull(created_at)) AS latest_at_state
FROM ${DATABASE}.collection_events
WHERE isNotNull(created_at)
  AND created_at >= now64(6, 'UTC') - toIntervalDay(${LOOKBACK_DAYS})
GROUP BY hour;
SQL

echo "[hourly-snapshot] rebuilding hourly collection activity rollup"
run_clickhouse <<SQL
INSERT INTO ${DATABASE}.analytics_hourly_collection_activity_rollup
SELECT
    toDateTime64(toStartOfHour(assumeNotNull(created_at)), 0, 'UTC') AS hour,
    uniqExactState(collection) AS active_collection_state
FROM ${DATABASE}.collection_events
WHERE isNotNull(created_at)
  AND did != 'did:web:lexicon.store'
  AND created_at >= now64(6, 'UTC') - toIntervalDay(${LOOKBACK_DAYS})
GROUP BY hour;
SQL

echo "[hourly-snapshot] rebuilding did first_seen state"
run_clickhouse <<SQL
INSERT INTO ${DATABASE}.analytics_did_first_seen_state
SELECT
    did,
    minState(assumeNotNull(created_at)) AS first_seen_state
FROM ${DATABASE}.collection_events
WHERE isNotNull(created_at)
GROUP BY did;
SQL

echo "[hourly-snapshot] rebuilding collection first_seen state"
run_clickhouse <<SQL
INSERT INTO ${DATABASE}.analytics_collection_first_seen_state
SELECT
    collection,
    minState(assumeNotNull(created_at)) AS first_seen_state
FROM ${DATABASE}.collection_events
WHERE isNotNull(created_at)
  AND did != 'did:web:lexicon.store'
GROUP BY collection;
SQL

echo "[hourly-snapshot] rebuilding hourly new did rollup"
run_clickhouse <<SQL
INSERT INTO ${DATABASE}.analytics_hourly_new_did_rollup
SELECT
    dateTrunc('hour', first_seen_at) AS hour,
    count() AS new_count,
    now64(3, 'UTC') AS refreshed_at
FROM
(
    SELECT
        did,
        minMerge(first_seen_state) AS first_seen_at
    FROM ${DATABASE}.analytics_did_first_seen_state
    GROUP BY did
)
WHERE first_seen_at <= now64(6, 'UTC')
GROUP BY hour;
SQL

echo "[hourly-snapshot] rebuilding hourly new collection rollup"
run_clickhouse <<SQL
INSERT INTO ${DATABASE}.analytics_hourly_new_collection_rollup
SELECT
    dateTrunc('hour', first_seen_at) AS hour,
    count() AS new_count,
    now64(3, 'UTC') AS refreshed_at
FROM
(
    SELECT
        collection,
        minMerge(first_seen_state) AS first_seen_at
    FROM ${DATABASE}.analytics_collection_first_seen_state
    GROUP BY collection
)
WHERE first_seen_at <= now64(6, 'UTC')
GROUP BY hour;
SQL

echo "[hourly-snapshot] rollup summary"
query_clickhouse "
SELECT
  'activity' AS kind,
  count() AS rows,
  min(hour) AS min_hour,
  max(hour) AS max_hour,
  countIf(hour > now()) AS future_rows
FROM ${DATABASE}.analytics_hourly_activity_rollup
UNION ALL
SELECT
  'collection_activity' AS kind,
  count() AS rows,
  min(hour) AS min_hour,
  max(hour) AS max_hour,
  countIf(hour > now()) AS future_rows
FROM ${DATABASE}.analytics_hourly_collection_activity_rollup
UNION ALL
SELECT
  'new_did' AS kind,
  count() AS rows,
  min(hour) AS min_hour,
  max(hour) AS max_hour,
  countIf(hour > now()) AS future_rows
FROM ${DATABASE}.analytics_hourly_new_did_rollup
UNION ALL
SELECT
  'new_collection' AS kind,
  count() AS rows,
  min(hour) AS min_hour,
  max(hour) AS max_hour,
  countIf(hour > now()) AS future_rows
FROM ${DATABASE}.analytics_hourly_new_collection_rollup
"

future_rows="$(query_clickhouse "
SELECT
  sum(future_rows)
FROM
(
  SELECT countIf(hour > now()) AS future_rows
  FROM ${DATABASE}.analytics_hourly_activity_rollup
  UNION ALL
  SELECT countIf(hour > now()) AS future_rows
  FROM ${DATABASE}.analytics_hourly_collection_activity_rollup
  UNION ALL
  SELECT countIf(hour > now()) AS future_rows
  FROM ${DATABASE}.analytics_hourly_new_did_rollup
  UNION ALL
  SELECT countIf(hour > now()) AS future_rows
  FROM ${DATABASE}.analytics_hourly_new_collection_rollup
)
")"

if [[ "$future_rows" != "0" ]]; then
  echo "[hourly-snapshot] future rollup rows remain: $future_rows" >&2
  exit 1
fi

echo "[hourly-snapshot] loading ClickHouse client env"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

echo "[hourly-snapshot] publishing analytics chart snapshot from hourly rollups"
ANALYTICS_CHART_REFRESH_SOURCE=hourly pnpm refresh:analytics-charts -- --confirm-production

echo "[hourly-snapshot] latest published snapshot"
query_clickhouse "
WITH latest AS
(
  SELECT refresh_id
  FROM ${DATABASE}.analytics_chart_refresh_manifest
  WHERE status = 'completed'
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  toString(refresh_id) AS refresh_id,
  tool,
  days,
  bucket_days,
  count() AS rows,
  min(date) AS min_date,
  max(date) AS max_date,
  min(latest_at) AS min_latest_at,
  max(latest_at) AS max_latest_at
FROM ${DATABASE}.analytics_chart_snapshot
WHERE refresh_id IN latest
GROUP BY refresh_id, tool, days, bucket_days
ORDER BY tool, days, bucket_days
"

echo "[hourly-snapshot] completed"
