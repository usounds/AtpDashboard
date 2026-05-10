import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEXICON_STORE_DID,
  buildDidFirstSeenSnapshotInsertQuery,
  buildRefreshQueryPlan,
  buildSnapshotInsertQuery,
  loadRefreshCollectionCountConfig,
  parseRefreshCollectionCountOptions,
  refreshCollectionCountSnapshot,
} from './refresh-collection-count-snapshot.ts';

test('requires dry-run or confirm-production', () => {
  assert.throws(() => parseRefreshCollectionCountOptions([]), /Refusing to refresh/);
  assert.equal(parseRefreshCollectionCountOptions(['--dry-run']).dryRun, true);
  assert.equal(parseRefreshCollectionCountOptions(['--', '--dry-run']).dryRun, true);
  assert.equal(parseRefreshCollectionCountOptions(['--confirm-production']).confirmProduction, true);
});

test('dry-run config does not require ClickHouse URL', () => {
  const config = loadRefreshCollectionCountConfig({}, { requireClickHouse: false });

  assert.equal(config.clickhouseUrl, 'http://localhost:8123');
  assert.equal(config.clickhouseRefreshTimeoutMs, 600000);
});

test('loads refresh timeout from env', () => {
  const config = loadRefreshCollectionCountConfig(
    {
      CLICKHOUSE_URL: 'http://example.test:8123',
      CLICKHOUSE_REFRESH_TIMEOUT_MS: '1200000',
    },
    { requireClickHouse: true },
  );

  assert.equal(config.clickhouseRefreshTimeoutMs, 1200000);
});

test('snapshot query uses PostgREST-compatible counts and excludes lexicon store', () => {
  const sql = buildSnapshotInsertQuery();

  assert.match(sql, /unique_did, unique_rkey, total_count/);
  assert.match(sql, /GROUP BY event_key/);
  assert.match(sql, /uniqExact\(did\) AS unique_did/);
  assert.match(sql, /uniqExact\(tuple\(did, collection, rkey\)\) AS unique_rkey/);
  assert.match(sql, /count\(\) AS total_count/);
  assert.match(sql, /countIf\(isNotNull\(created_at\)/);
  assert.match(sql, /minIf\(created_at_key, created_at_key != '<NULL>'\)/);
  assert.match(sql, /maxIf\(created_at_key, created_at_key != '<NULL>'\)/);
  assert.match(sql, /WHERE did != \{excluded_did:String\}/);
  assert.match(sql, /optimize_aggregation_in_order = 1/);
});

test('DID first seen snapshot query stores one first_seen row per collection DID', () => {
  const sql = buildDidFirstSeenSnapshotInsertQuery();

  assert.match(sql, /INSERT INTO atp_dashboard\.collection_did_first_seen_snapshot/);
  assert.match(sql, /min\(created_at\) AS first_seen_at/);
  assert.match(sql, /WHERE did != \{excluded_did:String\}/);
  assert.match(sql, /AND created_at_key != '<NULL>'/);
  assert.match(sql, /GROUP BY collection, did/);
});

test('query plan marks stale running, creates running manifest, inserts snapshot, then completes manifest', () => {
  const plan = buildRefreshQueryPlan({
    refreshId: '00000000-0000-4000-8000-000000000001',
    dryRun: false,
    confirmProduction: true,
    staleRunningMinutes: 30,
    recentHours: 72,
  });

  assert.match(plan.beforeSnapshot[0].query, /status = 'running'/);
  assert.equal(plan.beforeSnapshot[0].query_params.stale_running_minutes, 30);
  assert.match(plan.beforeSnapshot[1].query, /'running'/);
  assert.equal(plan.insertSnapshot.query_params.excluded_did, LEXICON_STORE_DID);
  assert.equal(plan.insertSnapshot.query_params.recent_hours, 72);
  assert.equal(plan.insertDidFirstSeenSnapshot.query_params.excluded_did, LEXICON_STORE_DID);
  assert.match(plan.completeManifest.query, /'completed'/);
});

test('refresh executes complete manifest only after snapshot inserts', async () => {
  const operations: string[] = [];
  const client = {
    async command(params: { query: string }) {
      if (params.query.includes('marked stale')) operations.push('stale');
      if (params.query.includes("VALUES\n  ({refresh_id:UUID}, 'running'")) operations.push('running');
      if (params.query.includes('INSERT INTO atp_dashboard.collection_count_snapshot')) operations.push('snapshot');
      if (params.query.includes('INSERT INTO atp_dashboard.collection_did_first_seen_snapshot')) operations.push('did_first_seen');
      if (params.query.includes('collection_count_snapshot sanity failed')) operations.push('validate');
      if (params.query.includes("'completed' AS status")) operations.push('completed');
    },
  };

  const result = await refreshCollectionCountSnapshot(client, {
    refreshId: '00000000-0000-4000-8000-000000000001',
    dryRun: false,
    confirmProduction: true,
    staleRunningMinutes: 60,
    recentHours: 72,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(operations, ['stale', 'running', 'snapshot', 'validate', 'completed']);
});

test('failed snapshot writes failed manifest and never completes', async () => {
  const operations: string[] = [];
  const client = {
    async command(params: { query: string }) {
      if (params.query.includes("'completed' AS status")) operations.push('completed');
      if (params.query.includes("VALUES\n  ({refresh_id:UUID}, 'failed'")) operations.push('failed');
      if (params.query.includes('INSERT INTO atp_dashboard.collection_count_snapshot')) {
        throw new Error('snapshot insert failed');
      }
    },
  };

  await assert.rejects(
    () =>
      refreshCollectionCountSnapshot(client, {
        refreshId: '00000000-0000-4000-8000-000000000001',
        dryRun: false,
        confirmProduction: true,
        staleRunningMinutes: 60,
        recentHours: 72,
      }),
    /snapshot insert failed/,
  );
  assert.deepEqual(operations, ['failed']);
});
