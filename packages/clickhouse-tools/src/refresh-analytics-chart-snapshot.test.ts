import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANALYTICS_CHART_TARGETS,
  LEXICON_STORE_DID,
  buildRefreshQueryPlan,
  buildSnapshotInsertQuery,
  loadRefreshAnalyticsChartConfig,
  parseRefreshAnalyticsChartOptions,
  refreshAnalyticsChartSnapshot,
} from './refresh-analytics-chart-snapshot.ts';

test('requires dry-run or confirm-production', () => {
  assert.throws(() => parseRefreshAnalyticsChartOptions([]), /Refusing to refresh/);
  assert.equal(parseRefreshAnalyticsChartOptions(['--dry-run']).dryRun, true);
  assert.equal(parseRefreshAnalyticsChartOptions(['--', '--dry-run']).dryRun, true);
  assert.equal(parseRefreshAnalyticsChartOptions(['--confirm-production']).confirmProduction, true);
});

test('dry-run config does not require ClickHouse URL', () => {
  const config = loadRefreshAnalyticsChartConfig({}, { requireClickHouse: false });

  assert.equal(config.clickhouseUrl, 'http://localhost:8123');
});

test('snapshot query inserts every dashboard chart target', () => {
  const sql = buildSnapshotInsertQuery();

  assert.equal(ANALYTICS_CHART_TARGETS.length, 9);
  assert.match(sql, /INSERT INTO atp_dashboard\.analytics_chart_snapshot/);
  assert.match(sql, /'daily_collections' AS tool/);
  assert.match(sql, /'daily_users' AS tool/);
  assert.match(sql, /'event_counts' AS tool/);
  assert.match(sql, /365 AS lookback_days/);
  assert.match(sql, /30 AS chart_bucket_days/);
  assert.doesNotMatch(sql, /\d+ AS bucket_days/);
  assert.match(sql, /did != \{excluded_did:String\}/);
  assert.match(sql, /count\(\) AS count/);
});

test('query plan marks stale running, creates running manifest, inserts snapshot, then completes manifest', () => {
  const plan = buildRefreshQueryPlan({
    refreshId: '00000000-0000-4000-8000-000000000001',
    dryRun: false,
    confirmProduction: true,
    staleRunningMinutes: 30,
  });

  assert.match(plan.beforeSnapshot[0].query, /status = 'running'/);
  assert.equal(plan.beforeSnapshot[0].query_params.stale_running_minutes, 30);
  assert.match(plan.beforeSnapshot[1].query, /'running'/);
  assert.equal(plan.insertSnapshot.query_params.excluded_did, LEXICON_STORE_DID);
  assert.match(plan.insertSnapshot.query, /INSERT INTO atp_dashboard\.analytics_chart_snapshot/);
  assert.match(plan.completeManifest.query, /'completed'/);
});

test('refresh executes complete manifest only after snapshot insert', async () => {
  const operations: string[] = [];
  const client = {
    async command(params: { query: string }) {
      if (params.query.includes('marked stale')) operations.push('stale');
      if (params.query.includes("VALUES\n  ({refresh_id:UUID}, 'running'")) operations.push('running');
      if (params.query.includes('INSERT INTO atp_dashboard.analytics_chart_snapshot')) operations.push('snapshot');
      if (params.query.includes("'completed' AS status")) operations.push('completed');
    },
  };

  const result = await refreshAnalyticsChartSnapshot(client, {
    refreshId: '00000000-0000-4000-8000-000000000001',
    dryRun: false,
    confirmProduction: true,
    staleRunningMinutes: 60,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(operations, ['stale', 'running', 'snapshot', 'completed']);
});

test('failed snapshot writes failed manifest and never completes', async () => {
  const operations: string[] = [];
  const client = {
    async command(params: { query: string }) {
      if (params.query.includes("'completed' AS status")) operations.push('completed');
      if (params.query.includes("VALUES\n  ({refresh_id:UUID}, 'failed'")) operations.push('failed');
      if (params.query.includes('INSERT INTO atp_dashboard.analytics_chart_snapshot')) {
        throw new Error('snapshot insert failed');
      }
    },
  };

  await assert.rejects(
    () =>
      refreshAnalyticsChartSnapshot(client, {
        refreshId: '00000000-0000-4000-8000-000000000001',
        dryRun: false,
        confirmProduction: true,
        staleRunningMinutes: 60,
      }),
    /snapshot insert failed/,
  );
  assert.deepEqual(operations, ['failed']);
});
