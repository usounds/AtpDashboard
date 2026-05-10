import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDidPresenceInsertQuery,
  buildEventKeyPresenceInsertQuery,
  buildHourlyEventCountInsertQuery,
  buildPresenceRunStartQuery,
  buildPresenceWatermarkCommitQuery,
  buildShadowSnapshotInsertQueries,
  parseRefreshAnalyticsPresencePipelineOptions,
  refreshAnalyticsPresencePipeline,
} from './refresh-analytics-presence-pipeline.ts';

test('requires dry-run or confirm-production', () => {
  assert.throws(() => parseRefreshAnalyticsPresencePipelineOptions([]), /Refusing to refresh/);
  assert.equal(parseRefreshAnalyticsPresencePipelineOptions(['--dry-run']).dryRun, true);
  assert.equal(parseRefreshAnalyticsPresencePipelineOptions(['--confirm-production']).confirmProduction, true);
  assert.equal(parseRefreshAnalyticsPresencePipelineOptions(['--dry-run', '--backfill-days', '400']).backfillDays, 400);
});

test('presence pipeline queries use ingested watermark and avoid uniqExactMerge', () => {
  const sql = [
    buildPresenceRunStartQuery(),
    buildDidPresenceInsertQuery(),
    buildEventKeyPresenceInsertQuery(),
    buildHourlyEventCountInsertQuery(),
    ...buildShadowSnapshotInsertQueries(),
    buildPresenceWatermarkCommitQuery(),
  ].join('\n');

  assert.match(sql, /cutoff_ingested_at/);
  assert.match(sql, /ingested_at <=/);
  assert.match(sql, /FROM atp_dashboard\.analytics_presence_event_source/);
  assert.match(sql, /name = 'event_source_backfill' AND run_id = \{run_id:UUID\}/);
  assert.match(sql, /GROUP BY hour, did/);
  assert.match(sql, /GROUP BY hour, event_key/);
  assert.match(sql, /INSERT INTO atp_dashboard\.analytics_presence_watermarks/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
  assert.doesNotMatch(sql, /uniqExactMerge/);
});

test('presence pipeline commits watermark after snapshot build commands', async () => {
  const operations: string[] = [];
  const client = {
    async command(params: { query: string }) {
      if (params.query.includes('analytics_presence_run_status') && params.query.includes("'running'")) operations.push('run');
      if (params.query.includes('analytics_hourly_did_presence')) operations.push('did_presence');
      if (params.query.includes('analytics_chart_snapshot_shadow')) operations.push('shadow');
      if (params.query.includes('analytics_chart_bucket_values')) operations.push('bucket_values');
      if (params.query.includes('INSERT INTO atp_dashboard.analytics_presence_watermarks')) operations.push('watermark');
    },
  };

  const result = await refreshAnalyticsPresencePipeline(client, {
    runId: '00000000-0000-4000-8000-000000000010',
    dryRun: false,
    confirmProduction: true,
    backfillDays: 370,
    safetyLagSeconds: 300,
  });

  assert.equal(result.status, 'completed');
  assert.equal(operations[0], 'run');
  assert(operations.indexOf('watermark') > operations.indexOf('bucket_values'));
  assert(operations.includes('shadow'));
});
