export const FALLBACK_REASONS = [
  'stale_snapshot',
  'clickhouse_timeout',
  'clickhouse_error',
  'circuit_open',
  'forced_fallback',
  'fallback_failed',
  'unavailable',
] as const;

export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export type CollectionCountApiConfig = {
  host: string;
  port: number;
  publicBasePath: string;
  postgrestCollectionCountUrl: string;
  clickhouseUrl: string | null;
  clickhouseDatabase: string;
  clickhouseUsername: string | null;
  clickhousePassword: string | null;
  allowedOrigins: string[];
  trustedProxyCidrs: string[];
  trustForwardedHeaders: boolean;
  rateLimitRequestsPerMinute: number;
  clickhouseTimeoutMs: number;
  apiTimeoutMs: number;
  snapshotMaxAgeSeconds: number;
  circuitBreakerFailureThreshold: number;
  circuitBreakerOpenMs: number;
  responseCacheTtlMs: number;
  forceCollectionCountFallback: boolean;
  nodeEnv: string;
};

export type ConfigEnv = Record<string, string | undefined>;

const DEFAULT_POSTGREST_COLLECTION_COUNT_URL = 'https://collectiondata.usounds.work/collection_count_view';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://atpdashboard.usounds.work',
  'http://localhost:5173',
  'http://localhost:3000',
];

export function loadCollectionCountApiConfig(env: ConfigEnv = process.env): CollectionCountApiConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const host = env.ATPDASHBOARD_API_HOST ?? '127.0.0.1';
  const config: CollectionCountApiConfig = {
    host,
    port: readInteger(env.ATPDASHBOARD_API_PORT, 8787, 'ATPDASHBOARD_API_PORT', { min: 1, max: 65535 }),
    publicBasePath: normalizeBasePath(env.ATPDASHBOARD_API_BASE_PATH ?? '/api/analytics'),
    postgrestCollectionCountUrl: readHttpUrl(
      env.POSTGREST_COLLECTION_COUNT_URL ?? DEFAULT_POSTGREST_COLLECTION_COUNT_URL,
      'POSTGREST_COLLECTION_COUNT_URL',
    ),
    clickhouseUrl: readOptionalHttpUrl(env.CLICKHOUSE_URL, 'CLICKHOUSE_URL'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'atp_dashboard',
    clickhouseUsername: readOptionalSecret(env.CLICKHOUSE_USERNAME),
    clickhousePassword: readOptionalSecret(env.CLICKHOUSE_PASSWORD),
    allowedOrigins: readCsv(env.ATPDASHBOARD_API_ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS),
    trustedProxyCidrs: readCsv(env.ATPDASHBOARD_TRUSTED_PROXY_CIDRS, ['127.0.0.1/32', '::1/128']),
    trustForwardedHeaders: readBoolean(env.ATPDASHBOARD_TRUST_FORWARDED_HEADERS, false),
    rateLimitRequestsPerMinute: readInteger(env.ATPDASHBOARD_API_RATE_LIMIT_PER_MINUTE, 60, 'ATPDASHBOARD_API_RATE_LIMIT_PER_MINUTE', { min: 1 }),
    clickhouseTimeoutMs: readInteger(env.CLICKHOUSE_TIMEOUT_MS, 2000, 'CLICKHOUSE_TIMEOUT_MS', { min: 100 }),
    apiTimeoutMs: readInteger(env.ATPDASHBOARD_API_TIMEOUT_MS, 3000, 'ATPDASHBOARD_API_TIMEOUT_MS', { min: 100 }),
    snapshotMaxAgeSeconds: readInteger(env.SNAPSHOT_MAX_AGE_SECONDS, 1800, 'SNAPSHOT_MAX_AGE_SECONDS', { min: 1 }),
    circuitBreakerFailureThreshold: readInteger(env.CLICKHOUSE_CIRCUIT_BREAKER_FAILURE_THRESHOLD, 3, 'CLICKHOUSE_CIRCUIT_BREAKER_FAILURE_THRESHOLD', { min: 1 }),
    circuitBreakerOpenMs: readInteger(env.CLICKHOUSE_CIRCUIT_BREAKER_OPEN_MS, 60000, 'CLICKHOUSE_CIRCUIT_BREAKER_OPEN_MS', { min: 1000 }),
    responseCacheTtlMs: readInteger(env.COLLECTION_COUNT_RESPONSE_CACHE_TTL_MS, 30000, 'COLLECTION_COUNT_RESPONSE_CACHE_TTL_MS', { min: 0 }),
    forceCollectionCountFallback: readBoolean(env.FORCE_COLLECTION_COUNT_FALLBACK, false),
    nodeEnv,
  };

  assertSafeBind(config, nodeEnv, env);
  assertTimeoutBudget(config);
  return config;
}

export function getPublicRoute(config: Pick<CollectionCountApiConfig, 'publicBasePath'>, route: string): string {
  return `${config.publicBasePath}${route.startsWith('/') ? route : `/${route}`}`;
}

function readOptionalSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readCsv(value: string | undefined, fallback: string[]): string[] {
  const rawValues = value == null ? fallback : value.split(',');
  const values = rawValues.map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function readInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  bounds: { min?: number; max?: number } = {},
): number {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  if (bounds.min != null && parsed < bounds.min) {
    throw new Error(`${name} must be >= ${bounds.min}`);
  }
  if (bounds.max != null && parsed > bounds.max) {
    throw new Error(`${name} must be <= ${bounds.max}`);
  }
  return parsed;
}

function readHttpUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return url.toString();
}

function readOptionalHttpUrl(value: string | undefined, name: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? readHttpUrl(trimmed, name) : null;
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error('ATPDASHBOARD_API_BASE_PATH must start with /');
  }
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

function assertSafeBind(config: CollectionCountApiConfig, nodeEnv: string, env: ConfigEnv): void {
  const explicitlyAllowPublicBind = readBoolean(env.ATPDASHBOARD_ALLOW_PUBLIC_BIND, false);
  const isLoopback = config.host === '127.0.0.1' || config.host === '::1' || config.host === 'localhost';
  if (!isLoopback && nodeEnv === 'production' && !explicitlyAllowPublicBind) {
    throw new Error('Refusing non-loopback production bind without ATPDASHBOARD_ALLOW_PUBLIC_BIND=true');
  }
}

function assertTimeoutBudget(config: CollectionCountApiConfig): void {
  if (config.clickhouseTimeoutMs >= config.apiTimeoutMs) {
    throw new Error('CLICKHOUSE_TIMEOUT_MS must be lower than ATPDASHBOARD_API_TIMEOUT_MS');
  }
}
