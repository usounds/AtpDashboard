export type VerifyAnalyticsPresencePipelineOptions = {
  runId: string | null;
  dryRun: boolean;
  confirmProduction: boolean;
};

export type VerifyAnalyticsPresencePipelineConfig = {
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUsername: string | null;
  clickhousePassword: string | null;
  clickhouseRefreshTimeoutMs: number;
};

type ClickHouseQueryLike = {
  query: (params: { query: string; query_params?: Record<string, unknown>; format?: string }) => Promise<{ json: <T>() => Promise<T> }>;
  close?: () => Promise<void>;
};

type VerifyRow = {
  row_count: string | number;
  chart_groups: string | number;
  future_rows: string | number;
  latest_at_values: string | number;
  refreshed_at_values: string | number;
  manifest_rows: string | number;
  cross_hour_event_key_duplicates: string | number;
  run_status: string;
};

export function parseVerifyAnalyticsPresencePipelineOptions(argv: string[]): VerifyAnalyticsPresencePipelineOptions {
  const options: VerifyAnalyticsPresencePipelineOptions = {
    runId: null,
    dryRun: false,
    confirmProduction: false,
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
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.dryRun && !options.confirmProduction) {
    throw new Error('Refusing to verify analytics presence pipeline without --confirm-production. Use --dry-run to inspect SQL.');
  }

  return options;
}

export function loadVerifyAnalyticsPresencePipelineConfig(
  env: Record<string, string | undefined> = process.env,
  options: { requireClickHouse: boolean } = { requireClickHouse: true },
): VerifyAnalyticsPresencePipelineConfig {
  return {
    clickhouseUrl: options.requireClickHouse ? readRequired(env.CLICKHOUSE_URL, 'CLICKHOUSE_URL') : (env.CLICKHOUSE_URL ?? 'http://localhost:8123'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'atp_dashboard',
    clickhouseUsername: readOptional(env.CLICKHOUSE_USERNAME),
    clickhousePassword: readOptional(env.CLICKHOUSE_PASSWORD),
    clickhouseRefreshTimeoutMs: readPositiveInteger(env.CLICKHOUSE_REFRESH_TIMEOUT_MS ?? '600000', 'CLICKHOUSE_REFRESH_TIMEOUT_MS'),
  };
}

export function buildVerifyPresencePipelineQuery(hasRunId: boolean): string {
  const runFilter = hasRunId ? 'WHERE run_id = {run_id:UUID}' : '';
  return `
WITH latest_run AS
(
  SELECT run_id, status
  FROM atp_dashboard.analytics_presence_run_status
  ${runFilter}
  ORDER BY if(isNull(published_at), verified_at, published_at) DESC, updated_at DESC
  LIMIT 1
),
latest_refresh AS
(
  SELECT refresh_id
  FROM atp_dashboard.analytics_chart_refresh_manifest
  WHERE status = 'completed'
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT
  count() AS row_count,
  countDistinct(tuple(tool, days, bucket_days)) AS chart_groups,
  countIf(date > today()) AS future_rows,
  countDistinct(latest_at) AS latest_at_values,
  countDistinct(refreshed_at) AS refreshed_at_values,
  (SELECT count() FROM atp_dashboard.analytics_chart_refresh_manifest WHERE refresh_id IN latest_refresh AND status = 'completed') AS manifest_rows,
  (
    SELECT count()
    FROM
    (
      SELECT event_key
      FROM atp_dashboard.analytics_hourly_event_key_presence
      GROUP BY event_key
      HAVING countDistinct(hour) > 1
    )
  ) AS cross_hour_event_key_duplicates,
  (SELECT status FROM latest_run) AS run_status
FROM atp_dashboard.analytics_chart_snapshot
WHERE refresh_id IN latest_refresh
`;
}

export async function verifyAnalyticsPresencePipeline(
  client: ClickHouseQueryLike,
  options: VerifyAnalyticsPresencePipelineOptions,
): Promise<{ status: 'completed' | 'dry_run'; row?: VerifyRow }> {
  const query = buildVerifyPresencePipelineQuery(options.runId !== null);

  if (options.dryRun) {
    console.log(query);
    return { status: 'dry_run' };
  }

  const result = await client.query({
    query,
    query_params: options.runId ? { run_id: options.runId } : {},
    format: 'JSONEachRow',
  });
  const rows = await result.json<VerifyRow[]>();
  const row = rows[0];
  if (!row) {
    throw new Error('presence pipeline verification returned no rows');
  }

  const rowCount = Number(row.row_count);
  const chartGroups = Number(row.chart_groups);
  const futureRows = Number(row.future_rows);
  const latestAtValues = Number(row.latest_at_values);
  const refreshedAtValues = Number(row.refreshed_at_values);
  const manifestRows = Number(row.manifest_rows);
  const crossHourEventKeyDuplicates = Number(row.cross_hour_event_key_duplicates);
  if (rowCount !== 150 || chartGroups !== 9 || futureRows !== 0 || latestAtValues !== 1 || refreshedAtValues !== 1 || manifestRows !== 1 || crossHourEventKeyDuplicates !== 0) {
    throw new Error(
      `presence pipeline verification failed rows=${rowCount} groups=${chartGroups} future=${futureRows} latest_at_values=${latestAtValues} refreshed_at_values=${refreshedAtValues} manifest_rows=${manifestRows} cross_hour_event_key_duplicates=${crossHourEventKeyDuplicates}`,
    );
  }

  return { status: 'completed', row };
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
  const options = parseVerifyAnalyticsPresencePipelineOptions(process.argv.slice(2));
  const config = loadVerifyAnalyticsPresencePipelineConfig(process.env, { requireClickHouse: !options.dryRun });
  const { createClient } = await import('@clickhouse/client');
  const client = options.dryRun
    ? {
        async query() {
          return { async json() { return []; } };
        },
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
    const result = await verifyAnalyticsPresencePipeline(client, options);
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
