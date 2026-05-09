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
                },
              ] as T;
            },
          };
        },
      },
    },
  );

  const first = await app.request('/api/analytics/mcp/new_collections?days=7&limit=30');
  const second = await app.request('/api/analytics/mcp/new_collections?days=7&limit=30');
  const body = await second.json();

  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.equal(queryCount, 1);
  assert.deepEqual(body, [
    {
      collection: 'app.example.new',
      first_seen_at: '2026-05-09T00:00:00.000000Z',
      event_count: 3,
    },
  ]);
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
                  collection: 'app.example.active',
                  event_count: 9,
                  first_seen_at: '2026-05-08T00:00:00.000000Z',
                  last_seen_at: '2026-05-09T00:00:00.000000Z',
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
        name: 'get_active_collections',
        arguments: { days: 7, limit: 30 },
      },
    }),
  });
  const callBody = await callResponse.json();
  const parsedToolText = JSON.parse(callBody.result.content[0].text);

  assert.equal(listResponse.status, 200);
  assert.deepEqual(
    listBody.result.tools.map((tool: { name: string }) => tool.name),
    ['get_new_collections', 'get_active_collections'],
  );
  assert.equal(callResponse.status, 200);
  assert.deepEqual(parsedToolText.data, [
    {
      collection: 'app.example.active',
      event_count: 9,
      first_seen_at: '2026-05-08T00:00:00.000000Z',
      last_seen_at: '2026-05-09T00:00:00.000000Z',
    },
  ]);
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
