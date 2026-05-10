export type RefreshAnalyticsHourlyNewOptions = {
  dryRun: boolean;
  confirmProduction: boolean;
};

export type RefreshAnalyticsHourlyNewConfig = {
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUsername: string | null;
  clickhousePassword: string | null;
  clickhouseRefreshTimeoutMs: number;
};

type ClickHouseCommandLike = {
  command: (params: { query: string }) => Promise<unknown>;
  close?: () => Promise<void>;
};

export function parseRefreshAnalyticsHourlyNewOptions(argv: string[]): RefreshAnalyticsHourlyNewOptions {
  const options: RefreshAnalyticsHourlyNewOptions = {
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
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.dryRun && !options.confirmProduction) {
    throw new Error('Refusing to refresh analytics hourly new rollups without --confirm-production. Use --dry-run to inspect SQL.');
  }

  return options;
}

export function loadRefreshAnalyticsHourlyNewConfig(
  env: Record<string, string | undefined> = process.env,
  options: { requireClickHouse: boolean } = { requireClickHouse: true },
): RefreshAnalyticsHourlyNewConfig {
  return {
    clickhouseUrl: options.requireClickHouse ? readRequired(env.CLICKHOUSE_URL, 'CLICKHOUSE_URL') : (env.CLICKHOUSE_URL ?? 'http://localhost:8123'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'atp_dashboard',
    clickhouseUsername: readOptional(env.CLICKHOUSE_USERNAME),
    clickhousePassword: readOptional(env.CLICKHOUSE_PASSWORD),
    clickhouseRefreshTimeoutMs: readPositiveInteger(env.CLICKHOUSE_REFRESH_TIMEOUT_MS ?? '600000', 'CLICKHOUSE_REFRESH_TIMEOUT_MS'),
  };
}

export function buildHourlyNewDidRollupInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_hourly_new_did_rollup
SELECT
  dateTrunc('hour', first_seen_at) AS hour,
  count() AS new_count,
  now64(3, 'UTC') AS refreshed_at
FROM
(
  SELECT
    did,
    minMerge(first_seen_state) AS first_seen_at
  FROM atp_dashboard.analytics_did_first_seen_state
  GROUP BY did
)
GROUP BY hour
`;
}

export function buildHourlyNewCollectionRollupInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.analytics_hourly_new_collection_rollup
SELECT
  dateTrunc('hour', first_seen_at) AS hour,
  count() AS new_count,
  now64(3, 'UTC') AS refreshed_at
FROM
(
  SELECT
    collection,
    minMerge(first_seen_state) AS first_seen_at
  FROM atp_dashboard.analytics_collection_first_seen_state
  GROUP BY collection
)
GROUP BY hour
`;
}

export async function refreshAnalyticsHourlyNewRollups(
  client: ClickHouseCommandLike,
  options: RefreshAnalyticsHourlyNewOptions,
): Promise<{ dryRun: boolean; status: 'completed' | 'dry_run' }> {
  if (options.dryRun) {
    return {
      dryRun: true,
      status: 'dry_run',
    };
  }

  await client.command({ query: buildHourlyNewDidRollupInsertQuery() });
  await client.command({ query: buildHourlyNewCollectionRollupInsertQuery() });

  return {
    dryRun: false,
    status: 'completed',
  };
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
  const options = parseRefreshAnalyticsHourlyNewOptions(process.argv.slice(2));
  const config = loadRefreshAnalyticsHourlyNewConfig(process.env, { requireClickHouse: !options.dryRun });
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
    const result = await refreshAnalyticsHourlyNewRollups(client, options);
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
