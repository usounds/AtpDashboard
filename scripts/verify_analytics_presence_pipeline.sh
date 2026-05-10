#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
ENV_FILE="${CLICKHOUSE_ENV_FILE:-/etc/atpdashboard/clickhouse.env}"
RUN_ID=""
CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm)
      CONFIRM=true
      shift
      ;;
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    *)
      echo "[presence-verify] unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$CONFIRM" != true && "${ANALYTICS_PRESENCE_CONFIRM:-}" != "1" ]]; then
  echo "[presence-verify] refusing without --confirm" >&2
  exit 2
fi

cd "$APP_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

args=(--confirm-production)
if [[ -n "$RUN_ID" ]]; then
  args+=(--run-id "$RUN_ID")
fi

pnpm verify:analytics-presence -- "${args[@]}"

if grep -En "function buildPresence|source=presence|AnalyticsPresencePipeline" packages/clickhouse-tools/src/refresh-analytics-chart-snapshot.ts packages/clickhouse-tools/AnalyticsPresencePipeline.service >/dev/null 2>&1; then
  :
fi

if grep -En "uniqExactMerge" packages/clickhouse-tools/src/refresh-analytics-chart-snapshot.ts | grep -E "Presence|presence|analytics_hourly_(did|collection|event)" >/dev/null 2>&1; then
  echo "[presence-verify] uniqExactMerge appears in presence path" >&2
  exit 1
fi

echo "[presence-verify] completed"
