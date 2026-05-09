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
                  last_indexed_at: '2026-05-09T00:30:00.000000Z',
                  last_indexed_did: 'did:plc:example',
                  last_indexed_rkey: 'r1',
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
      last_indexed_at: '2026-05-09T00:30:00.000000Z',
      last_indexed_at_uri: 'at://did:plc:example/app.example.new/r1',
      last_indexed_get_record_url:
        'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aexample&collection=app.example.new&rkey=r1',
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
    ['get_new_collections', 'get_active_collections', 'get_latest_record_for_collection'],
  );
  assert.equal(callResponse.status, 200);
  assert.equal(Object.hasOwn(parsedToolText, 'summary'), false);
  assert.equal(Object.hasOwn(parsedToolText, 'display_hint'), false);
  assert.deepEqual(parsedToolText.data, [
    {
      collection: 'app.example.active',
      event_count: 9,
      first_seen_at: '2026-05-08T00:00:00.000000Z',
      last_seen_at: '2026-05-09T00:00:00.000000Z',
    },
  ]);
});

test('serves MCP get_new_collections with namespace-group-first response shape', async () => {
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
                  last_indexed_at: '2026-05-09T11:49:23.006000Z',
                  last_indexed_did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
                  last_indexed_rkey: '3lv4ouczo2b2a',
                },
                {
                  collection: 'cash.attoshi.tx',
                  first_seen_at: '2026-05-09T11:45:22.006000Z',
                  event_count: 42,
                  last_indexed_at: '2026-05-09T11:48:22.006000Z',
                  last_indexed_did: 'did:plc:tx',
                  last_indexed_rkey: 'tx-rkey',
                },
                {
                  collection: 'app.example.new',
                  first_seen_at: '2026-05-09T11:45:24.006000Z',
                  event_count: 1,
                  last_indexed_at: '2026-05-09T11:46:24.006000Z',
                  last_indexed_did: 'did:plc:new',
                  last_indexed_rkey: 'new-rkey',
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
        arguments: { days: 3, limit: 100 },
      },
    }),
  });
  const body = await response.json();
  const parsedToolText = JSON.parse(body.result.content[0].text);

  assert.equal(response.status, 200);
  assert.equal(parsedToolText.tool, 'get_new_collections');
  assert.equal(parsedToolText.intent, 'newly_observed_namespace_groups');
  assert.deepEqual(parsedToolText.parameters, { lookback_days: 3, limit: 100 });
  assert.equal(Object.hasOwn(parsedToolText, 'display_hint'), false);
  assert.equal(Object.hasOwn(parsedToolText, 'summary'), false);
  assert.equal(Object.hasOwn(parsedToolText.result, 'newly_observed_nsids'), false);
  assert.equal(parsedToolText.result.primary_view, 'namespace_groups');
  assert.deepEqual(parsedToolText.result.primary_order, [
    'collection_count desc',
    'group_first_seen_at desc',
    'event_count_since_group_first_seen desc',
    'namespace_prefix asc',
  ]);
  assert.equal(parsedToolText.result.returned_nsid_count, 3);
  assert.equal(parsedToolText.result.full_nsid_list_omitted, true);
  assert.deepEqual(parsedToolText.result.recent_newly_observed_sample[0], {
    collection: 'cash.attoshi.utxo',
    nsid_first_seen_at: '2026-05-09T11:45:23.006000Z',
    event_count_since_nsid_first_seen: 83,
    last_indexed_record: {
      indexed_at: '2026-05-09T11:49:23.006000Z',
      at_uri: 'at://did:plc:hdhoaan3xa3jiuq4fg4mefid/cash.attoshi.utxo/3lv4ouczo2b2a',
      get_record_url:
        'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Ahdhoaan3xa3jiuq4fg4mefid&collection=cash.attoshi.utxo&rkey=3lv4ouczo2b2a',
    },
  });
  assert.equal(Object.hasOwn(parsedToolText.result.recent_newly_observed_sample[0], 'first_seen_at'), false);
  assert.equal(Object.hasOwn(parsedToolText.result.recent_newly_observed_sample[0], 'event_count'), false);
  assert.deepEqual(parsedToolText.result.namespace_groups.find((group: { namespace_prefix: string }) => group.namespace_prefix === 'cash.attoshi.*'), {
    namespace_prefix: 'cash.attoshi.*',
    group_first_seen_at: '2026-05-09T11:45:22.006000Z',
    first_seen_nsid_in_group: 'cash.attoshi.tx',
    collection_count: 2,
    event_count_since_group_first_seen: 125,
    sample_nsids: [
      {
        collection: 'cash.attoshi.utxo',
        nsid_first_seen_at: '2026-05-09T11:45:23.006000Z',
        event_count_since_nsid_first_seen: 83,
        last_indexed_record: {
          indexed_at: '2026-05-09T11:49:23.006000Z',
          at_uri: 'at://did:plc:hdhoaan3xa3jiuq4fg4mefid/cash.attoshi.utxo/3lv4ouczo2b2a',
          get_record_url:
            'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Ahdhoaan3xa3jiuq4fg4mefid&collection=cash.attoshi.utxo&rkey=3lv4ouczo2b2a',
        },
      },
      {
        collection: 'cash.attoshi.tx',
        nsid_first_seen_at: '2026-05-09T11:45:22.006000Z',
        event_count_since_nsid_first_seen: 42,
        last_indexed_record: {
          indexed_at: '2026-05-09T11:48:22.006000Z',
          at_uri: 'at://did:plc:tx/cash.attoshi.tx/tx-rkey',
          get_record_url: 'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Atx&collection=cash.attoshi.tx&rkey=tx-rkey',
        },
      },
    ],
  });
  assert.equal(
    Object.hasOwn(
      parsedToolText.result.namespace_groups.find((group: { namespace_prefix: string }) => group.namespace_prefix === 'cash.attoshi.*'),
      'nsid_first_seen_at',
    ),
    false,
  );
  assert.equal(Object.hasOwn(parsedToolText.result, 'top_by_event_count'), false);
  assert.equal(Object.hasOwn(parsedToolText.result, 'latest_first_seen'), false);
});

test('serves MCP get_latest_record_for_collection with record JSON', async () => {
  let fetchedUrl = '';
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
                  indexed_at: '2026-05-09T11:49:23.006000Z',
                  did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
                  rkey: '3lv4ouczo2b2a',
                },
              ] as T;
            },
          };
        },
      },
      fetch: (async (input: RequestInfo | URL) => {
        fetchedUrl = String(input);
        return new Response(
          JSON.stringify({
            uri: 'at://did:plc:hdhoaan3xa3jiuq4fg4mefid/app.bsky.feed.like/3lv4ouczo2b2a',
            value: {
              $type: 'app.bsky.feed.like',
              subject: {
                uri: 'at://did:plc:example/app.bsky.feed.post/r1',
              },
            },
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );
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
  assert.equal(
    fetchedUrl,
    'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Ahdhoaan3xa3jiuq4fg4mefid&collection=app.bsky.feed.like&rkey=3lv4ouczo2b2a',
  );
  assert.equal(parsedToolText.tool, 'get_latest_record_for_collection');
  assert.equal(parsedToolText.intent, 'show_latest_record_json_for_nsid');
  assert.equal(parsedToolText.collection, 'app.bsky.feed.like');
  assert.equal(parsedToolText.found, true);
  assert.deepEqual(parsedToolText.latest_indexed_record, {
    collection: 'app.bsky.feed.like',
    indexed_at: '2026-05-09T11:49:23.006000Z',
    did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
    rkey: '3lv4ouczo2b2a',
    at_uri: 'at://did:plc:hdhoaan3xa3jiuq4fg4mefid/app.bsky.feed.like/3lv4ouczo2b2a',
    get_record_url:
      'https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Ahdhoaan3xa3jiuq4fg4mefid&collection=app.bsky.feed.like&rkey=3lv4ouczo2b2a',
  });
  assert.deepEqual(parsedToolText.record_json.value, {
    $type: 'app.bsky.feed.like',
    subject: {
      uri: 'at://did:plc:example/app.bsky.feed.post/r1',
    },
  });
  assert.equal(parsedToolText.get_record_error, null);
});

test('serves MCP get_latest_record_for_collection with found false when no indexed record exists', async () => {
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
  assert.equal(parsedToolText.latest_indexed_record, null);
  assert.equal(parsedToolText.record_json, null);
  assert.equal(parsedToolText.get_record_error, null);
});

test('serves MCP get_latest_record_for_collection with pointer preserved when getRecord fails', async () => {
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
                  indexed_at: '2026-05-09T11:49:23.006000Z',
                  did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
                  rkey: '3lv4ouczo2b2a',
                },
              ] as T;
            },
          };
        },
      },
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          statusText: 'Not Found',
        })) as typeof fetch,
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
  assert.equal(parsedToolText.found, true);
  assert.equal(parsedToolText.record_json, null);
  assert.equal(parsedToolText.latest_indexed_record.at_uri, 'at://did:plc:hdhoaan3xa3jiuq4fg4mefid/app.bsky.feed.like/3lv4ouczo2b2a');
  assert.deepEqual(parsedToolText.get_record_error, {
    type: 'http_error',
    status: 404,
    status_text: 'Not Found',
    message: 'getRecord failed with 404',
    retryable: false,
  });
});

test('serves MCP get_latest_record_for_collection timeout as retryable record error', async () => {
  const abortError = new Error('The operation was aborted');
  abortError.name = 'AbortError';
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
                  indexed_at: '2026-05-09T11:49:23.006000Z',
                  did: 'did:plc:hdhoaan3xa3jiuq4fg4mefid',
                  rkey: '3lv4ouczo2b2a',
                },
              ] as T;
            },
          };
        },
      },
      fetch: (async () => {
        throw abortError;
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
  assert.equal(parsedToolText.found, true);
  assert.equal(parsedToolText.record_json, null);
  assert.equal(parsedToolText.latest_indexed_record.at_uri, 'at://did:plc:hdhoaan3xa3jiuq4fg4mefid/app.bsky.feed.like/3lv4ouczo2b2a');
  assert.deepEqual(parsedToolText.get_record_error, {
    type: 'timeout',
    message: 'getRecord request timed out',
    retryable: true,
  });
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
