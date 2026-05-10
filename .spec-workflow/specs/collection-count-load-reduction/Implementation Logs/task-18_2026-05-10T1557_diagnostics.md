# Implementation Log: Task 18

**Summary:** Extended production verification and diagnostics for the incremental collection-count deployment. Verification now has an explicit load-reduction gate, machine-tagged approved bootstrap/catch-up queries, static checks for those tags, and deploy invokes the load gate during post-cutover verification. Diagnostics now print latest manifest v2 state, queue/existence/orphan/conflict/backlog status, forbidden broad raw query evidence, incremental and legacy journal sections, and exact timer state.

**Timestamp:** 2026-05-10T15:57:20Z
**Log ID:** task-18-diagnostics

---

## Files Modified

- `scripts/verify_collection_count_incremental_read_model.sh`
- `scripts/diagnose_analytics_load.sh`
- `scripts/deploy_collection_count_incremental_read_model.sh`
- `packages/clickhouse-tools/src/backfill-collection-events.ts`
- `packages/clickhouse-tools/src/backfill-collection-events.test.ts`
- `packages/clickhouse-tools/src/refresh-collection-count-incremental.ts`
- `packages/clickhouse-tools/src/refresh-collection-count-incremental.test.ts`
- `.spec-workflow/specs/collection-count-load-reduction/tasks.md`

## Key Behavior

- `--load-gates` fails closed on active legacy full-refresh timers/processes, forbidden broad `collection_events` aggregation in active/recent ClickHouse logs, and recent old full-refresh systemd starts.
- Approved bootstrap/catch-up work is distinguished by SQL comments: `collection_count_bootstrap_bounded` and `collection_count_incremental_catchup`.
- `diagnose_analytics_load.sh` now reports collection-count manifest, queue health, forbidden raw query evidence, incremental journals, legacy journals, and timer enable/active state.

## Verification

- `rtk bash -n scripts/verify_collection_count_incremental_read_model.sh scripts/deploy_collection_count_incremental_read_model.sh scripts/diagnose_analytics_load.sh`
- `rtk pnpm --filter @atpdashboard/clickhouse-tools test`
- `rtk bash scripts/test_collection_count_incremental_clickhouse.sh`

