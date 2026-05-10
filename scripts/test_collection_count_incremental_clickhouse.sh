#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="${CLICKHOUSE_TEST_CONTAINER:-atpdashboard-collection-count-incremental-test-$$}"
IMAGE="${CLICKHOUSE_TEST_IMAGE:-clickhouse/clickhouse-server:latest}"
HOST_PORT="${CLICKHOUSE_TEST_HTTP_PORT:-8124}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
docker run -d --name "$CONTAINER" -p "${HOST_PORT}:8123" -e CLICKHOUSE_SKIP_USER_SETUP=1 "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" clickhouse-client --query "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$CONTAINER" clickhouse-client --query "SELECT 1" >/dev/null

ch() {
  docker exec -i "$CONTAINER" clickhouse-client "$@"
}

wait_mutations() {
  for _ in $(seq 1 60); do
    local pending
    pending="$(ch --query "SELECT count() FROM system.mutations WHERE database = 'atp_dashboard' AND is_done = 0")"
    [[ "$pending" == "0" ]] && return
    sleep 1
  done
  echo "mutations did not finish" >&2
  exit 1
}

run_verify_repair() {
  local env_file
  env_file="$(mktemp)"
  {
    echo "CLICKHOUSE_CONTAINER=$CONTAINER"
    echo "CLICKHOUSE_DATABASE=atp_dashboard"
  } > "$env_file"
  APP_DIR="$PWD" \
  CLICKHOUSE_ENV_FILE="$env_file" \
  CLICKHOUSE_CONTAINER="$CONTAINER" \
  CLICKHOUSE_DATABASE="atp_dashboard" \
    scripts/verify_collection_count_incremental_read_model.sh --confirm --repair >/tmp/collection-count-verify-repair.log
  rm -f "$env_file"
}

run_refresh() {
  local run_id="$1"
  local refresh_id="$2"
  CLICKHOUSE_URL="http://localhost:${HOST_PORT}" \
  CLICKHOUSE_DATABASE="atp_dashboard" \
  pnpm --filter @atpdashboard/clickhouse-tools refresh:collection-count-incremental -- \
    --confirm-production \
    --run-id "$run_id" \
    --refresh-id "$refresh_id" \
    --safety-lag-seconds 1 \
    --max-rows 1000 \
    --max-queued-at-span-seconds 7200 \
    --max-estimated-bytes 104857600 \
    --retention-mode safe-disabled
}

ch --multiquery < sql/clickhouse/001_collection_events.sql
ch --multiquery < sql/clickhouse/002_collection_count_snapshot.sql
ch --multiquery < sql/clickhouse/007_collection_count_incremental.sql

ch --multiquery <<'SQL'
INSERT INTO atp_dashboard.collection_count_event_existence_log
  (event_key, payload_hash, collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, written_at)
VALUES
  ('e1', 101, 'app.test.one', 'did:plc:a', 'r1', toDateTime64('2026-05-10 09:00:00.000000', 6, 'UTC'), '2026-05-10T09:00:00.000000Z', toDateTime64('2026-05-10 09:00:00', 0, 'UTC'), toDateTime64('2026-05-10 09:00:10.000', 3, 'UTC'), toDateTime64('2026-05-10 09:00:11.000', 3, 'UTC')),
  ('e-old', 105, 'app.test.one', 'did:plc:old', 'r-old', toDateTime64('1900-01-01 00:00:00.000000', 6, 'UTC'), '1900-01-01T00:00:00.000000Z', toDateTime64('1900-01-01 00:00:00', 0, 'UTC'), toDateTime64('2026-05-10 09:30:10.000', 3, 'UTC'), toDateTime64('2026-05-10 09:30:11.000', 3, 'UTC')),
  ('e2', 102, 'app.test.one', 'did:plc:a', 'r2', toDateTime64('2026-05-10 10:00:00.000000', 6, 'UTC'), '2026-05-10T10:00:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:00:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:00:11.000', 3, 'UTC')),
  ('e-null', 103, 'app.test.null', 'did:plc:null', 'rn', NULL, '<NULL_CREATED_AT>', NULL, toDateTime64('2026-05-10 10:10:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:10:11.000', 3, 'UTC')),
  ('e-lexicon', 104, 'app.test.excluded', 'did:web:lexicon.store', 'rx', toDateTime64('2026-05-10 10:20:00.000000', 6, 'UTC'), '2026-05-10T10:20:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:20:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:20:11.000', 3, 'UTC')),
  ('e-conflict', 201, 'app.test.conflict', 'did:plc:c1', 'rc', toDateTime64('2026-05-10 10:30:00.000000', 6, 'UTC'), '2026-05-10T10:30:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:30:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:30:11.000', 3, 'UTC')),
  ('e-conflict', 202, 'app.test.conflict', 'did:plc:c2', 'rc', toDateTime64('2026-05-10 10:31:00.000000', 6, 'UTC'), '2026-05-10T10:31:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:31:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:31:11.000', 3, 'UTC'));

INSERT INTO atp_dashboard.collection_count_ingest_queue
  (event_key, collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, queued_at, queue_seq, payload_hash)
VALUES
  ('e1', 'app.test.one', 'did:plc:a', 'r1', toDateTime64('2026-05-10 09:00:00.000000', 6, 'UTC'), '2026-05-10T09:00:00.000000Z', toDateTime64('2026-05-10 09:00:00', 0, 'UTC'), toDateTime64('2026-05-10 09:00:10.000', 3, 'UTC'), toDateTime64('2026-05-10 09:00:12.000', 3, 'UTC'), '001-e1-a', 101),
  ('e1', 'app.test.one', 'did:plc:a', 'r1', toDateTime64('2026-05-10 09:00:00.000000', 6, 'UTC'), '2026-05-10T09:00:00.000000Z', toDateTime64('2026-05-10 09:00:00', 0, 'UTC'), toDateTime64('2026-05-10 09:00:10.000', 3, 'UTC'), toDateTime64('2026-05-10 09:00:13.000', 3, 'UTC'), '002-e1-b', 101),
  ('e-old', 'app.test.one', 'did:plc:old', 'r-old', toDateTime64('1900-01-01 00:00:00.000000', 6, 'UTC'), '1900-01-01T00:00:00.000000Z', toDateTime64('1900-01-01 00:00:00', 0, 'UTC'), toDateTime64('2026-05-10 09:30:10.000', 3, 'UTC'), toDateTime64('2026-05-10 09:30:12.000', 3, 'UTC'), '003-old', 105),
  ('e2', 'app.test.one', 'did:plc:a', 'r2', toDateTime64('2026-05-10 10:00:00.000000', 6, 'UTC'), '2026-05-10T10:00:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:00:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:00:12.000', 3, 'UTC'), '004-e2', 102),
  ('e-null', 'app.test.null', 'did:plc:null', 'rn', NULL, '<NULL_CREATED_AT>', NULL, toDateTime64('2026-05-10 10:10:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:10:12.000', 3, 'UTC'), '005-null', 103),
  ('e-lexicon', 'app.test.excluded', 'did:web:lexicon.store', 'rx', toDateTime64('2026-05-10 10:20:00.000000', 6, 'UTC'), '2026-05-10T10:20:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:20:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:20:12.000', 3, 'UTC'), '006-lexicon', 104),
  ('e-conflict', 'app.test.conflict', 'did:plc:c1', 'rc', toDateTime64('2026-05-10 10:30:00.000000', 6, 'UTC'), '2026-05-10T10:30:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:30:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:30:12.000', 3, 'UTC'), '007-conflict-a', 201),
  ('e-conflict', 'app.test.conflict', 'did:plc:c2', 'rc', toDateTime64('2026-05-10 10:31:00.000000', 6, 'UTC'), '2026-05-10T10:31:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:31:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:31:12.000', 3, 'UTC'), '008-conflict-b', 202),
  ('orphan', 'app.test.orphan', 'did:plc:o', 'ro', toDateTime64('2026-05-10 10:40:00.000000', 6, 'UTC'), '2026-05-10T10:40:00.000000Z', toDateTime64('2026-05-10 10:00:00', 0, 'UTC'), toDateTime64('2026-05-10 10:40:10.000', 3, 'UTC'), toDateTime64('2026-05-10 10:40:12.000', 3, 'UTC'), '009-orphan', 999);
SQL

if run_refresh "00000000-0000-4000-8000-000000000901" "00000000-0000-4000-8000-000000000902" >/tmp/collection-count-orphan.log 2>&1; then
  cat /tmp/collection-count-orphan.log >&2
  echo "expected orphan run to fail" >&2
  exit 1
fi

completed_after_orphan="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_refresh_manifest_v2 WHERE status = 'completed'")"
if [[ "$completed_after_orphan" != "0" ]]; then
  echo "expected no completed manifest after orphan failure, got $completed_after_orphan" >&2
  exit 1
fi

ch --query "ALTER TABLE atp_dashboard.collection_count_ingest_queue DELETE WHERE event_key = 'orphan'"
wait_mutations

run_refresh "00000000-0000-4000-8000-000000000903" "00000000-0000-4000-8000-000000000904" >/tmp/collection-count-success.log

summary="$(ch --query "
SELECT total_count, unique_did, unique_rkey, recent_count, toString(min_created_at), toString(max_created_at)
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000904')
  AND collection = 'app.test.one'
FORMAT TSV
")"
IFS=$'\t' read -r total_count unique_did unique_rkey recent_count min_created_at max_created_at <<<"$summary"

if [[ "$total_count" != "3" || "$unique_did" != "2" || "$unique_rkey" != "3" || "$recent_count" != "2" ]]; then
  echo "unexpected app.test.one snapshot: total=$total_count did=$unique_did rkey=$unique_rkey recent=$recent_count" >&2
  exit 1
fi

if [[ "$min_created_at" != "1900-01-01 00:00:00" && "$min_created_at" != "1900-01-01 00:00:00.000000" ]]; then
  echo "expected 1900-01-01 min_created_at, got $min_created_at" >&2
  exit 1
fi

if [[ "$max_created_at" != 2026-05-10\ 10:00:00* ]]; then
  echo "expected 2026-05-10 max_created_at, got $max_created_at" >&2
  exit 1
fi

excluded_rows="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_snapshot WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000904') AND collection = 'app.test.excluded'")"
if [[ "$excluded_rows" != "0" ]]; then
  echo "did:web:lexicon.store collection should be excluded, got rows=$excluded_rows" >&2
  exit 1
fi

seen_duplicates="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_event_seen_log WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000904') AND event_key = 'e1'")"
if [[ "$seen_duplicates" != "1" ]]; then
  echo "duplicate event_key should be seen once, got $seen_duplicates" >&2
  exit 1
fi

conflicts="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_event_conflicts WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000904') AND event_key = 'e-conflict'")"
if [[ "$conflicts" == "0" ]]; then
  echo "expected same-run payload conflict rows" >&2
  exit 1
fi

cumulative_rows="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_cumulative_users_snapshot WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000904') AND collection = 'app.test.one'")"
if [[ "$cumulative_rows" == "0" ]]; then
  echo "expected cumulative user rows for app.test.one" >&2
  exit 1
fi

old_first_seen_rows="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_did_first_seen_state WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000904') AND collection = 'app.test.one' AND did = 'did:plc:old' AND first_seen_at = toDateTime64('1900-01-01 00:00:00.000000', 6, 'UTC')")"
if [[ "$old_first_seen_rows" != "1" ]]; then
  echo "expected 1900-01-01 first-seen state for did:plc:old, got $old_first_seen_rows" >&2
  exit 1
fi

null_snapshot="$(ch --query "
SELECT total_count, recent_count, isNull(min_created_at), isNull(max_created_at)
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000904')
  AND collection = 'app.test.null'
FORMAT TSV
")"
IFS=$'\t' read -r null_total null_recent null_min_is_null null_max_is_null <<<"$null_snapshot"
if [[ "$null_total" != "1" || "$null_recent" != "0" || "$null_min_is_null" != "1" || "$null_max_is_null" != "1" ]]; then
  echo "unexpected null-created_at snapshot: total=$null_total recent=$null_recent min_is_null=$null_min_is_null max_is_null=$null_max_is_null" >&2
  exit 1
fi

ch --multiquery <<'SQL'
INSERT INTO atp_dashboard.collection_count_event_existence_log
WITH
  now64(6, 'UTC') - toIntervalHour(71) AS boundary_in_created,
  now64(6, 'UTC') - toIntervalHour(73) AS boundary_out_created
SELECT
  event_key,
  payload_hash,
  collection,
  did,
  rkey,
  created_at,
  created_at_key,
  dateTrunc('hour', created_at) AS created_hour,
  source_ingested_at,
  written_at
FROM
(
  SELECT
    'e-boundary-in' AS event_key,
    toUInt64(301) AS payload_hash,
    'app.test.boundary' AS collection,
    'did:plc:boundary-in' AS did,
    'rb-in' AS rkey,
    boundary_in_created AS created_at,
    formatDateTime(boundary_in_created, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS created_at_key,
    now64(3, 'UTC') - toIntervalSecond(20) AS source_ingested_at,
    now64(3, 'UTC') - toIntervalSecond(19) AS written_at
  UNION ALL
  SELECT
    'e-boundary-out',
    toUInt64(302),
    'app.test.boundary',
    'did:plc:boundary-out',
    'rb-out',
    boundary_out_created,
    formatDateTime(boundary_out_created, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC'),
    now64(3, 'UTC') - toIntervalSecond(18),
    now64(3, 'UTC') - toIntervalSecond(17)
  UNION ALL
  SELECT
    'e1',
    toUInt64(999),
    'app.test.one',
    'did:plc:a',
    'r1',
    toDateTime64('2026-05-10 09:00:00.000000', 6, 'UTC'),
    '2026-05-10T09:00:00.000000Z',
    now64(3, 'UTC') - toIntervalSecond(16),
    now64(3, 'UTC') - toIntervalSecond(15)
  UNION ALL
  SELECT
    'e2',
    toUInt64(102),
    'app.test.one',
    'did:plc:a',
    'r2',
    toDateTime64('2026-05-10 10:00:00.000000', 6, 'UTC'),
    '2026-05-10T10:00:00.000000Z',
    now64(3, 'UTC') - toIntervalSecond(14),
    now64(3, 'UTC') - toIntervalSecond(13)
);

INSERT INTO atp_dashboard.collection_count_ingest_queue
WITH
  now64(6, 'UTC') - toIntervalHour(71) AS boundary_in_created,
  now64(6, 'UTC') - toIntervalHour(73) AS boundary_out_created
SELECT
  event_key,
  collection,
  did,
  rkey,
  created_at,
  created_at_key,
  dateTrunc('hour', created_at) AS created_hour,
  source_ingested_at,
  queued_at,
  queue_seq,
  payload_hash
FROM
(
  SELECT
    'e-boundary-in' AS event_key,
    'app.test.boundary' AS collection,
    'did:plc:boundary-in' AS did,
    'rb-in' AS rkey,
    boundary_in_created AS created_at,
    formatDateTime(boundary_in_created, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS created_at_key,
    now64(3, 'UTC') - toIntervalSecond(20) AS source_ingested_at,
    now64(3, 'UTC') - toIntervalSecond(19) AS queued_at,
    '010-boundary-in' AS queue_seq,
    toUInt64(301) AS payload_hash
  UNION ALL
  SELECT
    'e-boundary-out',
    'app.test.boundary',
    'did:plc:boundary-out',
    'rb-out',
    boundary_out_created,
    formatDateTime(boundary_out_created, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC'),
    now64(3, 'UTC') - toIntervalSecond(18),
    now64(3, 'UTC') - toIntervalSecond(17),
    '011-boundary-out',
    toUInt64(302)
  UNION ALL
  SELECT
    'e1',
    'app.test.one',
    'did:plc:a',
    'r1',
    toDateTime64('2026-05-10 09:00:00.000000', 6, 'UTC'),
    '2026-05-10T09:00:00.000000Z',
    now64(3, 'UTC') - toIntervalSecond(16),
    now64(3, 'UTC') - toIntervalSecond(15),
    '012-cross-run-conflict',
    toUInt64(999)
  UNION ALL
  SELECT
    'e2',
    'app.test.one',
    'did:plc:a',
    'r2',
    toDateTime64('2026-05-10 10:00:00.000000', 6, 'UTC'),
    '2026-05-10T10:00:00.000000Z',
    now64(3, 'UTC') - toIntervalSecond(14),
    now64(3, 'UTC') - toIntervalSecond(13),
    '013-cross-run-replay',
    toUInt64(102)
);
SQL

run_refresh "00000000-0000-4000-8000-000000000905" "00000000-0000-4000-8000-000000000906" >/tmp/collection-count-second-batch.log

boundary_summary="$(ch --query "
SELECT total_count, unique_did, unique_rkey, recent_count
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000906')
  AND collection = 'app.test.boundary'
FORMAT TSV
")"
IFS=$'\t' read -r boundary_total boundary_unique_did boundary_unique_rkey boundary_recent <<<"$boundary_summary"
if [[ "$boundary_total" != "2" || "$boundary_unique_did" != "2" || "$boundary_unique_rkey" != "2" || "$boundary_recent" != "1" ]]; then
  echo "unexpected boundary snapshot: total=$boundary_total did=$boundary_unique_did rkey=$boundary_unique_rkey recent=$boundary_recent" >&2
  exit 1
fi

second_one_summary="$(ch --query "
SELECT total_count, unique_did, unique_rkey, recent_count
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000906')
  AND collection = 'app.test.one'
FORMAT TSV
")"
IFS=$'\t' read -r second_total second_unique_did second_unique_rkey second_recent <<<"$second_one_summary"
if [[ "$second_total" != "3" || "$second_unique_did" != "2" || "$second_unique_rkey" != "3" || "$second_recent" != "2" ]]; then
  echo "cross-run replay/conflict changed app.test.one snapshot: total=$second_total did=$second_unique_did rkey=$second_unique_rkey recent=$second_recent" >&2
  exit 1
fi

cross_run_conflicts="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_event_conflicts WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000906') AND event_key = 'e1'")"
if [[ "$cross_run_conflicts" == "0" ]]; then
  echo "expected cross-run payload conflict for e1" >&2
  exit 1
fi

replay_seen_rows="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_event_seen_log WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000906') AND event_key = 'e2'")"
if [[ "$replay_seen_rows" != "0" ]]; then
  echo "identical cross-run replay should not write a second seen row, got $replay_seen_rows" >&2
  exit 1
fi

run_refresh "00000000-0000-4000-8000-000000000907" "00000000-0000-4000-8000-000000000908" >/tmp/collection-count-zero-source.log

completed_count="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_refresh_manifest_v2 WHERE status = 'completed'")"
if [[ "$completed_count" != "3" ]]; then
  echo "expected zero-source aging refresh to complete a second manifest, got $completed_count" >&2
  exit 1
fi

ch --query "
ALTER TABLE atp_dashboard.collection_count_queue_orphans
UPDATE resolved_at = now64(3, 'UTC'), resolution = 'integration-test-resolved'
WHERE event_key = 'orphan'
"
wait_mutations

ch --multiquery <<'SQL'
INSERT INTO atp_dashboard.collection_count_event_existence_log
  (event_key, payload_hash, collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, written_at)
VALUES
  ('e-repair', 401, 'app.test.repair', 'did:plc:repair', 'rr', toDateTime64('2026-05-10 11:00:00.000000', 6, 'UTC'), '2026-05-10T11:00:00.000000Z', toDateTime64('2026-05-10 11:00:00', 0, 'UTC'), now64(3, 'UTC') - toIntervalSecond(10), now64(3, 'UTC') - toIntervalSecond(9));
SQL

missing_before_repair="$(ch --query "
SELECT count()
FROM atp_dashboard.collection_count_event_existence_log AS e
LEFT JOIN atp_dashboard.collection_count_ingest_queue AS q
  ON q.event_key = e.event_key
 AND q.payload_hash = e.payload_hash
WHERE e.event_key = 'e-repair'
  AND q.event_key = ''
")"
if [[ "$missing_before_repair" != "1" ]]; then
  echo "expected missing queue row before verify repair, got $missing_before_repair" >&2
  exit 1
fi

run_verify_repair

repair_queue_rows="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_ingest_queue WHERE event_key = 'e-repair' AND payload_hash = 401 AND queue_seq != ''")"
if [[ "$repair_queue_rows" != "1" ]]; then
  echo "expected verify repair to insert one non-empty queue row, got $repair_queue_rows" >&2
  exit 1
fi

run_refresh "00000000-0000-4000-8000-000000000909" "00000000-0000-4000-8000-000000000910" >/tmp/collection-count-repair-publish.log

repair_snapshot_rows="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_snapshot WHERE refresh_id = toUUID('00000000-0000-4000-8000-000000000910') AND collection = 'app.test.repair' AND total_count = 1")"
if [[ "$repair_snapshot_rows" != "1" ]]; then
  echo "expected repaired queue row to publish app.test.repair snapshot, got $repair_snapshot_rows" >&2
  exit 1
fi

completed_count="$(ch --query "SELECT count() FROM atp_dashboard.collection_count_refresh_manifest_v2 WHERE status = 'completed'")"
if [[ "$completed_count" != "4" ]]; then
  echo "expected repair publish to complete a fourth manifest, got $completed_count" >&2
  exit 1
fi

if ch --query "EXPLAIN indexes=1 SELECT * FROM atp_dashboard.collection_count_event_stage WHERE run_id = toUUID('00000000-0000-4000-8000-000000000903')" | grep -q 'collection_events'; then
  echo "periodic path explain should not include raw collection_events" >&2
  exit 1
fi

echo "ok collection count incremental integration total=$total_count unique_did=$unique_did unique_rkey=$unique_rkey recent=$recent_count boundary_recent=$boundary_recent min=$min_created_at conflicts=$conflicts cross_run_conflicts=$cross_run_conflicts repair_rows=$repair_queue_rows completed=$completed_count"
