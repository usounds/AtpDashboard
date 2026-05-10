# ClickHouse部分移行 ローカル初期設定

この手順は、`collection_count_view` のClickHouse部分移行をローカル開発環境で小さく検証するためのものです。

本番DBには触れず、Docker上のローカルPostgres/ClickHouseで確認します。

## 0. 実行場所

原則として、コマンドはmonorepoルートで実行します。

```bash
cd /Users/usounds/Program/AtpDashboard
rtk pwd
```

期待:

```text
/Users/usounds/Program/AtpDashboard
```

## 1. DBなしでできる確認

まずコードだけ確認します。

```bash
rtk pnpm test:api
rtk pnpm test:clickhouse-tools
rtk pnpm build
```

Hono APIをDBなしで起動します。

```bash
rtk pnpm --filter @atpdashboard/api dev
```

`127.0.0.1:8787` が使用中の場合は別ポートを使います。

```bash
ATPDASHBOARD_API_PORT=8788 rtk pnpm --filter @atpdashboard/api dev
```

別ターミナルで確認します。

```bash
rtk curl http://127.0.0.1:8788/healthz
rtk curl http://127.0.0.1:8788/api/analytics/status
```

期待:

- `/healthz` が `ok: true` を返す
- `/api/analytics/status` が `clickhouse_configured: false` を返す
- `postgrest_fallback_configured: true` になっている

fallback確認:

```bash
rtk curl -i http://127.0.0.1:8788/api/analytics/collection_count_view
```

期待:

```text
X-Data-Source: fallback
```

この時点ではClickHouse未設定なので、既存PostgRESTへfallbackするのが正常です。

## 2. ClickHouseをDockerで起動

古いコンテナが残っている場合は削除します。

```bash
rtk docker rm -f -v atpdashboard-clickhouse
```

ClickHouseを起動します。

```bash
rtk docker run -d \
  --name atpdashboard-clickhouse \
  -e CLICKHOUSE_USER=default \
  -e CLICKHOUSE_PASSWORD=clickhouse \
  -p 8123:8123 \
  -p 9000:9000 \
  clickhouse/clickhouse-server
```

接続確認:

```bash
rtk curl 'http://default:clickhouse@127.0.0.1:8123/' --data-binary 'SELECT 1'
```

期待:

```text
1
```

以後、ローカルの `CLICKHOUSE_URL` は以下です。

```bash
CLICKHOUSE_URL=http://default:clickhouse@127.0.0.1:8123
```

## 3. PostgresをDockerで起動

Cloudflare Zero Trust / `cloudflared` が `127.0.0.1:5432` を使っている場合があります。
その場合、ホストから `127.0.0.1:5432` に接続するとDockerのPostgresではなく `cloudflared` 側へ到達し、認証エラーになります。

この手順では衝突を避けるため、ホスト側は `55432` を使います。

古い検証コンテナが残っている場合は削除します。

```bash
rtk docker rm -f -v atpdashboard-postgres
```

```bash
rtk docker run -d \
  --name atpdashboard-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=atpdashboard \
  -p 55432:5432 \
  postgres:16
```

接続確認:

```bash
rtk docker exec atpdashboard-postgres psql -U postgres -d atpdashboard -c "SELECT 1;"
```

期待:

```text
 ?column?
----------
        1
```

以後、ローカルの `POSTGRES_URL` は以下です。

```bash
POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55432/atpdashboard
```

## 4. ローカルPostgresに検証用collectionを作る

```bash
rtk docker exec atpdashboard-postgres psql -U postgres -d atpdashboard -c '
CREATE TABLE IF NOT EXISTS public.collection (
  did text NOT NULL,
  collection text NOT NULL,
  rkey text NOT NULL,
  "createdAt" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS collection_did_collection_rkey_createdat_idx
ON public.collection (did, collection, rkey, "createdAt");
'
```

少量のテストデータを入れます。

```bash
rtk docker exec atpdashboard-postgres psql -U postgres -d atpdashboard -c '
INSERT INTO public.collection (did, collection, rkey, "createdAt") VALUES
  ('\''did:plc:alice'\'', '\''app.example.post'\'', '\''r1'\'', now() - interval '\''1 hour'\''),
  ('\''did:plc:bob'\'', '\''app.example.post'\'', '\''r2'\'', now() - interval '\''2 days'\''),
  ('\''did:plc:carol'\'', '\''app.example.like'\'', '\''r3'\'', now() - interval '\''5 days'\''),
  ('\''did:web:lexicon.store'\'', '\''app.example.post'\'', '\''r4'\'', now())
ON CONFLICT DO NOTHING;
'
```

確認:

```bash
rtk docker exec atpdashboard-postgres psql -U postgres -d atpdashboard -c '
SELECT collection, count(*)
FROM public.collection
GROUP BY collection
ORDER BY collection;
'
```

期待:

```text
 app.example.like | 1
 app.example.post | 3
```

## 5. Postgres checkpoint/lock DDLを適用

monorepoルートで実行します。

```bash
cd /Users/usounds/Program/AtpDashboard
rtk docker exec -i atpdashboard-postgres psql -U postgres -d atpdashboard < sql/postgres/clickhouse/sync_state.sql
```

確認:

```bash
rtk docker exec atpdashboard-postgres psql -U postgres -d atpdashboard -c '\dt public.clickhouse_sync_*'
```

期待:

```text
clickhouse_sync_checkpoints
clickhouse_sync_locks
```

## 6. ClickHouse DDLを適用

ClickHouse HTTP APIは複数SQL文を一度に流せない場合があります。

このリポジトリのDDLは `CREATE DATABASE` と `CREATE TABLE` を含むため、Dockerコンテナ内の `clickhouse-client --multiquery` を使います。

```bash
cd /Users/usounds/Program/AtpDashboard
```

```bash
rtk docker exec -i atpdashboard-clickhouse clickhouse-client \
  --user default \
  --password clickhouse \
  --multiquery < sql/clickhouse/001_collection_events.sql
```

```bash
rtk docker exec -i atpdashboard-clickhouse clickhouse-client \
  --user default \
  --password clickhouse \
  --multiquery < sql/clickhouse/002_collection_count_snapshot.sql
```

```bash
rtk docker exec -i atpdashboard-clickhouse clickhouse-client \
  --user default \
  --password clickhouse \
  --multiquery < sql/clickhouse/003_collection_count_refresh.sql
```

```bash
rtk docker exec -i atpdashboard-clickhouse clickhouse-client \
  --user default \
  --password clickhouse \
  --multiquery < sql/clickhouse/004_analytics_chart_snapshot.sql
```

```bash
rtk docker exec -i atpdashboard-clickhouse clickhouse-client \
  --user default \
  --password clickhouse \
  --multiquery < sql/clickhouse/005_analytics_chart_rollups.sql
```

確認:

```bash
rtk curl 'http://default:clickhouse@127.0.0.1:8123/' --data-binary 'SHOW TABLES FROM atp_dashboard'
```

期待:

```text
collection_count_refresh_manifest
collection_count_snapshot
collection_events
analytics_chart_refresh_manifest
analytics_chart_snapshot
analytics_collection_first_seen_state
analytics_collection_first_seen_state_mv
analytics_daily_activity_rollup
analytics_daily_activity_rollup_mv
analytics_daily_collection_activity_rollup
analytics_daily_collection_activity_rollup_mv
analytics_daily_new_collection_rollup
analytics_daily_new_did_rollup
analytics_did_first_seen_state
analytics_did_first_seen_state_mv
```

## 7. backfill dry-run

Postgresを読むだけで、ClickHouseには書きません。

```bash
rtk env POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55432/atpdashboard \
  pnpm backfill:collection-events -- --dry-run --limit 100
```

見るポイント:

- `rowsRead` が出る
- `rowsInserted` が `0`
- `finalWatermark` が出る
- エラーにならない

## 8. 小さくbackfillを書き込む

ローカルDBにだけ書き込みます。

```bash
rtk env POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55432/atpdashboard \
  CLICKHOUSE_URL=http://default:clickhouse@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm backfill:collection-events -- --confirm-production --limit 100
```

ClickHouse側の件数確認:

```bash
rtk curl 'http://default:clickhouse@127.0.0.1:8123/' --data-binary '
SELECT collection, count()
FROM atp_dashboard.collection_events
GROUP BY collection
ORDER BY collection
'
```

## 9. snapshot refresh

まずdry-run:

```bash
rtk env CLICKHOUSE_URL=http://default:clickhouse@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm refresh:collection-count -- --dry-run
```

ローカルClickHouseへ書き込み:

```bash
rtk env CLICKHOUSE_URL=http://default:clickhouse@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm refresh:collection-count -- --confirm-production
```

確認:

```bash
rtk curl 'http://default:clickhouse@127.0.0.1:8123/' --data-binary '
SELECT refresh_id, status, row_count
FROM atp_dashboard.collection_count_refresh_manifest
ORDER BY updated_at DESC
LIMIT 5
'
```

## 10. Hono APIをClickHouseありで起動

```bash
rtk env ATPDASHBOARD_API_PORT=8788 \
  CLICKHOUSE_URL=http://default:clickhouse@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  POSTGREST_COLLECTION_COUNT_URL=https://collectiondata.usounds.work/collection_count_view \
  pnpm --filter @atpdashboard/api dev
```

確認:

```bash
rtk curl http://127.0.0.1:8788/api/analytics/status
rtk curl -i http://127.0.0.1:8788/api/analytics/collection_count_view
```

期待:

```text
X-Data-Source: clickhouse
```

もしsnapshotが古い、またはClickHouse接続に失敗する場合は `X-Data-Source: fallback` になります。

## 11. 比較スクリプト

ClickHouseのみを合格条件にする比較:

```bash
rtk pnpm compare:collection-count -- --clickhouse-only \
  --postgres-url https://collectiondata.usounds.work/collection_count_view \
  --clickhouse-url http://127.0.0.1:8788/api/analytics/collection_count_view \
  --json-out reports/collection-count-compare.json \
  --markdown-out reports/collection-count-compare.md
```

`--clickhouse-only` ではAPIへ `X-Disable-Fallback: true` を送ります。

`X-Data-Source: clickhouse` でない場合は `No-Go` になります。

## 12. まだやらないこと

以下はProduction Default Gate前の別手順です。

- Cloudflare route切替
- Vercel endpoint切替
- 本番Postgresへのbackfill
- 本番Hono APIの常駐化
- MCP endpoint公開
- 24時間観測とGo/No-Go承認
