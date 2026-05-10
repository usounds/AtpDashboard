#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != "--confirm" ]]; then
  echo "usage: $0 --confirm" >&2
  exit 2
fi

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
ENV_FILE="${CLICKHOUSE_ENV_FILE:-/etc/atpdashboard/clickhouse.env}"
CLICKHOUSE_CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"
LOCAL_API_URL="${LOCAL_API_URL:-http://127.0.0.1:8787/api/analytics/collection_count_view}"
PUBLIC_API_URL="${PUBLIC_API_URL:-https://dashboardapi.usounds.work/api/analytics/collection_count_view}"
MAX_SOURCE_STALE_MINUTES="${MAX_SOURCE_STALE_MINUTES:-30}"

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

log() {
  echo "[collection-count-read-model] $*"
}

fail() {
  echo "[collection-count-read-model][ERROR] $*" >&2
  exit 1
}

ch() {
  docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --database "$CLICKHOUSE_DATABASE" "$@"
}

http_check() {
  local name="$1"
  local url="$2"
  local headers="/tmp/collection_count_${name}_headers.txt"
  local body="/tmp/collection_count_${name}_body.json"
  local code

  code="$(curl -sS --max-time 45 -D "$headers" -o "$body" -w '%{http_code}' "$url")"
  [[ "$code" =~ ^2[0-9][0-9]$ ]] || fail "$name API returned HTTP $code"
  grep -iq '^x-data-source: clickhouse' "$headers" || fail "$name API did not return X-Data-Source: clickhouse"
  if grep -iq '^x-fallback-reason: .*[^[:space:]]' "$headers"; then
    fail "$name API returned fallback reason"
  fi
  node -e "
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (!Array.isArray(body) || body.length === 0) process.exit(1);
" "$body" || fail "$name API returned empty or invalid JSON"
}

verify_timer_state() {
  for unit in CollectionEventsSync.timer CollectionEventsRescan.timer AnalyticsPresencePipeline.timer CollectionCountReadModelRefresh.timer; do
    "${SUDO[@]}" systemctl is-enabled --quiet "$unit" || fail "$unit is not enabled"
    "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "$unit is not active"
  done

  if "${SUDO[@]}" systemctl is-enabled --quiet CollectionCountRefresh.timer 2>/dev/null; then
    fail "CollectionCountRefresh.timer is still enabled"
  fi
  if "${SUDO[@]}" systemctl is-active --quiet CollectionCountRefresh.timer 2>/dev/null; then
    fail "CollectionCountRefresh.timer is still active"
  fi
}

verify_clickhouse() {
  ch --query "
SELECT throwIf(count() = 0, 'no completed collection_count read model manifest')
FROM atp_dashboard.collection_count_refresh_manifest
WHERE status = 'completed';
"

  ch --query "
WITH latest AS
(
  SELECT refresh_id
  FROM atp_dashboard.collection_count_refresh_manifest
  WHERE status = 'completed'
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  throwIf(count() = 0, 'active collection_count read model is empty'),
  throwIf(count() != uniqExact(collection), 'active collection_count read model has duplicate collection rows')
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = (SELECT refresh_id FROM latest);
"

  ch --query "
SELECT throwIf(dateDiff('minute', max(ingested_at), now64(3, 'UTC')) > ${MAX_SOURCE_STALE_MINUTES}, 'collection_events source is stale')
FROM atp_dashboard.collection_events;
"
}

log "final target state:"
echo "  API: AtpDashboardAnalyticsApi.service active"
echo "  collection_count_view: committed ClickHouse read model snapshot, not raw collection_events"
echo "  enabled timers: CollectionEventsSync, CollectionEventsRescan, AnalyticsPresencePipeline, CollectionCountReadModelRefresh"
echo "  disabled timer: CollectionCountRefresh"
echo "  public API must return X-Data-Source: clickhouse and no fallback reason"

cd "$APP_DIR"

log "loading ClickHouse env"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

log "applying collection_count DDL"
docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --multiquery < sql/clickhouse/002_collection_count_snapshot.sql
docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --multiquery < sql/clickhouse/003_collection_count_refresh.sql

log "refreshing collection_count read model"
pnpm refresh:collection-count -- --confirm-production --stale-running-minutes 60 --recent-hours 72

log "installing systemd units"
"${SUDO[@]}" cp packages/clickhouse-tools/CollectionCountReadModelRefresh.service /etc/systemd/system/
"${SUDO[@]}" cp packages/clickhouse-tools/CollectionCountReadModelRefresh.timer /etc/systemd/system/
"${SUDO[@]}" systemctl daemon-reload

log "converging timers"
"${SUDO[@]}" systemctl stop CollectionCountRefresh.timer CollectionCountRefresh.service 2>/dev/null || true
"${SUDO[@]}" systemctl disable CollectionCountRefresh.timer 2>/dev/null || true
"${SUDO[@]}" systemctl enable --now CollectionEventsSync.timer
"${SUDO[@]}" systemctl enable --now CollectionEventsRescan.timer
"${SUDO[@]}" systemctl enable --now AnalyticsPresencePipeline.timer
"${SUDO[@]}" systemctl enable --now CollectionCountReadModelRefresh.timer

log "restarting API"
"${SUDO[@]}" systemctl restart AtpDashboardAnalyticsApi.service

log "verifying ClickHouse"
verify_clickhouse

log "verifying timer state"
verify_timer_state

log "verifying local API"
http_check local "$LOCAL_API_URL"

log "verifying public API"
http_check public "$PUBLIC_API_URL"

log "final timers"
"${SUDO[@]}" systemctl --no-pager list-timers 'Analytics*' 'Collection*'

log "completed"
