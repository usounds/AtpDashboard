import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHourlyNewCollectionRollupInsertQuery,
  buildHourlyNewDidRollupInsertQuery,
  parseRefreshAnalyticsHourlyNewOptions,
  refreshAnalyticsHourlyNewRollups,
} from './refresh-analytics-hourly-new-rollups.ts';

test('requires dry-run or confirm-production', () => {
  assert.throws(() => parseRefreshAnalyticsHourlyNewOptions([]), /Refusing to refresh/);
  assert.equal(parseRefreshAnalyticsHourlyNewOptions(['--dry-run']).dryRun, true);
  assert.equal(parseRefreshAnalyticsHourlyNewOptions(['--confirm-production']).confirmProduction, true);
});

test('builds hourly new rollup inserts from first seen state tables', () => {
  const didSql = buildHourlyNewDidRollupInsertQuery();
  const collectionSql = buildHourlyNewCollectionRollupInsertQuery();

  assert.match(didSql, /INSERT INTO atp_dashboard\.analytics_hourly_new_did_rollup/);
  assert.match(didSql, /FROM atp_dashboard\.analytics_did_first_seen_state/);
  assert.match(didSql, /minMerge\(first_seen_state\) AS first_seen_at/);
  assert.match(didSql, /toUnixTimestamp\(first_seen_at\)/);
  assert.match(didSql, /intDiv\(toUnixTimestamp\(first_seen_at\), 3600\) \* 3600/);
  assert.match(collectionSql, /INSERT INTO atp_dashboard\.analytics_hourly_new_collection_rollup/);
  assert.match(collectionSql, /FROM atp_dashboard\.analytics_collection_first_seen_state/);
});

test('refresh inserts did and collection hourly new rollups', async () => {
  const operations: string[] = [];
  const client = {
    async command(params: { query: string }) {
      if (params.query.includes('analytics_hourly_new_did_rollup')) operations.push('did');
      if (params.query.includes('analytics_hourly_new_collection_rollup')) operations.push('collection');
    },
  };

  const result = await refreshAnalyticsHourlyNewRollups(client, {
    dryRun: false,
    confirmProduction: true,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(operations, ['did', 'collection']);
});
