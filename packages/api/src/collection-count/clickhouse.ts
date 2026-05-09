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
  if (ageSeconds > config.snapshotMaxAgeSeconds) {
    const error = new Error(`Snapshot is stale: ${ageSeconds}s`);
    error.name = 'StaleSnapshotError';
    throw error;
  }

  const rows = await withTimeout(readSnapshotRows(client, refresh.refresh_id), config.clickhouseTimeoutMs, 'ClickHouse snapshot query timed out');

  return {
    rows,
    headers: {
      dataSource: 'clickhouse',
      fallbackReason: null,
      snapshotRefreshId: refresh.refresh_id,
      snapshotRefreshedAt: refresh.completed_at,
      snapshotAgeSeconds: ageSeconds,
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

export function isStaleSnapshotError(error: unknown): boolean {
  return error instanceof Error && error.name === 'StaleSnapshotError';
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
