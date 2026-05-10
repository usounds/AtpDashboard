# ClickHouse部分移行 運用手順書

この運用手順書は `collection_count_view` ClickHouse-backed API の運用、Cloudflare Zero Trust配置、障害時フォールバック、復旧確認、本番既定化切替、切り戻しを扱う。

対象は `collection_count_view` のみである。他のPostgREST view、MCP endpoint、Postgres正本の変更は対象外とする。

## 原則

- Postgres `public.collection` は source of truth のまま維持する。
- ClickHouseは派生read modelであり、不整合時は破棄・再構築できるものとして扱う。
- 既存PostgREST `/collection_count_view` は常にフォールバック先として残す。
- ブラウザへClickHouse接続情報を出さない。
- 比較差分が解消するまで本番既定経路にしない。
- 本番既定化後でも、緊急時は `FORCE_COLLECTION_COUNT_FALLBACK=true` またはCloudflare経路の切り戻しでPostgRESTへ戻す。

## サービス構成

```text
Vercelフロントエンド
  -> collectiondata.usounds.work/collection_count_view
       -> PostgREST
  -> collectiondata.usounds.work/api/analytics/collection_count_view
       -> Hono API
       -> ClickHouse completed snapshot
       -> PostgRESTへフォールバック

Postgres public.collection
  -> backfill/sync worker
  -> ClickHouse collection_events
  -> refresh worker
  -> ClickHouse collection_count_snapshot
```

## APIとtoolsの動かし方

基本方針として、APIとtoolsはDocker必須ではない。

- `packages/api`: HonoのNode API。自サーバーでsystemd管理の常駐プロセスとして起動する。
- `packages/clickhouse-tools`: 同期、スナップショット更新、比較のCLI群。常駐させず、systemd timerまたはcronから実行する。
- ClickHouse: 本番では別VMまたは専用プロセスとして運用する。ローカル検証ではDockerでよい。
- Postgres: 既存本番Postgresを使う。ローカル検証ではDockerでよい。

Docker Composeでまとめることも可能だが、初期運用では「DBはDBとして管理」「APIはsystemd」「toolsはtimer」が一番切り分けやすい。

## Cloudflare Zero Trust / Tunnel 経路設定

推奨経路:

```text
collectiondata.usounds.work/collection_count_view
  -> http://127.0.0.1:3000
  -> PostgREST

collectiondata.usounds.work/rpc/*
  -> http://127.0.0.1:3000
  -> PostgREST

collectiondata.usounds.work/api/analytics/*
  -> http://127.0.0.1:8787
  -> Hono ClickHouse API

collectiondata.usounds.work/api/mcp
  -> http://127.0.0.1:8787
  -> Hono MCP endpoint, Cloudflare Access required, MVPでは未公開
```

`cloudflared` ingress例:

```yaml
tunnel: atpdashboard
credentials-file: /etc/cloudflared/atpdashboard.json

ingress:
  - hostname: collectiondata.usounds.work
    path: /api/analytics/*
    service: http://127.0.0.1:8787
  - hostname: collectiondata.usounds.work
    path: /api/mcp
    service: http://127.0.0.1:8787
  - hostname: collectiondata.usounds.work
    path: /rpc/*
    service: http://127.0.0.1:3000
  - hostname: collectiondata.usounds.work
    path: /collection_count_view
    service: http://127.0.0.1:3000
  - hostname: collectiondata.usounds.work
    service: http://127.0.0.1:3000
  - service: http_status:404
```

注意:

- `/api/analytics/*` をPostgRESTへ流さない。
- `/collection_count_view` と `/rpc/*` をHonoへ流さない。
- `/api/mcp` はProduction Default Gateとは別承認まで公開しない。
- Honoは原則 `127.0.0.1` bindにする。
- public bindが必要な場合だけ `ATPDASHBOARD_ALLOW_PUBLIC_BIND=true` を明示し、Cloudflare Access/Tunnel側の制限を確認する。

## Hono API環境変数

`/etc/atpdashboard/api.env` 例:

```bash
NODE_ENV=production
ATPDASHBOARD_API_HOST=127.0.0.1
ATPDASHBOARD_API_PORT=8787
ATPDASHBOARD_API_BASE_PATH=/api/analytics
ATPDASHBOARD_API_ALLOWED_ORIGINS=https://atpdashboard.usounds.work
ATPDASHBOARD_TRUST_FORWARDED_HEADERS=false
ATPDASHBOARD_API_RATE_LIMIT_PER_MINUTE=60
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123
CLICKHOUSE_DATABASE=atp_dashboard
CLICKHOUSE_TIMEOUT_MS=2000
ATPDASHBOARD_API_TIMEOUT_MS=3000
SNAPSHOT_MAX_AGE_SECONDS=1800
CLICKHOUSE_CIRCUIT_BREAKER_FAILURE_THRESHOLD=3
CLICKHOUSE_CIRCUIT_BREAKER_OPEN_MS=60000
COLLECTION_COUNT_RESPONSE_CACHE_TTL_MS=30000
POSTGREST_COLLECTION_COUNT_URL=https://collectiondata.usounds.work/collection_count_view
FORCE_COLLECTION_COUNT_FALLBACK=false
```

権限:

```bash
chmod 600 /etc/atpdashboard/api.env
chown atpdashboard:atpdashboard /etc/atpdashboard/api.env
```

## systemd service例

リポジトリには登録用unitを同梱している。

```text
packages/api/AtpDashboardAnalyticsApi.service
packages/jetstream/Collection.service
packages/clickhouse-tools/CollectionEventsSync.service
packages/clickhouse-tools/CollectionEventsSync.timer
packages/clickhouse-tools/CollectionEventsRescan.service
packages/clickhouse-tools/CollectionEventsRescan.timer
packages/clickhouse-tools/CollectionCountRefresh.service
packages/clickhouse-tools/CollectionCountRefresh.timer
packages/clickhouse-tools/AnalyticsHourlyNewRefresh.service
packages/clickhouse-tools/AnalyticsHourlyNewRefresh.timer
packages/clickhouse-tools/CollectionCountCompare.service
packages/clickhouse-tools/CollectionCountCompare.timer
```

VPS上では、必要に応じて以下のように登録する。

同梱unitの `WorkingDirectory` は `/srv/AtpDashboard` を前提にしている。別の場所へ配置する場合は、登録前に各 `.service` の `WorkingDirectory` をmonorepoルートへ変更する。packageディレクトリではなくmonorepoルートを指定する。

```bash
sudo mkdir -p /etc/atpdashboard
sudo cp packages/api/api.env.example /etc/atpdashboard/api.env
sudo cp packages/clickhouse-tools/clickhouse.env.example /etc/atpdashboard/clickhouse.env
sudo chmod 600 /etc/atpdashboard/api.env /etc/atpdashboard/clickhouse.env
sudo cp packages/api/AtpDashboardAnalyticsApi.service /etc/systemd/system/
sudo cp packages/jetstream/Collection.service /etc/systemd/system/
sudo cp packages/clickhouse-tools/CollectionEventsSync.service /etc/systemd/system/
sudo cp packages/clickhouse-tools/CollectionEventsSync.timer /etc/systemd/system/
sudo cp packages/clickhouse-tools/CollectionEventsRescan.service /etc/systemd/system/
sudo cp packages/clickhouse-tools/CollectionEventsRescan.timer /etc/systemd/system/
sudo cp packages/clickhouse-tools/CollectionCountRefresh.service /etc/systemd/system/
sudo cp packages/clickhouse-tools/CollectionCountRefresh.timer /etc/systemd/system/
sudo cp packages/clickhouse-tools/AnalyticsHourlyNewRefresh.service /etc/systemd/system/
sudo cp packages/clickhouse-tools/AnalyticsHourlyNewRefresh.timer /etc/systemd/system/
sudo cp packages/clickhouse-tools/AnalyticsChartsRefresh.service /etc/systemd/system/
sudo cp packages/clickhouse-tools/AnalyticsChartsRefresh.timer /etc/systemd/system/
sudo cp packages/clickhouse-tools/CollectionCountCompare.service /etc/systemd/system/
sudo cp packages/clickhouse-tools/CollectionCountCompare.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

`/etc/atpdashboard/*.env` の `REPLACE_ME` は、登録前に必ず実値へ変更する。

APIを起動する。

```bash
sudo systemctl enable --now AtpDashboardAnalyticsApi.service
sudo systemctl status AtpDashboardAnalyticsApi.service
```

同期・更新・比較timerを有効化する。

```bash
sudo systemctl enable --now CollectionEventsSync.timer
sudo systemctl enable --now CollectionEventsRescan.timer
sudo systemctl enable --now CollectionCountRefresh.timer
sudo systemctl enable --now AnalyticsHourlyNewRefresh.timer
sudo systemctl enable --now CollectionCountCompare.timer
sudo systemctl list-timers 'Collection*' 'Analytics*'
```

```ini
[Unit]
Description=AtpDashboard Hono analytics API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=atpdashboard
Group=atpdashboard
WorkingDirectory=/srv/AtpDashboard
EnvironmentFile=/etc/atpdashboard/api.env
ExecStart=/usr/bin/pnpm --filter @atpdashboard/api start
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`@atpdashboard/api` の `start` script は、現時点では以下と同等のNode strip-types起動である。

```ini
ExecStart=/usr/bin/node --experimental-strip-types packages/api/src/server.ts
```

## ヘルスチェック

ローカル:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/api/analytics/status
curl -i http://127.0.0.1:8787/api/analytics/collection_count_view
```

公開経路:

```bash
curl https://collectiondata.usounds.work/api/analytics/status
curl -i https://collectiondata.usounds.work/api/analytics/collection_count_view
```

期待:

- `/healthz` が `ok: true`
- `/api/analytics/status` が `clickhouse_configured: true`
- `X-Data-Source: clickhouse`
- `X-Snapshot-Age-Seconds` が `SNAPSHOT_MAX_AGE_SECONDS` 以下

## 最初の5分の障害対応

1分目: 影響を止める

```bash
sudo sed -i.bak 's/^FORCE_COLLECTION_COUNT_FALLBACK=.*/FORCE_COLLECTION_COUNT_FALLBACK=true/' /etc/atpdashboard/api.env
sudo systemctl restart atpdashboard-api.service
```

2分目: fallback確認

```bash
curl -i https://collectiondata.usounds.work/api/analytics/collection_count_view
curl https://collectiondata.usounds.work/api/analytics/status
```

期待:

- `X-Data-Source: fallback`
- `X-Fallback-Reason: forced_fallback`
- frontendが既存PostgREST相当の一覧を表示できる

3分目: ルートを外す必要があるか判断

- Hono自体が落ちているだけなら forced fallback で継続する。
- Honoがfallbackも返せない場合は、Cloudflare Tunnelで `/api/analytics/*` を一時的にPostgRESTまたは404へ戻す。
- frontendの `VITE_COLLECTION_COUNT_ENDPOINT` がHonoを指している場合は、PostgREST URLへ戻して再デプロイする。

4分目: 原因の切り分け

```bash
sudo journalctl -u atpdashboard-api.service -n 200 --no-pager
sudo journalctl -u atpdashboard-clickhouse-sync.service -n 200 --no-pager
sudo journalctl -u atpdashboard-clickhouse-refresh.service -n 200 --no-pager
curl http://127.0.0.1:8123/ --data-binary 'SELECT 1'
psql "$POSTGRES_URL" -c "SELECT name, expires_at, holder FROM public.clickhouse_sync_locks;"
```

5分目: 記録と告知

- incident recordを作成する。
- ownerへ `forced_fallback enabled` を共有する。
- 次回更新時刻を決める。

## 強制フォールバック

有効化:

```bash
sudo sed -i.bak 's/^FORCE_COLLECTION_COUNT_FALLBACK=.*/FORCE_COLLECTION_COUNT_FALLBACK=true/' /etc/atpdashboard/api.env
sudo systemctl restart atpdashboard-api.service
curl https://collectiondata.usounds.work/api/analytics/status
```

解除前チェック:

```bash
pnpm compare:collection-count -- --clickhouse-only \
  --postgres-url https://collectiondata.usounds.work/collection_count_view \
  --clickhouse-url https://collectiondata.usounds.work/api/analytics/collection_count_view \
  --json-out reports/collection-count-compare-before-fallback-off.json \
  --markdown-out reports/collection-count-compare-before-fallback-off.md
```

解除:

```bash
sudo sed -i.bak 's/^FORCE_COLLECTION_COUNT_FALLBACK=.*/FORCE_COLLECTION_COUNT_FALLBACK=false/' /etc/atpdashboard/api.env
sudo systemctl restart atpdashboard-api.service
curl -i https://collectiondata.usounds.work/api/analytics/collection_count_view
```

解除してよい条件:

- 比較が `Go`
- snapshot ageが30分以内
- circuit breakerがopenではない
- 直近30分でClickHouse/API errorがない
- ownerが解除を承認している

## worker lock解除

まずプロセスが実行中でないことを確認する。

```bash
systemctl list-timers 'atpdashboard-clickhouse-*'
systemctl status atpdashboard-clickhouse-sync.service
psql "$POSTGRES_URL" -c "SELECT name, holder, acquired_at, expires_at FROM public.clickhouse_sync_locks ORDER BY name;"
```

期限切れlockのみ解除:

```bash
psql "$POSTGRES_URL" -c "DELETE FROM public.clickhouse_sync_locks WHERE name = 'collection_events_backfill_v2_unique_index' AND expires_at < now();"
```

期限内lockの手動解除は、該当プロセス停止とowner承認がある場合だけ行う。

```bash
sudo systemctl stop atpdashboard-clickhouse-sync.service
psql "$POSTGRES_URL" -c "DELETE FROM public.clickhouse_sync_locks WHERE name = 'collection_events_backfill_v2_unique_index';"
```

## バックフィル再開

checkpoint確認:

```bash
psql "$POSTGRES_URL" -c "SELECT * FROM public.clickhouse_sync_checkpoints WHERE name = 'collection_events_backfill_v2_unique_index';"
```

dry-run:

```bash
POSTGRES_URL=postgres://sync_user:REDACTED@127.0.0.1:5432/atpdashboard \
  pnpm backfill:collection-events -- --dry-run --limit 10000
```

bounded resume:

```bash
POSTGRES_URL=postgres://sync_user:REDACTED@127.0.0.1:5432/atpdashboard \
  CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm backfill:collection-events -- \
    --confirm-production \
    --max-runtime-minutes 10 \
    --max-rows 500000 \
    --batch-size 50000 \
    --lock-ttl-seconds 900
```

手動watermarkから再開する場合:

```bash
POSTGRES_URL=postgres://sync_user:REDACTED@127.0.0.1:5432/atpdashboard \
  CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm backfill:collection-events -- \
    --confirm-production \
    --resume-from '{"createdAt":"2026-05-09T00:00:00.000000Z","createdAtKey":"2026-05-09T00:00:00.000000Z","did":"did:plc:example","collection":"app.example.post","rkey":"abc"}' \
    --limit 100000
```

## スナップショット再作成

dry-run:

```bash
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm refresh:collection-count -- --dry-run
```

実行:

```bash
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
pnpm refresh:collection-count -- \
    --confirm-production \
    --stale-running-minutes 60 \
    --recent-hours 72
```

analytics chart snapshot も初回デプロイ時に手動更新する:

```bash
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  ANALYTICS_CHART_REFRESH_SOURCE=raw \
  pnpm refresh:analytics-charts -- \
    --confirm-production \
    --stale-running-minutes 60
```

`sql/clickhouse/005_analytics_chart_rollups.sql` の適用とrollup backfill/比較が完了した後は、
`ANALYTICS_CHART_REFRESH_SOURCE=rollup` に切り替える。切り替え前の既定は `raw`。

確認:

```bash
curl 'http://127.0.0.1:8123/' --data-binary '
SELECT refresh_id, status, row_count, started_at, completed_at, error_message
FROM atp_dashboard.collection_count_refresh_manifest
ORDER BY updated_at DESC
LIMIT 5
'
```

## 比較

フォールバックを隠れ蓑にしないため、必ず `--clickhouse-only` を使う。

```bash
pnpm compare:collection-count -- --clickhouse-only \
  --postgres-url https://collectiondata.usounds.work/collection_count_view \
  --clickhouse-url https://collectiondata.usounds.work/api/analytics/collection_count_view \
  --json-out reports/collection-count-compare-$(date -u +%Y%m%dT%H%M%SZ).json \
  --markdown-out reports/collection-count-compare-$(date -u +%Y%m%dT%H%M%SZ).md
```

不可判定:

- `X-Data-Source` が `clickhouse` ではない
- `collection`, `count`, `min`, `max` が一致しない
- row countまたはcollection setが一致しない
- `recent_count` の差分がsnapshot基準時刻で説明できない

## 復旧確認

復旧後に以下をすべて確認する。

```bash
curl https://collectiondata.usounds.work/api/analytics/status
curl -i https://collectiondata.usounds.work/api/analytics/collection_count_view
pnpm compare:collection-count -- --clickhouse-only \
  --postgres-url https://collectiondata.usounds.work/collection_count_view \
  --clickhouse-url https://collectiondata.usounds.work/api/analytics/collection_count_view \
  --json-out reports/collection-count-recovery-compare.json \
  --markdown-out reports/collection-count-recovery-compare.md
```

復旧完了条件:

- `X-Data-Source: clickhouse`
- `X-Snapshot-Age-Seconds` が30分以内
- 比較が `Go`
- Hono API errorが解消
- 同期/更新timerが次回正常実行できる
- ownerがfallback解除を承認

## ログ確認

```bash
sudo journalctl -u atpdashboard-api.service -f
sudo journalctl -u atpdashboard-clickhouse-sync.service -n 200 --no-pager
sudo journalctl -u atpdashboard-clickhouse-refresh.service -n 200 --no-pager
sudo journalctl -u cloudflared.service -n 200 --no-pager
```

ClickHouse:

```bash
curl 'http://127.0.0.1:8123/' --data-binary '
SELECT database, table, formatReadableSize(sum(bytes_on_disk)) AS bytes_on_disk, sum(rows) AS rows
FROM system.parts
WHERE active AND database = '\''atp_dashboard'\''
GROUP BY database, table
ORDER BY table
'
```

## 本番切替チェックリスト

切替前:

- ownerが本番既定化Goに署名
- 24時間比較がすべてGo
- フォールバック手順が検証済み
- Hono API serviceが自動再起動設定済み
- 同期/更新/比較timerが設定済み
- `FORCE_COLLECTION_COUNT_FALLBACK=false`
- `VITE_COLLECTION_COUNT_ENDPOINT` の変更内容を記録
- Cloudflare route差分を記録
- 切り戻しownerと連絡先を記録

切替:

1. Cloudflareで `/api/analytics/*` をHonoへ向ける。
2. controlled environmentで `VITE_COLLECTION_COUNT_ENDPOINT=https://collectiondata.usounds.work/api/analytics/collection_count_view` を設定する。
3. frontendをデプロイする。
4. 30分の本番監視時間を開始する。
5. 状態、ヘッダー、比較、エラー率、フォールバック率を確認する。

切替直後チェック:

```bash
curl -i https://collectiondata.usounds.work/api/analytics/collection_count_view
curl https://collectiondata.usounds.work/api/analytics/status
pnpm compare:collection-count -- --clickhouse-only \
  --postgres-url https://collectiondata.usounds.work/collection_count_view \
  --clickhouse-url https://collectiondata.usounds.work/api/analytics/collection_count_view \
  --json-out reports/collection-count-cutover-compare.json \
  --markdown-out reports/collection-count-cutover-compare.md
```

## 切り戻しチェックリスト

APIフォールバックによる切り戻し:

```bash
sudo sed -i.bak 's/^FORCE_COLLECTION_COUNT_FALLBACK=.*/FORCE_COLLECTION_COUNT_FALLBACK=true/' /etc/atpdashboard/api.env
sudo systemctl restart atpdashboard-api.service
```

フロントエンド切り戻し:

- `VITE_COLLECTION_COUNT_ENDPOINT` を未設定に戻す。
- または `https://collectiondata.usounds.work/collection_count_view` に戻す。
- frontendを再デプロイする。

Cloudflare切り戻し:

- `/api/analytics/*` routeを一時的に無効化する。
- 既存 `/collection_count_view` と `/rpc/*` はPostgRESTのまま維持する。

切り戻し完了確認:

```bash
curl https://collectiondata.usounds.work/collection_count_view
curl -i https://collectiondata.usounds.work/api/analytics/collection_count_view
```

期待:

- dashboard主要一覧が表示できる
- Hono経路を使う場合は `X-Data-Source: fallback`
- Hono経路を外す場合はfrontendがPostgREST URLを直接参照

## 作業者向け告知テンプレート

```text
件名: collection_count_view ClickHouse read path 状態更新

状態:
現在のデータソース:
スナップショット経過時間:
フォールバック理由:
利用者影響:
実施したmitigation:
次の確認時刻:
責任者:
作業者:
```

## 障害記録テンプレート

```text
障害ID:
発生日時:
検知方法:
影響範囲:
利用者影響:
現在のデータソース:
フォールバック理由:
原因:
復旧手順:
復旧確認:
再発防止:
責任者:
作業者:
事後検証の要否:
```

## 禁止操作

- owner承認前にProduction Defaultへ切り替えない。
- compare差分がある状態でfallbackを解除しない。
- ClickHouse認証情報をVite env、ブラウザ、公開ログに出さない。
- ClickHouseへ任意SQL実行APIを公開しない。
- `public.collection` をClickHouse同期の都合で変更しない。
- lock holder不明のまま期限内lockを削除しない。
- `collection_events` raw eventにTTL/deleteを入れない。
- MCP endpointをProduction Default Gateの一部として公開しない。

## 不可判定条件

- 比較が1回でも不可判定
- フォールバックが予期せず発生
- スナップショット経過時間が30分を超過
- API p95がbaselineより悪化
- API error rateが1%以上
- circuit breakerがopen
- 同期/更新が連続失敗
- ClickHouseが既存Postgres運用に負荷影響を与える
- 月額追加運用コストが5,000円相当を超える見込み
- runbook通りにrollbackできない

## 引き継ぎ

| 役割 | 担当 | 連絡先 |
| --- | --- | --- |
| 責任者 | 未記入 | 未記入 |
| 主担当作業者 | 未記入 | 未記入 |
| 副担当作業者 | 未記入 | 未記入 |
| Cloudflare管理者 | 未記入 | 未記入 |
| フロントエンドデプロイ担当 | 未記入 | 未記入 |
