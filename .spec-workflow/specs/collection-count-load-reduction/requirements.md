# Requirements: collection-count-load-reduction

## 目的

`collection_count_view` と analytics 周辺の refresh 処理で発生している CPU/RAM spike を止める。

特に、10分ごとに `collection_events` 全量を読み直して `GROUP BY event_key` / `GROUP BY collection` する処理を定期経路からなくす。

## 現状の問題

- `CollectionCountReadModelRefresh.timer` は `refresh:collection-count` を10分ごとに実行している。
- `refresh:collection-count` は `collection_events` 全量を再集計して `collection_count_snapshot` を作り直している。
- `--recent-hours 72` は `recent_count` の条件に使われるだけで、全量 scan 自体を狭めていない。
- `CollectionCountRefresh.timer` は旧 refresh timer で、同じ重い処理を再有効化する危険がある。
- `deploy_collection_count_read_model.sh` は過去の試行錯誤で作った timer を再有効化するため、現状では危険。
- `stabilize_analytics_load.sh` は `CollectionCountReadModelRefresh.timer` を止めていないため、今の負荷源を取り逃がす。
- `collection_count_view` の API read path は snapshot を読む形になっているが、snapshot を作る処理が重い。

## 要件

### 1. 即時の止血

- `CollectionCountReadModelRefresh.timer` と `CollectionCountReadModelRefresh.service` を停止・無効化する。
- `CollectionCountRefresh.timer` と `CollectionCountRefresh.service` も停止・無効化を維持する。
- `CollectionEventsSync.timer` は有効のまま維持する。
- `CollectionEventsRescan.timer` は有効のまま維持する。
- 旧 full refresh を自動復旧や rollback で再有効化しない。
- 止血スクリプトは実行前に最終状態を表示し、実行後に timer / failed unit / API 応答を検証する。

### 2. API 互換性

- `collection_count_view` のレスポンス形状は維持する。
- API は引き続き latest completed `collection_count_snapshot` を読む。
- snapshot が古い場合でも、既存の stale/fallback header 方針を維持する。
- フロントエンドの表示ロジック変更を必須にしない。

### 3. 全量 refresh の廃止

- 定期実行経路から raw `collection_events` 全量 `GROUP BY event_key` をなくす。
- `refresh:collection-count` をそのまま定期実行しない。
- timer 頻度を落とすだけの対応を恒久策にしない。
- raw `collection_events` の物理削除、engine 変更、`OPTIMIZE FINAL` 依存は行わない。

### 4. 増分 read model

- 定期経路は `collection_events` を `ingested_at` 条件で直接 scan しない。
- 増分処理は `collection_count_ingest_queue` の `(queued_at, event_key, queue_seq)` の複合 watermark で読む。
- `source_ingested_at` は診断・照合用に保持するが、定期処理の watermark には使わない。
- `event_key` を論理イベントIDとして扱い、同じイベントを二重加算しない。
- collection 単位で以下を保持できる。
  - `total_count`
  - `unique_did`
  - `unique_rkey`
  - `min_created_at`
  - `max_created_at`
- `recent_count` は全量再集計ではなく、collection x hour の rollup から直近72時間分を合成する。
- watermark は read model 更新と snapshot publish の検証が成功した後だけ進める。
- 途中失敗しても、次回実行で欠損や二重計上を起こさない。

### 5. snapshot publish

- API 公開契約として `collection_count_snapshot` は維持する。
- 既存名 `collection_count_refresh_manifest` は compatibility view として維持し、新しい commit marker は append-only の `collection_count_refresh_manifest_v2` にする。
- snapshot は増分 read model から生成する。
- snapshot publish は検証が通った場合だけ completed manifest を作る。
- 不完全な snapshot を API が読む状態にしない。
- completed manifest v2 は commit marker として `run_id`, queue watermark, cutoff, snapshot anchor, validation marker を保持する。

### 6. timer 整理

- 最終的に有効な timer は以下に限定する。
  - `CollectionEventsSync.timer`
  - `CollectionEventsRescan.timer`
  - 新しい軽量な `CollectionCountIncrementalRefresh.timer`
- 以下は無効化を維持する。
  - `CollectionCountReadModelRefresh.timer`
  - `CollectionCountRefresh.timer`
- `AnalyticsPresencePipeline.timer` など analytics 系 timer は、この spec では不用意に再有効化しない。
- 既存 deploy / rollback / stabilize scripts が古い timer を再有効化しないようにする。

### 7. production script

- 本番で叩く入口は一発スクリプトにする。
- スクリプト内で以下を行う。
  - DDL 適用
  - 初回 backfill / catch-up
  - snapshot publish
  - API restart
  - timer 切替
  - ClickHouse 検証
  - local/public API 検証
  - failed unit 検証
  - 旧 full refresh timer が無効であることの検証
- ユーザーに個別 SQL、個別 systemctl、個別 curl を何度も打たせない。
- 失敗しても旧 full refresh timer は再有効化しない。

### 8. legacy 整理

- `deploy_collection_count_read_model.sh` は今後の通常導線から外す。
- `stabilize_analytics_load.sh` は `CollectionCountReadModelRefresh` も止めるように更新する。
- `CollectionCountReadModelRefresh.service/timer` と `CollectionCountRefresh.service/timer` は legacy として扱う。
- analytics daily/hourly rollup 系テーブルは即 DROP せず、参照がなくなったことを確認してから別途整理する。

## 受け入れ条件

- `CollectionCountReadModelRefresh.timer` が disabled / inactive である。
- `CollectionCountRefresh.timer` が disabled / inactive である。
- `CollectionEventsSync.timer` が enabled / active である。
- `CollectionEventsRescan.timer` が enabled / active である。
- 新しい refresh は raw `collection_events` 全量 `GROUP BY event_key` を定期実行しない。
- duplicate `event_key` があっても `total_count` が二重計上されない。
- `recent_count` が hourly rollup から計算される。
- `collection_cumulative_users` は selected collection の最大365 daily rows だけを読み、raw event / broad first-seen scan をしない。
- watermark が成功時だけ進む。
- `collection_count_view` が HTTP 200 を返し、既存レスポンス形状を維持する。
- local/public API 検証、timer 検証、failed unit 検証が deploy script 内で完結する。
- CPU/RAM の10分周期 spike が解消または大幅に低減する。

## 対象外

- raw `collection_events` の物理重複削除。
- `collection_events` の engine 変更。
- `OPTIMIZE FINAL` による恒久対策。
- analytics chart pipeline 全体の再設計。
- UI デザイン変更。
