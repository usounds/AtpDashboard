import assert from 'node:assert/strict';
import test from 'node:test';
import { FALLBACK_REASONS, getPublicRoute, loadCollectionCountApiConfig } from './config.ts';

test('loads safe defaults for local Hono API', () => {
  const config = loadCollectionCountApiConfig({
    ATPDASHBOARD_ALLOW_PUBLIC_BIND: 'false',
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.publicBasePath, '/api/analytics');
  assert.equal(config.rateLimitRequestsPerMinute, 60);
  assert.equal(config.clickhouseTimeoutMs, 2000);
  assert.equal(config.apiTimeoutMs, 3000);
  assert.equal(config.trustForwardedHeaders, false);
  assert.equal(config.forceCollectionCountFallback, false);
});

test('normalizes route path', () => {
  const route = getPublicRoute({ publicBasePath: '/api/analytics' }, 'collection_count_view');

  assert.equal(route, '/api/analytics/collection_count_view');
});

test('refuses production public bind unless explicitly allowed', () => {
  assert.throws(
    () =>
      loadCollectionCountApiConfig({
        NODE_ENV: 'production',
        ATPDASHBOARD_API_HOST: '0.0.0.0',
        ATPDASHBOARD_ALLOW_PUBLIC_BIND: 'false',
      }),
    /Refusing non-loopback production bind/,
  );
});

test('requires ClickHouse timeout lower than total API timeout', () => {
  assert.throws(
    () =>
      loadCollectionCountApiConfig({
        CLICKHOUSE_TIMEOUT_MS: '3000',
        ATPDASHBOARD_API_TIMEOUT_MS: '3000',
      }),
    /CLICKHOUSE_TIMEOUT_MS must be lower/,
  );
});

test('exports fixed fallback reason taxonomy', () => {
  assert.deepEqual([...FALLBACK_REASONS], [
    'stale_snapshot',
    'clickhouse_timeout',
    'clickhouse_error',
    'circuit_open',
    'forced_fallback',
    'fallback_failed',
    'unavailable',
  ]);
});
