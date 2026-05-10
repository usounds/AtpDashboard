import type { CollectionCountApiConfig } from './config.ts';
import type { CollectionCountResult, CollectionCountRow } from './types.ts';

export type ClickHouseQueryClient = {
  query: (params: { query: string; query_params?: Record<string, unknown>; format?: 'JSONEachRow' }) => Promise<{
    json: <T>() => Promise<T>;
  }>;
  close?: () => Promise<void>;
};

export type CompletedRefresh = {
  refresh_id: string;
  completed_at: string;
  row_count: string | number;
};

export type SnapshotRow = {
  collection: string;
  count: string | number;
  recent_count: string | number;
  min: string | null;
  max: string | null;
  refresh_id: string;
  refreshed_at: string;
};

export type CollectionStatsRow = {
  collection: string;
  unique_did: string | number;
  min_createdat: string | null;
  max_createdat: string | null;
  unique_rkey: string | number;
  total_count: string | number;
};

export type CollectionStatsResultRow = {
  collection: string;
  unique_did: number;
  min_createdat: string | null;
  max_createdat: string | null;
  unique_rkey: number;
  total_count: number;
};

export type CollectionCumulativeUsersRow = {
  date: string;
  day_offset: string | number;
  new: string | number;
  cumulative: string | number;
};

export type CollectionCumulativeUsersResultRow = {
  date: string;
  day_offset: number;
  new: number;
  cumulative: number;
};

export function toPostgrestTimestamp(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  return value.replace(/(\.\d*?[1-9])0+Z$/, '$1').replace(/\.0+Z$/, '').replace(/Z$/, '');
}

export async function createClickHouseClient(config: CollectionCountApiConfig): Promise<ClickHouseQueryClient | null> {
  if (!config.clickhouseUrl) {
    return null;
  }
  const { createClient } = await import('@clickhouse/client');
  return createClient({
    url: config.clickhouseUrl,
    username: config.clickhouseUsername ?? undefined,
    password: config.clickhousePassword ?? undefined,
    database: config.clickhouseDatabase,
  });
}

export async function readCollectionCountFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'snapshotMaxAgeSeconds' | 'clickhouseTimeoutMs'>,
): Promise<CollectionCountResult> {
  const refresh = await withTimeout(readLatestCompletedRefresh(client), config.clickhouseTimeoutMs, 'ClickHouse latest refresh timed out');
  if (!refresh) {
    throw new Error('No completed collection_count refresh is available');
  }

  const completedAtMs = Date.parse(refresh.completed_at);
  if (Number.isNaN(completedAtMs)) {
    throw new Error(`Invalid completed_at from ClickHouse: ${refresh.completed_at}`);
  }

  const ageSeconds = Math.max(Math.floor((Date.now() - completedAtMs) / 1000), 0);
  const rows = await withTimeout(readSnapshotRows(client, refresh.refresh_id), config.clickhouseTimeoutMs, 'ClickHouse snapshot query timed out');

  return {
    rows,
    headers: {
      dataSource: 'clickhouse',
      fallbackReason: ageSeconds > config.snapshotMaxAgeSeconds ? 'stale_snapshot' : null,
      snapshotRefreshId: refresh.refresh_id,
      snapshotRefreshedAt: refresh.completed_at,
      snapshotAgeSeconds: ageSeconds,
    },
  };
}

export async function readCollectionCountForCollectionFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  collection: string,
): Promise<CollectionCountResult> {
  const rows = await withTimeout(
    readLiveCollectionCountRows(client, collection),
    config.clickhouseTimeoutMs,
    'ClickHouse live collection_count_view query timed out',
  );

  return {
    rows,
    headers: {
      dataSource: 'clickhouse',
      fallbackReason: null,
      snapshotRefreshId: null,
      snapshotRefreshedAt: null,
      snapshotAgeSeconds: null,
    },
  };
}

export async function readLatestCompletedRefresh(client: ClickHouseQueryClient): Promise<CompletedRefresh | null> {
  const result = await client.query({
    query: `
SELECT
  toString(refresh_id) AS refresh_id,
  formatDateTime(completed_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS completed_at,
  row_count
FROM atp_dashboard.collection_count_refresh_manifest
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 1
`,
    format: 'JSONEachRow',
  });
  const rows = await result.json<CompletedRefresh[]>();
  return rows[0] ?? null;
}

export async function readSnapshotRows(client: ClickHouseQueryClient, refreshId: string): Promise<CollectionCountRow[]> {
  const result = await client.query({
    query: `
SELECT
  collection,
  total_count AS count,
  recent_count,
  if(isNull(min_created_at), NULL, formatDateTime(min_created_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')) AS min,
  if(isNull(max_created_at), NULL, formatDateTime(max_created_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')) AS max
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = {refresh_id:UUID}
ORDER BY max_created_at DESC NULLS LAST, collection ASC
`,
    query_params: {
      refresh_id: refreshId,
    },
    format: 'JSONEachRow',
  });
  const rows = await result.json<SnapshotRow[]>();
  return rows.map((row) => ({
    collection: row.collection,
    count: Number(row.count),
    recent_count: Number(row.recent_count),
    min: toPostgrestTimestamp(row.min),
    max: toPostgrestTimestamp(row.max),
  }));
}

async function readLiveCollectionCountRows(client: ClickHouseQueryClient, collection: string): Promise<CollectionCountRow[]> {
  const result = await client.query({
    query: `
SELECT
  collection,
  uniqExact(event_key) AS count,
  uniqExactIf(event_key, isNotNull(created_at) AND created_at >= now64(6, 'UTC') - toIntervalHour(72)) AS recent_count,
  if(countIf(created_at_key != '<NULL>') = 0, NULL, parseDateTime64BestEffortOrNull(minIf(created_at_key, created_at_key != '<NULL>'), 6, 'UTC')) AS min_created_at,
  if(countIf(created_at_key != '<NULL>') = 0, NULL, parseDateTime64BestEffortOrNull(maxIf(created_at_key, created_at_key != '<NULL>'), 6, 'UTC')) AS max_created_at
FROM atp_dashboard.collection_events
WHERE collection = {collection:String}
GROUP BY collection
LIMIT 1
`,
    query_params: {
      collection,
    },
    format: 'JSONEachRow',
  });
  const rows = await result.json<Array<{
    collection: string;
    count: string | number;
    recent_count: string | number;
    min_created_at: string | null;
    max_created_at: string | null;
  }>>();
  return rows.map((row) => ({
    collection: row.collection,
    count: Number(row.count),
    recent_count: Number(row.recent_count),
    min: toPostgrestTimestamp(row.min_created_at),
    max: toPostgrestTimestamp(row.max_created_at),
  }));
}

export async function readCollectionStatsFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  collection: string,
): Promise<CollectionStatsResultRow[]> {
  const rows = await withTimeout(readCollectionStatsRows(client, collection), config.clickhouseTimeoutMs, 'ClickHouse collection_stats query timed out');
  return rows.map((row) => ({
    collection: row.collection,
    unique_did: Number(row.unique_did),
    min_createdat: toPostgrestTimestamp(row.min_createdat),
    max_createdat: toPostgrestTimestamp(row.max_createdat),
    unique_rkey: Number(row.unique_rkey),
    total_count: Number(row.total_count),
  }));
}

async function readCollectionStatsRows(client: ClickHouseQueryClient, collection: string): Promise<CollectionStatsRow[]> {
  const result = await client.query({
    query: `
SELECT
  collection,
  uniqExact(did) AS unique_did,
  if(countIf(created_at_key != '<NULL>') = 0, NULL, parseDateTime64BestEffortOrNull(minIf(created_at_key, created_at_key != '<NULL>'), 6, 'UTC')) AS min_createdat,
  if(countIf(created_at_key != '<NULL>') = 0, NULL, parseDateTime64BestEffortOrNull(maxIf(created_at_key, created_at_key != '<NULL>'), 6, 'UTC')) AS max_createdat,
  uniqExact(tuple(did, collection, rkey)) AS unique_rkey,
  uniqExact(event_key) AS total_count
FROM atp_dashboard.collection_events
WHERE collection = {collection:String}
GROUP BY collection
LIMIT 1
`,
    query_params: {
      collection,
    },
    format: 'JSONEachRow',
  });
  return result.json<CollectionStatsRow[]>();
}

export async function readCollectionCumulativeUsersFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  params: { collection: string; days: number; bucketDays: number },
): Promise<CollectionCumulativeUsersResultRow[]> {
  const rows = await withTimeout(
    readCollectionCumulativeUsersRows(client, params),
    config.clickhouseTimeoutMs,
    'ClickHouse collection_cumulative_users query timed out',
  );
  return rows.map((row) => ({
    date: row.date,
    day_offset: Number(row.day_offset),
    new: Number(row.new),
    cumulative: Number(row.cumulative),
  }));
}

async function readCollectionCumulativeUsersRows(
  client: ClickHouseQueryClient,
  params: { collection: string; days: number; bucketDays: number },
): Promise<CollectionCumulativeUsersRow[]> {
  const result = await client.query({
    query: `
WITH
  latest_refresh AS
  (
    SELECT refresh_id
    FROM atp_dashboard.collection_count_refresh_manifest
    WHERE status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  ),
  latest_snapshot AS
  (
    SELECT
      max_created_at
    FROM atp_dashboard.collection_count_snapshot
    INNER JOIN latest_refresh USING refresh_id
    WHERE collection = {collection:String}
    LIMIT 1
  ),
  {days:UInt16} AS lookback_days,
  {bucket_days:UInt8} AS requested_bucket_days,
  toUInt16(ceil(lookback_days / requested_bucket_days)) AS bucket_count,
  requested_bucket_days * 86400 AS bucket_seconds,
  (SELECT max_created_at FROM latest_snapshot) AS latest_at,
  latest_at - toIntervalDay(lookback_days) AS window_start_at,
  (
    SELECT uniqExact(did)
    FROM atp_dashboard.collection_did_first_seen_snapshot
    INNER JOIN latest_refresh USING refresh_id
    WHERE collection = {collection:String}
      AND first_seen_at <= window_start_at
  ) AS baseline_users
SELECT
  toString(date) AS date,
  day_offset,
  new,
  baseline_users + sum(new) OVER (ORDER BY bucket_index DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
FROM
(
  SELECT
    days.bucket_index AS bucket_index,
    toString(toDate(days.bucket_end_at, 'UTC')) AS date,
    -toInt16(days.bucket_index * requested_bucket_days) AS day_offset,
    toUInt64(coalesce(new_users.new, 0)) AS new
  FROM
  (
    SELECT
      toUInt16(arrayJoin(range(bucket_count))) AS bucket_index,
      latest_at - toIntervalSecond(bucket_index * bucket_seconds) AS bucket_end_at
  ) AS days
  LEFT JOIN
  (
    SELECT
      toUInt16(intDiv(dateDiff('second', first_seen_at, latest_at), bucket_seconds)) AS bucket_index,
      uniqExact(did) AS new
    FROM atp_dashboard.collection_did_first_seen_snapshot
    INNER JOIN latest_refresh USING refresh_id
    WHERE first_seen_at > window_start_at
      AND first_seen_at <= latest_at
      AND collection = {collection:String}
    GROUP BY bucket_index
  ) AS new_users USING (bucket_index)
)
ORDER BY bucket_index DESC
`,
    query_params: {
      collection: params.collection,
      days: params.days,
      bucket_days: params.bucketDays,
    },
    format: 'JSONEachRow',
  });
  return result.json<CollectionCumulativeUsersRow[]>();
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
