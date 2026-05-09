# ClickHouse collection_count 定期実行メモ

このメモは `collection_count_view` ClickHouse部分移行の「本番既定化判定」へ進む前に、同期・スナップショット更新・比較を24時間観測するための定期実行案である。

ここに書く手順は **本番既定経路への切替ではない**。Cloudflare経路切替、Vite環境変数の本番既定値変更、本番タイマーの有効化は、別途owner承認後に行う。

## 前提

- Postgres は source of truth のまま維持する。
- ClickHouse は派生read modelとして扱う。
- `public.collection` は現時点でappend-onlyとして扱う。
- Hono API は自サーバー上の別プロセスで起動し、`/api/analytics/*` のみを担当する。
- 既存PostgREST `/collection_count_view` はフォールバックおよび比較対象として残す。

## 起動方針

APIとtoolsは、原則としてDockerコンテナ化しなくてよい。

- `packages/api`: Node.jsの常駐プロセスとして起動する。自サーバーではsystemdで管理する。
- `packages/clickhouse-tools`: 常駐サービスではなくCLIである。systemd timerまたはcronから `pnpm backfill:collection-events` や `pnpm refresh:collection-count` を定期実行する。
- Postgres: 既存の本番Postgresを使う。ローカル検証ではDockerでよい。
- ClickHouse: 本番では別VMまたは専用プロセスとして運用する。ローカル検証ではDockerでよい。

Docker化する場合でも、API/toolsはDBとは別コンテナにする。ClickHouse本体とHono APIを同じコンテナに詰め込まない。

## 必須環境変数

同期・更新worker:

```bash
POSTGRES_URL=postgres://readonly_or_sync_user:REDACTED@127.0.0.1:5432/atpdashboard
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123
CLICKHOUSE_DATABASE=atp_dashboard
```

Hono API:

```bash
ATPDASHBOARD_API_HOST=127.0.0.1
ATPDASHBOARD_API_PORT=8787
ATPDASHBOARD_API_BASE_PATH=/api/analytics
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123
CLICKHOUSE_DATABASE=atp_dashboard
POSTGREST_COLLECTION_COUNT_URL=https://collectiondata.usounds.work/collection_count_view
SNAPSHOT_MAX_AGE_SECONDS=1800
COLLECTION_COUNT_RESPONSE_CACHE_TTL_MS=30000
FORCE_COLLECTION_COUNT_FALLBACK=false
```

## MVP検証用の安全な単発確認

まずdry-runで接続と設定だけを確認する。

```bash
POSTGRES_URL=postgres://sync_user:REDACTED@127.0.0.1:5432/atpdashboard \
  pnpm backfill:collection-events -- --dry-run --limit 10000
```

```bash
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm refresh:collection-count -- --dry-run
```

## 本番既定化判定用の推奨実行間隔

24時間観測では、以下の3つを分けて実行する。

1. 重複許容の差分同期
2. スナップショット更新
3. PostgREST版とClickHouse版の比較

### 1. 重複許容の差分同期

checkpoint同期だけでは、checkpointより前に並ぶDID/collection/rkeyの新着行を次回実行で拾えないため、直近窓の再走査を併用する。再走査は `event_key` により重複投入しても集計で二重計上されない。

checkpoint同期の推奨実行例:

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

直近窓の再走査推奨実行例:

```bash
POSTGRES_URL=postgres://sync_user:REDACTED@127.0.0.1:5432/atpdashboard \
  CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm backfill:collection-events -- \
    --confirm-production \
    --rescan-days 1 \
    --max-rows 500000 \
    --batch-size 50000 \
    --lock-ttl-seconds 900
```

推奨頻度:

```text
*/10 * * * * collection_events checkpoint sync
```

lock運用:

- workerは `public.clickhouse_sync_locks` を使って多重実行を防ぐ。
- `--lock-ttl-seconds` は1回の最大実行時間より長くする。
- 長時間化する場合は、次フェーズでlock延長機能を追加する。
- lockが残り続ける場合は、実プロセス停止を確認してからrunbookのunlock手順で解除する。

checkpoint境界:

- watermarkは `did ASC, collection ASC, rkey ASC, "createdAt" ASC NULLS LAST`。
- この順序は既存Postgres index `unique_collection_index (did, collection, rkey, "createdAt")` に合わせる。
- 再開条件はexclusiveである。
- checkpoint更新はClickHouse insert成功後にだけ行う。
- 同一 `createdAt` 行を取りこぼさないため、`createdAt` 単独watermarkに戻してはいけない。

### 2. スナップショット更新

スナップショット更新は `collection_events` から `collection_count_snapshot` を作り、成功後のみ `collection_count_refresh_manifest.status = completed` を記録する。

```bash
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm refresh:collection-count -- \
    --confirm-production \
    --stale-running-minutes 60 \
    --recent-hours 72
```

推奨頻度:

```text
*/15 * * * * collection_count snapshot refresh
```

本番既定化判定では、`SNAPSHOT_MAX_AGE_SECONDS=1800` を前提に、スナップショット経過時間が30分を超えないことを観測する。

### 3. 比較

比較にフォールバックが混ざるとClickHouse検証にならないため、必ず `--clickhouse-only` を使う。

```bash
pnpm compare:collection-count -- --clickhouse-only \
  --postgres-url https://collectiondata.usounds.work/collection_count_view \
  --clickhouse-url https://collectiondata.usounds.work/api/analytics/collection_count_view \
  --json-out reports/collection-count-compare-$(date -u +%Y%m%dT%H%M%SZ).json \
  --markdown-out reports/collection-count-compare-$(date -u +%Y%m%dT%H%M%SZ).md
```

推奨頻度:

```text
*/30 * * * * collection_count compare
```

`--clickhouse-only` は `X-Disable-Fallback: true` を送り、`X-Data-Source: clickhouse` でない場合は不可判定にする。

## systemd timer例

実ファイル化する場合は、環境変数を `/etc/atpdashboard/clickhouse.env` に置き、権限を `0600` にする。

同期service例:

```ini
[Unit]
Description=AtpDashboard ClickHouse collection_events sync

[Service]
Type=oneshot
WorkingDirectory=/srv/AtpDashboard
EnvironmentFile=/etc/atpdashboard/clickhouse.env
ExecStart=/usr/bin/pnpm backfill:collection-events -- --confirm-production --max-runtime-minutes 10 --max-rows 500000 --batch-size 50000 --lock-ttl-seconds 900
```

同期timer例:

```ini
[Unit]
Description=Run AtpDashboard ClickHouse collection_events sync every 10 minutes

[Timer]
OnCalendar=*:0/10
Persistent=true

[Install]
WantedBy=timers.target
```

スナップショット更新service例:

```ini
[Unit]
Description=AtpDashboard ClickHouse collection_count snapshot refresh

[Service]
Type=oneshot
WorkingDirectory=/srv/AtpDashboard
EnvironmentFile=/etc/atpdashboard/clickhouse.env
ExecStart=/usr/bin/pnpm refresh:collection-count -- --confirm-production --stale-running-minutes 60 --recent-hours 72
```

スナップショット更新timer例:

```ini
[Unit]
Description=Run AtpDashboard ClickHouse collection_count snapshot refresh every 15 minutes

[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
```

比較service例:

```ini
[Unit]
Description=AtpDashboard collection_count PostgREST vs ClickHouse compare

[Service]
Type=oneshot
WorkingDirectory=/srv/AtpDashboard
EnvironmentFile=/etc/atpdashboard/clickhouse.env
ExecStart=/usr/bin/pnpm compare:collection-count -- --clickhouse-only --postgres-url https://collectiondata.usounds.work/collection_count_view --clickhouse-url https://collectiondata.usounds.work/api/analytics/collection_count_view --json-out reports/collection-count-compare-latest.json --markdown-out reports/collection-count-compare-latest.md
```

比較timer例:

```ini
[Unit]
Description=Run AtpDashboard collection_count compare every 30 minutes

[Timer]
OnCalendar=*:0/30
Persistent=true

[Install]
WantedBy=timers.target
```

## cron例

cronで運用する場合も、最初はコメントアウトした状態でレビューする。

```cron
# */10 * * * * cd /srv/AtpDashboard && set -a && . /etc/atpdashboard/clickhouse.env && set +a && pnpm backfill:collection-events -- --confirm-production --max-runtime-minutes 10 --max-rows 500000 --batch-size 50000 --lock-ttl-seconds 900
# */10 * * * * cd /srv/AtpDashboard && set -a && . /etc/atpdashboard/clickhouse.env && set +a && pnpm backfill:collection-events -- --confirm-production --rescan-days 1 --max-rows 500000 --batch-size 50000 --lock-ttl-seconds 900
# */15 * * * * cd /srv/AtpDashboard && set -a && . /etc/atpdashboard/clickhouse.env && set +a && pnpm refresh:collection-count -- --confirm-production --stale-running-minutes 60 --recent-hours 72
# */30 * * * * cd /srv/AtpDashboard && pnpm compare:collection-count -- --clickhouse-only --postgres-url https://collectiondata.usounds.work/collection_count_view --clickhouse-url https://collectiondata.usounds.work/api/analytics/collection_count_view --json-out reports/collection-count-compare-latest.json --markdown-out reports/collection-count-compare-latest.md
```

## 24時間観測中に保存するもの

- `reports/collection-count-compare-*.json`
- `reports/collection-count-compare-*.md`
- Hono API `/api/analytics/status` の定期取得結果
- `X-Data-Source`, `X-Fallback-Reason`, `X-Snapshot-Refresh-Id`, `X-Snapshot-Refreshed-At`, `X-Snapshot-Age-Seconds`
- 同期workerの `rowsRead`, `rowsInserted`, `finalWatermark`
- 更新workerの `refreshId`, `status`
- Postgres/ClickHouseのCPU、メモリ、ディスク、I/O、network観測
- ClickHouse storage query結果

## フォールバック固定条件

以下のいずれかに該当したら、本番既定化判定は不可、または `FORCE_COLLECTION_COUNT_FALLBACK=true` で固定する。

- 比較レポートが1回でも不可判定
- `collection`, `count`, `min`, `max` に差分がある
- `X-Data-Source` が `clickhouse` ではない
- スナップショット経過時間が30分を超える状態が連続2回以上
- API p95がbaselineより悪化、または目標値を超過
- API error rateが1%を超過
- circuit breakerが開く
- 同期lockが残留し、復旧手順なしで次回実行できない
- ClickHouseのCPU/メモリ/ディスク/I/Oが既存Postgres運用に悪影響を与える
- 月額追加運用コストが5,000円相当を超える見込み

## 本番既定化前に不足している堅牢化

- `--rescan-days 7` 相当の遅延到着再走査
- 長時間同期向けのlock延長
- checkpoint境界の本番データ量での追加検証
- クラッシュ後再実行時の比較差分0確認
- 24時間分の時刻付き比較レポート
- owner署名付きGo/No-Go判断
