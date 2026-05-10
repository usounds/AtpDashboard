import { resolveAnalyticsEndpoint, type FrontendEndpointEnv } from '../../config/endpoints.ts';
import { buildRelativeDayOffsetCategories } from './chartLabels.ts';

export type DailyChartMetric = 'collections' | 'users';
export type DailyChartRange = '7 Days' | '30 Days' | '365 Days';

export type DailyChartRow = {
  date: string;
  day_offset: number;
  active: number;
  new: number;
};

export type DailyChartResponse = {
  rows: DailyChartRow[];
};

export type DailyChartSeries = {
  name: string;
  data: number[];
};

const dailyChartEndpoints: Record<DailyChartMetric, string> = {
  collections: 'daily_collections',
  users: 'daily_users',
};

export function buildDailyChartUrl(metric: DailyChartMetric, range: DailyChartRange, env?: FrontendEndpointEnv): string {
  const params = new URLSearchParams();
  if (range === '7 Days') {
    params.set('days', '7');
  } else if (range === '30 Days') {
    params.set('days', '30');
  } else {
    params.set('days', '365');
    params.set('bucket_days', '30');
  }
  return `${resolveAnalyticsEndpoint(dailyChartEndpoints[metric], env)}?${params.toString()}`;
}

export function buildDailyChartCategories(rows: DailyChartRow[]): string[] {
  return buildRelativeDayOffsetCategories(rows);
}

export function buildDailyChartSeries(
  rows: DailyChartRow[],
  activeTitle: string,
  newTitle: string,
): DailyChartSeries[] {
  return [
    {
      name: activeTitle,
      data: rows.map((row) => row.active),
    },
    {
      name: newTitle,
      data: rows.map((row) => row.new),
    },
  ];
}
