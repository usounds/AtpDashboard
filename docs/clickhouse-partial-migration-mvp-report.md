# ClickHouse部分移行 MVP Go/No-Goレポート

作成日: 2026-05-09
対象spec: `clickhouse-partial-migration`
対象endpoint: `collection_count_view`

## 結論

```text
MVP Demo判定: Continue Demo Only
Production Default判定: No-Go
```

理由:

- `collection_count_view` のClickHouse read model、Hono API、PostgRESTフォールバック、フロントエンドendpoint切替、systemd運用雛形は実装済み。
- ローカル検証DBでは、PostgresからClickHouseへのbackfill、snapshot refresh、Hono APIのClickHouse応答まで確認済み。
- API/tools/frontendのテストとVite buildは成功済み。
- ただし、本番データに対する24時間観測、PostgRESTとの本番compare、PostgREST read load削減実測、追加運用コスト実測は未完了。
- そのため、MVP検証は継続可能だが、Production Defaultにはまだ進めない。

## MVP範囲

MVPに含めたもの:

- ClickHouse DDL
- Postgres checkpoint/lock DDL
- `event_key` 生成
- bounded backfill worker
- snapshot refresh worker
- Hono `GET /api/analytics/collection_count_view`
- Hono `GET /api/analytics/status`
- PostgREST fallback
- `X-Disable-Fallback` によるClickHouse-only比較
- フロントエンド `VITE_COLLECTION_COUNT_ENDPOINT` 切替
- VPS向けsystemd unit/timer雛形
- Cloudflare Zero Trust運用手順書
- ローカル初期設定手順書

MVPに含めていないもの:

- 本番既定経路への切替
- 24時間本番観測
- `--rescan-days 7` 相当の遅延到着再走査
- MCP endpoint実装
- 他PostgREST viewの移行
- 日次bucketや週次推移read model
- Postgres全面移行

## Baseline

既存PostgREST `collection_count_view` のスポット実測:

| 項目 | 値 |
| --- | --- |
| 初回取得HTTP status | 200 |
| 初回 `time_total` | 20.853697秒 |
| 初回 `time_starttransfer` | 20.748310秒 |
| payload size | 916,822 bytes |
| rows | 6,625 |
| 連続取得 | 0.204秒、0.112秒、0.072秒、0.043秒、0.037秒 |

解釈:

- 初回20秒超のため、cold pathまたはPostgres/view計算の重さが露出する可能性がある。
- 連続取得はキャッシュ影響が大きく、p95ではない。
- 本番既定化判定では24時間のp95、エラー率、フォールバック率、同期遅延を別途測る必要がある。

## Source Table前提

Owner確認:

```text
public.collection は現時点でUPDATEされず、DELETEもされない。
```

MVPではappend-only前提で扱う。

注意:

- 今後UPDATE/DELETEが発生するなら、ClickHouse側は再バックフィル、全量突合、tombstone/update handlingのいずれかが必要。
- Production Default前には、遅延到着と補正方針を24時間観測の中で再確認する。

## ローカル検証結果

ローカルPostgres/ClickHouseで確認した内容:

| 検証 | 結果 |
| --- | --- |
| ClickHouse接続 | `SELECT 1` 成功 |
| Postgres接続 | `127.0.0.1:55432` で成功 |
| Postgresサンプル `public.collection` | 4 rows |
| Postgres checkpoint/lock DDL | 適用成功 |
| ClickHouse DDL | 適用成功 |
| backfill dry-run | `rowsRead: 4`, `rowsInserted: 0` |
| backfill実投入 | `rowsRead: 4`, `rowsInserted: 4` |
| snapshot refresh dry-run | 成功 |
| snapshot refresh実行 | `status: completed` |
| Hono API `/healthz` | 成功 |
| Hono API `/api/analytics/status` | `clickhouse_configured: true` |
| Hono API `/api/analytics/collection_count_view` | `X-Data-Source: clickhouse` |

ローカルClickHouse API応答:

```json
[
  {
    "collection": "app.example.post",
    "count": 2,
    "recent_count": 2
  },
  {
    "collection": "app.example.like",
    "count": 1,
    "recent_count": 0
  }
]
```

`app.example.post` はサンプル投入3件のうち `did:web:lexicon.store` を除外するため、期待通り `count: 2` になった。

## テストとビルド

実行済み:

```text
rtk pnpm test:frontend
rtk pnpm test:api
rtk pnpm test:clickhouse-tools
rtk pnpm build
```

結果:

| コマンド | 結果 |
| --- | --- |
| `test:frontend` | 3 tests passed |
| `test:api` | 14 tests passed |
| `test:clickhouse-tools` | 27 tests passed |
| `build` | 成功 |

build時の注意:

- `icon-calendar.svg` と `icon-arrow-down.svg` のruntime resolution warningが出る。
- これは既存のwarningであり、今回のClickHouse移行変更による失敗ではない。

## 実装済み互換契約

`collection_count_view` 互換API:

- `collection`
- `count`
- `recent_count`
- `min`
- `max`

互換上の重要条件:

- `did:web:lexicon.store` を除外する。
- 最新completed refreshだけを公開する。
- stale snapshot時はPostgRESTへフォールバックする。
- `X-Disable-Fallback: true` ではフォールバックせず、ClickHouse単独検証に使える。
- `X-Data-Source` で `clickhouse`, `fallback`, `unavailable` を区別できる。

## 運用成果物

追加済み:

- `docs/clickhouse-partial-migration-runbook.md`
- `docs/clickhouse-partial-migration-production-gate.md`
- `docs/clickhouse-local-initial-setup.md`
- `packages/clickhouse-tools/schedule-notes.md`
- `packages/api/AtpDashboardAnalyticsApi.service`
- `packages/api/api.env.example`
- `packages/clickhouse-tools/CollectionEventsSync.service`
- `packages/clickhouse-tools/CollectionEventsSync.timer`
- `packages/clickhouse-tools/CollectionCountRefresh.service`
- `packages/clickhouse-tools/CollectionCountRefresh.timer`
- `packages/clickhouse-tools/CollectionCountCompare.service`
- `packages/clickhouse-tools/CollectionCountCompare.timer`
- `packages/clickhouse-tools/clickhouse.env.example`

VPS運用方針:

- Docker必須ではない。
- `packages/api` はNode/Honoをsystemd常駐。
- `packages/clickhouse-tools` はsystemd timerまたはcronで定期実行。
- `WorkingDirectory` はmonorepoルート `/srv/AtpDashboard`。

## Go/No-Go指標

MVP Demo:

| 指標 | 状態 |
| --- | --- |
| ClickHouse DDL適用 | Go |
| Postgres checkpoint/lock DDL適用 | Go |
| backfill dry-run | Go |
| backfill実投入 | Go、ローカル小規模 |
| snapshot refresh | Go、ローカル小規模 |
| Hono API ClickHouse応答 | Go、ローカル小規模 |
| PostgREST fallback | Go、テスト済み |
| frontend endpoint switch | Go、テスト済み |
| tests/build | Go |

Production Default:

| 指標 | 状態 |
| --- | --- |
| 本番24時間compare | 未実施 |
| 本番p95 | 未実施 |
| 本番error rate | 未実施 |
| 本番fallback rate | 未実施 |
| 本番sync lag | 未実施 |
| ClickHouse serving ratio | 未実施 |
| PostgREST read load削減見込み | 未実測 |
| 追加月額コスト | 未実測 |
| `--rescan-days 7` 相当 | 未実装 |

## 撤退条件

以下に該当する場合はProduction Defaultへ進まない。

- 本番compareで `collection`, `count`, `min`, `max` に差分がある。
- `X-Data-Source: clickhouse` を維持できない。
- snapshot ageが30分を超える状態が連続する。
- 本番API p95がPostgREST baselineより改善しない。
- PostgREST fallbackが不安定。
- ClickHouseが既存Postgres運用へ負荷影響を与える。
- 月額追加運用コストが5,000円相当を超える見込み。
- rollback手順を実行できない。

## 最終判断

```text
Decision: Continue Demo Only
Owner: user
Date: 2026-05-09
```

判断理由:

- MVP Demoに必要なコード、DDL、API、CLI、フロント切替、運用雛形、テストは揃った。
- ローカル小規模検証ではClickHouse read pathが成立した。
- ただし本番データでの24時間比較・性能・鮮度・運用コストが未確認である。
- よって、本番既定化はまだ行わず、次はVPS/本番相当環境での限定デモと24時間観測準備へ進む。

## 次の推奨アクション

1. VPSへ `/srv/AtpDashboard` として配置する。
2. `/etc/atpdashboard/api.env` と `/etc/atpdashboard/clickhouse.env` を設定する。
3. `AtpDashboardAnalyticsApi.service` を起動する。
4. ClickHouse DDLとPostgres checkpoint/lock DDLを本番相当環境へ適用する。
5. `backfill:collection-events --dry-run` を本番Postgresに対して小さく実行する。
6. owner承認後、bounded backfillを限定実行する。
7. snapshot refreshを実行する。
8. `compare:collection-count --clickhouse-only` を実行する。
9. 24時間観測を開始するか判断する。
