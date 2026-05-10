import type { CollectionCountApiConfig } from './config.ts';
import type { ClickHouseQueryClient } from './clickhouse.ts';

export const MCP_READ_CACHE_TTL_MS = 10 * 60 * 1000;

const MAX_DAYS = 14;
const MAX_DAILY_USER_DAYS = 365;
const DEFAULT_DAYS = 7;
const LEXICON_STORE_DID = 'did:web:lexicon.store';
const DEFAULT_GET_RECORD_SERVICE = 'https://slingshot.microcosm.blue';
const PDS_LS_SERVICE = 'https://pds.ls';

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

export type DailyUserRow = {
  date: string;
  day_offset: number;
  active: number;
  new: number;
};

export type DailyCollectionRow = {
  date: string;
  day_offset: number;
  active: number;
  new: number;
};

export type DailyChartBucketParams = {
  days: number;
  bucketDays?: number;
};

export type EventCountRow = {
  date: string;
  day_offset: number;
  count: number;
};

export type UniqueDidCountRow = {
  unique_did_count: number;
};

export type LatestCollectionRecordPointer = {
  collection: string;
  created_at: string;
  did: string;
  rkey: string;
  at_uri: string;
  get_record_url: string;
  pds_ls_url: string;
};

type RawNewCollectionRow = {
  collection: string;
  first_seen_at: string;
  event_count: string | number;
  latest_record_created_at: string;
  latest_record_did: string;
  latest_record_rkey: string;
};

type RawDailyUserRow = {
  date: string;
  day_offset: string | number;
  active: string | number;
  new: string | number;
};

type RawDailyCollectionRow = {
  date: string;
  day_offset: string | number;
  active: string | number;
  new: string | number;
};

type RawEventCountRow = {
  date: string;
  day_offset: string | number;
  count: string | number;
};

type RawUniqueDidCountRow = {
  unique_did_count: string | number;
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

export function parseMcpDailyUserDays(value: string | number | undefined): number {
  return parseBoundedInteger(value, DEFAULT_DAYS, 1, MAX_DAILY_USER_DAYS);
}

export function parseDailyChartBucketDays(value: string | number | undefined): number {
  const bucketDays = parseBoundedInteger(value, 1, 1, 30);
  if (bucketDays !== 1 && bucketDays !== 30) {
    throw new Error('bucket_days must be 1 or 30');
  }
  return bucketDays;
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
  if (params.days != null && params.days !== '') {
    throw new Error('days cannot be combined with start_date/end_date');
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
    days: 0,
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

export function buildDailyChartCacheKey(tool: string, params: DailyChartBucketParams): string {
  return `${tool}:days=${params.days}:bucket_days=${params.bucketDays ?? 1}`;
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
    'ClickHouse MCP new collection groups query timed out',
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

export async function readDailyUsersFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  params: DailyChartBucketParams,
): Promise<DailyUserRow[]> {
  const bucketDays = params.bucketDays ?? 1;
  const bucketCount = Math.ceil(params.days / bucketDays);
  const bucketSeconds = bucketDays * 86400;
  const result = await withTimeout(
    client.query({
      query: `
WITH
  {days:UInt16} AS lookback_days,
  {bucket_count:UInt16} AS bucket_count,
  {bucket_days:UInt16} AS bucket_days,
  {bucket_seconds:UInt32} AS bucket_seconds,
  (
    SELECT max(created_at)
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_at
SELECT
  formatDateTime(bucket_end_at, '%Y-%m-%d', 'UTC') AS date,
  -toInt16(bucket_index * bucket_days) AS day_offset,
  coalesce(active.active, 0) AS active,
  coalesce(new_users.new, 0) AS new
FROM
(
  SELECT
    toUInt16(arrayJoin(range(bucket_count))) AS bucket_index,
    latest_at - toIntervalSecond(bucket_index * bucket_seconds) AS bucket_end_at
) days
LEFT JOIN
(
  SELECT
    toUInt16(intDiv(dateDiff('second', created_at, latest_at), bucket_seconds)) AS bucket_index,
    uniqExact(did) AS active
  FROM atp_dashboard.collection_events
  WHERE isNotNull(created_at)
    AND created_at > latest_at - toIntervalDay(lookback_days)
    AND created_at <= latest_at
  GROUP BY bucket_index
) active USING bucket_index
LEFT JOIN
(
  SELECT
    toUInt16(intDiv(dateDiff('second', first_seen_at, latest_at), bucket_seconds)) AS bucket_index,
    count() AS new
  FROM
  (
    SELECT
      did,
      min(created_at) AS first_seen_at
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
    GROUP BY did
  )
  WHERE first_seen_at > latest_at - toIntervalDay(lookback_days)
    AND first_seen_at <= latest_at
  GROUP BY bucket_index
) new_users USING bucket_index
ORDER BY bucket_end_at ASC
`,
      query_params: {
        days: params.days,
        bucket_count: bucketCount,
        bucket_days: bucketDays,
        bucket_seconds: bucketSeconds,
      },
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse MCP daily_users query timed out',
  );
  const rows = await result.json<RawDailyUserRow[]>();
  return rows.map((row) => ({
    date: row.date,
    day_offset: Number(row.day_offset),
    active: Number(row.active),
    new: Number(row.new),
  }));
}

export async function readDailyCollectionsFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  params: DailyChartBucketParams,
): Promise<DailyCollectionRow[]> {
  const bucketDays = params.bucketDays ?? 1;
  const bucketCount = Math.ceil(params.days / bucketDays);
  const bucketSeconds = bucketDays * 86400;
  const result = await withTimeout(
    client.query({
      query: `
WITH
  {days:UInt16} AS lookback_days,
  {bucket_count:UInt16} AS bucket_count,
  {bucket_days:UInt16} AS bucket_days,
  {bucket_seconds:UInt32} AS bucket_seconds,
  (
    SELECT max(created_at)
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_at
SELECT
  formatDateTime(bucket_end_at, '%Y-%m-%d', 'UTC') AS date,
  -toInt16(bucket_index * bucket_days) AS day_offset,
  coalesce(active_collections.active, 0) AS active,
  coalesce(new_collections.new, 0) AS new
FROM
(
  SELECT
    toUInt16(arrayJoin(range(bucket_count))) AS bucket_index,
    latest_at - toIntervalSecond(bucket_index * bucket_seconds) AS bucket_end_at
) days
LEFT JOIN
(
  SELECT
    toUInt16(intDiv(dateDiff('second', created_at, latest_at), bucket_seconds)) AS bucket_index,
    uniqExact(collection) AS active
  FROM atp_dashboard.collection_events
  WHERE isNotNull(created_at)
    AND did != {excluded_did:String}
    AND created_at > latest_at - toIntervalDay(lookback_days)
    AND created_at <= latest_at
  GROUP BY bucket_index
) active_collections USING bucket_index
LEFT JOIN
(
  SELECT
    toUInt16(intDiv(dateDiff('second', first_seen_at, latest_at), bucket_seconds)) AS bucket_index,
    count() AS new
  FROM
  (
    SELECT
      collection,
      min(created_at) AS first_seen_at
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
      AND did != {excluded_did:String}
    GROUP BY collection
  )
  WHERE first_seen_at > latest_at - toIntervalDay(lookback_days)
    AND first_seen_at <= latest_at
  GROUP BY bucket_index
) new_collections USING bucket_index
ORDER BY bucket_end_at ASC
`,
      query_params: {
        days: params.days,
        bucket_count: bucketCount,
        bucket_days: bucketDays,
        bucket_seconds: bucketSeconds,
        excluded_did: LEXICON_STORE_DID,
      },
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse MCP daily_collections query timed out',
  );
  const rows = await result.json<RawDailyCollectionRow[]>();
  return rows.map((row) => ({
    date: row.date,
    day_offset: Number(row.day_offset),
    active: Number(row.active),
    new: Number(row.new),
  }));
}

export async function readEventCountsFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  params: DailyChartBucketParams,
): Promise<EventCountRow[]> {
  const bucketDays = params.bucketDays ?? 1;
  const bucketCount = Math.ceil(params.days / bucketDays);
  const bucketSeconds = bucketDays * 86400;
  const result = await withTimeout(
    client.query({
      query: `
WITH
  {days:UInt16} AS lookback_days,
  {bucket_count:UInt16} AS bucket_count,
  {bucket_days:UInt16} AS bucket_days,
  {bucket_seconds:UInt32} AS bucket_seconds,
  (
    SELECT max(created_at)
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_at
SELECT
  formatDateTime(bucket_end_at, '%Y-%m-%d', 'UTC') AS date,
  -toInt16(bucket_index * bucket_days) AS day_offset,
  coalesce(events.count, 0) AS count
FROM
(
  SELECT
    toUInt16(arrayJoin(range(bucket_count))) AS bucket_index,
    latest_at - toIntervalSecond(bucket_index * bucket_seconds) AS bucket_end_at
) days
LEFT JOIN
(
  SELECT
    toUInt16(intDiv(dateDiff('second', created_at, latest_at), bucket_seconds)) AS bucket_index,
    count() AS count
  FROM atp_dashboard.collection_events
  WHERE isNotNull(created_at)
    AND created_at > latest_at - toIntervalDay(lookback_days)
    AND created_at <= latest_at
  GROUP BY bucket_index
) events USING bucket_index
ORDER BY bucket_end_at ASC
`,
      query_params: {
        days: params.days,
        bucket_count: bucketCount,
        bucket_days: bucketDays,
        bucket_seconds: bucketSeconds,
      },
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse event_counts query timed out',
  );
  const rows = await result.json<RawEventCountRow[]>();
  return rows.map((row) => ({
    date: row.date,
    day_offset: Number(row.day_offset),
    count: Number(row.count),
  }));
}

export async function readUniqueDidCountFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
): Promise<UniqueDidCountRow> {
  const result = await withTimeout(
    client.query({
      query: `
SELECT uniqExact(did) AS unique_did_count
FROM atp_dashboard.collection_events
WHERE did != ''
`,
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse unique_did_count query timed out',
  );
  const rows = await result.json<RawUniqueDidCountRow[]>();
  return {
    unique_did_count: Number(rows[0]?.unique_did_count ?? 0),
  };
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
  const atUri = buildAtUri(row.did, row.collection, row.rkey);
  return {
    collection: row.collection,
    created_at: row.created_at,
    did: row.did,
    rkey: row.rkey,
    at_uri: atUri,
    get_record_url: buildGetRecordUrl(row.did, row.collection, row.rkey),
    pds_ls_url: buildPdsLsUrl(atUri),
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

function buildPdsLsUrl(atUri: string): string {
  return `${PDS_LS_SERVICE}/${atUri}`;
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
