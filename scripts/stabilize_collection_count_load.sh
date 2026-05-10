#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
LOCAL_API_URL="${LOCAL_API_URL:-http://127.0.0.1:8787/api/analytics/collection_count_view}"
CONFIRM=false

usage() {
  cat >&2 <<USAGE
Usage: $0 --confirm

Stops the collection_count full-refresh load source while keeping event ingestion current.
This is an operational safety script, not a deploy script.

Final target state:
  enabled/active: CollectionEventsSync.timer
  enabled/active: CollectionEventsRescan.timer
  disabled/inactive: CollectionCountReadModelRefresh.timer/service
  disabled/inactive: CollectionCountRefresh.timer/service
  API: continues to serve the latest available collection_count snapshot/fallback
  semantic impact: collection_count read model full refresh is paused; raw event sync/rescan stays live
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
      echo "[collection-count-stabilize] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$CONFIRM" != true ]]; then
  echo "[collection-count-stabilize] refusing without --confirm" >&2
  usage
  exit 2
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

cd "$APP_DIR"

echo "[collection-count-stabilize] final target state:"
echo "  CollectionEventsSync.timer: enabled/active"
echo "  CollectionEventsRescan.timer: enabled/active"
echo "  CollectionCountReadModelRefresh.timer/service: disabled/inactive"
echo "  CollectionCountRefresh.timer/service: disabled/inactive"
echo "  API: latest available collection_count response remains served"
echo "  semantic impact: collection_count full refresh is paused; event ingestion/rescan stays live"

echo "[collection-count-stabilize] stopping collection_count full-refresh timers/services"
"${SUDO[@]}" systemctl stop \
  CollectionCountReadModelRefresh.timer CollectionCountReadModelRefresh.service \
  CollectionCountRefresh.timer CollectionCountRefresh.service \
  2>/dev/null || true

echo "[collection-count-stabilize] disabling collection_count full-refresh timers"
"${SUDO[@]}" systemctl disable \
  CollectionCountReadModelRefresh.timer \
  CollectionCountRefresh.timer \
  2>/dev/null || true

echo "[collection-count-stabilize] keeping event sync/rescan timers enabled"
"${SUDO[@]}" systemctl enable --now CollectionEventsSync.timer 2>/dev/null || true
"${SUDO[@]}" systemctl enable --now CollectionEventsRescan.timer 2>/dev/null || true

echo "[collection-count-stabilize] resetting failed unit state"
"${SUDO[@]}" systemctl reset-failed

echo "[collection-count-stabilize] checking API response"
api_headers="$(mktemp)"
api_body="$(mktemp)"
api_status="000"
if api_status="$(curl -sS -m 20 -D "$api_headers" -o "$api_body" -w '%{http_code}' "$LOCAL_API_URL" 2>/tmp/collection_count_stabilize_curl.err)"; then
  echo "[collection-count-stabilize] local API HTTP $api_status"
  grep -Ei '^(x-data-source|x-fallback-reason|x-snapshot-refresh-id|x-snapshot-refreshed-at):' "$api_headers" || true
  head -c 300 "$api_body" || true
  echo
else
  echo "[collection-count-stabilize] local API request failed" >&2
  cat /tmp/collection_count_stabilize_curl.err >&2 || true
  api_status="000"
fi
rm -f "$api_headers" "$api_body" /tmp/collection_count_stabilize_curl.err

if [[ ! "$api_status" =~ ^[23] ]]; then
  echo "[collection-count-stabilize] API response check failed status=$api_status" >&2
  exit 1
fi

echo "[collection-count-stabilize] final timer state"
"${SUDO[@]}" systemctl --no-pager list-timers 'Analytics*' 'Collection*'
"${SUDO[@]}" systemctl --no-pager --failed

echo "[collection-count-stabilize] machine-checking unit states"
enabled_heavy="$("${SUDO[@]}" systemctl is-enabled \
  CollectionCountReadModelRefresh.timer \
  CollectionCountRefresh.timer \
  2>/dev/null | grep -c '^enabled$' || true)"

active_heavy="$("${SUDO[@]}" systemctl is-active \
  CollectionCountReadModelRefresh.timer CollectionCountReadModelRefresh.service \
  CollectionCountRefresh.timer CollectionCountRefresh.service \
  2>/dev/null | grep -c '^active$' || true)"

missing_ingest=0
for timer in CollectionEventsSync.timer CollectionEventsRescan.timer; do
  if ! "${SUDO[@]}" systemctl is-enabled "$timer" >/dev/null 2>&1; then
    echo "[collection-count-stabilize] required timer is not enabled: $timer" >&2
    missing_ingest=1
  fi
  if ! "${SUDO[@]}" systemctl is-active "$timer" >/dev/null 2>&1; then
    echo "[collection-count-stabilize] required timer is not active: $timer" >&2
    missing_ingest=1
  fi
done

if [[ "$enabled_heavy" != "0" || "$active_heavy" != "0" || "$missing_ingest" != "0" ]]; then
  echo "[collection-count-stabilize] final state check failed enabled_heavy=$enabled_heavy active_heavy=$active_heavy missing_ingest=$missing_ingest" >&2
  exit 1
fi

echo "[collection-count-stabilize] completed"
