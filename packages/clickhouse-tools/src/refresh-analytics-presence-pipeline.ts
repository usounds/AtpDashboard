import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_CHART_TARGETS,
  LEXICON_STORE_DID,
  buildSnapshotInsertQueryForTarget,
} from './refresh-analytics-chart-snapshot.ts';
import {
  buildHourlyNewCollectionRollupInsertQuery,
  buildHourlyNewDidRollupInsertQuery,
} from './refresh-analytics-hourly-new-rollups.ts';

export type RefreshAnalyticsPresencePipelineOptions = {
  runId: string;
  dryRun: boolean;
  confirmProduction: boolean;
  backfillDays: number;
  chunkDays: number;
  safetyLagSeconds: number;
  refreshedAt: string;
};

export type RefreshAnalyticsPresencePipelineConfig = {
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUsername: string | null;
  clickhousePassword: string | null;
  clickhouseRefreshTimeoutMs: number;
  clickhouseMaxThreads: number;
  clickhouseMaxInsertThreads: number;
  clickhouseMaxMemoryUsage: number;
};

type ClickHouseCommandLike = {
  command: (params: { query: string; query_params?: Record<string, unknown> }) => Promise<unknown>;
  close?: () => Promise<void>;
};

export function parseRefreshAnalyticsPresencePipelineOptions(argv: string[]): RefreshAnalyticsPresencePipelineOptions {
  const options: RefreshAnalyticsPresencePipelineOptions = {
    runId: randomUUID(),
    dryRun: false,
    confirmProduction: false,
    backfillDays: 370,
    chunkDays: 1,
    safetyLagSeconds: 300,
    refreshedAt: new Date().toISOString(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--confirm-production') {
      options.confirmProduction = true;
    } else if (arg === '--run-id') {
      options.runId = readNext(argv, ++index, arg);
    } else if (arg === '--backfill-days') {
      options.backfillDays = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--chunk-days') {
      options.chunkDays = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--safety-lag-seconds') {
      options.safetyLagSeconds = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.dryRun && !options.confirmProduction) {
    throw new Error('Refusing to refresh analytics presence pipeline without --confirm-production. Use --dry-run to inspect SQL.');
  }

  return options;
}

export function loadRefreshAnalyticsPresencePipelineConfig(
  env: Record<string, string | undefined> = process.env,
  options: { requireClickHouse: boolean } = { requireClickHouse: true },
): RefreshAnalyticsPresencePipelineConfig {
  return {
    clickhouseUrl: options.requireClickHouse ? readRequired(env.CLICKHOUSE_URL, 'CLICKHOUSE_URL') : (env.CLICKHOUSE_URL ?? 'http://localhost:8123'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'atp_dashboard',
    clickhouseUsername: readOptional(env.CLICKHOUSE_USERNAME),
    clickhousePassword: readOptional(env.CLICKHOUSE_PASSWORD),
    clickhouseRefreshTimeoutMs: readPositiveInteger(env.CLICKHOUSE_REFRESH_TIMEOUT_MS ?? '600000', 'CLICKHOUSE_REFRESH_TIMEOUT_MS'),
    clickhouseMaxThreads: readPositiveInteger(env.CLICKHOUSE_MAX_THREADS ?? '1', 'CLICKHOUSE_MAX_THREADS'),
    clickhouseMaxInsertThreads: readPositiveInteger(env.CLICKHOUSE_MAX_INSERT_THREADS ?? '1', 'CLICKHOUSE_MAX_INSERT_THREADS'),
    clickhouseMaxMemoryUsage: readPositiveInteger(env.CLICKHOUSE_MAX_MEMORY_USAGE ?? '3000000000', 'CLICKHOUSE_MAX_MEMORY_USAGE'),
  };
}

export function buildPresenceRunStartQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_presence_run_status
SELECT
  {run_id:UUID} AS run_id,
  'running' AS status,
  'prepare' AS phase,
  now64(3, 'UTC') AS started_at,
  NULL AS verified_at,
  NULL AS published_at,
  NULL AS completed_at,
  now64(3, 'UTC') - toIntervalSecond({safety_lag_seconds:UInt32}) AS cutoff_ingested_at,
  NULL AS processed_ingested_at,
  max(assumeNotNull(created_at)) AS source_latest_at,
  toDateTime64(toStartOfHour(max(assumeNotNull(created_at))), 0, 'UTC') AS source_latest_hour,
  NULL AS previous_refresh_id,
  NULL AS published_refresh_id,
  0 AS row_count,
  NULL AS error_message,
  now64(3, 'UTC') AS updated_at
FROM atp_dashboard.analytics_presence_event_source
WHERE ingested_at <= now64(3, 'UTC') - toIntervalSecond({safety_lag_seconds:UInt32})
`;
}

export function buildDidPresenceInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_hourly_did_presence
SELECT
  hour,
  did,
  now64(3, 'UTC') AS observed_at
FROM atp_dashboard.analytics_presence_event_source
WHERE ingested_at <= (SELECT cutoff_ingested_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
  AND (
    EXISTS (SELECT 1 FROM atp_dashboard.analytics_presence_watermarks WHERE name = 'event_source_backfill' AND run_id = {run_id:UUID})
    OR
    NOT EXISTS (SELECT 1 FROM atp_dashboard.analytics_presence_watermarks WHERE name = 'collection_events')
    OR ingested_at > (
      SELECT processed_ingested_at
      FROM atp_dashboard.analytics_presence_watermarks
      WHERE name = 'collection_events'
      ORDER BY updated_at DESC
      LIMIT 1
    )
  )
  AND created_at > (SELECT source_latest_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1) - toIntervalDay({backfill_days:UInt32})
  AND created_at <= (SELECT source_latest_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
  AND created_at > parseDateTime64BestEffort({chunk_start:String}, 6, 'UTC')
  AND created_at <= parseDateTime64BestEffort({chunk_end:String}, 6, 'UTC')
GROUP BY hour, did
`;
}

export function buildCollectionPresenceInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_hourly_collection_presence
SELECT
  hour,
  collection,
  now64(3, 'UTC') AS observed_at
FROM atp_dashboard.analytics_presence_event_source
WHERE did != {excluded_did:String}
  AND ingested_at <= (SELECT cutoff_ingested_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
  AND (
    EXISTS (SELECT 1 FROM atp_dashboard.analytics_presence_watermarks WHERE name = 'event_source_backfill' AND run_id = {run_id:UUID})
    OR
    NOT EXISTS (SELECT 1 FROM atp_dashboard.analytics_presence_watermarks WHERE name = 'collection_events')
    OR ingested_at > (
      SELECT processed_ingested_at
      FROM atp_dashboard.analytics_presence_watermarks
      WHERE name = 'collection_events'
      ORDER BY updated_at DESC
      LIMIT 1
    )
  )
  AND created_at > (SELECT source_latest_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1) - toIntervalDay({backfill_days:UInt32})
  AND created_at <= (SELECT source_latest_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
  AND created_at > parseDateTime64BestEffort({chunk_start:String}, 6, 'UTC')
  AND created_at <= parseDateTime64BestEffort({chunk_end:String}, 6, 'UTC')
GROUP BY hour, collection
`;
}

export function buildEventKeyPresenceInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_hourly_event_key_presence
SELECT
  hour,
  event_key,
  now64(3, 'UTC') AS observed_at
FROM atp_dashboard.analytics_presence_event_source
WHERE ingested_at <= (SELECT cutoff_ingested_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
  AND (
    EXISTS (SELECT 1 FROM atp_dashboard.analytics_presence_watermarks WHERE name = 'event_source_backfill' AND run_id = {run_id:UUID})
    OR
    NOT EXISTS (SELECT 1 FROM atp_dashboard.analytics_presence_watermarks WHERE name = 'collection_events')
    OR ingested_at > (
      SELECT processed_ingested_at
      FROM atp_dashboard.analytics_presence_watermarks
      WHERE name = 'collection_events'
      ORDER BY updated_at DESC
      LIMIT 1
    )
  )
  AND created_at > (SELECT source_latest_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1) - toIntervalDay({backfill_days:UInt32})
  AND created_at <= (SELECT source_latest_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
  AND created_at > parseDateTime64BestEffort({chunk_start:String}, 6, 'UTC')
  AND created_at <= parseDateTime64BestEffort({chunk_end:String}, 6, 'UTC')
GROUP BY hour, event_key
`;
}

export function buildHourlyEventCountInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_hourly_event_count
SELECT
  hour,
  count() AS count,
  (SELECT cutoff_ingested_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1) AS source_max_ingested_at,
  now64(3, 'UTC') AS refreshed_at
FROM
(
  SELECT
    hour,
    event_key
  FROM atp_dashboard.analytics_hourly_event_key_presence
  WHERE hour > (SELECT source_latest_hour FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1) - toIntervalDay({backfill_days:UInt32})
    AND hour <= (SELECT source_latest_hour FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
    AND hour > toDateTime64(toStartOfHour(parseDateTime64BestEffort({chunk_start:String}, 6, 'UTC')), 0, 'UTC')
    AND hour <= toDateTime64(toStartOfHour(parseDateTime64BestEffort({chunk_end:String}, 6, 'UTC')), 0, 'UTC')
    AND (
      EXISTS (SELECT 1 FROM atp_dashboard.analytics_presence_watermarks WHERE name = 'event_source_backfill' AND run_id = {run_id:UUID})
      OR
      NOT EXISTS (SELECT 1 FROM atp_dashboard.analytics_presence_watermarks WHERE name = 'collection_events')
      OR hour IN
      (
        SELECT hour AS dirty_hour
        FROM atp_dashboard.analytics_presence_event_source
        WHERE ingested_at <= (SELECT cutoff_ingested_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
          AND ingested_at > (
            SELECT processed_ingested_at
            FROM atp_dashboard.analytics_presence_watermarks
            WHERE name = 'collection_events'
            ORDER BY updated_at DESC
            LIMIT 1
          )
          AND created_at > (SELECT source_latest_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1) - toIntervalDay({backfill_days:UInt32})
          AND created_at <= (SELECT source_latest_at FROM atp_dashboard.analytics_presence_run_status WHERE run_id = {run_id:UUID} LIMIT 1)
          AND created_at > parseDateTime64BestEffort({chunk_start:String}, 6, 'UTC')
          AND created_at <= parseDateTime64BestEffort({chunk_end:String}, 6, 'UTC')
        GROUP BY dirty_hour
      )
    )
  GROUP BY hour, event_key
)
GROUP BY hour
`;
}

export function buildShadowSnapshotInsertQueries(): string[] {
  return ANALYTICS_CHART_TARGETS.map((target) =>
    buildSnapshotInsertQueryForTarget(target, 'presence')
      .replace('INSERT INTO atp_dashboard.analytics_chart_snapshot', 'INSERT INTO atp_dashboard.analytics_chart_snapshot_shadow')
      .replace('(refresh_id, tool, days, bucket_days, bucket_index, date, day_offset, active, new, count, latest_at, refreshed_at)', '(run_id, tool, days, bucket_days, bucket_index, date, day_offset, active, new, count, latest_at, refreshed_at)')
      .replace("WHERE status IN ('verified', 'published')", 'WHERE run_id = {run_id:UUID}')
      .replaceAll('{refresh_id:UUID}', '{run_id:UUID}'),
  );
}

export function buildBucketValuesInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_chart_bucket_values
SELECT
  shadow.run_id,
  shadow.tool,
  shadow.days,
  shadow.bucket_days,
  shadow.bucket_index,
  shadow.date,
  shadow.day_offset,
  shadow.active,
  shadow.new,
  shadow.count,
  assumeNotNull(shadow.latest_at) AS source_latest_at,
  status.source_latest_hour AS source_latest_hour,
  shadow.refreshed_at
FROM atp_dashboard.analytics_chart_snapshot_shadow shadow
INNER JOIN atp_dashboard.analytics_presence_run_status status USING run_id
WHERE shadow.run_id = {run_id:UUID}
`;
}

export function buildVerifyRunQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_presence_run_status
SELECT
  {run_id:UUID} AS run_id,
  if(metrics.row_count = 150 AND metrics.chart_groups = 9 AND metrics.future_rows = 0 AND metrics.latest_at_values = 1, 'verified', 'failed') AS status,
  'verify' AS phase,
  status.started_at AS started_at,
  if(metrics.row_count = 150 AND metrics.chart_groups = 9 AND metrics.future_rows = 0 AND metrics.latest_at_values = 1, now64(3, 'UTC'), NULL) AS verified_at,
  NULL AS published_at,
  if(metrics.row_count = 150 AND metrics.chart_groups = 9 AND metrics.future_rows = 0 AND metrics.latest_at_values = 1, now64(3, 'UTC'), NULL) AS completed_at,
  status.cutoff_ingested_at AS cutoff_ingested_at,
  status.cutoff_ingested_at AS processed_ingested_at,
  status.source_latest_at AS source_latest_at,
  status.source_latest_hour AS source_latest_hour,
  status.previous_refresh_id AS previous_refresh_id,
  NULL AS published_refresh_id,
  metrics.row_count,
  if(metrics.row_count = 150 AND metrics.chart_groups = 9 AND metrics.future_rows = 0 AND metrics.latest_at_values = 1, NULL, concat('presence verification failed rows=', toString(metrics.row_count), ' groups=', toString(metrics.chart_groups), ' future=', toString(metrics.future_rows))) AS error_message,
  now64(3, 'UTC') AS updated_at
FROM
(
  SELECT
    count() AS row_count,
    countDistinct(tuple(tool, days, bucket_days)) AS chart_groups,
    countIf(date > today()) AS future_rows,
    countDistinct(source_latest_at) AS latest_at_values
  FROM atp_dashboard.analytics_chart_bucket_values
  WHERE run_id = {run_id:UUID}
) metrics
CROSS JOIN
(
  SELECT *
  FROM atp_dashboard.analytics_presence_run_status
  WHERE run_id = {run_id:UUID}
  ORDER BY updated_at DESC
  LIMIT 1
) status
`;
}

export function buildPresenceWatermarkCommitQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_presence_watermarks
SELECT
  'collection_events' AS name,
  processed_ingested_at,
  run_id,
  now64(3, 'UTC') AS updated_at
FROM atp_dashboard.analytics_presence_run_status
WHERE run_id = {run_id:UUID}
  AND status = 'verified'
ORDER BY updated_at DESC
LIMIT 1
`;
}

export async function refreshAnalyticsPresencePipeline(
  client: ClickHouseCommandLike,
  options: RefreshAnalyticsPresencePipelineOptions,
): Promise<{ runId: string; dryRun: boolean; status: 'completed' | 'dry_run' }> {
  const chunkedCommands = [
    buildDidPresenceInsertQuery(),
    buildCollectionPresenceInsertQuery(),
    buildEventKeyPresenceInsertQuery(),
    buildHourlyEventCountInsertQuery(),
  ];
  const commands = [
    buildPresenceRunStartQuery(),
    buildHourlyNewDidRollupInsertQuery(),
    buildHourlyNewCollectionRollupInsertQuery(),
    ...buildShadowSnapshotInsertQueries(),
    buildBucketValuesInsertQuery(),
    buildVerifyRunQuery(),
    buildPresenceWatermarkCommitQuery(),
  ];

  if (options.dryRun) {
    console.log([commands[0], ...chunkedCommands, ...commands.slice(1)].join('\n\n'));
    return { runId: options.runId, dryRun: true, status: 'dry_run' };
  }

  await client.command({
    query: buildPresenceRunStartQuery(),
    query_params: {
      run_id: options.runId,
      backfill_days: options.backfillDays,
      safety_lag_seconds: options.safetyLagSeconds,
      excluded_did: LEXICON_STORE_DID,
    },
  });

  for (const chunk of buildBackfillChunks(options.backfillDays, options.chunkDays)) {
    for (const query of chunkedCommands) {
      await client.command({
        query,
        query_params: {
          run_id: options.runId,
          backfill_days: options.backfillDays,
          safety_lag_seconds: options.safetyLagSeconds,
          excluded_did: LEXICON_STORE_DID,
          refreshed_at: options.refreshedAt,
          chunk_start: chunk.start,
          chunk_end: chunk.end,
        },
      });
    }
  }

  for (const query of commands.slice(1)) {
    await client.command({
      query,
      query_params: {
        run_id: options.runId,
        backfill_days: options.backfillDays,
        safety_lag_seconds: options.safetyLagSeconds,
        excluded_did: LEXICON_STORE_DID,
        refreshed_at: options.refreshedAt,
      },
    });
  }

  return { runId: options.runId, dryRun: false, status: 'completed' };
}

function buildBackfillChunks(backfillDays: number, chunkDays: number): Array<{ start: string; end: string }> {
  const end = new Date();
  const start = new Date(end.getTime() - backfillDays * 24 * 60 * 60 * 1000);
  const chunks: Array<{ start: string; end: string }> = [];
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += chunkDays * 24 * 60 * 60 * 1000) {
    const chunkEnd = Math.min(cursor + chunkDays * 24 * 60 * 60 * 1000, end.getTime());
    chunks.push({
      start: new Date(cursor).toISOString(),
      end: new Date(chunkEnd).toISOString(),
    });
  }
  return chunks;
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
  const options = parseRefreshAnalyticsPresencePipelineOptions(process.argv.slice(2));
  const config = loadRefreshAnalyticsPresencePipelineConfig(process.env, { requireClickHouse: !options.dryRun });
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
        clickhouse_settings: {
          max_threads: config.clickhouseMaxThreads,
          max_insert_threads: config.clickhouseMaxInsertThreads,
          max_memory_usage: config.clickhouseMaxMemoryUsage,
          send_progress_in_http_headers: 1,
          http_headers_progress_interval_ms: '30000',
        },
      });

  try {
    const result = await refreshAnalyticsPresencePipeline(client, options);
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
