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
  assert.equal(parseRefreshAnalyticsChartOptions(['--dry-run', '--source', 'rollup']).source, 'rollup');
  assert.equal(parseRefreshAnalyticsChartOptions(['--dry-run', '--source', 'hourly']).source, 'hourly');
  assert.equal(parseRefreshAnalyticsChartOptions(['--dry-run', '--source', 'presence']).source, 'presence');
  assert.throws(() => parseRefreshAnalyticsChartOptions(['--dry-run', '--source', 'bad']), /raw.*rollup.*hourly.*presence/);
});

test('dry-run config does not require ClickHouse URL', () => {
  const config = loadRefreshAnalyticsChartConfig({}, { requireClickHouse: false });

  assert.equal(config.clickhouseUrl, 'http://localhost:8123');
  assert.equal(config.clickhouseRefreshTimeoutMs, 600000);
});

test('loads refresh timeout from env', () => {
  const config = loadRefreshAnalyticsChartConfig(
    {
      CLICKHOUSE_URL: 'http://example.test:8123',
      CLICKHOUSE_REFRESH_TIMEOUT_MS: '1200000',
    },
    { requireClickHouse: true },
  );

  assert.equal(config.clickhouseRefreshTimeoutMs, 1200000);
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
  assert.match(sql, /uniqExact\(event_key\) AS count/);
});

test('rollup snapshot query reads daily rollups instead of raw events', () => {
  const sql = buildSnapshotInsertQuery(undefined, 'rollup');

  assert.match(sql, /INSERT INTO atp_dashboard\.analytics_chart_snapshot/);
  assert.match(sql, /FROM atp_dashboard\.analytics_daily_activity_rollup/);
  assert.match(sql, /FROM atp_dashboard\.analytics_daily_collection_activity_rollup/);
  assert.match(sql, /FROM atp_dashboard\.analytics_daily_new_did_rollup/);
  assert.match(sql, /FROM atp_dashboard\.analytics_daily_new_collection_rollup/);
  assert.match(sql, /uniqExactMerge\(event_count_state\) AS count/);
  assert.match(sql, /uniqExactMerge\(active_did_state\) AS active/);
  assert.match(sql, /uniqExactMerge\(active_collection_state\) AS active/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
});

test('hourly snapshot query reads hourly rollups instead of raw events', () => {
  const sql = buildSnapshotInsertQuery(undefined, 'hourly');

  assert.match(sql, /INSERT INTO atp_dashboard\.analytics_chart_snapshot/);
  assert.match(sql, /FROM atp_dashboard\.analytics_hourly_activity_rollup/);
  assert.match(sql, /FROM atp_dashboard\.analytics_hourly_collection_activity_rollup/);
  assert.match(sql, /FROM atp_dashboard\.analytics_hourly_new_did_rollup/);
  assert.match(sql, /FROM atp_dashboard\.analytics_hourly_new_collection_rollup/);
  assert.match(sql, /toStartOfHour\(latest_at\) AS latest_hour/);
  assert.match(sql, /uniqExactMerge\(event_count_state\) AS count/);
  assert.match(sql, /uniqExactMerge\(active_did_state\) AS active/);
  assert.match(sql, /uniqExactMerge\(active_collection_state\) AS active/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
});

test('presence snapshot query avoids uniqExactMerge in scheduled source', () => {
  const sql = buildSnapshotInsertQuery(undefined, 'presence');

  assert.match(sql, /INSERT INTO atp_dashboard\.analytics_chart_snapshot/);
  assert.match(sql, /FROM atp_dashboard\.analytics_hourly_did_presence/);
  assert.match(sql, /FROM atp_dashboard\.analytics_hourly_collection_presence/);
  assert.match(sql, /FROM atp_dashboard\.analytics_hourly_event_count/);
  assert.match(sql, /FROM atp_dashboard\.analytics_hourly_new_did_rollup/);
  assert.match(sql, /GROUP BY bucket_index, did/);
  assert.match(sql, /GROUP BY bucket_index, collection/);
  assert.doesNotMatch(sql, /uniqExactMerge/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
});

test('query plan marks stale running, creates running manifest, inserts snapshot, then completes manifest', () => {
  const plan = buildRefreshQueryPlan({
    refreshId: '00000000-0000-4000-8000-000000000001',
    dryRun: false,
    confirmProduction: true,
    staleRunningMinutes: 30,
    source: 'raw',
  });

  assert.match(plan.beforeSnapshot[0].query, /status = 'running'/);
  assert.equal(plan.beforeSnapshot[0].query_params.stale_running_minutes, 30);
  assert.match(plan.beforeSnapshot[1].query, /'running'/);
  assert.equal(plan.insertSnapshots.length, 9);
  assert.deepEqual(plan.insertSnapshots.map((query) => query.target), ANALYTICS_CHART_TARGETS);
  assert.equal(plan.insertSnapshots[0].command.query_params.excluded_did, LEXICON_STORE_DID);
  assert.match(plan.insertSnapshots[0].command.query, /INSERT INTO atp_dashboard\.analytics_chart_snapshot/);
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
    source: 'raw',
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(operations, ['stale', 'running', ...Array(9).fill('snapshot'), 'completed']);
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
        source: 'raw',
      }),
    /snapshot insert failed/,
  );
  assert.deepEqual(operations, ['failed']);
});
