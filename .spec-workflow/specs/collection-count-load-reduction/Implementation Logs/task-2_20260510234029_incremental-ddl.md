# Task 2 Implementation Log: Incremental Collection Count DDL

## Summary

Added the pre-cutover additive ClickHouse DDL for the incremental collection count model and schema tests for the required manifest, queue, stage, state, delta, and current-stage key artifacts.

## Files

- Created `sql/clickhouse/007_collection_count_incremental.sql`
- Created `packages/clickhouse-tools/src/refresh-collection-count-incremental.test.ts`
- Updated task status in `.spec-workflow/specs/collection-count-load-reduction/tasks.md`

## Verification

- `node --test packages/clickhouse-tools/src/refresh-collection-count-incremental.test.ts`
- `pnpm --filter @atpdashboard/clickhouse-tools test`

## Artifacts

- `sql/clickhouse/007_collection_count_incremental.sql`
  - Additive pre-cutover DDL only; it does not rename/drop/replace the live legacy manifest.
  - Defines `collection_count_refresh_manifest_v2`, queue, existence log, raw/canonical stages, seen/conflict/orphan tables, delta/state tables, cumulative users snapshot, and current-stage key/probe tables.
  - Provides a v2 compatibility preview view with latest-valid gates.
- `packages/clickhouse-tools/src/refresh-collection-count-incremental.test.ts`
  - Verifies additive migration constraints, manifest validity gates, physical queue row preservation, and bounded probe-friendly table order keys.
