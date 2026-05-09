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

test('uses PostgREST analytics base by default', () => {
    assert.equal(resolveAnalyticsApiBase({}), DEFAULT_ANALYTICS_API_BASE);
    assert.equal(
        resolveAnalyticsEndpoint('active_collection_summary_view', {}),
        'https://collectiondata.usounds.work/active_collection_summary_view',
    );
});

test('keeps daily summary endpoints on PostgREST even when analytics API base is configured', () => {
    assert.equal(
        resolveAnalyticsEndpoint('/active_collection_summary_view', {
            VITE_ANALYTICS_API_BASE: 'https://example.com/api/analytics/',
        }),
        'https://collectiondata.usounds.work/active_collection_summary_view',
    );
});
