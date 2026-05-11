#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/srv/AtpDashboard}"
CLICKHOUSE_CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"
ENV_FILE="${CLICKHOUSE_ENV_FILE:-/etc/atpdashboard/clickhouse.env}"
CONFIRM=false

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/publish_collection_count_baseline_from_queue.sh --confirm

Publishes a full collection_count v2 baseline from the already-built
collection_count_ingest_queue. This is the fast catch-up path after historical
raw backfill has completed; it avoids replaying 60M+ queue rows through many
bounded incremental refreshes.
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
      echo "[collection-count-baseline][ERROR] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$CONFIRM" != true ]]; then
  echo "[collection-count-baseline][ERROR] refusing without --confirm" >&2
  usage
  exit 2
fi

cd "$APP_DIR"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
REFRESH_ID="$(cat /proc/sys/kernel/random/uuid)"
LOCK_FILE="/run/atpdashboard-collection-count-incremental.lock"

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

log() {
  echo "[collection-count-baseline] $*"
}

ch() {
  docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --database "$CLICKHOUSE_DATABASE" "$@"
}

log "run_id=$RUN_ID refresh_id=$REFRESH_ID"
log "applying additive DDL"
docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --multiquery < sql/clickhouse/007_collection_count_incremental.sql

log "preparing shared lock"
"${SUDO[@]}" install -m 0666 -o root -g root /dev/null "$LOCK_FILE"

log "publishing full baseline from collection_count_ingest_queue"
flock -n "$LOCK_FILE" docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --database "$CLICKHOUSE_DATABASE" --multiquery <<SQL
INSERT INTO collection_count_incremental_runs
  (run_id, refresh_id, status, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, source_rows, stage_rows, started_at, updated_at, completed_at)
WITH
latest_manifest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS latest_status,
    argMax(completed_at, tuple(updated_at, status_version)) AS latest_completed_at,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
    argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM collection_count_refresh_manifest_v2
  GROUP BY refresh_id
),
latest_valid AS
(
  SELECT *
  FROM latest_manifest
  WHERE latest_status = 'completed'
    AND latest_completed_at IS NOT NULL
    AND validation_passed = 1
    AND invalidated_at IS NULL
    AND is_bootstrap_seed = 0
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
),
cutoff AS
(
  SELECT
    max(queued_at) AS cutoff_queued_at,
    argMax(event_key, tuple(queued_at, event_key, queue_seq)) AS cutoff_event_key,
    argMax(queue_seq, tuple(queued_at, event_key, queue_seq)) AS cutoff_queue_seq
  FROM collection_count_ingest_queue
)
SELECT
  '$RUN_ID' AS run_id,
  '$REFRESH_ID' AS refresh_id,
  'snapshot_written' AS status,
  (SELECT refresh_id FROM latest_valid) AS previous_refresh_id,
  (SELECT cutoff_queued_at FROM latest_valid) AS watermark_queued_at,
  (SELECT cutoff_event_key FROM latest_valid) AS watermark_event_key,
  coalesce((SELECT cutoff_queue_seq FROM latest_valid), '') AS watermark_queue_seq,
  cutoff_queued_at,
  cutoff_event_key,
  cutoff_queue_seq,
  (SELECT count() FROM collection_count_ingest_queue WHERE did != 'did:web:lexicon.store') AS source_rows,
  0 AS stage_rows,
  now64(3, 'UTC') AS started_at,
  now64(3, 'UTC') AS updated_at,
  NULL AS completed_at
FROM cutoff;

INSERT INTO collection_count_event_stage
  (run_id, event_key, collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, queued_at, queue_seq, payload_hash)
SELECT
  '$RUN_ID' AS run_id,
  event_key,
  any(collection) AS collection,
  any(did) AS did,
  any(rkey) AS rkey,
  any(created_at) AS created_at,
  any(created_at_key) AS created_at_key,
  any(created_hour) AS created_hour,
  min(source_ingested_at) AS source_ingested_at,
  min(queued_at) AS queued_at,
  argMin(queue_seq, tuple(queued_at, queue_seq, payload_hash)) AS queue_seq,
  any(payload_hash) AS payload_hash
FROM collection_count_ingest_queue
WHERE did != 'did:web:lexicon.store'
GROUP BY event_key
SETTINGS max_threads = 1, max_insert_threads = 1, optimize_aggregation_in_order = 1, max_bytes_before_external_group_by = 268435456, max_bytes_before_external_sort = 268435456;

INSERT INTO collection_count_event_seen_log
  (run_id, refresh_id, event_key, collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, queued_at, payload_hash, seen_at)
SELECT
  run_id,
  '$REFRESH_ID' AS refresh_id,
  event_key,
  collection,
  did,
  rkey,
  created_at,
  created_at_key,
  created_hour,
  source_ingested_at,
  queued_at,
  payload_hash,
  now64(3, 'UTC') AS seen_at
FROM collection_count_event_stage
WHERE run_id = '$RUN_ID';

INSERT INTO collection_count_did_seen_state
  (refresh_id, run_id, collection, did, first_seen_at, created_at_is_null, state_written_at)
SELECT
  '$REFRESH_ID' AS refresh_id,
  '$RUN_ID' AS run_id,
  collection,
  did,
  if(countIf(isNotNull(created_at)) = 0, NULL, minIf(created_at, isNotNull(created_at))) AS first_seen_at,
  toUInt8(countIf(isNull(created_at)) > 0) AS created_at_is_null,
  now64(3, 'UTC') AS state_written_at
FROM collection_count_event_stage
WHERE run_id = '$RUN_ID'
GROUP BY collection, did
SETTINGS max_threads = 1, max_insert_threads = 1, max_bytes_before_external_group_by = 268435456, max_bytes_before_external_sort = 268435456;

INSERT INTO collection_count_rkey_seen_state
  (refresh_id, run_id, collection, did, rkey, state_written_at)
SELECT
  '$REFRESH_ID' AS refresh_id,
  '$RUN_ID' AS run_id,
  collection,
  did,
  rkey,
  now64(3, 'UTC') AS state_written_at
FROM collection_count_event_stage
WHERE run_id = '$RUN_ID'
GROUP BY collection, did, rkey
SETTINGS max_threads = 1, max_insert_threads = 1, max_bytes_before_external_group_by = 268435456, max_bytes_before_external_sort = 268435456;

INSERT INTO collection_count_did_first_seen_state
  (refresh_id, run_id, collection, did, first_seen_at, state_written_at)
SELECT
  '$REFRESH_ID' AS refresh_id,
  '$RUN_ID' AS run_id,
  collection,
  did,
  min(created_at) AS first_seen_at,
  now64(3, 'UTC') AS state_written_at
FROM collection_count_event_stage
WHERE run_id = '$RUN_ID'
  AND isNotNull(created_at)
GROUP BY collection, did
SETTINGS max_threads = 1, max_insert_threads = 1, max_bytes_before_external_group_by = 268435456, max_bytes_before_external_sort = 268435456;

INSERT INTO collection_count_recent_hourly_state
  (refresh_id, run_id, collection, created_hour, event_count, state_written_at)
SELECT
  '$REFRESH_ID' AS refresh_id,
  '$RUN_ID' AS run_id,
  collection,
  created_hour,
  count() AS event_count,
  now64(3, 'UTC') AS state_written_at
FROM collection_count_event_stage
WHERE run_id = '$RUN_ID'
  AND isNotNull(created_hour)
GROUP BY collection, created_hour
SETTINGS max_threads = 1, max_insert_threads = 1, max_bytes_before_external_group_by = 268435456, max_bytes_before_external_sort = 268435456;

INSERT INTO collection_count_snapshot
  (refresh_id, collection, unique_did, unique_rkey, total_count, recent_count, min_created_at, max_created_at, refreshed_at)
WITH anchor AS (SELECT toStartOfHour(now64(3, 'UTC')) AS anchor_hour)
SELECT
  '$REFRESH_ID' AS refresh_id,
  collection,
  uniqExact(did) AS unique_did,
  uniqExact(tuple(did, collection, rkey)) AS unique_rkey,
  count() AS total_count,
  countIf(isNotNull(created_at) AND created_at >= (SELECT anchor_hour FROM anchor) - toIntervalHour(72) AND created_at < (SELECT anchor_hour FROM anchor)) AS recent_count,
  if(countIf(isNotNull(created_at)) = 0, NULL, minIf(created_at, isNotNull(created_at))) AS min_created_at,
  if(countIf(isNotNull(created_at)) = 0, NULL, maxIf(created_at, isNotNull(created_at))) AS max_created_at,
  now64(3, 'UTC') AS refreshed_at
FROM collection_count_event_stage
WHERE run_id = '$RUN_ID'
GROUP BY collection
SETTINGS max_threads = 1, max_insert_threads = 1, max_bytes_before_external_group_by = 268435456, max_bytes_before_external_sort = 268435456;

INSERT INTO collection_count_cumulative_users_snapshot
  (refresh_id, collection, day, new_users, cumulative_users, refreshed_at)
WITH
anchor AS (SELECT toDate(now64(3, 'UTC')) AS anchor_day),
day_series AS
(
  SELECT addDays((SELECT anchor_day FROM anchor), -toInt32(364 - number)) AS day
  FROM numbers(365)
),
collections AS
(
  SELECT DISTINCT collection
  FROM collection_count_did_first_seen_state
  WHERE refresh_id = '$REFRESH_ID'
),
daily_new AS
(
  SELECT
    collection,
    toDate(first_seen_at) AS day,
    count() AS new_users
  FROM collection_count_did_first_seen_state
  WHERE refresh_id = '$REFRESH_ID'
    AND toDate(first_seen_at) >= (SELECT anchor_day FROM anchor) - 364
    AND toDate(first_seen_at) <= (SELECT anchor_day FROM anchor)
  GROUP BY collection, day
),
dense AS
(
  SELECT
    c.collection,
    d.day,
    coalesce(n.new_users, 0) AS new_users
  FROM collections AS c
  CROSS JOIN day_series AS d
  LEFT JOIN daily_new AS n USING (collection, day)
)
SELECT
  '$REFRESH_ID' AS refresh_id,
  collection,
  day,
  new_users,
  sum(new_users) OVER (PARTITION BY collection ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_users,
  now64(3, 'UTC') AS refreshed_at
FROM dense;

INSERT INTO collection_count_refresh_manifest_v2
  (refresh_id, status, updated_at, completed_at, row_count, refreshed_at, run_id, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, snapshot_anchor_at, source_rows, stage_rows, event_seen_row_count, event_conflict_row_count, first_seen_row_count, did_seen_row_count, rkey_seen_row_count, hourly_row_count, snapshot_written, event_seen_written, event_conflict_written, first_seen_written, did_seen_written, rkey_seen_written, hourly_written, cumulative_users_written, validation_passed, queue_backfill_generation, status_version, invalidated_at, invalidated_reason, is_bootstrap_seed)
WITH run AS
(
  SELECT *
  FROM collection_count_incremental_runs
  WHERE run_id = '$RUN_ID'
  ORDER BY updated_at DESC
  LIMIT 1
)
SELECT
  '$REFRESH_ID' AS refresh_id,
  'completed' AS status,
  now64(3, 'UTC') AS updated_at,
  now64(3, 'UTC') AS completed_at,
  (SELECT count() FROM collection_count_snapshot WHERE refresh_id = '$REFRESH_ID') AS row_count,
  now64(3, 'UTC') AS refreshed_at,
  '$RUN_ID' AS run_id,
  previous_refresh_id,
  watermark_queued_at,
  watermark_event_key,
  watermark_queue_seq,
  cutoff_queued_at,
  cutoff_event_key,
  cutoff_queue_seq,
  toStartOfHour(now64(3, 'UTC')) AS snapshot_anchor_at,
  (SELECT count() FROM collection_count_event_stage WHERE run_id = '$RUN_ID') AS source_rows,
  (SELECT count() FROM collection_count_event_stage WHERE run_id = '$RUN_ID') AS stage_rows,
  (SELECT count() FROM collection_count_event_seen_log WHERE refresh_id = '$REFRESH_ID') AS event_seen_row_count,
  0 AS event_conflict_row_count,
  (SELECT count() FROM collection_count_did_first_seen_state WHERE refresh_id = '$REFRESH_ID') AS first_seen_row_count,
  (SELECT count() FROM collection_count_did_seen_state WHERE refresh_id = '$REFRESH_ID') AS did_seen_row_count,
  (SELECT count() FROM collection_count_rkey_seen_state WHERE refresh_id = '$REFRESH_ID') AS rkey_seen_row_count,
  (SELECT count() FROM collection_count_recent_hourly_state WHERE refresh_id = '$REFRESH_ID') AS hourly_row_count,
  1 AS snapshot_written,
  1 AS event_seen_written,
  1 AS event_conflict_written,
  1 AS first_seen_written,
  1 AS did_seen_written,
  1 AS rkey_seen_written,
  1 AS hourly_written,
  1 AS cumulative_users_written,
  1 AS validation_passed,
  0 AS queue_backfill_generation,
  1000000 AS status_version,
  NULL AS invalidated_at,
  NULL AS invalidated_reason,
  0 AS is_bootstrap_seed
FROM run;

INSERT INTO collection_count_incremental_runs
  (run_id, refresh_id, status, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, source_rows, stage_rows, started_at, updated_at, completed_at)
SELECT
  run_id,
  refresh_id,
  'completed' AS status,
  previous_refresh_id,
  watermark_queued_at,
  watermark_event_key,
  watermark_queue_seq,
  cutoff_queued_at,
  cutoff_event_key,
  cutoff_queue_seq,
  source_rows,
  (SELECT count() FROM collection_count_event_stage WHERE run_id = '$RUN_ID') AS stage_rows,
  started_at,
  now64(3, 'UTC') AS updated_at,
  now64(3, 'UTC') AS completed_at
FROM collection_count_incremental_runs
WHERE run_id = '$RUN_ID'
ORDER BY updated_at DESC
LIMIT 1;
SQL

log "baseline publish completed"
log "verifying latest snapshot"
ch --query "
SELECT
  refresh_id,
  row_count,
  source_rows,
  did_seen_row_count,
  rkey_seen_row_count,
  hourly_row_count
FROM
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS status,
    argMax(completed_at, tuple(updated_at, status_version)) AS completed_at,
    argMax(row_count, tuple(updated_at, status_version)) AS row_count,
    argMax(source_rows, tuple(updated_at, status_version)) AS source_rows,
    argMax(did_seen_row_count, tuple(updated_at, status_version)) AS did_seen_row_count,
    argMax(rkey_seen_row_count, tuple(updated_at, status_version)) AS rkey_seen_row_count,
    argMax(hourly_row_count, tuple(updated_at, status_version)) AS hourly_row_count,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at
  FROM collection_count_refresh_manifest_v2
  GROUP BY refresh_id
)
WHERE status = 'completed'
  AND validation_passed = 1
  AND invalidated_at IS NULL
ORDER BY completed_at DESC
LIMIT 1"
