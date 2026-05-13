import { randomUUID } from 'node:crypto';

export const LEXICON_STORE_DID = 'did:web:lexicon.store';

export type RefreshCollectionCountIncrementalOptions = {
  runId: string;
  refreshId: string;
  dryRun: boolean;
  confirmProduction: boolean;
  safetyLagSeconds: number;
  maxRows: number;
  maxQueuedAtSpanSeconds: number;
  maxEstimatedBytes: number;
  excludedDid: string;
  skipOrphanCheck: boolean;
  retentionMode: 'safe-disabled';
};

export type RefreshCollectionCountIncrementalConfig = {
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUsername: string | null;
  clickhousePassword: string | null;
  clickhouseRefreshTimeoutMs: number;
};

type ClickHouseCommandLike = {
  command: (params: { query: string; query_params?: Record<string, unknown>; clickhouse_settings?: Record<string, unknown> }) => Promise<unknown>;
  query?: <T = unknown>(params: { query: string; query_params?: Record<string, unknown>; format: 'JSONEachRow' }) => Promise<{
    json: () => Promise<{ data: T[] }>;
  }>;
  close?: () => Promise<void>;
};

export function parseRefreshCollectionCountIncrementalOptions(argv: string[]): RefreshCollectionCountIncrementalOptions {
  const options: RefreshCollectionCountIncrementalOptions = {
    runId: randomUUID(),
    refreshId: randomUUID(),
    dryRun: false,
    confirmProduction: false,
    safetyLagSeconds: 300,
    maxRows: 500_000,
    maxQueuedAtSpanSeconds: 600,
    maxEstimatedBytes: 512 * 1024 * 1024,
    excludedDid: LEXICON_STORE_DID,
    skipOrphanCheck: false,
    retentionMode: 'safe-disabled',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--confirm-production') {
      options.confirmProduction = true;
    } else if (arg === '--run-id') {
      options.runId = readNext(argv, ++index, arg);
    } else if (arg === '--refresh-id') {
      options.refreshId = readNext(argv, ++index, arg);
    } else if (arg === '--safety-lag-seconds') {
      options.safetyLagSeconds = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--max-rows') {
      options.maxRows = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--max-queued-at-span-seconds') {
      options.maxQueuedAtSpanSeconds = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--max-estimated-bytes') {
      options.maxEstimatedBytes = readPositiveInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--excluded-did') {
      options.excludedDid = readNext(argv, ++index, arg);
    } else if (arg === '--skip-orphan-check') {
      options.skipOrphanCheck = true;
    } else if (arg === '--retention-mode') {
      const retentionMode = readNext(argv, ++index, arg);
      if (retentionMode !== 'safe-disabled') {
        throw new Error('--retention-mode currently supports only safe-disabled');
      }
      options.retentionMode = retentionMode;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.dryRun && !options.confirmProduction) {
    throw new Error('Refusing to refresh incremental collection count without --confirm-production. Use --dry-run to inspect SQL.');
  }

  return options;
}

export function loadRefreshCollectionCountIncrementalConfig(
  env: Record<string, string | undefined> = process.env,
  options: { requireClickHouse: boolean } = { requireClickHouse: true },
): RefreshCollectionCountIncrementalConfig {
  return {
    clickhouseUrl: options.requireClickHouse ? readRequired(env.CLICKHOUSE_URL, 'CLICKHOUSE_URL') : (env.CLICKHOUSE_URL ?? 'http://localhost:8123'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'atp_dashboard',
    clickhouseUsername: readOptional(env.CLICKHOUSE_USERNAME),
    clickhousePassword: readOptional(env.CLICKHOUSE_PASSWORD),
    clickhouseRefreshTimeoutMs: readPositiveInteger(env.CLICKHOUSE_REFRESH_TIMEOUT_MS ?? '600000', 'CLICKHOUSE_REFRESH_TIMEOUT_MS'),
  };
}

export function buildValidCompletedAllCte(): string {
  return `
latest_manifest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS latest_status,
    argMax(completed_at, tuple(updated_at, status_version)) AS latest_completed_at,
    argMax(run_id, tuple(updated_at, status_version)) AS run_id,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
    argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
    argMax(snapshot_anchor_at, tuple(updated_at, status_version)) AS snapshot_anchor_at,
    argMax(snapshot_written, tuple(updated_at, status_version)) AS snapshot_written,
    argMax(event_seen_written, tuple(updated_at, status_version)) AS event_seen_written,
    argMax(event_conflict_written, tuple(updated_at, status_version)) AS event_conflict_written,
    argMax(first_seen_written, tuple(updated_at, status_version)) AS first_seen_written,
    argMax(did_seen_written, tuple(updated_at, status_version)) AS did_seen_written,
    argMax(rkey_seen_written, tuple(updated_at, status_version)) AS rkey_seen_written,
    argMax(hourly_written, tuple(updated_at, status_version)) AS hourly_written,
    argMax(cumulative_users_written, tuple(updated_at, status_version)) AS cumulative_users_written,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM atp_dashboard.collection_count_refresh_manifest_v2
  GROUP BY refresh_id
),
valid_completed_all AS
(
  SELECT *
  FROM latest_manifest
  WHERE latest_status = 'completed'
    AND latest_completed_at IS NOT NULL
    AND invalidated_at IS NULL
    AND is_bootstrap_seed = 0
    AND run_id IS NOT NULL
    AND snapshot_anchor_at IS NOT NULL
    AND cutoff_queued_at IS NOT NULL
    AND cutoff_event_key IS NOT NULL
    AND cutoff_queue_seq != ''
    AND snapshot_written = 1
    AND event_seen_written = 1
    AND event_conflict_written = 1
    AND first_seen_written = 1
    AND did_seen_written = 1
    AND rkey_seen_written = 1
    AND hourly_written = 1
    AND cumulative_users_written = 1
    AND validation_passed = 1
)`;
}

export function buildReserveRunQuery(): string {
  return `
/* collection_count_incremental_catchup */
INSERT INTO atp_dashboard.collection_count_incremental_runs
  (run_id, refresh_id, status, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, source_rows, stage_rows, error_message, started_at, updated_at, completed_at)
WITH
${buildValidCompletedAllCte()},
latest_valid_completed AS
(
  SELECT *
  FROM valid_completed_all
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
),
watermark AS
(
  SELECT
    refresh_id AS previous_refresh_id,
    cutoff_queued_at AS watermark_queued_at,
    cutoff_event_key AS watermark_event_key,
    cutoff_queue_seq AS watermark_queue_seq
  FROM latest_valid_completed
  UNION ALL
  SELECT
    CAST(NULL, 'Nullable(UUID)') AS previous_refresh_id,
    toDateTime64(0, 3, 'UTC') AS watermark_queued_at,
    '' AS watermark_event_key,
    '' AS watermark_queue_seq
  WHERE NOT EXISTS (SELECT 1 FROM latest_valid_completed)
),
eligible_candidates AS
(
  SELECT
    q.queued_at,
    q.event_key,
    q.queue_seq,
    q.payload_hash
  FROM atp_dashboard.collection_count_ingest_queue AS q
  CROSS JOIN watermark AS w
  WHERE (q.queued_at, q.event_key, q.queue_seq) > (w.watermark_queued_at, w.watermark_event_key, w.watermark_queue_seq)
    AND q.queued_at <= now64(3, 'UTC') - toIntervalSecond({safety_lag_seconds:UInt32})
),
first_candidate AS
(
  SELECT queued_at AS first_queued_at
  FROM eligible_candidates
  ORDER BY queued_at ASC, event_key ASC, queue_seq ASC
  LIMIT 1
),
bounded_candidates AS
(
  SELECT
    event_key,
    payload_hash,
    argMin(tuple(queued_at, queue_seq), tuple(queued_at, queue_seq)) AS first_queue_tuple
  FROM eligible_candidates AS q
  CROSS JOIN first_candidate AS f
  WHERE q.queued_at <= f.first_queued_at + toIntervalSecond({max_queued_at_span_seconds:UInt32})
  GROUP BY event_key, payload_hash
  ORDER BY tupleElement(first_queue_tuple, 1) ASC, event_key ASC, tupleElement(first_queue_tuple, 2) ASC
  LIMIT {max_rows:UInt64}
),
cutoff AS
(
  SELECT
    count() AS source_rows,
    max(tuple(tupleElement(first_queue_tuple, 1), event_key, tupleElement(first_queue_tuple, 2))) AS cutoff_tuple
  FROM bounded_candidates
),
selected_run AS
(
  SELECT
    c.source_rows,
    tupleElement(c.cutoff_tuple, 1) AS cutoff_queued_at,
    tupleElement(c.cutoff_tuple, 2) AS cutoff_event_key,
    tupleElement(c.cutoff_tuple, 3) AS cutoff_queue_seq
  FROM cutoff AS c
  WHERE c.source_rows > 0
    AND c.source_rows * 256 <= {max_estimated_bytes:UInt64}

  UNION ALL

  SELECT
    toUInt64(0) AS source_rows,
    w.watermark_queued_at AS cutoff_queued_at,
    w.watermark_event_key AS cutoff_event_key,
    w.watermark_queue_seq AS cutoff_queue_seq
  FROM cutoff AS c
  CROSS JOIN watermark AS w
  WHERE c.source_rows = 0
    AND w.previous_refresh_id IS NOT NULL
)
SELECT
  {run_id:UUID} AS run_id,
  {refresh_id:UUID} AS refresh_id,
  'running' AS status,
  w.previous_refresh_id,
  w.watermark_queued_at,
  w.watermark_event_key,
  w.watermark_queue_seq,
  r.cutoff_queued_at,
  r.cutoff_event_key,
  r.cutoff_queue_seq,
  r.source_rows,
  0 AS stage_rows,
  NULL AS error_message,
  now64(3, 'UTC') AS started_at,
  now64(3, 'UTC') AS updated_at,
  NULL AS completed_at
FROM watermark AS w
CROSS JOIN selected_run AS r`;
}

export function buildRawCandidateStageInsertQuery(): string {
  return `
/* collection_count_incremental_catchup */
INSERT INTO atp_dashboard.collection_count_event_raw_candidate_stage
  (run_id, event_key, collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, queued_at, queue_seq, payload_hash)
SELECT
  {run_id:UUID} AS run_id,
  q.event_key,
  q.collection,
  q.did,
  q.rkey,
  q.created_at,
  q.created_at_key,
  q.created_hour,
  q.source_ingested_at,
  q.queued_at,
  q.queue_seq,
  q.payload_hash
FROM atp_dashboard.collection_count_ingest_queue AS q
INNER JOIN atp_dashboard.collection_count_incremental_runs AS r ON r.run_id = {run_id:UUID}
WHERE r.status = 'running'
  AND (q.queued_at, q.event_key, q.queue_seq) > (r.watermark_queued_at, r.watermark_event_key, r.watermark_queue_seq)
  AND (q.queued_at, q.event_key, q.queue_seq) <= (r.cutoff_queued_at, r.cutoff_event_key, r.cutoff_queue_seq)
  AND q.did != {excluded_did:String}`;
}

export function buildOrphanInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_queue_orphans
  (run_id, event_key, queued_at, queue_seq, payload_hash, detected_at, resolved_at, resolution)
SELECT
  c.run_id,
  c.event_key,
  c.queued_at,
  c.queue_seq,
  c.payload_hash,
  now64(3, 'UTC') AS detected_at,
  NULL AS resolved_at,
  NULL AS resolution
FROM atp_dashboard.collection_count_event_raw_candidate_stage AS c
LEFT JOIN atp_dashboard.collection_count_event_existence_log AS e
  ON e.event_key = c.event_key
 AND e.payload_hash = c.payload_hash
WHERE c.run_id = {run_id:UUID}
  AND e.event_key = ''`;
}

export function buildOrphanCountQuery(): string {
  return `
SELECT count() AS orphan_count
FROM atp_dashboard.collection_count_queue_orphans
WHERE run_id = {run_id:UUID}
  AND resolved_at IS NULL`;
}

export function buildSameRunConflictInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_event_conflicts
  (run_id, refresh_id, event_key, payload_hash, existing_payload_hash, collection, did, rkey, created_at_key, source_ingested_at, queued_at, detected_at)
WITH conflict_keys AS
(
  SELECT event_key
  FROM atp_dashboard.collection_count_event_raw_candidate_stage
  WHERE run_id = {run_id:UUID}
  GROUP BY event_key
  HAVING uniqExact(tuple(collection, did, rkey, created_at_key, ifNull(toString(created_hour), '<NULL_HOUR>'), payload_hash)) > 1
)
SELECT
  c.run_id,
  {refresh_id:UUID} AS refresh_id,
  c.event_key,
  c.payload_hash,
  CAST(NULL, 'Nullable(UInt64)') AS existing_payload_hash,
  c.collection,
  c.did,
  c.rkey,
  c.created_at_key,
  c.source_ingested_at,
  c.queued_at,
  now64(3, 'UTC') AS detected_at
FROM atp_dashboard.collection_count_event_raw_candidate_stage AS c
INNER JOIN conflict_keys USING (event_key)
WHERE c.run_id = {run_id:UUID}`;
}

export function buildCrossRunConflictInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_event_conflicts
  (run_id, refresh_id, event_key, payload_hash, existing_payload_hash, collection, did, rkey, created_at_key, source_ingested_at, queued_at, detected_at)
WITH
${buildValidCompletedAllCte()},
existing_seen AS
(
  SELECT
    s.event_key,
    argMin(
      tuple(
        s.payload_hash,
        s.collection,
        s.did,
        s.rkey,
        s.created_at_key,
        ifNull(toString(s.created_hour), '<NULL_HOUR>')
      ),
      tuple(v.latest_completed_at, v.cutoff_queued_at, v.cutoff_event_key, v.cutoff_queue_seq, s.refresh_id)
    ) AS first_payload
  FROM atp_dashboard.collection_count_event_seen_log AS s
  INNER JOIN valid_completed_all AS v USING (refresh_id)
  WHERE s.event_key IN (
    SELECT event_key
    FROM atp_dashboard.collection_count_event_raw_candidate_stage
    WHERE run_id = {run_id:UUID}
  )
  GROUP BY s.event_key
)
SELECT
  c.run_id,
  {refresh_id:UUID} AS refresh_id,
  c.event_key,
  c.payload_hash,
  tupleElement(e.first_payload, 1) AS existing_payload_hash,
  c.collection,
  c.did,
  c.rkey,
  c.created_at_key,
  c.source_ingested_at,
  c.queued_at,
  now64(3, 'UTC') AS detected_at
FROM atp_dashboard.collection_count_event_raw_candidate_stage AS c
INNER JOIN existing_seen AS e USING (event_key)
WHERE c.run_id = {run_id:UUID}
  AND (
    c.payload_hash != tupleElement(e.first_payload, 1)
    OR tuple(c.collection, c.did, c.rkey, c.created_at_key, ifNull(toString(c.created_hour), '<NULL_HOUR>')) != tuple(
      tupleElement(e.first_payload, 2),
      tupleElement(e.first_payload, 3),
      tupleElement(e.first_payload, 4),
      tupleElement(e.first_payload, 5),
      tupleElement(e.first_payload, 6)
    )
  )`;
}

export function buildCanonicalStageInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_event_stage
  (run_id, event_key, collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, queued_at, queue_seq, payload_hash)
WITH
${buildValidCompletedAllCte()},
existing_seen AS
(
  SELECT
    s.event_key,
    argMin(s.payload_hash, tuple(v.latest_completed_at, v.cutoff_queued_at, v.cutoff_event_key, v.cutoff_queue_seq, s.refresh_id)) AS first_payload_hash
  FROM atp_dashboard.collection_count_event_seen_log AS s
  INNER JOIN valid_completed_all AS v USING (refresh_id)
  WHERE s.event_key IN (
    SELECT event_key
    FROM atp_dashboard.collection_count_event_raw_candidate_stage
    WHERE run_id = {run_id:UUID}
  )
  GROUP BY s.event_key
),
blocked AS
(
  SELECT event_key
  FROM atp_dashboard.collection_count_queue_orphans
  WHERE run_id = {run_id:UUID}
  UNION DISTINCT
  SELECT event_key
  FROM atp_dashboard.collection_count_event_conflicts
  WHERE run_id = {run_id:UUID}
  UNION DISTINCT
  SELECT event_key
  FROM existing_seen
),
canonical AS
(
  SELECT
    run_id,
    event_key,
    argMin(tuple(collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, queued_at, queue_seq, payload_hash), tuple(source_ingested_at, queued_at, queue_seq, payload_hash, collection, did, rkey, created_at_key, ifNull(toString(created_hour), '<NULL_HOUR>'))) AS row_tuple
  FROM atp_dashboard.collection_count_event_raw_candidate_stage
  WHERE run_id = {run_id:UUID}
    AND event_key NOT IN (SELECT event_key FROM blocked)
  GROUP BY run_id, event_key
)
SELECT
  run_id,
  event_key,
  tupleElement(row_tuple, 1) AS collection,
  tupleElement(row_tuple, 2) AS did,
  tupleElement(row_tuple, 3) AS rkey,
  tupleElement(row_tuple, 4) AS created_at,
  tupleElement(row_tuple, 5) AS created_at_key,
  tupleElement(row_tuple, 6) AS created_hour,
  tupleElement(row_tuple, 7) AS source_ingested_at,
  tupleElement(row_tuple, 8) AS queued_at,
  tupleElement(row_tuple, 9) AS queue_seq,
  tupleElement(row_tuple, 10) AS payload_hash
FROM canonical`;
}

export function buildCurrentStageDidKeysInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.current_stage_did_keys
  (run_id, collection, did)
SELECT DISTINCT
  run_id,
  collection,
  did
FROM atp_dashboard.collection_count_event_stage
WHERE run_id = {run_id:UUID}`;
}

export function buildCurrentStageRkeyKeysInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.current_stage_rkey_keys
  (run_id, collection, did, rkey)
SELECT DISTINCT
  run_id,
  collection,
  did,
  rkey
FROM atp_dashboard.collection_count_event_stage
WHERE run_id = {run_id:UUID}`;
}

export function buildCurrentStageAffectedCollectionsInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.current_stage_affected_collections
  (run_id, collection)
SELECT DISTINCT
  run_id,
  collection
FROM atp_dashboard.collection_count_event_stage
WHERE run_id = {run_id:UUID}`;
}

export function buildCurrentStageHourKeysInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.current_stage_hour_keys
  (run_id, collection, created_hour)
SELECT DISTINCT
  run_id,
  collection,
  assumeNotNull(created_hour) AS created_hour
FROM atp_dashboard.collection_count_event_stage
WHERE run_id = {run_id:UUID}
  AND created_at IS NOT NULL
  AND created_hour IS NOT NULL`;
}

export function buildEventSeenLogInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_event_seen_log
  (run_id, refresh_id, event_key, collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, queued_at, payload_hash, seen_at)
SELECT
  run_id,
  {refresh_id:UUID} AS refresh_id,
  event_key,
  collection,
  did,
  rkey,
  created_at,
  created_at_key,
  created_hour,
  source_ingested_at,
  queued_at,
  payload_hash,
  now64(3, 'UTC') AS seen_at
FROM atp_dashboard.collection_count_event_stage
WHERE run_id = {run_id:UUID}`;
}

export function buildCollectionDeltaInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_collection_delta
  (run_id, collection, total_count, min_created_at, max_created_at, delta_written_at)
SELECT
  run_id,
  collection,
  count() AS total_count,
  minIf(created_at, created_at IS NOT NULL) AS min_created_at,
  maxIf(created_at, created_at IS NOT NULL) AS max_created_at,
  now64(3, 'UTC') AS delta_written_at
FROM atp_dashboard.collection_count_event_stage
WHERE run_id = {run_id:UUID}
GROUP BY run_id, collection`;
}

export function buildDidDeltaInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_did_delta
  (run_id, collection, did, delta_written_at)
WITH
${buildValidCompletedAllCte()},
visible_did AS
(
  SELECT s.collection, s.did
  FROM atp_dashboard.collection_count_did_seen_state AS s
  INNER JOIN valid_completed_all AS v USING (refresh_id)
  WHERE (s.collection, s.did) IN (
    SELECT collection, did
    FROM atp_dashboard.current_stage_did_keys
    WHERE run_id = {run_id:UUID}
  )
  GROUP BY s.collection, s.did
)
SELECT
  k.run_id,
  k.collection,
  k.did,
  now64(3, 'UTC') AS delta_written_at
FROM atp_dashboard.current_stage_did_keys AS k
LEFT JOIN visible_did AS v
  ON v.collection = k.collection
 AND v.did = k.did
WHERE k.run_id = {run_id:UUID}
  AND v.did = ''`;
}

export function buildRkeyDeltaInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_rkey_delta
  (run_id, collection, did, rkey, delta_written_at)
WITH
${buildValidCompletedAllCte()},
visible_rkey AS
(
  SELECT s.collection, s.did, s.rkey
  FROM atp_dashboard.collection_count_rkey_seen_state AS s
  INNER JOIN valid_completed_all AS v USING (refresh_id)
  WHERE (s.collection, s.did, s.rkey) IN (
    SELECT collection, did, rkey
    FROM atp_dashboard.current_stage_rkey_keys
    WHERE run_id = {run_id:UUID}
  )
  GROUP BY s.collection, s.did, s.rkey
)
SELECT
  k.run_id,
  k.collection,
  k.did,
  k.rkey,
  now64(3, 'UTC') AS delta_written_at
FROM atp_dashboard.current_stage_rkey_keys AS k
LEFT JOIN visible_rkey AS v
  ON v.collection = k.collection
 AND v.did = k.did
 AND v.rkey = k.rkey
WHERE k.run_id = {run_id:UUID}
  AND v.rkey = ''`;
}

export function buildDidFirstSeenDeltaInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_did_first_seen_delta
  (run_id, collection, did, first_seen_at, delta_written_at)
WITH
${buildValidCompletedAllCte()},
current_first_seen AS
(
  SELECT
    run_id,
    collection,
    did,
    min(assumeNotNull(created_at)) AS first_seen_at
  FROM atp_dashboard.collection_count_event_stage
  WHERE run_id = {run_id:UUID}
    AND created_at IS NOT NULL
  GROUP BY run_id, collection, did
),
visible_first_seen AS
(
  SELECT
    s.collection,
    s.did,
    min(s.first_seen_at) AS first_seen_at
  FROM atp_dashboard.collection_count_did_first_seen_state AS s
  INNER JOIN valid_completed_all AS v USING (refresh_id)
  WHERE (s.collection, s.did) IN (
    SELECT collection, did
    FROM atp_dashboard.current_stage_did_keys
    WHERE run_id = {run_id:UUID}
  )
  GROUP BY s.collection, s.did
)
SELECT
  c.run_id,
  c.collection,
  c.did,
  c.first_seen_at,
  now64(3, 'UTC') AS delta_written_at
FROM current_first_seen AS c
LEFT JOIN visible_first_seen AS v
  ON v.collection = c.collection
 AND v.did = c.did
WHERE v.did = ''
   OR c.first_seen_at < v.first_seen_at`;
}

export function buildRecentHourlyDeltaInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_recent_hourly_delta
  (run_id, created_hour, collection, event_count)
SELECT
  run_id,
  assumeNotNull(created_hour) AS created_hour,
  collection,
  count() AS event_count
FROM atp_dashboard.collection_count_event_stage
WHERE run_id = {run_id:UUID}
  AND created_at IS NOT NULL
  AND created_hour IS NOT NULL
GROUP BY run_id, created_hour, collection`;
}

export function buildDidSeenStateInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_did_seen_state
  (refresh_id, run_id, collection, did, first_seen_at, created_at_is_null, state_written_at)
SELECT
  {refresh_id:UUID} AS refresh_id,
  d.run_id,
  d.collection,
  d.did,
  minOrNull(toDateTime64(s.created_at, 3, 'UTC')) AS first_seen_at,
  if(countIf(s.created_at IS NOT NULL) = 0, 1, 0) AS created_at_is_null,
  now64(3, 'UTC') AS state_written_at
FROM atp_dashboard.collection_count_did_delta AS d
LEFT JOIN atp_dashboard.collection_count_event_stage AS s
  ON s.run_id = d.run_id
 AND s.collection = d.collection
 AND s.did = d.did
WHERE d.run_id = {run_id:UUID}
GROUP BY d.run_id, d.collection, d.did`;
}

export function buildRkeySeenStateInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_rkey_seen_state
  (refresh_id, run_id, collection, did, rkey, state_written_at)
SELECT
  {refresh_id:UUID} AS refresh_id,
  run_id,
  collection,
  did,
  rkey,
  now64(3, 'UTC') AS state_written_at
FROM atp_dashboard.collection_count_rkey_delta
WHERE run_id = {run_id:UUID}`;
}

export function buildDidFirstSeenStateInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_did_first_seen_state
  (refresh_id, run_id, collection, did, first_seen_at, state_written_at)
SELECT
  {refresh_id:UUID} AS refresh_id,
  run_id,
  collection,
  did,
  first_seen_at,
  now64(3, 'UTC') AS state_written_at
FROM atp_dashboard.collection_count_did_first_seen_delta
WHERE run_id = {run_id:UUID}`;
}

export function buildRecentHourlyStateInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_recent_hourly_state
  (refresh_id, run_id, collection, created_hour, event_count, state_written_at)
SELECT
  {refresh_id:UUID} AS refresh_id,
  run_id,
  collection,
  created_hour,
  event_count,
  now64(3, 'UTC') AS state_written_at
FROM atp_dashboard.collection_count_recent_hourly_delta
WHERE run_id = {run_id:UUID}`;
}

export function buildSnapshotPublishInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_snapshot
  (refresh_id, collection, unique_did, unique_rkey, total_count, recent_count, min_created_at, max_created_at, refreshed_at)
WITH
${buildValidCompletedAllCte()},
latest_valid_completed AS
(
  SELECT *
  FROM valid_completed_all
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
),
snapshot_anchor AS
(
  SELECT toStartOfHour(now64(3, 'UTC')) AS anchor_hour
),
previous_snapshot AS
(
  SELECT s.*
  FROM atp_dashboard.collection_count_snapshot AS s
  INNER JOIN latest_valid_completed AS v ON v.refresh_id = s.refresh_id
),
collection_delta AS
(
  SELECT
    collection,
    sum(total_count) AS total_count_delta,
    min(min_created_at) AS min_created_at_delta,
    max(max_created_at) AS max_created_at_delta
  FROM atp_dashboard.collection_count_collection_delta
  WHERE run_id = {run_id:UUID}
  GROUP BY collection
),
did_delta AS
(
  SELECT collection, count() AS unique_did_delta
  FROM atp_dashboard.collection_count_did_delta
  WHERE run_id = {run_id:UUID}
  GROUP BY collection
),
rkey_delta AS
(
  SELECT collection, count() AS unique_rkey_delta
  FROM atp_dashboard.collection_count_rkey_delta
  WHERE run_id = {run_id:UUID}
  GROUP BY collection
),
visible_recent AS
(
  SELECT
    h.collection,
    sum(h.event_count) AS recent_count
  FROM atp_dashboard.collection_count_recent_hourly_state AS h
  INNER JOIN valid_completed_all AS v USING (refresh_id)
  CROSS JOIN snapshot_anchor AS a
  WHERE h.created_hour >= a.anchor_hour - toIntervalHour(72)
    AND h.created_hour < a.anchor_hour
    AND h.collection IN (
      SELECT collection FROM atp_dashboard.current_stage_affected_collections WHERE run_id = {run_id:UUID}
      UNION DISTINCT
      SELECT collection FROM previous_snapshot WHERE recent_count > 0
      UNION DISTINCT
      SELECT collection FROM atp_dashboard.collection_count_recent_hourly_delta WHERE run_id = {run_id:UUID}
    )
  GROUP BY h.collection
),
current_recent AS
(
  SELECT
    h.collection,
    sum(h.event_count) AS recent_count
  FROM atp_dashboard.collection_count_recent_hourly_delta AS h
  CROSS JOIN snapshot_anchor AS a
  WHERE h.run_id = {run_id:UUID}
    AND h.created_hour >= a.anchor_hour - toIntervalHour(72)
    AND h.created_hour < a.anchor_hour
  GROUP BY h.collection
),
affected_collections AS
(
  SELECT collection FROM atp_dashboard.current_stage_affected_collections WHERE run_id = {run_id:UUID}
  UNION DISTINCT
  SELECT collection FROM previous_snapshot WHERE recent_count > 0
  UNION DISTINCT
  SELECT collection FROM current_recent
),
all_collections AS
(
  SELECT collection FROM previous_snapshot
  UNION DISTINCT
  SELECT collection FROM collection_delta
)
SELECT
  {refresh_id:UUID} AS refresh_id,
  c.collection,
  toUInt64(coalesce(p.unique_did, 0) + coalesce(d.unique_did_delta, 0)) AS unique_did,
  toUInt64(coalesce(p.unique_rkey, 0) + coalesce(r.unique_rkey_delta, 0)) AS unique_rkey,
  toUInt64(coalesce(p.total_count, 0) + coalesce(cd.total_count_delta, 0)) AS total_count,
  toUInt64(if(a.collection = '', coalesce(p.recent_count, 0), coalesce(vr.recent_count, 0) + coalesce(cr.recent_count, 0))) AS recent_count,
  if(p.min_created_at IS NULL, cd.min_created_at_delta, least(p.min_created_at, coalesce(cd.min_created_at_delta, p.min_created_at))) AS min_created_at,
  if(p.max_created_at IS NULL, cd.max_created_at_delta, greatest(p.max_created_at, coalesce(cd.max_created_at_delta, p.max_created_at))) AS max_created_at,
  now64(3, 'UTC') AS refreshed_at
FROM all_collections AS c
LEFT JOIN previous_snapshot AS p USING (collection)
LEFT JOIN collection_delta AS cd USING (collection)
LEFT JOIN did_delta AS d USING (collection)
LEFT JOIN rkey_delta AS r USING (collection)
LEFT JOIN visible_recent AS vr USING (collection)
LEFT JOIN current_recent AS cr USING (collection)
LEFT JOIN affected_collections AS a USING (collection)`;
}

export function buildPublishValidationQuery(): string {
  return `
WITH
snapshot_rows AS
(
  SELECT count() AS row_count, uniqExact(collection) AS unique_collection_count
  FROM atp_dashboard.collection_count_snapshot
  WHERE refresh_id = {refresh_id:UUID}
),
did_rows AS
(
  SELECT count() AS delta_rows
  FROM atp_dashboard.collection_count_did_delta
  WHERE run_id = {run_id:UUID}
),
did_state_rows AS
(
  SELECT count() AS state_rows
  FROM atp_dashboard.collection_count_did_seen_state
  WHERE refresh_id = {refresh_id:UUID}
),
rkey_rows AS
(
  SELECT count() AS delta_rows
  FROM atp_dashboard.collection_count_rkey_delta
  WHERE run_id = {run_id:UUID}
),
rkey_state_rows AS
(
  SELECT count() AS state_rows
  FROM atp_dashboard.collection_count_rkey_seen_state
  WHERE refresh_id = {refresh_id:UUID}
),
hourly_rows AS
(
  SELECT count() AS delta_rows
  FROM atp_dashboard.collection_count_recent_hourly_delta
  WHERE run_id = {run_id:UUID}
),
hourly_state_rows AS
(
  SELECT count() AS state_rows
  FROM atp_dashboard.collection_count_recent_hourly_state
  WHERE refresh_id = {refresh_id:UUID}
),
cumulative_collection_rows AS
(
  SELECT
    count() AS collection_count,
    max(rows_per_collection) AS max_rows_per_collection
  FROM
  (
    SELECT
      collection,
      count() AS rows_per_collection
    FROM atp_dashboard.collection_count_cumulative_users_snapshot
    WHERE refresh_id = {refresh_id:UUID}
    GROUP BY collection
  )
),
cumulative_future_rows AS
(
  SELECT countIf(day > today()) AS future_rows
  FROM atp_dashboard.collection_count_cumulative_users_snapshot
  WHERE refresh_id = {refresh_id:UUID}
)
SELECT
  throwIf(row_count = 0, 'collection_count incremental validation failed: empty snapshot') AS non_empty_snapshot,
  throwIf(row_count != unique_collection_count, 'collection_count incremental validation failed: duplicate snapshot collection') AS unique_snapshot_collections,
  throwIf((SELECT delta_rows FROM did_rows) != (SELECT state_rows FROM did_state_rows), 'collection_count incremental validation failed: did state mismatch') AS did_state_matches,
  throwIf((SELECT delta_rows FROM rkey_rows) != (SELECT state_rows FROM rkey_state_rows), 'collection_count incremental validation failed: rkey state mismatch') AS rkey_state_matches,
  throwIf((SELECT delta_rows FROM hourly_rows) != (SELECT state_rows FROM hourly_state_rows), 'collection_count incremental validation failed: hourly state mismatch') AS hourly_state_matches,
  throwIf((SELECT max_rows_per_collection FROM cumulative_collection_rows) > 365, 'collection_count incremental validation failed: cumulative users over 365 rows per collection') AS cumulative_users_365_rows,
  throwIf((SELECT future_rows FROM cumulative_future_rows) > 0, 'collection_count incremental validation failed: cumulative users future rows') AS cumulative_users_no_future_rows
FROM snapshot_rows`;
}

export function buildCumulativeUsersSnapshotInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_cumulative_users_snapshot
  (refresh_id, collection, day, new_users, cumulative_users, refreshed_at)
WITH
${buildValidCompletedAllCte()},
latest_valid_completed AS
(
  SELECT *
  FROM valid_completed_all
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
),
snapshot_anchor AS
(
  SELECT toDate(now64(3, 'UTC')) AS anchor_day
),
previous_daily AS
(
  SELECT d.*
  FROM atp_dashboard.collection_count_cumulative_users_snapshot AS d
  INNER JOIN latest_valid_completed AS v ON v.refresh_id = d.refresh_id
),
cumulative_affected_collections AS
(
  SELECT DISTINCT collection
  FROM atp_dashboard.collection_count_did_first_seen_delta
  WHERE run_id = {run_id:UUID}

  UNION DISTINCT

  SELECT DISTINCT p.collection
  FROM previous_daily AS p
  CROSS JOIN latest_valid_completed AS v
  CROSS JOIN snapshot_anchor AS a
  WHERE toDate(v.snapshot_anchor_at) < a.anchor_day
),
day_series AS
(
  SELECT
    addDays(a.anchor_day, -toInt32(364 - number)) AS day
  FROM snapshot_anchor AS a
  ARRAY JOIN range(365) AS number
),
visible_first_seen AS
(
  SELECT
    s.collection,
    s.did,
    min(s.first_seen_at) AS first_seen_at
  FROM atp_dashboard.collection_count_did_first_seen_state AS s
  INNER JOIN valid_completed_all AS v USING (refresh_id)
  WHERE s.collection IN (SELECT collection FROM cumulative_affected_collections)
  GROUP BY s.collection, s.did
),
current_first_seen AS
(
  SELECT
    collection,
    did,
    min(first_seen_at) AS first_seen_at
  FROM atp_dashboard.collection_count_did_first_seen_delta
  WHERE run_id = {run_id:UUID}
  GROUP BY collection, did
),
combined_first_seen AS
(
  SELECT collection, did, first_seen_at FROM visible_first_seen
  UNION ALL
  SELECT collection, did, first_seen_at FROM current_first_seen
),
effective_first_seen AS
(
  SELECT
    collection,
    did,
    min(first_seen_at) AS first_seen_at
  FROM combined_first_seen
  GROUP BY collection, did
),
regenerated AS
(
  SELECT
    {refresh_id:UUID} AS refresh_id,
    c.collection,
    d.day,
    countIf(toDate(f.first_seen_at) = d.day) AS new_users,
    countIf(toDate(f.first_seen_at) <= d.day) AS cumulative_users,
    now64(3, 'UTC') AS refreshed_at
  FROM cumulative_affected_collections AS c
  CROSS JOIN day_series AS d
  LEFT JOIN effective_first_seen AS f ON f.collection = c.collection
  GROUP BY c.collection, d.day
),
copied AS
(
  SELECT
    {refresh_id:UUID} AS refresh_id,
    p.collection,
    p.day,
    p.new_users,
    p.cumulative_users,
    now64(3, 'UTC') AS refreshed_at
  FROM previous_daily AS p
  WHERE p.collection NOT IN (SELECT collection FROM cumulative_affected_collections)
)
SELECT *
FROM regenerated
UNION ALL
SELECT *
FROM copied`;
}

export function buildCumulativeUsersReadQuery(): string {
  return `
WITH
${buildValidCompletedAllCte()},
latest_valid_completed AS
(
  SELECT *
  FROM valid_completed_all
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
)
SELECT
  day AS date,
  new_users AS new,
  cumulative_users AS cumulative
FROM atp_dashboard.collection_count_cumulative_users_snapshot
WHERE refresh_id = (SELECT refresh_id FROM latest_valid_completed)
  AND collection = {collection:String}
  AND day >= {from:Date}
  AND day < {to:Date}
ORDER BY day
LIMIT 365`;
}

export function buildDidSeenStateExplainQuery(): string {
  return `
EXPLAIN indexes=1
WITH
${buildValidCompletedAllCte()}
SELECT s.collection, s.did
FROM atp_dashboard.collection_count_did_seen_state AS s
INNER JOIN valid_completed_all AS v USING (refresh_id)
WHERE (s.collection, s.did) IN (
  SELECT collection, did
  FROM atp_dashboard.current_stage_did_keys
  WHERE run_id = {run_id:UUID}
)`;
}

export function buildRkeySeenStateExplainQuery(): string {
  return `
EXPLAIN indexes=1
WITH
${buildValidCompletedAllCte()}
SELECT s.collection, s.did, s.rkey
FROM atp_dashboard.collection_count_rkey_seen_state AS s
INNER JOIN valid_completed_all AS v USING (refresh_id)
WHERE (s.collection, s.did, s.rkey) IN (
  SELECT collection, did, rkey
  FROM atp_dashboard.current_stage_rkey_keys
  WHERE run_id = {run_id:UUID}
)`;
}

export function buildRecentHourlyStateExplainQuery(): string {
  return `
EXPLAIN indexes=1
WITH
${buildValidCompletedAllCte()}
SELECT h.collection, sum(h.event_count) AS recent_count
FROM atp_dashboard.collection_count_recent_hourly_state AS h
INNER JOIN valid_completed_all AS v USING (refresh_id)
WHERE h.created_hour >= toStartOfHour(now64(3, 'UTC')) - toIntervalHour(72)
  AND h.created_hour < toStartOfHour(now64(3, 'UTC'))
  AND (h.created_hour, h.collection) IN (
    SELECT created_hour, collection
    FROM atp_dashboard.current_stage_hour_keys
    WHERE run_id = {run_id:UUID}
  )
GROUP BY h.collection`;
}

export function buildRunSnapshotWrittenQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_incremental_runs
  (run_id, refresh_id, status, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, source_rows, stage_rows, error_message, started_at, updated_at, completed_at)
SELECT
  run_id,
  refresh_id,
  'snapshot_written' AS status,
  previous_refresh_id,
  watermark_queued_at,
  watermark_event_key,
  watermark_queue_seq,
  cutoff_queued_at,
  cutoff_event_key,
  cutoff_queue_seq,
  source_rows,
  (SELECT count() FROM atp_dashboard.collection_count_event_stage WHERE run_id = {run_id:UUID}) AS stage_rows,
  NULL AS error_message,
  started_at,
  now64(3, 'UTC') AS updated_at,
  NULL AS completed_at
FROM atp_dashboard.collection_count_incremental_runs
WHERE run_id = {run_id:UUID}
ORDER BY updated_at DESC
LIMIT 1`;
}

export function buildLinearCommitGuardQuery(): string {
  return `
WITH
${buildValidCompletedAllCte()},
latest_valid_completed AS
(
  SELECT *
  FROM valid_completed_all
  ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
  LIMIT 1
),
run AS
(
  SELECT *
  FROM atp_dashboard.collection_count_incremental_runs
  WHERE run_id = {run_id:UUID}
  ORDER BY updated_at DESC
  LIMIT 1
)
SELECT
  throwIf(
    if(
      r.previous_refresh_id IS NULL,
      (SELECT count() FROM latest_valid_completed) != 0,
      NOT (
        (SELECT refresh_id FROM latest_valid_completed) = r.previous_refresh_id
        AND (SELECT cutoff_queued_at FROM latest_valid_completed) = r.watermark_queued_at
        AND (SELECT cutoff_event_key FROM latest_valid_completed) = r.watermark_event_key
        AND (SELECT cutoff_queue_seq FROM latest_valid_completed) = r.watermark_queue_seq
      )
    ),
    'collection_count incremental commit guard failed: latest completed moved'
  ) AS linear_commit_guard
FROM run AS r`;
}

export function buildCompletedManifestInsertQuery(options: { bootstrapSeed?: boolean } = {}): string {
  const isBootstrapSeed = options.bootstrapSeed ? '1' : '0';
  return `
INSERT INTO atp_dashboard.collection_count_refresh_manifest_v2
  (refresh_id, status, updated_at, completed_at, row_count, refreshed_at, run_id, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, snapshot_anchor_at, source_rows, stage_rows, event_seen_row_count, event_conflict_row_count, first_seen_row_count, did_seen_row_count, rkey_seen_row_count, hourly_row_count, snapshot_written, event_seen_written, event_conflict_written, first_seen_written, did_seen_written, rkey_seen_written, hourly_written, cumulative_users_written, validation_passed, queue_backfill_generation, status_version, invalidated_at, invalidated_reason, is_bootstrap_seed)
WITH
run AS
(
  SELECT *
  FROM atp_dashboard.collection_count_incremental_runs
  WHERE run_id = {run_id:UUID}
  ORDER BY updated_at DESC
  LIMIT 1
),
existing_manifest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS latest_status,
    max(status_version) AS max_status_version
  FROM atp_dashboard.collection_count_refresh_manifest_v2
  WHERE refresh_id = {refresh_id:UUID}
  GROUP BY refresh_id
),
counts AS
(
  SELECT
    (SELECT count() FROM atp_dashboard.collection_count_snapshot WHERE refresh_id = {refresh_id:UUID}) AS row_count,
    (SELECT count() FROM atp_dashboard.collection_count_event_seen_log WHERE refresh_id = {refresh_id:UUID}) AS event_seen_row_count,
    (SELECT count() FROM atp_dashboard.collection_count_event_conflicts WHERE refresh_id = {refresh_id:UUID}) AS event_conflict_row_count,
    (SELECT count() FROM atp_dashboard.collection_count_did_first_seen_state WHERE refresh_id = {refresh_id:UUID}) AS first_seen_row_count,
    (SELECT count() FROM atp_dashboard.collection_count_did_seen_state WHERE refresh_id = {refresh_id:UUID}) AS did_seen_row_count,
    (SELECT count() FROM atp_dashboard.collection_count_rkey_seen_state WHERE refresh_id = {refresh_id:UUID}) AS rkey_seen_row_count,
    (SELECT count() FROM atp_dashboard.collection_count_recent_hourly_state WHERE refresh_id = {refresh_id:UUID}) AS hourly_row_count
)
SELECT
  {refresh_id:UUID} AS refresh_id,
  'completed' AS status,
  now64(3, 'UTC') AS updated_at,
  now64(3, 'UTC') AS completed_at,
  c.row_count,
  now64(3, 'UTC') AS refreshed_at,
  r.run_id,
  r.previous_refresh_id,
  r.watermark_queued_at,
  r.watermark_event_key,
  r.watermark_queue_seq,
  r.cutoff_queued_at,
  r.cutoff_event_key,
  r.cutoff_queue_seq,
  toStartOfHour(now64(3, 'UTC')) AS snapshot_anchor_at,
  r.source_rows,
  r.stage_rows,
  c.event_seen_row_count,
  c.event_conflict_row_count,
  c.first_seen_row_count,
  c.did_seen_row_count,
  c.rkey_seen_row_count,
  c.hourly_row_count,
  1 AS snapshot_written,
  1 AS event_seen_written,
  1 AS event_conflict_written,
  1 AS first_seen_written,
  1 AS did_seen_written,
  1 AS rkey_seen_written,
  1 AS hourly_written,
  1 AS cumulative_users_written,
  1 AS validation_passed,
  0 AS queue_backfill_generation,
  greatest(toUInt64(30), coalesce((SELECT max_status_version FROM existing_manifest), 0) + 1) AS status_version,
  NULL AS invalidated_at,
  NULL AS invalidated_reason,
  ${isBootstrapSeed} AS is_bootstrap_seed
FROM run AS r
CROSS JOIN counts AS c
WHERE r.status = 'snapshot_written'
  AND c.row_count > 0
  AND NOT EXISTS (
    SELECT 1
    FROM existing_manifest
    WHERE latest_status = 'completed'
  )`;
}

export function buildFailedManifestInsertQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_refresh_manifest_v2
  (refresh_id, status, updated_at, completed_at, row_count, refreshed_at, run_id, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, snapshot_anchor_at, source_rows, stage_rows, event_seen_row_count, event_conflict_row_count, first_seen_row_count, did_seen_row_count, rkey_seen_row_count, hourly_row_count, snapshot_written, event_seen_written, event_conflict_written, first_seen_written, did_seen_written, rkey_seen_written, hourly_written, cumulative_users_written, validation_passed, queue_backfill_generation, status_version, invalidated_at, invalidated_reason, is_bootstrap_seed)
WITH
run AS
(
  SELECT *
  FROM atp_dashboard.collection_count_incremental_runs
  WHERE run_id = {run_id:UUID}
  ORDER BY updated_at DESC
  LIMIT 1
),
existing_manifest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS latest_status,
    max(status_version) AS max_status_version
  FROM atp_dashboard.collection_count_refresh_manifest_v2
  WHERE refresh_id = {refresh_id:UUID}
  GROUP BY refresh_id
)
SELECT
  {refresh_id:UUID} AS refresh_id,
  'failed' AS status,
  now64(3, 'UTC') AS updated_at,
  now64(3, 'UTC') AS completed_at,
  0 AS row_count,
  now64(3, 'UTC') AS refreshed_at,
  r.run_id,
  r.previous_refresh_id,
  r.watermark_queued_at,
  r.watermark_event_key,
  r.watermark_queue_seq,
  r.cutoff_queued_at,
  r.cutoff_event_key,
  r.cutoff_queue_seq,
  NULL AS snapshot_anchor_at,
  r.source_rows,
  r.stage_rows,
  0 AS event_seen_row_count,
  0 AS event_conflict_row_count,
  0 AS first_seen_row_count,
  0 AS did_seen_row_count,
  0 AS rkey_seen_row_count,
  0 AS hourly_row_count,
  0 AS snapshot_written,
  0 AS event_seen_written,
  0 AS event_conflict_written,
  0 AS first_seen_written,
  0 AS did_seen_written,
  0 AS rkey_seen_written,
  0 AS hourly_written,
  0 AS cumulative_users_written,
  0 AS validation_passed,
  0 AS queue_backfill_generation,
  greatest(toUInt64(90), coalesce((SELECT max_status_version FROM existing_manifest), 0) + 1) AS status_version,
  NULL AS invalidated_at,
  NULL AS invalidated_reason,
  0 AS is_bootstrap_seed
FROM run AS r
WHERE NOT EXISTS (
  SELECT 1
  FROM existing_manifest
  WHERE latest_status = 'completed'
)`;
}

export function buildManifestReadbackQuery(): string {
  return `
SELECT
  refresh_id,
  argMax(status, tuple(updated_at, status_version)) AS latest_status,
  argMax(completed_at, tuple(updated_at, status_version)) AS latest_completed_at,
  argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
  max(status_version) AS max_status_version
FROM atp_dashboard.collection_count_refresh_manifest_v2
WHERE refresh_id = {refresh_id:UUID}
GROUP BY refresh_id`;
}

export function buildInvalidateRefreshQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_refresh_manifest_v2
  (refresh_id, status, updated_at, completed_at, row_count, refreshed_at, run_id, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, snapshot_anchor_at, source_rows, stage_rows, event_seen_row_count, event_conflict_row_count, first_seen_row_count, did_seen_row_count, rkey_seen_row_count, hourly_row_count, snapshot_written, event_seen_written, event_conflict_written, first_seen_written, did_seen_written, rkey_seen_written, hourly_written, cumulative_users_written, validation_passed, queue_backfill_generation, status_version, invalidated_at, invalidated_reason, is_bootstrap_seed)
WITH latest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS status,
    argMax(completed_at, tuple(updated_at, status_version)) AS completed_at,
    argMax(row_count, tuple(updated_at, status_version)) AS row_count,
    argMax(refreshed_at, tuple(updated_at, status_version)) AS refreshed_at,
    argMax(run_id, tuple(updated_at, status_version)) AS run_id,
    argMax(previous_refresh_id, tuple(updated_at, status_version)) AS previous_refresh_id,
    argMax(watermark_queued_at, tuple(updated_at, status_version)) AS watermark_queued_at,
    argMax(watermark_event_key, tuple(updated_at, status_version)) AS watermark_event_key,
    argMax(watermark_queue_seq, tuple(updated_at, status_version)) AS watermark_queue_seq,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
    argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
    argMax(snapshot_anchor_at, tuple(updated_at, status_version)) AS snapshot_anchor_at,
    argMax(source_rows, tuple(updated_at, status_version)) AS source_rows,
    argMax(stage_rows, tuple(updated_at, status_version)) AS stage_rows,
    argMax(event_seen_row_count, tuple(updated_at, status_version)) AS event_seen_row_count,
    argMax(event_conflict_row_count, tuple(updated_at, status_version)) AS event_conflict_row_count,
    argMax(first_seen_row_count, tuple(updated_at, status_version)) AS first_seen_row_count,
    argMax(did_seen_row_count, tuple(updated_at, status_version)) AS did_seen_row_count,
    argMax(rkey_seen_row_count, tuple(updated_at, status_version)) AS rkey_seen_row_count,
    argMax(hourly_row_count, tuple(updated_at, status_version)) AS hourly_row_count,
    argMax(snapshot_written, tuple(updated_at, status_version)) AS snapshot_written,
    argMax(event_seen_written, tuple(updated_at, status_version)) AS event_seen_written,
    argMax(event_conflict_written, tuple(updated_at, status_version)) AS event_conflict_written,
    argMax(first_seen_written, tuple(updated_at, status_version)) AS first_seen_written,
    argMax(did_seen_written, tuple(updated_at, status_version)) AS did_seen_written,
    argMax(rkey_seen_written, tuple(updated_at, status_version)) AS rkey_seen_written,
    argMax(hourly_written, tuple(updated_at, status_version)) AS hourly_written,
    argMax(cumulative_users_written, tuple(updated_at, status_version)) AS cumulative_users_written,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(queue_backfill_generation, tuple(updated_at, status_version)) AS queue_backfill_generation,
    max(status_version) AS max_status_version,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM atp_dashboard.collection_count_refresh_manifest_v2
  WHERE refresh_id = {invalidate_refresh_id:UUID}
  GROUP BY refresh_id
)
SELECT
  refresh_id,
  status,
  now64(3, 'UTC') AS updated_at,
  completed_at,
  row_count,
  refreshed_at,
  run_id,
  previous_refresh_id,
  watermark_queued_at,
  watermark_event_key,
  watermark_queue_seq,
  cutoff_queued_at,
  cutoff_event_key,
  cutoff_queue_seq,
  snapshot_anchor_at,
  source_rows,
  stage_rows,
  event_seen_row_count,
  event_conflict_row_count,
  first_seen_row_count,
  did_seen_row_count,
  rkey_seen_row_count,
  hourly_row_count,
  snapshot_written,
  event_seen_written,
  event_conflict_written,
  first_seen_written,
  did_seen_written,
  rkey_seen_written,
  hourly_written,
  cumulative_users_written,
  validation_passed,
  queue_backfill_generation,
  max_status_version + 1 AS status_version,
  now64(3, 'UTC') AS invalidated_at,
  {invalidated_reason:String} AS invalidated_reason,
  is_bootstrap_seed
FROM latest`;
}

export function buildDescendantInvalidationQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_refresh_manifest_v2
  (refresh_id, status, updated_at, completed_at, row_count, refreshed_at, run_id, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, snapshot_anchor_at, source_rows, stage_rows, event_seen_row_count, event_conflict_row_count, first_seen_row_count, did_seen_row_count, rkey_seen_row_count, hourly_row_count, snapshot_written, event_seen_written, event_conflict_written, first_seen_written, did_seen_written, rkey_seen_written, hourly_written, cumulative_users_written, validation_passed, queue_backfill_generation, status_version, invalidated_at, invalidated_reason, is_bootstrap_seed)
WITH RECURSIVE
latest AS
(
  SELECT
    refresh_id,
    argMax(status, tuple(updated_at, status_version)) AS status,
    argMax(completed_at, tuple(updated_at, status_version)) AS completed_at,
    argMax(row_count, tuple(updated_at, status_version)) AS row_count,
    argMax(refreshed_at, tuple(updated_at, status_version)) AS refreshed_at,
    argMax(run_id, tuple(updated_at, status_version)) AS run_id,
    argMax(previous_refresh_id, tuple(updated_at, status_version)) AS previous_refresh_id,
    argMax(watermark_queued_at, tuple(updated_at, status_version)) AS watermark_queued_at,
    argMax(watermark_event_key, tuple(updated_at, status_version)) AS watermark_event_key,
    argMax(watermark_queue_seq, tuple(updated_at, status_version)) AS watermark_queue_seq,
    argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
    argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
    argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
    argMax(snapshot_anchor_at, tuple(updated_at, status_version)) AS snapshot_anchor_at,
    argMax(source_rows, tuple(updated_at, status_version)) AS source_rows,
    argMax(stage_rows, tuple(updated_at, status_version)) AS stage_rows,
    argMax(event_seen_row_count, tuple(updated_at, status_version)) AS event_seen_row_count,
    argMax(event_conflict_row_count, tuple(updated_at, status_version)) AS event_conflict_row_count,
    argMax(first_seen_row_count, tuple(updated_at, status_version)) AS first_seen_row_count,
    argMax(did_seen_row_count, tuple(updated_at, status_version)) AS did_seen_row_count,
    argMax(rkey_seen_row_count, tuple(updated_at, status_version)) AS rkey_seen_row_count,
    argMax(hourly_row_count, tuple(updated_at, status_version)) AS hourly_row_count,
    argMax(snapshot_written, tuple(updated_at, status_version)) AS snapshot_written,
    argMax(event_seen_written, tuple(updated_at, status_version)) AS event_seen_written,
    argMax(event_conflict_written, tuple(updated_at, status_version)) AS event_conflict_written,
    argMax(first_seen_written, tuple(updated_at, status_version)) AS first_seen_written,
    argMax(did_seen_written, tuple(updated_at, status_version)) AS did_seen_written,
    argMax(rkey_seen_written, tuple(updated_at, status_version)) AS rkey_seen_written,
    argMax(hourly_written, tuple(updated_at, status_version)) AS hourly_written,
    argMax(cumulative_users_written, tuple(updated_at, status_version)) AS cumulative_users_written,
    argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
    argMax(queue_backfill_generation, tuple(updated_at, status_version)) AS queue_backfill_generation,
    max(status_version) AS max_status_version,
    argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
    argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
  FROM atp_dashboard.collection_count_refresh_manifest_v2
  GROUP BY refresh_id
),
descendants AS
(
  SELECT refresh_id
  FROM latest
  WHERE previous_refresh_id = {invalidate_refresh_id:UUID}

  UNION ALL

  SELECT l.refresh_id
  FROM latest AS l
  INNER JOIN descendants AS d ON l.previous_refresh_id = d.refresh_id
)
SELECT
  l.refresh_id,
  l.status,
  now64(3, 'UTC') AS updated_at,
  l.completed_at,
  l.row_count,
  l.refreshed_at,
  l.run_id,
  l.previous_refresh_id,
  l.watermark_queued_at,
  l.watermark_event_key,
  l.watermark_queue_seq,
  l.cutoff_queued_at,
  l.cutoff_event_key,
  l.cutoff_queue_seq,
  l.snapshot_anchor_at,
  l.source_rows,
  l.stage_rows,
  l.event_seen_row_count,
  l.event_conflict_row_count,
  l.first_seen_row_count,
  l.did_seen_row_count,
  l.rkey_seen_row_count,
  l.hourly_row_count,
  l.snapshot_written,
  l.event_seen_written,
  l.event_conflict_written,
  l.first_seen_written,
  l.did_seen_written,
  l.rkey_seen_written,
  l.hourly_written,
  l.cumulative_users_written,
  l.validation_passed,
  l.queue_backfill_generation,
  l.max_status_version + 1 AS status_version,
  now64(3, 'UTC') AS invalidated_at,
  {invalidated_reason:String} AS invalidated_reason,
  l.is_bootstrap_seed
FROM latest AS l
INNER JOIN descendants AS d USING (refresh_id)
WHERE l.invalidated_at IS NULL`;
}

export function buildRunFailedQuery(): string {
  return `
INSERT INTO atp_dashboard.collection_count_incremental_runs
  (run_id, refresh_id, status, previous_refresh_id, watermark_queued_at, watermark_event_key, watermark_queue_seq, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, source_rows, stage_rows, error_message, started_at, updated_at, completed_at)
SELECT
  run_id,
  refresh_id,
  'failed' AS status,
  previous_refresh_id,
  watermark_queued_at,
  watermark_event_key,
  watermark_queue_seq,
  cutoff_queued_at,
  cutoff_event_key,
  cutoff_queue_seq,
  source_rows,
  stage_rows,
  {error_message:String} AS error_message,
  started_at,
  now64(3, 'UTC') AS updated_at,
  now64(3, 'UTC') AS completed_at
FROM atp_dashboard.collection_count_incremental_runs
WHERE run_id = {run_id:UUID}
ORDER BY updated_at DESC
LIMIT 1`;
}

export async function refreshCollectionCountIncremental(
  client: ClickHouseCommandLike,
  options: RefreshCollectionCountIncrementalOptions,
): Promise<{ runId: string; refreshId: string; dryRun: boolean; status: 'completed' | 'dry_run' }> {
  const plan = buildRefreshCollectionCountIncrementalPlan(options);

  if (options.dryRun) {
    return { runId: options.runId, refreshId: options.refreshId, dryRun: true, status: 'dry_run' };
  }

  for (const command of plan.beforeOrphanCheck) {
    await client.command(command);
  }

  if (!options.skipOrphanCheck) {
    const orphanCount = await readCount(client, buildOrphanCountQuery(), { run_id: options.runId }, 'orphan_count');
    if (orphanCount > 0) {
      await client.command({
        query: buildRunFailedQuery(),
        query_params: {
          run_id: options.runId,
          error_message: `orphan queue rows detected: ${orphanCount}`,
        },
      });
      throw new Error(`orphan queue rows detected: ${orphanCount}`);
    }
  }

  for (const command of plan.afterOrphanCheck) {
    await client.command(command);
  }

  return { runId: options.runId, refreshId: options.refreshId, dryRun: false, status: 'completed' };
}

export function buildRefreshCollectionCountIncrementalPlan(options: RefreshCollectionCountIncrementalOptions): {
  beforeOrphanCheck: Array<{ query: string; query_params: Record<string, unknown>; clickhouse_settings?: Record<string, unknown> }>;
  afterOrphanCheck: Array<{ query: string; query_params: Record<string, unknown>; clickhouse_settings?: Record<string, unknown> }>;
} {
  const query_params = buildQueryParams(options);
  const settings = {
    max_threads: 1,
    max_insert_threads: 1,
    max_bytes_before_external_group_by: 268435456,
    max_bytes_before_external_sort: 268435456,
  };

  return {
    beforeOrphanCheck: [
      { query: buildReserveRunQuery(), query_params, clickhouse_settings: settings },
      { query: buildRawCandidateStageInsertQuery(), query_params, clickhouse_settings: settings },
      ...(options.skipOrphanCheck ? [] : [{ query: buildOrphanInsertQuery(), query_params, clickhouse_settings: settings }]),
    ],
    afterOrphanCheck: [
      { query: buildSameRunConflictInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildCrossRunConflictInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildCanonicalStageInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildCurrentStageDidKeysInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildCurrentStageRkeyKeysInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildCurrentStageAffectedCollectionsInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildCurrentStageHourKeysInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildEventSeenLogInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildCollectionDeltaInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildDidDeltaInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildRkeyDeltaInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildDidFirstSeenDeltaInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildRecentHourlyDeltaInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildDidSeenStateInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildRkeySeenStateInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildDidFirstSeenStateInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildRecentHourlyStateInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildSnapshotPublishInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildCumulativeUsersSnapshotInsertQuery(), query_params, clickhouse_settings: settings },
      { query: buildPublishValidationQuery(), query_params, clickhouse_settings: settings },
      { query: buildRunSnapshotWrittenQuery(), query_params, clickhouse_settings: settings },
      { query: buildLinearCommitGuardQuery(), query_params, clickhouse_settings: settings },
      { query: buildCompletedManifestInsertQuery(), query_params, clickhouse_settings: settings },
    ],
  };
}

function buildQueryParams(options: RefreshCollectionCountIncrementalOptions): Record<string, unknown> {
  return {
    run_id: options.runId,
    refresh_id: options.refreshId,
    safety_lag_seconds: options.safetyLagSeconds,
    max_rows: options.maxRows,
    max_queued_at_span_seconds: options.maxQueuedAtSpanSeconds,
    max_estimated_bytes: options.maxEstimatedBytes,
    excluded_did: options.excludedDid,
  };
}

async function readCount(
  client: ClickHouseCommandLike,
  query: string,
  query_params: Record<string, unknown>,
  field: string,
): Promise<number> {
  if (!client.query) {
    throw new Error('ClickHouse query method is required for incremental verification');
  }
  const response = await client.query<Record<string, unknown>>({ query, query_params, format: 'JSONEachRow' });
  const json = await response.json();
  const rows = Array.isArray(json) ? json : ((json as { data?: Record<string, unknown>[] }).data ?? []);
  const value = rows[0]?.[field];
  return Number(value ?? 0);
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
  const options = parseRefreshCollectionCountIncrementalOptions(process.argv.slice(2));
  const config = loadRefreshCollectionCountIncrementalConfig(process.env, { requireClickHouse: !options.dryRun });
  const { createClient } = await import('@clickhouse/client');
  const client = options.dryRun
    ? {
        async command() {},
        async query() {
          return { async json() { return { data: [] }; } };
        },
        async close() {},
      }
    : createClient({
        url: config.clickhouseUrl,
        username: config.clickhouseUsername ?? undefined,
        password: config.clickhousePassword ?? undefined,
        database: config.clickhouseDatabase,
        request_timeout: config.clickhouseRefreshTimeoutMs,
        clickhouse_settings: {
          send_progress_in_http_headers: 1,
          http_headers_progress_interval_ms: '30000',
        },
      });

  try {
    const result = await refreshCollectionCountIncremental(client, options);
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
