import assert from 'node:assert/strict';
import test from 'node:test';
import { readNewCollectionsFromClickHouse } from './mcp-insights.ts';
import type { ClickHouseQueryClient } from './clickhouse.ts';

test('reads new collections by first record created_at instead of ingestion time', async () => {
  let capturedQuery = '';
  const client: ClickHouseQueryClient = {
    async query(queryParams) {
      capturedQuery = queryParams.query;
      return {
        async json<T>() {
          return [
            {
              collection: 'app.example.backfilled',
              first_seen_at: '2026-05-09T11:00:00.000000Z',
              event_count: 4,
              latest_record_created_at: '2026-05-09T11:30:00.000000Z',
              latest_record_did: 'did:plc:example',
              latest_record_rkey: '3lv4ouczo2b2a',
            },
          ] as T;
        },
      };
    },
  };

  const rows = await readNewCollectionsFromClickHouse(client, { clickhouseTimeoutMs: 1000 }, { days: 3 });

  assert.deepEqual(rows, [
    {
      collection: 'app.example.backfilled',
      first_seen_at: '2026-05-09T11:00:00.000000Z',
      event_count: 4,
      latest_record_created_at: '2026-05-09T11:30:00.000000Z',
      latest_record_at_uri: 'at://did:plc:example/app.example.backfilled/3lv4ouczo2b2a',
      latest_record_get_record_url:
        'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aexample&collection=app.example.backfilled&rkey=3lv4ouczo2b2a',
    },
  ]);
  assert.match(capturedQuery, /SELECT max\(created_at\)/);
  assert.match(capturedQuery, /WHERE isNotNull\(created_at\)/);
  assert.match(capturedQuery, /min\(created_at\) AS first_seen_created_at/);
  assert.match(capturedQuery, /WHERE first_seen_created_at > latest_at - toIntervalDay\(lookback_days\)/);
  assert.match(capturedQuery, /countIf\(created_at > latest_at - toIntervalDay\(lookback_days\)/);
  assert.match(capturedQuery, /max\(created_at\) AS latest_record_created_at/);
  assert.match(capturedQuery, /argMax\(did, tuple\(created_at, event_key\)\) AS latest_record_did/);
  assert.match(capturedQuery, /argMax\(rkey, tuple\(created_at, event_key\)\) AS latest_record_rkey/);
  assert.doesNotMatch(capturedQuery, /LIMIT \{row_limit:UInt16\}/);
  assert.doesNotMatch(capturedQuery, /min\(ingested_at\) AS first_seen_ingested_at/);
});
