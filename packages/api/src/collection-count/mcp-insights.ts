import type { CollectionCountApiConfig } from './config.ts';
import type { ClickHouseQueryClient } from './clickhouse.ts';

export const MCP_READ_CACHE_TTL_MS = 10 * 60 * 1000;

const MAX_DAYS = 14;
const MAX_LIMIT = 100;
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 30;
const LEXICON_STORE_DID = 'did:web:lexicon.store';

export type McpCacheStatus = 'HIT' | 'MISS';

export type McpCacheEntry<T> = {
  expiresAt: number;
  value?: T;
  inFlight?: Promise<T>;
};

export type NewCollectionRow = {
  collection: string;
  first_seen_at: string;
  event_count: number;
};

export type ActiveCollectionRow = {
  collection: string;
  event_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

type RawNewCollectionRow = {
  collection: string;
  first_seen_at: string;
  event_count: string | number;
};

type RawActiveCollectionRow = {
  collection: string;
  event_count: string | number;
  first_seen_at: string;
  last_seen_at: string;
};

export function parseMcpDays(value: string | number | undefined): number {
  return parseBoundedInteger(value, DEFAULT_DAYS, 1, MAX_DAYS);
}

export function parseMcpLimit(value: string | number | undefined): number {
  return parseBoundedInteger(value, DEFAULT_LIMIT, 1, MAX_LIMIT);
}

export function buildMcpCacheKey(tool: string, params: { days: number; limit: number }): string {
  return `${tool}:days=${params.days}:limit=${params.limit}`;
}

export async function readThroughMcpCache<T>(
  cache: Map<string, McpCacheEntry<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<{ value: T; status: McpCacheStatus }> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return { value: cached.value, status: 'HIT' };
  }
  if (cached?.inFlight) {
    return { value: await cached.inFlight, status: 'HIT' };
  }

  const inFlight = load();
  cache.set(key, { expiresAt: now + MCP_READ_CACHE_TTL_MS, inFlight });
  try {
    const value = await inFlight;
    cache.set(key, { expiresAt: Date.now() + MCP_READ_CACHE_TTL_MS, value });
    return { value, status: 'MISS' };
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

export async function readNewCollectionsFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  params: { days: number; limit: number },
): Promise<NewCollectionRow[]> {
  const result = await withTimeout(
    client.query({
      query: `
WITH
  {days:UInt16} AS lookback_days,
  (
    SELECT max(ingested_at)
    FROM atp_dashboard.collection_events
  ) AS latest_at
SELECT
  collection,
  formatDateTime(first_seen_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS first_seen_at,
  event_count
FROM
(
  SELECT
    collection,
    min(ingested_at) AS first_seen_at,
    countIf(ingested_at > latest_at - toIntervalDay(lookback_days) AND ingested_at <= latest_at) AS event_count
  FROM atp_dashboard.collection_events
  WHERE did != {excluded_did:String}
  GROUP BY collection
)
WHERE first_seen_at > latest_at - toIntervalDay(lookback_days)
  AND first_seen_at <= latest_at
ORDER BY first_seen_at DESC, event_count DESC, collection ASC
LIMIT {row_limit:UInt16}
`,
      query_params: {
        days: params.days,
        row_limit: params.limit,
        excluded_did: LEXICON_STORE_DID,
      },
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse MCP new_collections query timed out',
  );
  const rows = await result.json<RawNewCollectionRow[]>();
  return rows.map((row) => ({
    collection: row.collection,
    first_seen_at: row.first_seen_at,
    event_count: Number(row.event_count),
  }));
}

export async function readActiveCollectionsFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  params: { days: number; limit: number },
): Promise<ActiveCollectionRow[]> {
  const result = await withTimeout(
    client.query({
      query: `
WITH
  {days:UInt16} AS lookback_days,
  (
    SELECT toDate(max(created_at))
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_day
SELECT
  collection,
  count() AS event_count,
  formatDateTime(min(created_at), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS first_seen_at,
  formatDateTime(max(created_at), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS last_seen_at
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
  AND did != {excluded_did:String}
  AND toDate(created_at) >= latest_day - toIntervalDay(lookback_days - 1)
GROUP BY collection
ORDER BY event_count DESC, collection ASC
LIMIT {row_limit:UInt16}
`,
      query_params: {
        days: params.days,
        row_limit: params.limit,
        excluded_did: LEXICON_STORE_DID,
      },
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse MCP active_collections query timed out',
  );
  const rows = await result.json<RawActiveCollectionRow[]>();
  return rows.map((row) => ({
    collection: row.collection,
    event_count: Number(row.event_count),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  }));
}

function parseBoundedInteger(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Value must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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
