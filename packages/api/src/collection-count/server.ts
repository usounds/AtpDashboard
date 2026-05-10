import { serve } from '@hono/node-server';
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { loadCollectionCountApiConfig, getPublicRoute, type CollectionCountApiConfig, type FallbackReason } from './config.ts';
import {
  createClickHouseClient,
  isStaleSnapshotError,
  readCollectionCumulativeUsersFromClickHouse,
  readCollectionStatsFromClickHouse,
  readCollectionCountFromClickHouse,
  type ClickHouseQueryClient,
  type CollectionCumulativeUsersResultRow,
  type CollectionStatsResultRow,
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
  buildDailyChartCacheKey,
  buildMcpCacheKey,
  parseDailyChartBucketDays,
  parseMcpDateRange,
  parseMcpDailyUserDays,
  readAnalyticsChartSnapshotFromClickHouse,
  readLatestCollectionRecordPointerFromClickHouse,
  readCollectionsForNamespaceFromClickHouse,
  readDailyCollectionsFromClickHouse,
  readDailyUsersFromClickHouse,
  readNewCollectionsFromClickHouse,
  readThroughMcpCache,
  readUniqueDidCountFromClickHouse,
  type AnalyticsChartSnapshotResult,
  type DailyCollectionRow,
  type DailyChartBucketParams,
  type DailyUserRow,
  type EventCountRow,
  type LatestCollectionRecordPointer,
  type McpCacheEntry,
  type McpCacheStatus,
  type McpDateRange,
  type NamespaceCollectionRow,
  type NewCollectionRow,
  type UniqueDidCountRow,
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

type McpInsightTool =
  | 'get_new_collection_groups'
  | 'get_daily_users'
  | 'get_daily_collections'
  | 'get_collections_for_namespace';
type McpTool = McpInsightTool | 'get_latest_record_for_collection';
type DailyChartTool = 'daily_users' | 'daily_collections' | 'event_counts';

type DailyChartResult = {
  rows: DailyUserRow[] | DailyCollectionRow[] | EventCountRow[];
  cacheKey: string;
  cacheStatus: McpCacheStatus;
  snapshot: {
    refreshId: string;
    refreshedAt: string;
    ageSeconds: number;
  };
  params: Required<DailyChartBucketParams>;
  tool: DailyChartTool;
};

type UniqueDidCountResult = {
  value: UniqueDidCountRow;
  cacheKey: string;
  cacheStatus: McpCacheStatus;
};

type CollectionStatsResult = {
  rows: CollectionStatsResultRow[];
  cacheKey: string;
  cacheStatus: McpCacheStatus;
};

type CollectionCumulativeUsersResult = {
  collection: string;
  rows: CollectionCumulativeUsersResultRow[];
  cacheKey: string;
  cacheStatus: McpCacheStatus;
  params: Required<DailyChartBucketParams>;
};

const RAW_RECORD_DISPLAY_POLICY = {
  raw_record_json_inline_forbidden: true,
  instruction:
    'Do not display raw record JSON inline in chat. Never fetch and paste the real record body into the LLM response. To inspect actual data, direct the user to the pds.ls URL.',
  pds_ls_instruction:
    'Guide the user to open pds.ls for actual record data. If the user asks for 実データ, answer with the pds.ls endpoint URL instead of expanding JSON in chat.',
};

const LEXICON_COLLECTION = 'com.atproto.lexicon.schema';
const GOOGLE_DNS_RESOLVE_URL = 'https://dns.google/resolve';
const PLC_DIRECTORY_URL = 'https://plc.directory';
const UNIVERSAL_RESOLVER_URL = 'https://dev.uniresolver.io/1.0/identifiers';
const DID_DOCUMENT_CACHE_TTL_MS = 60 * 60 * 1000;

type McpInsightResult = {
  value: NewCollectionRow[] | DailyUserRow[] | DailyCollectionRow[] | NamespaceCollectionRow[];
  cacheKey: string;
  cacheStatus: McpCacheStatus;
  dateRange?: McpDateRange;
  limit?: number;
  namespacePrefix?: string;
  tool: McpInsightTool;
};

type LexiconResolutionSummary = {
  collection: string;
  authority_domain: string;
  dns_name: string;
  status: 'found' | 'not_found' | 'error';
  did?: string;
  pds_service_endpoint?: string;
  lexicon_record_url?: string;
  schema?: Record<string, unknown>;
  error?: string;
  guidance: string;
};

type McpLexiconSummary = {
  collection: string;
  schema_available: boolean;
  summary: string;
  schema?: Record<string, unknown>;
  lexicon_record_url?: string;
  guidance: string;
};

type DidDocumentCacheEntry = {
  expiresAt: number;
  value?: Record<string, unknown>;
  inFlight?: Promise<Record<string, unknown>>;
};

class InvalidRequestError extends Error {}

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
  const didDocumentCache = new Map<string, DidDocumentCacheEntry>();

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

  app.get(getPublicRoute(config, '/daily_users'), async (c) => {
    try {
      const result = await resolveDailyChart({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'daily_users',
        params: parseDailyChartParams(c.req.query('days'), c.req.query('bucket_days')),
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setDailyChartCacheHeaders(c, result);
      return c.json(formatDailyChartHttpResult(result));
    } catch (error) {
      console.error('[atpdashboard-api] daily_users chart failed', sanitizeError(error));
      c.header('X-Data-Source', 'unavailable');
      return c.json({ error: error instanceof Error ? error.message : 'unavailable' }, 503);
    }
  });

  app.get(getPublicRoute(config, '/daily_collections'), async (c) => {
    try {
      const result = await resolveDailyChart({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'daily_collections',
        params: parseDailyChartParams(c.req.query('days'), c.req.query('bucket_days')),
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setDailyChartCacheHeaders(c, result);
      return c.json(formatDailyChartHttpResult(result));
    } catch (error) {
      console.error('[atpdashboard-api] daily_collections chart failed', sanitizeError(error));
      c.header('X-Data-Source', 'unavailable');
      return c.json({ error: error instanceof Error ? error.message : 'unavailable' }, 503);
    }
  });

  app.get(getPublicRoute(config, '/event_counts'), async (c) => {
    try {
      const result = await resolveDailyChart({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'event_counts',
        params: parseDailyChartParams(c.req.query('days'), c.req.query('bucket_days')),
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setDailyChartCacheHeaders(c, result);
      return c.json(formatDailyChartHttpResult(result));
    } catch (error) {
      console.error('[atpdashboard-api] event_counts chart failed', sanitizeError(error));
      c.header('X-Data-Source', 'unavailable');
      return c.json({ error: error instanceof Error ? error.message : 'unavailable' }, 503);
    }
  });

  app.get(getPublicRoute(config, '/unique_did_count'), async (c) => {
    try {
      const result = await resolveUniqueDidCount({
        config,
        clickhouseClient,
        mcpReadCache,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setUniqueDidCountCacheHeaders(c, result);
      return c.json(result.value);
    } catch (error) {
      console.error('[atpdashboard-api] unique_did_count failed', sanitizeError(error));
      c.header('X-Data-Source', 'unavailable');
      return c.json({ error: error instanceof Error ? error.message : 'unavailable' }, 503);
    }
  });

  app.get(getPublicRoute(config, '/collection_stats'), async (c) => {
    try {
      const collection = parseCollectionStatsCollection(c.req.query('collection'));
      const result = await resolveCollectionStats({
        config,
        clickhouseClient,
        mcpReadCache,
        collection,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setCollectionStatsCacheHeaders(c, result);
      return c.json(result.rows);
    } catch (error) {
      console.error('[atpdashboard-api] collection_stats failed', sanitizeError(error));
      c.header('X-Data-Source', 'unavailable');
      return c.json({ error: error instanceof Error ? error.message : 'unavailable' }, error instanceof InvalidRequestError ? 400 : 503);
    }
  });

  app.get(getPublicRoute(config, '/collection_cumulative_users'), async (c) => {
    try {
      const collection = parseCollectionStatsCollection(c.req.query('collection'));
      const result = await resolveCollectionCumulativeUsers({
        config,
        clickhouseClient,
        mcpReadCache,
        collection,
        params: parseDailyChartParams(c.req.query('days'), c.req.query('bucket_days')),
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setCollectionCumulativeUsersCacheHeaders(c, result);
      return c.json(formatCollectionCumulativeUsersHttpResult(result));
    } catch (error) {
      console.error('[atpdashboard-api] collection_cumulative_users failed', sanitizeError(error));
      c.header('X-Data-Source', 'unavailable');
      return c.json({ error: error instanceof Error ? error.message : 'unavailable' }, error instanceof InvalidRequestError ? 400 : 503);
    }
  });

  app.get(getPublicRoute(config, '/mcp/new_collection_groups'), async (c) => {
    try {
      const dateRange = parseMcpDateRange({
        days: c.req.query('days'),
        startDate: c.req.query('start_date'),
        endDate: c.req.query('end_date'),
      });
      const result = await resolveMcpInsight({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'get_new_collection_groups',
        dateRange,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setMcpCacheHeaders(c, result);
      return c.json(formatNewCollectionGroupsResult(result));
    } catch (error) {
      console.error('[atpdashboard-api] MCP new_collection_groups failed', sanitizeError(error));
      return c.json({ error: 'unavailable' }, 503);
    }
  });

  app.get(getPublicRoute(config, '/mcp/collections_for_namespace'), async (c) => {
    try {
      const namespacePrefix = parseMcpNamespacePrefix(c.req.query('namespace_prefix') ?? c.req.query('namespace'));
      const result = await resolveMcpInsight({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'get_collections_for_namespace',
        namespacePrefix,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setMcpCacheHeaders(c, result);
      return c.json(formatNamespaceCollectionsResult(result));
    } catch (error) {
      console.error('[atpdashboard-api] MCP collections_for_namespace failed', sanitizeError(error));
      return c.json({ error: error instanceof Error ? error.message : 'unavailable' }, 503);
    }
  });

  app.get(getPublicRoute(config, '/mcp/daily_users'), async (c) => {
    try {
      const dateRange = { days: parseMcpDailyUserDays(c.req.query('days')) };
      const result = await resolveMcpInsight({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'get_daily_users',
        dateRange,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setMcpCacheHeaders(c, result);
      return c.json(formatDailyUsersToolResult(result, {
        status: result.cacheStatus,
        key: result.cacheKey,
        ttl_seconds: Math.floor(MCP_READ_CACHE_TTL_MS / 1000),
      }));
    } catch (error) {
      console.error('[atpdashboard-api] MCP daily_users failed', sanitizeError(error));
      return c.json({ error: 'unavailable' }, 503);
    }
  });

  app.get(getPublicRoute(config, '/mcp/daily_collections'), async (c) => {
    try {
      const dateRange = { days: parseMcpDailyUserDays(c.req.query('days')) };
      const result = await resolveMcpInsight({
        config,
        clickhouseClient,
        mcpReadCache,
        tool: 'get_daily_collections',
        dateRange,
        getClickHouseClient: async () => {
          clickhouseClient ??= await createClickHouseClient(config);
          return clickhouseClient ?? null;
        },
      });
      setMcpCacheHeaders(c, result);
      return c.json(formatDailyCollectionsToolResult(result, {
        status: result.cacheStatus,
        key: result.cacheKey,
        ttl_seconds: Math.floor(MCP_READ_CACHE_TTL_MS / 1000),
      }));
    } catch (error) {
      console.error('[atpdashboard-api] MCP daily_collections failed', sanitizeError(error));
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
        didDocumentCache,
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
  dateRange?: McpDateRange;
  limit?: number;
  namespacePrefix?: string;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<McpInsightResult> {
  const client = params.clickhouseClient ?? (await params.getClickHouseClient());
  if (!client) {
    throw new Error('ClickHouse client is not configured');
  }

  const dateRange = params.dateRange ?? { days: 0 };
  const cacheKey = buildMcpCacheKey(params.tool, { ...dateRange, limit: params.limit, namespacePrefix: params.namespacePrefix });
  const cached = await readThroughMcpCache(params.mcpReadCache, cacheKey, async () => {
    if (params.tool === 'get_collections_for_namespace') {
      if (params.namespacePrefix == null) {
        throw new Error('namespace_prefix is required');
      }
      return readCollectionsForNamespaceFromClickHouse(client, params.config, { namespacePrefix: params.namespacePrefix });
    }
    if (params.tool === 'get_new_collection_groups') {
      if (params.dateRange == null) {
        throw new Error('dateRange is required');
      }
      return readNewCollectionsFromClickHouse(client, params.config, params.dateRange);
    }
    if (params.tool === 'get_daily_users') {
      return readDailyUsersFromClickHouse(client, params.config, {
        days: dateRange.days,
      });
    }
    if (params.tool === 'get_daily_collections') {
      return readDailyCollectionsFromClickHouse(client, params.config, {
        days: dateRange.days,
      });
    }
    throw new Error(`Unsupported MCP insight tool: ${params.tool}`);
  });

  return {
    value: cached.value as NewCollectionRow[] | DailyUserRow[] | DailyCollectionRow[] | NamespaceCollectionRow[],
    cacheKey,
    cacheStatus: cached.status,
    dateRange: params.dateRange,
    limit: params.limit,
    namespacePrefix: params.namespacePrefix,
    tool: params.tool,
  };
}

function parseDailyChartParams(days: string | number | undefined, bucketDays: string | number | undefined): Required<DailyChartBucketParams> {
  return {
    days: parseMcpDailyUserDays(days),
    bucketDays: parseDailyChartBucketDays(bucketDays),
  };
}

async function resolveDailyChart(params: {
  config: CollectionCountApiConfig;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  mcpReadCache: Map<string, McpCacheEntry<unknown>>;
  tool: DailyChartTool;
  params: Required<DailyChartBucketParams>;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<DailyChartResult> {
  const client = params.clickhouseClient ?? (await params.getClickHouseClient());
  if (!client) {
    throw new Error('ClickHouse client is not configured');
  }

  const cacheKey = buildDailyChartCacheKey(params.tool, params.params);
  const cached = await readThroughMcpCache(params.mcpReadCache, cacheKey, async () =>
    readAnalyticsChartSnapshotFromClickHouse(client, params.config, {
      tool: params.tool,
      days: params.params.days,
      bucketDays: params.params.bucketDays,
    }),
  );
  const snapshot = cached.value as AnalyticsChartSnapshotResult;

  return {
    rows: formatDailyChartSnapshotRows(params.tool, snapshot.rows),
    cacheKey,
    cacheStatus: cached.status,
    snapshot: {
      refreshId: snapshot.refreshId,
      refreshedAt: snapshot.refreshedAt,
      ageSeconds: snapshot.snapshotAgeSeconds,
    },
    params: params.params,
    tool: params.tool,
  };
}

async function resolveUniqueDidCount(params: {
  config: CollectionCountApiConfig;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  mcpReadCache: Map<string, McpCacheEntry<unknown>>;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<UniqueDidCountResult> {
  const client = params.clickhouseClient ?? (await params.getClickHouseClient());
  if (!client) {
    throw new Error('ClickHouse client is not configured');
  }

  const cacheKey = 'unique_did_count';
  const cached = await readThroughMcpCache(params.mcpReadCache, cacheKey, async () =>
    readUniqueDidCountFromClickHouse(client, params.config),
  );

  return {
    value: cached.value as UniqueDidCountRow,
    cacheKey,
    cacheStatus: cached.status,
  };
}

async function resolveCollectionStats(params: {
  config: CollectionCountApiConfig;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  mcpReadCache: Map<string, McpCacheEntry<unknown>>;
  collection: string;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<CollectionStatsResult> {
  const client = params.clickhouseClient ?? (await params.getClickHouseClient());
  if (!client) {
    throw new Error('ClickHouse client is not configured');
  }

  const cacheKey = `collection_stats:collection=${params.collection}`;
  const cached = await readThroughMcpCache(params.mcpReadCache, cacheKey, async () =>
    readCollectionStatsFromClickHouse(client, params.config, params.collection),
  );

  return {
    rows: cached.value as CollectionStatsResultRow[],
    cacheKey,
    cacheStatus: cached.status,
  };
}

async function resolveCollectionCumulativeUsers(params: {
  config: CollectionCountApiConfig;
  clickhouseClient: ClickHouseQueryClient | null | undefined;
  mcpReadCache: Map<string, McpCacheEntry<unknown>>;
  collection: string;
  params: Required<DailyChartBucketParams>;
  getClickHouseClient: () => Promise<ClickHouseQueryClient | null>;
}): Promise<CollectionCumulativeUsersResult> {
  const client = params.clickhouseClient ?? (await params.getClickHouseClient());
  if (!client) {
    throw new Error('ClickHouse client is not configured');
  }

  const cacheKey = `collection_cumulative_users:collection=${params.collection}:days=${params.params.days}:bucket_days=${params.params.bucketDays}`;
  const cached = await readThroughMcpCache(params.mcpReadCache, cacheKey, async () =>
    readCollectionCumulativeUsersFromClickHouse(client, params.config, {
      collection: params.collection,
      days: params.params.days,
      bucketDays: params.params.bucketDays,
    }),
  );

  return {
    collection: params.collection,
    rows: cached.value as CollectionCumulativeUsersResultRow[],
    cacheKey,
    cacheStatus: cached.status,
    params: params.params,
  };
}

function parseCollectionStatsCollection(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) {
    throw new InvalidRequestError('collection is required');
  }
  const collection = raw.startsWith('eq.') ? raw.slice(3) : raw;
  if (!collection || collection.length > 512) {
    throw new InvalidRequestError('invalid collection');
  }
  return collection;
}

function setDailyChartCacheHeaders(c: { header: (name: string, value: string) => void }, result: DailyChartResult): void {
  c.header('X-Data-Source', 'clickhouse_snapshot');
  c.header('X-Cache', result.cacheStatus);
  c.header('X-Cache-Key', result.cacheKey);
  c.header('X-Cache-Ttl-Seconds', String(Math.floor(MCP_READ_CACHE_TTL_MS / 1000)));
  c.header('X-Snapshot-Refresh-Id', result.snapshot.refreshId);
  c.header('X-Snapshot-Refreshed-At', result.snapshot.refreshedAt);
  c.header('X-Snapshot-Age-Seconds', String(result.snapshot.ageSeconds));
}

function formatDailyChartHttpResult(result: DailyChartResult): Record<string, unknown> {
  return {
    tool: result.tool,
    parameters: {
      days: result.params.days,
      bucket_days: result.params.bucketDays,
    },
    rows: result.rows,
    cache: {
      status: result.cacheStatus,
      key: result.cacheKey,
      ttl_seconds: Math.floor(MCP_READ_CACHE_TTL_MS / 1000),
    },
  };
}

function formatDailyChartSnapshotRows(
  tool: DailyChartTool,
  rows: AnalyticsChartSnapshotResult['rows'],
): DailyUserRow[] | DailyCollectionRow[] | EventCountRow[] {
  if (tool === 'event_counts') {
    return rows.map((row) => ({
      date: row.date,
      day_offset: row.day_offset,
      count: row.count,
    }));
  }
  return rows.map((row) => ({
    date: row.date,
    day_offset: row.day_offset,
    active: row.active,
    new: row.new,
  }));
}

function setUniqueDidCountCacheHeaders(c: { header: (name: string, value: string) => void }, result: UniqueDidCountResult): void {
  c.header('X-Data-Source', 'clickhouse');
  c.header('X-Cache', result.cacheStatus);
  c.header('X-Cache-Key', result.cacheKey);
  c.header('X-Cache-Ttl-Seconds', String(Math.floor(MCP_READ_CACHE_TTL_MS / 1000)));
}

function setCollectionStatsCacheHeaders(c: { header: (name: string, value: string) => void }, result: CollectionStatsResult): void {
  c.header('X-Data-Source', 'clickhouse');
  c.header('X-Cache', result.cacheStatus);
  c.header('X-Cache-Key', result.cacheKey);
  c.header('X-Cache-Ttl-Seconds', String(Math.floor(MCP_READ_CACHE_TTL_MS / 1000)));
}

function setCollectionCumulativeUsersCacheHeaders(
  c: { header: (name: string, value: string) => void },
  result: CollectionCumulativeUsersResult,
): void {
  c.header('X-Data-Source', 'clickhouse');
  c.header('X-Cache', result.cacheStatus);
  c.header('X-Cache-Key', result.cacheKey);
  c.header('X-Cache-Ttl-Seconds', String(Math.floor(MCP_READ_CACHE_TTL_MS / 1000)));
}

function formatCollectionCumulativeUsersHttpResult(result: CollectionCumulativeUsersResult): Record<string, unknown> {
  return {
    collection: result.collection,
    parameters: {
      days: result.params.days,
      bucket_days: result.params.bucketDays,
    },
    rows: result.rows,
    cache: {
      status: result.cacheStatus,
      key: result.cacheKey,
      ttl_seconds: Math.floor(MCP_READ_CACHE_TTL_MS / 1000),
    },
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
  didDocumentCache: Map<string, DidDocumentCacheEntry>;
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
          name: 'get_new_collection_groups',
          description:
            '指定した直近日数または日付範囲で初めて観測された ATProto collection/NSID を namespace group だけの短い一覧で返します。first_seen_nsid_in_group は、その namespace group 内で期間内に最初に観測された代表の実NSIDであり、グループ内NSIDの完全一覧ではありません。「YYYY年M月D日に生まれたNSID」「生まれたLexicon」「new NSID/new Lexicon」のような質問は、この tool を優先し、明示的に個別NSID一覧を求められない限り namespace group として解釈して回答してください。sample_nsids や record URL は返しません。',
          inputSchema: mcpNewCollectionToolInputSchema(),
        },
        {
          name: 'get_collections_for_namespace',
          description:
            '指定した namespace prefix 配下で観測済みの ATProto collection/NSID をすべて列挙し、可能なら各NSIDのLexicon定義JSONを解決してschema要約を返します。Lexicon JSONはschemaとして理解して説明してよいですが、実レコードのJSON本文は絶対に取得・表示・チャット展開しないでください。実データ確認は latest_record の pds_ls_url を案内してください。例: app.chavatar について聞かれたら namespace_prefix=app.chavatar で呼び、app.chavatar.* 配下のNSID一覧とLexicon説明を返します。',
          inputSchema: mcpNamespaceCollectionToolInputSchema(),
        },
        {
          name: 'get_daily_users',
          description:
            '指定した直近日数で rolling 24h バケットのユーザー推移を返します。グラフ描画しやすい time series として、各24時間バケットの active DID 数と new DID 数を date/day_offset/active/new の行と chart_spec で返します。「この1週間のユーザーの推移」「Daily Users」「Active/New users」「グラフにして」の質問ではこの tool を優先してください。',
          inputSchema: mcpDailyUsersToolInputSchema(),
        },
        {
          name: 'get_daily_collections',
          description:
            '指定した直近日数で Daily Collections の Active/New 推移を返します。画像の Daily Collections カードのような折れ線グラフを作るため、各 rolling 24h バケットの active collection 数と new collection 数を date/day_offset/active/new の行と chart_spec で返します。This Week/This Month/This Year は days=7/30/365 を指定してください。',
          inputSchema: mcpDailyCollectionsToolInputSchema(),
        },
        {
          name: 'get_latest_record_for_collection',
          description:
            '指定した ATProto collection/NSID の record created_at が最新のrecordを探します。実データのJSON本文は絶対に取得・表示・チャット展開しないでください。必ず pds.ls の確認URLだけをユーザーに案内してください。',
          inputSchema: mcpLatestRecordToolInputSchema(),
        },
      ],
    });
  }

  if (payload.method === 'tools/call') {
    const tool = payload.params?.name as McpTool | undefined;
    if (
      tool !== 'get_new_collection_groups' &&
      tool !== 'get_daily_users' &&
      tool !== 'get_daily_collections' &&
      tool !== 'get_collections_for_namespace' &&
      tool !== 'get_latest_record_for_collection'
    ) {
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

    let dateRange: McpDateRange;
    let namespacePrefix: string | undefined;
    try {
      if (tool === 'get_collections_for_namespace') {
        namespacePrefix = parseMcpNamespacePrefix(args.namespace_prefix ?? args.namespacePrefix ?? args.namespace);
        dateRange = { days: 0 };
      } else if (tool === 'get_daily_users') {
        dateRange = { days: parseMcpDailyUserDays(args.days as string | number | undefined) };
      } else if (tool === 'get_daily_collections') {
        dateRange = { days: parseMcpDailyUserDays(args.days as string | number | undefined) };
      } else {
        dateRange = parseMcpDateRange({
          days: args.days as string | number | undefined,
          startDate: (args.start_date ?? args.startDate) as string | undefined,
          endDate: (args.end_date ?? args.endDate) as string | undefined,
        });
      }
    } catch (error) {
      return jsonRpcError(id, -32602, error instanceof Error ? error.message : 'Invalid params');
    }
    const result = await resolveMcpInsight({
      config: params.config,
      clickhouseClient: params.clickhouseClient,
      mcpReadCache: params.mcpReadCache,
      tool,
      dateRange: tool === 'get_collections_for_namespace' ? undefined : dateRange,
      namespacePrefix,
      getClickHouseClient: params.getClickHouseClient,
    });
    const cache = {
      status: result.cacheStatus,
      key: result.cacheKey,
      ttl_seconds: Math.floor(MCP_READ_CACHE_TTL_MS / 1000),
    };
    if (tool === 'get_collections_for_namespace') {
      const lexicons = await resolveLexiconsForNamespaceRows(
        result.value as NamespaceCollectionRow[],
        params.fetchImpl,
        params.config.apiTimeoutMs,
        params.didDocumentCache,
      );
      return jsonRpcResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(formatNamespaceCollectionsToolResult(result, cache, lexicons), null, 2),
          },
        ],
      });
    }

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
      intent: 'guide_to_latest_record_on_pds_ls',
      raw_record_display_policy: RAW_RECORD_DISPLAY_POLICY,
      collection: params.collection,
      found: false,
      latest_record: null,
      guidance: 'No record pointer was found. Do not try to fetch raw record JSON inline; ask the user for another collection or date range.',
    };
  }
  return {
    tool: 'get_latest_record_for_collection',
    intent: 'guide_to_latest_record_on_pds_ls',
    raw_record_display_policy: RAW_RECORD_DISPLAY_POLICY,
    collection: params.collection,
    found: true,
    latest_record: {
      collection: pointer.collection,
      created_at: pointer.created_at,
      at_uri: pointer.at_uri,
      pds_ls_url: pointer.pds_ls_url,
    },
    guidance: `Do not display the raw record JSON inline in chat. Open ${pointer.pds_ls_url} on pds.ls to inspect the actual record data outside the LLM conversation. If asked for 実データ, provide this pds.ls URL, not pasted JSON.`,
  };
}

function parseMcpCollection(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('collection must be a non-empty string');
  }
  return value.trim();
}

function parseMcpNamespacePrefix(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('namespace_prefix must be a non-empty string');
  }
  const normalized = value.trim().replace(/\.\*$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+$/.test(normalized)) {
    throw new Error('namespace_prefix must be a dot-separated namespace such as app.chavatar');
  }
  return normalized;
}

function formatMcpToolResult(result: McpInsightResult): Record<string, unknown> {
  const cache = {
    status: result.cacheStatus,
    key: result.cacheKey,
    ttl_seconds: Math.floor(MCP_READ_CACHE_TTL_MS / 1000),
  };
  if (result.tool === 'get_new_collection_groups') {
    return {
      tool: 'get_new_collection_groups',
      intent: 'newly_observed_namespace_groups_compact',
      result: formatNewCollectionGroupsResult(result),
      cache,
    };
  }
  if (result.tool === 'get_collections_for_namespace') {
    return formatNamespaceCollectionsToolResult(result, cache);
  }
  if (result.tool === 'get_daily_users') {
    return formatDailyUsersToolResult(result, cache);
  }
  if (result.tool === 'get_daily_collections') {
    return formatDailyCollectionsToolResult(result, cache);
  }

  return {
    cache,
    data: result.value,
  };
}

function formatDailyUsersToolResult(result: McpInsightResult, cache: Record<string, unknown>): Record<string, unknown> {
  const rows = result.value as DailyUserRow[];
  const startDate = rows[0]?.date ?? null;
  const endDate = rows.at(-1)?.date ?? null;
  const totals = rows.reduce(
    (summary, row) => ({
      active_sum: summary.active_sum + row.active,
      new_sum: summary.new_sum + row.new,
      active_peak: Math.max(summary.active_peak, row.active),
      new_peak: Math.max(summary.new_peak, row.new),
    }),
    { active_sum: 0, new_sum: 0, active_peak: 0, new_peak: 0 },
  );

  return {
    tool: 'get_daily_users',
    intent: 'daily_users_active_and_new_time_series',
    parameters: formatDateRangeParameters(result.dateRange ?? { days: 0 }),
    result: {
      primary_view: 'time_series_chart',
      period: {
        start_date: startDate,
        end_date: endDate,
        days: rows.length,
        timezone: 'UTC',
      },
      columns: [
        { key: 'date', description: 'UTC date of the rolling 24-hour bucket end.' },
        { key: 'day_offset', description: 'Rolling 24-hour buckets relative to the latest indexed event. 0 is the latest 24h bucket.' },
        { key: 'active', description: 'Unique DIDs observed in that rolling 24-hour bucket.' },
        { key: 'new', description: 'DIDs first observed in that rolling 24-hour bucket.' },
      ],
      chart_spec: {
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
      },
      returned_day_count: rows.length,
      rows,
      summary: {
        active_peak: totals.active_peak,
        new_peak: totals.new_peak,
        active_average: rows.length === 0 ? 0 : Math.round(totals.active_sum / rows.length),
        new_total: totals.new_sum,
      },
      response_guidance:
        'For graph or trend requests, render compact line charts from chart_spec and rows. Prefer Mermaid xyChart-beta when supported, using date as the x-axis; plot active users as the primary series and also plot new users, either as a second line when scale remains readable or as a separate companion chart when the values would be compressed. Also include a compact Daily Users table when it helps readability. For days-based requests, treat each row as a rolling 24-hour bucket ending on the shown UTC date; active is unique DID count and new is first-observed DID count within that bucket. The assistant may proactively add concise analysis without waiting for an explicit request: call out peaks, dips, increases, decreases, active/new alignment or divergence, and short-term trend hypotheses, as long as every observation is grounded in the returned numbers and clearly avoids unsupported causation.',
    },
    cache,
  };
}

function formatDailyCollectionsToolResult(result: McpInsightResult, cache: Record<string, unknown>): Record<string, unknown> {
  const rows = result.value as DailyCollectionRow[];
  const startDate = rows[0]?.date ?? null;
  const endDate = rows.at(-1)?.date ?? null;
  const totals = rows.reduce(
    (summary, row) => ({
      active_sum: summary.active_sum + row.active,
      new_sum: summary.new_sum + row.new,
      active_peak: Math.max(summary.active_peak, row.active),
      new_peak: Math.max(summary.new_peak, row.new),
    }),
    { active_sum: 0, new_sum: 0, active_peak: 0, new_peak: 0 },
  );

  return {
    tool: 'get_daily_collections',
    intent: 'daily_collections_active_and_new_time_series',
    parameters: formatDateRangeParameters(result.dateRange ?? { days: 0 }),
    result: {
      primary_view: 'time_series_chart',
      period: {
        start_date: startDate,
        end_date: endDate,
        days: rows.length,
        timezone: 'UTC',
      },
      columns: [
        { key: 'date', description: 'UTC date of the rolling 24-hour bucket end.' },
        { key: 'day_offset', description: 'Rolling 24-hour buckets relative to the latest indexed event. 0 is the latest 24h bucket.' },
        { key: 'active', description: 'Unique ATProto collections observed in that rolling 24-hour bucket.' },
        { key: 'new', description: 'Collections first observed in that rolling 24-hour bucket.' },
      ],
      chart_spec: {
        type: 'line',
        title: 'Daily Collections',
        controls: [
          { label: 'This Week', days: 7 },
          { label: 'This Month', days: 30 },
          { label: 'This Year', days: 365 },
        ],
        x: {
          key: 'day_offset',
          type: 'ordinal',
          label: 'Days from latest indexed event',
        },
        series: [
          {
            key: 'active',
            label: 'Active',
            role: 'primary',
            color_hint: 'blue',
          },
          {
            key: 'new',
            label: 'New',
            role: 'secondary',
            color_hint: 'light_blue',
          },
        ],
        preferred_rendering: ['line_area_chart', 'mermaid_xychart', 'markdown_table'],
      },
      returned_day_count: rows.length,
      rows,
      summary: {
        active_peak: totals.active_peak,
        new_peak: totals.new_peak,
        active_average: rows.length === 0 ? 0 : Math.round(totals.active_sum / rows.length),
        new_total: totals.new_sum,
      },
      response_guidance:
        'Render this as a Daily Collections chart with Active and New lines like the reference card. Use day_offset on the x-axis for compact dashboard views and include This Week/This Month/This Year controls by calling this tool with days=7/30/365. Add concise observations grounded in the returned active/new counts only.',
    },
    cache,
  };
}

function formatNamespaceCollectionsToolResult(
  result: McpInsightResult,
  cache: Record<string, unknown>,
  lexicons: Map<string, LexiconResolutionSummary> = new Map(),
): Record<string, unknown> {
  return {
    tool: 'get_collections_for_namespace',
    intent: 'observed_nsids_under_namespace_prefix_with_lexicon_schema',
    raw_record_display_policy: RAW_RECORD_DISPLAY_POLICY,
    lexicon_policy: {
      lexicon_json_allowed_for_schema_understanding: true,
      instruction:
        'Lexicon definitions may be read and summarized as schema JSON. Actual record data JSON must never be displayed inline in chat.',
      response_guidance:
        'When schema_available is true, explain the Lexicon purpose, fields, types, and refs. When schema_available is false, say the schema is not available in the current data and describe the NSID cautiously from its name and observed activity. Do not mention resolver internals, DNS lookup names, or raw status codes unless the user explicitly asks for diagnostics. For actual user record data, provide only pds.ls/getRecord URLs.',
    },
    parameters: {
      namespace_prefix: result.namespacePrefix,
    },
    result: formatNamespaceCollectionsResult(result, lexicons),
    cache,
  };
}

function formatNewCollectionGroupsResult(result: McpInsightResult): Record<string, unknown> {
  const rows = result.value as NewCollectionRow[];
  const groups = summarizeNamespaceGroups(rows).map(
    ({ namespace_prefix, group_first_seen_at, first_seen_nsid_in_group, collection_count, event_count_since_group_first_seen }) => ({
      namespace_prefix,
      collection_count,
      group_first_seen_at,
      first_seen_nsid_in_group,
      event_count_since_group_first_seen,
    }),
  );

  return {
    ...formatDateRangeParameters(result.dateRange ?? { days: 0 }),
    returned_nsid_count: rows.length,
    returned_group_count: groups.length,
    field_descriptions: {
      namespace_prefix: 'Namespace group prefix for newly observed ATProto collection/NSID rows in this result.',
      collection_count: 'Number of newly observed NSIDs in this namespace group for the requested period.',
      group_first_seen_at:
        'Earliest first_seen_at timestamp among the newly observed NSIDs in this namespace group for the requested period.',
      first_seen_nsid_in_group:
        'Representative literal NSID first observed earliest within this namespace group for the requested period. This is not the complete list of NSIDs in the group.',
      event_count_since_group_first_seen:
        'Sum of observed events for the newly observed NSIDs in this namespace group since each NSID was first seen.',
    },
    response_guidance:
      'When presenting namespace_groups, describe first_seen_nsid_in_group as the representative NSID first observed within that group during the requested period, not as the full NSID list. Use collection_count to state how many NSIDs the group contains.',
    namespace_groups: groups,
  };
}

function formatNamespaceCollectionsResult(
  result: McpInsightResult,
  lexicons: Map<string, LexiconResolutionSummary> = new Map(),
): Record<string, unknown> {
  const rows = result.value as NamespaceCollectionRow[];
  return {
    namespace_prefix: result.namespacePrefix,
    returned_nsid_count: rows.length,
    nsids: rows.map((row) => ({
      collection: row.collection,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      event_count: row.event_count,
      latest_record: {
        created_at: row.latest_record_created_at,
        at_uri: row.latest_record_at_uri,
        pds_ls_url: buildPdsLsUrlForMcp(row.latest_record_at_uri),
        get_record_url: row.latest_record_get_record_url,
        guidance: 'Do not fetch or paste raw record JSON inline. Send the user to pds_ls_url to inspect actual data.',
      },
      lexicon: formatLexiconSummaryForMcp(
        lexicons.get(row.collection) ?? {
          collection: row.collection,
          authority_domain: getLexiconAuthorityDomain(row.collection),
          dns_name: '',
          status: 'not_found',
          guidance: '',
        },
      ),
    })),
  };
}

function formatLexiconSummaryForMcp(summary: LexiconResolutionSummary): McpLexiconSummary {
  if (summary.status === 'found' && summary.schema) {
    return {
      collection: summary.collection,
      schema_available: true,
      summary: 'Lexicon schema is available and may be used to explain fields, types, and references.',
      schema: summary.schema,
      lexicon_record_url: summary.lexicon_record_url,
      guidance: 'Use the schema for explanation. Do not fetch or paste actual record JSON inline.',
    };
  }

  return {
    collection: summary.collection,
    schema_available: false,
    summary: 'Lexicon schema is not available from the current data; describe this NSID cautiously from its name and observed activity.',
    guidance:
      'Avoid presenting resolver details, DNS lookup names, raw status labels, or error text unless the user explicitly asks for diagnostics. Do not fetch or paste actual record JSON inline.',
  };
}

async function resolveLexiconsForNamespaceRows(
  rows: NamespaceCollectionRow[],
  fetchImpl: FetchLike,
  timeoutMs: number,
  didDocumentCache: Map<string, DidDocumentCacheEntry>,
): Promise<Map<string, LexiconResolutionSummary>> {
  const entries = await Promise.all(rows.map((row) => resolveLexiconForCollection(row.collection, fetchImpl, timeoutMs, didDocumentCache)));
  return new Map(entries.map((entry) => [entry.collection, entry]));
}

async function resolveLexiconForCollection(
  collection: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  didDocumentCache: Map<string, DidDocumentCacheEntry>,
): Promise<LexiconResolutionSummary> {
  const authorityDomain = getLexiconAuthorityDomain(collection);
  const dnsName = `_lexicon.${authorityDomain}`;
  const guidance = 'Use this Lexicon schema to explain the NSID. Do not fetch or paste actual record JSON inline.';
  try {
    const did = await resolveLexiconDidFromDns(dnsName, fetchImpl, timeoutMs);
    if (!did) {
      return {
        collection,
        authority_domain: authorityDomain,
        dns_name: dnsName,
        status: 'not_found',
        guidance,
      };
    }

    const didDocument = await resolveDidDocument(did, fetchImpl, timeoutMs, didDocumentCache);
    const serviceEndpoint = getAtprotoPdsServiceEndpoint(didDocument);
    if (!serviceEndpoint) {
      return {
        collection,
        authority_domain: authorityDomain,
        dns_name: dnsName,
        status: 'not_found',
        did,
        guidance,
        error: 'No #atproto_pds service endpoint found in DID document',
      };
    }

    const lexiconRecordUrl = buildLexiconRecordUrl(serviceEndpoint, did, collection);
    const response = await withTimeout(fetchImpl(lexiconRecordUrl), timeoutMs, 'Lexicon record request timed out');
    if (!response.ok) {
      return {
        collection,
        authority_domain: authorityDomain,
        dns_name: dnsName,
        status: 'not_found',
        did,
        pds_service_endpoint: serviceEndpoint,
        lexicon_record_url: lexiconRecordUrl,
        guidance,
      };
    }

    const record = (await response.json()) as { value?: unknown };
    return {
      collection,
      authority_domain: authorityDomain,
      dns_name: dnsName,
      status: 'found',
      did,
      pds_service_endpoint: serviceEndpoint,
      lexicon_record_url: lexiconRecordUrl,
      schema: summarizeLexiconDefinition(record.value),
      guidance,
    };
  } catch (error) {
    return {
      collection,
      authority_domain: authorityDomain,
      dns_name: dnsName,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown Lexicon resolution error',
      guidance,
    };
  }
}

function getLexiconAuthorityDomain(collection: string): string {
  const parts = collection.split('.');
  if (parts.length < 2) {
    return collection;
  }
  return parts.slice(0, 2).reverse().join('.');
}

async function resolveLexiconDidFromDns(dnsName: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string | null> {
  const url = `${GOOGLE_DNS_RESOLVE_URL}?${new URLSearchParams({ name: dnsName, type: 'TXT' }).toString()}`;
  const response = await withTimeout(fetchImpl(url), timeoutMs, 'Lexicon DNS TXT request timed out');
  if (!response.ok) {
    return null;
  }
  const json = (await response.json()) as { Answer?: Array<{ data?: string }> };
  const txtData = json.Answer?.map((answer) => answer.data ?? '')
    .join('')
    .replace(/^"|"$/g, '')
    .replace(/"/g, '');
  const did = txtData?.match(/did=(did:[A-Za-z0-9:._%-]+)/)?.[1];
  return did ?? null;
}

async function resolveDidDocument(
  did: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  didDocumentCache: Map<string, DidDocumentCacheEntry>,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const cached = didDocumentCache.get(did);
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const url = did.startsWith('did:web:')
    ? `${UNIVERSAL_RESOLVER_URL}/${encodeURIComponent(did)}`
    : `${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`;
  const inFlight = (async () => {
    const response = await withTimeout(fetchImpl(url), timeoutMs, 'DID document request timed out');
    if (!response.ok) {
      throw new Error(`DID document request failed (${response.status})`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    if (did.startsWith('did:web:') && isRecord(json.didDocument)) {
      return json.didDocument;
    }
    return json;
  })();
  didDocumentCache.set(did, { expiresAt: now + DID_DOCUMENT_CACHE_TTL_MS, inFlight });
  try {
    const value = await inFlight;
    didDocumentCache.set(did, { expiresAt: Date.now() + DID_DOCUMENT_CACHE_TTL_MS, value });
    return value;
  } catch (error) {
    didDocumentCache.delete(did);
    throw error;
  }
}

function getAtprotoPdsServiceEndpoint(didDocument: Record<string, unknown>): string | null {
  const services = Array.isArray(didDocument.service) ? didDocument.service : [];
  const service = services.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === '#atproto_pds');
  const endpoint = service?.serviceEndpoint;
  if (typeof endpoint === 'string') {
    return endpoint;
  }
  if (Array.isArray(endpoint) && typeof endpoint[0] === 'string') {
    return endpoint[0];
  }
  return null;
}

function buildLexiconRecordUrl(serviceEndpoint: string, repo: string, collection: string): string {
  const params = new URLSearchParams({
    repo,
    collection: LEXICON_COLLECTION,
    rkey: collection,
  });
  return `${serviceEndpoint.replace(/\/+$/, '')}/xrpc/com.atproto.repo.getRecord?${params.toString()}`;
}

function summarizeLexiconDefinition(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { status: 'invalid_lexicon_value' };
  }
  const defs = isRecord(value.defs) ? value.defs : {};
  return {
    lexicon: value.lexicon,
    id: value.id,
    description: value.description,
    defs: Object.fromEntries(Object.entries(defs).map(([name, def]) => [name, summarizeLexiconDef(def)])),
  };
}

function summarizeLexiconDef(def: unknown): Record<string, unknown> {
  if (!isRecord(def)) {
    return { type: typeof def };
  }
  const summary: Record<string, unknown> = pickLexiconFields(def, ['type', 'description', 'key', 'record', 'ref', 'knownValues']);
  if (isRecord(def.record)) {
    summary.record = summarizeLexiconDef(def.record);
  }
  if (isRecord(def.properties)) {
    summary.properties = Object.fromEntries(Object.entries(def.properties).map(([name, prop]) => [name, summarizeLexiconProperty(prop)]));
  }
  if (Array.isArray(def.required)) {
    summary.required = def.required.filter((value) => typeof value === 'string');
  }
  return summary;
}

function summarizeLexiconProperty(prop: unknown): Record<string, unknown> {
  if (!isRecord(prop)) {
    return { type: typeof prop };
  }
  const summary: Record<string, unknown> = pickLexiconFields(prop, [
    'type',
    'description',
    'format',
    'ref',
    'knownValues',
    'maxLength',
    'minLength',
    'maximum',
    'minimum',
  ]);
  if (isRecord(prop.items)) {
    summary.items = pickLexiconFields(prop.items, ['type', 'ref', 'format']);
  }
  return summary;
}

function pickLexiconFields(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function formatDateRangeParameters(dateRange: McpDateRange): Record<string, unknown> {
  if (dateRange.startDate != null && dateRange.endDate != null) {
    return {
      start_date: dateRange.startDate,
      end_date: dateRange.endDate,
    };
  }
  return {
    lookback_days: dateRange.days,
  };
}

function summarizeNamespaceGroups(rows: NewCollectionRow[]): Array<{
  namespace_prefix: string;
  group_first_seen_at: string;
  first_seen_nsid_in_group: string;
  collection_count: number;
  event_count_since_group_first_seen: number;
  sample_nsids: Array<ReturnType<typeof formatNewCollectionRowForMcp>>;
}> {
  const groups = new Map<
    string,
    {
      group_first_seen_at: string;
      first_seen_nsid_in_group: string;
      collection_count: number;
      event_count_since_group_first_seen: number;
      sample_nsids: Array<ReturnType<typeof formatNewCollectionRowForMcp>>;
    }
  >();
  for (const row of rows) {
    const namespacePrefix = getNamespacePrefix(row.collection);
    const group = groups.get(namespacePrefix) ?? {
      group_first_seen_at: row.first_seen_at,
      first_seen_nsid_in_group: row.collection,
      collection_count: 0,
      event_count_since_group_first_seen: 0,
      sample_nsids: [],
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
    if (group.sample_nsids.length < 3) {
      group.sample_nsids.push(formatNewCollectionRowForMcp(row));
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
    );
}

function formatNewCollectionRowForMcp(row: NewCollectionRow): {
  collection: string;
  nsid_first_seen_at: string;
  event_count_since_nsid_first_seen: number;
  latest_record: {
    created_at: string;
    at_uri: string;
    get_record_url: string;
  };
} {
  return {
    collection: row.collection,
    nsid_first_seen_at: row.first_seen_at,
    event_count_since_nsid_first_seen: row.event_count,
    latest_record: {
      created_at: row.latest_record_created_at,
      at_uri: row.latest_record_at_uri,
      get_record_url: row.latest_record_get_record_url,
    },
  };
}

function getNamespacePrefix(collection: string): string {
  const parts = collection.split('.').filter(Boolean);
  if (parts.length <= 2) {
    return collection;
  }
  return `${parts[0]}.${parts[1]}.*`;
}

function buildPdsLsUrlForMcp(atUri: string): string {
  return `https://pds.ls/${atUri}`;
}

function mcpNewCollectionToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 14,
        default: 7,
        description: '直近何日分を見るか。1から14まで。start_date/end_date を指定する場合は省略できます。',
      },
      start_date: {
        type: 'string',
        description:
          '集計開始日。YYYY-MM-DD、YYYY/MM/DD、YYYY年M月D日。「2026年5月7日に生まれたNSID/Lexicon」のような日付指定は start_date と end_date を同じ日にし、明示的に個別NSID一覧を求められない限り namespace group として扱います。例: 「2026年5月1日から10日まで」は start_date=2026-05-01, end_date=2026-05-10。',
      },
      end_date: {
        type: 'string',
        description:
          '集計終了日。この日全体を含みます。YYYY-MM-DD、YYYY/MM/DD、YYYY年M月D日。「2026年5月7日に生まれたNSID/Lexicon」のような日付指定は start_date と end_date を同じ日にし、明示的に個別NSID一覧を求められない限り namespace group として扱います。',
      },
    },
  };
}

function mcpDailyUsersToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 365,
        default: 7,
        description:
          '直近何日分のDaily Users表を見るか。1から365まで。This Weekは7、This Monthは30、This Yearは365を指定します。',
      },
    },
  };
}

function mcpDailyCollectionsToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 365,
        default: 30,
        description:
          '直近何日分のDaily Collections表を見るか。1から365まで。This Weekは7、This Monthは30、This Yearは365を指定します。',
      },
    },
  };
}

function mcpNamespaceCollectionToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      namespace_prefix: {
        type: 'string',
        description: '配下NSIDを列挙したい namespace prefix。例: app.chavatar または app.chavatar.*。',
      },
    },
    required: ['namespace_prefix'],
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
