#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"

if [[ "${1:-}" != "--confirm" ]]; then
  echo "Usage: $0 --confirm" >&2
  echo "This truncates and rebuilds unused analytics first_seen/hourly_new rollup tables." >&2
  exit 2
fi

run_clickhouse() {
  docker exec -i "$CONTAINER" clickhouse-client --multiquery
}

query_clickhouse() {
  docker exec -i "$CONTAINER" clickhouse-client --query "$1"
}

echo "[repair] container=$CONTAINER database=$DATABASE"

echo "[repair] raw future rows"
query_clickhouse "
SELECT
  count() AS future_rows,
  min(created_at) AS min_future_created_at,
  max(created_at) AS max_future_created_at
FROM ${DATABASE}.collection_events
WHERE isNotNull(created_at)
  AND created_at > now64(6, 'UTC')
"

echo "[repair] truncating derived first_seen/hourly_new rollups"
run_clickhouse <<SQL
TRUNCATE TABLE ${DATABASE}.analytics_did_first_seen_state;
TRUNCATE TABLE ${DATABASE}.analytics_collection_first_seen_state;
TRUNCATE TABLE ${DATABASE}.analytics_hourly_new_did_rollup;
TRUNCATE TABLE ${DATABASE}.analytics_hourly_new_collection_rollup;
SQL

echo "[repair] rebuilding did first_seen state"
run_clickhouse <<SQL
INSERT INTO ${DATABASE}.analytics_did_first_seen_state
SELECT
    did,
    minState(assumeNotNull(created_at)) AS first_seen_state
FROM ${DATABASE}.collection_events
WHERE isNotNull(created_at)
GROUP BY did;
SQL

echo "[repair] rebuilding collection first_seen state"
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

echo "[repair] rebuilding hourly new did rollup"
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

echo "[repair] rebuilding hourly new collection rollup"
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

echo "[repair] summary"
query_clickhouse "
SELECT
  'did' AS kind,
  count() AS rows,
  min(hour) AS min_hour,
  max(hour) AS max_hour,
  countIf(hour > now()) AS future_rows
FROM ${DATABASE}.analytics_hourly_new_did_rollup
UNION ALL
SELECT
  'collection' AS kind,
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
  FROM ${DATABASE}.analytics_hourly_new_did_rollup
  UNION ALL
  SELECT countIf(hour > now()) AS future_rows
  FROM ${DATABASE}.analytics_hourly_new_collection_rollup
)
")"

if [[ "$future_rows" != "0" ]]; then
  echo "[repair] future rows remain: $future_rows" >&2
  exit 1
fi

echo "[repair] completed"
