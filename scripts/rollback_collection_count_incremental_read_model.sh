#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
ENV_FILE="${CLICKHOUSE_ENV_FILE:-/etc/atpdashboard/clickhouse.env}"
CLICKHOUSE_CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"
LOCAL_API_BASE_URL="${LOCAL_API_BASE_URL:-http://127.0.0.1:8787/api/analytics}"
PUBLIC_API_BASE_URL="${PUBLIC_API_BASE_URL:-https://dashboardapi.usounds.work/api/analytics}"

if [[ "${1:-}" != "--confirm" ]]; then
  echo "Usage: scripts/rollback_collection_count_incremental_read_model.sh --confirm" >&2
  exit 2
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

log() {
  echo "[collection-count-incremental-rollback] $*"
}

fail() {
  echo "[collection-count-incremental-rollback][ERROR] $*" >&2
  exit 1
}

cd "$APP_DIR"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

ch() {
  docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --database "$CLICKHOUSE_DATABASE" "$@"
}

scalar() {
  ch --query "$1"
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

assert_unit_disabled_inactive() {
  local unit="$1"
  if "${SUDO[@]}" systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    fail "$unit is enabled"
  fi
  if "${SUDO[@]}" systemctl is-active --quiet "$unit" 2>/dev/null; then
    fail "$unit is active"
  fi
}

assert_unit_enabled_active() {
  local unit="$1"
  "${SUDO[@]}" systemctl is-enabled --quiet "$unit" || fail "$unit is not enabled"
  "${SUDO[@]}" systemctl is-active --quiet "$unit" || fail "$unit is not active"
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

urlencode() {
  node -e "process.stdout.write(encodeURIComponent(process.argv[1] || ''))" "$1"
}

http_check_json() {
  local label="$1"
  local url="$2"
  local expected_shape="$3"
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
  [[ "$data_source" == "clickhouse" ]] || fail "$label did not return X-Data-Source: clickhouse"
  [[ -z "$fallback" ]] || fail "$label returned fallback reason: $fallback"
  rm -f "$headers" "$body"
  log "$label ok"
}

verify_valid_snapshot_for_api() {
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
  log "latest valid snapshot preserved sample_collection=$SAMPLE_COLLECTION snapshot_rows=$snapshot_rows cumulative_rows=$cumulative_rows"
}

verify_api() {
  local encoded_collection
  encoded_collection="$(urlencode "$SAMPLE_COLLECTION")"
  http_check_json "local collection_count_view" "$LOCAL_API_BASE_URL/collection_count_view" array
  http_check_json "local collection_stats" "$LOCAL_API_BASE_URL/collection_stats?collection=$encoded_collection" object
  http_check_json "local collection_cumulative_users" "$LOCAL_API_BASE_URL/collection_cumulative_users?collection=$encoded_collection&days=30" array
  http_check_json "public collection_count_view" "$PUBLIC_API_BASE_URL/collection_count_view" array
  http_check_json "public collection_stats" "$PUBLIC_API_BASE_URL/collection_stats?collection=$encoded_collection" object
  http_check_json "public collection_cumulative_users" "$PUBLIC_API_BASE_URL/collection_cumulative_users?collection=$encoded_collection&days=30" array
}

verify_failed_units() {
  "${SUDO[@]}" systemctl --no-pager --failed
  if [[ "$("${SUDO[@]}" systemctl --no-pager --failed --plain --no-legend | wc -l | tr -d ' ')" != "0" ]]; then
    fail "systemd has failed units"
  fi
}

log "final rollback target state:"
echo "  CollectionEventsSync.timer: enabled/active"
echo "  CollectionEventsRescan.timer: enabled/active"
echo "  CollectionCountIncrementalRefresh.timer: disabled/inactive"
echo "  CollectionCountReadModelRefresh.timer: disabled/inactive"
echo "  CollectionCountRefresh.timer: disabled/inactive"
echo "  API: continues reading latest valid v2 snapshot; old full refresh is not restored"
echo "  systemd scope: only AtpDashboardAnalyticsApi and Collection* AtpDashboard units are managed"

assert_systemd_scope_allowlist

log "disabling incremental and old full-refresh units"
"${SUDO[@]}" systemctl stop CollectionCountIncrementalRefresh.timer CollectionCountIncrementalRefresh.service 2>/dev/null || true
"${SUDO[@]}" systemctl disable CollectionCountIncrementalRefresh.timer 2>/dev/null || true
"${SUDO[@]}" systemctl stop CollectionCountReadModelRefresh.timer CollectionCountReadModelRefresh.service 2>/dev/null || true
"${SUDO[@]}" systemctl disable CollectionCountReadModelRefresh.timer 2>/dev/null || true
"${SUDO[@]}" systemctl stop CollectionCountRefresh.timer CollectionCountRefresh.service 2>/dev/null || true
"${SUDO[@]}" systemctl disable CollectionCountRefresh.timer 2>/dev/null || true

log "keeping collection event sync/rescan enabled"
"${SUDO[@]}" systemctl enable --now CollectionEventsSync.timer
"${SUDO[@]}" systemctl enable --now CollectionEventsRescan.timer

verify_valid_snapshot_for_api
verify_api
verify_failed_units
assert_unit_enabled_active CollectionEventsSync.timer
assert_unit_enabled_active CollectionEventsRescan.timer
assert_unit_disabled_inactive CollectionCountIncrementalRefresh.timer
assert_unit_disabled_inactive CollectionCountIncrementalRefresh.service
assert_unit_disabled_inactive CollectionCountReadModelRefresh.timer
assert_unit_disabled_inactive CollectionCountReadModelRefresh.service
assert_unit_disabled_inactive CollectionCountRefresh.timer
assert_unit_disabled_inactive CollectionCountRefresh.service
"${SUDO[@]}" systemctl --no-pager list-timers 'Collection*'

log "completed"
