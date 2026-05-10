import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDailyChartCategories,
  buildDailyChartSeries,
  buildDailyChartUrl,
} from '../components/Charts/dailyChart.ts';

test('builds daily collections URL on ClickHouse analytics API', () => {
  assert.equal(
    buildDailyChartUrl('collections', '30 Days', {}),
    'https://dashboardapi.usounds.work/api/analytics/daily_collections?days=30',
  );
});

test('builds yearly URL with 30 day buckets', () => {
  assert.equal(
    buildDailyChartUrl('users', '365 Days', {
      VITE_ANALYTICS_API_BASE: 'https://example.com/api/analytics',
    }),
    'https://example.com/api/analytics/daily_users?days=365&bucket_days=30',
  );
});

test('maps daily chart rows to categories and series', () => {
  const rows = [
    { date: '2026-05-08', day_offset: -1, active: 452, new: 18 },
    { date: '2026-05-09', day_offset: 0, active: 489, new: 31 },
  ];

  assert.deepEqual(buildDailyChartCategories(rows), ['-1', '0']);
  assert.deepEqual(buildDailyChartSeries(rows, 'Active', 'New'), [
    { name: 'Active', data: [452, 489] },
    { name: 'New', data: [18, 31] },
  ]);
});

test('keeps yearly 30 day bucket offsets from the API', () => {
  const rows = [
    { date: '2025-05-14', day_offset: -360, active: 100, new: 10 },
    { date: '2026-05-09', day_offset: 0, active: 150, new: 12 },
  ];

  assert.deepEqual(buildDailyChartCategories(rows), ['-360', '0']);
});
