import { randomUUID } from 'node:crypto';

export type RefreshStatus = 'running' | 'completed' | 'failed';

export type RefreshAnalyticsChartOptions = {
  refreshId: string;
  dryRun: boolean;
  confirmProduction: boolean;
  staleRunningMinutes: number;
};

export type RefreshAnalyticsChartConfig = {
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUsername: string | null;
  clickhousePassword: string | null;
  clickhouseRefreshTimeoutMs: number;
};

export type AnalyticsChartSnapshotTarget = {
  tool: 'daily_collections' | 'daily_users' | 'event_counts';
  days: 7 | 30 | 365;
  bucketDays: 1 | 30;
};

type ClickHouseCommandLike = {
  command: (params: { query: string; query_params?: Record<string, unknown> }) => Promise<unknown>;
  close?: () => Promise<void>;
};

export const LEXICON_STORE_DID = 'did:web:lexicon.store';

export const ANALYTICS_CHART_TARGETS: AnalyticsChartSnapshotTarget[] = [
  { tool: 'daily_collections', days: 7, bucketDays: 1 },
  { tool: 'daily_collections', days: 30, bucketDays: 1 },
  { tool: 'daily_collections', days: 365, bucketDays: 30 },
  { tool: 'daily_users', days: 7, bucketDays: 1 },
  { tool: 'daily_users', days: 30, bucketDays: 1 },
  { tool: 'daily_users', days: 365, bucketDays: 30 },
  { tool: 'event_counts', days: 7, bucketDays: 1 },
  { tool: 'event_counts', days: 30, bucketDays: 1 },
  { tool: 'event_counts', days: 365, bucketDays: 30 },
];

export function parseRefreshAnalyticsChartOptions(argv: string[]): RefreshAnalyticsChartOptions {
  const options: RefreshAnalyticsChartOptions = {
    refreshId: randomUUID(),
    dryRun: false,
    confirmProduction: false,
    staleRunningMinutes: 60,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--confirm-production') {
      options.confirmProduction = true;
    } else if (arg === '--refresh-id') {
      options.refreshId = readNext(argv, ++index, arg);
    } else if (arg === '--stale-running-minutes') {
      options.staleRunningMinutes = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.dryRun && !options.confirmProduction) {
    throw new Error('Refusing to refresh analytics chart snapshot without --confirm-production. Use --dry-run to inspect SQL.');
  }

  return options;
}

export function loadRefreshAnalyticsChartConfig(
  env: Record<string, string | undefined> = process.env,
  options: { requireClickHouse: boolean } = { requireClickHouse: true },
): RefreshAnalyticsChartConfig {
  return {
    clickhouseUrl: options.requireClickHouse ? readRequired(env.CLICKHOUSE_URL, 'CLICKHOUSE_URL') : (env.CLICKHOUSE_URL ?? 'http://localhost:8123'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'atp_dashboard',
    clickhouseUsername: readOptional(env.CLICKHOUSE_USERNAME),
    clickhousePassword: readOptional(env.CLICKHOUSE_PASSWORD),
    clickhouseRefreshTimeoutMs: readPositiveInteger(env.CLICKHOUSE_REFRESH_TIMEOUT_MS ?? '600000', 'CLICKHOUSE_REFRESH_TIMEOUT_MS'),
  };
}

export function buildMarkStaleRunningQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_chart_refresh_manifest
SELECT
  refresh_id,
  'failed' AS status,
  started_at,
  now64(3, 'UTC') AS completed_at,
  row_count,
  concat('marked stale after ', {stale_running_minutes:UInt32}, ' minutes') AS error_message,
  now64(3, 'UTC') AS updated_at
FROM atp_dashboard.analytics_chart_refresh_manifest
WHERE status = 'running'
  AND started_at < now64(3, 'UTC') - toIntervalMinute({stale_running_minutes:UInt32})
`;
}

export function buildManifestInsertQuery(status: RefreshStatus): string {
  if (status === 'completed') {
    return `
INSERT INTO atp_dashboard.analytics_chart_refresh_manifest
  (refresh_id, status, started_at, completed_at, row_count, error_message, updated_at)
SELECT
  {refresh_id:UUID} AS refresh_id,
  'completed' AS status,
  now64(3, 'UTC') AS started_at,
  now64(3, 'UTC') AS completed_at,
  count() AS row_count,
  NULL AS error_message,
  now64(3, 'UTC') AS updated_at
FROM atp_dashboard.analytics_chart_snapshot
WHERE refresh_id = {refresh_id:UUID}
`;
  }

  const completedAt = status === 'running' ? 'NULL' : "now64(3, 'UTC')";
  const errorMessage = status === 'failed' ? '{error_message:Nullable(String)}' : 'NULL';
  return `
INSERT INTO atp_dashboard.analytics_chart_refresh_manifest
  (refresh_id, status, started_at, completed_at, row_count, error_message, updated_at)
VALUES
  ({refresh_id:UUID}, '${status}', now64(3, 'UTC'), ${completedAt}, {row_count:UInt64}, ${errorMessage}, now64(3, 'UTC'))
`;
}

export function buildSnapshotInsertQuery(targets: AnalyticsChartSnapshotTarget[] = ANALYTICS_CHART_TARGETS): string {
  return `
INSERT INTO atp_dashboard.analytics_chart_snapshot
  (refresh_id, tool, days, bucket_days, bucket_index, date, day_offset, active, new, count, latest_at, refreshed_at)
${targets.map(buildTargetSelectQuery).join('\nUNION ALL\n')}
`;
}

export function buildSnapshotInsertQueryForTarget(target: AnalyticsChartSnapshotTarget): string {
  return buildSnapshotInsertQuery([target]);
}

export async function refreshAnalyticsChartSnapshot(
  client: ClickHouseCommandLike,
  options: RefreshAnalyticsChartOptions,
): Promise<{ refreshId: string; dryRun: boolean; status: 'completed' | 'dry_run' }> {
  const queries = buildRefreshQueryPlan(options);

  if (options.dryRun) {
    return {
      refreshId: options.refreshId,
      dryRun: true,
      status: 'dry_run',
    };
  }

  try {
    for (const query of queries.beforeSnapshot) {
      await client.command(query);
    }
    for (const query of queries.insertSnapshots) {
      console.log(`[analytics-chart-refresh] inserting ${query.target.tool} days=${query.target.days} bucket_days=${query.target.bucketDays}`);
      await client.command(query.command);
    }
    await client.command(queries.completeManifest);
    return {
      refreshId: options.refreshId,
      dryRun: false,
      status: 'completed',
    };
  } catch (error) {
    await client.command({
      query: buildManifestInsertQuery('failed'),
      query_params: {
        refresh_id: options.refreshId,
        row_count: 0,
        error_message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown refresh error',
      },
    });
    throw error;
  }
}

export function buildRefreshQueryPlan(options: RefreshAnalyticsChartOptions): {
  beforeSnapshot: Array<{ query: string; query_params: Record<string, unknown> }>;
  insertSnapshots: Array<{
    target: AnalyticsChartSnapshotTarget;
    command: { query: string; query_params: Record<string, unknown> };
  }>;
  completeManifest: { query: string; query_params: Record<string, unknown> };
} {
  return {
    beforeSnapshot: [
      {
        query: buildMarkStaleRunningQuery(),
        query_params: {
          stale_running_minutes: options.staleRunningMinutes,
        },
      },
      {
        query: buildManifestInsertQuery('running'),
        query_params: {
          refresh_id: options.refreshId,
          row_count: 0,
        },
      },
    ],
    insertSnapshots: ANALYTICS_CHART_TARGETS.map((target) => ({
      target,
      command: {
        query: buildSnapshotInsertQueryForTarget(target),
        query_params: {
          refresh_id: options.refreshId,
          excluded_did: LEXICON_STORE_DID,
        },
      },
    })),
    completeManifest: {
      query: buildManifestInsertQuery('completed'),
      query_params: {
        refresh_id: options.refreshId,
      },
    },
  };
}

function buildTargetSelectQuery(target: AnalyticsChartSnapshotTarget): string {
  if (target.tool === 'daily_users') {
    return buildDailyUsersSelectQuery(target);
  }
  if (target.tool === 'daily_collections') {
    return buildDailyCollectionsSelectQuery(target);
  }
  return buildEventCountsSelectQuery(target);
}

function buildDailyUsersSelectQuery(target: AnalyticsChartSnapshotTarget): string {
  return `
WITH
  ${target.days} AS lookback_days,
  ${Math.ceil(target.days / target.bucketDays)} AS bucket_count,
  ${target.bucketDays} AS chart_bucket_days,
  ${target.bucketDays * 86400} AS bucket_seconds,
  (
    SELECT max(created_at)
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_at
SELECT
  {refresh_id:UUID} AS refresh_id,
  '${target.tool}' AS tool,
  toUInt16(lookback_days) AS days,
  toUInt8(chart_bucket_days) AS bucket_days,
  days.bucket_index,
  toDate(bucket_end_at, 'UTC') AS date,
  -toInt16(days.bucket_index * chart_bucket_days) AS day_offset,
  toUInt64(coalesce(active.active, 0)) AS active,
  toUInt64(coalesce(new_users.new, 0)) AS new,
  toUInt64(0) AS count,
  latest_at,
  now64(3, 'UTC') AS refreshed_at
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
) new_users USING bucket_index`;
}

function buildDailyCollectionsSelectQuery(target: AnalyticsChartSnapshotTarget): string {
  return `
WITH
  ${target.days} AS lookback_days,
  ${Math.ceil(target.days / target.bucketDays)} AS bucket_count,
  ${target.bucketDays} AS chart_bucket_days,
  ${target.bucketDays * 86400} AS bucket_seconds,
  (
    SELECT max(created_at)
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_at
SELECT
  {refresh_id:UUID} AS refresh_id,
  '${target.tool}' AS tool,
  toUInt16(lookback_days) AS days,
  toUInt8(chart_bucket_days) AS bucket_days,
  days.bucket_index,
  toDate(bucket_end_at, 'UTC') AS date,
  -toInt16(days.bucket_index * chart_bucket_days) AS day_offset,
  toUInt64(coalesce(active_collections.active, 0)) AS active,
  toUInt64(coalesce(new_collections.new, 0)) AS new,
  toUInt64(0) AS count,
  latest_at,
  now64(3, 'UTC') AS refreshed_at
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
) new_collections USING bucket_index`;
}

function buildEventCountsSelectQuery(target: AnalyticsChartSnapshotTarget): string {
  return `
WITH
  ${target.days} AS lookback_days,
  ${Math.ceil(target.days / target.bucketDays)} AS bucket_count,
  ${target.bucketDays} AS chart_bucket_days,
  ${target.bucketDays * 86400} AS bucket_seconds,
  (
    SELECT max(created_at)
    FROM atp_dashboard.collection_events
    WHERE isNotNull(created_at)
  ) AS latest_at
SELECT
  {refresh_id:UUID} AS refresh_id,
  '${target.tool}' AS tool,
  toUInt16(lookback_days) AS days,
  toUInt8(chart_bucket_days) AS bucket_days,
  days.bucket_index,
  toDate(bucket_end_at, 'UTC') AS date,
  -toInt16(days.bucket_index * chart_bucket_days) AS day_offset,
  toUInt64(0) AS active,
  toUInt64(0) AS new,
  toUInt64(coalesce(events.count, 0)) AS count,
  latest_at,
  now64(3, 'UTC') AS refreshed_at
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
    uniqExact(event_key) AS count
  FROM atp_dashboard.collection_events
  WHERE isNotNull(created_at)
    AND created_at > latest_at - toIntervalDay(lookback_days)
    AND created_at <= latest_at
  GROUP BY bucket_index
) events USING bucket_index`;
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readRequired(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function readOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function main(): Promise<void> {
  const options = parseRefreshAnalyticsChartOptions(process.argv.slice(2));
  const config = loadRefreshAnalyticsChartConfig(process.env, { requireClickHouse: !options.dryRun });
  const { createClient } = await import('@clickhouse/client');
  const client = options.dryRun
    ? {
        async command() {},
        async close() {},
      }
    : createClient({
        url: config.clickhouseUrl,
        username: config.clickhouseUsername ?? undefined,
        password: config.clickhousePassword ?? undefined,
        database: config.clickhouseDatabase,
        request_timeout: config.clickhouseRefreshTimeoutMs,
      });

  try {
    const result = await refreshAnalyticsChartSnapshot(client, options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
