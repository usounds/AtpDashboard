# Design: collection-count-load-reduction

## 方針

`collection_count_view` の API 形状は維持し、重い full refresh を増分 publish に置き換える。

現状の問題は、API が snapshot を読むことではなく、snapshot 作成時に `collection_events` を広く再集計すること。  
`collection_events` は raw append `MergeTree` のまま維持し、`event_key` を論理イベントIDとして扱う。raw table に unique 制約風の仕組みは足さない。

completed manifest を公開・watermark・dedupe の唯一の commit marker とする。  
ClickHouse に multi-table transaction はないため、manifest completed 後にさらに別テーブル更新が必要な設計にはしない。

## 最終構成

```text
collection_events
  -> CollectionEventsSync / CollectionEventsRescan
  -> collection_count_ingest_queue
  -> collection_count_incremental stage/run tables
  -> collection_count compact read model
  -> collection_count_snapshot
  -> API collection_count_view / collection_stats
```

最終的に有効な collection count 系 timer は次だけ。

- `CollectionEventsSync.timer`
- `CollectionEventsRescan.timer`
- `CollectionCountIncrementalRefresh.timer`

最終的に無効な collection count 系 timer は次。

- `CollectionCountReadModelRefresh.timer`
- `CollectionCountRefresh.timer`

analytics 系 timer はこの spec では有効化しない。  
ただし、この spec で触る deploy / rollback / stabilize script は、旧 collection count full refresh timer を再有効化しないことを検証する。

## ClickHouse DDL

### `collection_count_incremental_runs`

run 単位の状態を持つ。

- `run_id`
- `status`: `running`, `snapshot_written`, `failed`
- `from_queued_at`
- `from_event_key`
- `previous_refresh_id`
- `watermark_queued_at`
- `watermark_event_key`
- `watermark_queue_seq`
- `cutoff_queued_at`
- `cutoff_event_key`
- `cutoff_queue_seq`
- `source_rows`
- `stage_rows`
- `refresh_id`
- `error_message`
- `started_at`
- `completed_at`

`collection_count_incremental_runs.status` の許容値。

- `running`
- `snapshot_written`
- `failed`

watermark は latest completed `collection_count_refresh_manifest_v2` だけから進める。  
ClickHouse に multi-table transaction はないため、途中失敗した run の行は残っても、completed manifest がなければ意味集計に入らない。

### `collection_count_refresh_manifest_v2`

既存 manifest は `ReplacingMergeTree(updated_at)` のため status_version tie-break に使わない。  
新しい append-only manifest v2 を作り、唯一の commit marker とする。

engine / key。

- `MergeTree`
- `ORDER BY (refresh_id, status_version, updated_at)`
- migration では既存 table を `collection_count_refresh_manifest_legacy` に rename し、旧名 `collection_count_refresh_manifest` は v2 latest completed を投影する compatibility view として作り直す
- 新 incremental / API / worker / deploy verify / retry / invalidation は `collection_count_refresh_manifest_v2` だけを読む
- 新処理は compatibility view も commit source として読まない

base columns。

- `refresh_id UUID`
- `status String`
- `updated_at DateTime64(3, 'UTC')`
- `completed_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL`
- `row_count UInt64 DEFAULT 0`
- `refreshed_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')`

v2 固有列。

- `run_id Nullable(UUID) DEFAULT NULL`
- `previous_refresh_id Nullable(UUID) DEFAULT NULL`
- `watermark_queued_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL`
- `watermark_event_key Nullable(String) DEFAULT NULL`
- `watermark_queue_seq String DEFAULT ''`
- `cutoff_queued_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL`
- `cutoff_event_key Nullable(String) DEFAULT NULL`
- `cutoff_queue_seq String DEFAULT ''`
- `snapshot_anchor_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL`
- `source_rows UInt64 DEFAULT 0`
- `stage_rows UInt64 DEFAULT 0`
- `event_seen_row_count UInt64 DEFAULT 0`
- `event_conflict_row_count UInt64 DEFAULT 0`
- `first_seen_row_count UInt64 DEFAULT 0`
- `did_seen_row_count UInt64 DEFAULT 0`
- `rkey_seen_row_count UInt64 DEFAULT 0`
- `hourly_row_count UInt64 DEFAULT 0`
- `snapshot_written UInt8 DEFAULT 0`
- `event_seen_written UInt8 DEFAULT 0`
- `event_conflict_written UInt8 DEFAULT 0`
- `first_seen_written UInt8 DEFAULT 0`
- `did_seen_written UInt8 DEFAULT 0`
- `rkey_seen_written UInt8 DEFAULT 0`
- `hourly_written UInt8 DEFAULT 0`
- `cumulative_users_written UInt8 DEFAULT 0`
- `validation_passed UInt8 DEFAULT 0`
- `queue_backfill_generation UInt64 DEFAULT 0`
- `status_version UInt64 DEFAULT 0`
- `invalidated_at Nullable(DateTime64(3, 'UTC')) DEFAULT NULL`
- `invalidated_reason Nullable(String) DEFAULT NULL`
- `is_bootstrap_seed UInt8 DEFAULT 0`

compatibility。

- legacy table は `collection_count_refresh_manifest_legacy` として read-only 保持する
- 旧名 `collection_count_refresh_manifest` は view とし、`collection_count_refresh_manifest_v2` の latest valid completed を旧API互換列へ投影する
- compatibility view の列は少なくとも `refresh_id`, `status`, `row_count`, `refreshed_at`, `completed_at`, `updated_at` を持つ
- compatibility view は write target にしない。旧手動 write path は hard-fail させ、新 deploy script へ誘導する
- legacy rows は v2 へ自動 copy しない。incremental deploy 前に published snapshot が必要な場合は、deploy script が明示的に v2 bootstrap seed または rollback snapshot を作る
- incremental deploy の latest completed 判定では legacy table と compatibility view を watermark source として使わない

`collection_count_refresh_manifest_v2.status` の許容値。

- `running`
- `completed`
- `failed`

`snapshot_written` は manifest status ではなく marker column としてだけ扱う。  
run の中間状態は `collection_count_incremental_runs.status = 'snapshot_written'` にだけ書く。

watermark / cutoff の意味。

- `cutoff_*`: その refresh が queue から読んだ上限 `(queued_at, event_key, queue_seq)`。completed 後、次回 run の開始 watermark になる
- `watermark_*`: その refresh が開始時に読んだ前回 completed cutoff。診断・検証用に保持する
- 初回 incremental run は lower bound なしで読む。sentinel を置く場合は `(toDateTime64(0, 3, 'UTC'), '', '')` を使い、queue の最小 row を落とさない
- 2回目以降の valid completed は `cutoff_* IS NOT NULL` を必須にする
- 次回 run の queue predicate は `(queued_at, event_key, queue_seq) > (previous.cutoff_queued_at, previous.cutoff_event_key, previous.cutoff_queue_seq)` かつ `(queued_at, event_key, queue_seq) <= (new.cutoff_queued_at, new.cutoff_event_key, new.cutoff_queue_seq)`
- predicate は exclusive lower bound / inclusive upper bound に固定する

status version の規則。

- `status_version` は同一 `refresh_id` 内で status 遷移ごとに必ず単調増加させる
- manifest writer は `running=10`, `completed=30`, `failed=90` を下限として使い、同一 status を再 insert する場合も前回より大きい値を入れる
- `snapshot_written=20` は `collection_count_incremental_runs.status` の中間状態であり、manifest status には使わない
- `argMax(..., tuple(updated_at, status_version))` の tie が残らないよう、同一 `refresh_id` / 同一 `updated_at` の複数 status row は `status_version` で決定的に順序付ける
- `completed` は terminal status とし、同じ `refresh_id` に後続 `failed` を書かない

latest completed は次の意味で読む。

- `argMax(status, tuple(updated_at, status_version))` が `completed`
- `completed_at` が NULL ではない
- `snapshot_written`, `event_seen_written`, `event_conflict_written`, `first_seen_written`, `did_seen_written`, `rkey_seen_written`, `hourly_written`, `cumulative_users_written`, `validation_passed` がすべて 1
- `row_count`, `first_seen_row_count`, `did_seen_row_count`, `rkey_seen_row_count`, `hourly_row_count` は publish 時検証で実テーブルから取得済み

API は heavy artifact 再検証をリクエスト時に実行しない。  
API は検証済み manifest marker だけで latest `refresh_id` を選び、snapshot table を読む。  
worker / deploy verify は publish 時だけ artifact 検証 SQL を実行する。  
`WHERE status = 'completed' ORDER BY completed_at DESC` の直読みは禁止する。

valid completed CTE は2種類に分ける。

- `valid_completed_all`: state / seen log の可視性に使う。全 valid completed refresh を返す
- `latest_valid_completed`: API snapshot / watermark 選択に使う。`valid_completed_all` から最新1件だけを返す

API 用 latest completed CTE の形。

```sql
WITH latest_manifest AS
(
    SELECT
        refresh_id,
        argMax(status, tuple(updated_at, status_version)) AS latest_status,
        argMax(completed_at, tuple(updated_at, status_version)) AS latest_completed_at,
        argMax(run_id, tuple(updated_at, status_version)) AS run_id,
        argMax(previous_refresh_id, tuple(updated_at, status_version)) AS previous_refresh_id,
        argMax(watermark_queued_at, tuple(updated_at, status_version)) AS watermark_queued_at,
        argMax(watermark_event_key, tuple(updated_at, status_version)) AS watermark_event_key,
        argMax(watermark_queue_seq, tuple(updated_at, status_version)) AS watermark_queue_seq,
        argMax(cutoff_queued_at, tuple(updated_at, status_version)) AS cutoff_queued_at,
        argMax(cutoff_event_key, tuple(updated_at, status_version)) AS cutoff_event_key,
        argMax(cutoff_queue_seq, tuple(updated_at, status_version)) AS cutoff_queue_seq,
        argMax(snapshot_anchor_at, tuple(updated_at, status_version)) AS snapshot_anchor_at,
        argMax(row_count, tuple(updated_at, status_version)) AS row_count,
        argMax(first_seen_row_count, tuple(updated_at, status_version)) AS first_seen_row_count,
        argMax(did_seen_row_count, tuple(updated_at, status_version)) AS did_seen_row_count,
        argMax(rkey_seen_row_count, tuple(updated_at, status_version)) AS rkey_seen_row_count,
        argMax(hourly_row_count, tuple(updated_at, status_version)) AS hourly_row_count,
        argMax(snapshot_written, tuple(updated_at, status_version)) AS snapshot_written,
        argMax(event_seen_written, tuple(updated_at, status_version)) AS event_seen_written,
        argMax(event_conflict_written, tuple(updated_at, status_version)) AS event_conflict_written,
        argMax(first_seen_written, tuple(updated_at, status_version)) AS first_seen_written,
        argMax(did_seen_written, tuple(updated_at, status_version)) AS did_seen_written,
        argMax(rkey_seen_written, tuple(updated_at, status_version)) AS rkey_seen_written,
        argMax(hourly_written, tuple(updated_at, status_version)) AS hourly_written,
        argMax(cumulative_users_written, tuple(updated_at, status_version)) AS cumulative_users_written,
        argMax(validation_passed, tuple(updated_at, status_version)) AS validation_passed,
        argMax(invalidated_at, tuple(updated_at, status_version)) AS invalidated_at,
        argMax(is_bootstrap_seed, tuple(updated_at, status_version)) AS is_bootstrap_seed
    FROM atp_dashboard.collection_count_refresh_manifest_v2
    GROUP BY refresh_id
),
valid_completed_all AS
(
    SELECT *
    FROM latest_manifest
    WHERE latest_status = 'completed'
      AND latest_completed_at IS NOT NULL
      AND invalidated_at IS NULL
      AND is_bootstrap_seed = 0
      AND run_id IS NOT NULL
      AND snapshot_anchor_at IS NOT NULL
      AND cutoff_queued_at IS NOT NULL
      AND cutoff_event_key IS NOT NULL
      AND cutoff_queue_seq != ''
      AND snapshot_written = 1
      AND event_seen_written = 1
      AND event_conflict_written = 1
      AND first_seen_written = 1
      AND did_seen_written = 1
      AND rkey_seen_written = 1
      AND hourly_written = 1
      AND cumulative_users_written = 1
      AND validation_passed = 1
)
SELECT *
FROM valid_completed_all
ORDER BY latest_completed_at DESC, cutoff_queued_at DESC, cutoff_event_key DESC, cutoff_queue_seq DESC, refresh_id DESC
LIMIT 1
```

state / seen log の visible read は `valid_completed_all` に join する。  
API snapshot と次回 watermark は `latest_valid_completed` だけを使う。

linear commit guard。

- run 開始時の `previous_refresh_id`, `watermark_queued_at`, `watermark_event_key`, `watermark_queue_seq` を `collection_count_incremental_runs` に保存する
- final completed manifest insert 直前に、現在の `latest_valid_completed.refresh_id` / cutoff `(cutoff_queued_at, cutoff_event_key, cutoff_queue_seq)` が run 開始時の値と一致することを検証する
- 一致しない場合、その run は `failed` にし、completed manifest を insert しない
- deploy CLI / manual CLI / systemd service は同じ `flock` lock を必須にする
- 万一 overlapping completed が検出された場合、deploy verify は fail し、該当 refresh に `invalidated_at` / `invalidated_reason` を持つ manifest row を追加して `valid_completed_all` から除外する

### `collection_count_ingest_queue`

collection count 用の増分 source。

- `event_key`
- `collection`
- `did`
- `rkey`
- `created_at`
- `created_at_key`
- `created_hour`
- `source_ingested_at`
- `queued_at`
- `queue_seq`
- `payload_hash`

`collection_events` は `ingested_at` が ORDER BY に入っていないため、定期増分処理で `collection_events WHERE ingested_at > watermark` を直接読む設計にはしない。  
初回だけ backfill script が `collection_events` から queue を作る。以後は `backfill-collection-events.ts` / `CollectionEventsSync.service` / `CollectionEventsRescan.service` の反映経路が、`collection_events` と同じイベントを `collection_count_ingest_queue` にも書く。

queue は `ORDER BY (queued_at, event_key, queue_seq)` とする。  
`queue_seq` は writer が発行する lexicographic monotonic row id とし、同一 `queued_at` / `event_key` の複数物理行を lossless に読むための cursor 第3要素にする。  
定期 refresh は queue だけを `(queued_at, event_key, queue_seq)` の複合 watermark で読む。  
`source_ingested_at` は raw source との照合・診断用であり、watermark には使わない。

`queue_seq` の発行方式。

- `queue_seq` は writer が生成する lexicographic sortable string とする
- `queue_seq` は empty / NULL を禁止し、bootstrap / sync / rescan / backfill / repair の全 insert path で必須にする
- 形式は `unix_ms_padded-writer_id-local_counter_padded-random_suffix` とし、同一 writer process 内では直前発行値以下にならない hybrid logical clock を使う
- `writer_id` は sync / rescan / backfill / repair の process 起動時に固定する
- 新しい queue row は必ず latest completed cutoff より大きい `(queued_at, event_key, queue_seq)` になるよう、writer/backfill/repair が insert 前に検証する
- insert 前検証で latest completed cutoff 以下になる場合は、`queued_at` を `previous_cutoff_queued_at + INTERVAL 1 millisecond` 以上に bump してから再検証する
- active `collection_count_incremental_runs` に reserved cutoff がある場合、新しい queue row は latest completed cutoff だけでなく active reserved cutoff よりも大きい tuple にする
- refresh worker は `queued_at <= now64(3, 'UTC') - safety_lag` の範囲から reserved cutoff を決め、stage 作成前にその cutoff を run table に保存する
- writer は queue insert 時刻を `queued_at` に使い、source time / `source_ingested_at` を `queued_at` に戻さない
- dual-write / backfill / repair はすべて同じ generator 仕様を使う
- 1 insert batch 内でも物理行ごとに別の `queue_seq` を生成する
- `queue_seq` は String で、同じ `(queued_at, event_key)` の行でも必ず異なる
- queue row は insert 前に canonical normalized payload tuple から `payload_hash` を計算し、existence log と同じ値を書かなければならない
- 並行 writer で `queue_seq` collision が起きないこと、empty / NULL `queue_seq` が拒否されること、かつ new row が completed cutoff 以下に入らないことを integration test に入れる

cutover 手順。

1. queue DDL を先に作る
2. dual-write 対応済みの `backfill-collection-events.ts` / sync / rescan を反映し、以後の raw success は queue と existence log へ同じ logical event を書く
3. dual-write 反映直後に `dual_write_started_at` を記録する
4. dual-write 稼働確認後に `bootstrap_high = max(collection_events.ingested_at, event_key)` を記録する
5. `bootstrap_high` 以下の既存 `collection_events` を queue と existence log に backfill する
6. step 3 から step 4 の overlap 範囲も backfill 対象に含め、dual-write 開始前後の隙間を作らない
7. 初回 backfill row の `queued_at` は backfill insert 時刻から作る単調 sequence time を付与し、`source_ingested_at` を `queued_at` に使わない
8. backfill 完了後に `bootstrap_high` 以下の bounded source 範囲だけを検証し、queue / existence log 欠損と duplicate conflict を 0 にする
9. 初回 incremental run は lower bound なしで queue を読み、bootstrap/backfill row をすべて含める
10. 検証成功後だけ incremental timer を enable する

deploy hard gate。

- `bootstrap_high` 記録前に、`collection_events` を insert し得る全 write path が queue と existence log を dual-write していることを machine-check する
- dual-write 未対応 path が 1 つでも残る場合、deploy は non-zero で停止し、incremental timer を enable しない

片肺失敗の扱い。

- `collection_events` 成功 / queue 失敗は repair 対象として検出する
- repair script は raw success の証跡である `collection_count_event_existence_log` に存在し queue にない `(event_key, payload_hash)` を補充する
- repair 補充時の `queued_at` は ClickHouse 側の単一時刻源で `greatest(now64(3, 'UTC'), previous_cutoff_queued_at + INTERVAL 1 millisecond)` として作る。過去の `source_ingested_at` を `queued_at` に戻さない
- repair row は `(queued_at, event_key, queue_seq) > (previous_cutoff_queued_at, previous_cutoff_event_key, previous_cutoff_queue_seq)` を SQL で検証してから insert する
- queue 成功 / `collection_events` 失敗は orphan queue として検出する
- stage 作成前に queue candidate の `(event_key, payload_hash)` を bounded anti-join で `collection_count_event_existence_log` に照合する
- 定期 refresh は orphan check のために raw `collection_events` を直接 anti-join しない
- orphan queue が batch 内に 1 件でもある場合、その run は `failed` にし、watermark を進めない
- orphan は `collection_count_queue_orphans` に記録し、raw 側 repair が完了したら new `(queued_at, event_key, queue_seq) > previous cutoff` で requeue する
- orphan queue は通常 stage へ入れない
- deploy verify は queue missing `(event_key, payload_hash)` と queue orphan の両方が 0 であることを必須にする
- queue 欠損が 0 になるまで deploy は成功扱いしない

### `collection_count_event_existence_log`

raw `collection_events` へ入った logical event の存在証跡。  
定期 refresh の orphan check はこの table を使い、raw `collection_events` を広域 scan しない。

- `event_key`
- `payload_hash`
- `collection`
- `did`
- `rkey`
- `created_at`
- `created_at_key`
- `created_hour`
- `source_ingested_at`
- `written_at`

engine / key。

- `MergeTree`
- `ORDER BY (event_key, payload_hash)`

書き込み規則。

- `collection_events` insert 成功後に同じ logical event を書く
- Sync / Rescan / backfill は、同じ source batch の `collection_events`, `collection_count_event_existence_log`, `collection_count_ingest_queue` がすべて書かれた、または idempotent に既存確認できた場合だけ upstream cursor / checkpoint を進める
- `collection_events` は成功したが existence log または queue write が失敗した場合、source batch は同じ upstream cursor から retry する
- retry は bounded source cursor の範囲で既存 raw row を確認し、不足している existence log / queue row だけを補充する。定期 refresh のために raw `collection_events` を broad scan しない
- bounded source cursor から retry できない書き込み経路は release blocker とし、incremental timer を enable しない
- queue insert 失敗時も existence log があれば repair が queue を補充できる
- repair は existence log の `collection`, `did`, `rkey`, `created_at`, `created_at_key`, `created_hour`, `source_ingested_at`, `payload_hash` から queue row を復元する
- queue だけが成功し existence log がない row は orphan として扱う
- 初回 bootstrap は `bootstrap_high` 以下の raw source から queue と existence log の両方を backfill する
- deploy verify 以外の定期経路では raw `collection_events` と queue の broad anti-join を行わない

### `collection_count_event_stage`

run 内の新規候補イベントを保持する。

- `run_id`
- `event_key`
- `collection`
- `did`
- `rkey`
- `created_at`
- `created_at_key`
- `created_hour`
- `source_ingested_at`
- `queued_at`
- `queue_seq`
- `payload_hash`

`collection_count_ingest_queue` から読む範囲は `(queued_at, event_key, queue_seq)` の複合 watermark で決める。  
同一 `ingested_at` の複数行が run をまたいでも取りこぼさない。

stage 作成時に次を行う。

- stage creation first writes a raw run-scoped candidate set preserving every physical queue row in the selected watermark range
- same-run conflict detection runs against this uncollapsed candidate set before canonical row selection
- only after conflicts are recorded and excluded may identical duplicates be collapsed to one canonical row per `event_key`
- canonical normalized payload tuple は `(collection, did, rkey, coalesce(created_at_key, '<NULL>'), coalesce(toString(created_hour), '<NULL_HOUR>'))` とする
- `payload_hash = cityHash64(concat(canonical normalized payload tuple fields with '\0'))` とする
- 同一 `event_key` 内の conflict 判定を canonical row 選択より先に行う
- canonical row は `argMin(tuple(collection, did, rkey, created_at, created_at_key, created_hour, source_ingested_at, queued_at, queue_seq, payload_hash), tuple(source_ingested_at, queued_at, queue_seq, payload_hash, collection, did, rkey, created_at_key, created_hour))` で決定する
- 同一 `event_key` に複数の canonical normalized payload tuple が存在する場合は `collection_count_event_conflicts` に記録し、対象 `event_key` は stage から除外する
- 同一 `event_key` の canonical normalized payload tuple がすべて同じ場合は identical duplicate として 1 件に collapse する
- cross-run duplicate は first completed wins とする
- 後続 run に同じ `event_key` が来た場合、既存 completed seen log の canonical normalized payload tuple と `payload_hash` を比較する
- canonical normalized payload tuple と `payload_hash` が同じなら identical replay として stage から除外するだけにする
- canonical normalized payload tuple または `payload_hash` が異なるなら `collection_count_event_conflicts` に記録し、stage から除外する
- cross-run duplicate probe の canonical existing row は `valid_completed_all` に join した seen log から `argMin(payload_tuple, tuple(latest_completed_at, cutoff_queued_at, cutoff_event_key, cutoff_queue_seq, refresh_id))` で選ぶ
- conflict 判定は `payload_hash` と canonical payload tuple の両方を比較する
- `did = 'did:web:lexicon.store'` は既存互換のため collection count / first-seen / unique 系から除外する
- 既に completed manifest に紐づく `collection_count_event_seen_log` に存在する `event_key` を除外する
- `created_at IS NULL` は all-time count には入れてよいが、recent window からは除外する

### `collection_count_event_seen_log`

公開済み logical event の判定に使う run-scoped log。  
ClickHouse に unique 制約はないため、この table 単体を「物理一意」とは扱わない。

- `run_id`
- `refresh_id`
- `event_key`
- `collection`
- `did`
- `rkey`
- `created_at`
- `created_at_key`
- `created_hour`
- `source_ingested_at`
- `queued_at`
- `payload_hash`
- `seen_at`

engine / key。

- `MergeTree`
- `ORDER BY (event_key, refresh_id, run_id)`

visible seen event は、`collection_count_event_seen_log` を全 completed manifest に join したものとする。  
failed / running / snapshot_written run の log row は、存在しても dedupe / snapshot / watermark に使わない。

queue replay や repair で同じ `event_key` が複数 insert されても、読み側は必ず `GROUP BY event_key` または `uniqExact(event_key)` で意味上 1 件にする。  
current stage の除外は、current stage の `event_key` だけを completed seen log に probe する。  
completed seen log は latest run 限定ではなく、過去の completed refresh が公開済みの全 logical event を対象にする。  
全履歴を集計 join せず、keyed existence check だけにする。

`collection_count_event_seen_log` は duplicate `event_key` の永続 dedupe state なので Phase1 では削除しない。

### versioned compact state model

累積 state を completed manifest 後に更新しない。  
各 refresh は、run-scoped / refresh-scoped の compact state row を completed manifest 前に書く。  
completed manifest が入るまで、その row は API / dedupe / 次回計算から見えない。

visibility 判定。

- seen log / compact state は、`valid_completed_all` に含まれる manifest だけを visible とする
- API snapshot / watermark は、`latest_valid_completed` だけを visible とする
- raw `status = 'completed'` だけの join は使わない
- worker の probe は current stage の key subset に限定し、visible manifest に join した keyed state だけを見る

authoritative な published artifacts。

- `collection_count_snapshot`
  - 全 collection の full snapshot
  - current run に変更がない collection も前回 completed snapshot から copy して残す
- `collection_count_event_seen_log`
  - 全 completed manifest に紐づく logical event だけが visible
- `collection_count_did_seen_state`
  - `(collection, did)` の versioned keyset
  - `created_at IS NULL` の DID もここで重複判定する
- `collection_count_rkey_seen_state`
  - `(collection, did, rkey)` の versioned keyset
  - `unique_rkey` の cross-run 二重加算をここで防ぐ
- `collection_count_did_first_seen_state`
  - `(collection, did)` の versioned first-seen state
  - `created_at IS NULL` の row は入れない
- `collection_count_recent_hourly_state`
  - `collection x created_hour` の versioned hourly state
  - recent window の期限切れは snapshot 作成時に 72 complete hours から外すだけで、全 history copy はしない
- `collection_count_cumulative_users_snapshot`
  - `collection x day` の365日 daily cumulative users API 用 snapshot
  - completed manifest 前に bounded rows として publish し、API は request-time に first-seen state 全体を scan しない

compact state DDL。

- `collection_count_did_seen_state`
  - columns: `refresh_id`, `run_id`, `collection`, `did`, `first_seen_at Nullable(DateTime64(3, 'UTC'))`, `created_at_is_null UInt8`, `state_written_at`
  - engine: `MergeTree`
  - order: `ORDER BY (collection, did, refresh_id)`
  - probe: current run の `(collection, did)` だけを visible completed state に keyed lookup する
- `collection_count_rkey_seen_state`
  - columns: `refresh_id`, `run_id`, `collection`, `did`, `rkey`, `state_written_at`
  - engine: `MergeTree`
  - order: `ORDER BY (collection, did, rkey, refresh_id)`
  - probe: current run の `(collection, did, rkey)` だけを visible completed state に keyed lookup する
- `collection_count_did_first_seen_state`
  - columns: `refresh_id`, `run_id`, `collection`, `did`, `first_seen_at`, `state_written_at`
  - engine: `MergeTree`
  - order: `ORDER BY (collection, did, first_seen_at, refresh_id)`
  - `created_at IS NULL` は入れない
  - late old event は same key のより古い `first_seen_at` row として追加し、visible read は `min(first_seen_at)` を使う
- `collection_count_recent_hourly_state`
  - columns: `refresh_id`, `run_id`, `collection`, `created_hour`, `event_count`, `state_written_at`
  - engine: `SummingMergeTree(event_count)`
  - order: `ORDER BY (created_hour, collection, refresh_id)`
  - partition: `PARTITION BY toYYYYMM(created_hour)`
  - read: snapshot anchor の 72 complete hours に入る rows だけを completed manifest に join して collection 単位に集計する
- `collection_count_cumulative_users_snapshot`
  - columns: `refresh_id`, `collection`, `day`, `new_users`, `cumulative_users`, `refreshed_at`
  - engine: `MergeTree`
  - order: `ORDER BY (refresh_id, collection, day)`
  - API read: selected collection の最大365 daily rows だけを読み、requested `days` / `bucket_days` に API 層で bounded aggregation する
  - 粒度: collection 単位の365日 daily cumulative/base snapshot
  - 保持範囲: latest completed と rollback 用世代の daily rows を保持する
  - marker 検証: collection ごとに最大365 rows、future day 0、`cumulative_users` monotonic を確認してから `cumulative_users_written=1` にする

### `collection_count_event_conflicts`

duplicate `event_key` の payload 不一致を診断する。

- columns: `run_id`, `refresh_id`, `event_key`, `payload_hash`, `existing_payload_hash Nullable(UInt64)`, `collection`, `did`, `rkey`, `created_at_key`, `source_ingested_at`, `queued_at`, `detected_at`
- engine: `MergeTree`
- order: `ORDER BY (event_key, refresh_id, run_id)`
- 書き込み条件: same run 内 conflict、または cross-run duplicate で first completed payload と `payload_hash` が異なる場合
- conflicts は集計に使わない
- completed manifest 前に conflict row count を取得し、`event_conflict_written=1` と `event_conflict_row_count` を completed row に載せる
- retention: 90 日保持

### `collection_count_queue_orphans`

queue に存在するが raw `collection_events` に存在しない row を隔離する。

- columns: `run_id`, `event_key`, `queued_at`, `queue_seq`, `payload_hash`, `detected_at`, `resolved_at Nullable(DateTime64(3, 'UTC'))`, `resolution Nullable(String)`
- engine: `MergeTree`
- order: `ORDER BY (event_key, queued_at, queue_seq)`
- stage 作成前の bounded orphan check で見つけた row を記録する
- orphan が存在する run は failed になり、watermark は進めない
- raw repair 後は新しい `queued_at` / `queue_seq` で requeue し、元 orphan row は `resolved_at` を入れる
- deploy verify は unresolved orphan が 0 であることを確認する
- retention: resolved から 30 日後に削除可能

visible state query semantics。

- all visible state reads join to `valid_completed_all`, not raw `status = 'completed'`
- broad examples over all historical state are semantics only, not implementation SQL
- implementation must use bounded probes from current stage keys / affected collections / latest 72h range

worker は上記の全履歴 visible query をそのまま広域実行しない。  
current stage keys を小さな一時 table として先に作り、state table 側は primary key prefix で絞る。

probe SQL の形。

```sql
-- did seen probe
SELECT s.collection, s.did
FROM atp_dashboard.collection_count_did_seen_state s
INNER JOIN valid_completed_all v USING (refresh_id)
WHERE (s.collection, s.did) IN (
  SELECT collection, did FROM current_stage_did_keys
)
GROUP BY s.collection, s.did

-- rkey seen probe
SELECT s.collection, s.did, s.rkey
FROM atp_dashboard.collection_count_rkey_seen_state s
INNER JOIN valid_completed_all v USING (refresh_id)
WHERE (s.collection, s.did, s.rkey) IN (
  SELECT collection, did, rkey FROM current_stage_rkey_keys
)
GROUP BY s.collection, s.did, s.rkey
```

`current_stage_*_keys` は current run から作る小テーブルであり、state 側を全件 hash 化する query plan にしない。
`EXPLAIN indexes=1` で state table の primary key 条件が使われることを integration test と deploy verify に入れる。

run-scoped delta tables。

- `collection_count_collection_delta`
  - `ORDER BY (run_id, collection)`
  - current run の `event_key` dedupe 後に collection 単位の `total_count`, `min_created_at`, `max_created_at` delta を保持する
- `collection_count_did_delta`
  - `ORDER BY (run_id, collection, did)`
  - current run で初めて visible になる `(collection, did)` を保持する
- `collection_count_rkey_delta`
  - `ORDER BY (run_id, collection, did, rkey)`
  - current run で初めて visible になる `(collection, did, rkey)` を保持する
- `collection_count_did_first_seen_delta`
  - `ORDER BY (run_id, collection, did)`
  - current run 内の `min(created_at)` を保持する
  - previous first-seen より古い late-ingested event が来た場合は candidate first-seen snapshot で過去へ戻す
- `collection_count_recent_hourly_delta`
  - `ORDER BY (run_id, created_hour, collection)`
  - current run の `event_key` dedupe 後に `collection x created_hour` の event count delta を保持する

candidate 作成時の probe / copy-forward。

- `unique_did`: completed `collection_count_did_seen_state` に `(collection, did)` がなければ new DID とする
- `unique_rkey`: completed `collection_count_rkey_seen_state` に `(collection, did, rkey)` がなければ new rkey とする
- `first_seen`: completed `collection_count_did_first_seen_state` と current delta の `min(created_at)` を比較し、より古い値を new state row として書く
- `recent_count`: completed `collection_count_recent_hourly_state` と current hourly delta から、new anchor の 72 complete hours に入る rows だけを collection 単位で集計する
- `collection_count_snapshot` は前回 snapshot の collection 行を copy-forward し、current run で `total_count` / unique / `min_created_at` / `max_created_at` が変わる collection と、72h window の出入りで recent_count が変わる collection だけを差し替える
- recent aging の affected set は、前回 snapshot の `recent_count > 0` collection、current hourly delta の collection、新 anchor の 72 complete hours に存在する hourly state の collection の和集合とする
- この affected set だけ recent_count を再計算し、他 collection は copy-forward する
- publish 前 validation も affected collection / current run keys / latest 72h range に限定する
- 定期経路の validation で did/rkey/hourly state 全体を collection 全件で broad scan しない
- DID/RKEY/first-seen/hourly の full keyset snapshot は毎 refresh 作らない
- hourly state は `(collection, created_hour, event_key)` dedupe 後に `event_count` を作るため、複数 completed run を合算しても duplicate logical event は二重加算されない
- hourly retention は latest snapshot anchor の 72 complete hours + safety lag を完全に含む範囲だけ残す。削除前に `min(created_hour)` / `max(created_hour)` の coverage を検証する

cumulative users snapshot 生成。

- 対象は collection 単位の最大365日 daily rows に固定する
- current run で first_seen が新規または過去へ戻った `(collection,did)` を affected set とする
- affected collection に加えて、snapshot anchor の日付が進んだ場合に前回 daily rows を持つ collection も再生成対象にする
- 再生成対象 collection は completed `collection_count_did_first_seen_state` を collection key で絞って bucket 集計する
- late old first_seen で過去 day が変わる場合、その collection の365日 daily rows を再生成する
- anchor day が同一で first_seen 変化もない collection だけ、前回 `collection_count_cumulative_users_snapshot` の rows を copy-forward する
- publish 時に first-seen state 全体を全 collection で broad scan しない
- daily row は `day`, `new_users`, `cumulative_users` だけを公開 artifact とし、window/bucket 列は持たない
- window / bucket 変換は API 層で selected collection の最大365 daily rows から行う

`created_at IS NULL` の扱い。

- all-time `count` は有効な `event_key` があれば数える
- `unique_did` は `did` が有効なら数える
- `unique_rkey` は `did` と `rkey` が有効なら数える
- `recent_count` は除外する
- `collection_count_did_first_seen_state` と cumulative users は除外する
- hourly delta / hourly state は `created_at IS NOT NULL` の row だけを対象にし、`created_hour` は non-null として書く

`did = 'did:web:lexicon.store'` は既存互換のため collection count / first-seen / unique 系から除外する。

定期経路で raw `collection_events` に対して広域 `uniqExact` をかけない。  
snapshot は latest completed snapshot + current run delta から発行する。  
completed manifest は最後の公開操作であり、manifest insert 後に別 table を更新しない。

### `collection_count_recent_hourly_delta`

recent count 用の run delta。

- `run_id`
- `created_hour`
- `collection`
- `event_count`

engine / key。

- `MergeTree`
- `ORDER BY (run_id, created_hour, collection)`

recent hourly delta も run-scoped とし、completed manifest に紐づかない run は snapshot に使わない。

`created_hour = toStartOfHour(created_at)` とする。  
`anchor_hour = toStartOfHour(snapshot_anchor_at)` とする。  
`recent_count` は `[anchor_hour - INTERVAL 72 HOUR, anchor_hour)` の 72 complete hours の count として定義する。  
current partial hour は含めない。  
厳密な「リクエスト時刻から72時間ぴったり」ではないため、API header と manifest に snapshot anchor / refreshed_at を残す。

### `collection_count_snapshot`

既存 API 契約を維持する publish 先。  
latest completed snapshot だけを API が読む。

保持する意味。

- `collection`
- `total_count`: duplicate raw row を除いた論理イベント数
- `recent_count`: snapshot anchor 基準の直近 72 complete hours
- `unique_did`: exact distinct DID
- `unique_rkey`: exact distinct `(did, collection, rkey)`
- `min_created_at`
- `max_created_at`
- `refresh_id`
- `refreshed_at`

## 増分 refresh CLI

追加する。

- `refresh-collection-count-incremental.ts`

処理順。

1. latest completed manifest から複合 watermark を読む
2. safety lag を含めた cutoff `(queued_at, event_key, queue_seq)` を決める
3. `collection_count_incremental_runs` に `running` を作る
4. `collection_count_ingest_queue` から対象範囲を raw candidate stage に全物理行として入れる
5. raw candidate stage 上で同一 `event_key` の payload conflict を検出し、conflict event を除外する
6. conflict でない identical duplicate だけを canonical stage に 1 件化する
7. current canonical stage の `event_key` だけを completed `collection_count_event_seen_log` に probe し、既存 event を除外する
8. 新規 event だけから run-scoped delta と `collection_count_event_seen_log` を同じ `refresh_id` で作る
9. versioned compact state row と candidate `collection_count_snapshot` を作る
10. run を `snapshot_written` にする
11. candidate から `collection_count_snapshot` を publish し、first-seen / did-seen / rkey-seen / hourly state row を書く。ただしこの時点では manifest marker を公開しない
12. `collection_count_cumulative_users_snapshot` を同じ `refresh_id` で publish し、completed manifest 前の必須 SQL 検証を行う
13. 最終 `completed` manifest row を insert する。この row 自体に watermark / cutoff / snapshot anchor / all row counts / all written markers / validation_passed をすべて載せる

batch 上限。

- 1 run の queue 読み取りは `max_rows`, `max_queued_at_span`, `max_estimated_bytes` を持つ
- cutoff は safety lag と batch 上限の小さい方で決める
- backlog がある場合は completed manifest で watermark を進め、次 timer で続きから処理する
- batch 上限に到達した run は正常 completed とし、旧 full refresh に fallback しない
- previous cutoff から safety-lag boundary まで queue row がない場合、worker は zero-source aging refresh を publish してよい
- zero-source aging refresh は previous cutoff tuple をそのまま再利用し、`source_rows=0`, `stage_rows=0` とする
- zero-source aging refresh の queue predicate は意図的に空で、lower bound と cutoff は同じ tuple になる
- zero-source aging refresh は snapshot anchor を進め、time-window affected collection だけ recent_count / cumulative daily rows を再計算して completed manifest を書く
- zero-source aging refresh は unseen queue row を飛び越えず、linear commit guard を必ず通す
- zero-source aging refresh でも `snapshot_written`, `event_seen_written`, `event_conflict_written`, `first_seen_written`, `did_seen_written`, `rkey_seen_written`, `hourly_written`, `cumulative_users_written`, `validation_passed` はすべて 1 にする
- zero-row artifact は row count 0 と written marker 1 を明示し、未作成 artifact と区別する
- zero-source aging refresh の publish validation は snapshot / seen log / conflicts / first-seen / did-seen / rkey-seen / hourly / cumulative users の空または copy-forward artifact を検証してから completed manifest を書く

初回 bootstrap 例外。

- 初回 bootstrap は通常 `valid_completed_all` に入らない private seed generation として処理する
- seed batch ごとに `is_bootstrap_seed=1` の completed manifest row を作って private checkpoint にできる
- `is_bootstrap_seed=1` は API / worker / normal watermark の source にしない
- bootstrap resume は `collection_count_refresh_manifest_v2` の `is_bootstrap_seed=1` 行だけから private latest seed cutoff を `argMax(..., tuple(updated_at, status_version))` で読み、通常 `latest_valid_completed` とは混ぜない
- private seed manifest も `cutoff_queued_at`, `cutoff_event_key`, `cutoff_queue_seq`, row counts, written markers を持つ
- 初回処理が batch 上限に達した場合は seed completed で private watermark だけ進め、API visible にしない
- 初回 visible publish は full historical queue 処理、state seed、snapshot validation がすべて完了した後だけ行う
- final bootstrap publish は private seed refresh_id 群を直接 visible にしない
- final bootstrap publish は新しい non-bootstrap `refresh_id` を発行し、private seed の seen/state/hourly/first-seen/cumulative/snapshot artifacts を同一 `refresh_id` へ copy/materialize してから completed manifest を書く
- final bootstrap publish の検証は copied/materialized artifact だけを対象にし、`valid_completed_all` に private seed refresh_id を混ぜない
- final bootstrap completed manifest の `previous_refresh_id` は NULL、`watermark_*` は sentinel、`cutoff_*` は private seed latest cutoff とする
- 通常増分だけ batch completed による watermark 前進を許可する

completed manifest insert 後に別 table を更新しない。  
step 12 までに publish に必要な row はすべて書き終えておき、completed manifest は visibility を切り替える最後の操作にする。

retry の規則。

- 失敗した run は再利用しない
- retry は常に新しい `run_id` / `refresh_id` を発行する
- failed / running / snapshot_written の古い row は残してよいが、completed manifest に join されないため不可視
- 同じ `refresh_id` への再 publish は行わない
- completed manifest 前の artifact insert 結果が timeout / connection lost で不明な場合、その `refresh_id` は公開せず abandon し、次回は新しい `run_id` / `refresh_id` で最初からやり直す
- 不明 artifact の `refresh_id` は completed manifest がないため API / dedupe / watermark から不可視のまま残る
- `SummingMergeTree` 系 artifact は unknown retry で同じ `refresh_id` を再利用しない
- final completed manifest insert の結果が timeout / connection lost で不明な場合は、同じ `refresh_id` を `argMax(status, tuple(updated_at, status_version))` で再読取する
- 再読取で completed が見えたら成功扱いにする
- 再読取で completed が見えず、かつ再読取自体が成功した場合だけ failed を書く
- 再読取自体が失敗した場合は failed を書かず、running/orphan reconcile 対象として次回 deploy/verify で再照合する
- completed terminal 後に同じ `refresh_id` へ failed を書かない
- overlapping completed を invalidated にする場合、その refresh を `previous_refresh_id` lineage に含む descendant refresh もすべて invalidated にする

失敗時。

- run を `failed` にする
- watermark は進めない
- failed / running / snapshot_written run は、completed manifest がなければ次回 dedupe の反映済み判定に使わない
- failed / running / snapshot_written run の stage / delta / seen log / snapshot row は残っても、completed manifest に join されないため API と次回 dedupe から見えない
- API は最後の completed snapshot を読み続ける
- 旧 full refresh timer は戻さない
- deploy script は非0終了する

manifest の latest completed / stale running / invalidation / retry 再読取は、すべて `argMax(..., tuple(updated_at, status_version))` に固定する。
`FINAL` 直読みや `WHERE status = 'completed' ORDER BY completed_at DESC` は禁止する。
invalidation row の `status_version` は対象 refresh_id の既存最大 `status_version` より大きい値にする。

## API

`collection_count_view` は latest completed `collection_count_snapshot` を読む。  
raw `collection_events` を直接読まない。

`collection_stats` もこの spec の対象に含める。  
単一 collection 指定でも raw `collection_events` 集計を避け、latest snapshot / compact read model から返す。  
既存の response shape と cache 挙動は維持する。

実装条件。

- `collection_count_view` は API 用 latest completed CTE で選んだ `refresh_id` の `collection_count_snapshot` だけを読む
- `collection_stats` は API 用 latest completed CTE と completed compact state から返し、raw `collection_events` を読まない
- `collection_cumulative_users` は selected collection の latest valid daily artifact を `collection_count_cumulative_users_snapshot` から最大365行だけ読み、requested window / bucket への集約は API 層で行う
- `collection_cumulative_users` は raw `collection_events` と first-seen state 全体を request-time に読まない
- 3 endpoint とも `WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1` を使わない
- fallback は最後の valid completed snapshot がない場合だけに限定し、通常成功時は `X-Data-Source: clickhouse` を返す
- valid completed snapshot が存在するが freshness SLA を超える場合は、既存互換として `X-Fallback-Reason: stale_snapshot` と snapshot age headers を維持する。レスポンス body は最後の valid completed snapshot を返す

API response contract。

- `GET /api/analytics/collection_count_view`
  - body: array of `{ collection, count, recent_count, min, max }`
  - `count` / `recent_count` are numbers
  - `min` / `max` are PostgREST-compatible timestamp strings or null
  - optional `collection=eq.<name>` filter keeps the same one-row array shape
- `GET /api/analytics/collection_stats?collection=<name>`
  - body: array of `{ collection, unique_did, min_createdat, max_createdat, unique_rkey, total_count }`
  - timestamp fields are PostgREST-compatible timestamp strings or null
- `GET /api/analytics/collection_cumulative_users?collection=<name>&days=<n>&bucket_days=<n>`
  - body: `{ collection, parameters: { days, bucket_days }, rows, cache }`
  - `rows`: array of `{ date, day_offset, new, cumulative }`
  - `cache`: `{ status, key, ttl_seconds }`
- success headers for collection count endpoints:
  - `X-Data-Source: clickhouse`
  - `X-Fallback-Reason: ''` unless stale or fallback is used
  - `X-Snapshot-Refresh-Id`
  - `X-Snapshot-Refreshed-At`
  - `X-Snapshot-Age-Seconds`
- stale valid snapshot keeps body from latest valid snapshot and sets `X-Fallback-Reason: stale_snapshot`
- unavailable/fallback failure keeps existing non-200/error behavior and must not mask absence of a valid completed snapshot as success

`collection_cumulative_users` 互換のため、`collection_count_did_first_seen_state` と `collection_count_cumulative_users_snapshot` は completed manifest 前に書く。  
`collection_count_refresh_manifest_v2` だけ completed になり、対応する first-seen state / cumulative users snapshot marker がない状態を成功扱いにしない。

`collection_count_did_first_seen_state` は previous completed state + current delta から増分更新する。  
raw `collection_events` または全 historical event log を定期経路で `GROUP BY collection, did` しない。

API SQL 例。

```sql
-- collection_stats
WITH latest AS (<API 用 latest completed CTE>)
SELECT
  collection,
  total_count,
  unique_did,
  unique_rkey,
  min_created_at AS min_createdat,
  max_created_at AS max_createdat,
  refreshed_at
FROM atp_dashboard.collection_count_snapshot
WHERE refresh_id = (SELECT refresh_id FROM latest)
  AND collection = {collection:String}

-- collection_cumulative_users
WITH latest AS (<API 用 latest completed CTE>)
SELECT
  day AS date,
  dateDiff('day', {from:Date}, day) AS day_offset,
  new_users AS new,
  cumulative_users AS cumulative
FROM atp_dashboard.collection_count_cumulative_users_snapshot
WHERE refresh_id = (SELECT refresh_id FROM latest)
  AND collection = {collection:String}
  AND day >= {from:Date}
  AND day < {to:Date}
ORDER BY day
```

`collection_cumulative_users_snapshot` は collection/day 単位の artifact とし、API は selected collection の最新 valid daily row set だけを読む。全 collection の全 window/bucket rows を毎 refresh copy-forward しない。
HTTP response shape は既存互換にし、API 内で `bucket_days` ごとの `date`, `day_offset`, `new`, `cumulative` に整形する。

## systemd

追加する。

- `CollectionCountIncrementalRefresh.service`
- `CollectionCountIncrementalRefresh.timer`

timer 設定。

- `OnCalendar=*:08/10`
- `Persistent=false`

service 設定。

- `flock -n /run/atpdashboard-collection-count-incremental.lock` で多重起動を防ぐ
- deploy CLI / manual CLI も同じ lock を使う
- ClickHouse settings を明示する
  - `max_threads=1`
  - `max_insert_threads=1`
  - `max_memory_usage` を固定
  - progress header を有効化する
- 1回の実行で watermark 以降だけを読む
- 1回の実行で読む対象は `collection_count_ingest_queue` に限定する

## production scripts

### `scripts/stabilize_collection_count_load.sh`

追加する。

やること。

- 実行前に最終状態と表示影響を表示する
  - disabled/inactive: `CollectionCountReadModelRefresh.timer/service`, `CollectionCountRefresh.timer/service`
  - enabled/active: `CollectionEventsSync.timer`, `CollectionEventsRescan.timer`
  - API: latest completed snapshot を返し、旧 full refresh は再開しない
- `CollectionCountReadModelRefresh.timer/service` を stop/disable
- `CollectionCountRefresh.timer/service` を stop/disable
- `CollectionEventsSync.timer` を enable/active に保つ
- `CollectionEventsRescan.timer` を enable/active に保つ
- systemd failed unit を確認
- API 応答を確認
- timer と service の最終状態を machine-check する

### `scripts/deploy_collection_count_incremental_read_model.sh`

追加する。

やること。

1. 最終状態と表示影響を先に表示
2. 旧 full refresh timer / service を stop/disable し、disabled/inactive を検証
3. DDL 適用
4. systemd unit install
5. dual-write 対応済み Sync/Rescan を反映
6. 初回 queue backfill / catch-up / repair
7. snapshot publish
8. API restart
9. ClickHouse 検証
10. local API 検証
11. public API 検証
12. failed unit 検証
13. 新 incremental timer enable
14. timer 最終状態検証

trap/finalizer を持つ。

- 失敗時も旧 full refresh timer は disabled/inactive に収束させる
- 新 incremental timer は検証成功まで enable しない
- failed run / failed manifest を残す
- 最後に systemd/API/ClickHouse 状態を表示する

### retention

- `collection_count_event_stage`: completed / failed から 7 日後に削除可能
- `collection_count_incremental_runs`: completed / failed から 30 日後に削除可能
- `collection_count_ingest_queue`: latest completed watermark より古く、かつ repair 検証済みの行は 30 日後に削除可能
- `collection_count_snapshot`: latest completed と直近 rollback 用世代を残す
- `collection_count_event_seen_log`, `collection_count_did_seen_state`, `collection_count_rkey_seen_state`, `collection_count_did_first_seen_state`: Phase1 では削除しない
- `collection_count_recent_hourly_state`: snapshot anchor の 72 complete hours と safety lag より古い hour は 30 日後に削除可能
- `collection_count_cumulative_users_snapshot`: latest completed と直近 rollback 用世代を残す
- `collection_count_collection_delta`, `collection_count_did_delta`, `collection_count_rkey_delta`, `collection_count_did_first_seen_delta`: completed / failed から 30 日後に削除可能

### `scripts/rollback_collection_count_incremental_read_model.sh`

追加する。

やること。

- 新 incremental timer を disable
- API は最後の completed snapshot を維持
- 旧 full refresh timer は戻さない
- rollback 後の API / timer 状態を検証する

## 既存処理の扱い

通常導線から外す。

- `CollectionCountReadModelRefresh.service/timer`
- `CollectionCountRefresh.service/timer`
- `scripts/deploy_collection_count_read_model.sh`

`scripts/deploy_collection_count_read_model.sh` は通常実行時に hard-fail させる。  
少なくとも `CollectionCountReadModelRefresh.timer` を enable する導線を残さない。
shipped `CollectionCountReadModelRefresh.service/timer` と `CollectionCountRefresh.service/timer` は通常 install script の copy 対象から外す。  
legacy unit として残す場合は `Legacy` suffix を付け、通常 timer pattern に一致しない名前にする。

root package script は分ける。

- `refresh:collection-count-incremental`: 新しい定期実行用
- `refresh:collection-count-legacy`: 旧 full refresh を明示的な手動用に隔離
- `refresh:collection-count`: incremental に固定する。旧 full refresh はこの名前から起動できない

更新対象。

- `scripts/stabilize_analytics_load.sh`
  - `CollectionCountReadModelRefresh` も止める
  - `CollectionEventsRescan` を stop/disable 対象から外し、enable/active 側で検証する
- `scripts/deploy_analytics_presence_pipeline.sh`
  - `CollectionCountReadModelRefresh` / `CollectionCountRefresh` を再有効化しないことを検証する
- `scripts/rollback_analytics_presence_pipeline.sh`
  - `CollectionCountReadModelRefresh` / `CollectionCountRefresh` を disabled/inactive に収束させる
- `backfill-collection-events.ts`
  - `collection_events` と同じ対象イベントを `collection_count_ingest_queue` にも書く
- `CollectionEventsSync.service` / `CollectionEventsRescan.service`
  - 継続的に queue が供給されることを検証する

実装ゲート。

- P1 必須: `packages/api/src/collection-count/clickhouse.ts` の `collection_count_view` latest completed 直読みを API 用 latest completed CTE に置換する
- P1 必須: `packages/api/src/collection-count/clickhouse.ts` の `collection_stats` raw `collection_events` 集計を廃止する
- P1 必須: `packages/api/src/collection-count/clickhouse.ts` の `collection_cumulative_users` raw / broad first-seen scan を廃止する
- P1 必須: `scripts/deploy_collection_count_read_model.sh` は通常実行で hard-fail し、旧 full refresh timer を enable できない
- P1 必須: `CollectionCountReadModelRefresh.timer` と `CollectionCountRefresh.timer` は shipped script から enable されない
- P1 必須: root `refresh:collection-count` は新 incremental に固定し、旧 full refresh は `refresh:collection-count-legacy` 以外から起動できない
- P1 必須: `docs/clickhouse-partial-migration-runbook.md` から旧 full refresh 通常導線を外す
- P1 必須: `packages/clickhouse-tools/schedule-notes.md` の collection count timer 記述を incremental timer に更新する
- P1 必須: shipped `CollectionCountReadModelRefresh.service/timer` と `CollectionCountRefresh.service/timer` は legacy 明示名に移すか、通常 install 対象から外す
- P1 必須ゲートが未完了の場合、deploy script は release blocker として非0終了する

触らない。

- `collection_events` の engine
- raw `collection_events` の物理重複削除
- analytics chart pipeline 全体
- frontend UI

## 検証

### Unit

- 増分処理が複合 watermark 以降だけを読む
- 増分処理が定期経路で `collection_events` を直接読まない
- `collection_count_ingest_queue` が `(queued_at, event_key, queue_seq)` で読める
- `source_ingested_at` を watermark に使わない
- 同じ `ingested_at` の複数行を取りこぼさない
- duplicate `event_key` が二重加算されない
- 同じ DID が別 watermark window に出ても `unique_did` が二重加算されない
- 同じ `(collection, did, rkey)` が別 watermark window に出ても `unique_rkey` が二重加算されない
- `recent_count` が snapshot anchor 基準の complete hour から計算される
- null `created_at` は recent window から除外される
- late-ingested recent event が反映される
- late-ingested old event が recent window に混ざらない
- snapshot publish 成功前に watermark が進まない
- snapshot publish 前検証で `collection_count_snapshot.unique_did` が completed did-seen state の collection 別件数と一致する
- snapshot publish 前検証で `collection_count_snapshot.unique_rkey` が completed rkey-seen state の collection 別件数と一致する
- snapshot publish 前検証で `collection_count_snapshot.recent_count` が 72 complete hours の hourly state 合計と一致する
- snapshot publish 前検証で current run の new visible event 数が `collection_count_event_seen_log` の `uniqExact(event_key)` と一致する
- seen log 欠落 completed は valid completed として扱われない
- conflict table の row count と `event_conflict_row_count` が一致する
- snapshot publish 前検証で first-seen / did-seen / rkey-seen / hourly state の written marker と row count が 0 件でも artifact 未作成と区別できる
- failed manifest が completed として扱われない
- latest completed manifest の判定が `argMax(..., tuple(updated_at, status_version))` 固定である
- stale running 判定が `argMax(..., tuple(updated_at, status_version))` 固定である
- completed manifest insert 後に別テーブル更新が不要である
- partial failure 後の retry で欠損も二重加算も起きない
- retry は常に新しい `run_id` / `refresh_id` を使う

### Failure injection

- stage 作成後に失敗して retry
- seen log 書き込み後に失敗して retry
- delta 書き込み後に失敗して retry
- snapshot publish 前に失敗して retry
- snapshot publish 後、completed manifest insert 前に失敗して retry
- completed manifest insert 後にプロセスが落ちても追加 catch-up なしで API が最新 snapshot を読める
- duplicate `event_key` の conflicting payload は conflict table に記録され、stage から除外される
- duplicate `event_key` が同一 `queued_at` で複数 queue insert されても、`queue_seq` により全物理行が処理対象になる
- API 用 latest completed CTE 以外の raw completed status 直読みが残らない

どのケースでも latest completed snapshot は壊れず、retry 後に同じ論理結果になる。

### ClickHouse integration

- duplicate / replay / late event を含む fixture で、増分結果が期待値になる
- 初回 catch-up 後に `collection_count_snapshot` が空でない
- `collection_count_snapshot` に collection 重複行がない
- raw `collection_events` に対する full refresh query を使わない
- 定期増分 query が `collection_count_ingest_queue` を読む
- `collection_stats` が raw `collection_events` を直接読まない
- `collection_cumulative_users` が raw `collection_events` と broad first-seen state scan をしない
- visible state read が valid completed marker に join される

### Shell

- `bash -n` が通る
- deploy / rollback / stabilize script が最終 timer state を検証する
- shipped script に `enable --now CollectionCountReadModelRefresh.timer` が残っていない
- shipped script に `enable --now CollectionCountRefresh.timer` が残っていない
- `stabilize_analytics_load.sh` が `CollectionEventsRescan.timer` を disable しない

### API

- `collection_count_view` が HTTP 200 を返す
- `collection_stats` が HTTP 200 を返す
- `collection_cumulative_users` が HTTP 200 を返す
- `X-Data-Source: clickhouse`
- fallback reason が空
- response shape が既存互換

### Deploy Verify

- final completed insert 前に linear commit guard が成功する
- overlapping completed refresh が存在しない
- invalidated refresh とその descendants が `valid_completed_all` から除外される
- `collection_count_recent_hourly_state` の recent publish query が `EXPLAIN indexes=1` で hour range による index pruning を使う
- 初回 backfill queue の rows が lower bound なし初回 run に含まれる
- queue missing と queue orphan が 0 である
- normal refresh batch 内の orphan queue が 0 である。orphan がある run は failed で watermark が進まない
- docs/runbook/schedule-notes に旧 full refresh 通常導線が残っていない

## 失敗時の扱い

- 旧 full refresh timer は戻さない
- API は最後の completed snapshot を返す
- watermark は進めない
- failed manifest / failed run を残す
- deploy script は非0で終了する

## 表示影響

`collection_count_view` の項目と JSON 形状は変えない。  
`total_count`, `unique_did`, `unique_rkey`, `min_created_at`, `max_created_at` は論理イベント単位で維持する。  
`recent_count` は snapshot anchor 基準の直近 72 complete hours になるため、最大で約 1 時間分の境界差が出る可能性がある。
