#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"

if [[ "${1:-}" != "--confirm" ]]; then
  echo "Usage: $0 --confirm" >&2
  exit 2
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

echo "[presence-rollback] disabling presence timer"
"${SUDO[@]}" systemctl stop AnalyticsPresencePipeline.timer AnalyticsPresencePipeline.service 2>/dev/null || true
"${SUDO[@]}" systemctl disable AnalyticsPresencePipeline.timer 2>/dev/null || true

previous_refresh_id="$(ch --query "
SELECT toString(refresh_id)
FROM ${DATABASE}.analytics_chart_refresh_manifest
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 2
" | tail -n 1)"

if [[ -n "$previous_refresh_id" ]]; then
  rollback_refresh_id="$(node -e "console.log(crypto.randomUUID())")"
  echo "[presence-rollback] republishing previous snapshot previous=$previous_refresh_id rollback=$rollback_refresh_id"
  ch --query "
INSERT INTO ${DATABASE}.analytics_chart_snapshot
SELECT
  toUUID('${rollback_refresh_id}') AS refresh_id,
  tool,
  days,
  bucket_days,
  bucket_index,
  date,
  day_offset,
  active,
  new,
  count,
  latest_at,
  now64(3, 'UTC') AS refreshed_at
FROM ${DATABASE}.analytics_chart_snapshot
WHERE refresh_id = toUUID('${previous_refresh_id}')
"
  ch --query "
INSERT INTO ${DATABASE}.analytics_chart_refresh_manifest
SELECT
  toUUID('${rollback_refresh_id}') AS refresh_id,
  'completed' AS status,
  now64(3, 'UTC') AS started_at,
  now64(3, 'UTC') AS completed_at,
  count() AS row_count,
  NULL AS error_message,
  now64(3, 'UTC') AS updated_at
FROM ${DATABASE}.analytics_chart_snapshot
WHERE refresh_id = toUUID('${rollback_refresh_id}')
"
fi

echo "[presence-rollback] restoring legacy analytics timers"
"${SUDO[@]}" systemctl enable --now AnalyticsChartsRefresh.timer 2>/dev/null || true
"${SUDO[@]}" systemctl enable --now AnalyticsHourlyNewRefresh.timer 2>/dev/null || true
"${SUDO[@]}" systemctl --no-pager list-timers 'Analytics*' 'Collection*' || true
"${SUDO[@]}" systemctl --no-pager --failed || true
echo "[presence-rollback] completed"
