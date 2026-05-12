#!/usr/bin/env bash
set -euo pipefail

MAX_LOOPS="${MAX_LOOPS:-1000}"
MAX_ROWS="${MAX_ROWS:-500000}"
SLEEP_SECONDS="${SLEEP_SECONDS:-5}"
CLICKHOUSE_CONTAINER="${CLICKHOUSE_CONTAINER:-atpdashboard-clickhouse}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-atp_dashboard}"

if [[ "${1:-}" != "--confirm" ]]; then
  echo "[collection-count-catchup][ERROR] refusing without --confirm" >&2
  exit 2
fi

if [[ $EUID -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

log() {
  echo "[collection-count-catchup] $*"
}

ch() {
  docker exec -i "$CLICKHOUSE_CONTAINER" clickhouse-client --database "$CLICKHOUSE_DATABASE" "$@"
}

latest_manifest_tsv() {
  ch --query "
SELECT
  completed_at,
  row_count,
  source_rows,
  cutoff_queued_at,
  refresh_id
FROM
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS status,
    argMax(completed_at, tuple(updated_at, status_version)) AS completed_at,
    argMax(row_count, tuple(updated_at, status_version)) AS row_count,
    argMax(source_rows, tuple(updated_at, status_version)) AS source_rows,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM collection_count_refresh_manifest_v2
  GROUP BY refresh_id
)
WHERE status = 'completed'
  AND completed_at IS NOT NULL
  AND validation_passed = 1
  AND invalidated_at IS NULL
  AND is_bootstrap_seed = 0
ORDER BY completed_at DESC, cutoff_queued_at DESC, refresh_id DESC
LIMIT 1
FORMAT TSV"
}

log "disabling timer so catch-up is controlled by this runner"
"${SUDO[@]}" systemctl disable --now CollectionCountIncrementalRefresh.timer >/dev/null 2>&1 || true

for ((loop = 1; loop <= MAX_LOOPS; loop += 1)); do
  before="$(latest_manifest_tsv || true)"
  log "loop=$loop starting CollectionCountIncrementalRefresh.service"

  if ! "${SUDO[@]}" systemctl start CollectionCountIncrementalRefresh.service; then
    log "service failed; recent journal follows"
    "${SUDO[@]}" journalctl -u CollectionCountIncrementalRefresh.service -n 80 --no-pager >&2 || true
    exit 1
  fi

  after="$(latest_manifest_tsv || true)"
  if [[ -z "$after" ]]; then
    log "no completed manifest found after loop=$loop"
    sleep "$SLEEP_SECONDS"
    continue
  fi

  IFS=$'\t' read -r completed_at row_count source_rows cutoff_queued_at refresh_id <<<"$after"
  log "loop=$loop completed_at=$completed_at snapshot_rows=$row_count source_rows=$source_rows cutoff_queued_at=$cutoff_queued_at refresh_id=$refresh_id"

  if [[ "$after" == "$before" ]]; then
    log "latest manifest did not advance; stopping to avoid a blind loop"
    exit 1
  fi

  if [[ "$source_rows" =~ ^[0-9]+$ ]] && (( source_rows == 0 )); then
    log "caught up: last batch source_rows=0"
    exit 0
  fi

  if [[ "$source_rows" =~ ^[0-9]+$ ]] && (( source_rows < MAX_ROWS )); then
    log "continuing: source_rows=$source_rows is below max_rows=$MAX_ROWS, but bounded queued_at spans can produce partial batches before backlog is drained"
  fi

  sleep "$SLEEP_SECONDS"
done

log "reached MAX_LOOPS=$MAX_LOOPS before catch-up completed"
exit 1
