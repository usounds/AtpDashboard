import { resolveAnalyticsEndpoint, type FrontendEndpointEnv } from '../../config/endpoints.ts';

export type CollectionCumulativeUsersRange = '7 Days' | '30 Days' | '365 Days';

export type CollectionCumulativeUsersRow = {
  date: string;
  day_offset: number;
  new: number;
  cumulative: number;
};

export type CollectionCumulativeUsersResponse = {
  collection: string;
  rows: CollectionCumulativeUsersRow[];
};

export type CollectionCumulativeUsersSeries = {
  name: string;
  data: number[];
};

export function buildCollectionCumulativeUsersUrl(
  collection: string,
  range: CollectionCumulativeUsersRange,
  env?: FrontendEndpointEnv,
): string {
  const params = new URLSearchParams();
  params.set('collection', collection);
  if (range === '7 Days') {
    params.set('days', '7');
  } else if (range === '30 Days') {
    params.set('days', '30');
  } else {
    params.set('days', '365');
    params.set('bucket_days', '30');
  }
  return `${resolveAnalyticsEndpoint('collection_cumulative_users', env)}?${params.toString()}`;
}

export function buildCollectionCumulativeUsersCategories(rows: CollectionCumulativeUsersRow[]): string[] {
  return rows.map((row) => (row.day_offset === 0 ? '0' : String(row.day_offset)));
}

export function buildCollectionCumulativeUsersSeries(rows: CollectionCumulativeUsersRow[]): CollectionCumulativeUsersSeries[] {
  return [
    {
      name: 'Cumulative Users',
      data: rows.map((row) => row.cumulative),
    },
    {
      name: 'New Users',
      data: rows.map((row) => row.new),
    },
  ];
}
