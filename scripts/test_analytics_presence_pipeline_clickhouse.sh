#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${CLICKHOUSE_TEST_CONTAINER:-atpdashboard-presence-test-clickhouse}"
IMAGE="${CLICKHOUSE_TEST_IMAGE:-clickhouse/clickhouse-server:latest}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
docker run -d --name "$CONTAINER" -p 8123:8123 -e CLICKHOUSE_SKIP_USER_SETUP=1 "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" clickhouse-client --query "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

ch() {
  docker exec -i "$CONTAINER" clickhouse-client "$@"
}

ch --multiquery < sql/clickhouse/001_collection_events.sql
ch --multiquery < sql/clickhouse/004_analytics_chart_snapshot.sql
ch --multiquery < sql/clickhouse/005_analytics_chart_rollups.sql
ch --multiquery < sql/clickhouse/006_analytics_presence_pipeline.sql

ch --multiquery <<'SQL'
INSERT INTO atp_dashboard.collection_events
  (event_key, did, collection, rkey, created_at, created_at_key, ingested_at)
VALUES
  ('e1', 'did:plc:a', 'app.test.one', 'r1', toDateTime64('2026-05-10 06:10:00', 6, 'UTC'), '2026-05-10T06:10:00.000000Z', toDateTime64('2026-05-10 06:11:00', 3, 'UTC')),
  ('e1', 'did:plc:a', 'app.test.one', 'r1', toDateTime64('2026-05-10 06:10:00', 6, 'UTC'), '2026-05-10T06:10:00.000000Z', toDateTime64('2026-05-10 06:12:00', 3, 'UTC')),
  ('e2', 'did:plc:a', 'app.test.two', 'r2', toDateTime64('2026-05-10 07:10:00', 6, 'UTC'), '2026-05-10T07:10:00.000000Z', toDateTime64('2026-05-10 07:11:00', 3, 'UTC')),
  ('e3', 'did:plc:b', 'app.test.one', 'r3', toDateTime64('2026-05-09 07:10:00', 6, 'UTC'), '2026-05-09T07:10:00.000000Z', toDateTime64('2026-05-09 07:11:00', 3, 'UTC'));
SQL

RUN_ID="00000000-0000-4000-8000-000000000101"

CLICKHOUSE_URL="http://localhost:8123" \
CLICKHOUSE_DATABASE="atp_dashboard" \
pnpm refresh:analytics-presence -- --confirm-production --run-id "$RUN_ID" --backfill-days 370 --safety-lag-seconds 1 >/tmp/presence-refresh.json

ANALYTICS_CHART_REFRESH_SOURCE=presence \
CLICKHOUSE_URL="http://localhost:8123" \
CLICKHOUSE_DATABASE="atp_dashboard" \
pnpm refresh:analytics-charts -- --confirm-production >/tmp/presence-chart-refresh.json

rows="$(ch --query "
SELECT count()
FROM atp_dashboard.analytics_chart_snapshot
WHERE refresh_id IN
(
  SELECT refresh_id
  FROM atp_dashboard.analytics_chart_refresh_manifest
  WHERE status = 'completed'
  ORDER BY completed_at DESC
  LIMIT 1
)
")"

if [[ "$rows" != "150" ]]; then
  echo "expected 150 snapshot rows, got $rows" >&2
  exit 1
fi

active_users="$(ch --query "
SELECT active
FROM atp_dashboard.analytics_chart_snapshot
WHERE refresh_id IN
(
  SELECT refresh_id
  FROM atp_dashboard.analytics_chart_refresh_manifest
  WHERE status = 'completed'
  ORDER BY completed_at DESC
  LIMIT 1
)
  AND tool = 'daily_users'
  AND days = 7
  AND bucket_days = 1
  AND bucket_index = 0
")"

if [[ "$active_users" != "1" ]]; then
  echo "expected same DID across hours to count once in current bucket, got $active_users" >&2
  exit 1
fi

event_count="$(ch --query "
SELECT count
FROM atp_dashboard.analytics_chart_snapshot
WHERE refresh_id IN
(
  SELECT refresh_id
  FROM atp_dashboard.analytics_chart_refresh_manifest
  WHERE status = 'completed'
  ORDER BY completed_at DESC
  LIMIT 1
)
  AND tool = 'event_counts'
  AND days = 7
  AND bucket_days = 1
  AND bucket_index = 0
")"

if [[ "$event_count" != "2" ]]; then
  echo "expected duplicate event_key to count once, got $event_count" >&2
  exit 1
fi

echo "ok presence pipeline rows=$rows active_users=$active_users event_count=$event_count"
