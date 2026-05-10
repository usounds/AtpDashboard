#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
ENV_FILE="${CLICKHOUSE_ENV_FILE:-/etc/atpdashboard/clickhouse.env}"
CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"
RUN_ID="${ANALYTICS_PRESENCE_RUN_ID:-}"
PERIODIC=false
CONFIRM=false

usage() {
  cat >&2 <<USAGE
Usage: $0 --confirm [--periodic]

Deploys or runs the analytics presence pipeline. Manual deploy mode installs the
new systemd timer, disables legacy analytics timers, and verifies the final state.
Periodic mode only runs the pipeline and publishes a verified snapshot.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm)
      CONFIRM=true
      shift
      ;;
    --periodic)
      PERIODIC=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[presence-deploy] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$CONFIRM" != true && "${ANALYTICS_PRESENCE_CONFIRM:-}" != "1" ]]; then
  echo "[presence-deploy] refusing without --confirm" >&2
  usage
  exit 2
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "[presence-deploy] APP_DIR does not exist: $APP_DIR" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[presence-deploy] env file does not exist: $ENV_FILE" >&2
  exit 1
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(node -e "console.log(crypto.randomUUID())")"
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

cd "$APP_DIR"

ch() {
  docker exec -i "$CONTAINER" clickhouse-client "$@"
}

finalize_failed() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "[presence-deploy] failed run_id=$RUN_ID status=$status" >&2
    if [[ "$PERIODIC" != true ]]; then
      scripts/rollback_analytics_presence_pipeline.sh --confirm || true
    fi
  fi
  exit "$status"
}
trap finalize_failed EXIT

echo "[presence-deploy] final target state:"
echo "  AnalyticsPresencePipeline.timer: enabled, OnCalendar=*:17, Persistent=false"
echo "  AnalyticsChartsRefresh.timer: disabled"
echo "  AnalyticsHourlyNewRefresh.timer: disabled"
echo "  CollectionCountRefresh.timer: stays disabled until its full-scan refresh is replaced"
echo "  API/frontend: unchanged, reads analytics_chart_snapshot"
echo "  source: presence event source ordered by ingested_at; scheduled path does not use uniqExactMerge or broad raw scans"
echo "[presence-deploy] run_id=$RUN_ID periodic=$PERIODIC"

echo "[presence-deploy] loading ClickHouse env"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

export CLICKHOUSE_MAX_THREADS="${CLICKHOUSE_MAX_THREADS:-1}"
export CLICKHOUSE_MAX_INSERT_THREADS="${CLICKHOUSE_MAX_INSERT_THREADS:-1}"
export CLICKHOUSE_MAX_MEMORY_USAGE="${CLICKHOUSE_MAX_MEMORY_USAGE:-3000000000}"
export ANALYTICS_PRESENCE_BACKFILL_DAYS="${ANALYTICS_PRESENCE_BACKFILL_DAYS:-370}"
export ANALYTICS_PRESENCE_CHUNK_DAYS="${ANALYTICS_PRESENCE_CHUNK_DAYS:-1}"

echo "[presence-deploy] applying ClickHouse DDL"
ch --multiquery < sql/clickhouse/004_analytics_chart_snapshot.sql
ch --multiquery < sql/clickhouse/005_analytics_chart_rollups.sql
ch --multiquery < sql/clickhouse/006_analytics_presence_pipeline.sql

source_rows="$(ch --query "SELECT count() FROM ${DATABASE}.analytics_presence_event_source")"
source_backfilled="$(ch --query "SELECT count() FROM ${DATABASE}.analytics_presence_watermarks WHERE name = 'event_source_backfill'")"
if [[ "$source_backfilled" == "0" ]]; then
  echo "[presence-deploy] backfilling analytics_presence_event_source once current_rows=$source_rows"
  ch \
    --max_threads=1 \
    --max_insert_threads=1 \
    --max_memory_usage="${CLICKHOUSE_MAX_MEMORY_USAGE:-3000000000}" \
    --query "
INSERT INTO ${DATABASE}.analytics_presence_event_source
SELECT
  event_key,
  did,
  collection,
  assumeNotNull(created_at) AS created_at,
  toDateTime64(toStartOfHour(assumeNotNull(created_at)), 0, 'UTC') AS hour,
  ingested_at
FROM ${DATABASE}.collection_events
WHERE isNotNull(created_at)
  AND created_at >= now64(6, 'UTC') - toIntervalDay(${ANALYTICS_PRESENCE_BACKFILL_DAYS})
"
  ch --query "
INSERT INTO ${DATABASE}.analytics_presence_watermarks
SELECT
  'event_source_backfill' AS name,
  now64(3, 'UTC') AS processed_ingested_at,
  toUUID('${RUN_ID}') AS run_id,
  now64(3, 'UTC') AS updated_at
"
else
  echo "[presence-deploy] analytics_presence_event_source backfill already recorded rows=$source_rows; skipping full source backfill"
fi

echo "[presence-deploy] preparing presence run"
pnpm refresh:analytics-presence -- --confirm-production --run-id "$RUN_ID" --backfill-days "$ANALYTICS_PRESENCE_BACKFILL_DAYS" --chunk-days "$ANALYTICS_PRESENCE_CHUNK_DAYS"

echo "[presence-deploy] publishing snapshot from presence source"
ANALYTICS_CHART_REFRESH_SOURCE=presence pnpm refresh:analytics-charts -- --confirm-production

latest_refresh_id="$(ch --query "
SELECT toString(refresh_id)
FROM ${DATABASE}.analytics_chart_refresh_manifest
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 1
")"

ch --query "
INSERT INTO ${DATABASE}.analytics_presence_run_status
SELECT
  toUUID('${RUN_ID}') AS run_id,
  'published' AS status,
  'publish' AS phase,
  started_at,
  verified_at,
  now64(3, 'UTC') AS published_at,
  now64(3, 'UTC') AS completed_at,
  cutoff_ingested_at,
  processed_ingested_at,
  source_latest_at,
  source_latest_hour,
  previous_refresh_id,
  toUUID('${latest_refresh_id}') AS published_refresh_id,
  150 AS row_count,
  NULL AS error_message,
  now64(3, 'UTC') AS updated_at
FROM ${DATABASE}.analytics_presence_run_status
WHERE run_id = toUUID('${RUN_ID}')
ORDER BY updated_at DESC
LIMIT 1
"

echo "[presence-deploy] verifying published snapshot"
scripts/verify_analytics_presence_pipeline.sh --confirm --run-id "$RUN_ID"

if [[ "$PERIODIC" != true ]]; then
  echo "[presence-deploy] installing systemd units"
  "${SUDO[@]}" cp packages/clickhouse-tools/AnalyticsPresencePipeline.service /etc/systemd/system/
  "${SUDO[@]}" cp packages/clickhouse-tools/AnalyticsPresencePipeline.timer /etc/systemd/system/
  "${SUDO[@]}" systemctl daemon-reload

  echo "[presence-deploy] disabling legacy analytics timers"
  "${SUDO[@]}" systemctl stop AnalyticsChartsRefresh.timer AnalyticsChartsRefresh.service AnalyticsHourlyNewRefresh.timer AnalyticsHourlyNewRefresh.service CollectionCountRefresh.timer CollectionCountRefresh.service 2>/dev/null || true
  "${SUDO[@]}" systemctl disable AnalyticsChartsRefresh.timer AnalyticsHourlyNewRefresh.timer CollectionCountRefresh.timer 2>/dev/null || true

  echo "[presence-deploy] enabling presence timer"
  "${SUDO[@]}" systemctl enable --now AnalyticsPresencePipeline.timer
  "${SUDO[@]}" systemctl restart AnalyticsPresencePipeline.timer

  echo "[presence-deploy] final systemd check"
  "${SUDO[@]}" systemctl --no-pager list-timers 'Analytics*' 'Collection*'
  "${SUDO[@]}" systemctl --no-pager --failed

  active_legacy="$("${SUDO[@]}" systemctl is-enabled AnalyticsChartsRefresh.timer AnalyticsHourlyNewRefresh.timer CollectionCountRefresh.timer 2>/dev/null | grep -c '^enabled$' || true)"
  presence_enabled="$("${SUDO[@]}" systemctl is-enabled AnalyticsPresencePipeline.timer 2>/dev/null || true)"
  if [[ "$active_legacy" != "0" || "$presence_enabled" != "enabled" ]]; then
    echo "[presence-deploy] final timer state check failed legacy_enabled=$active_legacy presence_enabled=$presence_enabled" >&2
    exit 1
  fi
fi

trap - EXIT
echo "[presence-deploy] completed run_id=$RUN_ID refresh_id=$latest_refresh_id"
