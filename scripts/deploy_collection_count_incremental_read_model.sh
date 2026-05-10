#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
ENV_FILE="${CLICKHOUSE_ENV_FILE:-/etc/atpdashboard/clickhouse.env}"
CLICKHOUSE_CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"
LOCAL_API_BASE_URL="${LOCAL_API_BASE_URL:-http://127.0.0.1:8787/api/analytics}"
PUBLIC_API_BASE_URL="${PUBLIC_API_BASE_URL:-https://dashboardapi.usounds.work/api/analytics}"
BOOTSTRAP_MAX_ROWS="${BOOTSTRAP_MAX_ROWS:-500000}"
BOOTSTRAP_MAX_LOOPS="${BOOTSTRAP_MAX_LOOPS:-1000}"
BOOTSTRAP_LOCK_RETRY_SECONDS="${BOOTSTRAP_LOCK_RETRY_SECONDS:-30}"
BOOTSTRAP_LOCK_MAX_WAIT_SECONDS="${BOOTSTRAP_LOCK_MAX_WAIT_SECONDS:-1800}"
INCREMENTAL_MAX_ROWS="${INCREMENTAL_MAX_ROWS:-500000}"
INCREMENTAL_MAX_SPAN_SECONDS="${INCREMENTAL_MAX_SPAN_SECONDS:-600}"
INCREMENTAL_MAX_ESTIMATED_BYTES="${INCREMENTAL_MAX_ESTIMATED_BYTES:-536870912}"
SAFETY_LAG_SECONDS="${SAFETY_LAG_SECONDS:-300}"
COLLECTION_COUNT_RETENTION_MODE="${COLLECTION_COUNT_RETENTION_MODE:-safe-disabled}"
CONFIRM=false

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/deploy_collection_count_incremental_read_model.sh --confirm

Runs the complete one-shot production deployment for the incremental collection
count read model. The incremental timer remains disabled until dual-write,
bootstrap, repair, publish, API, P1, retention, and load-reduction gates pass.
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
      echo "[collection-count-incremental-deploy] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$CONFIRM" != true ]]; then
  echo "[collection-count-incremental-deploy] refusing without --confirm" >&2
  usage
  exit 2
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

log() {
  echo "[collection-count-incremental-deploy] $*"
}

fail() {
  echo "[collection-count-incremental-deploy][ERROR] $*" >&2
  exit 1
}

on_failure() {
  local status=$?
  trap - EXIT
  echo "[collection-count-incremental-deploy][ERROR] failed status=$status" >&2
  echo "[collection-count-incremental-deploy] failure finalizer: disabling collection count refresh timers" >&2
  "${SUDO[@]}" systemctl stop CollectionCountIncrementalRefresh.timer CollectionCountIncrementalRefresh.service 2>/dev/null || true
  "${SUDO[@]}" systemctl disable CollectionCountIncrementalRefresh.timer 2>/dev/null || true
  "${SUDO[@]}" systemctl stop CollectionCountReadModelRefresh.timer CollectionCountReadModelRefresh.service 2>/dev/null || true
  "${SUDO[@]}" systemctl disable CollectionCountReadModelRefresh.timer 2>/dev/null || true
  "${SUDO[@]}" systemctl stop CollectionCountRefresh.timer CollectionCountRefresh.service 2>/dev/null || true
  "${SUDO[@]}" systemctl disable CollectionCountRefresh.timer 2>/dev/null || true
  "${SUDO[@]}" systemctl reset-failed 2>/dev/null || true
  exit "$status"
}
trap on_failure EXIT

ch() {
  docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --database "$CLICKHOUSE_DATABASE" "$@"
}

scalar() {
  ch --query "$1"
}

require_file_without_pre_cutover_hazards() {
  local file="$1"
  local sql_body
  sql_body="$(grep -Ev '^[[:space:]]*--' "$file")"
  if grep -Ein '\b(RENAME|DETACH)\b|DROP[[:space:]]+(TABLE|VIEW|DATABASE)|CREATE[[:space:]]+OR[[:space:]]+REPLACE.*collection_count_refresh_manifest' <<<"$sql_body" >/dev/null; then
    fail "pre-cutover path contains live manifest rename/drop/replace hazard: $file"
  fi
  if grep -Ein 'collection_count_refresh_manifest[[:space:]]+AS|TO[[:space:]]+collection_count_refresh_manifest\b' <<<"$sql_body" | grep -v 'collection_count_refresh_manifest_v2' >/dev/null 2>&1; then
    fail "pre-cutover path can shadow live collection_count_refresh_manifest: $file"
  fi
}

assert_systemd_scope_allowlist() {
  local bad_units
  bad_units="$(grep -Eoh '[A-Za-z0-9@_.-]+\.(service|timer)' \
      scripts/deploy_collection_count_incremental_read_model.sh \
      scripts/rollback_collection_count_incremental_read_model.sh \
    | sort -u \
    | grep -Ev '^(AtpDashboardAnalyticsApi\.service|CollectionEventsSync\.(service|timer)|CollectionEventsRescan\.(service|timer)|CollectionCountIncrementalRefresh\.(service|timer)|CollectionCountReadModelRefresh\.(service|timer)|CollectionCountRefresh\.(service|timer))$' \
    || true)"

  if [[ -n "$bad_units" ]]; then
    echo "$bad_units" >&2
    fail "systemd scope contains non-AtpDashboard collection-count units"
  fi
}

stop_disable_legacy_full_refresh() {
  log "stopping/disabling old full refresh timer/service"
  "${SUDO[@]}" systemctl stop CollectionCountReadModelRefresh.timer CollectionCountReadModelRefresh.service 2>/dev/null || true
  "${SUDO[@]}" systemctl disable CollectionCountReadModelRefresh.timer 2>/dev/null || true
  "${SUDO[@]}" systemctl stop CollectionCountRefresh.timer CollectionCountRefresh.service 2>/dev/null || true
  "${SUDO[@]}" systemctl disable CollectionCountRefresh.timer 2>/dev/null || true
}

install_units_with_incremental_timer_disabled() {
  log "installing systemd units; CollectionCountIncrementalRefresh.timer stays disabled/inactive"
  "${SUDO[@]}" cp packages/clickhouse-tools/CollectionEventsSync.service /etc/systemd/system/
  "${SUDO[@]}" cp packages/clickhouse-tools/CollectionEventsSync.timer /etc/systemd/system/
  "${SUDO[@]}" cp packages/clickhouse-tools/CollectionEventsRescan.service /etc/systemd/system/
  "${SUDO[@]}" cp packages/clickhouse-tools/CollectionEventsRescan.timer /etc/systemd/system/
  "${SUDO[@]}" cp packages/clickhouse-tools/CollectionCountIncrementalRefresh.service /etc/systemd/system/
  "${SUDO[@]}" cp packages/clickhouse-tools/CollectionCountIncrementalRefresh.timer /etc/systemd/system/
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl stop CollectionCountIncrementalRefresh.timer CollectionCountIncrementalRefresh.service 2>/dev/null || true
  "${SUDO[@]}" systemctl disable CollectionCountIncrementalRefresh.timer 2>/dev/null || true
}

deploy_enable_dual_write() {
  log "enabling dual-write collection event sync/rescan path"
  "${SUDO[@]}" systemctl enable --now CollectionEventsSync.timer
  "${SUDO[@]}" systemctl enable --now CollectionEventsRescan.timer
  DUAL_WRITE_STARTED_AT="$(date -u +'%Y-%m-%d %H:%M:%S.%3N')"
  export DUAL_WRITE_STARTED_AT
  log "dual_write_started_at=$DUAL_WRITE_STARTED_AT"
}

verify_dual_write_static_paths() {
  log "verifying raw write paths supply existence log and ingest queue"
  grep -q 'collection_count_event_existence_log' packages/clickhouse-tools/src/backfill-collection-events.ts || fail "backfill path does not write existence log"
  grep -q 'collection_count_ingest_queue' packages/clickhouse-tools/src/backfill-collection-events.ts || fail "backfill path does not write ingest queue"
  grep -q 'backfill:collection-events' packages/clickhouse-tools/CollectionEventsSync.service || fail "sync service does not use shared backfill path"
  grep -q 'backfill:collection-events' packages/clickhouse-tools/CollectionEventsRescan.service || fail "rescan service does not use shared backfill path"
}

record_bootstrap_high() {
  BOOTSTRAP_HIGH="$(scalar "SELECT formatDateTime(now64(3, 'UTC'), '%Y-%m-%d %H:%i:%S.%f')")"
  export BOOTSTRAP_HIGH
  log "bootstrap_high=$BOOTSTRAP_HIGH"
}

backfill_through_bootstrap_high() {
  log "backfilling bounded queue/existence rows through bootstrap_high max_rows=$BOOTSTRAP_MAX_ROWS max_loops=$BOOTSTRAP_MAX_LOOPS"
  local loop rows_read output status waited
  for ((loop = 1; loop <= BOOTSTRAP_MAX_LOOPS; loop += 1)); do
    output="$(mktemp)"
    waited=0
    while true; do
      set +e
      pnpm --filter @atpdashboard/clickhouse-tools backfill:collection-events -- \
        --confirm-production \
        --bootstrap-queue-from-raw \
        --max-rows "$BOOTSTRAP_MAX_ROWS" \
        --lock-ttl-seconds 900 >"$output" 2>&1
      status=$?
      set -e

      if [[ "$status" -eq 0 ]]; then
        cat "$output"
        break
      fi
      if grep -q 'Could not acquire ClickHouse sync lock' "$output" && [[ "$waited" -lt "$BOOTSTRAP_LOCK_MAX_WAIT_SECONDS" ]]; then
        log "bootstrap loop=$loop waiting for collection_events sync lock ${BOOTSTRAP_LOCK_RETRY_SECONDS}s waited=${waited}s"
        sleep "$BOOTSTRAP_LOCK_RETRY_SECONDS"
        waited=$((waited + BOOTSTRAP_LOCK_RETRY_SECONDS))
        continue
      fi
      cat "$output" >&2
      rm -f "$output"
      fail "bootstrap backfill failed loop=$loop status=$status"
    done
    rows_read="$(node -e "const fs=require('fs'); const text=fs.readFileSync(process.argv[1],'utf8'); const match=text.match(/\\{[\\s\\S]*\\}/); if(!match) process.exit(2); const json=JSON.parse(match[0]); process.stdout.write(String(json.rowsRead ?? 0));" "$output")"
    rm -f "$output"
    log "bootstrap loop=$loop rows_read=$rows_read"
    if [[ "$rows_read" -lt "$BOOTSTRAP_MAX_ROWS" ]]; then
      return
    fi
  done
  fail "bootstrap did not drain within BOOTSTRAP_MAX_LOOPS=$BOOTSTRAP_MAX_LOOPS"
}

run_verification_repair_and_gates() {
  log "running queue repair, P1 gates, and retention gate"
  export COLLECTION_COUNT_RETENTION_MODE
  scripts/verify_collection_count_incremental_read_model.sh --confirm --repair --p1-gates
}

publish_snapshot_under_lock() {
  log "publishing incremental collection_count snapshot under shared lock"
  flock -n /run/atpdashboard-collection-count-incremental.lock \
    pnpm refresh:collection-count -- \
      --confirm-production \
      --safety-lag-seconds "$SAFETY_LAG_SECONDS" \
      --max-rows "$INCREMENTAL_MAX_ROWS" \
      --max-queued-at-span-seconds "$INCREMENTAL_MAX_SPAN_SECONDS" \
      --max-estimated-bytes "$INCREMENTAL_MAX_ESTIMATED_BYTES" \
      --retention-mode "$COLLECTION_COUNT_RETENTION_MODE"
}

latest_valid_cte() {
  cat <<'SQL'
latest_manifest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS latest_status,
    argMax(completed_at, tuple(updated_at, status_version)) AS latest_completed_at,
    argMax(run_id, tuple(updated_at, status_version)) AS run_id,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
    argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
    argMax(snapshot_anchor_at, tuple(updated_at, status_version)) AS snapshot_anchor_at,
    argMax(snapshot_written, tuple(updated_at, status_version)) AS snapshot_written,
    argMax(event_seen_written, tuple(updated_at, status_version)) AS event_seen_written,
    argMax(event_conflict_written, tuple(updated_at, status_version)) AS event_conflict_written,
    argMax(first_seen_written, tuple(updated_at, status_version)) AS first_seen_written,
    argMax(did_seen_written, tuple(updated_at, status_version)) AS did_seen_written,
    argMax(rkey_seen_written, tuple(updated_at, status_version)) AS rkey_seen_written,
    argMax(hourly_written, tuple(updated_at, status_version)) AS hourly_written,
    argMax(cumulative_users_written, tuple(updated_at, status_version)) AS cumulative_users_written,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM collection_count_refresh_manifest_v2
  GROUP BY refresh_id
),
latest_valid_completed AS
(
  SELECT *
  FROM latest_manifest
  WHERE latest_status = 'completed'
    AND latest_completed_at IS NOT NULL
    AND invalidated_at IS NULL
    AND is_bootstrap_seed = 0
    AND run_id IS NOT NULL
    AND snapshot_anchor_at IS NOT NULL
    AND cutoff_queued_at IS NOT NULL
    AND cutoff_event_key IS NOT NULL
    AND cutoff_queue_seq != ''
    AND snapshot_written = 1
    AND event_seen_written = 1
    AND event_conflict_written = 1
    AND first_seen_written = 1
    AND did_seen_written = 1
    AND rkey_seen_written = 1
    AND hourly_written = 1
    AND cumulative_users_written = 1
    AND validation_passed = 1
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
)
SQL
}

verify_visible_v2_marker() {
  log "verifying visible v2 completed marker and snapshot artifacts"
  local marker_count snapshot_rows cumulative_rows sample_collection
  marker_count="$(scalar "WITH $(latest_valid_cte) SELECT count() FROM latest_valid_completed")"
  snapshot_rows="$(scalar "WITH $(latest_valid_cte) SELECT count() FROM collection_count_snapshot WHERE refresh_id = (SELECT refresh_id FROM latest_valid_completed)")"
  cumulative_rows="$(scalar "WITH $(latest_valid_cte) SELECT count() FROM collection_count_cumulative_users_snapshot WHERE refresh_id = (SELECT refresh_id FROM latest_valid_completed)")"
  sample_collection="$(scalar "WITH $(latest_valid_cte) SELECT collection FROM collection_count_snapshot WHERE refresh_id = (SELECT refresh_id FROM latest_valid_completed) ORDER BY count DESC LIMIT 1")"

  [[ "$marker_count" == "1" ]] || fail "latest valid v2 marker count is $marker_count"
  [[ "$snapshot_rows" != "0" ]] || fail "latest valid collection_count_snapshot is empty"
  [[ "$cumulative_rows" != "0" ]] || fail "latest valid cumulative users snapshot is empty"
  [[ -n "$sample_collection" ]] || fail "cannot find sample collection for API checks"
  SAMPLE_COLLECTION="$sample_collection"
  export SAMPLE_COLLECTION
  log "visible_v2_marker=ok sample_collection=$SAMPLE_COLLECTION snapshot_rows=$snapshot_rows cumulative_rows=$cumulative_rows"
}

urlencode() {
  node -e "process.stdout.write(encodeURIComponent(process.argv[1] || ''))" "$1"
}

http_check_json() {
  local label="$1"
  local url="$2"
  local expected_shape="$3"
  local require_clickhouse="$4"
  local headers body status data_source fallback
  headers="$(mktemp)"
  body="$(mktemp)"
  status="$(curl -fsS -L -D "$headers" -o "$body" -w '%{http_code}' "$url" || true)"
  if [[ "$status" != "200" ]]; then
    cat "$headers" >&2 || true
    head -c 1000 "$body" >&2 || true
    rm -f "$headers" "$body"
    fail "$label returned HTTP $status"
  fi
  node - "$body" "$expected_shape" <<'NODE'
const fs = require('fs');
const bodyPath = process.argv[2];
const expected = process.argv[3];
const value = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
if (expected === 'array' && !Array.isArray(value)) process.exit(10);
if (expected === 'object' && (Array.isArray(value) || value === null || typeof value !== 'object')) process.exit(11);
if (expected === 'array' && value.length === 0) process.exit(12);
NODE
  data_source="$(awk 'BEGIN{IGNORECASE=1} /^x-data-source:/ {gsub(/\r/,""); print $2}' "$headers" | tail -1)"
  fallback="$(awk 'BEGIN{IGNORECASE=1} /^x-fallback-reason:/ {gsub(/\r/,""); print $2}' "$headers" | tail -1)"
  if [[ "$require_clickhouse" == "true" ]]; then
    [[ "$data_source" == "clickhouse" ]] || fail "$label did not return X-Data-Source: clickhouse"
    [[ -z "$fallback" ]] || fail "$label returned fallback reason: $fallback"
  fi
  rm -f "$headers" "$body"
  log "$label ok"
}

run_api_continuity_checks_current_live() {
  log "checking current live API continuity before API read-path restart"
  http_check_json "local collection_count_view continuity" "$LOCAL_API_BASE_URL/collection_count_view" array false
  http_check_json "public collection_count_view continuity" "$PUBLIC_API_BASE_URL/collection_count_view" array false
}

restart_api_for_cutover() {
  log "restarting AtpDashboardAnalyticsApi.service for guarded API read-path cutover"
  "${SUDO[@]}" systemctl restart AtpDashboardAnalyticsApi.service
  sleep 2
  "${SUDO[@]}" systemctl is-active --quiet AtpDashboardAnalyticsApi.service || fail "AtpDashboardAnalyticsApi.service is not active"
}

run_clickhouse_verification() {
  log "running ClickHouse verification after API cutover"
  scripts/verify_collection_count_incremental_read_model.sh --confirm --repair --p1-gates --load-gates
  verify_visible_v2_marker
}

run_all_api_checks() {
  local encoded_collection
  encoded_collection="$(urlencode "$SAMPLE_COLLECTION")"
  log "checking local/public API endpoints for collection=$SAMPLE_COLLECTION"
  http_check_json "local collection_count_view" "$LOCAL_API_BASE_URL/collection_count_view" array true
  http_check_json "local collection_stats" "$LOCAL_API_BASE_URL/collection_stats?collection=$encoded_collection" object true
  http_check_json "local collection_cumulative_users" "$LOCAL_API_BASE_URL/collection_cumulative_users?collection=$encoded_collection&days=30" array true
  http_check_json "public collection_count_view" "$PUBLIC_API_BASE_URL/collection_count_view" array true
  http_check_json "public collection_stats" "$PUBLIC_API_BASE_URL/collection_stats?collection=$encoded_collection" object true
  http_check_json "public collection_cumulative_users" "$PUBLIC_API_BASE_URL/collection_cumulative_users?collection=$encoded_collection&days=30" array true
}

assert_unit_disabled_inactive() {
  local unit="$1"
  if "${SUDO[@]}" systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    fail "$unit is enabled"
  fi
  if "${SUDO[@]}" systemctl is-active --quiet "$unit" 2>/dev/null; then
    fail "$unit is active"
  fi
}

verify_failed_units_and_old_disabled() {
  log "verifying failed units and old timer state"
  "${SUDO[@]}" systemctl --no-pager --failed
  if [[ "$("${SUDO[@]}" systemctl --no-pager --failed --plain --no-legend | wc -l | tr -d ' ')" != "0" ]]; then
    fail "systemd has failed units"
  fi
  assert_unit_disabled_inactive CollectionCountReadModelRefresh.timer
  assert_unit_disabled_inactive CollectionCountReadModelRefresh.service
  assert_unit_disabled_inactive CollectionCountRefresh.timer
  assert_unit_disabled_inactive CollectionCountRefresh.service
}

verify_load_reduction_gate() {
  log "verifying load-reduction gate"
  verify_failed_units_and_old_disabled

  if pgrep -af 'refresh-collection-count-snapshot|CollectionCountReadModelRefresh|CollectionCountRefresh' >/dev/null 2>&1; then
    pgrep -af 'refresh-collection-count-snapshot|CollectionCountReadModelRefresh|CollectionCountRefresh' >&2 || true
    fail "legacy collection count full refresh process is active"
  fi

  local active_forbidden recent_forbidden
  active_forbidden="$(scalar "
SELECT count()
FROM system.processes
WHERE query ILIKE '%collection_events%'
  AND query ILIKE '%GROUP BY%collection%'
  AND query NOT ILIKE '%collection_count_bootstrap_bounded%'
  AND query NOT ILIKE '%collection_count_incremental_catchup%'
  AND query NOT ILIKE '%collection_count_event_existence_log%'
")"
  recent_forbidden="$(scalar "
SELECT count()
FROM system.query_log
WHERE event_time >= now() - INTERVAL 30 MINUTE
  AND type IN ('QueryStart', 'QueryFinish')
  AND query ILIKE '%collection_events%'
  AND query ILIKE '%GROUP BY%collection%'
  AND query NOT ILIKE '%collection_count_bootstrap_bounded%'
  AND query NOT ILIKE '%collection_count_incremental_catchup%'
  AND query NOT ILIKE '%collection_count_event_existence_log%'
")"
  [[ "$active_forbidden" == "0" ]] || fail "forbidden broad collection_events aggregation is active"
  [[ "$recent_forbidden" == "0" ]] || fail "recent forbidden broad collection_events aggregation found in query_log"

  for unit in CollectionCountReadModelRefresh.service CollectionCountRefresh.service; do
    if "${SUDO[@]}" journalctl -u "$unit" --since "30 minutes ago" --no-pager 2>/dev/null | grep -q 'Starting '; then
      fail "recent legacy service execution found for $unit"
    fi
  done

  log "load-reduction gate passed"
}

run_all_deploy_gates_before_timer() {
  run_clickhouse_verification
  run_all_api_checks
  verify_failed_units_and_old_disabled
  verify_load_reduction_gate
}

enable_incremental_timer_after_gates() {
  log "enabling CollectionCountIncrementalRefresh.timer after all deploy gates"
  "${SUDO[@]}" systemctl enable --now CollectionCountIncrementalRefresh.timer
  "${SUDO[@]}" systemctl restart CollectionCountIncrementalRefresh.timer
}

assert_unit_enabled_active() {
  local unit="$1"
  "${SUDO[@]}" systemctl is-enabled --quiet "$unit" || fail "$unit is not enabled"
  "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "$unit is not active"
}

verify_final_convergence() {
  log "verifying final timer/service convergence"
  assert_unit_enabled_active CollectionEventsSync.timer
  assert_unit_enabled_active CollectionEventsRescan.timer
  assert_unit_enabled_active CollectionCountIncrementalRefresh.timer
  assert_unit_disabled_inactive CollectionCountReadModelRefresh.timer
  assert_unit_disabled_inactive CollectionCountReadModelRefresh.service
  assert_unit_disabled_inactive CollectionCountRefresh.timer
  assert_unit_disabled_inactive CollectionCountRefresh.service
  "${SUDO[@]}" systemctl --no-pager list-timers 'Collection*'
  verify_failed_units_and_old_disabled
}

log "final target state and semantic impact:"
echo "  collection_count_view: latest valid collection_count_refresh_manifest_v2 + collection_count_snapshot"
echo "  collection_stats: latest valid v2 read model artifacts; no raw collection_events request-time scan"
echo "  collection_cumulative_users: latest valid v2 cumulative snapshot; no broad first-seen request-time scan"
echo "  enabled final timers: CollectionEventsSync.timer, CollectionEventsRescan.timer, CollectionCountIncrementalRefresh.timer"
echo "  disabled final timers: CollectionCountReadModelRefresh.timer, CollectionCountRefresh.timer"
echo "  CollectionCountIncrementalRefresh.timer: enabled only after dual-write/bootstrap/repair/publish/API/P1/retention/load gates"
echo "  CollectionCountReadModelRefresh/CollectionCountRefresh: never re-enabled"
echo "  systemd scope: only AtpDashboardAnalyticsApi and Collection* AtpDashboard units are managed"
echo "  retention cleanup: $COLLECTION_COUNT_RETENTION_MODE"

cd "$APP_DIR"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

require_file_without_pre_cutover_hazards sql/clickhouse/007_collection_count_incremental.sql
assert_systemd_scope_allowlist
stop_disable_legacy_full_refresh

log "applying additive pre-cutover DDL"
docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --multiquery < sql/clickhouse/007_collection_count_incremental.sql

install_units_with_incremental_timer_disabled
deploy_enable_dual_write
verify_dual_write_static_paths
record_bootstrap_high
backfill_through_bootstrap_high
run_verification_repair_and_gates
publish_snapshot_under_lock
run_verification_repair_and_gates
verify_visible_v2_marker
run_api_continuity_checks_current_live
restart_api_for_cutover
run_all_deploy_gates_before_timer
enable_incremental_timer_after_gates
verify_final_convergence

trap - EXIT
log "completed"
