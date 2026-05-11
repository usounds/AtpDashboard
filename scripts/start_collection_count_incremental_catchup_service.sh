#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--confirm" ]]; then
  echo "[collection-count-catchup-service][ERROR] refusing without --confirm" >&2
  exit 2
fi

if [[ $EUID -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

log() {
  echo "[collection-count-catchup-service] $*"
}

log "installing systemd catch-up service"
"${SUDO[@]}" cp packages/clickhouse-tools/CollectionCountIncrementalCatchup.service /etc/systemd/system/
"${SUDO[@]}" systemctl daemon-reload

log "stopping timer-driven incremental refresh; catch-up service will run serial batches"
"${SUDO[@]}" systemctl disable --now CollectionCountIncrementalRefresh.timer >/dev/null 2>&1 || true
"${SUDO[@]}" systemctl stop CollectionCountIncrementalRefresh.service >/dev/null 2>&1 || true

log "starting CollectionCountIncrementalCatchup.service"
"${SUDO[@]}" systemctl restart CollectionCountIncrementalCatchup.service

log "started; follow progress with: sudo journalctl -u CollectionCountIncrementalCatchup.service -f"
"${SUDO[@]}" systemctl --no-pager --full status CollectionCountIncrementalCatchup.service || true
