import { randomUUID } from 'node:crypto';
import { buildCollectionEventKey, normalizeCreatedAtKey } from './event-key.ts';

export type CollectionSourceRow = {
  did: string;
  collection: string;
  rkey: string;
  createdAt: string | null;
};

export type CollectionEventInsertRow = {
  event_key: string;
  did: string;
  collection: string;
  rkey: string;
  created_at: string | null;
  created_at_key: string;
};

export type BackfillWatermark = {
  createdAt: string | null;
  createdAtKey: string;
  did: string;
  collection: string;
  rkey: string;
};

export type BackfillCliOptions = {
  dryRun: boolean;
  limit: number | null;
  resumeFrom: BackfillWatermark | null;
  batchSize: number;
  maxRuntimeMinutes: number | null;
  maxRows: number | null;
  confirmProduction: boolean;
  checkpointName: string;
  lockName: string;
  lockTtlSeconds: number;
};

export type BackfillConfig = {
  postgresUrl: string;
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUsername: string | null;
  clickhousePassword: string | null;
};

type PgClientLike = {
  connect: () => Promise<void>;
  end: () => Promise<void>;
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type ClickHouseClientLike = {
  insert: (params: { table: string; values: CollectionEventInsertRow[]; format: 'JSONEachRow' }) => Promise<unknown>;
  close?: () => Promise<void>;
};

export const DEFAULT_CHECKPOINT_NAME = 'collection_events_backfill_v2_unique_index';
export const NULL_CREATED_AT_ORDER_NOTE =
  'Backfill order is did, collection, rkey, then "createdAt" ASC NULLS LAST to follow unique_collection_index. Resume predicates are exclusive; replay is safe because event_key is deterministic.';

export function parseBackfillCliOptions(argv: string[]): BackfillCliOptions {
  const options: BackfillCliOptions = {
    dryRun: false,
    limit: null,
    resumeFrom: null,
    batchSize: 50_000,
    maxRuntimeMinutes: null,
    maxRows: null,
    confirmProduction: false,
    checkpointName: DEFAULT_CHECKPOINT_NAME,
    lockName: DEFAULT_CHECKPOINT_NAME,
    lockTtlSeconds: 900,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--confirm-production') {
      options.confirmProduction = true;
    } else if (arg === '--limit') {
      options.limit = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--batch-size') {
      options.batchSize = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--max-runtime-minutes') {
      options.maxRuntimeMinutes = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--max-rows') {
      options.maxRows = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--resume-from') {
      options.resumeFrom = parseWatermark(readNext(argv, ++index, arg));
    } else if (arg === '--checkpoint-name') {
      options.checkpointName = readNext(argv, ++index, arg);
      options.lockName = options.checkpointName;
    } else if (arg === '--lock-ttl-seconds') {
      options.lockTtlSeconds = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.dryRun && !options.confirmProduction) {
    throw new Error('Refusing to write without --confirm-production. Use --dry-run for safe inspection.');
  }
  if (options.limit == null && options.maxRows == null && options.maxRuntimeMinutes == null) {
    throw new Error('Refusing unbounded run. Provide --limit, --max-rows, or --max-runtime-minutes.');
  }
  return options;
}

export function loadBackfillConfig(
  env: Record<string, string | undefined> = process.env,
  options: { requireClickHouse: boolean } = { requireClickHouse: true },
): BackfillConfig {
  return {
    postgresUrl: readRequired(env.POSTGRES_URL, 'POSTGRES_URL'),
    clickhouseUrl: options.requireClickHouse ? readRequired(env.CLICKHOUSE_URL, 'CLICKHOUSE_URL') : (env.CLICKHOUSE_URL ?? 'http://localhost:8123'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'atp_dashboard',
    clickhouseUsername: readOptional(env.CLICKHOUSE_USERNAME),
    clickhousePassword: readOptional(env.CLICKHOUSE_PASSWORD),
  };
}

export function buildCollectionEventRows(rows: CollectionSourceRow[]): CollectionEventInsertRow[] {
  return rows.map((row) => {
    const createdAtKey = normalizeCreatedAtKey(row.createdAt);
    const { eventKey } = buildCollectionEventKey({
      did: row.did,
      collection: row.collection,
      rkey: row.rkey,
      createdAt: row.createdAt,
    });

    return {
      event_key: eventKey,
      did: row.did,
      collection: row.collection,
      rkey: row.rkey,
      created_at: createdAtKey === '<NULL>' ? null : toClickHouseDateTime64(createdAtKey),
      created_at_key: createdAtKey,
    };
  });
}

export function toClickHouseDateTime64(createdAtKey: string): string {
  return createdAtKey.replace('T', ' ').replace(/Z$/, '');
}

export function getLastWatermark(rows: CollectionSourceRow[]): BackfillWatermark | null {
  const row = rows.at(-1);
  if (!row) {
    return null;
  }

  return {
    createdAt: row.createdAt,
    createdAtKey: normalizeCreatedAtKey(row.createdAt),
    did: row.did,
    collection: row.collection,
    rkey: row.rkey,
  };
}

export function buildBatchQuery(watermark: BackfillWatermark | null, limit: number): { sql: string; params: unknown[] } {
  const select = `
SELECT
  c.did,
  c.collection,
  c.rkey,
  CASE WHEN c."createdAt" IS NULL THEN NULL ELSE to_char(c."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "createdAt"
FROM public.collection c`;
  const orderLimit = `
ORDER BY c.did ASC, c.collection ASC, c.rkey ASC, c."createdAt" ASC NULLS LAST
LIMIT $${watermark ? 5 : 1}`;

  if (!watermark) {
    return { sql: `${select}${orderLimit}`, params: [limit] };
  }

  if (watermark.createdAt === null) {
    const sql = `${select}
WHERE (
  (c.did, c.collection, c.rkey) > ($2::text, $3::text, $4::text)
)${orderLimit}`;

    return {
      sql,
      params: [watermark.createdAt, watermark.did, watermark.collection, watermark.rkey, limit],
    };
  }

  const unionSelect = `
SELECT
  c.did,
  c.collection,
  c.rkey,
  CASE WHEN c."createdAt" IS NULL THEN NULL ELSE to_char(c."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "createdAt",
  c."createdAt" AS created_at_sort
FROM public.collection c`;
  const sql = `
SELECT did, collection, rkey, "createdAt"
FROM (
  (${unionSelect}
   WHERE (c.did, c.collection, c.rkey, c."createdAt") > ($2::text, $3::text, $4::text, $1::timestamptz)
   ORDER BY c.did ASC, c.collection ASC, c.rkey ASC, c."createdAt" ASC
   LIMIT $5)
  UNION ALL
  (${unionSelect}
   WHERE (c.did, c.collection, c.rkey) = ($2::text, $3::text, $4::text)
     AND c."createdAt" IS NULL
   ORDER BY c.did ASC, c.collection ASC, c.rkey ASC, c."createdAt" ASC
   LIMIT $5)
) s
ORDER BY did ASC, collection ASC, rkey ASC, created_at_sort ASC NULLS LAST
LIMIT $5`;

  return {
    sql,
    params: [watermark.createdAt, watermark.did, watermark.collection, watermark.rkey, limit],
  };
}

export async function runBackfill(
  options: BackfillCliOptions,
  clients: { pg: PgClientLike; clickhouse: ClickHouseClientLike },
): Promise<{ rowsRead: number; rowsInserted: number; finalWatermark: BackfillWatermark | null; dryRun: boolean }> {
  const startedAt = Date.now();
  let rowsRead = 0;
  let rowsInserted = 0;
  let watermark = options.resumeFrom ?? (await readCheckpoint(clients.pg, options.checkpointName));
  const holder = randomUUID();

  if (!options.dryRun) {
    await acquireLock(clients.pg, options.lockName, holder, options.lockTtlSeconds);
  }

  try {
    while (true) {
      if (options.maxRuntimeMinutes != null && Date.now() - startedAt >= options.maxRuntimeMinutes * 60_000) {
        break;
      }
      const totalRowCap = options.maxRows ?? options.limit;
      const remainingRows = totalRowCap == null ? options.batchSize : totalRowCap - rowsRead;
      if (remainingRows <= 0) {
        break;
      }

      const effectiveLimit = Math.min(options.batchSize, remainingRows);
      const { sql, params } = buildBatchQuery(watermark, effectiveLimit);
      const result = await clients.pg.query<CollectionSourceRow>(sql, params);
      if (result.rows.length === 0) {
        break;
      }

      const eventRows = buildCollectionEventRows(result.rows);
      const nextWatermark = getLastWatermark(result.rows);
      rowsRead += result.rows.length;

      if (!options.dryRun) {
        await clients.clickhouse.insert({
          table: 'atp_dashboard.collection_events',
          values: eventRows,
          format: 'JSONEachRow',
        });
        if (nextWatermark) {
          await writeCheckpoint(clients.pg, options.checkpointName, nextWatermark);
        }
        rowsInserted += eventRows.length;
      }

      watermark = nextWatermark;
      if (result.rows.length < effectiveLimit) {
        break;
      }
    }
  } finally {
    if (!options.dryRun) {
      await releaseLock(clients.pg, options.lockName, holder);
    }
  }

  return {
    rowsRead,
    rowsInserted,
    finalWatermark: watermark,
    dryRun: options.dryRun,
  };
}

async function readCheckpoint(pg: PgClientLike, name: string): Promise<BackfillWatermark | null> {
  const result = await pg.query<{
    watermark_created_at: string | null;
    watermark_created_at_key: string;
    watermark_did: string;
    watermark_collection: string;
    watermark_rkey: string;
  }>(
    `SELECT
       CASE
         WHEN watermark_created_at IS NULL THEN NULL
         ELSE to_char(watermark_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       END AS watermark_created_at,
       watermark_created_at_key,
       watermark_did,
       watermark_collection,
       watermark_rkey
     FROM public.clickhouse_sync_checkpoints
     WHERE name = $1`,
    [name],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    createdAt: row.watermark_created_at,
    createdAtKey: row.watermark_created_at_key,
    did: row.watermark_did,
    collection: row.watermark_collection,
    rkey: row.watermark_rkey,
  };
}

async function writeCheckpoint(pg: PgClientLike, name: string, watermark: BackfillWatermark): Promise<void> {
  await pg.query(
    `INSERT INTO public.clickhouse_sync_checkpoints
       (name, watermark_created_at, watermark_created_at_key, watermark_did, watermark_collection, watermark_rkey, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (name) DO UPDATE
     SET watermark_created_at = EXCLUDED.watermark_created_at,
         watermark_created_at_key = EXCLUDED.watermark_created_at_key,
         watermark_did = EXCLUDED.watermark_did,
         watermark_collection = EXCLUDED.watermark_collection,
         watermark_rkey = EXCLUDED.watermark_rkey,
         updated_at = now()`,
    [name, watermark.createdAt, watermark.createdAtKey, watermark.did, watermark.collection, watermark.rkey],
  );
}

async function acquireLock(pg: PgClientLike, name: string, holder: string, ttlSeconds: number): Promise<void> {
  const result = await pg.query(
    `INSERT INTO public.clickhouse_sync_locks (name, holder, expires_at)
     VALUES ($1, $2, now() + ($3::text || ' seconds')::interval)
     ON CONFLICT (name) DO UPDATE
     SET holder = EXCLUDED.holder,
         acquired_at = now(),
         expires_at = EXCLUDED.expires_at
     WHERE public.clickhouse_sync_locks.expires_at < now()
     RETURNING holder`,
    [name, holder, ttlSeconds],
  );
  if (result.rows.length !== 1) {
    throw new Error(`Could not acquire ClickHouse sync lock: ${name}`);
  }
}

async function releaseLock(pg: PgClientLike, name: string, holder: string): Promise<void> {
  await pg.query('DELETE FROM public.clickhouse_sync_locks WHERE name = $1 AND holder = $2', [name, holder]);
}

function parseWatermark(value: string): BackfillWatermark {
  const parsed = JSON.parse(value) as Partial<BackfillWatermark>;
  if (!('createdAt' in parsed) || !parsed.did || !parsed.collection || !parsed.rkey) {
    throw new Error('--resume-from must be JSON with createdAt, did, collection, and rkey');
  }
  return {
    createdAt: parsed.createdAt ?? null,
    createdAtKey: parsed.createdAtKey ?? normalizeCreatedAtKey(parsed.createdAt),
    did: parsed.did,
    collection: parsed.collection,
    rkey: parsed.rkey,
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
  const options = parseBackfillCliOptions(process.argv.slice(2));
  const config = loadBackfillConfig(process.env, { requireClickHouse: !options.dryRun });
  const { Client } = await import('pg');
  const pg = new Client({ connectionString: config.postgresUrl });
  const clickhouse = options.dryRun
    ? {
        async insert() {},
        async close() {},
      }
    : await createClickHouseClient(config);

  await pg.connect();
  try {
    const result = await runBackfill(options, { pg, clickhouse });
    console.log(JSON.stringify({ ...result, note: NULL_CREATED_AT_ORDER_NOTE }, null, 2));
  } finally {
    await Promise.allSettled([pg.end(), clickhouse.close()]);
  }
}

async function createClickHouseClient(config: BackfillConfig): Promise<ClickHouseClientLike> {
  const { createClient } = await import('@clickhouse/client');
  return createClient({
    url: config.clickhouseUrl,
    username: config.clickhouseUsername ?? undefined,
    password: config.clickhousePassword ?? undefined,
    database: config.clickhouseDatabase,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
