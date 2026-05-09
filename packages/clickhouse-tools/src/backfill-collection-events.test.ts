import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBatchQuery,
  buildCollectionEventRows,
  getLastWatermark,
  loadBackfillConfig,
  parseBackfillCliOptions,
  runBackfill,
  type BackfillCliOptions,
  type CollectionSourceRow,
} from './backfill-collection-events.ts';

test('requires dry-run or confirm-production', () => {
  assert.throws(() => parseBackfillCliOptions(['--batch-size', '100']), /Refusing to write/);
  assert.throws(() => parseBackfillCliOptions(['--dry-run']), /Refusing unbounded run/);
  assert.equal(parseBackfillCliOptions(['--dry-run', '--limit', '1']).dryRun, true);
  assert.equal(parseBackfillCliOptions(['--', '--dry-run', '--limit', '1']).limit, 1);
});

test('dry-run config does not require ClickHouse URL', () => {
  const config = loadBackfillConfig({ POSTGRES_URL: 'postgres://local/db' }, { requireClickHouse: false });

  assert.equal(config.postgresUrl, 'postgres://local/db');
  assert.equal(config.clickhouseUrl, 'http://localhost:8123');
});

test('builds deterministic event rows with microsecond createdAt key', () => {
  const [row] = buildCollectionEventRows([
    {
      did: 'did:plc:example',
      collection: 'app.example.post',
      rkey: 'abc',
      createdAt: '2026-05-09T05:34:10.123456Z',
    },
  ]);

  assert.equal(row.created_at, '2026-05-09 05:34:10.123456');
  assert.equal(row.created_at_key, '2026-05-09T05:34:10.123456Z');
  assert.match(row.event_key, /2026-05-09T05:34:10\.123456Z/);
});

test('maps null createdAt to null ClickHouse timestamp and sentinel key', () => {
  const [row] = buildCollectionEventRows([
    { did: 'did:plc:null', collection: 'app.example.post', rkey: 'null-rkey', createdAt: null },
  ]);

  assert.equal(row.created_at, null);
  assert.equal(row.created_at_key, '<NULL>');
});

test('batch query uses unique index order and exclusive tuple watermark', () => {
  const { sql, params } = buildBatchQuery(
    {
      createdAt: '2026-05-09T00:00:00.000001Z',
      createdAtKey: '2026-05-09T00:00:00.000001Z',
      did: 'did:plc:a',
      collection: 'app.a',
      rkey: 'r1',
    },
    500,
  );

  assert.match(sql, /UNION ALL/);
  assert.match(sql, /\(c\.did, c\.collection, c\.rkey, c\."createdAt"\) > \(\$2::text, \$3::text, \$4::text, \$1::timestamptz\)/);
  assert.match(sql, /c\."createdAt" IS NULL/);
  assert.match(sql, /ORDER BY did ASC, collection ASC, rkey ASC, created_at_sort ASC NULLS LAST/);
  assert.deepEqual(params, ['2026-05-09T00:00:00.000001Z', 'did:plc:a', 'app.a', 'r1', 500]);
});

test('batch query advances to next key after NULL createdAt watermark', () => {
  const { sql, params } = buildBatchQuery(
    {
      createdAt: null,
      createdAtKey: '<NULL>',
      did: 'did:plc:a',
      collection: 'app.a',
      rkey: 'r1',
    },
    500,
  );

  assert.doesNotMatch(sql, /UNION ALL/);
  assert.match(sql, /\(c\.did, c\.collection, c\.rkey\) > \(\$2::text, \$3::text, \$4::text\)/);
  assert.match(sql, /ORDER BY c\.did ASC, c\.collection ASC, c\.rkey ASC, c\."createdAt" ASC NULLS LAST/);
  assert.deepEqual(params, [null, 'did:plc:a', 'app.a', 'r1', 500]);
});

test('last watermark is taken from final row', () => {
  const rows: CollectionSourceRow[] = [
    { did: 'did:plc:a', collection: 'app.a', rkey: 'r1', createdAt: null },
    { did: 'did:plc:b', collection: 'app.b', rkey: 'r2', createdAt: '2026-05-09T00:00:00.000001Z' },
  ];

  assert.deepEqual(getLastWatermark(rows), {
    createdAt: '2026-05-09T00:00:00.000001Z',
    createdAtKey: '2026-05-09T00:00:00.000001Z',
    did: 'did:plc:b',
    collection: 'app.b',
    rkey: 'r2',
  });
});

test('runBackfill updates checkpoint only after ClickHouse insert succeeds', async () => {
  const queries: string[] = [];
  const operations: string[] = [];
  const inserted: unknown[] = [];
  const pg = {
    async connect() {},
    async end() {},
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      queries.push(sql);
      if (sql.includes('clickhouse_sync_checkpoints') && sql.includes('SELECT')) {
        return { rows: [] };
      }
      if (sql.includes('FROM public.collection')) {
        operations.push('read-source');
        return {
          rows: [
            { did: 'did:plc:a', collection: 'app.a', rkey: 'r1', createdAt: null },
            { did: 'did:plc:b', collection: 'app.b', rkey: 'r2', createdAt: '2026-05-09T00:00:00.000001Z' },
          ] as T[],
        };
      }
      if (sql.includes('public.clickhouse_sync_checkpoints') && sql.includes('ON CONFLICT (name) DO UPDATE')) {
        operations.push('write-checkpoint');
      }
      return { rows: [{ ok: true }] as T[] };
    },
  };
  const clickhouse = {
    async insert(params: { values: unknown[] }) {
      operations.push('insert-clickhouse');
      inserted.push(...params.values);
    },
  };

  const options: BackfillCliOptions = {
    dryRun: false,
    limit: 2,
    resumeFrom: null,
    batchSize: 2,
    maxRuntimeMinutes: null,
    maxRows: null,
    confirmProduction: true,
    checkpointName: 'test',
    lockName: 'test',
    lockTtlSeconds: 60,
  };

  const result = await runBackfill(options, { pg, clickhouse });
  const insertIndex = operations.indexOf('insert-clickhouse');
  const checkpointIndex = operations.indexOf('write-checkpoint');

  assert.equal(result.rowsRead, 2);
  assert.equal(result.rowsInserted, 2);
  assert.equal(inserted.length, 2);
  assert.ok(insertIndex >= 0);
  assert.ok(checkpointIndex > insertIndex);
});

test('dry-run reads rows but does not insert or checkpoint', async () => {
  let insertCalled = false;
  const pg = {
    async connect() {},
    async end() {},
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('clickhouse_sync_checkpoints')) {
        return { rows: [] };
      }
      return {
        rows: [{ did: 'did:plc:a', collection: 'app.a', rkey: 'r1', createdAt: null }] as T[],
      };
    },
  };
  const clickhouse = {
    async insert() {
      insertCalled = true;
    },
  };

  const result = await runBackfill(
    {
      dryRun: true,
      limit: 1,
      resumeFrom: null,
      batchSize: 1,
      maxRuntimeMinutes: null,
      maxRows: null,
      confirmProduction: false,
      checkpointName: 'test',
      lockName: 'test',
      lockTtlSeconds: 60,
    },
    { pg, clickhouse },
  );

  assert.equal(result.rowsRead, 1);
  assert.equal(result.rowsInserted, 0);
  assert.equal(insertCalled, false);
});
