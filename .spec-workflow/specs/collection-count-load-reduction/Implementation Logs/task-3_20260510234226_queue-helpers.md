# Task 3 Implementation Log: Queue Sequence, Cursor, and Payload Helpers

## Summary

Added reusable incremental collection count helpers for canonical payload tuples, deterministic payload hashes, queue sequence generation, compound queue cursor comparison, cutoff bumping, queue cursor SQL predicates, and shared lock path constants.

## Files

- Created `packages/clickhouse-tools/src/collection-count-incremental.ts`
- Created `packages/clickhouse-tools/src/collection-count-incremental.test.ts`
- Updated task status in `.spec-workflow/specs/collection-count-load-reduction/tasks.md`

## Verification

- `node --test packages/clickhouse-tools/src/collection-count-incremental.test.ts`
- `pnpm --filter @atpdashboard/clickhouse-tools test`

## Artifacts

- `QueueSequenceGenerator`: lexicographic queue sequence generator with stable writer id, per-process monotonic counter, and non-empty sequence enforcement.
- `buildCanonicalPayloadTuple` / `buildPayloadHash`: deterministic normalized payload semantics for queue and existence log rows.
- `compareQueueCursor`, `isQueueCursorAfter`, `ensureQueueCursorAfterCutoffs`: compound `(queued_at, event_key, queue_seq)` ordering and cutoff protection helpers.
- `buildQueueCursorPredicate`: shared SQL predicate using queue cursor tuple instead of `source_ingested_at`.
- `COLLECTION_COUNT_INCREMENTAL_LOCK_PATH`: stable shared lock path for deploy/manual/systemd paths.
