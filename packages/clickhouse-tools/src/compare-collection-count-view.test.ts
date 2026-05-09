import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCompareReport,
  compareCollectionCountView,
  compareRows,
  normalizeRows,
  parseCompareCollectionCountOptions,
  renderMarkdownReport,
  type CollectionCountRow,
} from './compare-collection-count-view.ts';

const rows: CollectionCountRow[] = [
  {
    collection: 'app.example.post',
    count: 10,
    recent_count: 2,
    min: '2026-05-01T00:00:00.000000Z',
    max: '2026-05-09T00:00:00.000000Z',
  },
];

test('parses clickhouse-only and output options', () => {
  const options = parseCompareCollectionCountOptions([
    '--',
    '--clickhouse-only',
    '--postgres-url',
    'https://pg.example/collection_count_view',
    '--clickhouse-url',
    'https://ch.example/api/analytics/collection_count_view',
    '--json-out',
    '/tmp/report.json',
    '--markdown-out',
    '/tmp/report.md',
  ]);

  assert.equal(options.clickhouseOnly, true);
  assert.equal(options.postgresUrl, 'https://pg.example/collection_count_view');
  assert.equal(options.clickhouseUrl, 'https://ch.example/api/analytics/collection_count_view');
  assert.equal(options.jsonOut, '/tmp/report.json');
  assert.equal(options.markdownOut, '/tmp/report.md');
});

test('normalizes numeric strings and null dates', () => {
  assert.deepEqual(
    normalizeRows([{ collection: 'a', count: '1', recent_count: '0', min: null, max: '2026-05-09' }]),
    [{ collection: 'a', count: 1, recent_count: 0, min: null, max: '2026-05-09' }],
  );
});

test('detects row and field mismatches', () => {
  const issues = [];

  compareRows(rows, [{ ...rows[0], count: 11, recent_count: 3 }], issues);

  assert.deepEqual(issues.map((issue) => issue.type), ['count_mismatch', 'recent_count_mismatch']);
});

test('clickhouse-only fails if API data source is fallback', () => {
  const report = buildCompareReport(
    { clickhouseOnly: true, sampleSize: 10, topSize: 100 },
    endpoint('postgres', 200, {}, rows),
    endpoint('clickhouse', 200, { 'x-data-source': 'fallback' }, rows),
  );

  assert.equal(report.goNoGo, 'No-Go');
  assert.equal(report.issues[0].type, 'data_source');
});

test('matching clickhouse source is Go', () => {
  const report = buildCompareReport(
    { clickhouseOnly: true, sampleSize: 10, topSize: 100 },
    endpoint('postgres', 200, {}, rows),
    endpoint('clickhouse', 200, { 'x-data-source': 'clickhouse' }, rows),
  );

  assert.equal(report.goNoGo, 'Go');
  assert.equal(report.metrics.issueCount, 0);
  assert.equal(report.top100[0].collection, 'app.example.post');
  assert.equal(report.sample[0].status, 'match');
});

test('compareCollectionCountView sends X-Disable-Fallback in clickhouse-only mode', async () => {
  const seenHeaders: Record<string, string | undefined> = {};
  const report = await compareCollectionCountView(
    {
      postgresUrl: 'https://pg.example/collection_count_view',
      clickhouseUrl: 'https://ch.example/api/analytics/collection_count_view',
      clickhouseOnly: true,
      jsonOut: null,
      markdownOut: null,
      sampleSize: 10,
      topSize: 100,
    },
    async (url, init) => {
      if (String(url).includes('ch.example')) {
        seenHeaders.disableFallback = (init?.headers as Record<string, string>)?.['X-Disable-Fallback'];
        return response(rows, { 'x-data-source': 'clickhouse' });
      }
      return response(rows);
    },
  );

  assert.equal(seenHeaders.disableFallback, 'true');
  assert.equal(report.goNoGo, 'Go');
});

test('renders markdown report with decision and issue count', () => {
  const report = buildCompareReport(
    { clickhouseOnly: false, sampleSize: 10, topSize: 100 },
    endpoint('postgres', 200, {}, rows),
    endpoint('clickhouse', 500, {}, []),
  );
  const markdown = renderMarkdownReport(report);

  assert.match(markdown, /decision: No-Go/);
  assert.match(markdown, /issueCount:/);
});

function endpoint(
  url: string,
  status: number,
  headers: Record<string, string | null>,
  endpointRows: CollectionCountRow[],
) {
  return {
    url,
    status,
    headers: {
      'x-data-source': null,
      'x-fallback-reason': null,
      'x-snapshot-refresh-id': null,
      'x-snapshot-refreshed-at': null,
      'x-snapshot-age-seconds': null,
      ...headers,
    },
    rows: endpointRows,
    elapsedMs: 1,
  };
}

function response(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}
