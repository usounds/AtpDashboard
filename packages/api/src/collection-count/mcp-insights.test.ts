import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMcpDateRange, readNewCollectionsFromClickHouse } from './mcp-insights.ts';
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
  assert.match(capturedQuery, /parseDateTime64BestEffort\(\{start_at:String\}, 6, 'UTC'\)/);
  assert.match(capturedQuery, /parseDateTime64BestEffort\(\{end_exclusive_at:String\}, 6, 'UTC'\)/);
  assert.match(capturedQuery, /WHERE first_seen_created_at >= range_start_at/);
  assert.match(capturedQuery, /AND first_seen_created_at < range_end_at/);
  assert.match(capturedQuery, /countIf\(created_at >= range_start_at AND created_at < range_end_at\)/);
  assert.match(capturedQuery, /max\(created_at\) AS latest_record_created_at/);
  assert.match(capturedQuery, /argMax\(did, tuple\(created_at, event_key\)\) AS latest_record_did/);
  assert.match(capturedQuery, /argMax\(rkey, tuple\(created_at, event_key\)\) AS latest_record_rkey/);
  assert.doesNotMatch(capturedQuery, /LIMIT \{row_limit:UInt16\}/);
  assert.doesNotMatch(capturedQuery, /min\(ingested_at\) AS first_seen_ingested_at/);
});

test('parses explicit MCP date ranges from ISO, slash, and Japanese date strings', () => {
  assert.deepEqual(parseMcpDateRange({ startDate: '2026-05-01', endDate: '2026-05-10' }), {
    days: 7,
    startDate: '2026-05-01',
    endDate: '2026-05-10',
    startDateTime: '2026-05-01 00:00:00.000000',
    endExclusiveDateTime: '2026-05-11 00:00:00.000000',
  });
  assert.equal(parseMcpDateRange({ startDate: '2026/5/1', endDate: '2026年5月10日' }).endDate, '2026-05-10');
});

test('rejects incomplete or reversed MCP date ranges', () => {
  assert.throws(() => parseMcpDateRange({ startDate: '2026-05-01' }), /start_date and end_date/);
  assert.throws(() => parseMcpDateRange({ startDate: '2026-05-10', endDate: '2026-05-01' }), /before or equal/);
});
