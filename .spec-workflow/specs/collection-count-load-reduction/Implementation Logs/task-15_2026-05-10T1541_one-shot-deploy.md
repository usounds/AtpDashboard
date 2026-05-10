# Implementation Log: Task 15

**Summary:** Replaced the incremental collection-count deploy helper with the full one-shot production deployment flow. The script now prints final state and semantic impact before mutation, disables old full-refresh units, applies only additive pre-cutover DDL, installs sync/rescan/incremental units with the incremental timer disabled, enables dual-write sync/rescan, records dual-write/bootstrap markers, drains bounded bootstrap sidecars, runs repair/P1/retention gates, publishes the incremental snapshot under the shared lock, proves a visible v2 completed marker, verifies local/public API continuity and strict ClickHouse responses for all three affected endpoints, checks failed units, verifies old refresh removal and load-reduction gates, and only then enables `CollectionCountIncrementalRefresh.timer`.

**Timestamp:** 2026-05-10T15:41:15Z
**Log ID:** task-15-one-shot-deploy

---

## Files Modified

- `scripts/deploy_collection_count_incremental_read_model.sh`
- `scripts/verify_collection_count_incremental_read_model.sh`
- `packages/clickhouse-tools/src/backfill-collection-events.ts`
- `packages/clickhouse-tools/src/backfill-collection-events.test.ts`
- `.spec-workflow/specs/collection-count-load-reduction/tasks.md`

## Key Behavior

- Failure finalizer disables `CollectionCountIncrementalRefresh`, `CollectionCountReadModelRefresh`, and `CollectionCountRefresh`.
- Pre-cutover DDL is statically checked for live manifest rename/drop/replace hazards.
- Bootstrap raw reads are allowed only in the explicit bootstrap path and now skip rows already recorded in `collection_count_event_existence_log`, so repeated bounded loops can drain instead of replaying the same first chunk.
- `run_all_deploy_gates_before_timer` must run before `enable_incremental_timer_after_gates`; the verify script machine-checks this call order.
- Final timer convergence is exact: sync, rescan, and incremental timers enabled/active; both legacy collection-count timers disabled/inactive; no failed units.

## Verification

- `rtk bash -n scripts/deploy_collection_count_incremental_read_model.sh scripts/verify_collection_count_incremental_read_model.sh`
- `rtk pnpm --filter @atpdashboard/clickhouse-tools test`

