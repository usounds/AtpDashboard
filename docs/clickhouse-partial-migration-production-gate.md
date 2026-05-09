# ClickHouse部分移行 本番既定化判定

この文書は、`collection_count_view` をClickHouse-backed APIへ本番既定経路として切り替える前に必要な24時間観測と可否条件を定義する。

重要: この判定は **本番既定化を許可するための審査** であり、この文書を作成しただけでは切替しない。

## 対象範囲

対象:

- `collection_count_view` 互換API
- Hono `GET /api/analytics/collection_count_view`
- ClickHouse `atp_dashboard.collection_events`
- ClickHouse `atp_dashboard.collection_count_snapshot`
- ClickHouse `atp_dashboard.collection_count_refresh_manifest`
- 既存PostgREST `https://collectiondata.usounds.work/collection_count_view` との比較

対象外:

- 他PostgREST viewのClickHouse移行
- MCP endpointの実装・公開
- UIデザイン変更
- Postgres全面移行
- Cloudflare routeの本番切替
- Vite本番既定endpointの変更

## 判定開始条件

判定開始前に、以下をすべて満たすこと。

| 項目 | 条件 | 状態 |
| --- | --- | --- |
| DDL | Postgres checkpoint/lock DDLとClickHouse DDLが適用済み | 未記入 |
| Backfill | bounded backfillが成功し、checkpointが進む | 未記入 |
| スナップショット | 更新処理が `completed` manifestを作る | 未記入 |
| API | `/healthz`, `/api/analytics/status`, `/api/analytics/collection_count_view` が応答する | 未記入 |
| 比較 | `--clickhouse-only` 比較が実行できる | 未記入 |
| フォールバック | `FORCE_COLLECTION_COUNT_FALLBACK=true` でPostgRESTへ戻せる | 未記入 |
| Cost | 追加月額5,000円相当以内の見込み | 未記入 |
| 責任者 | 24時間観測開始をownerが承認 | 未記入 |

## 24時間観測の実行内容

観測期間:

```text
開始: YYYY-MM-DD HH:MM:SS UTC
終了: YYYY-MM-DD HH:MM:SS UTC
Owner:
作業者:
```

実行cadence:

| 処理 | 頻度 | 目的 |
| --- | --- | --- |
| collection_events同期 | 10分ごと | PostgresからClickHouseへ差分を反映 |
| collection_countスナップショット更新 | 15分ごと | APIが読むcompleted snapshotを更新 |
| `--clickhouse-only` 比較 | 30分ごと | PostgREST互換性とフォールバック混入なしを検証 |
| API状態取得 | 5分ごと | 鮮度、フォールバック、circuit状態を記録 |
| resource観測 | 5分ごと | CPU, memory, disk, I/O, networkを確認 |

## 実行コマンド

同期:

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

スナップショット更新:

```bash
CLICKHOUSE_URL=http://clickhouse_user:REDACTED@127.0.0.1:8123 \
  CLICKHOUSE_DATABASE=atp_dashboard \
  pnpm refresh:collection-count -- \
    --confirm-production \
    --stale-running-minutes 60 \
    --recent-hours 72
```

比較:

```bash
pnpm compare:collection-count -- --clickhouse-only \
  --postgres-url https://collectiondata.usounds.work/collection_count_view \
  --clickhouse-url https://collectiondata.usounds.work/api/analytics/collection_count_view \
  --json-out reports/collection-count-compare-YYYYMMDDTHHMMSSZ.json \
  --markdown-out reports/collection-count-compare-YYYYMMDDTHHMMSSZ.md
```

状態確認:

```bash
curl https://collectiondata.usounds.work/api/analytics/status
```

ヘッダー確認:

```bash
curl -i https://collectiondata.usounds.work/api/analytics/collection_count_view
```

## 観測するSLO

| 指標 | Go条件 | No-Go条件 |
| --- | --- | --- |
| API p95 | 既存PostgREST baselineより改善、かつ目標値以内 | baselineより悪化、または目標値超過 |
| APIエラー率 | 1%未満 | 1%以上 |
| フォールバック率 | 24時間で0%、またはownerが許容した計画停止のみ | 予期しないフォールバックが1回以上 |
| `X-Data-Source` | compare時は常に `clickhouse` | `fallback`, `unavailable`, null |
| スナップショット経過時間 | 30分以内 | 30分超が連続2回以上 |
| 比較差分 | `collection`, `count`, `min`, `max` が一致 | いずれかに差分 |
| `recent_count` | snapshot基準時刻を固定して説明可能 | 説明不能な差分 |
| 同期遅延 | 実行間隔内に収まる | 連続して増加、または手動復旧が必要 |
| circuit breaker | 開かない | 1回でも開く |
| ClickHouse resource | 既存Postgres運用に影響なし | CPU/memory/disk/I/Oが上限超過 |
| cost | 月額5,000円相当以内 | 月額5,000円相当超過見込み |

## 比較判定

`--clickhouse-only` 比較で以下のいずれかが発生したら不可判定。

- HTTP statusが200ではない
- `X-Data-Source` が `clickhouse` ではない
- 行数が一致しない
- collection集合が一致しない
- `count` が一致しない
- `min` が一致しない
- `max` が一致しない
- 上位100件で差分がある
- サンプルで差分がある

`recent_count` は72時間窓とsnapshot時刻の差により差分が出やすいため、可条件は「snapshot基準時刻を固定した比較で説明可能」であること。ただし説明不能な差分は不可判定。

## 遅延到着と7日再走査

本番既定化判定では、遅延到着データの扱いを明示する。

現時点の同期workerはcheckpoint以降を読む上限付きimportであり、`--rescan-days 7` は未実装である。そのため本番既定化へ進むには、次のどちらかが必要である。

1. `--rescan-days 7` 相当を実装し、7日窓の重複再投入が `event_key` により二重計上されないことをTask 11で検証する。
2. 24時間観測中はcheckpoint同期に加えて、手動reconciliationでPostgRESTとの差分0を証明する。

この条件を満たせない場合、MVP検証は可能でも本番既定化は不可とする。

## 保存する証跡

以下を `reports/` または運用ログ保管先に保存する。

- 30分ごとの比較JSON
- 30分ごとの比較Markdown
- 5分ごとのAPI status
- 5分ごとのresponse headers
- 同期worker summary
- 更新worker summary
- Hono API logs
- ClickHouse server logs
- Postgres resource metrics
- ClickHouse resource metrics
- cost estimateまたは実測

## 可否記録

| 項目 | 値 |
| --- | --- |
| 判定 | Stop / Continue Demo Only / Continue Toward Production Gate / Production Default Go |
| 判断日時 | 未記入 |
| Owner | 未記入 |
| 作業者 | 未記入 |
| 観測期間 | 未記入 |
| 比較レポート | 未記入 |
| API p95 | 未記入 |
| APIエラー率 | 未記入 |
| フォールバック率 | 未記入 |
| 最大スナップショット経過時間 | 未記入 |
| 最大同期遅延 | 未記入 |
| ClickHouse serving ratio | 未記入 |
| PostgREST read load削減見込み | 未記入 |
| 追加月額コスト | 未記入 |
| 残リスク | 未記入 |
| 判断理由 | 未記入 |

## 不可判定時の扱い

不可判定の場合は、以下のいずれかに固定する。

- 既存PostgRESTを本番既定のまま維持する。
- `FORCE_COLLECTION_COUNT_FALLBACK=true` でHonoはフォールバック専用にする。
- Hono `/api/analytics/*` routeをCloudflareから外す。
- `VITE_COLLECTION_COUNT_ENDPOINT` を未設定またはPostgREST URLへ戻す。

不可判定後に再開する場合は、失敗原因を修正し、24時間観測を最初からやり直す。

## 本番既定化切替でまだ行わないこと

この文書作成時点では、以下を行わない。

- Cloudflare routeを本番既定として切り替える
- Vercel production envの `VITE_COLLECTION_COUNT_ENDPOINT` をClickHouse-backed APIへ変更する
- MCP endpointを公開する
- 他のPostgREST endpointを移行する
- Postgres source of truthを変更する
