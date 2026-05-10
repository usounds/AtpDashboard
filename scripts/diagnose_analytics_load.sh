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

section "diagnose completed"
