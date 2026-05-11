#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
ENV_FILE="${CLICKHOUSE_ENV_FILE:-/etc/atpdashboard/clickhouse.env}"
CLICKHOUSE_CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"
DUAL_WRITE_STARTED_AT="${DUAL_WRITE_STARTED_AT:-}"
BOOTSTRAP_HIGH="${BOOTSTRAP_HIGH:-}"
COLLECTION_COUNT_RETENTION_MODE="${COLLECTION_COUNT_RETENTION_MODE:-safe-disabled}"
LOAD_GATE_QUERY_LOG_SINCE="${LOAD_GATE_QUERY_LOG_SINCE:-}"
CONFIRM=false
REPAIR=false
P1_GATES=false
LOAD_GATES=false
REPAIR_MAX_LOOPS="${REPAIR_MAX_LOOPS:-5}"

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/verify_collection_count_incremental_read_model.sh --confirm [--repair] [--p1-gates] [--load-gates]

Verifies the incremental collection count queue/read-model prerequisites.
Repair uses collection_count_event_existence_log only; it does not broad-scan
collection_events.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm)
      CONFIRM=true
      shift
      ;;
    --repair)
      REPAIR=true
      shift
      ;;
    --p1-gates)
      P1_GATES=true
      shift
      ;;
    --load-gates)
      LOAD_GATES=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[collection-count-incremental-verify] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$CONFIRM" != true ]]; then
  echo "[collection-count-incremental-verify] refusing without --confirm" >&2
  usage
  exit 2
fi

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

log() {
  echo "[collection-count-incremental-verify] $*"
}

fail() {
  echo "[collection-count-incremental-verify][ERROR] $*" >&2
  exit 1
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
valid_completed_all AS
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
),
latest_valid_completed AS
(
  SELECT *
  FROM valid_completed_all
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
)
SQL
}

repair_missing_queue_from_existence_log() {
  log "repairing missing queue rows from existence log"
  ch --query "
INSERT INTO collection_count_ingest_queue
WITH
$(latest_valid_cte),
watermark AS
(
  SELECT
    cutoff_queued_at,
    cutoff_event_key,
    cutoff_queue_seq
  FROM latest_valid_completed
  UNION ALL
  SELECT
    toDateTime64(0, 3, 'UTC') AS cutoff_queued_at,
    '' AS cutoff_event_key,
    '' AS cutoff_queue_seq
  WHERE NOT EXISTS (SELECT 1 FROM latest_valid_completed)
),
active_cutoff AS
(
  SELECT
    coalesce(max_queued_at, toDateTime64(0, 3, 'UTC')) AS cutoff_queued_at,
    coalesce(max_event_key, '') AS cutoff_event_key,
    coalesce(max_queue_seq, '') AS cutoff_queue_seq
  FROM
  (
    SELECT
      max(cutoff_queued_at) AS max_queued_at,
      argMax(cutoff_event_key, tuple(cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, run_id)) AS max_event_key,
      argMax(cutoff_queue_seq, tuple(cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, run_id)) AS max_queue_seq
    FROM collection_count_incremental_runs
    WHERE status = 'running'
  )
),
missing AS
(
  SELECT
    e.event_key,
    e.collection,
    e.did,
    e.rkey,
    e.created_at,
    e.created_at_key,
    e.created_hour,
    e.source_ingested_at,
    greatest(e.written_at, w.cutoff_queued_at + toIntervalMillisecond(1), a.cutoff_queued_at + toIntervalMillisecond(1)) AS queued_at,
    concat(toString(toUnixTimestamp64Milli(greatest(e.written_at, w.cutoff_queued_at + toIntervalMillisecond(1), a.cutoff_queued_at + toIntervalMillisecond(1)))), '-repair-', lower(hex(e.payload_hash)), '-', left(hex(sipHash64(e.event_key)), 16)) AS queue_seq,
    e.payload_hash
  FROM collection_count_event_existence_log AS e
  CROSS JOIN watermark AS w
  CROSS JOIN active_cutoff AS a
  LEFT JOIN collection_count_ingest_queue AS q
    ON q.event_key = e.event_key
   AND q.payload_hash = e.payload_hash
  WHERE q.event_key = ''
    AND e.did != 'did:web:lexicon.store'
    AND (e.written_at, e.event_key, concat(toString(toUnixTimestamp64Milli(e.written_at)), '-existence')) > (w.cutoff_queued_at, w.cutoff_event_key, w.cutoff_queue_seq)
)
SELECT *
FROM missing
WHERE queue_seq != ''
"
}

queue_missing_count() {
  scalar "
WITH
$(latest_valid_cte),
watermark AS
(
  SELECT cutoff_queued_at, cutoff_event_key, cutoff_queue_seq
  FROM latest_valid_completed
  UNION ALL
  SELECT toDateTime64(0, 3, 'UTC'), '', ''
  WHERE NOT EXISTS (SELECT 1 FROM latest_valid_completed)
)
SELECT count()
FROM collection_count_event_existence_log AS e
CROSS JOIN watermark AS w
LEFT JOIN collection_count_ingest_queue AS q
  ON q.event_key = e.event_key
 AND q.payload_hash = e.payload_hash
WHERE q.event_key = ''
  AND e.did != 'did:web:lexicon.store'
  AND (e.written_at, e.event_key, concat(toString(toUnixTimestamp64Milli(e.written_at)), '-existence')) > (w.cutoff_queued_at, w.cutoff_event_key, w.cutoff_queue_seq)
"
}

repair_missing_queue_until_stable() {
  local loop missing_count
  for ((loop = 1; loop <= REPAIR_MAX_LOOPS; loop += 1)); do
    missing_count="$(queue_missing_count)"
    if [[ "$missing_count" == "0" ]]; then
      return
    fi
    log "queue_missing=$missing_count before repair loop=$loop"
    repair_missing_queue_from_existence_log
  done
}

verify_queue_invariants() {
  local missing_count orphan_count empty_queue_seq conflict_count unsafe_count

  missing_count="$(queue_missing_count)"

  orphan_count="$(scalar "
SELECT count()
FROM collection_count_queue_orphans
WHERE resolved_at IS NULL
")"

  empty_queue_seq="$(scalar "
SELECT count()
FROM collection_count_ingest_queue
WHERE queue_seq = ''
")"

  unsafe_count="$(scalar "
WITH
$(latest_valid_cte),
watermark AS
(
  SELECT cutoff_queued_at, cutoff_event_key, cutoff_queue_seq
  FROM latest_valid_completed
  UNION ALL
  SELECT toDateTime64(0, 3, 'UTC'), '', ''
  WHERE NOT EXISTS (SELECT 1 FROM latest_valid_completed)
),
active_cutoff AS
(
  SELECT
    coalesce(max_queued_at, toDateTime64(0, 3, 'UTC')) AS cutoff_queued_at,
    coalesce(max_event_key, '') AS cutoff_event_key,
    coalesce(max_queue_seq, '') AS cutoff_queue_seq
  FROM
  (
    SELECT
      max(cutoff_queued_at) AS max_queued_at,
      argMax(cutoff_event_key, tuple(cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, run_id)) AS max_event_key,
      argMax(cutoff_queue_seq, tuple(cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, run_id)) AS max_queue_seq
    FROM collection_count_incremental_runs
    WHERE status = 'running'
  )
)
SELECT count()
FROM collection_count_ingest_queue AS q
CROSS JOIN watermark AS w
CROSS JOIN active_cutoff AS a
LEFT JOIN
(
  SELECT DISTINCT event_key, payload_hash
  FROM collection_count_event_seen_log
) AS s
  ON s.event_key = q.event_key
 AND s.payload_hash = q.payload_hash
LEFT JOIN
(
  SELECT DISTINCT event_key, payload_hash
  FROM collection_count_event_conflicts
) AS c
  ON c.event_key = q.event_key
 AND c.payload_hash = q.payload_hash
WHERE q.queue_seq = ''
  AND q.did != 'did:web:lexicon.store'
   OR (
        q.did != 'did:web:lexicon.store'
        AND (q.queued_at, q.event_key, q.queue_seq) <= (w.cutoff_queued_at, w.cutoff_event_key, w.cutoff_queue_seq)
        AND s.event_key = ''
        AND c.event_key = ''
      )
   OR (
        q.did != 'did:web:lexicon.store'
        AND q.queue_seq LIKE '%-repair-%'
        AND a.cutoff_queue_seq != ''
        AND (q.queued_at, q.event_key, q.queue_seq) <= (a.cutoff_queued_at, a.cutoff_event_key, a.cutoff_queue_seq)
        AND s.event_key = ''
        AND c.event_key = ''
      )
")"

  conflict_count="$(scalar "
SELECT count()
FROM collection_count_event_conflicts
WHERE detected_at >= now64(3, 'UTC') - toIntervalDay(7)
")"

  log "queue_missing=$missing_count unresolved_orphans=$orphan_count empty_queue_seq=$empty_queue_seq unsafe_queue_rows=$unsafe_count recent_conflicts_7d=$conflict_count"

  [[ "$missing_count" == "0" ]] || fail "queue missing rows remain: $missing_count"
  [[ "$orphan_count" == "0" ]] || fail "unresolved queue orphans remain: $orphan_count"
  [[ "$empty_queue_seq" == "0" ]] || fail "empty queue_seq rows remain: $empty_queue_seq"
  [[ "$unsafe_count" == "0" ]] || fail "queue rows violate latest/active cutoff invariant: $unsafe_count"
}

verify_optional_bootstrap_overlap() {
  if [[ -z "$DUAL_WRITE_STARTED_AT" || -z "$BOOTSTRAP_HIGH" ]]; then
    log "bootstrap overlap check skipped; DUAL_WRITE_STARTED_AT or BOOTSTRAP_HIGH is not set"
    return
  fi

  local overlap_missing
  overlap_missing="$(scalar "
SELECT count()
FROM collection_count_event_existence_log AS e
LEFT JOIN collection_count_ingest_queue AS q
  ON q.event_key = e.event_key
 AND q.payload_hash = e.payload_hash
WHERE e.written_at >= parseDateTime64BestEffort('${DUAL_WRITE_STARTED_AT}', 3, 'UTC')
  AND e.written_at <= parseDateTime64BestEffort('${BOOTSTRAP_HIGH}', 3, 'UTC')
  AND q.event_key = ''
")"

  log "bootstrap_overlap_missing=$overlap_missing"
  [[ "$overlap_missing" == "0" ]] || fail "bootstrap overlap queue coverage missing rows: $overlap_missing"
}

assert_file_contains() {
  local file="$1"
  local pattern="$2"
  local message="$3"

  if ! grep -Eq "$pattern" "$file"; then
    fail "$message"
  fi
}

assert_file_not_contains() {
  local file="$1"
  local pattern="$2"
  local message="$3"

  if grep -Eq "$pattern" "$file"; then
    fail "$message"
  fi
}

assert_unit_disabled_inactive() {
  local unit="$1"

  if ! command -v systemctl >/dev/null 2>&1; then
    log "systemctl unavailable; skipping runtime unit check for $unit"
    return
  fi

  if [[ "$unit" == *.timer ]] && systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    fail "$unit is enabled"
  fi
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    fail "$unit is active"
  fi
}

run_p1_release_gates() {
  log "running P1 release gates"

  assert_file_contains packages/api/src/collection-count/clickhouse.ts 'collection_count_refresh_manifest_v2' \
    "collection_count API does not use manifest v2"
  assert_file_not_contains packages/api/src/collection-count/clickhouse.ts 'FROM atp_dashboard\.collection_events' \
    "collection_count API still reads raw collection_events"
  assert_file_not_contains packages/api/src/collection-count/clickhouse.ts 'FROM atp_dashboard\.collection_did_first_seen_snapshot' \
    "collection_count API still reads broad first-seen snapshot"
  assert_file_not_contains packages/api/src/collection-count/clickhouse.ts "WHERE status = 'completed'[[:space:][:print:]]*ORDER BY completed_at DESC" \
    "collection_count API still uses legacy completed manifest ordering"

  assert_file_contains scripts/deploy_collection_count_read_model.sh 'legacy full-refresh deploy path is disabled' \
    "legacy collection count read-model deploy script does not hard-fail"
  assert_file_not_contains scripts/deploy_collection_count_read_model.sh 'enable --now CollectionCount(ReadModelRefresh|Refresh)\.timer' \
    "legacy read-model deploy script can enable old timers"

  assert_file_not_contains docs/clickhouse-partial-migration-runbook.md 'pnpm refresh:collection-count --[[:space:]]+--confirm-production' \
    "runbook still documents old full-refresh refresh command as normal path"
  assert_file_not_contains docs/clickhouse-partial-migration-runbook.md 'enable --now CollectionCount(ReadModelRefresh|Refresh)\.timer' \
    "runbook still enables old collection count timers"
  assert_file_contains packages/clickhouse-tools/schedule-notes.md 'refresh:collection-count-incremental' \
    "schedule notes do not document incremental refresh path"
  assert_file_not_contains packages/clickhouse-tools/schedule-notes.md 'refresh:collection-count --[[:space:]]+--confirm-production' \
    "schedule notes still document old full-refresh command"

  assert_file_not_contains packages/clickhouse-tools/CollectionCountReadModelRefresh.timer '^WantedBy=timers\.target$' \
    "CollectionCountReadModelRefresh.timer still has a normal install target"
  assert_file_not_contains packages/clickhouse-tools/CollectionCountRefresh.timer '^WantedBy=timers\.target$' \
    "CollectionCountRefresh.timer still has a normal install target"

  assert_file_contains packages/clickhouse-tools/CollectionCountIncrementalRefresh.service '/run/atpdashboard-collection-count-incremental\.lock' \
    "incremental systemd service does not use the shared lock"
  assert_file_contains scripts/deploy_collection_count_incremental_read_model.sh '/run/atpdashboard-collection-count-incremental\.lock' \
    "incremental deploy/manual path does not use the shared lock"
  assert_file_contains packages/clickhouse-tools/src/collection-count-incremental.ts "COLLECTION_COUNT_INCREMENTAL_LOCK_PATH = '/run/atpdashboard-collection-count-incremental.lock'" \
    "shared lock constant is missing"

  assert_file_contains scripts/deploy_collection_count_incremental_read_model.sh 'CollectionCountIncrementalRefresh\.timer stays disabled/inactive' \
    "incremental deploy script does not keep the timer disabled during unit installation"
  assert_file_contains scripts/deploy_collection_count_incremental_read_model.sh 'run_all_deploy_gates_before_timer' \
    "incremental deploy script does not group required gates before timer enablement"
  assert_file_contains scripts/deploy_collection_count_incremental_read_model.sh 'enable_incremental_timer_after_gates' \
    "incremental deploy script does not isolate final timer enablement after gates"
  assert_file_contains scripts/deploy_collection_count_incremental_read_model.sh 'run_all_deploy_gates_before_timer[[:space:]]*$' \
    "incremental deploy script does not call deploy gates before final timer enablement"
  local gates_call_line timer_call_line
  gates_call_line="$(grep -En '^run_all_deploy_gates_before_timer[[:space:]]*$' scripts/deploy_collection_count_incremental_read_model.sh | tail -1 | cut -d: -f1)"
  timer_call_line="$(grep -En '^enable_incremental_timer_after_gates[[:space:]]*$' scripts/deploy_collection_count_incremental_read_model.sh | tail -1 | cut -d: -f1)"
  [[ -n "$gates_call_line" && -n "$timer_call_line" ]] || fail "deploy script timer gate call order cannot be checked"
  [[ "$gates_call_line" -lt "$timer_call_line" ]] || fail "incremental timer is enabled before deploy gates"

  assert_file_contains packages/clickhouse-tools/src/backfill-collection-events.ts 'collection_count_event_existence_log' \
    "collection event write path does not write existence log"
  assert_file_contains packages/clickhouse-tools/src/backfill-collection-events.ts 'collection_count_ingest_queue' \
    "collection event write path does not write ingest queue"
  assert_file_contains packages/clickhouse-tools/src/backfill-collection-events.ts 'collection_count_bootstrap_bounded' \
    "bounded bootstrap query is not machine-tagged"
  assert_file_contains packages/clickhouse-tools/src/refresh-collection-count-incremental.ts 'collection_count_incremental_catchup' \
    "incremental catch-up queries are not machine-tagged"

  assert_file_contains packages/clickhouse-tools/src/refresh-collection-count-snapshot.ts 'Legacy collection_count full refresh is disabled' \
    "legacy full-refresh CLI does not hard-fail by default"

  if grep -REn 'INSERT INTO[[:space:]]+.*collection_count_refresh_manifest\b' scripts packages docs --exclude='*.md' | grep -v 'collection_count_refresh_manifest_v2' | grep -v 'refresh-collection-count-snapshot.ts' >/dev/null 2>&1; then
    fail "a normal shipped path writes to legacy collection_count_refresh_manifest"
  fi

  assert_file_contains package.json '"refresh:collection-count": "pnpm --filter @atpdashboard/clickhouse-tools refresh:collection-count-incremental"' \
    "root refresh:collection-count is not routed to incremental"
  assert_file_contains packages/clickhouse-tools/package.json '"refresh:collection-count": "node --experimental-strip-types src/refresh-collection-count-incremental.ts"' \
    "clickhouse-tools refresh:collection-count is not routed to incremental"
  assert_file_contains packages/clickhouse-tools/package.json '"refresh:collection-count-legacy": "node --experimental-strip-types src/refresh-collection-count-snapshot.ts"' \
    "legacy refresh script is not isolated"
  if [[ -f scripts/rollback_collection_count_incremental_read_model.sh ]]; then
    assert_file_contains scripts/rollback_collection_count_incremental_read_model.sh 'CollectionCountIncrementalRefresh\.timer: disabled/inactive' \
      "rollback script does not target incremental timer disabled/inactive"
    assert_file_not_contains scripts/rollback_collection_count_incremental_read_model.sh 'enable --now CollectionCount(ReadModelRefresh|Refresh)\.timer' \
      "rollback script can enable old collection count full refresh timers"
  fi

  assert_unit_disabled_inactive CollectionCountReadModelRefresh.timer
  assert_unit_disabled_inactive CollectionCountReadModelRefresh.service
  assert_unit_disabled_inactive CollectionCountRefresh.timer
  assert_unit_disabled_inactive CollectionCountRefresh.service

  log "P1 release gates passed"
}

verify_retention_gate() {
  log "verifying retention gate mode=$COLLECTION_COUNT_RETENTION_MODE"

  case "$COLLECTION_COUNT_RETENTION_MODE" in
    safe-disabled)
      ;;
    *)
      fail "unsupported COLLECTION_COUNT_RETENTION_MODE=$COLLECTION_COUNT_RETENTION_MODE; cleanup is not implemented"
      ;;
  esac

  for table in \
    collection_count_event_seen_log \
    collection_count_did_seen_state \
    collection_count_rkey_seen_state \
    collection_count_did_first_seen_state
  do
    if grep -REn "(DELETE FROM|TRUNCATE TABLE|DROP TABLE).*${table}" scripts packages/clickhouse-tools/src >/dev/null 2>&1; then
      fail "retention path attempts to delete permanent Phase1 state table: $table"
    fi
  done

  if grep -REn "(DELETE FROM|TRUNCATE TABLE|DROP TABLE).*collection_count_(recent_hourly_state|snapshot|cumulative_users_snapshot)" scripts packages/clickhouse-tools/src >/dev/null 2>&1; then
    fail "retention path can delete rollback/hourly artifacts without coverage verification"
  fi

  log "retention cleanup is explicitly safe-disabled; no delete cleanup will run"
}

verify_load_reduction_gate() {
  log "running load-reduction acceptance gate"

  assert_unit_disabled_inactive CollectionCountReadModelRefresh.timer
  assert_unit_disabled_inactive CollectionCountReadModelRefresh.service
  assert_unit_disabled_inactive CollectionCountRefresh.timer
  assert_unit_disabled_inactive CollectionCountRefresh.service

  if command -v pgrep >/dev/null 2>&1 && pgrep -af 'refresh-collection-count-snapshot|CollectionCountReadModelRefresh|CollectionCountRefresh' >/dev/null 2>&1; then
    pgrep -af 'refresh-collection-count-snapshot|CollectionCountReadModelRefresh|CollectionCountRefresh' >&2 || true
    fail "legacy collection count full-refresh process is active"
  fi

  local active_forbidden recent_forbidden
  local query_log_since="${LOAD_GATE_QUERY_LOG_SINCE:-$(scalar "SELECT now()")}"
  active_forbidden="$(scalar "
SELECT count()
FROM system.processes
WHERE query ILIKE '%collection_events%'
  AND query ILIKE '%GROUP BY%collection%'
  AND query NOT ILIKE '%system.processes%'
  AND query NOT ILIKE '%system.query_log%'
  AND query NOT ILIKE '%collection_count_bootstrap_bounded%'
  AND query NOT ILIKE '%collection_count_incremental_catchup%'
  AND query NOT ILIKE '%collection_count_event_existence_log%'
")"
  recent_forbidden="$(scalar "
SELECT count()
FROM system.query_log
WHERE event_time >= parseDateTimeBestEffort('$query_log_since')
  AND type IN ('QueryStart', 'QueryFinish')
  AND query ILIKE '%collection_events%'
  AND query ILIKE '%GROUP BY%collection%'
  AND query NOT ILIKE '%system.processes%'
  AND query NOT ILIKE '%system.query_log%'
  AND query NOT ILIKE '%collection_count_bootstrap_bounded%'
  AND query NOT ILIKE '%collection_count_incremental_catchup%'
  AND query NOT ILIKE '%collection_count_event_existence_log%'
")"

  [[ "$active_forbidden" == "0" ]] || fail "forbidden broad collection_events aggregation is active"
  [[ "$recent_forbidden" == "0" ]] || fail "recent forbidden broad collection_events aggregation found in query_log"

  if command -v journalctl >/dev/null 2>&1; then
    for unit in CollectionCountReadModelRefresh.service CollectionCountRefresh.service; do
      if journalctl -u "$unit" --since "30 minutes ago" --no-pager 2>/dev/null | grep -q 'Starting '; then
        fail "recent legacy service execution found for $unit"
      fi
    done
  fi

  log "load-reduction acceptance gate passed"
}

if [[ "$REPAIR" == true ]]; then
  repair_missing_queue_until_stable
fi

verify_queue_invariants
verify_optional_bootstrap_overlap

if [[ "$P1_GATES" == true ]]; then
  run_p1_release_gates
fi

verify_retention_gate

if [[ "$LOAD_GATES" == true ]]; then
  verify_load_reduction_gate
fi

log "completed"
