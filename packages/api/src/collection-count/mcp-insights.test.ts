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
    },
  ]);
  assert.match(capturedQuery, /SELECT max\(ingested_at\)/);
  assert.match(capturedQuery, /min\(ingested_at\) AS first_seen_ingested_at/);
  assert.match(capturedQuery, /WHERE first_seen_ingested_at > latest_at - toIntervalDay\(lookback_days\)/);
  assert.match(capturedQuery, /countIf\(ingested_at > latest_at - toIntervalDay\(lookback_days\)/);
  assert.doesNotMatch(capturedQuery, /min\(created_at\) AS first_seen_at/);
});
