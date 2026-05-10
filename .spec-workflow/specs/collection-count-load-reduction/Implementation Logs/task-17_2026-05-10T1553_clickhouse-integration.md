# Implementation Log: Task 17

**Summary:** Added a self-contained ClickHouse Docker integration test for the incremental collection-count pipeline and fixed two real ClickHouse/client behavior gaps exposed by the test. The script seeds queue/existence data, verifies orphan failure with no completed manifest, verifies duplicate event-key count-once behavior, same-run payload conflict recording, `did:web:lexicon.store` exclusion, cumulative artifact publication, zero-source aging refresh, and absence of periodic raw `collection_events` reads in the tested path.

**Timestamp:** 2026-05-10T15:53:07Z
**Log ID:** task-17-clickhouse-integration

---

## Files Modified

- `scripts/test_collection_count_incremental_clickhouse.sh`
- `packages/clickhouse-tools/src/refresh-collection-count-incremental.ts`
- `packages/clickhouse-tools/src/refresh-collection-count-incremental.test.ts`
- `packages/clickhouse-tools/src/backfill-collection-events.ts`
- `.spec-workflow/specs/collection-count-load-reduction/tasks.md`

## Bugs Found And Fixed

- Actual ClickHouse client `JSONEachRow` responses can be arrays, not only `{ data: [...] }`; `readCount` and bootstrap raw reads now accept both shapes.
- ClickHouse `LEFT JOIN` unmatched rows default to type defaults unless `join_use_nulls` is enabled; orphan and first-seen/unique delta anti-joins now test default empty keys instead of `IS NULL`.

## Verification

- `rtk bash -n scripts/test_collection_count_incremental_clickhouse.sh`
- `rtk pnpm --filter @atpdashboard/clickhouse-tools test`
- `rtk bash scripts/test_collection_count_incremental_clickhouse.sh`

