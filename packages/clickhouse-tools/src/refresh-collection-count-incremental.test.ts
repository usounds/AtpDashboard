import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCanonicalStageInsertQuery,
  buildCollectionDeltaInsertQuery,
  buildCompletedManifestInsertQuery,
  buildCumulativeUsersReadQuery,
  buildCumulativeUsersSnapshotInsertQuery,
  buildCrossRunConflictInsertQuery,
  buildCurrentStageAffectedCollectionsInsertQuery,
  buildCurrentStageDidKeysInsertQuery,
  buildCurrentStageHourKeysInsertQuery,
  buildCurrentStageRkeyKeysInsertQuery,
  buildDidDeltaInsertQuery,
  buildDidFirstSeenDeltaInsertQuery,
  buildDidFirstSeenStateInsertQuery,
  buildDidSeenStateExplainQuery,
  buildDidSeenStateInsertQuery,
  buildDescendantInvalidationQuery,
  buildEventSeenLogInsertQuery,
  buildFailedManifestInsertQuery,
  buildInvalidateRefreshQuery,
  buildLinearCommitGuardQuery,
  buildManifestReadbackQuery,
  buildOrphanInsertQuery,
  buildPublishValidationQuery,
  buildRawCandidateStageInsertQuery,
  buildRecentHourlyDeltaInsertQuery,
  buildRecentHourlyStateExplainQuery,
  buildRecentHourlyStateInsertQuery,
  buildRefreshCollectionCountIncrementalPlan,
  buildReserveRunQuery,
  buildRkeyDeltaInsertQuery,
  buildRkeySeenStateExplainQuery,
  buildRkeySeenStateInsertQuery,
  buildRunSnapshotWrittenQuery,
  buildSameRunConflictInsertQuery,
  buildSnapshotPublishInsertQuery,
  parseRefreshCollectionCountIncrementalOptions,
  refreshCollectionCountIncremental,
} from './refresh-collection-count-incremental.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ddl = readFileSync(resolve(here, '../../../sql/clickhouse/007_collection_count_incremental.sql'), 'utf8');
const rootPackageJson = readFileSync(resolve(here, '../../../package.json'), 'utf8');
const toolsPackageJson = readFileSync(resolve(here, '../package.json'), 'utf8');
const incrementalService = readFileSync(resolve(here, '../CollectionCountIncrementalRefresh.service'), 'utf8');
const incrementalTimer = readFileSync(resolve(here, '../CollectionCountIncrementalRefresh.timer'), 'utf8');
const legacyReadModelService = readFileSync(resolve(here, '../CollectionCountReadModelRefresh.service'), 'utf8');
const legacyReadModelTimer = readFileSync(resolve(here, '../CollectionCountReadModelRefresh.timer'), 'utf8');
const legacySnapshotService = readFileSync(resolve(here, '../CollectionCountRefresh.service'), 'utf8');
const legacySnapshotTimer = readFileSync(resolve(here, '../CollectionCountRefresh.timer'), 'utf8');
const executableDdl = ddl
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

test('incremental collection count DDL is pre-cutover additive', () => {
  assert.doesNotMatch(executableDdl, /\bRENAME\b/i);
  assert.doesNotMatch(executableDdl, /\bDROP\b/i);
  assert.doesNotMatch(executableDdl, /\bEXCHANGE\b/i);
  assert.doesNotMatch(executableDdl, /CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+IF\s+NOT\s+EXISTS\s+atp_dashboard\.collection_count_refresh_manifest\b/i);
  assert.match(ddl, /collection_count_refresh_manifest_v2_compatibility_preview/);
});

test('incremental DDL creates required queue, stage, state, and manifest artifacts', () => {
  for (const table of [
    'collection_count_refresh_manifest_v2',
    'collection_count_incremental_runs',
    'collection_count_ingest_queue',
    'collection_count_event_existence_log',
    'collection_count_event_raw_candidate_stage',
    'collection_count_event_stage',
    'collection_count_event_seen_log',
    'collection_count_event_conflicts',
    'collection_count_queue_orphans',
    'collection_count_collection_delta',
    'collection_count_did_delta',
    'collection_count_rkey_delta',
    'collection_count_did_first_seen_delta',
    'collection_count_recent_hourly_delta',
    'collection_count_did_seen_state',
    'collection_count_rkey_seen_state',
    'collection_count_did_first_seen_state',
    'collection_count_recent_hourly_state',
    'collection_count_cumulative_users_snapshot',
    'current_stage_did_keys',
    'current_stage_rkey_keys',
    'current_stage_affected_collections',
    'current_stage_hour_keys',
  ]) {
    assert.match(ddl, new RegExp(`CREATE (?:TABLE|VIEW) IF NOT EXISTS atp_dashboard\\.${table}\\b`));
  }
});

test('manifest v2 validity gates are explicit and append-only', () => {
  assert.match(ddl, /ENGINE = MergeTree\s+ORDER BY \(refresh_id, status_version, updated_at\)/);
  assert.doesNotMatch(ddl, /collection_count_refresh_manifest_v2[\s\S]*?ReplacingMergeTree/);

  for (const column of [
    'run_id Nullable(UUID)',
    'previous_refresh_id Nullable(UUID)',
    "watermark_queued_at Nullable(DateTime64(3, 'UTC'))",
    'watermark_event_key Nullable(String)',
    "watermark_queue_seq String DEFAULT ''",
    "cutoff_queued_at Nullable(DateTime64(3, 'UTC'))",
    'cutoff_event_key Nullable(String)',
    "cutoff_queue_seq String DEFAULT ''",
    "snapshot_anchor_at Nullable(DateTime64(3, 'UTC'))",
    'source_rows UInt64 DEFAULT 0',
    'stage_rows UInt64 DEFAULT 0',
    'event_seen_row_count UInt64 DEFAULT 0',
    'event_conflict_row_count UInt64 DEFAULT 0',
    'first_seen_row_count UInt64 DEFAULT 0',
    'did_seen_row_count UInt64 DEFAULT 0',
    'rkey_seen_row_count UInt64 DEFAULT 0',
    'hourly_row_count UInt64 DEFAULT 0',
    'snapshot_written UInt8 DEFAULT 0',
    'event_seen_written UInt8 DEFAULT 0',
    'event_conflict_written UInt8 DEFAULT 0',
    'first_seen_written UInt8 DEFAULT 0',
    'did_seen_written UInt8 DEFAULT 0',
    'rkey_seen_written UInt8 DEFAULT 0',
    'hourly_written UInt8 DEFAULT 0',
    'cumulative_users_written UInt8 DEFAULT 0',
    'validation_passed UInt8 DEFAULT 0',
    'queue_backfill_generation UInt64 DEFAULT 0',
    'status_version UInt64 DEFAULT 0',
    "invalidated_at Nullable(DateTime64(3, 'UTC'))",
    'invalidated_reason Nullable(String)',
    'is_bootstrap_seed UInt8 DEFAULT 0',
  ]) {
    assert(ddl.includes(column), `DDL missing column: ${column}`);
  }

  for (const gate of [
    "latest_status = 'completed'",
    'latest_completed_at IS NOT NULL',
    'invalidated_at IS NULL',
    'is_bootstrap_seed = 0',
    'latest_run_id IS NOT NULL',
    'snapshot_anchor_at IS NOT NULL',
    'cutoff_queued_at IS NOT NULL',
    'cutoff_event_key IS NOT NULL',
    "cutoff_queue_seq != ''",
    'snapshot_written = 1',
    'event_seen_written = 1',
    'event_conflict_written = 1',
    'first_seen_written = 1',
    'did_seen_written = 1',
    'rkey_seen_written = 1',
    'hourly_written = 1',
    'cumulative_users_written = 1',
    'validation_passed = 1',
  ]) {
    assert.match(ddl, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('queue and candidate stages preserve physical queue row ordering', () => {
  assert.match(ddl, /collection_count_ingest_queue[\s\S]*?queue_seq String[\s\S]*?payload_hash UInt64[\s\S]*?ORDER BY \(queued_at, event_key, queue_seq\)/);
  assert.match(
    ddl,
    /collection_count_event_raw_candidate_stage[\s\S]*?queued_at DateTime64\(3, 'UTC'\)[\s\S]*?queue_seq String[\s\S]*?payload_hash UInt64[\s\S]*?ORDER BY \(run_id, queued_at, event_key, queue_seq\)/,
  );
  assert.match(ddl, /collection_count_event_stage[\s\S]*?ORDER BY \(run_id, event_key\)/);
});

test('state tables use bounded probe friendly order keys', () => {
  assert.match(ddl, /collection_count_did_seen_state[\s\S]*?ORDER BY \(collection, did, refresh_id\)/);
  assert.match(ddl, /collection_count_rkey_seen_state[\s\S]*?ORDER BY \(collection, did, rkey, refresh_id\)/);
  assert.match(ddl, /collection_count_did_first_seen_state[\s\S]*?ORDER BY \(collection, did, first_seen_at, refresh_id\)/);
  assert.match(ddl, /collection_count_recent_hourly_state[\s\S]*?SummingMergeTree\(event_count\)[\s\S]*?ORDER BY \(created_hour, collection, refresh_id\)/);
  assert.match(ddl, /current_stage_did_keys[\s\S]*?ORDER BY \(run_id, collection, did\)/);
  assert.match(ddl, /current_stage_rkey_keys[\s\S]*?ORDER BY \(run_id, collection, did, rkey\)/);
  assert.match(ddl, /current_stage_affected_collections[\s\S]*?ORDER BY \(run_id, collection\)/);
  assert.match(ddl, /current_stage_hour_keys[\s\S]*?ORDER BY \(run_id, created_hour, collection\)/);
});

test('incremental refresh options require dry-run or production confirmation', () => {
  assert.throws(() => parseRefreshCollectionCountIncrementalOptions([]), /Refusing to refresh/);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run']).dryRun, true);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--confirm-production']).confirmProduction, true);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--safety-lag-seconds', '60']).safetyLagSeconds, 60);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--max-rows', '100']).maxRows, 100);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--max-queued-at-span-seconds', '30']).maxQueuedAtSpanSeconds, 30);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--max-estimated-bytes', '1024']).maxEstimatedBytes, 1024);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--skip-orphan-check']).skipOrphanCheck, true);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--max-slice-rows', '999']).maxSliceRows, 999);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--max-rows', '100']).maxSliceRows, 400);
  assert.equal(parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--retention-mode', 'safe-disabled']).retentionMode, 'safe-disabled');
  assert.throws(() => parseRefreshCollectionCountIncrementalOptions(['--dry-run', '--retention-mode', 'cleanup']), /supports only safe-disabled/);
});

test('reserve run query uses compound queue cursor, safety lag, and batch limits', () => {
  const sql = buildReserveRunQuery();

  assert.match(sql, /valid_completed_all/);
  assert.match(sql, /latest_valid_completed/);
  assert.match(sql, /\(q\.queued_at, q\.event_key, q\.queue_seq\) > \(w\.watermark_queued_at, w\.watermark_event_key, w\.watermark_queue_seq\)/);
  assert.match(sql, /q\.queued_at <= now64\(3, 'UTC'\) - toIntervalSecond\(\{safety_lag_seconds:UInt32\}\)/);
  assert.match(sql, /ORDER BY q\.queued_at ASC, q\.event_key ASC, q\.queue_seq ASC/);
  assert.match(sql, /LIMIT \{slice_limit:UInt64\}/);
  assert.match(sql, /first_candidate AS/);
  assert.match(sql, /GROUP BY event_key, payload_hash/);
  assert.match(sql, /argMin\(tuple\(queued_at, queue_seq\), tuple\(queued_at, queue_seq\)\)/);
  assert.match(sql, /q\.queued_at <= f\.first_queued_at \+ toIntervalSecond\(\{max_queued_at_span_seconds:UInt32\}\)/);
  assert.match(sql, /selected_run AS/);
  assert.match(sql, /c\.source_rows = 0/);
  assert.match(sql, /w\.previous_refresh_id IS NOT NULL/);
  assert.match(sql, /w\.watermark_queue_seq AS cutoff_queue_seq/);
  assert.match(sql, /LIMIT \{max_rows:UInt64\}/);
  assert.match(sql, /c\.source_rows \* 256 <= \{max_estimated_bytes:UInt64\}/);
  assert.doesNotMatch(sql, /source_ingested_at\s*>/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
});

test('raw candidate stage reads only queue with compound cutoff and excludes lexicon store', () => {
  const sql = buildRawCandidateStageInsertQuery();

  assert.match(sql, /FROM atp_dashboard\.collection_count_ingest_queue AS q/);
  assert.match(sql, /\(q\.queued_at, q\.event_key, q\.queue_seq\) > \(r\.watermark_queued_at, r\.watermark_event_key, r\.watermark_queue_seq\)/);
  assert.match(sql, /\(q\.queued_at, q\.event_key, q\.queue_seq\) <= \(r\.cutoff_queued_at, r\.cutoff_event_key, r\.cutoff_queue_seq\)/);
  assert.match(sql, /q\.did != \{excluded_did:String\}/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
});

test('orphan detection uses existence log and fails before canonical staging', async () => {
  assert.match(buildOrphanInsertQuery(), /e\.event_key = ''/);
  assert.doesNotMatch(buildOrphanInsertQuery(), /e\.event_key IS NULL/);

  const operations: string[] = [];
  const client = {
    async command(params: { query: string }) {
      if (params.query.includes("'failed' AS status")) operations.push('failed');
      else if (params.query.includes('INSERT INTO atp_dashboard.collection_count_incremental_runs')) operations.push('running');
      else if (params.query.includes('INSERT INTO atp_dashboard.collection_count_event_raw_candidate_stage')) operations.push('raw-stage');
      else if (params.query.includes('INSERT INTO atp_dashboard.collection_count_queue_orphans')) operations.push('orphans');
      else if (params.query.includes('INSERT INTO atp_dashboard.collection_count_event_stage')) operations.push('canonical');
    },
    async query() {
      return {
        async json() {
          return { data: [{ orphan_count: '2' }] };
        },
      };
    },
  };

  await assert.rejects(
    () =>
      refreshCollectionCountIncremental(client, {
        runId: '00000000-0000-4000-8000-000000000101',
        refreshId: '00000000-0000-4000-8000-000000000102',
        dryRun: false,
        confirmProduction: true,
        safetyLagSeconds: 300,
        maxRows: 10,
        maxQueuedAtSpanSeconds: 60,
        maxEstimatedBytes: 1024 * 1024,
        excludedDid: 'did:web:lexicon.store',
        skipOrphanCheck: false,
      }),
    /orphan queue rows detected: 2/,
  );
  assert.deepEqual(operations, ['running', 'raw-stage', 'orphans', 'failed']);
});

test('conflict and canonical queries detect conflicts before collapse and use first-completed-wins', () => {
  const sameRun = buildSameRunConflictInsertQuery();
  const crossRun = buildCrossRunConflictInsertQuery();
  const canonical = buildCanonicalStageInsertQuery();

  assert.match(sameRun, /HAVING uniqExact\(tuple\(collection, did, rkey, created_at_key/);
  assert.match(crossRun, /valid_completed_all/);
  assert.match(crossRun, /FROM atp_dashboard\.collection_count_event_seen_log AS s/);
  assert.match(crossRun, /argMin\(\s*tuple\(\s*s\.payload_hash/);
  assert.match(crossRun, /tuple\(v\.latest_completed_at, v\.cutoff_queued_at, v\.cutoff_event_key, v\.cutoff_queue_seq, s\.refresh_id\)/);
  assert.match(crossRun, /tuple\(c\.collection, c\.did, c\.rkey, c\.created_at_key/);
  assert.match(canonical, /blocked AS/);
  assert.match(canonical, /collection_count_queue_orphans/);
  assert.match(canonical, /collection_count_event_conflicts/);
  assert.match(canonical, /argMin\(tuple\(collection, did, rkey, created_at/);
  assert.doesNotMatch(canonical, /FROM atp_dashboard\.collection_events/);
});

test('incremental query plan stages, checks orphans, records conflicts, then canonicalizes', () => {
  const plan = buildRefreshCollectionCountIncrementalPlan({
    runId: '00000000-0000-4000-8000-000000000201',
    refreshId: '00000000-0000-4000-8000-000000000202',
    dryRun: false,
    confirmProduction: true,
    safetyLagSeconds: 120,
    maxRows: 42,
    maxQueuedAtSpanSeconds: 60,
    maxEstimatedBytes: 100000,
    excludedDid: 'did:web:lexicon.store',
    skipOrphanCheck: false,
  });

  assert.equal(plan.beforeOrphanCheck.length, 3);
  assert.equal(plan.afterOrphanCheck.length, 23);
  assert.match(plan.beforeOrphanCheck[0].query, /collection_count_incremental_runs/);
  assert.match(plan.beforeOrphanCheck[0].query, /collection_count_incremental_catchup/);
  assert.match(plan.beforeOrphanCheck[1].query, /collection_count_event_raw_candidate_stage/);
  assert.match(plan.beforeOrphanCheck[1].query, /collection_count_incremental_catchup/);
  assert.match(plan.beforeOrphanCheck[2].query, /collection_count_queue_orphans/);
  assert.match(plan.afterOrphanCheck[0].query, /collection_count_event_conflicts/);
  assert.match(plan.afterOrphanCheck[1].query, /existing_seen/);
  assert.match(plan.afterOrphanCheck[2].query, /collection_count_event_stage/);
  assert.equal(plan.beforeOrphanCheck[0].query_params.max_rows, 42);
  assert.equal(plan.beforeOrphanCheck[0].query_params.slice_limit, 42 * 4);
  assert.equal(plan.beforeOrphanCheck[0].query_params.safety_lag_seconds, 120);
});

test('query plan can skip per-run orphan detection for normal timer refreshes', async () => {
  const plan = buildRefreshCollectionCountIncrementalPlan({
    runId: '00000000-0000-4000-8000-000000000211',
    refreshId: '00000000-0000-4000-8000-000000000212',
    dryRun: false,
    confirmProduction: true,
    safetyLagSeconds: 120,
    maxRows: 42,
    maxQueuedAtSpanSeconds: 60,
    maxEstimatedBytes: 100000,
    excludedDid: 'did:web:lexicon.store',
    skipOrphanCheck: true,
  });

  assert.equal(plan.beforeOrphanCheck.length, 2);
  assert.doesNotMatch(plan.beforeOrphanCheck.map((command) => command.query).join('\n'), /collection_count_queue_orphans/);

  let readCountCalled = false;
  const client = {
    async command() {},
    async query() {
      readCountCalled = true;
      return {
        async json() {
          return { data: [{ orphan_count: '2' }] };
        },
      };
    },
  };

  await refreshCollectionCountIncremental(client, {
    runId: '00000000-0000-4000-8000-000000000213',
    refreshId: '00000000-0000-4000-8000-000000000214',
    dryRun: false,
    confirmProduction: true,
    safetyLagSeconds: 300,
    maxRows: 10,
    maxQueuedAtSpanSeconds: 60,
    maxEstimatedBytes: 1024 * 1024,
    excludedDid: 'did:web:lexicon.store',
    skipOrphanCheck: true,
  });
  assert.equal(readCountCalled, false);
});

test('current-stage key and delta queries stay run-scoped and avoid raw collection_events', () => {
  const queries = [
    buildCurrentStageDidKeysInsertQuery(),
    buildCurrentStageRkeyKeysInsertQuery(),
    buildCurrentStageAffectedCollectionsInsertQuery(),
    buildCurrentStageHourKeysInsertQuery(),
    buildEventSeenLogInsertQuery(),
    buildCollectionDeltaInsertQuery(),
    buildDidDeltaInsertQuery(),
    buildRkeyDeltaInsertQuery(),
    buildDidFirstSeenDeltaInsertQuery(),
    buildRecentHourlyDeltaInsertQuery(),
  ];

  for (const sql of queries) {
    assert.match(sql, /run_id = \{run_id:UUID\}/);
    assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
  }

  assert.match(buildDidDeltaInsertQuery(), /INNER JOIN valid_completed_all AS v USING \(refresh_id\)/);
  assert.match(buildDidDeltaInsertQuery(), /current_stage_did_keys/);
  assert.match(buildDidDeltaInsertQuery(), /v\.did = ''/);
  assert.doesNotMatch(buildDidDeltaInsertQuery(), /v\.did IS NULL/);
  assert.match(buildRkeyDeltaInsertQuery(), /INNER JOIN valid_completed_all AS v USING \(refresh_id\)/);
  assert.match(buildRkeyDeltaInsertQuery(), /current_stage_rkey_keys/);
  assert.match(buildRkeyDeltaInsertQuery(), /v\.rkey = ''/);
  assert.doesNotMatch(buildRkeyDeltaInsertQuery(), /v\.rkey IS NULL/);
  assert.match(buildDidFirstSeenDeltaInsertQuery(), /created_at IS NOT NULL/);
  assert.match(buildDidFirstSeenDeltaInsertQuery(), /v\.did = ''/);
  assert.match(buildRecentHourlyDeltaInsertQuery(), /created_at IS NOT NULL/);
  assert.match(buildRecentHourlyDeltaInsertQuery(), /created_hour IS NOT NULL/);
});

test('state publish queries write only current refresh artifacts from deltas', () => {
  const didState = buildDidSeenStateInsertQuery();
  const rkeyState = buildRkeySeenStateInsertQuery();
  const firstSeenState = buildDidFirstSeenStateInsertQuery();
  const hourlyState = buildRecentHourlyStateInsertQuery();

  for (const sql of [didState, rkeyState, firstSeenState, hourlyState]) {
    assert.match(sql, /\{refresh_id:UUID\} AS refresh_id/);
    assert.match(sql, /WHERE .*run_id = \{run_id:UUID\}/s);
    assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
    assert.doesNotMatch(sql, /WHERE status = 'completed'/);
  }

  assert.match(didState, /FROM atp_dashboard\.collection_count_did_delta AS d/);
  assert.match(rkeyState, /FROM atp_dashboard\.collection_count_rkey_delta/);
  assert.match(firstSeenState, /FROM atp_dashboard\.collection_count_did_first_seen_delta/);
  assert.match(hourlyState, /FROM atp_dashboard\.collection_count_recent_hourly_delta/);
});

test('snapshot publish uses latest valid snapshot plus current deltas and bounded recent state', () => {
  const sql = buildSnapshotPublishInsertQuery();

  assert.match(sql, /valid_completed_all/);
  assert.match(sql, /latest_valid_completed AS/);
  assert.match(sql, /FROM atp_dashboard\.collection_count_snapshot AS s/);
  assert.match(sql, /collection_count_collection_delta/);
  assert.match(sql, /collection_count_did_delta/);
  assert.match(sql, /collection_count_rkey_delta/);
  assert.match(sql, /collection_count_recent_hourly_state AS h/);
  assert.match(sql, /INNER JOIN valid_completed_all AS v USING \(refresh_id\)/);
  assert.match(sql, /h\.created_hour >= a\.anchor_hour - toIntervalHour\(72\)/);
  assert.match(sql, /current_stage_affected_collections/);
  assert.match(sql, /previous_snapshot WHERE recent_count > 0/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
  assert.doesNotMatch(sql, /WHERE status = 'completed'/);
});

test('publish validation and explain queries are bounded and use valid_completed_all', () => {
  const validation = buildPublishValidationQuery();
  const didExplain = buildDidSeenStateExplainQuery();
  const rkeyExplain = buildRkeySeenStateExplainQuery();
  const hourlyExplain = buildRecentHourlyStateExplainQuery();

  assert.match(validation, /collection_count_snapshot/);
  assert.match(validation, /collection_count_did_seen_state/);
  assert.match(validation, /collection_count_rkey_seen_state/);
  assert.match(validation, /collection_count_recent_hourly_state/);
  assert.match(validation, /collection_count_cumulative_users_snapshot/);
  assert.match(validation, /max_rows_per_collection FROM cumulative_collection_rows\) > 365/);
  assert.match(validation, /future_rows/);
  assert.match(validation, /throwIf/);

  for (const sql of [didExplain, rkeyExplain, hourlyExplain]) {
    assert.match(sql, /EXPLAIN indexes=1/);
    assert.match(sql, /valid_completed_all/);
    assert.match(sql, /INNER JOIN valid_completed_all AS v USING \(refresh_id\)/);
    assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
    assert.doesNotMatch(sql, /WHERE status = 'completed'/);
  }

  assert.match(didExplain, /current_stage_did_keys/);
  assert.match(rkeyExplain, /current_stage_rkey_keys/);
  assert.match(hourlyExplain, /current_stage_hour_keys/);
  assert.match(hourlyExplain, /h\.created_hour >= toStartOfHour/);
});

test('cumulative users publish regenerates affected collections and copies forward unaffected daily artifacts', () => {
  const sql = buildCumulativeUsersSnapshotInsertQuery();

  assert.match(sql, /INSERT INTO atp_dashboard\.collection_count_cumulative_users_snapshot/);
  assert.match(sql, /range\(365\)/);
  assert.match(sql, /collection_count_did_first_seen_delta/);
  assert.match(sql, /previous_daily/);
  assert.match(sql, /toDate\(v\.snapshot_anchor_at\) < a\.anchor_day/);
  assert.match(sql, /INNER JOIN valid_completed_all AS v USING \(refresh_id\)/);
  assert.match(sql, /s\.collection IN \(SELECT collection FROM cumulative_affected_collections\)/);
  assert.match(sql, /WHERE p\.collection NOT IN \(SELECT collection FROM cumulative_affected_collections\)/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
  assert.doesNotMatch(sql, /WHERE status = 'completed'/);
});

test('cumulative users read path is selected-collection bounded to latest valid daily artifact', () => {
  const sql = buildCumulativeUsersReadQuery();

  assert.match(sql, /latest_valid_completed/);
  assert.match(sql, /FROM atp_dashboard\.collection_count_cumulative_users_snapshot/);
  assert.match(sql, /collection = \{collection:String\}/);
  assert.match(sql, /LIMIT 365/);
  assert.doesNotMatch(sql, /collection_count_did_first_seen_state/);
  assert.doesNotMatch(sql, /FROM atp_dashboard\.collection_events/);
});

test('query plan publishes artifacts then commits completed manifest last', () => {
  const plan = buildRefreshCollectionCountIncrementalPlan({
    runId: '00000000-0000-4000-8000-000000000301',
    refreshId: '00000000-0000-4000-8000-000000000302',
    dryRun: false,
    confirmProduction: true,
    safetyLagSeconds: 120,
    maxRows: 42,
    maxQueuedAtSpanSeconds: 60,
    maxEstimatedBytes: 100000,
    excludedDid: 'did:web:lexicon.store',
    skipOrphanCheck: false,
  });
  const afterSql = plan.afterOrphanCheck.map((command) => command.query).join('\n');

  assert.match(afterSql, /collection_count_event_seen_log/);
  assert.match(afterSql, /collection_count_collection_delta/);
  assert.match(afterSql, /collection_count_did_seen_state/);
  assert.match(afterSql, /collection_count_rkey_seen_state/);
  assert.match(afterSql, /collection_count_did_first_seen_state/);
  assert.match(afterSql, /collection_count_recent_hourly_state/);
  assert.match(afterSql, /INSERT INTO atp_dashboard\.collection_count_snapshot/);
  assert.match(afterSql, /'snapshot_written' AS status/);
  assert.match(afterSql, /collection_count_cumulative_users_snapshot/);
  assert.match(afterSql, /collection_count_refresh_manifest_v2/);
  assert.match(afterSql, /'completed' AS status/);
  assert.match(afterSql, /linear_commit_guard/);
  assert.equal(plan.afterOrphanCheck.length, 23);
  assert.match(plan.afterOrphanCheck.at(-2)?.query ?? '', /linear_commit_guard/);
  assert.match(plan.afterOrphanCheck.at(-1)?.query ?? '', /INSERT INTO atp_dashboard\.collection_count_refresh_manifest_v2/);
  assert.match(plan.afterOrphanCheck.at(-1)?.query ?? '', /'completed' AS status/);
});

test('completed manifest commit is last and carries all visibility markers', () => {
  const completed = buildCompletedManifestInsertQuery();
  const guard = buildLinearCommitGuardQuery();
  const readback = buildManifestReadbackQuery();

  assert.match(guard, /latest_valid_completed/);
  assert.match(guard, /throwIf/);
  assert.match(guard, /r\.previous_refresh_id IS NULL/);
  assert.match(guard, /latest completed moved/);

  assert.match(completed, /INSERT INTO atp_dashboard\.collection_count_refresh_manifest_v2/);
  assert.match(completed, /'completed' AS status/);
  assert.match(completed, /r\.status = 'snapshot_written'/);
  assert.match(completed, /greatest\(toUInt64\(30\)/);
  assert.match(completed, /snapshot_written/);
  assert.match(completed, /event_seen_written/);
  assert.match(completed, /event_conflict_written/);
  assert.match(completed, /first_seen_written/);
  assert.match(completed, /did_seen_written/);
  assert.match(completed, /rkey_seen_written/);
  assert.match(completed, /hourly_written/);
  assert.match(completed, /cumulative_users_written/);
  assert.match(completed, /validation_passed/);
  assert.match(completed, /NOT EXISTS \(\s*SELECT 1\s*FROM existing_manifest\s*WHERE latest_status = 'completed'/);
  assert.doesNotMatch(completed, /WHERE status = 'completed' ORDER BY completed_at/);
  assert.doesNotMatch(completed, /\bFINAL\b/);

  assert.match(readback, /argMax\(status, tuple\(updated_at, status_version\)\)/);
  assert.doesNotMatch(readback, /\bFINAL\b/);
});

test('failed manifest and bootstrap seed use status-version rules without overriding completed', () => {
  const failed = buildFailedManifestInsertQuery();
  const bootstrap = buildCompletedManifestInsertQuery({ bootstrapSeed: true });

  assert.match(failed, /'failed' AS status/);
  assert.match(failed, /greatest\(toUInt64\(90\)/);
  assert.match(failed, /WHERE latest_status = 'completed'/);
  assert.doesNotMatch(failed, /\bFINAL\b/);

  assert.match(bootstrap, /'completed' AS status/);
  assert.match(bootstrap, /1 AS is_bootstrap_seed/);
  assert.match(bootstrap, /greatest\(toUInt64\(30\)/);
});

test('invalidation queries append higher status versions and include descendants', () => {
  const invalidate = buildInvalidateRefreshQuery();
  const descendants = buildDescendantInvalidationQuery();

  assert.match(invalidate, /argMax\(status, tuple\(updated_at, status_version\)\)/);
  assert.match(invalidate, /max_status_version \+ 1 AS status_version/);
  assert.match(invalidate, /now64\(3, 'UTC'\) AS invalidated_at/);
  assert.match(invalidate, /\{invalidated_reason:String\} AS invalidated_reason/);
  assert.doesNotMatch(invalidate, /\bFINAL\b/);

  assert.match(descendants, /WITH RECURSIVE/);
  assert.match(descendants, /INNER JOIN descendants AS d ON l\.previous_refresh_id = d\.refresh_id/);
  assert.match(descendants, /max_status_version \+ 1 AS status_version/);
  assert.match(descendants, /WHERE l\.invalidated_at IS NULL/);
  assert.doesNotMatch(descendants, /\bFINAL\b/);
});

test('incremental systemd unit is isolated and uses the shared lock', () => {
  assert.match(incrementalService, /Description=AtpDashboard ClickHouse incremental collection_count refresh/);
  assert.match(incrementalService, /WorkingDirectory=\/srv\/AtpDashboard\/packages\/clickhouse-tools/);
  assert.match(incrementalService, /\/usr\/bin\/flock -n \/run\/atpdashboard-collection-count-incremental\.lock/);
  assert.match(incrementalService, /pnpm refresh:collection-count-incremental -- --confirm-production/);
  assert.match(incrementalService, /--safety-lag-seconds 300/);
  assert.match(incrementalService, /Environment=INCREMENTAL_MAX_ROWS=500000/);
  assert.match(incrementalService, /--max-rows "\$INCREMENTAL_MAX_ROWS"/);
  assert.match(incrementalService, /Environment=INCREMENTAL_MAX_SPAN_SECONDS=1200/);
  assert.match(incrementalService, /--max-queued-at-span-seconds "\$INCREMENTAL_MAX_SPAN_SECONDS"/);
  assert.match(incrementalService, /Environment=INCREMENTAL_MAX_ESTIMATED_BYTES=536870912/);
  assert.match(incrementalService, /--max-estimated-bytes "\$INCREMENTAL_MAX_ESTIMATED_BYTES"/);
  assert.match(incrementalService, /--skip-orphan-check/);
  assert.match(incrementalService, /CLICKHOUSE_REFRESH_TIMEOUT_MS=600000/);

  assert.match(incrementalTimer, /OnCalendar=\*:08\/10/);
  assert.match(incrementalTimer, /Persistent=false/);
  assert.match(incrementalTimer, /Unit=CollectionCountIncrementalRefresh\.service/);
  assert.match(incrementalTimer, /WantedBy=timers\.target/);
});

test('package scripts route normal collection count refresh to incremental and isolate legacy refresh', () => {
  const rootPackage = JSON.parse(rootPackageJson);
  const toolsPackage = JSON.parse(toolsPackageJson);

  assert.equal(rootPackage.scripts['refresh:collection-count'], 'pnpm --filter @atpdashboard/clickhouse-tools refresh:collection-count-incremental');
  assert.equal(toolsPackage.scripts['refresh:collection-count'], 'node --experimental-strip-types src/refresh-collection-count-incremental.ts');
  assert.equal(toolsPackage.scripts['refresh:collection-count-legacy'], 'node --experimental-strip-types src/refresh-collection-count-snapshot.ts');
  assert.equal(toolsPackage.scripts['refresh:collection-count-incremental'], 'node --experimental-strip-types src/refresh-collection-count-incremental.ts');
});

test('legacy collection count units are disabled-only and not normally installable', () => {
  for (const unit of [legacyReadModelService, legacySnapshotService]) {
    assert.match(unit, /LEGACY DISABLED-ONLY/);
    assert.match(unit, /refresh:collection-count-legacy/);
    assert.doesNotMatch(unit, /refresh:collection-count --/);
    assert.doesNotMatch(unit, /refresh:collection-count-incremental/);
  }

  for (const timer of [legacyReadModelTimer, legacySnapshotTimer]) {
    assert.match(timer, /LEGACY DISABLED-ONLY/);
    assert.doesNotMatch(timer, /WantedBy=timers\.target/);
    assert.match(timer, /Persistent=false/);
  }
});
