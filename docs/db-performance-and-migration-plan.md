# DB Performance And Migration Plan

Last updated: 2026-05-09

## Schema Sync Note

Rechecked with `toolkit-postgres` on 2026-05-09. The live database differs from some local SQL files:

- `collection_stats` is a materialized view, per the live DDL supplied from pgAdmin/source inspection.
- `collection_did` was not visible in the live database metadata.
- `collection` is the dominant table: about 59.5M estimated live rows and about 31GB total size.
- `event_logs` is much smaller in the currently connected database: about 18.9k estimated live rows and about 51MB total size.
- `pg_stat_statements` is not installed, so query-level timing is currently unavailable.
- A live procedure `public.backfill_collection_id_batched` exists, but it references `collection.collection_id` and `collection_names`; those were not visible in the table metadata returned by toolkit-postgres and need follow-up validation before execution.

## Summary

The current dashboard is likely slow because public PostgREST endpoints expose views that aggregate large append-only tables at request time. The biggest risks are:

- `event_logs` has only a primary-key index, while dashboard views group by `creator_did`, `server_did`, `rkey`, and `create_at`.
- Several views over `collection` still run full-table `GROUP BY`, `COUNT(DISTINCT ...)`, `MIN`, and `MAX` calculations.
- Some pre-aggregation objects already exist (`collection_stats` materialized view, `unique_did`, `daily_active_did`, `daily_collection_stats`), but heavy read paths still call raw views instead of fully pre-aggregated objects.
- Daily cron jobs still recompute first-seen values from the full `collection` table.

Recommended direction:

1. Keep Postgres as the source of truth for now.
2. Add measurement first: `pg_stat_statements`, `EXPLAIN (ANALYZE, BUFFERS)`, table sizes, index usage.
3. Replace high-traffic raw views with precomputed tables or materialized views.
4. Add the minimum safe indexes and time-based partitioning.
5. Move only selected analytics queries to ClickHouse while keeping Postgres as ingestion/source-of-truth.

See also:

- `docs/clickhouse-partial-migration-plan.md` for the agreed partial migration plan. The first target is `collection_count_view`.

## Current Query Surface

The frontend currently reads these PostgREST endpoints:

- `/collection_count_view` from `packages/frontend/src/zustand/collectionStore.ts`
- `/collection_stats?collection=eq...` from `packages/frontend/src/components/StatsViewer.tsx`
- `/collection?select=...&collection=eq...&order=createdAt.desc&limit=1` from `packages/frontend/src/components/CollectionDetail.tsx`
- `/unique_did_count_view` from `packages/frontend/src/pages/Dashboard/ATmosphere.tsx`
- `/event_logs_summary` from `packages/frontend/src/pages/Dashboard/CustomFeedDashboard.tsx`
- `/rpc/get_event_logs_by_server` from `packages/frontend/src/components/CustomFeedList.tsx`
- `/distinct_schema_rkeys` from `packages/frontend/src/pages/Dashboard/CollectonBrowser.tsx`
- Daily chart views over `daily_active_did` and `daily_collection_stats`

## Likely Heavy Spots

### P0: `event_logs_summary`

File: `sql/postgres/view/event_logs_summary.sql`

Why it is heavy:

- It scans `event_logs` multiple times through CTEs.
- It calculates `COUNT(DISTINCT ...)` over high-cardinality columns.
- `event_logs` currently only has `event_logs_pkey` on `id`.
- There are no indexes for `create_at`, `creator_did`, `server_did`, or `(creator_did, rkey)`.

Immediate risk:

- Opening the Custom Feed dashboard can trigger expensive full-table aggregation.
- The RPC `get_event_logs_by_server` is probably another large aggregation path, though its function definition is not present in this repo.

### P0: `collection_count_view`

File: `sql/postgres/view/collection_count_view.sql`

Why it is heavy:

- It groups all `collection` rows by `collection`.
- It calculates total count, recent count, min, and max on each request.
- It orders by `max(createdAt)`, which is computed during aggregation.
- There is already a `collection_stats` materialized view that should replace most of this work, as long as its refresh strategy is acceptable.

Immediate risk:

- The dashboard loads the whole collection list from this view.
- As the firehose grows, this endpoint gets slower even if only a small dashboard summary is needed.

### P0: Daily first-seen cron

Files:

- `sql/postgres/cron/daily_active_did.sql`
- `sql/postgres/cron/daily_collection_stats.sql`

Why it is heavy:

- Both calculate first-seen values with `GROUP BY did` or `GROUP BY collection` over the whole `collection` table.
- This is a classic append-only dataset problem: first-seen should be maintained incrementally, not rediscovered daily.

### P1: `collection_stats` correctness and cost

Files:

- `sql/postgres/mview/collection_stats.sql`
- `sql/postgres/cron/update_collection_stats_hourly.sql`
- `sql/postgres/maintenance/backfill_collection_stats.sql`

Why it is risky:

- `unique_did` is maintained separately, which is good for global DID counts.
- `collection_did` was not visible in the live database metadata, so any script that depends on it needs validation before use.
- `unique_rkey` is incremented by `count(DISTINCT rkey)` per hour. If the same `rkey` can appear in multiple hourly windows for the same collection, this overcounts globally.
- Backfill uses `count(DISTINCT rkey)`, while the materialized view uses `count(DISTINCT ROW(did, collection, rkey))`; these are not equivalent.

### P1: Point lookup for latest record by collection

File: `packages/frontend/src/components/CollectionDetail.tsx`

Query pattern:

```text
collection=eq.<name>&order=createdAt.desc&limit=1
```

Current index:

```sql
CREATE INDEX collection_collection_created_at_idx
ON public.collection (collection, "createdAt");
```

This is close, but a descending index with included columns can be better for index-only scans:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS collection_latest_by_collection_idx
ON public.collection (collection, "createdAt" DESC)
INCLUDE (did, rkey);
```

## Measurement Plan

Run this before changing schema:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

SELECT query, calls, total_exec_time, mean_exec_time, rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

For each endpoint-backed view:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.event_logs_summary;

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.collection_count_view;

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.distinct_schema_rkeys;
```

Check table and index size:

```sql
SELECT
  relname,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_size_pretty(pg_relation_size(relid)) AS table_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

Check index usage:

```sql
SELECT
  relname,
  indexrelname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC, idx_tup_read DESC;
```

## Postgres-First Improvement Plan

### Phase 1: Safe indexing

Add indexes concurrently to reduce immediate pain:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS event_logs_create_at_idx
ON public.event_logs (create_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS event_logs_creator_create_at_idx
ON public.event_logs (creator_did, create_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS event_logs_server_create_at_idx
ON public.event_logs (server_did, create_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS event_logs_creator_rkey_create_at_idx
ON public.event_logs (creator_did, rkey, create_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS collection_created_at_brin_idx
ON public.collection USING BRIN ("createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS collection_latest_by_collection_idx
ON public.collection (collection, "createdAt" DESC)
INCLUDE (did, rkey);
```

Notes:

- Use `CONCURRENTLY` in production to avoid long write locks.
- BRIN is useful for very large append-only tables where timestamp order is correlated with physical storage.
- Re-check `EXPLAIN` after each index; do not keep indexes that are not used.

### Phase 2: Replace raw views with precomputed tables

Replace `collection_count_view` with a view backed by `collection_stats`:

```sql
CREATE OR REPLACE VIEW public.collection_count_view AS
SELECT
  collection,
  total_count AS count,
  NULL::bigint AS recent_count,
  min_createdat AS min,
  max_createdat AS max
FROM public.collection_stats
WHERE collection <> 'did:web:lexicon.store'
ORDER BY max_createdat DESC;
```

Then add a separate hourly or daily table for recent counts:

```sql
CREATE TABLE IF NOT EXISTS public.collection_recent_stats (
  collection text PRIMARY KEY,
  recent_72h_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

This avoids scanning raw `collection` just to render the list.

### Phase 3: Incremental first-seen tables

Create and maintain first-seen dimensions:

```sql
CREATE TABLE IF NOT EXISTS public.did_first_seen (
  did text PRIMARY KEY,
  first_seen timestamp without time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS public.collection_first_seen (
  collection text PRIMARY KEY,
  first_seen timestamp without time zone NOT NULL
);
```

Update them during ingestion or hourly maintenance:

```sql
INSERT INTO public.did_first_seen (did, first_seen)
SELECT did, min("createdAt")
FROM public.collection
WHERE "createdAt" >= date_trunc('hour', now() - interval '1 hour')
  AND "createdAt" < date_trunc('hour', now())
GROUP BY did
ON CONFLICT (did) DO UPDATE
SET first_seen = LEAST(did_first_seen.first_seen, EXCLUDED.first_seen);
```

Then daily jobs can count from small dimension tables instead of grouping the full event table.

### Phase 4: Event log summary table

Replace `event_logs_summary` with an incrementally maintained table:

```sql
CREATE TABLE IF NOT EXISTS public.event_logs_global_stats (
  id boolean PRIMARY KEY DEFAULT true,
  total_creators bigint NOT NULL DEFAULT 0,
  total_servers bigint NOT NULL DEFAULT 0,
  total_creator_rkeys bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id)
);

CREATE TABLE IF NOT EXISTS public.event_log_creator_first_seen (
  creator_did text PRIMARY KEY,
  first_seen timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS public.event_log_server_first_seen (
  server_did text PRIMARY KEY,
  first_seen timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS public.event_log_creator_rkey_first_seen (
  creator_did text NOT NULL,
  rkey text NOT NULL,
  first_seen timestamptz NOT NULL,
  PRIMARY KEY (creator_did, rkey)
);
```

Then `new_creators`, `new_servers`, and `new_creator_rkeys` become indexed counts over first-seen tables:

```sql
SELECT count(*)
FROM public.event_log_creator_first_seen
WHERE first_seen >= now() - interval '7 days';
```

### Phase 5: Partitioning

Partition append-only raw tables by time:

- `event_logs` by monthly `create_at`
- `collection` by monthly `createdAt`

Benefits:

- Recent-window queries prune old partitions.
- Retention or archive becomes a partition detach/drop operation.
- Vacuum/index maintenance gets smaller and more predictable.

## Migration Options Beyond Postgres

### Option A: TimescaleDB

Best fit if:

- You want to stay close to Postgres and SQL.
- Most queries are time-series aggregations.
- You want automatic/incremental continuous aggregates.

Why it fits this project:

- Existing schema is timestamp-heavy.
- Current cron-maintained rollups map naturally to continuous aggregates.
- It is the lowest-friction move from Postgres.

Tradeoffs:

- It is still Postgres-family operationally.
- Very high-cardinality distinct counts can still need careful design.
- Some features depend on TimescaleDB version and deployment model.

### Option B: ClickHouse

Best fit if:

- Dashboard reads are the priority.
- Raw events grow very large.
- You need fast `GROUP BY`, top-N, distinct-ish analytics, and time-window scans.

Why it fits this project:

- `collection` and `event_logs` are append-heavy analytical event tables.
- Materialized views and `AggregatingMergeTree` can pre-aggregate at ingest time.
- Postgres can remain the source of truth while ClickHouse serves dashboard reads.

Tradeoffs:

- More operational complexity than Postgres-only.
- Updates/deletes and exact relational constraints are not its sweet spot.
- Need an ingestion pipeline from Postgres/firehose to ClickHouse.

### Option C: Apache Druid

Best fit if:

- You want real-time OLAP over streaming events.
- You can accept ingestion-time rollup and segment-based operations.
- You want dashboard queries over enormous event streams.

Why it might fit:

- Firehose data can be rolled up during ingestion.
- Druid is strong for time-filtered, dimension-heavy dashboards.

Tradeoffs:

- More moving parts.
- Less natural for record-level lookup.
- Best when the analytics model is stable and rollup dimensions are well-defined.

### Option D: DuckDB + Object Storage

Best fit if:

- You need cheap offline analysis or periodic report generation.
- Queries do not need to be highly concurrent or live.

Why it is not the first choice here:

- This dashboard appears interactive and public.
- DuckDB is excellent for local/embedded analytics, but it is not the cleanest serving layer for a public real-time dashboard.

## Recommended Architecture

Use a two-tier model:

```text
ATProto Firehose
  -> ingestion worker
  -> Postgres raw tables and dimensions
  -> incremental summary tables
  -> PostgREST dashboard endpoints
```

If Postgres remains too slow:

```text
ATProto Firehose
  -> ingestion worker
  -> Postgres source-of-truth
  -> ClickHouse analytics tables
  -> dashboard reads from ClickHouse-backed API
```

Recommended first migration target: ClickHouse for analytics, not a full replacement of Postgres. The first endpoint to migrate should be `collection_count_view`.

Reason:

- The slow paths are OLAP/dashboard aggregations, not transactional writes.
- Keeping Postgres avoids a risky all-at-once migration.
- ClickHouse can be introduced endpoint by endpoint.

## Proposed Roadmap

### Week 1: Measure and quick wins

- Enable `pg_stat_statements`.
- Capture top slow queries and `EXPLAIN (ANALYZE, BUFFERS)`.
- Add missing indexes on `event_logs`.
- Add BRIN timestamp indexes on append-only raw tables.
- Confirm whether `get_event_logs_by_server` is a SQL function in production and export it into this repo.

### Week 2: Precompute dashboard endpoints

- Replace `collection_count_view` with a `collection_stats`-backed view.
- Add `collection_recent_stats`.
- Add first-seen tables for DID, collection, event-log creator, server, and creator-rkey.
- Rewrite daily cron jobs to read first-seen tables.

### Week 3: Partition and retention

- Partition `event_logs` and `collection` by month.
- Add retention/archive policy for raw data if dashboard does not need infinite raw history online.
- Keep summaries permanently.

### Week 4: Analytics DB proof of concept

- Mirror `event_logs` and `collection` into ClickHouse.
- Build ClickHouse equivalents for:
  - `event_logs_summary`
  - `get_event_logs_by_server`
  - `collection_count_view`
- Compare latency, cost, and operational burden against optimized Postgres.

## Acceptance Criteria

- Dashboard top-level endpoints respond in under 500 ms p95 from the database layer.
- No public endpoint runs full-table `COUNT(DISTINCT ...)` on raw event tables.
- Daily maintenance does not group the entire raw `collection` table.
- Slow-query list has no dashboard endpoint in the top 10 by total execution time after optimization.
- Analytics migration is optional and endpoint-by-endpoint, not a risky big bang.

## Source Notes

- PostgreSQL `pg_stat_statements` tracks planning and execution statistics for SQL statements.
- PostgreSQL BRIN indexes are designed for very large tables where indexed values correlate with physical row order.
- TimescaleDB continuous aggregates incrementally refresh aggregate data in the background.
- ClickHouse materialized views can prepare aggregated data at ingest time to make SELECT queries faster.
- Apache Druid rollup can pre-aggregate at ingestion time, reducing stored rows at the cost of raw event detail.
