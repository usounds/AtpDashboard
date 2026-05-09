# ClickHouse Partial Migration Baseline

作成日: 2026-05-09
対象spec: `clickhouse-partial-migration`
対象endpoint: `collection_count_view`

## 目的

`collection_count_view` のClickHouse部分移行を始める前に、現行PostgRESTの状態、ClickHouse追加コスト、source tableのmutability、MVP Demo / Production Default GateのStop/Continue条件を固定する。

この文書はTask 0の成果物であり、コード実装前のgateとして扱う。Task 1以降は、ownerが本書の判断欄に署名してから開始する。

## 現行PostgREST Baseline

実測コマンド:

```bash
rtk curl --max-time 30 -s -o /tmp/collection_count_view_baseline_30s.json -w 'http_code=%{http_code}\ntime_total=%{time_total}\ntime_starttransfer=%{time_starttransfer}\nsize_download=%{size_download}\n' https://collectiondata.usounds.work/collection_count_view
```

スポット実測:

最初の取得:

```text
http_code: 200
time_total: 20.853697 sec
time_starttransfer: 20.748310 sec
size_download: 916822 bytes
```

30秒上限付き再取得:

```text
http_code: 200
time_total: 0.320687 sec
time_starttransfer: 0.175771 sec
size_download: 916822 bytes
rows: 6625
```

5回連続取得:

```text
1: 0.204 sec, 916822 bytes, 6625 rows
2: 0.112 sec, 916822 bytes, 6625 rows
3: 0.072 sec, 916822 bytes, 6625 rows
4: 0.043 sec, 916822 bytes, 6625 rows
5: 0.037 sec, 916822 bytes, 6625 rows
```

注意:

- 初回取得は20秒超で、cold pathまたはDB/view計算の重さが露出している可能性がある。
- 連続取得はCloudflare/PostgREST/OS cacheの影響を受ける可能性が高い。
- これはp95ではなく、MVP開始時点のスポット値である。
- `pg_stat_statements` は現状未導入と記録されており、query-level read loadは未取得。
- Production Default Gateでは24時間のp95、error rate、fallback rate、sync lag、PostgREST read load削減見込みを別途記録する。

## 既存DB規模と重い箇所

既存調査 `docs/db-performance-and-migration-plan.md` より:

```text
public.collection: 約59.5M estimated live rows
public.collection total size: 約31GB
event_logs: 約18.9k estimated live rows
pg_stat_statements: 未導入
```

`collection_count_view` は以下の集計をPostgres上で行う。

```sql
SELECT
  collection.collection,
  count(*) AS count,
  count(*) FILTER (WHERE collection."createdAt" >= now() - interval '72 hours') AS recent_count,
  min(collection."createdAt") AS min,
  max(collection."createdAt") AS max
FROM public.collection
WHERE collection.did <> 'did:web:lexicon.store'
GROUP BY collection.collection
ORDER BY max(collection."createdAt") DESC;
```

## Source Table Mutability確認

ローカルDDL上の `public.collection`:

```text
columns: did, collection, rkey, createdAt
unique index: (did, collection, rkey, createdAt)
triggers: AFTER INSERT only
```

確認できたtrigger:

- `collection_lv2_insert_trg`
- `collection_unique_did_trg`

ローカルDDLからは、`collection` に対するUPDATE/DELETE triggerは確認できない。

ただし、別ファイルに `backfill_collection_id_batched` procedureがあり、これは `collection.collection_id` をUPDATEする内容になっている。一方で現在のローカル `collection` DDLには `collection_id` が見えない。実DBとローカルDDLの乖離があり得るためDDLだけでは断定しない。

Owner確認:

```text
2026-05-09: public.collection は現時点でUPDATEされず、DELETEもされない運用である。
```

### Mutability Gate

MVP DemoのGo判定前に、以下のいずれかを満たす必要がある。

```text
1. public.collection は実運用上 append-only とownerが確認する
2. UPDATE/DELETEがあり得る場合、全量reconciliationをMVP Demo前に実施する
3. UPDATE/DELETEがあり得る場合、tombstone/update handlingをMVP Demo前に実装する
```

どれも満たせない場合は `Stop` とする。

## ClickHouse追加コスト見積もり

方針:

- ClickHouse Cloud前提にはしない。
- OSS版ClickHouseを第一候補にする。
- 既存Postgresサーバーはスペックが強くない前提のため、原則としてPostgres本体とは同居しない。
- MVP Demoでは別VM、または明示的にresource limitされた環境で試す。

初期上限:

```text
追加運用コスト上限: 月額5,000円相当
対象: VM/VPS、storage、backup、monitoring、運用時間
```

MVP Demoで許容する範囲:

```text
ClickHouse VM: 小型VM/VPSまたは同等の隔離環境
storage: collection raw相当 + snapshot + 余裕分を観測
backup: MVP Demoでは必須化しないが、Production Default前に方針決定
ops: 週1時間以内を目標
```

Stop条件:

- 月額5,000円相当を超える見込みが高い。
- 既存Postgresサーバー同居が必要で、CPU/メモリ/IOへの影響が読めない。
- 初回バックフィルがPostgres本番DBへ許容できない負荷を与える。
- 運用が週1時間以内に収まる見込みがない。

## MVP Demo Budget

目標:

```text
MVP Demo期間: 3営業日以内
対象endpoint: collection_count_viewのみ
```

MVP Demoに含める:

- bounded one-shot/resumable backfill
- ClickHouse snapshot refresh
- Hono APIの手動起動
- PostgREST fallback
- ClickHouse-only compare
- frontend endpoint switchはcontrolled comparison用途に限定

MVP Demoに含めない:

- 全endpoint移行
- Production default cutover
- 本番cron/systemd timer有効化
- 24h overlap syncの本番運用
- 7日rescanの本番運用
- MCP endpoint実装
- 日次bucket未実装のweekly trend

## Production Default Gate

Production Defaultへ進むには、MVP Demoとは別に以下を24時間以上観測する。

```text
collection/count/min/max: 差分0
recent_count: 同期遅延窓内のみ許容
ClickHouse-only compare: pass
X-Data-Source: clickhouse
GET /collection_count_view p95: 1000ms未満目標
fallback込み p95: 3000ms未満目標
ClickHouse serving ratio: 95%以上
PostgREST read load削減見込み: 50%以上
PostgREST fallback success: 99.9%以上
sync lag: 5分以内目標
stale data継続: 10分未満
追加運用コスト: 月額5,000円相当以下
```

必要なartifact:

- timestamped compare reports
- p95/error/fallback/sync-lag series
- source mutability確認結果
- storage growth estimate
- owner署名付きGo/No-Go

## Stop / Continue判断

現時点の提案判断:

```text
Decision: Continue Demo Only
Reason:
- collection_count_viewはMVP対象として十分に限定されている
- 現行PostgRESTのスポット応答は速いが、59.5M rows / 31GB級のraw集計リスクは残る
- ClickHouseはOSS + 別VM/隔離環境で月額5,000円相当以内に収める前提なら試す価値がある
- append-onlyは未確定のため、MVP DemoのGo判断前にowner確認またはreconciliationが必要
```

まだ満たしていない条件:

- 24時間観測
- PostgREST read load削減の実測

## Owner Decision

以下のいずれかをownerが選択する。

```text
[ ] Stop
[x] Continue Demo Only
[ ] Continue Toward Production Gate
```

Owner: user
Date: 2026-05-09
Notes: Continue Demo Only。public.collection は現時点でUPDATE/DELETEされないため、MVP Demoではappend-only前提でClickHouse backfill/snapshot比較へ進める。
