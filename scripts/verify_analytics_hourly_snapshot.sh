#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"
REFRESH_ID="${ANALYTICS_CHART_REFRESH_ID:-}"
EXPECTED_SNAPSHOT_ROWS="${EXPECTED_ANALYTICS_CHART_SNAPSHOT_ROWS:-150}"
EXPECTED_CHART_GROUPS="${EXPECTED_ANALYTICS_CHART_GROUPS:-9}"

usage() {
  cat >&2 <<USAGE
Usage: $0 [--refresh-id UUID]

Verifies the latest published hourly analytics chart snapshot and exits non-zero
if manifest, snapshot, rollup, or future-row checks fail.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --refresh-id)
      REFRESH_ID="${2:-}"
      if [[ -z "$REFRESH_ID" ]]; then
        echo "[verify-hourly-snapshot] --refresh-id requires a value" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[verify-hourly-snapshot] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ ! -d "$APP_DIR" ]]; then
  echo "[verify-hourly-snapshot] APP_DIR does not exist: $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

query_clickhouse() {
  docker exec -i "$CONTAINER" clickhouse-client --query "$1"
}

fail() {
  echo "[verify-hourly-snapshot] FAIL: $*" >&2
  exit 1
}

pass() {
  echo "[verify-hourly-snapshot] ok: $*"
}

echo "[verify-hourly-snapshot] container=$CONTAINER database=$DATABASE"

if [[ -z "$REFRESH_ID" ]]; then
  REFRESH_ID="$(query_clickhouse "
SELECT toString(refresh_id)
FROM ${DATABASE}.analytics_chart_refresh_manifest
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 1
")"
fi

[[ -n "$REFRESH_ID" ]] || fail "no completed analytics chart refresh found"

echo "[verify-hourly-snapshot] refresh_id=$REFRESH_ID"

manifest_status="$(query_clickhouse "
SELECT status
FROM ${DATABASE}.analytics_chart_refresh_manifest
WHERE refresh_id = '${REFRESH_ID}'
ORDER BY updated_at DESC
LIMIT 1
")"
[[ "$manifest_status" == "completed" ]] || fail "manifest status is ${manifest_status:-empty}, expected completed"
pass "manifest status completed"

manifest_row_count="$(query_clickhouse "
SELECT row_count
FROM ${DATABASE}.analytics_chart_refresh_manifest
WHERE refresh_id = '${REFRESH_ID}'
  AND status = 'completed'
ORDER BY updated_at DESC
LIMIT 1
")"

snapshot_row_count="$(query_clickhouse "
SELECT count()
FROM ${DATABASE}.analytics_chart_snapshot
WHERE refresh_id = '${REFRESH_ID}'
")"

[[ "$snapshot_row_count" == "$manifest_row_count" ]] || fail "snapshot rows $snapshot_row_count != manifest row_count $manifest_row_count"
[[ "$snapshot_row_count" == "$EXPECTED_SNAPSHOT_ROWS" ]] || fail "snapshot rows $snapshot_row_count != expected $EXPECTED_SNAPSHOT_ROWS"
pass "snapshot rows $snapshot_row_count"

chart_group_count="$(query_clickhouse "
SELECT count()
FROM
(
  SELECT tool, days, bucket_days
  FROM ${DATABASE}.analytics_chart_snapshot
  WHERE refresh_id = '${REFRESH_ID}'
  GROUP BY tool, days, bucket_days
)
")"
[[ "$chart_group_count" == "$EXPECTED_CHART_GROUPS" ]] || fail "chart groups $chart_group_count != expected $EXPECTED_CHART_GROUPS"
pass "chart groups $chart_group_count"

bad_snapshot_rows="$(query_clickhouse "
SELECT count()
FROM ${DATABASE}.analytics_chart_snapshot
WHERE refresh_id = '${REFRESH_ID}'
  AND (isNull(latest_at) OR date > today('UTC'))
")"
[[ "$bad_snapshot_rows" == "0" ]] || fail "snapshot has $bad_snapshot_rows rows with NULL latest_at or future date"
pass "snapshot latest_at/date sanity"

rollup_future_rows="$(query_clickhouse "
SELECT sum(future_rows)
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
[[ "$rollup_future_rows" == "0" ]] || fail "hourly rollups have $rollup_future_rows future rows"
pass "hourly rollups have no future rows"

empty_rollups="$(query_clickhouse "
SELECT countIf(rows = 0)
FROM
(
  SELECT count() AS rows FROM ${DATABASE}.analytics_hourly_activity_rollup
  UNION ALL
  SELECT count() AS rows FROM ${DATABASE}.analytics_hourly_collection_activity_rollup
  UNION ALL
  SELECT count() AS rows FROM ${DATABASE}.analytics_hourly_new_did_rollup
  UNION ALL
  SELECT count() AS rows FROM ${DATABASE}.analytics_hourly_new_collection_rollup
)
")"
[[ "$empty_rollups" == "0" ]] || fail "$empty_rollups hourly rollup tables are empty"
pass "hourly rollup tables are populated"

latest_rollup_at="$(query_clickhouse "
SELECT toString(maxMerge(latest_at_state))
FROM ${DATABASE}.analytics_hourly_activity_rollup
")"

latest_snapshot_at="$(query_clickhouse "
SELECT toString(max(latest_at))
FROM ${DATABASE}.analytics_chart_snapshot
WHERE refresh_id = '${REFRESH_ID}'
")"

[[ "$latest_snapshot_at" == "$latest_rollup_at" ]] || fail "snapshot latest_at $latest_snapshot_at != hourly rollup latest_at $latest_rollup_at"
pass "snapshot latest_at matches hourly rollup latest_at $latest_snapshot_at"

echo "[verify-hourly-snapshot] rollup summary"
query_clickhouse "
SELECT
  kind,
  rows,
  min_hour,
  max_hour,
  future_rows
FROM
(
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
)
ORDER BY kind
"

echo "[verify-hourly-snapshot] latest snapshot summary"
query_clickhouse "
SELECT
  tool,
  days,
  bucket_days,
  count() AS rows,
  min(date) AS min_date,
  max(date) AS max_date,
  max(latest_at) AS latest_at
FROM ${DATABASE}.analytics_chart_snapshot
WHERE refresh_id = '${REFRESH_ID}'
GROUP BY tool, days, bucket_days
ORDER BY tool, days, bucket_days
"

echo "[verify-hourly-snapshot] completed"
