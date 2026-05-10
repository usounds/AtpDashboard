import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectionCountApp } from './server.ts';
import type { CollectionCountApiConfig } from './config.ts';
import type { ClickHouseQueryClient } from './clickhouse.ts';

const baseConfig: CollectionCountApiConfig = {
  host: '127.0.0.1',
  port: 8787,
  publicBasePath: '/api/analytics',
  postgrestCollectionCountUrl: 'https://collectiondata.usounds.work/collection_count_view',
  clickhouseUrl: null,
  clickhouseDatabase: 'atp_dashboard',
  clickhouseUsername: null,
  clickhousePassword: null,
  allowedOrigins: ['https://atpdashboard.usounds.work'],
  trustedProxyCidrs: ['127.0.0.1/32'],
  trustForwardedHeaders: false,
  rateLimitRequestsPerMinute: 60,
  clickhouseTimeoutMs: 2000,
  apiTimeoutMs: 3000,
  snapshotMaxAgeSeconds: 1800,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerOpenMs: 60000,
  responseCacheTtlMs: 30000,
  forceCollectionCountFallback: false,
  nodeEnv: 'test',
};

const postgrestRows = [
  {
    collection: 'app.example.fallback',
    count: 10,
    recent_count: 2,
    min: '2026-05-01T00:00:00.000000Z',
    max: '2026-05-09T00:00:00.000000Z',
  },
];

const newCollectionGroupsFieldDescriptions = {
  namespace_prefix: 'Namespace group prefix for newly observed ATProto collection/NSID rows in this result.',
  collection_count: 'Number of newly observed NSIDs in this namespace group for the requested period.',
  group_first_seen_at:
    'Earliest first_seen_at timestamp among the newly observed NSIDs in this namespace group for the requested period.',
  first_seen_nsid_in_group:
    'Representative literal NSID first observed earliest within this namespace group for the requested period. This is not the complete list of NSIDs in the group.',
  event_count_since_group_first_seen:
    'Sum of observed events for the newly observed NSIDs in this namespace group since each NSID was first seen.',
};

const newCollectionGroupsResponseGuidance =
  'When presenting namespace_groups, describe first_seen_nsid_in_group as the representative NSID first observed within that group during the requested period, not as the full NSID list. Use collection_count to state how many NSIDs the group contains.';

test('serves healthz outside analytics base path', async () => {
  const app = createCollectionCountApp(baseConfig);

  const response = await app.request('/healthz');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.publicBasePath, '/api/analytics');
});

test('allows public CORS access for analytics routes', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: createFakeClickHouse({
        refreshRows: [
          {
            refresh_id: '00000000-0000-4000-8000-000000000011',
            completed_at: new Date().toISOString(),
            row_count: 0,
          },
        ],
        snapshotRows: [],
      }),
    },
  );

  const response = await app.request('/api/analytics/collection_count_view', {
    headers: {
      Origin: 'http://localhost:5174',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('serves collection_count_view from latest completed ClickHouse snapshot', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: createFakeClickHouse({
        refreshRows: [
          {
            refresh_id: '00000000-0000-4000-8000-000000000001',
            completed_at: new Date().toISOString(),
            row_count: 1,
          },
        ],
        snapshotRows: [
          {
            collection: 'app.example.post',
            count: 42,
            recent_count: 7,
            min: '2026-05-01T00:00:00.000000Z',
            max: '2026-05-09T00:00:00.123000Z',
            refresh_id: '00000000-0000-4000-8000-000000000001',
            refreshed_at: new Date().toISOString(),
          },
        ],
      }),
    },
  );

  const response = await app.request('/api/analytics/collection_count_view');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Data-Source'), 'clickhouse');
  assert.equal(response.headers.get('X-Fallback-Reason'), '');
  assert.equal(response.headers.get('X-Snapshot-Refresh-Id'), '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(body, [
    {
      collection: 'app.example.post',
      count: 42,
      recent_count: 7,
      min: '2026-05-01T00:00:00',
      max: '2026-05-09T00:00:00.123',
    },
  ]);
});

test('forced fallback skips ClickHouse and returns PostgREST-compatible rows', async () => {
  let clickhouseCalled = false;
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      forceCollectionCountFallback: true,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          clickhouseCalled = true;
          throw new Error('should not be called');
        },
      },
      fetch: createJsonFetch(postgrestRows),
    },
  );

  const response = await app.request('/api/analytics/collection_count_view');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Data-Source'), 'fallback');
  assert.equal(response.headers.get('X-Fallback-Reason'), 'forced_fallback');
  assert.equal(clickhouseCalled, false);
  assert.deepEqual(body, postgrestRows);
});

test('stale snapshot falls back to PostgREST', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
      snapshotMaxAgeSeconds: 1,
    },
    {
      clickhouse: createFakeClickHouse({
        refreshRows: [
          {
            refresh_id: '00000000-0000-4000-8000-000000000002',
            completed_at: '2026-01-01T00:00:00.000Z',
            row_count: 1,
          },
        ],
        snapshotRows: [],
      }),
      fetch: createJsonFetch(postgrestRows),
    },
  );

  const response = await app.request('/api/analytics/collection_count_view');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Data-Source'), 'fallback');
  assert.equal(response.headers.get('X-Fallback-Reason'), 'stale_snapshot');
  assert.deepEqual(body, postgrestRows);
});

test('clickhouse-only request fails instead of falling back', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
      snapshotMaxAgeSeconds: 1,
    },
    {
      clickhouse: createFakeClickHouse({
        refreshRows: [
          {
            refresh_id: '00000000-0000-4000-8000-000000000003',
            completed_at: '2026-01-01T00:00:00.000Z',
            row_count: 1,
          },
        ],
        snapshotRows: [],
      }),
      fetch: createJsonFetch(postgrestRows),
    },
  );

  const response = await app.request('/api/analytics/collection_count_view', {
    headers: {
      'X-Disable-Fallback': 'true',
    },
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('X-Data-Source'), 'unavailable');
  assert.equal(response.headers.get('X-Fallback-Reason'), 'stale_snapshot');
  assert.equal(body.error, 'unavailable');
});

test('returns 503 when ClickHouse and fallback both fail', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          throw new Error('ClickHouse down');
        },
      },
      fetch: async () => new Response('bad gateway', { status: 502 }),
    },
  );

  const response = await app.request('/api/analytics/collection_count_view');
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('X-Data-Source'), 'unavailable');
  assert.equal(response.headers.get('X-Fallback-Reason'), 'fallback_failed');
  assert.equal(response.headers.get('Retry-After'), '30');
  assert.equal(body.error, 'unavailable');
});

test('opens circuit breaker and uses circuit_open fallback after repeated ClickHouse failures', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
      circuitBreakerFailureThreshold: 1,
      responseCacheTtlMs: 0,
    },
    {
      clickhouse: {
        async query() {
          throw new Error('ClickHouse down');
        },
      },
      fetch: createJsonFetch(postgrestRows),
    },
  );

  const first = await app.request('/api/analytics/collection_count_view');
  const second = await app.request('/api/analytics/collection_count_view');
  const status = await app.request('/api/analytics/status');
  const statusBody = await status.json();

  assert.equal(first.headers.get('X-Fallback-Reason'), 'clickhouse_error');
  assert.equal(second.headers.get('X-Fallback-Reason'), 'circuit_open');
  assert.equal(statusBody.circuit_open, true);
});

test('caches successful response for collection_count_view', async () => {
  let queryCount = 0;
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
      responseCacheTtlMs: 30_000,
    },
    {
      clickhouse: {
        async query(queryParams) {
          queryCount += 1;
          const rows = queryParams.query.includes('collection_count_refresh_manifest')
            ? [
                {
                  refresh_id: '00000000-0000-4000-8000-000000000004',
                  completed_at: new Date().toISOString(),
                  row_count: 1,
                },
              ]
            : [
                {
                  collection: 'app.example.cached',
                  count: 1,
                  recent_count: 1,
                  min: null,
                  max: null,
                  refresh_id: '00000000-0000-4000-8000-000000000004',
                  refreshed_at: new Date().toISOString(),
                },
              ];
          return {
            async json<T>() {
              return rows as T;
            },
          };
        },
      },
    },
  );

  await app.request('/api/analytics/collection_count_view?select=*');
  await app.request('/api/analytics/collection_count_view?select=*');

  assert.equal(queryCount, 2);
});

test('reports forced fallback in status response', async () => {
  const app = createCollectionCountApp({
    ...baseConfig,
    forceCollectionCountFallback: true,
  });

  const response = await app.request('/api/analytics/status');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.mode, 'fallback');
  assert.equal(body.fallback_reason, 'forced_fallback');
});

test('serves daily summary routes from ClickHouse', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: createFakeClickHouse({
        refreshRows: [],
        snapshotRows: [],
        dailyRows: [
          { day: 1, count: 10 },
          { day: 2, count: 8 },
        ],
      }),
    },
  );

  const response = await app.request('/api/analytics/active_collection_summary_view?limit=2');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Data-Source'), 'clickhouse');
  assert.deepEqual(body, [
    { day: 1, count: 10 },
    { day: 2, count: 8 },
  ]);
});

test('serves cached MCP insight HTTP endpoints from ClickHouse', async () => {
  let queryCount = 0;
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          queryCount += 1;
          return {
            async json<T>() {
              return [
                {
                  collection: 'app.example.new',
                  first_seen_at: '2026-05-09T00:00:00.000000Z',
                  event_count: 3,
                  latest_record_created_at: '2026-05-09T00:30:00.000000Z',
                  latest_record_did: 'did:plc:example',
                  latest_record_rkey: 'r1',
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const first = await app.request('/api/analytics/mcp/new_collection_groups?days=7');
  const second = await app.request('/api/analytics/mcp/new_collection_groups?days=7');
  const body = await second.json();

  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.equal(queryCount, 1);
  assert.deepEqual(body, {
    lookback_days: 7,
    returned_nsid_count: 1,
    returned_group_count: 1,
    field_descriptions: newCollectionGroupsFieldDescriptions,
    response_guidance: newCollectionGroupsResponseGuidance,
    namespace_groups: [
      {
        namespace_prefix: 'app.example.*',
        collection_count: 1,
        group_first_seen_at: '2026-05-09T00:00:00.000000Z',
        first_seen_nsid_in_group: 'app.example.new',
        event_count_since_group_first_seen: 3,
      },
    ],
  });
});

test('serves cached daily collections chart endpoint from ClickHouse', async () => {
  let queryCount = 0;
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          queryCount += 1;
          return {
            async json<T>() {
              return [
                {
                  date: '2026-05-08',
                  day_offset: -1,
                  active: 452,
                  new: 18,
                },
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
      },
    },
  );

  const first = await app.request('/api/analytics/daily_collections?days=30');
  const second = await app.request('/api/analytics/daily_collections?days=30');
  const body = await second.json();

  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Data-Source'), 'clickhouse');
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(first.headers.get('X-Cache-Ttl-Seconds'), '600');
  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.equal(queryCount, 1);
  assert.deepEqual(body, {
    tool: 'daily_collections',
    parameters: {
      days: 30,
      bucket_days: 1,
    },
    rows: [
      {
        date: '2026-05-08',
        day_offset: -1,
        active: 452,
        new: 18,
      },
      {
        date: '2026-05-09',
        day_offset: 0,
        active: 489,
        new: 31,
      },
    ],
    cache: {
      status: 'HIT',
      key: 'daily_collections:days=30:bucket_days=1',
      ttl_seconds: 600,
    },
  });
});

test('serves daily users chart endpoint from ClickHouse', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [
                {
                  date: '2026-05-03',
                  day_offset: -6,
                  active: 4021,
                  new: 350,
                },
                {
                  date: '2026-05-09',
                  day_offset: 0,
                  active: 4265,
                  new: 410,
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/analytics/daily_users?days=7');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Data-Source'), 'clickhouse');
  assert.deepEqual(body.rows, [
    {
      date: '2026-05-03',
      day_offset: -6,
      active: 4021,
      new: 350,
    },
    {
      date: '2026-05-09',
      day_offset: 0,
      active: 4265,
      new: 410,
    },
  ]);
  assert.deepEqual(body.parameters, {
    days: 7,
    bucket_days: 1,
  });
});

test('serves yearly daily chart endpoint as 30 day buckets', async () => {
  let queryParams: Record<string, unknown> | null = null;
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query(params) {
          queryParams = params.query_params as Record<string, unknown>;
          return {
            async json<T>() {
              return [
                {
                  date: '2025-05-14',
                  day_offset: -360,
                  active: 100,
                  new: 10,
                },
                {
                  date: '2026-05-09',
                  day_offset: 0,
                  active: 150,
                  new: 12,
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/analytics/daily_users?days=365&bucket_days=30');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.parameters, {
    days: 365,
    bucket_days: 30,
  });
  assert.deepEqual(body.rows, [
    {
      date: '2025-05-14',
      day_offset: -360,
      active: 100,
      new: 10,
    },
    {
      date: '2026-05-09',
      day_offset: 0,
      active: 150,
      new: 12,
    },
  ]);
  assert.deepEqual(queryParams, {
    days: 365,
    bucket_count: 13,
    bucket_days: 30,
    bucket_seconds: 2592000,
  });
});

test('serves compact new collection groups HTTP endpoint', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [
                {
                  collection: 'cash.attoshi.utxo',
                  first_seen_at: '2026-05-09T11:45:23.006000Z',
                  event_count: 83,
                  latest_record_created_at: '2026-05-09T11:49:23.006000Z',
                  latest_record_did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
                  latest_record_rkey: '3lv4ouczo2b2a',
                },
                {
                  collection: 'cash.attoshi.tx',
                  first_seen_at: '2026-05-09T11:45:22.006000Z',
                  event_count: 42,
                  latest_record_created_at: '2026-05-09T11:48:22.006000Z',
                  latest_record_did: 'did:plc:tx',
                  latest_record_rkey: 'tx-rkey',
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/analytics/mcp/new_collection_groups?days=3');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    lookback_days: 3,
    returned_nsid_count: 2,
    returned_group_count: 1,
    field_descriptions: newCollectionGroupsFieldDescriptions,
    response_guidance: newCollectionGroupsResponseGuidance,
    namespace_groups: [
      {
        namespace_prefix: 'cash.attoshi.*',
        collection_count: 2,
        group_first_seen_at: '2026-05-09T11:45:22.006000Z',
        first_seen_nsid_in_group: 'cash.attoshi.tx',
        event_count_since_group_first_seen: 125,
      },
    ],
  });
});

test('does not serve removed new_collections HTTP endpoint', async () => {
  const app = createCollectionCountApp(baseConfig);

  const response = await app.request('/api/analytics/mcp/new_collections?days=7');
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.deepEqual(body, { error: 'not_found' });
});

test('serves compact new collection groups HTTP endpoint for explicit date range', async () => {
  let capturedQueryParams: Record<string, unknown> = {};
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query(queryParams) {
          capturedQueryParams = queryParams.query_params ?? {};
          return {
            async json<T>() {
              return [
                {
                  collection: 'app.example.new',
                  first_seen_at: '2026-05-10T03:00:00.000000Z',
                  event_count: 1,
                  latest_record_created_at: '2026-05-10T03:00:00.000000Z',
                  latest_record_did: 'did:plc:example',
                  latest_record_rkey: 'r1',
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/analytics/mcp/new_collection_groups?start_date=2026-05-01&end_date=2026-05-10');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(capturedQueryParams.has_explicit_date_range, 1);
  assert.equal(capturedQueryParams.start_at, '2026-05-01 00:00:00.000000');
  assert.equal(capturedQueryParams.end_exclusive_at, '2026-05-11 00:00:00.000000');
  assert.deepEqual(body, {
    start_date: '2026-05-01',
    end_date: '2026-05-10',
    returned_nsid_count: 1,
    returned_group_count: 1,
    field_descriptions: newCollectionGroupsFieldDescriptions,
    response_guidance: newCollectionGroupsResponseGuidance,
    namespace_groups: [
      {
        namespace_prefix: 'app.example.*',
        collection_count: 1,
        group_first_seen_at: '2026-05-10T03:00:00.000000Z',
        first_seen_nsid_in_group: 'app.example.new',
        event_count_since_group_first_seen: 1,
      },
    ],
  });
});

test('serves MCP tools/list and tools/call', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [
                {
                  date: '2026-05-08',
                  day_offset: -1,
                  active: 452,
                  new: 18,
                },
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
      },
    },
  );

  const listResponse = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const listBody = await listResponse.json();

  const callResponse = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'get_daily_collections',
        arguments: { days: 30 },
      },
    }),
  });
  const callBody = await callResponse.json();
  const parsedToolText = JSON.parse(callBody.result.content[0].text);

  assert.equal(listResponse.status, 200);
  assert.deepEqual(
    listBody.result.tools.map((tool: { name: string }) => tool.name),
    [
      'get_new_collection_groups',
      'get_collections_for_namespace',
      'get_daily_users',
      'get_daily_collections',
      'get_latest_record_for_collection',
    ],
  );
  assert.equal(Object.hasOwn(listBody.result.tools[0].inputSchema.properties, 'limit'), false);
  assert.match(listBody.result.tools[0].description, /生まれたNSID/);
  assert.match(listBody.result.tools[0].description, /この tool を優先/);
  assert.match(listBody.result.tools[0].inputSchema.properties.start_date.description, /start_date と end_date を同じ日/);
  assert.match(listBody.result.tools[0].inputSchema.properties.end_date.description, /namespace group として扱います/);
  assert.equal(Object.hasOwn(listBody.result.tools[1].inputSchema.properties, 'namespace_prefix'), true);
  assert.equal(Object.hasOwn(listBody.result.tools[2].inputSchema.properties, 'days'), true);
  assert.equal(Object.hasOwn(listBody.result.tools[3].inputSchema.properties, 'days'), true);
  assert.match(listBody.result.tools[2].description, /Daily Users/);
  assert.match(listBody.result.tools[2].description, /ユーザー推移/);
  assert.match(listBody.result.tools[3].description, /Daily Collections/);
  assert.equal(callResponse.status, 200);
  assert.equal(parsedToolText.tool, 'get_daily_collections');
  assert.equal(parsedToolText.intent, 'daily_collections_active_and_new_time_series');
  assert.equal(parsedToolText.result.chart_spec.title, 'Daily Collections');
  assert.deepEqual(parsedToolText.result.chart_spec.controls, [
    { label: 'This Week', days: 7 },
    { label: 'This Month', days: 30 },
    { label: 'This Year', days: 365 },
  ]);
  assert.deepEqual(parsedToolText.result.rows, [
    {
      date: '2026-05-08',
      day_offset: -1,
      active: 452,
      new: 18,
    },
    {
      date: '2026-05-09',
      day_offset: 0,
      active: 489,
      new: 31,
    },
  ]);
});

test('serves MCP get_daily_users as active and new user time series', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [
                {
                  date: '2026-05-03',
                  day_offset: -6,
                  active: 4021,
                  new: 350,
                },
                {
                  date: '2026-05-09',
                  day_offset: 0,
                  active: 4265,
                  new: 410,
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_daily_users',
        arguments: { days: 7 },
      },
    }),
  });
  const body = await response.json();
  const parsedToolText = JSON.parse(body.result.content[0].text);

  assert.equal(response.status, 200);
  assert.equal(parsedToolText.tool, 'get_daily_users');
  assert.equal(parsedToolText.intent, 'daily_users_active_and_new_time_series');
  assert.deepEqual(parsedToolText.parameters, { lookback_days: 7 });
  assert.equal(parsedToolText.result.primary_view, 'time_series_chart');
  assert.deepEqual(parsedToolText.result.period, {
    start_date: '2026-05-03',
    end_date: '2026-05-09',
    days: 2,
    timezone: 'UTC',
  });
  assert.deepEqual(parsedToolText.result.chart_spec, {
    type: 'line',
    title: 'Daily active and new users',
    x: {
      key: 'date',
      type: 'temporal',
      label: 'Date',
    },
    series: [
      {
        key: 'active',
        label: 'Active users',
        role: 'primary',
        color_hint: 'blue',
      },
      {
        key: 'new',
        label: 'New users',
        role: 'secondary',
        color_hint: 'green',
        interpretation_hint: 'Compare with active users to comment on acquisition spikes, dips, and whether new-user movement appears to align with overall activity.',
      },
    ],
    preferred_rendering: ['mermaid_xychart', 'markdown_table'],
  });
  assert.match(parsedToolText.result.response_guidance, /also plot new users/);
  assert.match(parsedToolText.result.response_guidance, /may proactively add concise analysis/);
  assert.deepEqual(parsedToolText.result.rows, [
    {
      date: '2026-05-03',
      day_offset: -6,
      active: 4021,
      new: 350,
    },
    {
      date: '2026-05-09',
      day_offset: 0,
      active: 4265,
      new: 410,
    },
  ]);
  assert.deepEqual(parsedToolText.result.summary, {
    active_peak: 4265,
    new_peak: 410,
    active_average: 4143,
    new_total: 760,
  });
});

test('rejects removed MCP get_new_collections tool', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [
                {
                  collection: 'cash.attoshi.utxo',
                  first_seen_at: '2026-05-09T11:45:23.006000Z',
                  event_count: 83,
                  latest_record_created_at: '2026-05-09T11:49:23.006000Z',
                  latest_record_did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
                  latest_record_rkey: '3lv4ouczo2b2a',
                },
                {
                  collection: 'cash.attoshi.tx',
                  first_seen_at: '2026-05-09T11:45:22.006000Z',
                  event_count: 42,
                  latest_record_created_at: '2026-05-09T11:48:22.006000Z',
                  latest_record_did: 'did:plc:tx',
                  latest_record_rkey: 'tx-rkey',
                },
                {
                  collection: 'app.example.new',
                  first_seen_at: '2026-05-09T11:45:24.006000Z',
                  event_count: 1,
                  latest_record_created_at: '2026-05-09T11:46:24.006000Z',
                  latest_record_did: 'did:plc:new',
                  latest_record_rkey: 'new-rkey',
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_new_collections',
        arguments: { days: 3 },
      },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.error.code, -32602);
  assert.equal(body.error.message, 'Unknown tool');
});

test('rejects removed MCP get_active_collections tool', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_active_collections',
        arguments: { days: 7 },
      },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.error.code, -32602);
  assert.equal(body.error.message, 'Unknown tool');
});

test('serves all MCP get_new_collection_groups namespace groups', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    collection: `app.group${String(index).padStart(2, '0')}.record`,
    first_seen_at: `2026-05-09T11:${String(index).padStart(2, '0')}:00.000000Z`,
    event_count: index + 1,
    latest_record_created_at: `2026-05-09T11:${String(index).padStart(2, '0')}:30.000000Z`,
    latest_record_did: `did:plc:group${index}`,
    latest_record_rkey: `rkey-${index}`,
  }));
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return rows as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_new_collection_groups',
        arguments: { days: 3 },
      },
    }),
  });
  const body = await response.json();
  const parsedToolText = JSON.parse(body.result.content[0].text);

  assert.equal(response.status, 200);
  assert.equal(parsedToolText.result.returned_group_count, 12);
  assert.equal(parsedToolText.result.namespace_groups.length, 12);
  assert.deepEqual(
    new Set(parsedToolText.result.namespace_groups.map((group: { namespace_prefix: string }) => group.namespace_prefix)),
    new Set(rows.map((row) => row.collection.replace(/\.record$/, '.*'))),
  );
});

test('serves compact MCP get_new_collection_groups without samples or record pointers', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [
                {
                  collection: 'cash.attoshi.utxo',
                  first_seen_at: '2026-05-09T11:45:23.006000Z',
                  event_count: 83,
                  latest_record_created_at: '2026-05-09T11:49:23.006000Z',
                  latest_record_did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
                  latest_record_rkey: '3lv4ouczo2b2a',
                },
                {
                  collection: 'cash.attoshi.tx',
                  first_seen_at: '2026-05-09T11:45:22.006000Z',
                  event_count: 42,
                  latest_record_created_at: '2026-05-09T11:48:22.006000Z',
                  latest_record_did: 'did:plc:tx',
                  latest_record_rkey: 'tx-rkey',
                },
                {
                  collection: 'app.example.new',
                  first_seen_at: '2026-05-09T11:45:24.006000Z',
                  event_count: 1,
                  latest_record_created_at: '2026-05-09T11:46:24.006000Z',
                  latest_record_did: 'did:plc:new',
                  latest_record_rkey: 'new-rkey',
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_new_collection_groups',
        arguments: { days: 3 },
      },
    }),
  });
  const body = await response.json();
  const parsedToolText = JSON.parse(body.result.content[0].text);

  assert.equal(response.status, 200);
  assert.equal(parsedToolText.tool, 'get_new_collection_groups');
  assert.equal(parsedToolText.intent, 'newly_observed_namespace_groups_compact');
  assert.equal(parsedToolText.result.returned_nsid_count, 3);
  assert.equal(parsedToolText.result.returned_group_count, 2);
  assert.match(
    parsedToolText.result.field_descriptions.first_seen_nsid_in_group,
    /Representative literal NSID first observed earliest within this namespace group/,
  );
  assert.match(parsedToolText.result.response_guidance, /not as the full NSID list/);
  assert.deepEqual(parsedToolText.result.namespace_groups, [
    {
      namespace_prefix: 'cash.attoshi.*',
      collection_count: 2,
      group_first_seen_at: '2026-05-09T11:45:22.006000Z',
      first_seen_nsid_in_group: 'cash.attoshi.tx',
      event_count_since_group_first_seen: 125,
    },
    {
      namespace_prefix: 'app.example.*',
      collection_count: 1,
      group_first_seen_at: '2026-05-09T11:45:24.006000Z',
      first_seen_nsid_in_group: 'app.example.new',
      event_count_since_group_first_seen: 1,
    },
  ]);
  assert.equal(Object.hasOwn(parsedToolText.result.namespace_groups[0], 'sample_nsids'), false);
  assert.equal(Object.hasOwn(parsedToolText.result.namespace_groups[0], 'latest_record'), false);
});

test('serves MCP get_collections_for_namespace with all observed child NSIDs', async () => {
  let capturedQueryParams: Record<string, unknown> = {};
  const lexiconFetchCalls: string[] = [];
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query(params) {
          capturedQueryParams = params.query_params ?? {};
          return {
            async json<T>() {
              return [
                {
                  collection: 'app.chavatar.avatar',
                  first_seen_at: '2026-04-29T00:36:59.668000Z',
                  last_seen_at: '2026-05-07T15:40:00.000000Z',
                  event_count: 12,
                  latest_record_created_at: '2026-05-07T15:40:00.000000Z',
                  latest_record_did: 'did:plc:avatar',
                  latest_record_rkey: 'avatar-rkey',
                },
                {
                  collection: 'app.chavatar.schedules',
                  first_seen_at: '2026-05-07T15:47:24.712000Z',
                  last_seen_at: '2026-05-07T15:47:24.712000Z',
                  event_count: 1,
                  latest_record_created_at: '2026-05-07T15:47:24.712000Z',
                  latest_record_did: 'did:plc:schedule',
                  latest_record_rkey: 'self',
                },
              ] as T;
            },
          };
        },
      },
      fetch: createLexiconFetch(
        {
          did: 'did:plc:lexicon',
          serviceEndpoint: 'https://pds.example',
          lexicons: {
            'app.chavatar.avatar': {
              lexicon: 1,
              id: 'app.chavatar.avatar',
              defs: {
                main: {
                  type: 'record',
                  description: 'Avatar metadata',
                  key: 'tid',
                  record: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                      name: { type: 'string', description: 'Avatar name' },
                      image: { type: 'blob' },
                    },
                  },
                },
              },
            },
            'app.chavatar.schedules': {
              lexicon: 1,
              id: 'app.chavatar.schedules',
              defs: {
                main: {
                  type: 'record',
                  description: 'Schedule settings',
                  key: 'literal:self',
                  record: {
                    type: 'object',
                    required: ['enabled'],
                    properties: {
                      enabled: { type: 'boolean', description: 'Whether schedules are enabled' },
                      entries: { type: 'array', items: { type: 'ref', ref: '#schedule' } },
                    },
                  },
                },
                schedule: {
                  type: 'object',
                  properties: {
                    startsAt: { type: 'string', format: 'datetime' },
                  },
                },
              },
            },
          },
        },
        lexiconFetchCalls,
      ),
    },
  );

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_collections_for_namespace',
        arguments: { namespace_prefix: 'app.chavatar.*' },
      },
    }),
  });
  const body = await response.json();
  const parsedToolText = JSON.parse(body.result.content[0].text);

  assert.equal(response.status, 200);
  assert.equal(capturedQueryParams.namespace_prefix, 'app.chavatar');
  assert.equal(parsedToolText.tool, 'get_collections_for_namespace');
  assert.equal(parsedToolText.intent, 'observed_nsids_under_namespace_prefix_with_lexicon_schema');
  assert.equal(parsedToolText.raw_record_display_policy.raw_record_json_inline_forbidden, true);
  assert.match(parsedToolText.raw_record_display_policy.instruction, /Do not display raw record JSON inline/);
  assert.match(parsedToolText.raw_record_display_policy.pds_ls_instruction, /pds\.ls/);
  assert.equal(parsedToolText.lexicon_policy.lexicon_json_allowed_for_schema_understanding, true);
  assert.match(parsedToolText.lexicon_policy.instruction, /Actual record data JSON must never/);
  assert.match(parsedToolText.lexicon_policy.response_guidance, /Do not mention resolver internals/);
  assert.deepEqual(parsedToolText.parameters, { namespace_prefix: 'app.chavatar' });
  assert.equal(parsedToolText.result.returned_nsid_count, 2);
  assert.deepEqual(
    parsedToolText.result.nsids.map((row: { collection: string }) => row.collection),
    ['app.chavatar.avatar', 'app.chavatar.schedules'],
  );
  assert.deepEqual(parsedToolText.result.nsids[1].latest_record, {
    created_at: '2026-05-07T15:47:24.712000Z',
    at_uri: 'at://did:plc:schedule/app.chavatar.schedules/self',
    pds_ls_url: 'https://pds.ls/at://did:plc:schedule/app.chavatar.schedules/self',
    get_record_url: 'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aschedule&collection=app.chavatar.schedules&rkey=self',
    guidance: 'Do not fetch or paste raw record JSON inline. Send the user to pds_ls_url to inspect actual data.',
  });
  assert.equal(parsedToolText.result.nsids[1].lexicon.schema_available, true);
  assert.match(parsedToolText.result.nsids[1].lexicon.summary, /schema is available/);
  assert.equal(parsedToolText.result.nsids[1].lexicon.lexicon_record_url, 'https://pds.example/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Alexicon&collection=com.atproto.lexicon.schema&rkey=app.chavatar.schedules');
  assert.equal('status' in parsedToolText.result.nsids[1].lexicon, false);
  assert.equal('dns_name' in parsedToolText.result.nsids[1].lexicon, false);
  assert.equal(parsedToolText.result.nsids[1].lexicon.schema.id, 'app.chavatar.schedules');
  assert.equal(parsedToolText.result.nsids[1].lexicon.schema.defs.main.description, 'Schedule settings');
  assert.deepEqual(parsedToolText.result.nsids[1].lexicon.schema.defs.main.record.required, ['enabled']);
  assert.equal(parsedToolText.result.nsids[1].lexicon.schema.defs.main.record.properties.entries.items.ref, '#schedule');
  assert.equal(lexiconFetchCalls.filter((url) => url === 'https://plc.directory/did%3Aplc%3Alexicon').length, 1);
});

test('serves MCP get_latest_record_for_collection with pds.ls guidance only', async () => {
  let fetched = false;
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [
                {
                  collection: 'app.bsky.feed.like',
                  created_at: '2026-05-09T11:49:23.006000Z',
                  did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
                  rkey: '3lv4ouczo2b2a',
                },
              ] as T;
            },
          };
        },
      },
      fetch: (async () => {
        fetched = true;
        return new Response('{}');
      }) as typeof fetch,
    },
  );

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_latest_record_for_collection',
        arguments: { collection: 'app.bsky.feed.like' },
      },
    }),
  });
  const body = await response.json();
  const parsedToolText = JSON.parse(body.result.content[0].text);

  assert.equal(response.status, 200);
  assert.equal(fetched, false);
  assert.equal(parsedToolText.tool, 'get_latest_record_for_collection');
  assert.equal(parsedToolText.intent, 'guide_to_latest_record_on_pds_ls');
  assert.equal(parsedToolText.raw_record_display_policy.raw_record_json_inline_forbidden, true);
  assert.match(parsedToolText.raw_record_display_policy.instruction, /Never fetch and paste/);
  assert.match(parsedToolText.raw_record_display_policy.pds_ls_instruction, /実データ/);
  assert.equal(parsedToolText.collection, 'app.bsky.feed.like');
  assert.equal(parsedToolText.found, true);
  assert.deepEqual(parsedToolText.latest_record, {
    collection: 'app.bsky.feed.like',
    created_at: '2026-05-09T11:49:23.006000Z',
    at_uri: 'at://did:plc:hdhoaan3xa3jiuq4fg4mefid/app.bsky.feed.like/3lv4ouczo2b2a',
    pds_ls_url: 'https://pds.ls/at://did:plc:hdhoaan3xa3jiuq4fg4mefid/app.bsky.feed.like/3lv4ouczo2b2a',
  });
  assert.equal(
    parsedToolText.guidance,
    'Do not display the raw record JSON inline in chat. Open https://pds.ls/at://did:plc:hdhoaan3xa3jiuq4fg4mefid/app.bsky.feed.like/3lv4ouczo2b2a on pds.ls to inspect the actual record data outside the LLM conversation. If asked for 実データ, provide this pds.ls URL, not pasted JSON.',
  );
  assert.equal(Object.hasOwn(parsedToolText, 'record_json'), false);
  assert.equal(Object.hasOwn(parsedToolText, 'get_record_error'), false);
});

test('serves MCP get_latest_record_for_collection with found false when no record exists', async () => {
  const app = createCollectionCountApp(
    {
      ...baseConfig,
      clickhouseUrl: 'http://localhost:8123',
    },
    {
      clickhouse: {
        async query() {
          return {
            async json<T>() {
              return [] as T;
            },
          };
        },
      },
    },
  );

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_latest_record_for_collection',
        arguments: { collection: 'app.example.missing' },
      },
    }),
  });
  const body = await response.json();
  const parsedToolText = JSON.parse(body.result.content[0].text);

  assert.equal(response.status, 200);
  assert.equal(parsedToolText.found, false);
  assert.equal(parsedToolText.latest_record, null);
  assert.equal(Object.hasOwn(parsedToolText, 'record_json'), false);
  assert.equal(Object.hasOwn(parsedToolText, 'get_record_error'), false);
});

test('serves MCP get_latest_record_for_collection invalid collection as invalid params', async () => {
  const app = createCollectionCountApp(baseConfig);

  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_latest_record_for_collection',
        arguments: { collection: '   ' },
      },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.error.code, -32602);
  assert.equal(body.error.message, 'collection must be a non-empty string');
});

function createFakeClickHouse(params: { refreshRows: unknown[]; snapshotRows: unknown[]; dailyRows?: unknown[] }): ClickHouseQueryClient {
  return {
    async query(queryParams) {
      const rows = queryParams.query.includes('collection_count_refresh_manifest')
        ? params.refreshRows
        : queryParams.query.includes('collection_count_snapshot')
          ? params.snapshotRows
          : (params.dailyRows ?? []);
      return {
        async json<T>() {
          return rows as T;
        },
      };
    },
  };
}

function createJsonFetch(value: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
}

function createLexiconFetch(
  options: {
    did: string;
    serviceEndpoint: string;
    lexicons: Record<string, unknown>;
  },
  calls: string[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://dns.google/resolve?')) {
      return jsonResponse({
        Answer: [
          {
            data: `"did=${options.did}"`,
          },
        ],
      });
    }
    if (url === `https://plc.directory/${encodeURIComponent(options.did)}`) {
      return jsonResponse({
        service: [
          {
            id: '#atproto_pds',
            serviceEndpoint: options.serviceEndpoint,
          },
        ],
      });
    }
    if (url.startsWith(`${options.serviceEndpoint}/xrpc/com.atproto.repo.getRecord?`)) {
      const parsed = new URL(url);
      const rkey = parsed.searchParams.get('rkey');
      const lexicon = rkey == null ? null : options.lexicons[rkey];
      if (!lexicon) {
        return new Response('{}', { status: 404 });
      }
      return jsonResponse({ value: lexicon });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
