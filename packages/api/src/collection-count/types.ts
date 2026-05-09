import type { FallbackReason } from './config.ts';

export type CollectionCountRow = {
  collection: string;
  count: number;
  recent_count: number;
  min: string | null;
  max: string | null;
};

export type CollectionCountHeaders = {
  dataSource: 'clickhouse' | 'fallback' | 'unavailable';
  fallbackReason: FallbackReason | null;
  snapshotRefreshId: string | null;
  snapshotRefreshedAt: string | null;
  snapshotAgeSeconds: number | null;
};

export type CollectionCountResult = {
  rows: CollectionCountRow[];
  headers: CollectionCountHeaders;
};
