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

const LATEST_VALID_COLLECTION_COUNT_REFRESH_CTE = `
latest_manifest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS latest_status,
    argMax(completed_at, tuple(updated_at, status_version)) AS latest_completed_at,
    argMax(row_count, tuple(updated_at, status_version)) AS row_count,
    argMax(run_id, tuple(updated_at, status_version)) AS run_id,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
    argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
    argMax(snapshot_anchor_at, tuple(updated_at, status_version)) AS snapshot_anchor_at,
    argMax(snapshot_written, tuple(updated_at, status_version)) AS snapshot_written,
    argMax(event_seen_written, tuple(updated_at, status_version)) AS event_seen_written,
    argMax(event_conflict_written, tuple(updated_at, status_version)) AS event_conflict_written,
    argMax(first_seen_written, tuple(updated_at, status_version)) AS first_seen_written,
    argMax(did_seen_written, tuple(updated_at, status_version)) AS did_seen_written,
    argMax(rkey_seen_written, tuple(updated_at, status_version)) AS rkey_seen_written,
    argMax(hourly_written, tuple(updated_at, status_version)) AS hourly_written,
    argMax(cumulative_users_written, tuple(updated_at, status_version)) AS cumulative_users_written,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM atp_dashboard.collection_count_refresh_manifest_v2
  GROUP BY refresh_id
),
valid_completed_all AS
(
  SELECT *
  FROM latest_manifest
  WHERE latest_status = 'completed'
    AND latest_completed_at IS NOT NULL
    AND invalidated_at IS NULL
    AND is_bootstrap_seed = 0
    AND run_id IS NOT NULL
    AND snapshot_anchor_at IS NOT NULL
    AND cutoff_queued_at IS NOT NULL
    AND cutoff_event_key IS NOT NULL
    AND cutoff_queue_seq != ''
    AND snapshot_written = 1
    AND event_seen_written = 1
    AND event_conflict_written = 1
    AND first_seen_written = 1
    AND did_seen_written = 1
    AND rkey_seen_written = 1
    AND hourly_written = 1
    AND cumulative_users_written = 1
    AND validation_passed = 1
),
latest_valid_completed AS
(
  SELECT *
  FROM valid_completed_all
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
)`;

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
  return readCollectionCountSnapshot(client, config, null);
}

export async function readCollectionCountForCollectionFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'snapshotMaxAgeSeconds' | 'clickhouseTimeoutMs'>,
  collection: string,
): Promise<CollectionCountResult> {
  return readCollectionCountSnapshot(client, config, collection);
}

async function readCollectionCountSnapshot(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'snapshotMaxAgeSeconds' | 'clickhouseTimeoutMs'>,
  collection: string | null,
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
  const rows = await withTimeout(
    readSnapshotRows(client, refresh.refresh_id, collection),
    config.clickhouseTimeoutMs,
    'ClickHouse collection_count read model query timed out',
  );

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

export async function readLatestCompletedRefresh(client: ClickHouseQueryClient): Promise<CompletedRefresh | null> {
  const result = await client.query({
    query: `
WITH
${LATEST_VALID_COLLECTION_COUNT_REFRESH_CTE}
SELECT
  toString(refresh_id) AS refresh_id,
  formatDateTime(latest_completed_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS completed_at,
  row_count
FROM latest_valid_completed
LIMIT 1
`,
    format: 'JSONEachRow',
  });
  const rows = await result.json<CompletedRefresh[]>();
  return rows[0] ?? null;
}

export async function readSnapshotRows(client: ClickHouseQueryClient, refreshId: string, collection: string | null = null): Promise<CollectionCountRow[]> {
  const collectionFilter = collection == null ? '' : '  AND collection = {collection:String}';
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
${collectionFilter}
ORDER BY max_created_at DESC NULLS LAST, collection ASC
`,
    query_params: {
      refresh_id: refreshId,
      ...(collection == null ? {} : { collection }),
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

export async function readCollectionStatsFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  collection: string,
): Promise<CollectionStatsResultRow[]> {
  const refresh = await withTimeout(readLatestCompletedRefresh(client), config.clickhouseTimeoutMs, 'ClickHouse latest refresh timed out');
  if (!refresh) {
    throw new Error('No completed collection_count refresh is available');
  }
  const rows = await withTimeout(readCollectionStatsRows(client, refresh.refresh_id, collection), config.clickhouseTimeoutMs, 'ClickHouse collection_stats query timed out');
  return rows.map((row) => ({
    collection: row.collection,
    unique_did: Number(row.unique_did),
    min_createdat: toPostgrestTimestamp(row.min_createdat),
    max_createdat: toPostgrestTimestamp(row.max_createdat),
    unique_rkey: Number(row.unique_rkey),
    total_count: Number(row.total_count),
  }));
}

async function readCollectionStatsRows(client: ClickHouseQueryClient, refreshId: string, collection: string): Promise<CollectionStatsRow[]> {
  const result = await client.query({
    query: `
SELECT
  collection,
  unique_did,
  min_created_at AS min_createdat,
  max_created_at AS max_createdat,
  unique_rkey,
  total_count
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = {refresh_id:UUID}
  AND collection = {collection:String}
LIMIT 1
`,
    query_params: {
      refresh_id: refreshId,
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
  const refresh = await withTimeout(readLatestCompletedRefresh(client), config.clickhouseTimeoutMs, 'ClickHouse latest refresh timed out');
  if (!refresh) {
    throw new Error('No completed collection_count refresh is available');
  }
  const rows = await withTimeout(
    readCollectionCumulativeUsersRows(client, refresh.refresh_id, params),
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
  refreshId: string,
  params: { collection: string; days: number; bucketDays: number },
): Promise<CollectionCumulativeUsersRow[]> {
  const result = await client.query({
    query: `
WITH
  {days:UInt16} AS lookback_days,
  {bucket_days:UInt8} AS requested_bucket_days,
  (
    SELECT max(day)
    FROM atp_dashboard.collection_count_cumulative_users_snapshot
    WHERE refresh_id = {refresh_id:UUID}
      AND collection = {collection:String}
  ) AS latest_day
SELECT
  toString(max(day)) AS date,
  -toInt16(bucket_index * requested_bucket_days) AS day_offset,
  sum(new_users) AS new,
  max(cumulative_users) AS cumulative
FROM
(
  SELECT
    day,
    new_users,
    cumulative_users,
    toUInt16(intDiv(dateDiff('day', day, latest_day), requested_bucket_days)) AS bucket_index
  FROM atp_dashboard.collection_count_cumulative_users_snapshot
  WHERE refresh_id = {refresh_id:UUID}
    AND collection = {collection:String}
    AND day > latest_day - toIntervalDay(lookback_days)
    AND day <= latest_day
)
GROUP BY bucket_index
ORDER BY bucket_index DESC
LIMIT 365
`,
    query_params: {
      refresh_id: refreshId,
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
