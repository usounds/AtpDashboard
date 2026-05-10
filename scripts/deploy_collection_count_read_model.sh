#!/usr/bin/env bash
set -Eeuo pipefail

cat >&2 <<'MESSAGE'
[collection-count-read-model][ERROR] legacy full-refresh deploy path is disabled.

This script used the old CollectionCountReadModelRefresh full-scan timer and
the legacy collection_count_refresh_manifest commit path. It must not be used
for normal production operation.

Use the incremental collection count deploy path instead:

  scripts/deploy_collection_count_incremental_read_model.sh --confirm

Until that deploy script is complete, keep these timers disabled/inactive:

  CollectionCountReadModelRefresh.timer
  CollectionCountRefresh.timer
MESSAGE

exit 1
