import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_ANALYTICS_API_BASE,
    DEFAULT_COLLECTION_COUNT_ENDPOINT,
    resolveAnalyticsEndpoint,
    resolveAnalyticsApiBase,
    resolveCollectionCountEndpoint,
} from './endpoints.ts';

test('uses ClickHouse collection_count_view API endpoint by default', () => {
    assert.equal(resolveCollectionCountEndpoint({}), DEFAULT_COLLECTION_COUNT_ENDPOINT);
});

test('uses configured collection_count_view endpoint when provided', () => {
    assert.equal(
        resolveCollectionCountEndpoint({
            VITE_COLLECTION_COUNT_ENDPOINT: 'https://example.com/collection_count_view',
        }),
        'https://example.com/collection_count_view',
    );
});

test('falls back to ClickHouse collection_count_view API endpoint for blank configuration', () => {
    assert.equal(resolveCollectionCountEndpoint({ VITE_COLLECTION_COUNT_ENDPOINT: '   ' }), DEFAULT_COLLECTION_COUNT_ENDPOINT);
});

test('uses ClickHouse analytics API base by default', () => {
    assert.equal(resolveAnalyticsApiBase({}), DEFAULT_ANALYTICS_API_BASE);
    assert.equal(
        resolveAnalyticsEndpoint('daily_collections', {}),
        'https://dashboardapi.usounds.work/api/analytics/daily_collections',
    );
    assert.equal(
        resolveAnalyticsEndpoint('unique_did_count', {}),
        'https://dashboardapi.usounds.work/api/analytics/unique_did_count',
    );
});

test('uses configured analytics API base when provided', () => {
    assert.equal(
        resolveAnalyticsEndpoint('/daily_users', {
            VITE_ANALYTICS_API_BASE: 'https://example.com/api/analytics/',
        }),
        'https://example.com/api/analytics/daily_users',
    );
    assert.equal(
        resolveAnalyticsEndpoint('/event_counts', {
            VITE_ANALYTICS_API_BASE: 'https://example.com/api/analytics/',
        }),
        'https://example.com/api/analytics/event_counts',
    );
});
