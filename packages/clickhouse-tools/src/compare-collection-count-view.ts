import { writeFile } from 'node:fs/promises';

export type CollectionCountRow = {
  collection: string;
  count: number;
  recent_count: number;
  min: string | null;
  max: string | null;
};

export type CompareCollectionCountOptions = {
  postgresUrl: string;
  clickhouseUrl: string;
  clickhouseOnly: boolean;
  jsonOut: string | null;
  markdownOut: string | null;
  sampleSize: number;
  topSize: number;
};

export type EndpointResult = {
  url: string;
  status: number;
  headers: Record<string, string | null>;
  rows: CollectionCountRow[];
  elapsedMs: number;
};

export type CompareIssue = {
  type:
    | 'http_status'
    | 'data_source'
    | 'row_count'
    | 'missing_collection'
    | 'extra_collection'
    | 'count_mismatch'
    | 'recent_count_mismatch'
    | 'min_mismatch'
    | 'max_mismatch';
  collection?: string;
  postgres?: unknown;
  clickhouse?: unknown;
};

export type CompareReport = {
  generatedAt: string;
  mode: 'fallback-allowed' | 'clickhouse-only';
  goNoGo: 'Go' | 'No-Go';
  endpoints: {
    postgres: Pick<EndpointResult, 'url' | 'status' | 'headers' | 'elapsedMs'>;
    clickhouse: Pick<EndpointResult, 'url' | 'status' | 'headers' | 'elapsedMs'>;
  };
  metrics: {
    postgresRows: number;
    clickhouseRows: number;
    issueCount: number;
    topCompared: number;
    sampleCompared: number;
  };
  issues: CompareIssue[];
  top100: Array<{
    collection: string;
    postgresCount: number | null;
    clickhouseCount: number | null;
    postgresRecentCount: number | null;
    clickhouseRecentCount: number | null;
  }>;
  sample: Array<{
    collection: string;
    status: 'match' | 'mismatch' | 'missing' | 'extra';
  }>;
};

const DEFAULT_POSTGRES_URL = 'https://collectiondata.usounds.work/collection_count_view';
const DEFAULT_CLICKHOUSE_URL = 'http://127.0.0.1:8787/api/analytics/collection_count_view';

export function parseCompareCollectionCountOptions(argv: string[]): CompareCollectionCountOptions {
  const options: CompareCollectionCountOptions = {
    postgresUrl: DEFAULT_POSTGRES_URL,
    clickhouseUrl: DEFAULT_CLICKHOUSE_URL,
    clickhouseOnly: false,
    jsonOut: null,
    markdownOut: null,
    sampleSize: 20,
    topSize: 100,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--clickhouse-only') {
      options.clickhouseOnly = true;
    } else if (arg === '--postgres-url') {
      options.postgresUrl = readNext(argv, ++index, arg);
    } else if (arg === '--clickhouse-url') {
      options.clickhouseUrl = readNext(argv, ++index, arg);
    } else if (arg === '--json-out') {
      options.jsonOut = readNext(argv, ++index, arg);
    } else if (arg === '--markdown-out') {
      options.markdownOut = readNext(argv, ++index, arg);
    } else if (arg === '--sample-size') {
      options.sampleSize = readNonNegativeInteger(readNext(argv, ++index, arg), arg);
    } else if (arg === '--top-size') {
      options.topSize = readNonNegativeInteger(readNext(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export async function compareCollectionCountView(
  options: CompareCollectionCountOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<CompareReport> {
  const [postgres, clickhouse] = await Promise.all([
    fetchEndpoint(options.postgresUrl, {}, fetchImpl),
    fetchEndpoint(
      options.clickhouseUrl,
      options.clickhouseOnly
        ? {
            'X-Disable-Fallback': 'true',
          }
        : {},
      fetchImpl,
    ),
  ]);

  const report = buildCompareReport(options, postgres, clickhouse);
  if (options.jsonOut) {
    await writeFile(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.markdownOut) {
    await writeFile(options.markdownOut, renderMarkdownReport(report));
  }
  return report;
}

export function buildCompareReport(
  options: Pick<CompareCollectionCountOptions, 'clickhouseOnly' | 'sampleSize' | 'topSize'>,
  postgres: EndpointResult,
  clickhouse: EndpointResult,
): CompareReport {
  const issues: CompareIssue[] = [];
  if (postgres.status !== 200) {
    issues.push({ type: 'http_status', postgres: postgres.status, clickhouse: null });
  }
  if (clickhouse.status !== 200) {
    issues.push({ type: 'http_status', postgres: null, clickhouse: clickhouse.status });
  }
  if (options.clickhouseOnly && clickhouse.headers['x-data-source'] !== 'clickhouse') {
    issues.push({ type: 'data_source', postgres: 'clickhouse', clickhouse: clickhouse.headers['x-data-source'] });
  }

  compareRows(postgres.rows, clickhouse.rows, issues);
  const top100 = buildTopRows(postgres.rows, clickhouse.rows, options.topSize);
  const sample = buildSample(postgres.rows, clickhouse.rows, options.sampleSize);

  return {
    generatedAt: new Date().toISOString(),
    mode: options.clickhouseOnly ? 'clickhouse-only' : 'fallback-allowed',
    goNoGo: issues.length === 0 ? 'Go' : 'No-Go',
    endpoints: {
      postgres: endpointSummary(postgres),
      clickhouse: endpointSummary(clickhouse),
    },
    metrics: {
      postgresRows: postgres.rows.length,
      clickhouseRows: clickhouse.rows.length,
      issueCount: issues.length,
      topCompared: top100.length,
      sampleCompared: sample.length,
    },
    issues,
    top100,
    sample,
  };
}

export function compareRows(postgresRows: CollectionCountRow[], clickhouseRows: CollectionCountRow[], issues: CompareIssue[]): void {
  if (postgresRows.length !== clickhouseRows.length) {
    issues.push({ type: 'row_count', postgres: postgresRows.length, clickhouse: clickhouseRows.length });
  }

  const postgresByCollection = new Map(postgresRows.map((row) => [row.collection, row]));
  const clickhouseByCollection = new Map(clickhouseRows.map((row) => [row.collection, row]));
  const collections = [...new Set([...postgresByCollection.keys(), ...clickhouseByCollection.keys()])].sort();

  for (const collection of collections) {
    const postgres = postgresByCollection.get(collection);
    const clickhouse = clickhouseByCollection.get(collection);
    if (!postgres) {
      issues.push({ type: 'extra_collection', collection, postgres: null, clickhouse: collection });
      continue;
    }
    if (!clickhouse) {
      issues.push({ type: 'missing_collection', collection, postgres: collection, clickhouse: null });
      continue;
    }
    pushMismatch(issues, 'count_mismatch', collection, postgres.count, clickhouse.count);
    pushMismatch(issues, 'recent_count_mismatch', collection, postgres.recent_count, clickhouse.recent_count);
    pushMismatch(issues, 'min_mismatch', collection, postgres.min, clickhouse.min);
    pushMismatch(issues, 'max_mismatch', collection, postgres.max, clickhouse.max);
  }
}

export function normalizeRows(value: unknown): CollectionCountRow[] {
  if (!Array.isArray(value)) {
    throw new Error('collection_count_view response must be an array');
  }
  return value.map((row) => {
    if (!row || typeof row !== 'object') {
      throw new Error('Invalid collection_count_view row');
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

export function renderMarkdownReport(report: CompareReport): string {
  const issueLines = report.issues.length === 0
    ? '- none'
    : report.issues.slice(0, 50).map((issue) => `- ${issue.type}${issue.collection ? ` ${issue.collection}` : ''}: postgres=${String(issue.postgres)} clickhouse=${String(issue.clickhouse)}`).join('\n');
  return `# collection_count_view Compare Report

- generatedAt: ${report.generatedAt}
- mode: ${report.mode}
- decision: ${report.goNoGo}
- postgresRows: ${report.metrics.postgresRows}
- clickhouseRows: ${report.metrics.clickhouseRows}
- issueCount: ${report.metrics.issueCount}
- clickhouseDataSource: ${report.endpoints.clickhouse.headers['x-data-source'] ?? ''}
- clickhouseFallbackReason: ${report.endpoints.clickhouse.headers['x-fallback-reason'] ?? ''}

## Issues

${issueLines}
`;
}

async function fetchEndpoint(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<EndpointResult> {
  const startedAt = Date.now();
  const response = await fetchImpl(url, { headers });
  const value = response.ok ? await response.json() : [];
  return {
    url,
    status: response.status,
    headers: {
      'x-data-source': response.headers.get('x-data-source'),
      'x-fallback-reason': response.headers.get('x-fallback-reason'),
      'x-snapshot-refresh-id': response.headers.get('x-snapshot-refresh-id'),
      'x-snapshot-refreshed-at': response.headers.get('x-snapshot-refreshed-at'),
      'x-snapshot-age-seconds': response.headers.get('x-snapshot-age-seconds'),
    },
    rows: response.ok ? normalizeRows(value) : [],
    elapsedMs: Date.now() - startedAt,
  };
}

function endpointSummary(endpoint: EndpointResult): Pick<EndpointResult, 'url' | 'status' | 'headers' | 'elapsedMs'> {
  return {
    url: endpoint.url,
    status: endpoint.status,
    headers: endpoint.headers,
    elapsedMs: endpoint.elapsedMs,
  };
}

function buildTopRows(
  postgresRows: CollectionCountRow[],
  clickhouseRows: CollectionCountRow[],
  topSize: number,
): CompareReport['top100'] {
  const clickhouseByCollection = new Map(clickhouseRows.map((row) => [row.collection, row]));
  return [...postgresRows]
    .sort((a, b) => b.count - a.count || a.collection.localeCompare(b.collection))
    .slice(0, topSize)
    .map((postgres) => {
      const clickhouse = clickhouseByCollection.get(postgres.collection);
      return {
        collection: postgres.collection,
        postgresCount: postgres.count,
        clickhouseCount: clickhouse?.count ?? null,
        postgresRecentCount: postgres.recent_count,
        clickhouseRecentCount: clickhouse?.recent_count ?? null,
      };
    });
}

function buildSample(
  postgresRows: CollectionCountRow[],
  clickhouseRows: CollectionCountRow[],
  sampleSize: number,
): CompareReport['sample'] {
  const clickhouseByCollection = new Map(clickhouseRows.map((row) => [row.collection, row]));
  return [...postgresRows]
    .sort((a, b) => a.collection.localeCompare(b.collection))
    .slice(0, sampleSize)
    .map((postgres) => {
      const clickhouse = clickhouseByCollection.get(postgres.collection);
      if (!clickhouse) {
        return { collection: postgres.collection, status: 'missing' };
      }
      return {
        collection: postgres.collection,
        status:
          postgres.count === clickhouse.count &&
          postgres.recent_count === clickhouse.recent_count &&
          postgres.min === clickhouse.min &&
          postgres.max === clickhouse.max
            ? 'match'
            : 'mismatch',
      };
    });
}

function pushMismatch(
  issues: CompareIssue[],
  type: Extract<CompareIssue['type'], 'count_mismatch' | 'recent_count_mismatch' | 'min_mismatch' | 'max_mismatch'>,
  collection: string,
  postgres: unknown,
  clickhouse: unknown,
): void {
  if (postgres !== clickhouse) {
    issues.push({ type, collection, postgres, clickhouse });
  }
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = parseCompareCollectionCountOptions(process.argv.slice(2));
  const report = await compareCollectionCountView(options);
  console.log(JSON.stringify(report, null, 2));
  if (report.goNoGo !== 'Go') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
