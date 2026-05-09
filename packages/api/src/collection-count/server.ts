import { serve } from '@hono/node-server';
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { loadCollectionCountApiConfig, getPublicRoute, type CollectionCountApiConfig, type FallbackReason } from './config.ts';
import {
  createClickHouseClient,
  isStaleSnapshotError,
  readCollectionCountFromClickHouse,
  type ClickHouseQueryClient,
} from './clickhouse.ts';
import { readCollectionCountFromPostgrest, type FetchLike } from './fallback.ts';
import {
  DAILY_SUMMARY_ROUTES,
  parseDailySummaryLimit,
  readDailySummaryFromClickHouse,
  type DailySummaryKind,
} from './daily-summary.ts';
import {
  MCP_READ_CACHE_TTL_MS,
  buildMcpCacheKey,
  parseMcpDays,
  parseMcpLimit,
  readLatestCollectionRecordPointerFromClickHouse,
  readActiveCollectionsFromClickHouse,
  readNewCollectionsFromClickHouse,
  readThroughMcpCache,
  type ActiveCollectionRow,
  type LatestCollectionRecordPointer,
  type McpCacheEntry,
  type McpCacheStatus,
  type NewCollectionRow,
} from './mcp-insights.ts';
import {
  createRuntimeStatus,
  isCircuitOpen,
  recordClickHouseFailure,
  recordClickHouseSuccess,
  updateRuntimeStatus,
  type RuntimeStatus,
} from './status.ts';
import type { CollectionCountResult } from './types.ts';

type RateLimitState = {
  windowStartedAt: number;
  count: number;
};

type CacheEntry = {
  expiresAt: number;
  result: CollectionCountResult;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

type McpInsightTool = 'get_new_collections' | 'get_active_collections';
type McpTool = McpInsightTool | 'get_latest_record_for_collection';

type McpInsightResult = {
  value: NewCollectionRow[] | ActiveCollectionRow[];
  cacheKey: string;
  cacheStatus: McpCacheStatus;
  days: number;
  limit: number;
  tool: McpInsightTool;
};

export type CollectionCountAppDependencies = {
  clickhouse?: ClickHouseQueryClient | null;
  fetch?: FetchLike;
  runtimeStatus?: RuntimeStatus;
};

export function createCollectionCountApp(
  config: CollectionCountApiConfig = loadCollectionCountApiConfig(),
  dependencies: CollectionCountAppDependencies = {},
): Hono {
  const app = new Hono();
  const rateLimitBuckets = new Map<string, RateLimitState>();
  const runtimeStatus = dependencies.runtimeStatus ?? createRuntimeStatus();
  const fetchImpl = dependencies.fetch ?? fetch;
  let clickhouseClient: ClickHouseQueryClient | null | undefined = dependencies.clickhouse;
  let cache: CacheEntry | null = null;
  const mcpReadCache = new Map<string, McpCacheEntry<unknown>>();

  app.use('*', secureHeaders());
  const publicCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Disable-Fallback'],
    exposeHeaders: [
      'X-Data-Source',
      'X-Fallback-Reason',
      'X-Snapshot-Refresh-Id',
      'X-Snapshot-Refreshed-At',
      'X-Snapshot-Age-Seconds',
      'X-Cache',
      'X-Cache-Key',
      'X-Cache-Ttl-Seconds',
    ],
    maxAge: 600,
  });

  app.use(`${config.publicBasePath}/*`, publicCors);
  app.use('/api/mcp', publicCors);

  const rateLimiter = async (c: Context, next: Next) => {
    const rateLimit = checkRateLimit(rateLimitBuckets, getClientKey(c.req.raw, config), config);
    c.header('X-RateLimit-Limit', String(config.rateLimitRequestsPerMinute));
    c.header('X-RateLimit-Remaining', String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    return next();
  };
  app.use(`${config.publicBasePath}/*`, rateLimiter);
  app.use('/api/mcp', rateLimiter);

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'atpdashboard-clickhouse-api',
      publicBasePath: config.publicBasePath,
    }),
  );

  app.get(getPublicRoute(config, '/collection_count_view'), async (c) => {
    const disableFallback = c.req.header('X-Disable-Fallback')?.toLowerCase() === 'true';
    const cached = cache && cache.expiresAt > Date.now() ? cache.result : null;
    if (cached && !disableFallback && !config.forceCollectionCountFallback) {
      setCollectionCountHeaders(c, cached);
      return c.json(cached.rows);
    }

    const result = await resolveCollectionCount({
      config,
      runtimeStatus,
      fetchImpl,
      clickhouseClient,
      disableFallback,
      getClickHouseClient: async () => {
        clickhouseClient ??= await createClickHouseClient(config);
        return clickhouseClient ?? null;
      },
    });

    if (result.status === 503) {
      c.header('Retry-After', '30');
      setCollectionCountHeaders(c, result.result);
      return c.json({ error: 'unavailable' }, 503);
    }

    cache = config.responseCacheTtlMs > 0 ? { expiresAt: Date.now() + config.responseCacheTtlMs, result: result.result } : null;
    setCollectionCountHeaders(c, result.result);
    return c.json(result.result.rows);
  });

  for (const [routeName, kind] of Object.entries(DAILY_SUMMARY_ROUTES)) {
    app.get(getPublicRoute(config, `/${routeName}`), async (c) => {
      const limit = parseDailySummaryLimit(c.req.query('limit'));
      try {
        const rows = await resolveDailySummary({
          config,
          clickhouseClient,
          kind,
          limit,
          getClickHouseClient: async () => {
            clickhouseClient ??= await createClickHouseClient(config);
            return clickhouseClient ?? null;
          },
        });
        c.header('X-Data-Source', 'clickhouse');
        return c.json(rows);
      } catch (error) {
        console.error('[atpdashboard-api] daily summary failed', sanitizeError(error));
        c.header('X-Data-Source', 'unavailable');
        return c.json({ error: 'unavailable' }, 503);
      }
    });
  }

  app.get(getPublicRoute(config, '/mcp/new_collections'), async (c) => {
    try {
      const days = parseMcpDays(c.req.query('days'));
      const limit = parseMcpLimit(c.req.query('limit'));
      const result = await resolveMcpInsight({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'get_new_collections',
        days,
        limit,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setMcpCacheHeaders(c, result);
      return c.json(result.value);
    } catch (error) {
      console.error('[atpdashboard-api] MCP new_collections failed', sanitizeError(error));
      return c.json({ error: 'unavailable' }, 503);
    }
  });

  app.get(getPublicRoute(config, '/mcp/active_collections'), async (c) => {
    try {
      const days = parseMcpDays(c.req.query('days'));
      const limit = parseMcpLimit(c.req.query('limit'));
      const result = await resolveMcpInsight({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'get_active_collections',
        days,
        limit,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setMcpCacheHeaders(c, result);
      return c.json(result.value);
    } catch (error) {
      console.error('[atpdashboard-api] MCP active_collections failed', sanitizeError(error));
      return c.json({ error: 'unavailable' }, 503);
    }
  });

  app.post('/api/mcp', async (c) => {
    let payload: JsonRpcRequest;
    try {
      payload = await c.req.json<JsonRpcRequest>();
    } catch {
      return c.json(jsonRpcError(null, -32700, 'Parse error'), 400);
    }

    try {
      const response = await handleMcpJsonRpc({
        payload,
        config,
        clickhouseClient,
        fetchImpl,
        mcpReadCache,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      if (response == null) {
        return new Response(null, { status: 204 });
      }
      return c.json(response);
    } catch (error) {
      console.error('[atpdashboard-api] MCP request failed', sanitizeError(error));
      return c.json(jsonRpcError(payload.id ?? null, -32603, 'Internal error'), 500);
    }
  });

  app.get(getPublicRoute(config, '/status'), (c) =>
    c.json({
      mode: config.forceCollectionCountFallback ? 'fallback' : 'clickhouse',
      fallback_reason: config.forceCollectionCountFallback ? 'forced_fallback' : null,
      clickhouse_configured: config.clickhouseUrl != null,
      postgrest_fallback_configured: config.postgrestCollectionCountUrl.length > 0,
      snapshot_max_age_seconds: config.snapshotMaxAgeSeconds,
      circuit_open: isCircuitOpen(runtimeStatus, config),
      circuit_failures: runtimeStatus.circuit.failures,
      last_data_source: runtimeStatus.lastDataSource,
      last_fallback_reason: runtimeStatus.lastFallbackReason,
      last_snapshot_refresh_id: runtimeStatus.lastSnapshotRefreshId,
      last_snapshot_refreshed_at: runtimeStatus.lastSnapshotRefreshedAt,
      last_snapshot_age_seconds: runtimeStatus.lastSnapshotAgeSeconds,
      last_success_at: runtimeStatus.lastSuccessAt,
      mcp: 'enabled',
    }),
  );

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    console.error('[atpdashboard-api] request failed', sanitizeError(error));
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

async function resolveMcpInsight(params: {
  config: CollectionCountApiConfig;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  mcpReadCache: Map<string, McpCacheEntry<unknown>>;
  tool: McpInsightTool;
  days: number;
  limit: number;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<McpInsightResult> {
  const client = params.clickhouseClient ?? (await params.getClickHouseClient());
  if (!client) {
    throw new Error('ClickHouse client is not configured');
  }

  const cacheKey = buildMcpCacheKey(params.tool, { days: params.days, limit: params.limit });
  const cached = await readThroughMcpCache(params.mcpReadCache, cacheKey, async () => {
    if (params.tool === 'get_new_collections') {
      return readNewCollectionsFromClickHouse(client, params.config, params);
    }
    return readActiveCollectionsFromClickHouse(client, params.config, params);
  });

  return {
    value: cached.value as NewCollectionRow[] | ActiveCollectionRow[],
    cacheKey,
    cacheStatus: cached.status,
    days: params.days,
    limit: params.limit,
    tool: params.tool,
  };
}

function setMcpCacheHeaders(c: { header: (name: string, value: string) => void }, result: McpInsightResult): void {
  c.header('X-Data-Source', 'clickhouse');
  c.header('X-Cache', result.cacheStatus);
  c.header('X-Cache-Key', result.cacheKey);
  c.header('X-Cache-Ttl-Seconds', String(Math.floor(MCP_READ_CACHE_TTL_MS / 1000)));
}

async function handleMcpJsonRpc(params: {
  payload: JsonRpcRequest;
  config: CollectionCountApiConfig;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  fetchImpl: FetchLike;
  mcpReadCache: Map<string, McpCacheEntry<unknown>>;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<Record<string, unknown> | null> {
  const { payload } = params;
  const id = payload.id ?? null;

  if (!payload.id && payload.method?.startsWith('notifications/')) {
    return null;
  }

  if (payload.method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'atpdashboard-analytics',
        version: '0.1.0',
      },
    });
  }

  if (payload.method === 'tools/list') {
    return jsonRpcResult(id, {
      tools: [
        {
          name: 'get_new_collections',
          description:
            '指定した直近日数で初めて観測された ATProto collection/NSID を、nsid_first_seen_at の新しい順で返します。',
          inputSchema: mcpCollectionToolInputSchema(),
        },
        {
          name: 'get_active_collections',
          description: '指定した直近日数で event_count が多い ATProto collection/NSID を返します。unique_did は重いため返しません。',
          inputSchema: mcpCollectionToolInputSchema(),
        },
        {
          name: 'get_latest_record_for_collection',
          description:
            '指定した ATProto collection/NSID の最新index済みrecordを取得し、AT URI、getRecord URL、record JSONを返します。「このNSIDのデータを見たい」ときに使ってください。',
          inputSchema: mcpLatestRecordToolInputSchema(),
        },
      ],
    });
  }

  if (payload.method === 'tools/call') {
    const tool = payload.params?.name as McpTool | undefined;
    if (tool !== 'get_new_collections' && tool !== 'get_active_collections' && tool !== 'get_latest_record_for_collection') {
      return jsonRpcError(id, -32602, 'Unknown tool');
    }

    const args = payload.params?.arguments ?? {};
    if (tool === 'get_latest_record_for_collection') {
      let collection: string;
      try {
        collection = parseMcpCollection(args.collection);
      } catch (error) {
        return jsonRpcError(id, -32602, error instanceof Error ? error.message : 'Invalid params');
      }
      const result = await resolveLatestCollectionRecord({
        config: params.config,
        clickhouseClient: params.clickhouseClient,
        fetchImpl: params.fetchImpl,
        collection,
        getClickHouseClient: params.getClickHouseClient,
      });
      return jsonRpcResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    }

    const days = parseMcpDays(args.days as string | number | undefined);
    const limit = parseMcpLimit(args.limit as string | number | undefined);
    const result = await resolveMcpInsight({
      config: params.config,
      clickhouseClient: params.clickhouseClient,
      mcpReadCache: params.mcpReadCache,
      tool,
      days,
      limit,
      getClickHouseClient: params.getClickHouseClient,
    });

    return jsonRpcResult(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            formatMcpToolResult(result),
            null,
            2,
          ),
        },
      ],
    });
  }

  return jsonRpcError(id, -32601, 'Method not found');
}

async function resolveLatestCollectionRecord(params: {
  config: CollectionCountApiConfig;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  fetchImpl: FetchLike;
  collection: string;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<Record<string, unknown>> {
  const client = params.clickhouseClient ?? (await params.getClickHouseClient());
  if (!client) {
    throw new Error('ClickHouse client is not configured');
  }
  const pointer = await readLatestCollectionRecordPointerFromClickHouse(client, params.config, { collection: params.collection });
  if (!pointer) {
    return {
      tool: 'get_latest_record_for_collection',
      intent: 'show_latest_record_json_for_nsid',
      collection: params.collection,
      found: false,
      latest_indexed_record: null,
      record_json: null,
      get_record_error: null,
    };
  }
  const record = await fetchLatestRecordJson(params.fetchImpl, params.config, pointer);
  return {
    tool: 'get_latest_record_for_collection',
    intent: 'show_latest_record_json_for_nsid',
    collection: params.collection,
    found: true,
    latest_indexed_record: pointer,
    record_json: record.ok ? record.json : null,
    get_record_error: record.ok ? null : record.error,
  };
}

type LatestRecordFetchResult =
  | {
      ok: true;
      json: unknown;
    }
  | {
      ok: false;
      error: {
        type: 'http_error' | 'parse_error' | 'timeout' | 'network_error';
        message: string;
        retryable: boolean;
        status?: number;
        status_text?: string;
      };
    };

async function fetchLatestRecordJson(
  fetchImpl: FetchLike,
  config: Pick<CollectionCountApiConfig, 'apiTimeoutMs'>,
  pointer: LatestCollectionRecordPointer,
): Promise<LatestRecordFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);
  try {
    const response = await fetchImpl(pointer.get_record_url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: {
          type: 'http_error',
          status: response.status,
          status_text: response.statusText,
          message: `getRecord failed with ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        },
      };
    }
    try {
      return {
        ok: true,
        json: await response.json(),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'parse_error',
          message: error instanceof Error ? error.message : 'getRecord response JSON parse failed',
          retryable: false,
        },
      };
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        ok: false,
        error: {
          type: 'timeout',
          message: 'getRecord request timed out',
          retryable: true,
        },
      };
    }
    return {
      ok: false,
      error: {
        type: 'network_error',
        message: error instanceof Error ? error.message : 'getRecord request failed',
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseMcpCollection(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('collection must be a non-empty string');
  }
  return value.trim();
}

function formatMcpToolResult(result: McpInsightResult): Record<string, unknown> {
  const cache = {
    status: result.cacheStatus,
    key: result.cacheKey,
    ttl_seconds: Math.floor(MCP_READ_CACHE_TTL_MS / 1000),
  };
  if (result.tool === 'get_new_collections') {
    return formatNewCollectionsToolResult(result, cache);
  }

  return {
    cache,
    data: result.value,
  };
}

function formatNewCollectionsToolResult(result: McpInsightResult, cache: Record<string, unknown>): Record<string, unknown> {
  const rows = result.value as NewCollectionRow[];
  const newlyObservedNsids = rows.map((row) => ({
    collection: row.collection,
    nsid_first_seen_at: row.first_seen_at,
    event_count_since_nsid_first_seen: row.event_count,
    last_indexed_record: {
      indexed_at: row.last_indexed_at,
      at_uri: row.last_indexed_at_uri,
      get_record_url: row.last_indexed_get_record_url,
    },
  }));

  return {
    tool: 'get_new_collections',
    intent: 'newly_observed_nsids',
    parameters: {
      lookback_days: result.days,
      limit: result.limit,
    },
    result: {
      primary_order: ['nsid_first_seen_at desc', 'event_count_since_nsid_first_seen desc', 'collection asc'],
      returned_count: rows.length,
      is_truncated: rows.length >= result.limit,
      newly_observed_nsids: newlyObservedNsids,
      namespace_groups: summarizeNamespaceGroups(rows),
    },
    cache,
  };
}

function summarizeNamespaceGroups(rows: NewCollectionRow[]): Array<{
  namespace_prefix: string;
  group_first_seen_at: string;
  first_seen_nsid_in_group: string;
  collection_count: number;
  event_count_since_group_first_seen: number;
  examples: string[];
}> {
  const groups = new Map<
    string,
    {
      group_first_seen_at: string;
      first_seen_nsid_in_group: string;
      collection_count: number;
      event_count_since_group_first_seen: number;
      examples: string[];
    }
  >();
  for (const row of rows) {
    const namespacePrefix = getNamespacePrefix(row.collection);
    const group = groups.get(namespacePrefix) ?? {
      group_first_seen_at: row.first_seen_at,
      first_seen_nsid_in_group: row.collection,
      collection_count: 0,
      event_count_since_group_first_seen: 0,
      examples: [],
    };
    group.collection_count += 1;
    group.event_count_since_group_first_seen += row.event_count;
    if (
      row.first_seen_at < group.group_first_seen_at ||
      (row.first_seen_at === group.group_first_seen_at && row.collection < group.first_seen_nsid_in_group)
    ) {
      group.group_first_seen_at = row.first_seen_at;
      group.first_seen_nsid_in_group = row.collection;
    }
    if (group.examples.length < 3) {
      group.examples.push(row.collection);
    }
    groups.set(namespacePrefix, group);
  }

  return [...groups.entries()]
    .map(([namespace_prefix, group]) => ({ namespace_prefix, ...group }))
    .sort(
      (a, b) =>
        b.collection_count - a.collection_count ||
        b.group_first_seen_at.localeCompare(a.group_first_seen_at) ||
        b.event_count_since_group_first_seen - a.event_count_since_group_first_seen ||
        a.namespace_prefix.localeCompare(b.namespace_prefix),
    )
    .slice(0, 10);
}

function getNamespacePrefix(collection: string): string {
  const parts = collection.split('.').filter(Boolean);
  if (parts.length <= 2) {
    return collection;
  }
  return `${parts[0]}.${parts[1]}.*`;
}

function mcpCollectionToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 14,
        default: 7,
        description: '直近何日分を見るか。1から14まで。',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 30,
        description: '返すcollection数。1から100まで。',
      },
    },
  };
}

function mcpLatestRecordToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      collection: {
        type: 'string',
        description: 'JSONを直接見たい ATProto collection/NSID。例: app.bsky.feed.like',
      },
    },
    required: ['collection'],
  };
}

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

async function resolveDailySummary(params: {
  config: CollectionCountApiConfig;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  kind: DailySummaryKind;
  limit: number;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}) {
  const client = params.clickhouseClient ?? (await params.getClickHouseClient());
  if (!client) {
    throw new Error('ClickHouse client is not configured');
  }
  return readDailySummaryFromClickHouse(client, params.config, params.kind, params.limit);
}

async function resolveCollectionCount(params: {
  config: CollectionCountApiConfig;
  runtimeStatus: RuntimeStatus;
  fetchImpl: FetchLike;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  disableFallback: boolean;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<{ status: 200 | 503; result: CollectionCountResult }> {
  const { config, runtimeStatus, fetchImpl, disableFallback } = params;

  if (config.forceCollectionCountFallback) {
    return { status: 200, result: await fallback(config, fetchImpl, 'forced_fallback', runtimeStatus) };
  }

  if (isCircuitOpen(runtimeStatus, config)) {
    return disableFallback
      ? unavailable('circuit_open')
      : { status: 200, result: await fallback(config, fetchImpl, 'circuit_open', runtimeStatus) };
  }

  try {
    const client = params.clickhouseClient ?? (await params.getClickHouseClient());
    if (!client) {
      throw new Error('ClickHouse client is not configured');
    }
    const result = await readCollectionCountFromClickHouse(client, config);
    recordClickHouseSuccess(runtimeStatus);
    updateRuntimeStatus(runtimeStatus, result.headers);
    return { status: 200, result };
  } catch (error) {
    const reason: FallbackReason = isStaleSnapshotError(error)
      ? 'stale_snapshot'
      : error instanceof Error && error.message.toLowerCase().includes('timed out')
        ? 'clickhouse_timeout'
        : 'clickhouse_error';
    recordClickHouseFailure(runtimeStatus, config);
    if (disableFallback) {
      return unavailable(reason);
    }
    try {
      return { status: 200, result: await fallback(config, fetchImpl, reason, runtimeStatus) };
    } catch {
      return unavailable('fallback_failed');
    }
  }
}

async function fallback(
  config: CollectionCountApiConfig,
  fetchImpl: FetchLike,
  reason: FallbackReason,
  runtimeStatus: RuntimeStatus,
): Promise<CollectionCountResult> {
  const result = await readCollectionCountFromPostgrest(config, fetchImpl, reason);
  updateRuntimeStatus(runtimeStatus, result.headers);
  return result;
}

function unavailable(reason: FallbackReason): { status: 503; result: CollectionCountResult } {
  return {
    status: 503,
    result: {
      rows: [],
      headers: {
        dataSource: 'unavailable',
        fallbackReason: reason,
        snapshotRefreshId: null,
        snapshotRefreshedAt: null,
        snapshotAgeSeconds: null,
      },
    },
  };
}

function setCollectionCountHeaders(c: { header: (name: string, value: string) => void }, result: CollectionCountResult): void {
  c.header('X-Data-Source', result.headers.dataSource);
  c.header('X-Fallback-Reason', result.headers.fallbackReason ?? '');
  c.header('X-Snapshot-Refresh-Id', result.headers.snapshotRefreshId ?? '');
  c.header('X-Snapshot-Refreshed-At', result.headers.snapshotRefreshedAt ?? '');
  c.header('X-Snapshot-Age-Seconds', result.headers.snapshotAgeSeconds == null ? '' : String(result.headers.snapshotAgeSeconds));
}

export function startCollectionCountServer(config: CollectionCountApiConfig = loadCollectionCountApiConfig()): void {
  const app = createCollectionCountApp(config);
  serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    },
    (info) => {
      console.log(`[atpdashboard-api] listening on http://${info.address}:${info.port}`);
      console.log(`[atpdashboard-api] analytics base path: ${config.publicBasePath}`);
    },
  );
}

function checkRateLimit(
  buckets: Map<string, RateLimitState>,
  key: string,
  config: Pick<CollectionCountApiConfig, 'rateLimitRequestsPerMinute'>,
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const current = buckets.get(key);
  const windowMs = 60_000;
  const bucket = current && now - current.windowStartedAt < windowMs ? current : { windowStartedAt: now, count: 0 };
  bucket.count += 1;
  buckets.set(key, bucket);

  const remaining = Math.max(config.rateLimitRequestsPerMinute - bucket.count, 0);
  return {
    allowed: bucket.count <= config.rateLimitRequestsPerMinute,
    remaining,
  };
}

function getClientKey(request: Request, config: Pick<CollectionCountApiConfig, 'trustForwardedHeaders'>): string {
  if (!config.trustForwardedHeaders) {
    return 'direct';
  }
  const forwardedFor = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || 'unknown';
  }
  return 'direct';
}

function sanitizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: 'Unknown error' };
}
