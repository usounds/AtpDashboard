import type { CollectionCountApiConfig } from './config.ts';
import type { ClickHouseQueryClient } from './clickhouse.ts';

export const MCP_READ_CACHE_TTL_MS = 10 * 60 * 1000;

const MAX_DAYS = 14;
const MAX_LIMIT = 100;
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 30;
const LEXICON_STORE_DID = 'did:web:lexicon.store';
const DEFAULT_GET_RECORD_SERVICE = 'https://slingshot.microcosm.blue';

export type McpCacheStatus = 'HIT' | 'MISS';

export type McpDateRange = {
  days: number;
  startDate?: string;
  endDate?: string;
  startDateTime?: string;
  endExclusiveDateTime?: string;
};

export type McpCacheEntry<T> = {
  expiresAt: number;
  value?: T;
  inFlight?: Promise<T>;
};

export type NewCollectionRow = {
  collection: string;
  first_seen_at: string;
  event_count: number;
  latest_record_created_at: string;
  latest_record_at_uri: string;
  latest_record_get_record_url: string;
};

export type NamespaceCollectionRow = {
  collection: string;
  first_seen_at: string;
  last_seen_at: string;
  event_count: number;
  latest_record_created_at: string;
  latest_record_at_uri: string;
  latest_record_get_record_url: string;
};

export type ActiveCollectionRow = {
  collection: string;
  event_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

export type LatestCollectionRecordPointer = {
  collection: string;
  created_at: string;
  did: string;
  rkey: string;
  at_uri: string;
  get_record_url: string;
};

type RawNewCollectionRow = {
  collection: string;
  first_seen_at: string;
  event_count: string | number;
  latest_record_created_at: string;
  latest_record_did: string;
  latest_record_rkey: string;
};

type RawActiveCollectionRow = {
  collection: string;
  event_count: string | number;
  first_seen_at: string;
  last_seen_at: string;
};

type RawNamespaceCollectionRow = {
  collection: string;
  first_seen_at: string;
  last_seen_at: string;
  event_count: string | number;
  latest_record_created_at: string;
  latest_record_did: string;
  latest_record_rkey: string;
};

type RawLatestCollectionRecordPointer = {
  collection: string;
  created_at: string;
  did: string;
  rkey: string;
};

export function parseMcpDays(value: string | number | undefined): number {
  return parseBoundedInteger(value, DEFAULT_DAYS, 1, MAX_DAYS);
}

export function parseMcpLimit(value: string | number | undefined): number {
  return parseBoundedInteger(value, DEFAULT_LIMIT, 1, MAX_LIMIT);
}

export function parseMcpDateRange(params: {
  days?: string | number;
  startDate?: string;
  endDate?: string;
}): McpDateRange {
  const hasStartDate = params.startDate != null && params.startDate.trim() !== '';
  const hasEndDate = params.endDate != null && params.endDate.trim() !== '';
  if (!hasStartDate && !hasEndDate) {
    return { days: parseMcpDays(params.days) };
  }
  if (!hasStartDate || !hasEndDate) {
    throw new Error('start_date and end_date must be provided together');
  }

  const startDate = parseMcpDateOnly(params.startDate);
  const endDate = parseMcpDateOnly(params.endDate);
  if (startDate > endDate) {
    throw new Error('start_date must be before or equal to end_date');
  }

  return {
    days: parseMcpDays(params.days),
    startDate,
    endDate,
    startDateTime: `${startDate} 00:00:00.000000`,
    endExclusiveDateTime: `${addUtcDays(endDate, 1)} 00:00:00.000000`,
  };
}

export function buildMcpCacheKey(tool: string, params: McpDateRange & { limit?: number; namespacePrefix?: string }): string {
  const rangeKey =
    params.startDate != null && params.endDate != null ? `start=${params.startDate}:end=${params.endDate}` : `days=${params.days}`;
  const limitKey = params.limit == null ? '' : `:limit=${params.limit}`;
  const namespaceKey = params.namespacePrefix == null ? '' : `:namespace=${params.namespacePrefix}`;
  return `${tool}:${rangeKey}${limitKey}${namespaceKey}`;
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
  params: McpDateRange,
): Promise<NewCollectionRow[]> {
  const hasExplicitDateRange = params.startDateTime != null && params.endExclusiveDateTime != null;
  const result = await withTimeout(
    client.query({
      query: `
WITH
  {days:UInt16} AS lookback_days,
  {has_explicit_date_range:Bool} AS has_explicit_date_range,
  (
    SELECT max(created_at)
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_at,
  if(
    has_explicit_date_range,
    parseDateTime64BestEffort({start_at:String}, 6, 'UTC'),
    latest_at - toIntervalDay(lookback_days)
  ) AS range_start_at,
  if(
    has_explicit_date_range,
    parseDateTime64BestEffort({end_exclusive_at:String}, 6, 'UTC'),
    latest_at
  ) AS range_end_at
SELECT
  collection,
  formatDateTime(first_seen_created_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS first_seen_at,
  event_count,
  formatDateTime(latest_record_created_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS latest_record_created_at,
  latest_record_did,
  latest_record_rkey
FROM
(
  SELECT
    collection,
    min(created_at) AS first_seen_created_at,
    countIf(created_at >= range_start_at AND created_at < range_end_at) AS event_count,
    max(created_at) AS latest_record_created_at,
    argMax(did, tuple(created_at, event_key)) AS latest_record_did,
    argMax(rkey, tuple(created_at, event_key)) AS latest_record_rkey
  FROM atp_dashboard.collection_events
  WHERE isNotNull(created_at)
    AND did != {excluded_did:String}
  GROUP BY collection
)
WHERE first_seen_created_at >= range_start_at
  AND first_seen_created_at < range_end_at
ORDER BY first_seen_created_at DESC, event_count DESC, collection ASC
`,
      query_params: {
        days: params.days,
        has_explicit_date_range: hasExplicitDateRange ? 1 : 0,
        start_at: params.startDateTime ?? '1970-01-01 00:00:00.000000',
        end_exclusive_at: params.endExclusiveDateTime ?? '1970-01-01 00:00:00.000000',
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
    latest_record_created_at: row.latest_record_created_at,
    latest_record_at_uri: buildAtUri(row.latest_record_did, row.collection, row.latest_record_rkey),
    latest_record_get_record_url: buildGetRecordUrl(row.latest_record_did, row.collection, row.latest_record_rkey),
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

export async function readCollectionsForNamespaceFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  params: { namespacePrefix: string },
): Promise<NamespaceCollectionRow[]> {
  const result = await withTimeout(
    client.query({
      query: `
SELECT
  collection,
  formatDateTime(min(created_at), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS first_seen_at,
  formatDateTime(max(created_at), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS last_seen_at,
  count() AS event_count,
  formatDateTime(max(created_at), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS latest_record_created_at,
  argMax(did, tuple(created_at, event_key)) AS latest_record_did,
  argMax(rkey, tuple(created_at, event_key)) AS latest_record_rkey
FROM atp_dashboard.collection_events
WHERE isNotNull(created_at)
  AND did != {excluded_did:String}
  AND startsWith(collection, concat({namespace_prefix:String}, '.'))
GROUP BY collection
ORDER BY first_seen_at ASC, collection ASC
`,
      query_params: {
        namespace_prefix: params.namespacePrefix,
        excluded_did: LEXICON_STORE_DID,
      },
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse MCP namespace collections query timed out',
  );
  const rows = await result.json<RawNamespaceCollectionRow[]>();
  return rows.map((row) => ({
    collection: row.collection,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    event_count: Number(row.event_count),
    latest_record_created_at: row.latest_record_created_at,
    latest_record_at_uri: buildAtUri(row.latest_record_did, row.collection, row.latest_record_rkey),
    latest_record_get_record_url: buildGetRecordUrl(row.latest_record_did, row.collection, row.latest_record_rkey),
  }));
}

export async function readLatestCollectionRecordPointerFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  params: { collection: string },
): Promise<LatestCollectionRecordPointer | null> {
  const result = await withTimeout(
    client.query({
      query: `
SELECT
  collection,
  formatDateTime(created_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS created_at,
  did,
  rkey
FROM atp_dashboard.collection_events
WHERE collection = {collection:String}
  AND isNotNull(created_at)
  AND did != {excluded_did:String}
ORDER BY created_at DESC, event_key DESC
LIMIT 1
`,
      query_params: {
        collection: params.collection,
        excluded_did: LEXICON_STORE_DID,
      },
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse MCP latest record query timed out',
  );
  const rows = await result.json<RawLatestCollectionRecordPointer[]>();
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    collection: row.collection,
    created_at: row.created_at,
    did: row.did,
    rkey: row.rkey,
    at_uri: buildAtUri(row.did, row.collection, row.rkey),
    get_record_url: buildGetRecordUrl(row.did, row.collection, row.rkey),
  };
}

function parseBoundedInteger(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Value must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseMcpDateOnly(value: string | undefined): string {
  const raw = value?.trim() ?? '';
  const match = raw.match(/^(\d{4})(?:-|\/|年)(\d{1,2})(?:-|\/|月)(\d{1,2})日?$/);
  if (!match) {
    throw new Error('date values must be YYYY-MM-DD, YYYY/MM/DD, or YYYY年M月D日');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('date values must be valid calendar dates');
  }
  return formatUtcDate(date);
}

function addUtcDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return formatUtcDate(date);
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`;
}

function buildGetRecordUrl(did: string, collection: string, rkey: string): string {
  const params = new URLSearchParams({
    repo: did,
    collection,
    rkey,
  });
  return `${DEFAULT_GET_RECORD_SERVICE}/xrpc/com.atproto.repo.getRecord?${params.toString()}`;
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
