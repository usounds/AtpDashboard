import { serve } from '@hono/node-server';
import { Hono } from 'hono';
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

  app.use('*', secureHeaders());
  app.use(
    `${config.publicBasePath}/*`,
    cors({
      origin: '*',
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-Disable-Fallback'],
      exposeHeaders: [
        'X-Data-Source',
        'X-Fallback-Reason',
        'X-Snapshot-Refresh-Id',
        'X-Snapshot-Refreshed-At',
        'X-Snapshot-Age-Seconds',
      ],
      maxAge: 600,
    }),
  );
  app.use(`${config.publicBasePath}/*`, async (c, next) => {
    const rateLimit = checkRateLimit(rateLimitBuckets, getClientKey(c.req.raw, config), config);
    c.header('X-RateLimit-Limit', String(config.rateLimitRequestsPerMinute));
    c.header('X-RateLimit-Remaining', String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    return next();
  });

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
      mcp: 'deferred',
    }),
  );

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    console.error('[atpdashboard-api] request failed', sanitizeError(error));
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
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
