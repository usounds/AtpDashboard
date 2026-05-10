#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
CUSTOMFEEDDB_CONTAINER="${CUSTOMFEEDDB_CONTAINER:-customfeeddb-postgres}"
CUSTOMFEEDDB_DATABASE="${CUSTOMFEEDDB_DATABASE:-ocustomfeeddb}"
CONFIRM=false

usage() {
  cat >&2 <<USAGE
Usage: $0 --confirm

Disables known heavy analytics jobs while keeping collection event sync running.
This is an operational safety script, not a deploy script.

Final target state:
  keep enabled: CollectionEventsSync.timer
  keep enabled: CollectionEventsRescan.timer
  disable: AnalyticsPresencePipeline.timer
  disable: AnalyticsChartsRefresh.timer
  disable: AnalyticsHourlyNewRefresh.timer
  disable: CollectionCountReadModelRefresh.timer
  disable: CollectionCountRefresh.timer
  remove from user crontab: REFRESH MATERIALIZED VIEW CONCURRENTLY collection_stats
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm)
      CONFIRM=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[stabilize] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$CONFIRM" != true ]]; then
  echo "[stabilize] refusing without --confirm" >&2
  usage
  exit 2
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

cd "$APP_DIR"

echo "[stabilize] final target state:"
echo "  CollectionEventsSync.timer: enabled/running"
echo "  CollectionEventsRescan.timer: enabled/running"
echo "  AnalyticsPresencePipeline.timer: disabled"
echo "  AnalyticsChartsRefresh.timer: disabled"
echo "  AnalyticsHourlyNewRefresh.timer: disabled"
echo "  CollectionCountReadModelRefresh.timer: disabled"
echo "  CollectionCountRefresh.timer: disabled"
echo "  user crontab hourly collection_stats materialized view refresh: removed"

backup="/tmp/usounds.cron.backup.$(date +%Y%m%d%H%M%S)"
if crontab -l > "$backup" 2>/dev/null; then
  if grep -q 'REFRESH MATERIALIZED VIEW CONCURRENTLY collection_stats' "$backup"; then
    echo "[stabilize] backing up crontab to $backup and removing hourly collection_stats refresh"
    grep -v 'REFRESH MATERIALIZED VIEW CONCURRENTLY collection_stats' "$backup" | crontab -
  else
    echo "[stabilize] hourly collection_stats refresh is already absent from user crontab"
  fi
else
  echo "[stabilize] no user crontab found"
fi

echo "[stabilize] stopping heavy timers/services"
"${SUDO[@]}" systemctl stop \
  AnalyticsPresencePipeline.timer AnalyticsPresencePipeline.service \
  AnalyticsChartsRefresh.timer AnalyticsChartsRefresh.service \
  AnalyticsHourlyNewRefresh.timer AnalyticsHourlyNewRefresh.service \
  CollectionCountReadModelRefresh.timer CollectionCountReadModelRefresh.service \
  CollectionCountRefresh.timer CollectionCountRefresh.service \
  2>/dev/null || true

echo "[stabilize] disabling heavy timers"
"${SUDO[@]}" systemctl disable \
  AnalyticsPresencePipeline.timer \
  AnalyticsChartsRefresh.timer \
  AnalyticsHourlyNewRefresh.timer \
  CollectionCountReadModelRefresh.timer \
  CollectionCountRefresh.timer \
  2>/dev/null || true

echo "[stabilize] keeping CollectionEventsSync.timer enabled"
"${SUDO[@]}" systemctl enable --now CollectionEventsSync.timer 2>/dev/null || true
echo "[stabilize] keeping CollectionEventsRescan.timer enabled"
"${SUDO[@]}" systemctl enable --now CollectionEventsRescan.timer 2>/dev/null || true

echo "[stabilize] checking active materialized view refresh"
if docker ps --format '{{.Names}}' | grep -Fx "$CUSTOMFEEDDB_CONTAINER" >/dev/null 2>&1; then
  docker exec -i "$CUSTOMFEEDDB_CONTAINER" psql -U postgres -d "$CUSTOMFEEDDB_DATABASE" -c "
SELECT
  pid,
  state,
  now() - query_start AS runtime,
  left(query, 240) AS query
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND query ILIKE '%REFRESH MATERIALIZED VIEW%';
"
else
  echo "[stabilize] container not running: $CUSTOMFEEDDB_CONTAINER"
fi

echo "[stabilize] final timer state"
"${SUDO[@]}" systemctl reset-failed
"${SUDO[@]}" systemctl --no-pager list-timers 'Analytics*' 'Collection*'
"${SUDO[@]}" systemctl --no-pager --failed

active_heavy="$("${SUDO[@]}" systemctl is-enabled \
  AnalyticsPresencePipeline.timer \
  AnalyticsChartsRefresh.timer \
  AnalyticsHourlyNewRefresh.timer \
  CollectionCountReadModelRefresh.timer \
  CollectionCountRefresh.timer \
  2>/dev/null | grep -c '^enabled$' || true)"

if [[ "$active_heavy" != "0" ]]; then
  echo "[stabilize] heavy timer state check failed enabled_count=$active_heavy" >&2
  exit 1
fi

echo "[stabilize] completed"
