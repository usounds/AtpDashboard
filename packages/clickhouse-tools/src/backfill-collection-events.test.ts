import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCollectionEventDualWriteRows,
  buildBatchQuery,
  buildBootstrapHighQuery,
  buildBootstrapRawSourceQuery,
  buildCollectionEventRows,
  buildRecentRescanQuery,
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
  assert.throws(() => parseBackfillCliOptions(['--dry-run', '--max-runtime-minutes', '1', '--rescan-days', '1']), /unbounded rescan/);
  assert.equal(parseBackfillCliOptions(['--dry-run', '--limit', '100', '--rescan-days', '1']).rescanDays, 1);
  assert.equal(parseBackfillCliOptions(['--dry-run', '--limit', '100', '--rescan-minutes', '180']).rescanMinutes, 180);
  assert.equal(parseBackfillCliOptions(['--dry-run', '--limit', '100', '--rescan-overlap-minutes', '5']).rescanOverlapMinutes, 5);
  assert.throws(() => parseBackfillCliOptions(['--dry-run', '--limit', '100', '--rescan-days', '1', '--rescan-minutes', '60']), /either --rescan-days or --rescan-minutes/);
  assert.throws(() => parseBackfillCliOptions(['--dry-run', '--max-runtime-minutes', '1', '--bootstrap-queue-from-raw']), /unbounded raw bootstrap/);
  assert.equal(parseBackfillCliOptions(['--dry-run', '--limit', '100', '--bootstrap-queue-from-raw']).bootstrapQueueFromRaw, true);
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
  ], '2026-05-10 00:00:00.001');

  assert.equal(row.created_at, '2026-05-09 05:34:10.123456');
  assert.equal(row.created_at_key, '2026-05-09T05:34:10.123456Z');
  assert.equal(row.ingested_at, '2026-05-10 00:00:00.001');
  assert.match(row.event_key, /2026-05-09T05:34:10\.123456Z/);
});

test('maps null createdAt to null ClickHouse timestamp and sentinel key', () => {
  const [row] = buildCollectionEventRows([
    { did: 'did:plc:null', collection: 'app.example.post', rkey: 'null-rkey', createdAt: null },
  ]);

  assert.equal(row.created_at, null);
  assert.equal(row.created_at_key, '<NULL>');
});

test('builds queue and existence log rows with payload hash and queue sequence', () => {
  const rows = buildCollectionEventDualWriteRows(
    [
      {
        did: 'did:plc:example',
        collection: 'app.example.post',
        rkey: 'abc',
        createdAt: '2026-05-09T05:34:10.123456Z',
      },
    ],
    { writtenAt: '2026-05-10 00:00:00.001' },
  );

  assert.equal(rows.events.length, 1);
  assert.equal(rows.existence.length, 1);
  assert.equal(rows.queue.length, 1);
  assert.equal(rows.events[0].event_key, rows.existence[0].event_key);
  assert.equal(rows.events[0].event_key, rows.queue[0].event_key);
  assert.equal(rows.existence[0].payload_hash, rows.queue[0].payload_hash);
  assert.equal(rows.existence[0].source_ingested_at, '2026-05-10 00:00:00.001');
  assert.equal(rows.queue[0].queued_at, '2026-05-10 00:00:00.001');
  assert.notEqual(rows.queue[0].queue_seq, '');
  assert.equal(rows.queue[0].created_hour, '2026-05-09 05:00:00');
});

test('dual-write queue rows are bumped after completed cutoff', () => {
  const rows = buildCollectionEventDualWriteRows(
    [{ did: 'did:plc:a', collection: 'app.a', rkey: 'r1', createdAt: null }],
    {
      writtenAt: '2026-05-10 00:00:00.000',
      latestCompletedCutoff: {
        queuedAt: '2026-05-10 00:00:00.000',
        eventKey: 'zzzz',
        queueSeq: '9999',
      },
    },
  );

  assert.equal(rows.queue[0].queued_at, '2026-05-10 00:00:00.001');
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

test('recent rescan query reads by createdAt window without checkpoint tuple', () => {
  const { sql, params } = buildRecentRescanQuery('2026-05-09T16:00:00.000000Z', 1000);

  assert.match(sql, /c\."createdAt" >= \$1::timestamptz/);
  assert.match(sql, /ORDER BY c\."createdAt" DESC, c\.did ASC, c\.collection ASC, c\.rkey ASC/);
  assert.doesNotMatch(sql, /clickhouse_sync_checkpoints/);
  assert.deepEqual(params, ['2026-05-09T16:00:00.000000Z', 1000]);
});

test('bootstrap raw source queries are bounded and ordered by bootstrap high tuple', () => {
  const high = buildBootstrapHighQuery();
  const source = buildBootstrapRawSourceQuery(1000);

  assert.match(high, /ORDER BY ingested_at DESC, event_key DESC/);
  assert.match(source.query, /collection_count_bootstrap_bounded/);
  assert.match(source.query, /FROM atp_dashboard\.collection_events/);
  assert.match(source.query, /FROM atp_dashboard\.collection_count_bootstrap_progress/);
  assert.match(source.query, /FROM atp_dashboard\.collection_count_event_existence_log/);
  assert.match(source.query, /WHERE event_key > last_scanned_event_key/);
  assert.match(source.query, /LEFT ANY JOIN/);
  assert.match(source.query, /alreadyExists/);
  assert.match(source.query, /ORDER BY c\.event_key ASC/);
  assert.match(source.query, /LIMIT \{limit:UInt64\}/);
  assert.deepEqual(source.query_params, { limit: 1000 });
});

test('rescan mode inserts recent rows and records last rescan time', async () => {
  const operations: string[] = [];
  const pg = {
    async connect() {},
    async end() {},
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('clickhouse_sync_checkpoints') && sql.includes('SELECT')) {
        operations.push('read-checkpoint');
        return {
          rows: [
            {
              watermark_created_at: '2026-05-09T00:00:00.000001Z',
              watermark_created_at_key: '2026-05-09T00:00:00.000001Z',
              watermark_did: 'did:plc:checkpoint',
              watermark_collection: 'app.checkpoint',
              watermark_rkey: 'r0',
            },
          ] as T[],
        };
      }
      if (sql.includes('FROM public.collection')) {
        operations.push('read-recent-source');
        return {
          rows: [
            { did: 'did:plc:recent', collection: 'app.recent', rkey: 'r1', createdAt: '2026-05-09T16:15:00.000001Z' },
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
    async query() {
      operations.push('query-existing-sidecar');
      return {
        async json() {
          return { data: [] };
        },
      };
    },
    async insert(params: { table: string }) {
      operations.push(`insert:${params.table}`);
    },
  };

  const result = await runBackfill(
    {
      dryRun: false,
      limit: 1000,
      resumeFrom: null,
      batchSize: 1000,
      maxRuntimeMinutes: null,
      maxRows: null,
      rescanDays: 1,
      rescanMinutes: null,
      rescanOverlapMinutes: 10,
      confirmProduction: true,
      checkpointName: 'test',
      lockName: 'test',
      lockTtlSeconds: 60,
    },
    { pg, clickhouse },
  );

  assert.equal(result.rowsRead, 1);
  assert.equal(result.rowsInserted, 1);
  assert.deepEqual(operations, [
    'read-checkpoint',
    'read-recent-source',
    'query-existing-sidecar',
    'insert:atp_dashboard.collection_events',
    'insert:atp_dashboard.collection_count_event_existence_log',
    'insert:atp_dashboard.collection_count_ingest_queue',
    'write-checkpoint',
  ]);
});

test('rescan mode skips rows already present in sidecar existence log', async () => {
  const operations: string[] = [];
  const pg = {
    async connect() {},
    async end() {},
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('clickhouse_sync_checkpoints') && sql.includes('SELECT')) {
        operations.push('read-checkpoint');
        return { rows: [] };
      }
      if (sql.includes('FROM public.collection')) {
        return {
          rows: [
            { did: 'did:plc:existing', collection: 'app.recent', rkey: 'r1', createdAt: '2026-05-09T16:15:00.000001Z' },
            { did: 'did:plc:missing', collection: 'app.recent', rkey: 'r2', createdAt: '2026-05-09T16:16:00.000001Z' },
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
    async query<T>() {
      operations.push('query-existing-sidecar');
      const existing = buildCollectionEventDualWriteRows([
        { did: 'did:plc:existing', collection: 'app.recent', rkey: 'r1', createdAt: '2026-05-09T16:15:00.000001Z' },
      ]);
      return {
        async json() {
          return { data: [{ event_key: existing.existence[0].event_key, payload_hash: existing.existence[0].payload_hash }] as T[] };
        },
      };
    },
    async insert(params: { table: string; values: unknown[] }) {
      operations.push(`insert:${params.table}:${params.values.length}`);
    },
  };

  const result = await runBackfill(
    {
      dryRun: false,
      limit: 1000,
      resumeFrom: null,
      batchSize: 1000,
      maxRuntimeMinutes: null,
      maxRows: null,
      rescanDays: null,
      rescanMinutes: 180,
      rescanOverlapMinutes: 10,
      confirmProduction: true,
      checkpointName: 'test',
      lockName: 'test',
      lockTtlSeconds: 60,
    },
    { pg, clickhouse },
  );

  assert.equal(result.rowsRead, 2);
  assert.equal(result.rowsInserted, 1);
  assert.deepEqual(operations, [
    'read-checkpoint',
    'query-existing-sidecar',
    'insert:atp_dashboard.collection_events:1',
    'insert:atp_dashboard.collection_count_event_existence_log:1',
    'insert:atp_dashboard.collection_count_ingest_queue:1',
    'write-checkpoint',
  ]);
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
    async insert(params: { table: string; values: unknown[] }) {
      operations.push(`insert:${params.table}`);
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
    rescanDays: null,
    rescanMinutes: null,
    rescanOverlapMinutes: 10,
    confirmProduction: true,
    checkpointName: 'test',
    lockName: 'test',
    lockTtlSeconds: 60,
  };

  const result = await runBackfill(options, { pg, clickhouse });
  const insertIndex = operations.indexOf('insert:atp_dashboard.collection_count_ingest_queue');
  const checkpointIndex = operations.indexOf('write-checkpoint');

  assert.equal(result.rowsRead, 2);
  assert.equal(result.rowsInserted, 2);
  assert.equal(inserted.length, 6);
  assert.ok(insertIndex >= 0);
  assert.ok(checkpointIndex > insertIndex);
});

test('runBackfill does not checkpoint if queue write fails after raw insert', async () => {
  const operations: string[] = [];
  const pg = {
    async connect() {},
    async end() {},
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('clickhouse_sync_checkpoints') && sql.includes('SELECT')) {
        return { rows: [] };
      }
      if (sql.includes('FROM public.collection')) {
        return {
          rows: [{ did: 'did:plc:a', collection: 'app.a', rkey: 'r1', createdAt: null }] as T[],
        };
      }
      if (sql.includes('public.clickhouse_sync_checkpoints') && sql.includes('ON CONFLICT (name) DO UPDATE')) {
        operations.push('write-checkpoint');
      }
      return { rows: [{ ok: true }] as T[] };
    },
  };
  const clickhouse = {
    async insert(params: { table: string }) {
      operations.push(`insert:${params.table}`);
      if (params.table === 'atp_dashboard.collection_count_ingest_queue') {
        throw new Error('queue insert failed');
      }
    },
  };

  await assert.rejects(
    () =>
      runBackfill(
        {
          dryRun: false,
          limit: 1,
          resumeFrom: null,
          batchSize: 1,
          maxRuntimeMinutes: null,
          maxRows: null,
          rescanDays: null,
          rescanMinutes: null,
          rescanOverlapMinutes: 10,
          confirmProduction: true,
          checkpointName: 'test',
          lockName: 'test',
          lockTtlSeconds: 60,
        },
        { pg, clickhouse },
      ),
    /queue insert failed/,
  );

  assert.deepEqual(operations, [
    'insert:atp_dashboard.collection_events',
    'insert:atp_dashboard.collection_count_event_existence_log',
    'insert:atp_dashboard.collection_count_ingest_queue',
  ]);
});

test('bootstrap queue from raw inserts only existence log and queue', async () => {
  const operations: string[] = [];
  const pg = {
    async connect() {},
    async end() {},
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('clickhouse_sync_checkpoints') && sql.includes('SELECT')) {
        return { rows: [] };
      }
      return { rows: [{ ok: true }] as T[] };
    },
  };
  const clickhouse = {
    async query() {
      operations.push('query-raw');
      return {
        async json() {
          return {
            data: [
              {
                eventKey: 'event-a',
                did: 'did:plc:a',
                collection: 'app.a',
                rkey: 'r1',
                createdAt: '2026-05-09T00:00:00.000001Z',
                sourceIngestedAt: '2026-05-10 00:00:00.000',
                alreadyExists: 0,
              },
            ],
          };
        },
      };
    },
    async insert(params: { table: string }) {
      operations.push(`insert:${params.table}`);
    },
  };

  const result = await runBackfill(
    {
      dryRun: false,
      limit: 1,
      resumeFrom: null,
      batchSize: 1,
      maxRuntimeMinutes: null,
      maxRows: null,
      rescanDays: null,
      rescanMinutes: null,
      rescanOverlapMinutes: 10,
      bootstrapQueueFromRaw: true,
      confirmProduction: true,
      checkpointName: 'test',
      lockName: 'test',
      lockTtlSeconds: 60,
    },
    { pg, clickhouse },
  );

  assert.equal(result.rowsRead, 1);
  assert.equal(result.rowsInserted, 1);
  assert.deepEqual(operations, [
    'query-raw',
    'insert:atp_dashboard.collection_count_event_existence_log',
    'insert:atp_dashboard.collection_count_ingest_queue',
    'insert:atp_dashboard.collection_count_bootstrap_progress',
  ]);
});

test('bootstrap queue from raw advances progress across existing sidecar rows', async () => {
  const operations: string[] = [];
  const clickhouse = {
    async query() {
      operations.push('query-raw');
      return {
        async json() {
          return {
            data: [
              {
                eventKey: 'event-existing',
                did: 'did:plc:a',
                collection: 'app.a',
                rkey: 'r1',
                createdAt: '2026-05-09T00:00:00.000001Z',
                sourceIngestedAt: '2026-05-10 00:00:00.000',
                alreadyExists: 1,
              },
            ],
          };
        },
      };
    },
    async insert(params: { table: string }) {
      operations.push(`insert:${params.table}`);
    },
  };

  const result = await runBackfill(
    {
      dryRun: false,
      limit: 1,
      resumeFrom: null,
      batchSize: 1,
      maxRuntimeMinutes: null,
      maxRows: null,
      rescanDays: null,
      rescanMinutes: null,
      rescanOverlapMinutes: 10,
      bootstrapQueueFromRaw: true,
      confirmProduction: true,
      checkpointName: 'test',
      lockName: 'test',
      lockTtlSeconds: 60,
    },
    {
      pg: {
        async connect() {},
        async end() {},
        async query<T>(sql: string) {
          if (sql.includes('RETURNING holder')) {
            return { rows: [{ holder: 'test-holder' }] as T[] };
          }
          return { rows: [] as T[] };
        },
      },
      clickhouse,
    },
  );

  assert.equal(result.rowsRead, 1);
  assert.equal(result.rowsInserted, 0);
  assert.deepEqual(operations, ['query-raw', 'insert:atp_dashboard.collection_count_bootstrap_progress']);
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
      rescanDays: null,
      rescanMinutes: null,
      rescanOverlapMinutes: 10,
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
