import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDailyChartCategories,
  buildDailyChartSeries,
  buildDailyChartUrl,
} from '../components/Charts/dailyChart.ts';
import {
  buildEventChartCategories,
  buildEventChartSeries,
  buildEventCountsUrl,
} from '../components/Charts/eventChart.ts';
import {
  buildCollectionCumulativeUsersCategories,
  buildCollectionCumulativeUsersSeries,
  buildCollectionCumulativeUsersUrl,
  formatCollectionCumulativeUsersOffset,
} from '../components/Charts/collectionCumulativeUsers.ts';

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

  assert.deepEqual(buildDailyChartCategories(rows), ['1d', 'Today']);
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

  assert.deepEqual(buildDailyChartCategories(rows), ['12m', 'Today']);
});

test('builds event counts URL on ClickHouse analytics API', () => {
  assert.equal(
    buildEventCountsUrl('30 Days', {}),
    'https://dashboardapi.usounds.work/api/analytics/event_counts?days=30',
  );
});

test('builds yearly event counts URL with 30 day buckets', () => {
  assert.equal(
    buildEventCountsUrl('365 Days', {
      VITE_ANALYTICS_API_BASE: 'https://example.com/api/analytics',
    }),
    'https://example.com/api/analytics/event_counts?days=365&bucket_days=30',
  );
});

test('maps event count rows to categories and series', () => {
  const rows = [
    { date: '2026-05-08', day_offset: -1, count: 120 },
    { date: '2026-05-09', day_offset: 0, count: 150 },
  ];

  assert.deepEqual(buildEventChartCategories(rows), ['1d', 'Today']);
  assert.deepEqual(buildEventChartSeries(rows), [{ name: 'Events', data: [120, 150] }]);
});

test('keeps yearly event count 30 day bucket offsets from the API', () => {
  const rows = [
    { date: '2025-05-14', day_offset: -360, count: 1250 },
    { date: '2026-05-09', day_offset: 0, count: 1530 },
  ];

  assert.deepEqual(buildEventChartCategories(rows), ['12m', 'Today']);
});

test('builds collection cumulative users URL on ClickHouse analytics API', () => {
  assert.equal(
    buildCollectionCumulativeUsersUrl('app.example.post', '30 Days', {}),
    'https://dashboardapi.usounds.work/api/analytics/collection_cumulative_users?collection=app.example.post&days=30',
  );
});

test('builds yearly collection cumulative users URL with 30 day buckets', () => {
  assert.equal(
    buildCollectionCumulativeUsersUrl('app.example.post', '365 Days', {
      VITE_ANALYTICS_API_BASE: 'https://example.com/api/analytics',
    }),
    'https://example.com/api/analytics/collection_cumulative_users?collection=app.example.post&days=365&bucket_days=30',
  );
});

test('maps collection cumulative users rows to categories and series', () => {
  const rows = [
    { date: '2026-05-08', day_offset: -1, new: 3, cumulative: 100 },
    { date: '2026-05-09', day_offset: 0, new: 2, cumulative: 102 },
  ];

  assert.deepEqual(buildCollectionCumulativeUsersCategories(rows), ['1d', 'Today']);
  assert.deepEqual(buildCollectionCumulativeUsersSeries(rows), [
    { name: 'Cumulative Users', data: [100, 102] },
    { name: 'New Users', data: [3, 2] },
  ]);
});

test('keeps yearly collection cumulative users 30 day bucket offsets from the API', () => {
  const rows = [
    { date: '2025-05-14', day_offset: -360, new: 50, cumulative: 50 },
    { date: '2026-05-09', day_offset: 0, new: 12, cumulative: 300 },
  ];

  assert.deepEqual(buildCollectionCumulativeUsersCategories(rows), ['12m', 'Today']);
});

test('formats collection cumulative users offsets for daily and monthly buckets', () => {
  assert.equal(formatCollectionCumulativeUsersOffset(0, false), 'Today');
  assert.equal(formatCollectionCumulativeUsersOffset(-29, false), '29d');
  assert.equal(formatCollectionCumulativeUsersOffset(-360, true), '12m');
  assert.equal(formatCollectionCumulativeUsersOffset(-30, true), '1m');
});
