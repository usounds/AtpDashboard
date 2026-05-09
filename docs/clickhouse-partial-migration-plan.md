# ClickHouse Partial Migration Plan

Last updated: 2026-05-09

## Decision

Use ClickHouse as a partial analytics read layer. Do not migrate the whole system.

Postgres remains the source of truth for:

- Raw `collection` data
- `cursor`
- `unique_did`
- `collection_lv2`
- Existing PostgREST endpoints that are not proven slow
- Operational recovery and rollback

ClickHouse starts with one endpoint:

- `collection_count_view`

This endpoint is the best first target because it is backed by the large `collection` relation, currently groups all rows by `collection`, and feeds the main collection list through `packages/frontend/src/zustand/collectionStore.ts`.

## Non-Goals

- Do not replace Postgres.
- Do not expose ClickHouse credentials to the browser.
- Do not move every PostgREST endpoint in the first iteration.
- Do not rewrite the frontend around a new API shape.
- Do not start with `event_logs_summary`; `event_logs` is currently much smaller than `collection` in the connected DB stats.

## Target Architecture

```text
ATProto Firehose / current ingestion
  -> Postgres
       source of truth
       existing PostgREST endpoints
  -> ClickHouse
       analytics read model for selected dashboard endpoints

React frontend
  -> existing PostgREST for most endpoints
  -> small API for ClickHouse-backed endpoints
```

The small API should return the same JSON shape as PostgREST for the first migrated endpoint so the frontend change stays tiny.

## First Endpoint: `collection_count_view`

Current Postgres view:

```sql
SELECT
  collection.collection,
  count(*) AS count,
  count(*) FILTER (
    WHERE collection."createdAt" >= now() - interval '72 hours'
  ) AS recent_count,
  min(collection."createdAt") AS min,
  max(collection."createdAt") AS max
FROM public.collection
WHERE collection.did <> 'did:web:lexicon.store'
GROUP BY collection.collection
ORDER BY max(collection."createdAt") DESC;
```

Required response shape:

```json
[
  {
    "collection": "app.bsky.feed.post",
    "count": 123,
    "recent_count": 45,
    "min": "2026-01-01T00:00:00",
    "max": "2026-05-09T12:00:00"
  }
]
```

## ClickHouse Schema

### Database

```sql
CREATE DATABASE IF NOT EXISTS atp_dashboard;
```

### Raw Collection Events

Keep a raw copy first. It gives us a simple rollback path and lets us rebuild summaries when the schema changes.

```sql
CREATE TABLE IF NOT EXISTS atp_dashboard.collection_events
(
    did String,
    collection String,
    rkey String,
    created_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (collection, created_at, did, rkey);
```

Why this shape:

- It mirrors the fields used by `collection_count_view`.
- Monthly partitions keep recent-window scans manageable.
- Ordering by `(collection, created_at, did, rkey)` helps collection-level grouping and latest/oldest lookups.

### Collection Summary

For the first iteration, use a periodically rebuilt table rather than a complicated exact incremental unique model.

```sql
CREATE TABLE IF NOT EXISTS atp_dashboard.collection_count_snapshot
(
    collection String,
    total_count UInt64,
    recent_count UInt64,
    min_created_at DateTime64(3, 'UTC'),
    max_created_at DateTime64(3, 'UTC'),
    refreshed_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(refreshed_at)
ORDER BY collection;
```

Refresh query:

```sql
INSERT INTO atp_dashboard.collection_count_snapshot
SELECT
    collection,
    count() AS total_count,
    countIf(created_at >= now() - INTERVAL 72 HOUR) AS recent_count,
    min(created_at) AS min_created_at,
    max(created_at) AS max_created_at,
    now64(3) AS refreshed_at
FROM atp_dashboard.collection_events
WHERE did != 'did:web:lexicon.store'
GROUP BY collection;
```

API query:

```sql
SELECT
    collection,
    argMax(total_count, refreshed_at) AS count,
    argMax(recent_count, refreshed_at) AS recent_count,
    argMax(min_created_at, refreshed_at) AS min,
    argMax(max_created_at, refreshed_at) AS max
FROM atp_dashboard.collection_count_snapshot
GROUP BY collection
ORDER BY max DESC;
```

This design intentionally avoids relying on background deduplication timing in `ReplacingMergeTree`.

## Backfill Plan

### Option A: Postgres `COPY` to ClickHouse insert

Export from Postgres:

```sql
COPY (
  SELECT
    did,
    collection,
    rkey,
    "createdAt" AT TIME ZONE 'UTC' AS created_at
  FROM public.collection
) TO STDOUT WITH CSV HEADER;
```

Import into ClickHouse using `CSVWithNames` or `JSONEachRow`.

### Option B: Streaming Worker

Create a small Node script:

1. Reads Postgres rows in `createdAt`/cursor batches.
2. Writes batches to ClickHouse HTTP API using `JSONEachRow`.
3. Stores progress in a local state file or a Postgres/ClickHouse checkpoint table.
4. Can resume safely.

This is the safer production path because the table is large.

Suggested batch key:

```text
createdAt, did, collection, rkey
```

## Incremental Sync Plan

Start simple:

1. Keep current ingestion writing to Postgres.
2. Run a cron sync every 1-5 minutes.
3. Sync rows where `createdAt > last_synced_created_at`.
4. Insert into ClickHouse.
5. Refresh `collection_count_snapshot`.

Later:

- If the ingestion worker is under our control, dual-write to Postgres and ClickHouse.
- If exact delivery matters, use a queue.
- If operational maturity is needed, evaluate logical replication/CDC.

## API Layer

Do not call ClickHouse directly from the browser.

Create a small API with one route:

```text
GET /collection_count_view
```

The route:

1. Queries ClickHouse.
2. Returns PostgREST-compatible JSON.
3. Sets short cache headers.
4. Falls back to Postgres endpoint if ClickHouse is unavailable.

Possible runtimes:

- Cloudflare Workers
- Vercel Functions
- Small Hono/Fastify service

Recommended first choice: Hono or Fastify if we want portable local testing; Cloudflare Workers if this is already behind Cloudflare.

## Frontend Change

Change only the endpoint source for the collection list:

File:

- `packages/frontend/src/zustand/collectionStore.ts`

Current:

```ts
fetch('https://collectiondata.usounds.work/collection_count_view')
```

Target:

```ts
fetch(import.meta.env.VITE_COLLECTION_COUNT_ENDPOINT ?? 'https://collectiondata.usounds.work/collection_count_view')
```

This allows instant rollback via environment config.

## Verification

Compare Postgres and ClickHouse outputs:

```text
row count
top 100 collections by count
top 100 collections by max
random 100 collections
recent_count difference
min/max difference
```

Acceptable first PoC tolerance:

- `count`: exact for backfilled range
- `min/max`: exact for backfilled range
- `recent_count`: exact if sync lag is below expected cron interval
- response schema: identical field names and compatible timestamp strings

## Rollback

Rollback should not require a deploy:

1. Keep the old PostgREST endpoint working.
2. Put the new endpoint behind `VITE_COLLECTION_COUNT_ENDPOINT`.
3. If ClickHouse API fails, API layer can proxy/fallback to PostgREST.
4. If results drift, switch env var back to PostgREST.

## Phased Roadmap

### Phase 0: Baseline

- Capture current response time for Postgres `/collection_count_view`.
- Capture payload size and row count.
- Capture DB stats with toolkit-postgres.

### Phase 1: Local/Dev ClickHouse PoC

- Create `collection_events`.
- Backfill a limited slice.
- Create `collection_count_snapshot`.
- Build the query that returns PostgREST-compatible JSON.

### Phase 2: API

- Add a tiny API route for `collection_count_view`.
- Add ClickHouse client configuration.
- Add fallback to Postgres.

### Phase 3: Frontend Switch

- Add endpoint env var in `collectionStore.ts`.
- Test page behavior without changing UI.

### Phase 4: Production Backfill and Sync

- Backfill all `collection` rows.
- Start incremental sync.
- Refresh snapshot on schedule.
- Compare results for at least 24 hours.

### Phase 5: Next Endpoints

After `collection_count_view` is stable, consider:

1. `collection_daily_summary_view`
2. `did_count_view`
3. `collection_min_max_did_view`
4. `distinct_schema_rkeys`

## Open Questions

- Where does the current ingestion worker live?
- Is `collectiondata.usounds.work` controlled through Cloudflare, Vercel, or another service?
- Can we run a small API service, or should this be serverless?
- How fresh does `recent_count` need to be: 1 minute, 5 minutes, 30 minutes?
- Do we need exact `count` forever, or is a bounded sync lag acceptable?

## Reference Notes

- ClickHouse materialized views can transform and aggregate data at insert time into target tables.
- ClickHouse HTTP interface can accept inserts and queries from standard HTTP clients.
- `ReplacingMergeTree` deduplicates during background merges, so API queries should not assume duplicates have already disappeared unless they aggregate by `argMax` or use another deterministic pattern.
