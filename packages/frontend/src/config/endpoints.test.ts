import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_COLLECTION_COUNT_ENDPOINT, resolveCollectionCountEndpoint } from './endpoints.ts';

test('uses existing PostgREST collection_count_view endpoint by default', () => {
    assert.equal(resolveCollectionCountEndpoint({}), DEFAULT_COLLECTION_COUNT_ENDPOINT);
});

test('uses configured collection_count_view endpoint when provided', () => {
    assert.equal(
        resolveCollectionCountEndpoint({
            VITE_COLLECTION_COUNT_ENDPOINT: 'https://collectiondata.usounds.work/api/analytics/collection_count_view',
        }),
        'https://collectiondata.usounds.work/api/analytics/collection_count_view',
    );
});

test('falls back to existing PostgREST endpoint for blank configuration', () => {
    assert.equal(resolveCollectionCountEndpoint({ VITE_COLLECTION_COUNT_ENDPOINT: '   ' }), DEFAULT_COLLECTION_COUNT_ENDPOINT);
});
