import { resolveAnalyticsEndpoint, type FrontendEndpointEnv } from '../../config/endpoints.ts';

export type EventChartRange = '7 Days' | '30 Days' | '365 Days';

export type EventCountRow = {
  date: string;
  day_offset: number;
  count: number;
};

export type EventCountsResponse = {
  rows: EventCountRow[];
};

export function buildEventCountsUrl(range: EventChartRange, env?: FrontendEndpointEnv): string {
  const params = new URLSearchParams();
  if (range === '7 Days') {
    params.set('days', '7');
  } else if (range === '30 Days') {
    params.set('days', '30');
  } else {
    params.set('days', '365');
    params.set('bucket_days', '30');
  }
  return `${resolveAnalyticsEndpoint('event_counts', env)}?${params.toString()}`;
}

export function buildEventChartCategories(rows: EventCountRow[]): string[] {
  return rows.map((row) => (row.day_offset === 0 ? 'Today' : String(row.day_offset)));
}

export function buildEventChartSeries(rows: EventCountRow[]): { name: string; data: number[] }[] {
  return [
    {
      name: 'Events',
      data: rows.map((row) => row.count),
    },
  ];
}
