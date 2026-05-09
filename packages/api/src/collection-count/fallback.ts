import type { CollectionCountApiConfig, FallbackReason } from './config.ts';
import type { CollectionCountResult, CollectionCountRow } from './types.ts';

export type FetchLike = typeof fetch;

export async function readCollectionCountFromPostgrest(
  config: Pick<CollectionCountApiConfig, 'postgrestCollectionCountUrl' | 'apiTimeoutMs'>,
  fetchImpl: FetchLike = fetch,
  reason: FallbackReason,
): Promise<CollectionCountResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);
  try {
    const response = await fetchImpl(config.postgrestCollectionCountUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`PostgREST fallback failed with ${response.status}`);
    }
    const rows = normalizePostgrestRows(await response.json());
    return {
      rows,
      headers: {
        dataSource: 'fallback',
        fallbackReason: reason,
        snapshotRefreshId: null,
        snapshotRefreshedAt: null,
        snapshotAgeSeconds: null,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizePostgrestRows(value: unknown): CollectionCountRow[] {
  if (!Array.isArray(value)) {
    throw new Error('PostgREST fallback response must be an array');
  }
  return value.map((row) => {
    if (!row || typeof row !== 'object') {
      throw new Error('Invalid PostgREST fallback row');
    }
    const source = row as Record<string, unknown>;
    return {
      collection: String(source.collection),
      count: Number(source.count),
      recent_count: Number(source.recent_count),
      min: source.min == null ? null : String(source.min),
      max: source.max == null ? null : String(source.max),
    };
  });
}
