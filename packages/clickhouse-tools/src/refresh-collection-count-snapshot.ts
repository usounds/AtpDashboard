import { randomUUID } from 'node:crypto';

export type RefreshStatus = 'running' | 'completed' | 'failed';

export type RefreshCollectionCountOptions = {
  refreshId: string;
  dryRun: boolean;
  confirmProduction: boolean;
  staleRunningMinutes: number;
  recentHours: number;
};

export type RefreshCollectionCountConfig = {
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUsername: string | null;
  clickhousePassword: string | null;
};

type ClickHouseCommandLike = {
  command: (params: { query: string; query_params?: Record<string, unknown> }) => Promise<unknown>;
  close?: () => Promise<void>;
};

export const LEXICON_STORE_DID = 'did:web:lexicon.store';

export function parseRefreshCollectionCountOptions(argv: string[]): RefreshCollectionCountOptions {
  const options: RefreshCollectionCountOptions = {
    refreshId: randomUUID(),
    dryRun: false,
    confirmProduction: false,
    staleRunningMinutes: 60,
    recentHours: 72,
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
    } else if (arg === '--recent-hours') {
      options.recentHours = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.dryRun && !options.confirmProduction) {
    throw new Error('Refusing to refresh snapshot without --confirm-production. Use --dry-run to inspect SQL.');
  }

  return options;
}

export function loadRefreshCollectionCountConfig(
  env: Record<string, string | undefined> = process.env,
  options: { requireClickHouse: boolean } = { requireClickHouse: true },
): RefreshCollectionCountConfig {
  return {
    clickhouseUrl: options.requireClickHouse ? readRequired(env.CLICKHOUSE_URL, 'CLICKHOUSE_URL') : (env.CLICKHOUSE_URL ?? 'http://localhost:8123'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'atp_dashboard',
    clickhouseUsername: readOptional(env.CLICKHOUSE_USERNAME),
    clickhousePassword: readOptional(env.CLICKHOUSE_PASSWORD),
  };
}

export function buildMarkStaleRunningQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_refresh_manifest
SELECT
  refresh_id,
  'failed' AS status,
  started_at,
  now64(3, 'UTC') AS completed_at,
  row_count,
  concat('marked stale after ', {stale_running_minutes:UInt32}, ' minutes') AS error_message,
  now64(3, 'UTC') AS updated_at
FROM atp_dashboard.collection_count_refresh_manifest
WHERE status = 'running'
  AND started_at < now64(3, 'UTC') - toIntervalMinute({stale_running_minutes:UInt32})
`;
}

export function buildManifestInsertQuery(status: RefreshStatus): string {
  if (status === 'completed') {
    return `
INSERT INTO atp_dashboard.collection_count_refresh_manifest
  (refresh_id, status, started_at, completed_at, row_count, error_message, updated_at)
SELECT
  {refresh_id:UUID} AS refresh_id,
  'completed' AS status,
  now64(3, 'UTC') AS started_at,
  now64(3, 'UTC') AS completed_at,
  count() AS row_count,
  NULL AS error_message,
  now64(3, 'UTC') AS updated_at
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = {refresh_id:UUID}
`;
  }

  const completedAt = status === 'running' ? 'NULL' : "now64(3, 'UTC')";
  const errorMessage = status === 'failed' ? '{error_message:Nullable(String)}' : 'NULL';
  return `
INSERT INTO atp_dashboard.collection_count_refresh_manifest
  (refresh_id, status, started_at, completed_at, row_count, error_message, updated_at)
VALUES
  ({refresh_id:UUID}, '${status}', now64(3, 'UTC'), ${completedAt}, {row_count:UInt64}, ${errorMessage}, now64(3, 'UTC'))
`;
}

export function buildSnapshotInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_snapshot
  (refresh_id, collection, total_count, recent_count, min_created_at, max_created_at, refreshed_at)
SELECT
  {refresh_id:UUID} AS refresh_id,
  collection,
  uniqExact(event_key) AS total_count,
  uniqExactIf(event_key, isNotNull(created_at) AND created_at >= now64(6, 'UTC') - toIntervalHour({recent_hours:UInt32})) AS recent_count,
  min(created_at) AS min_created_at,
  max(created_at) AS max_created_at,
  now64(3, 'UTC') AS refreshed_at
FROM atp_dashboard.collection_events
WHERE did != {excluded_did:String}
GROUP BY collection
`;
}

export async function refreshCollectionCountSnapshot(
  client: ClickHouseCommandLike,
  options: RefreshCollectionCountOptions,
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
    await client.command(queries.insertSnapshot);
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

export function buildRefreshQueryPlan(options: RefreshCollectionCountOptions): {
  beforeSnapshot: Array<{ query: string; query_params: Record<string, unknown> }>;
  insertSnapshot: { query: string; query_params: Record<string, unknown> };
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
    insertSnapshot: {
      query: buildSnapshotInsertQuery(),
      query_params: {
        refresh_id: options.refreshId,
        recent_hours: options.recentHours,
        excluded_did: LEXICON_STORE_DID,
      },
    },
    completeManifest: {
      query: buildManifestInsertQuery('completed'),
      query_params: {
        refresh_id: options.refreshId,
      },
    },
  };
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
  const options = parseRefreshCollectionCountOptions(process.argv.slice(2));
  const config = loadRefreshCollectionCountConfig(process.env, { requireClickHouse: !options.dryRun });
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
      });

  try {
    const result = await refreshCollectionCountSnapshot(client, options);
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
