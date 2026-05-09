import assert from 'node:assert/strict';
import test from 'node:test';
import { readNewCollectionsFromClickHouse } from './mcp-insights.ts';
import type { ClickHouseQueryClient } from './clickhouse.ts';

test('reads new collections by first ingestion time instead of record created_at', async () => {
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
              last_indexed_at: '2026-05-09T11:30:00.000000Z',
              last_indexed_did: 'did:plc:example',
              last_indexed_rkey: '3lv4ouczo2b2a',
            },
          ] as T;
        },
      };
    },
  };

  const rows = await readNewCollectionsFromClickHouse(client, { clickhouseTimeoutMs: 1000 }, { days: 3, limit: 20 });

  assert.deepEqual(rows, [
    {
      collection: 'app.example.backfilled',
      first_seen_at: '2026-05-09T11:00:00.000000Z',
      event_count: 4,
      last_indexed_at: '2026-05-09T11:30:00.000000Z',
      last_indexed_at_uri: 'at://did:plc:example/app.example.backfilled/3lv4ouczo2b2a',
      last_indexed_get_record_url:
        'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aexample&collection=app.example.backfilled&rkey=3lv4ouczo2b2a&cid=',
    },
  ]);
  assert.match(capturedQuery, /SELECT max\(ingested_at\)/);
  assert.match(capturedQuery, /min\(ingested_at\) AS first_seen_ingested_at/);
  assert.match(capturedQuery, /WHERE first_seen_ingested_at > latest_at - toIntervalDay\(lookback_days\)/);
  assert.match(capturedQuery, /countIf\(ingested_at > latest_at - toIntervalDay\(lookback_days\)/);
  assert.match(capturedQuery, /argMax\(did, tuple\(ingested_at, event_key\)\) AS last_indexed_did/);
  assert.match(capturedQuery, /argMax\(rkey, tuple\(ingested_at, event_key\)\) AS last_indexed_rkey/);
  assert.doesNotMatch(capturedQuery, /min\(created_at\) AS first_seen_at/);
});
