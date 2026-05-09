import type { CollectionCountApiConfig } from './config.ts';
import type { ClickHouseQueryClient } from './clickhouse.ts';

export type DailySummaryKind = 'active_collection' | 'new_collection' | 'active_did' | 'new_did';

export type DailySummaryRow = {
  day: string | number;
  count: string | number;
};

export type DailySummaryResultRow = {
  day: number;
  count: number;
};

export const DAILY_SUMMARY_ROUTES: Record<string, DailySummaryKind> = {
  active_collection_summary_view: 'active_collection',
  new_collection_summary_view: 'new_collection',
  active_did_summary_view: 'active_did',
  new_did_summary_view: 'new_did',
};

const LEXICON_STORE_DID = 'did:web:lexicon.store';

export function parseDailySummaryLimit(value: string | undefined): number {
  const parsed = Number(value ?? 30);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 30;
  }
  return Math.min(parsed, 365);
}

export async function readDailySummaryFromClickHouse(
  client: ClickHouseQueryClient,
  config: Pick<CollectionCountApiConfig, 'clickhouseTimeoutMs'>,
  kind: DailySummaryKind,
  limit: number,
): Promise<DailySummaryResultRow[]> {
  const result = await withTimeout(
    client.query({
      query: buildDailySummaryQuery(kind),
      query_params: {
        limit,
        excluded_did: LEXICON_STORE_DID,
      },
      format: 'JSONEachRow',
    }),
    config.clickhouseTimeoutMs,
    'ClickHouse daily summary query timed out',
  );
  const rows = await result.json<DailySummaryRow[]>();
  return rows.map((row) => ({
    day: Number(row.day),
    count: Number(row.count),
  }));
}

export function buildDailySummaryQuery(kind: DailySummaryKind): string {
  if (kind === 'active_collection') {
    return buildActiveSummaryQuery('collection', true);
  }
  if (kind === 'active_did') {
    return buildActiveSummaryQuery('did', false);
  }
  if (kind === 'new_collection') {
    return buildNewSummaryQuery('collection', true);
  }
  return buildNewSummaryQuery('did', false);
}

function buildActiveSummaryQuery(field: 'collection' | 'did', excludeLexiconStore: boolean): string {
  return `
WITH
  {limit:UInt32} AS limit_days,
  (
    SELECT toDate(max(created_at))
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_day
SELECT
  day,
  coalesce(count, 0) AS count
FROM
(
  SELECT toUInt16(arrayJoin(range(1, limit_days + 1))) AS day
) days
LEFT JOIN
(
  SELECT
    toUInt16(dateDiff('day', toDate(created_at), latest_day) + 1) AS day,
    uniqExact(${field}) AS count
  FROM atp_dashboard.collection_events
  WHERE isNotNull(created_at)
    AND toDate(created_at) >= latest_day - toIntervalDay(limit_days - 1)
    ${excludeLexiconStore ? 'AND did != {excluded_did:String}' : ''}
  GROUP BY day
) summary USING day
ORDER BY day ASC
`;
}

function buildNewSummaryQuery(field: 'collection' | 'did', excludeLexiconStore: boolean): string {
  return `
WITH
  {limit:UInt32} AS limit_days,
  (
    SELECT toDate(max(created_at))
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_day
SELECT
  day,
  coalesce(count, 0) AS count
FROM
(
  SELECT toUInt16(arrayJoin(range(1, limit_days + 1))) AS day
) days
LEFT JOIN
(
  SELECT
    toUInt16(dateDiff('day', first_day, latest_day) + 1) AS day,
    count() AS count
  FROM
  (
    SELECT
      ${field},
      min(toDate(created_at)) AS first_day
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
      ${excludeLexiconStore ? 'AND did != {excluded_did:String}' : ''}
    GROUP BY ${field}
  )
  WHERE first_day >= latest_day - toIntervalDay(limit_days - 1)
  GROUP BY day
) summary USING day
ORDER BY day ASC
`;
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
