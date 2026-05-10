# Task 1 Implementation Log: Immediate Stabilization Script

## Summary

Added `scripts/stabilize_collection_count_load.sh` as the one-shot operational stabilization entrypoint for pausing collection count full-refresh load while keeping event ingestion current. Updated `scripts/stabilize_analytics_load.sh` so it also disables `CollectionCountReadModelRefresh` and keeps `CollectionEventsRescan` enabled instead of stopping it.

## Files

- Created `scripts/stabilize_collection_count_load.sh`
- Modified `scripts/stabilize_analytics_load.sh`
- Updated task status in `.spec-workflow/specs/collection-count-load-reduction/tasks.md`

## Verification

- `bash -n scripts/stabilize_collection_count_load.sh`
- `bash -n scripts/stabilize_analytics_load.sh`

## Artifacts

- `scripts`
  - `stabilize_collection_count_load.sh`: prints final state and semantic impact before mutating, stops/disables `CollectionCountReadModelRefresh` and `CollectionCountRefresh`, keeps `CollectionEventsSync` and `CollectionEventsRescan` enabled/active, checks local API response, verifies failed units, and machine-checks final unit states.
  - `stabilize_analytics_load.sh`: no longer disables `CollectionEventsRescan`; now disables `CollectionCountReadModelRefresh` in addition to prior heavy analytics timers.
