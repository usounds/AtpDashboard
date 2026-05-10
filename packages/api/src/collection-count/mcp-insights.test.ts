import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDailyChartBucketDays,
  parseMcpDailyUserDays,
  parseMcpDateRange,
  readAnalyticsChartSnapshotFromClickHouse,
  readCollectionsForNamespaceFromClickHouse,
  readDailyCollectionsFromClickHouse,
  readDailyUsersFromClickHouse,
  readEventCountsFromClickHouse,
  readNewCollectionsFromClickHouse,
  readUniqueDidCountFromClickHouse,
} from './mcp-insights.ts';
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
  assert.match(capturedQuery, /uniqExactIf\(event_key, created_at >= range_start_at AND created_at < range_end_at\) AS event_count/);
  assert.doesNotMatch(capturedQuery, /countIf\(created_at >= range_start_at AND created_at < range_end_at\) AS event_count/);
  assert.match(capturedQuery, /max\(created_at\) AS latest_record_created_at/);
  assert.match(capturedQuery, /argMax\(did, tuple\(created_at, event_key\)\) AS latest_record_did/);
  assert.match(capturedQuery, /argMax\(rkey, tuple\(created_at, event_key\)\) AS latest_record_rkey/);
  assert.doesNotMatch(capturedQuery, /LIMIT \{row_limit:UInt16\}/);
  assert.doesNotMatch(capturedQuery, /min\(ingested_at\) AS first_seen_ingested_at/);
});

test('parses explicit MCP date ranges from ISO, slash, and Japanese date strings', () => {
  assert.deepEqual(parseMcpDateRange({ startDate: '2026-05-01', endDate: '2026-05-10' }), {
    days: 0,
    startDate: '2026-05-01',
    endDate: '2026-05-10',
    startDateTime: '2026-05-01 00:00:00.000000',
    endExclusiveDateTime: '2026-05-11 00:00:00.000000',
  });
  assert.equal(parseMcpDateRange({ startDate: '2026/5/1', endDate: '2026年5月10日' }).endDate, '2026-05-10');
});

test('reads daily users as active and new DID series', async () => {
  let capturedQuery = '';
  let capturedQueryParams: Record<string, unknown> = {};
  const client: ClickHouseQueryClient = {
    async query(queryParams) {
      capturedQuery = queryParams.query;
      capturedQueryParams = queryParams.query_params ?? {};
      return {
        async json<T>() {
          return [
            {
              date: '2026-05-03',
              day_offset: -6,
              active: 4021,
              new: 350,
            },
          ] as T;
        },
      };
    },
  };

  const rows = await readDailyUsersFromClickHouse(client, { clickhouseTimeoutMs: 1000 }, { days: 7 });

  assert.equal(capturedQueryParams.days, 7);
  assert.equal(capturedQueryParams.bucket_count, 7);
  assert.equal(capturedQueryParams.bucket_days, 1);
  assert.equal(capturedQueryParams.bucket_seconds, 86400);
  assert.match(capturedQuery, /uniqExact\(did\) AS active/);
  assert.match(capturedQuery, /SELECT max\(created_at\)/);
  assert.match(capturedQuery, /toUInt16\(intDiv\(dateDiff\('second', created_at, latest_at\), bucket_seconds\)\) AS bucket_index/);
  assert.match(capturedQuery, /min\(created_at\) AS first_seen_at/);
  assert.match(capturedQuery, /first_seen_at > latest_at - toIntervalDay\(lookback_days\)/);
  assert.match(capturedQuery, /ORDER BY bucket_end_at ASC/);
  assert.deepEqual(rows, [
    {
      date: '2026-05-03',
      day_offset: -6,
      active: 4021,
      new: 350,
    },
  ]);
});

test('reads daily collections as active and new collection series', async () => {
  let capturedQuery = '';
  let capturedQueryParams: Record<string, unknown> = {};
  const client: ClickHouseQueryClient = {
    async query(queryParams) {
      capturedQuery = queryParams.query;
      capturedQueryParams = queryParams.query_params ?? {};
      return {
        async json<T>() {
          return [
            {
              date: '2026-05-09',
              day_offset: 0,
              active: 489,
              new: 31,
            },
          ] as T;
        },
      };
    },
  };

  const rows = await readDailyCollectionsFromClickHouse(client, { clickhouseTimeoutMs: 1000 }, { days: 30 });

  assert.equal(capturedQueryParams.days, 30);
  assert.equal(capturedQueryParams.bucket_count, 30);
  assert.equal(capturedQueryParams.bucket_days, 1);
  assert.equal(capturedQueryParams.bucket_seconds, 86400);
  assert.equal(capturedQueryParams.excluded_did, 'did:web:lexicon.store');
  assert.match(capturedQuery, /uniqExact\(collection\) AS active/);
  assert.match(capturedQuery, /collection,\n\s+min\(created_at\) AS first_seen_at/);
  assert.match(capturedQuery, /GROUP BY collection/);
  assert.match(capturedQuery, /coalesce\(new_collections\.new, 0\) AS new/);
  assert.match(capturedQuery, /ORDER BY bucket_end_at ASC/);
  assert.deepEqual(rows, [
    {
      date: '2026-05-09',
      day_offset: 0,
      active: 489,
      new: 31,
    },
  ]);
});

test('reads event counts as rolling bucket series', async () => {
  let capturedQuery = '';
  let capturedQueryParams: Record<string, unknown> = {};
  const client: ClickHouseQueryClient = {
    async query(queryParams) {
      capturedQuery = queryParams.query;
      capturedQueryParams = queryParams.query_params ?? {};
      return {
        async json<T>() {
          return [
            {
              date: '2026-05-09',
              day_offset: 0,
              count: 12345,
            },
          ] as T;
        },
      };
    },
  };

  const rows = await readEventCountsFromClickHouse(client, { clickhouseTimeoutMs: 1000 }, { days: 365, bucketDays: 30 });

  assert.equal(capturedQueryParams.days, 365);
  assert.equal(capturedQueryParams.bucket_count, 13);
  assert.equal(capturedQueryParams.bucket_days, 30);
  assert.equal(capturedQueryParams.bucket_seconds, 2592000);
  assert.match(capturedQuery, /uniqExact\(event_key\) AS count/);
  assert.doesNotMatch(capturedQuery, /count\(\) AS count/);
  assert.match(capturedQuery, /toUInt16\(intDiv\(dateDiff\('second', created_at, latest_at\), bucket_seconds\)\) AS bucket_index/);
  assert.match(capturedQuery, /ORDER BY bucket_end_at ASC/);
  assert.deepEqual(rows, [
    {
      date: '2026-05-09',
      day_offset: 0,
      count: 12345,
    },
  ]);
});

test('reads analytics chart snapshot rows from latest completed refresh', async () => {
  let capturedQuery = '';
  let capturedQueryParams: Record<string, unknown> = {};
  const client: ClickHouseQueryClient = {
    async query(queryParams) {
      capturedQuery = queryParams.query;
      capturedQueryParams = queryParams.query_params ?? {};
      return {
        async json<T>() {
          return [
            {
              refresh_id: '00000000-0000-4000-8000-000000000001',
              refreshed_at: '2026-05-10T02:00:00.000Z',
              snapshot_age_seconds: 180,
              date: '2026-05-09',
              day_offset: -1,
              active: 452,
              new: 18,
              count: 12000,
            },
            {
              refresh_id: '00000000-0000-4000-8000-000000000001',
              refreshed_at: '2026-05-10T02:00:00.000Z',
              snapshot_age_seconds: 180,
              date: '2026-05-10',
              day_offset: 0,
              active: 489,
              new: 31,
              count: 13500,
            },
          ] as T;
        },
      };
    },
  };

  const result = await readAnalyticsChartSnapshotFromClickHouse(client, { clickhouseTimeoutMs: 1000 }, {
    tool: 'daily_collections',
    days: 30,
    bucketDays: 1,
  });

  assert.match(capturedQuery, /analytics_chart_refresh_manifest/);
  assert.match(capturedQuery, /analytics_chart_snapshot/);
  assert.match(capturedQuery, /status = 'completed'/);
  assert.match(capturedQuery, /ORDER BY snapshot\.bucket_index DESC/);
  assert.deepEqual(capturedQueryParams, {
    tool: 'daily_collections',
    days: 30,
    bucket_days: 1,
  });
  assert.deepEqual(result, {
    refreshId: '00000000-0000-4000-8000-000000000001',
    refreshedAt: '2026-05-10T02:00:00.000Z',
    snapshotAgeSeconds: 180,
    rows: [
      {
        date: '2026-05-09',
        day_offset: -1,
        active: 452,
        new: 18,
        count: 12000,
      },
      {
        date: '2026-05-10',
        day_offset: 0,
        active: 489,
        new: 31,
        count: 13500,
      },
    ],
  });
});

test('rejects missing analytics chart snapshot', async () => {
  const client: ClickHouseQueryClient = {
    async query() {
      return {
        async json<T>() {
          return [] as T;
        },
      };
    },
  };

  await assert.rejects(
    () =>
      readAnalyticsChartSnapshotFromClickHouse(client, { clickhouseTimeoutMs: 1000 }, {
        tool: 'daily_users',
        days: 7,
        bucketDays: 1,
      }),
    /analytics chart snapshot is unavailable/,
  );
});

test('reads unique DID count from ClickHouse', async () => {
  let capturedQuery = '';
  const client: ClickHouseQueryClient = {
    async query(queryParams) {
      capturedQuery = queryParams.query;
      return {
        async json<T>() {
          return [
            {
              unique_did_count: 183165,
            },
          ] as T;
        },
      };
    },
  };

  const result = await readUniqueDidCountFromClickHouse(client, { clickhouseTimeoutMs: 1000 });

  assert.match(capturedQuery, /uniqExact\(did\) AS unique_did_count/);
  assert.match(capturedQuery, /FROM atp_dashboard\.collection_events/);
  assert.deepEqual(result, { unique_did_count: 183165 });
});

test('parses MCP daily user days up to one year', () => {
  assert.equal(parseMcpDailyUserDays(undefined), 7);
  assert.equal(parseMcpDailyUserDays('365'), 365);
  assert.throws(() => parseMcpDailyUserDays('366'), /between 1 and 365/);
});

test('parses daily chart bucket days for day and year modes', () => {
  assert.equal(parseDailyChartBucketDays(undefined), 1);
  assert.equal(parseDailyChartBucketDays('1'), 1);
  assert.equal(parseDailyChartBucketDays('30'), 30);
  assert.throws(() => parseDailyChartBucketDays('7'), /bucket_days must be 1 or 30/);
});

test('reads all observed collections under a namespace prefix', async () => {
  let capturedQuery = '';
  let capturedQueryParams: Record<string, unknown> = {};
  const client: ClickHouseQueryClient = {
    async query(queryParams) {
      capturedQuery = queryParams.query;
      capturedQueryParams = queryParams.query_params ?? {};
      return {
        async json<T>() {
          return [
            {
              collection: 'app.chavatar.schedules',
              first_seen_at: '2026-05-07T15:47:24.712000Z',
              last_seen_at: '2026-05-07T15:47:24.712000Z',
              event_count: 1,
              latest_record_created_at: '2026-05-07T15:47:24.712000Z',
              latest_record_did: 'did:plc:example',
              latest_record_rkey: 'self',
            },
          ] as T;
        },
      };
    },
  };

  const rows = await readCollectionsForNamespaceFromClickHouse(client, { clickhouseTimeoutMs: 1000 }, { namespacePrefix: 'app.chavatar' });

  assert.equal(capturedQueryParams.namespace_prefix, 'app.chavatar');
  assert.match(capturedQuery, /startsWith\(collection, concat\(\{namespace_prefix:String\}, '\.'\)\)/);
  assert.match(capturedQuery, /uniqExact\(event_key\) AS event_count/);
  assert.doesNotMatch(capturedQuery, /count\(\) AS event_count/);
  assert.deepEqual(rows, [
    {
      collection: 'app.chavatar.schedules',
      first_seen_at: '2026-05-07T15:47:24.712000Z',
      last_seen_at: '2026-05-07T15:47:24.712000Z',
      event_count: 1,
      latest_record_created_at: '2026-05-07T15:47:24.712000Z',
      latest_record_at_uri: 'at://did:plc:example/app.chavatar.schedules/self',
      latest_record_get_record_url:
        'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aexample&collection=app.chavatar.schedules&rkey=self',
    },
  ]);
});

test('rejects incomplete or reversed MCP date ranges', () => {
  assert.throws(() => parseMcpDateRange({ startDate: '2026-05-01' }), /start_date and end_date/);
  assert.throws(() => parseMcpDateRange({ startDate: '2026-05-10', endDate: '2026-05-01' }), /before or equal/);
  assert.throws(
    () => parseMcpDateRange({ days: 7, startDate: '2026-05-01', endDate: '2026-05-10' }),
    /days cannot be combined/,
  );
});
