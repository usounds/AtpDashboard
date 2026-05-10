#!/usr/bin/env bash
set -euo pipefail

CLICKHOUSE_CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
CUSTOMFEEDDB_CONTAINER="${CUSTOMFEEDDB_CONTAINER:-customfeeddb-postgres}"
CUSTOMFEEDDB_DATABASE="${CUSTOMFEEDDB_DATABASE:-ocustomfeeddb}"

section() {
  printf '\n===== %s =====\n' "$1"
}

run() {
  local label="$1"
  shift
  section "$label"
  "$@" || true
}

ch() {
  docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client "$@"
}

pg() {
  docker exec -i "$CUSTOMFEEDDB_CONTAINER" psql -U postgres -d "$CUSTOMFEEDDB_DATABASE" "$@"
}

section "diagnose analytics load"
date

run "systemd timers" sudo systemctl --no-pager list-timers 'Analytics*' 'Collection*'
run "systemd failed" sudo systemctl --no-pager --failed

section "top processes"
ps -eo pid,user,comm,%cpu,%mem,etime --sort=-%cpu | head -20

run "docker ps" docker ps --format 'table {{.Names}}\t{{.Status}}'
run "docker stats no-stream" docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}\t{{.PIDs}}'

if docker ps --format '{{.Names}}' | grep -Fx "$CLICKHOUSE_CONTAINER" >/dev/null 2>&1; then
  run "clickhouse running queries" ch --query "
SELECT
  query_id,
  elapsed,
  read_rows,
  formatReadableSize(read_bytes) AS read_bytes,
  formatReadableSize(memory_usage) AS memory,
  left(replaceRegexpAll(query, '\\\\s+', ' '), 300) AS query
FROM system.processes
ORDER BY elapsed DESC
"

  run "clickhouse merges" ch --query "
SELECT
  database,
  table,
  elapsed,
  progress,
  num_parts,
  total_size_bytes_compressed,
  formatReadableSize(total_size_bytes_compressed) AS total_size,
  result_part_name
FROM system.merges
ORDER BY elapsed DESC
LIMIT 20
"

  run "clickhouse mutations" ch --query "
SELECT
  database,
  table,
  mutation_id,
  command,
  create_time,
  is_done,
  latest_failed_part,
  latest_fail_reason
FROM system.mutations
WHERE is_done = 0
ORDER BY create_time DESC
LIMIT 20
"

  run "clickhouse largest active parts" ch --query "
SELECT
  database,
  table,
  count() AS parts,
  sum(rows) AS rows,
  formatReadableSize(sum(bytes_on_disk)) AS bytes
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY sum(bytes_on_disk) DESC
LIMIT 20
"

  run "collection count latest valid v2 manifest" ch --query "
WITH latest_manifest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS latest_status,
    argMax(completed_at, tuple(updated_at, status_version)) AS completed_at,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
    argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
    argMax(row_count, tuple(updated_at, status_version)) AS row_count,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM atp_dashboard.collection_count_refresh_manifest_v2
  GROUP BY refresh_id
)
SELECT
  refresh_id,
  latest_status,
  completed_at,
  cutoff_queued_at,
  left(cutoff_event_key, 48) AS cutoff_event_key,
  cutoff_queue_seq,
  row_count,
  validation_passed,
  invalidated_at,
  is_bootstrap_seed
FROM latest_manifest
ORDER BY completed_at DESC NULLS LAST, cutoff_queued_at DESC
LIMIT 5
"

  run "collection count queue health" ch --query "
WITH latest_manifest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS latest_status,
    argMax(completed_at, tuple(updated_at, status_version)) AS completed_at,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
    argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM atp_dashboard.collection_count_refresh_manifest_v2
  GROUP BY refresh_id
),
latest_valid AS
(
  SELECT *
  FROM latest_manifest
  WHERE latest_status = 'completed'
    AND completed_at IS NOT NULL
    AND validation_passed = 1
    AND invalidated_at IS NULL
    AND is_bootstrap_seed = 0
  ORDER BY completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC
  LIMIT 1
)
SELECT
  (SELECT count() FROM atp_dashboard.collection_count_ingest_queue) AS queue_rows,
  (SELECT count() FROM atp_dashboard.collection_count_event_existence_log) AS existence_rows,
  (SELECT count() FROM atp_dashboard.collection_count_queue_orphans WHERE resolved_at IS NULL) AS unresolved_orphans,
  (SELECT count() FROM atp_dashboard.collection_count_event_conflicts WHERE detected_at >= now64(3, 'UTC') - toIntervalDay(7)) AS conflicts_7d,
  (SELECT count() FROM atp_dashboard.collection_count_ingest_queue AS q CROSS JOIN latest_valid AS v WHERE (q.queued_at, q.event_key, q.queue_seq) > (v.cutoff_queued_at, v.cutoff_event_key, v.cutoff_queue_seq)) AS backlog_after_latest_valid,
  (SELECT max(queued_at) FROM atp_dashboard.collection_count_ingest_queue) AS max_queued_at
"

  run "collection count bootstrap progress" ch --query "
SELECT
  (SELECT count() FROM atp_dashboard.collection_events) AS raw_rows,
  (SELECT count() FROM atp_dashboard.collection_count_event_existence_log) AS existence_rows,
  (SELECT count() FROM atp_dashboard.collection_count_ingest_queue) AS queue_rows,
  (SELECT coalesce(argMax(last_event_key, updated_at), '') FROM atp_dashboard.collection_count_bootstrap_progress WHERE name = 'raw_event_key_scan') AS last_scanned_event_key,
  (SELECT count() FROM atp_dashboard.collection_events WHERE event_key > (SELECT coalesce(argMax(last_event_key, updated_at), '') FROM atp_dashboard.collection_count_bootstrap_progress WHERE name = 'raw_event_key_scan')) AS raw_rows_after_bootstrap_progress
"

  run "collection count forbidden broad raw queries" ch --query "
SELECT
  event_time,
  type,
  query_duration_ms,
  read_rows,
  formatReadableSize(read_bytes) AS read_bytes,
  left(replaceRegexpAll(query, '\\\\s+', ' '), 300) AS query
FROM system.query_log
WHERE event_time >= now() - INTERVAL 30 MINUTE
  AND query ILIKE '%collection_events%'
  AND query ILIKE '%GROUP BY%collection%'
  AND query NOT ILIKE '%system.processes%'
  AND query NOT ILIKE '%system.query_log%'
  AND query NOT ILIKE '%collection_count_bootstrap_bounded%'
  AND query NOT ILIKE '%collection_count_incremental_catchup%'
  AND query NOT ILIKE '%collection_count_event_existence_log%'
ORDER BY event_time DESC
LIMIT 20
"
else
  section "clickhouse"
  echo "container not running: $CLICKHOUSE_CONTAINER"
fi

if docker ps --format '{{.Names}}' | grep -Fx "$CUSTOMFEEDDB_CONTAINER" >/dev/null 2>&1; then
  run "customfeeddb active postgres queries" pg -c "
SELECT
  pid,
  usename,
  application_name,
  client_addr,
  state,
  wait_event_type,
  wait_event,
  now() - query_start AS runtime,
  left(replace(regexp_replace(query, E'[\\n\\r\\t]+', ' ', 'g'), '  ', ' '), 300) AS query
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND state <> 'idle'
ORDER BY query_start NULLS LAST
LIMIT 20;
"

  run "customfeeddb materialized view refresh" pg -c "
SELECT
  pid,
  state,
  now() - query_start AS runtime,
  left(regexp_replace(query, E'[\\n\\r\\t]+', ' ', 'g'), 300) AS query
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND query ILIKE '%REFRESH MATERIALIZED VIEW%';
"
else
  section "customfeeddb"
  echo "container not running: $CUSTOMFEEDDB_CONTAINER"
fi

section "user crontab relevant lines"
crontab -l 2>/dev/null | grep -E 'REFRESH MATERIALIZED VIEW|daily_active_did|daily_collection_stats|collection_stats' || true

run "CollectionEventsSync recent journal" sudo journalctl -u CollectionEventsSync.service --since "30 minutes ago" --no-pager -n 80
run "CollectionEventsRescan recent journal" sudo journalctl -u CollectionEventsRescan.service --since "30 minutes ago" --no-pager -n 80
run "CollectionCountIncrementalRefresh recent journal" sudo journalctl -u CollectionCountIncrementalRefresh.service --since "30 minutes ago" --no-pager -n 80
run "legacy collection count full-refresh recent journal" sudo journalctl -u CollectionCountReadModelRefresh.service -u CollectionCountRefresh.service --since "30 minutes ago" --no-pager -n 80

section "collection count timer state"
for unit in \
  CollectionEventsSync.timer \
  CollectionEventsRescan.timer \
  CollectionCountIncrementalRefresh.timer \
  CollectionCountReadModelRefresh.timer \
  CollectionCountRefresh.timer
do
  printf '%s\tenabled=%s\tactive=%s\n' \
    "$unit" \
    "$(systemctl is-enabled "$unit" 2>/dev/null || true)" \
    "$(systemctl is-active "$unit" 2>/dev/null || true)"
done

section "diagnose completed"
