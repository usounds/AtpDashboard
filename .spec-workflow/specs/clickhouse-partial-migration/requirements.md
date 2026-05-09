# 要件定義書

## Introduction

AtpDashboard の `collection` 系集計は、Postgres 上の大規模テーブルに対する集計ビューを Web ダッシュボードから直接参照しているため、データ増加に伴って応答時間とDB負荷が悪化しやすい。特に `collection_count_view` は `collection` 全体を `collection` 単位で集計し、メインのコレクション一覧表示に使われている。

本機能では、Postgres を source of truth として維持しながら、重い分析系readの一部を ClickHouse に段階的に移行する。第一弾の対象は `collection_count_view` とし、既存フロントエンドへの影響を最小化しつつ、性能改善・検証・切り戻しができる状態を作る。

## Alignment with Product Vision

現時点で `.spec-workflow/steering/product.md` は存在しないため、既存READMEと現在のプロダクト用途に基づく。AtpDashboard は ATProto Firehose に流れる 3rd party collection を可視化するダッシュボードであり、利用者にとって一覧・集計・推移が安定して見られることが価値になる。

この要件は以下に貢献する。

- 大規模化した `collection` データに対して、ダッシュボードの主要一覧を安定して提供する
- Postgres の既存運用を壊さず、リスクを限定して分析基盤を拡張する
- endpoint 単位の段階移行により、今後の `collection_daily_summary_view` や `did_count_view` などの移行判断をしやすくする

## Requirements

### Requirement 1: Postgres を正本として維持する

**User Story:** 運用者として、既存Postgresを正本として維持したい。そうすることで、全面移行による停止・データ不整合・ロールバック困難を避けながら、重いreadだけを改善できる。

#### Acceptance Criteria

1. WHEN ClickHouse 部分移行を導入する THEN システム SHALL Postgres の `collection` を source of truth として扱う
2. IF ClickHouse 側の同期またはAPIに障害が発生した THEN システム SHALL 既存Postgres/PostgREST経路へ切り戻せる
3. WHEN 第一弾を実装する THEN システム SHALL Postgres の既存テーブル、既存Materialized View、既存トリガーの挙動を破壊しない
4. WHEN ClickHouse にデータを投入する THEN システム SHALL Postgres の `collection` から導出可能なデータのみを保持する

### Requirement 2: `collection_count_view` を第一弾の移行対象にする

**User Story:** ダッシュボード利用者として、メインのコレクション一覧をより安定して速く表示したい。そうすることで、データ量が増えても主要画面を待たずに使える。

#### Acceptance Criteria

1. WHEN 第一弾のClickHouse read modelを作成する THEN システム SHALL `collection_count_view` 相当のデータを返せる
2. WHEN APIが `collection_count_view` 相当のレスポンスを返す THEN システム SHALL `collection`, `count`, `recent_count`, `min`, `max` を含める
3. WHEN フロントエンドがコレクション一覧を取得する THEN システム SHALL 既存UIの表示に必要なレスポンス形状を維持する
4. IF ClickHouse版の結果検証が未完了である THEN システム SHALL 他のPostgREST endpointをClickHouseへ移行しない
5. IF `event_logs_summary` の移行を検討する THEN システム SHALL `collection_count_view` の安定稼働後に別フェーズとして扱う

### Requirement 3: ClickHouse read model を用意する

**User Story:** 開発者として、Postgresの重い集計をClickHouseで再現できるread modelが欲しい。そうすることで、Postgresに全表集計を実行させずにダッシュボード向けレスポンスを返せる。

#### Acceptance Criteria

1. WHEN ClickHouse スキーマを作成する THEN システム SHALL `collection` の `did`, `collection`, `rkey`, `createdAt` 相当を保持できる
2. WHEN `collection_count_view` 相当の集計を作る THEN システム SHALL collection単位の総件数、直近72時間件数、最古日時、最新日時を算出できる
3. WHEN 集計結果をAPIから読む THEN システム SHALL ClickHouseの内部列名に依存せず、PostgREST互換のフィールド名で返せる
4. IF 集計方式を変更する THEN システム SHALL raw相当データまたはPostgres正本から再構築できる

### Requirement 4: バックフィルと差分同期を安全に行う

**User Story:** 運用者として、大きな `collection` テーブルを安全にClickHouseへ同期したい。そうすることで、長時間処理や失敗が起きても再開・検証・切り戻しができる。

#### Acceptance Criteria

1. WHEN 初回バックフィルを実行する THEN システム SHALL 途中失敗後に再開できる方式を提供する
2. WHEN バックフィル対象を読み出す THEN システム SHALL Postgresへの過度な負荷を避けるため、バッチ単位で処理できる
3. WHEN 差分同期を実行する THEN システム SHALL 最終同期位置を記録できる
4. IF 同期遅延が発生する THEN システム SHALL `recent_count` の鮮度影響を検知または説明できる
5. WHEN 本番切替前の検証を行う THEN システム SHALL Postgres版とClickHouse版の件数・上位collection・min/max・recent_countを比較できる

### Requirement 5: API層でClickHouseを隠蔽する

**User Story:** 開発者として、フロントエンドからClickHouseを直接呼ばせたくない。そうすることで、認証情報漏洩、SQL露出、移行中の切替複雑化を避けられる。

#### Acceptance Criteria

1. WHEN フロントエンドが移行済みendpointを呼ぶ THEN システム SHALL ClickHouseに直接接続せずAPI層を経由する
2. WHEN API層が `collection_count_view` 相当を返す THEN システム SHALL 既存PostgRESTレスポンスと互換性のあるJSON配列を返す
3. IF ClickHouse接続に失敗する THEN API層 SHALL 既存PostgREST endpointへのフォールバックまたは明示的エラーを提供する
4. WHEN API層を実装する THEN システム SHALL ClickHouse接続情報をクライアントバンドルに含めない

### Requirement 6: フロントエンド変更を最小化し、即時切り戻し可能にする

**User Story:** 開発者として、既存UIを大きく変えずにClickHouse版endpointへ切り替えたい。そうすることで、表示ロジックの変更とDB移行の問題を切り分けられる。

#### Acceptance Criteria

1. WHEN コレクション一覧の取得先を変更する THEN システム SHALL `packages/frontend/src/zustand/collectionStore.ts` の取得URLを設定で切り替えられる
2. IF 新APIに問題がある THEN 運用者 SHALL デプロイなし、または最小変更で既存 `https://collectiondata.usounds.work/collection_count_view` へ戻せる
3. WHEN ClickHouse版とPostgres版のレスポンス形状が同じである THEN フロントエンド SHALL 既存の表示ロジックを維持できる
4. WHEN 移行を行う THEN システム SHALL UIデザインやページ構成の変更を必須にしない

### Requirement 7: 観測と検証を移行条件に含める

**User Story:** 運用者として、移行前後の性能と結果差分を把握したい。そうすることで、体感ではなく実測に基づいて切替判断ができる。

#### Acceptance Criteria

1. WHEN 移行前のベースラインを取る THEN システム SHALL 既存Postgres版 `collection_count_view` の応答時間、件数、ペイロードサイズを記録できる
2. WHEN ClickHouse版を検証する THEN システム SHALL Postgres版との結果差分を比較できる
3. IF `pg_stat_statements` が未導入である THEN システム SHALL `toolkit-postgres` の統計、API応答時間、限定的なSQL検証など代替手段で観測できる
4. WHEN 本番切替判断を行う THEN システム SHALL 少なくとも24時間相当の同期・結果比較を確認できる

### Requirement 8: `collection_count_view` 互換契約を明確にする

**User Story:** 開発者として、ClickHouse版 `collection_count_view` が既存PostgREST版と同じ契約で振る舞ってほしい。そうすることで、速くなっても数字・並び順・型が変わる事故を防げる。

#### Acceptance Criteria

1. WHEN ClickHouse版 `collection_count_view` 相当APIが集計する THEN システム SHALL `did:web:lexicon.store` を既存Postgres viewと同様に除外する
2. WHEN APIがレスポンスを返す THEN システム SHALL `collection`, `count`, `recent_count`, `min`, `max` の5項目を返す
3. WHEN APIがレスポンスを返す THEN システム SHALL `max` の降順で結果を返す
4. WHEN APIが日時を返す THEN システム SHALL タイムゾーンと文字列表現を既存フロントエンドが解釈できる形式に統一する
5. WHEN APIが数値を返す THEN システム SHALL `count` と `recent_count` を欠損させず、0件の場合は0として返す
6. IF ClickHouse版とPostgres版で `collection`, `count`, `min`, `max` が一致しない THEN システム SHALL 本番切替を行わない

### Requirement 9: 同期正当性と idempotency を保証する

**User Story:** 運用者として、バックフィルや差分同期を何度実行しても欠損や二重計上を起こしたくない。そうすることで、大量データ移行中でも安心して再実行・復旧できる。

#### Acceptance Criteria

1. WHEN PostgresからClickHouseへ同期する THEN システム SHALL `(did, collection, rkey, createdAt)` 相当の複合キーで同一イベントを識別できる
2. WHEN 同期処理を再実行する THEN システム SHALL 同一イベントの二重投入が `collection_count_view` 相当の集計値を二重計上しない
3. WHEN 差分同期のwatermarkを保存する THEN システム SHALL 同一 `createdAt` の複数行を取りこぼさない複合watermarkまたは同等の方式を使う
4. IF 遅延到着データが発生する THEN システム SHALL 許容遅延窓内の再同期または補正処理でClickHouse側へ反映できる
5. WHEN 同期処理が途中失敗する THEN システム SHALL 最後に確定した同期位置から安全に再開できる
6. IF Postgres側で削除または修正が必要になった場合 THEN システム SHALL ClickHouse側の補正方針を明示し、少なくとも再バックフィルで復旧できる

### Requirement 10: データ鮮度・SLO・Go/No-Go条件を定義する

**User Story:** 運用者として、ClickHouse版へ切り替えてよいかを定量的に判断したい。そうすることで、主観や雰囲気ではなく、性能・鮮度・正確性に基づいて移行判断できる。

#### Acceptance Criteria

1. WHEN ClickHouse版APIを評価する THEN システム SHALL p95応答時間の目標値を定義し、測定できる
2. WHEN 同期状態を評価する THEN システム SHALL 許容同期遅延を定義し、最終同期時刻または同等の鮮度情報を確認できる
3. WHEN `recent_count` を検証する THEN システム SHALL snapshot時刻またはAPI実行時刻を基準として比較条件を固定できる
4. WHEN 本番切替判断を行う THEN システム SHALL `collection`, `count`, `min`, `max` の差分が許容条件内であることを確認する
5. IF p95応答時間、同期遅延、結果差分、エラー率のいずれかがGo条件を満たさない THEN システム SHALL ClickHouse版を本番既定経路にしない
6. WHEN Go/No-Go判断を記録する THEN システム SHALL 判断日時、比較対象、主要メトリクス、判断理由を残せる

### Requirement 11: 運用ランブックとフォールバック条件を用意する

**User Story:** 運用者として、障害や数字のズレが起きたときに迷わず対応したい。そうすることで、主要画面の停止時間を短くし、利用者への影響を抑えられる。

#### Acceptance Criteria

1. WHEN ClickHouse版APIに障害が発生する THEN システム SHALL 既存PostgREST版 `collection_count_view` へフォールバックできる
2. WHEN フォールバックを発動する THEN システム SHALL 発動条件、確認項目、復旧手順をランブックとして参照できる
3. WHEN API層がClickHouseへ接続する THEN システム SHALL タイムアウト、リトライ回数、フォールバック優先順位を定義する
4. IF フォールバック中または同期遅延中である THEN システム SHALL 運用者が状態を確認できる
5. IF 利用者に古いデータが表示される可能性がある THEN システム SHALL UIまたは運用上の告知で最終更新時刻や遅延状態を説明できる
6. WHEN 障害対応が完了する THEN システム SHALL 原因、影響範囲、復旧手順、再発防止を記録できる

### Requirement 12: MVP範囲・コスト上限・撤退条件を明確にする

**User Story:** プロジェクト責任者として、ClickHouse導入を小さく始め、費用や工数が膨らむ前に継続判断したい。そうすることで、安全だが終わらない移行を避けられる。

#### Acceptance Criteria

1. WHEN MVPを開始する THEN システム SHALL 対象endpointを `collection_count_view` のみに限定する
2. WHEN MVPを実装する THEN システム SHALL 読み取り専用API、バックフィル、Postgres比較、設定切替を最小スコープとして扱う
3. IF 完全自動のリアルタイム差分同期がMVP完了を遅らせる THEN システム SHALL それを次フェーズへ分離できる
4. WHEN ClickHouse運用を評価する THEN システム SHALL 月額費用、保存容量、バックフィル所要時間、同期処理時間の見積もりまたは実測を記録できる
5. IF コスト、実装期間、運用負荷、正確性のいずれかが事前に定めた上限を超える THEN システム SHALL Postgres継続または別案へ撤退できる
6. WHEN MVPが成功した THEN システム SHALL 次の候補endpointを別フェーズとして評価し、無条件に全面移行へ進まない

### Requirement 13: MCPでAI向け分析サマリを提供する

**User Story:** 運用者として、今週の新規NSID、イベント数が多いNSID、ユーザー推移、コレクション推移をAIクライアントから取得したい。そうすることで、ダッシュボード画面とは別に、週次分析や状況把握を自然言語ワークフローへ渡せる。

#### Acceptance Criteria

1. WHEN MCP clientが今週の新規NSIDを要求する THEN システム SHALL 今週初めて観測されたNSID/collectionの一覧を返せる
2. WHEN MCP clientがイベント数上位NSIDを要求する THEN システム SHALL 指定期間のevent数上位NSID/collectionを返せる
3. WHEN MCP clientがユーザー推移を要求する THEN システム SHALL ClickHouseへ移行済みのread modelで算出可能な範囲に限り、今週の日次ユーザー数またはunique DID推移を返せる
4. WHEN MCP clientがcollection推移を要求する THEN システム SHALL ClickHouseへ移行済みのread modelで算出可能な範囲に限り、今週の日次collection/event推移を返せる
5. WHEN MCP toolがデータを返す THEN システム SHALL 任意SQL実行ではなく、定義済みread-only toolとして提供する
6. IF MCP endpointを公開する THEN システム SHALL Cloudflare Access等で管理者/開発者向けに制限し、公開ダッシュボードAPIとはrouteを分離する
7. IF 必要なviewまたは日次bucketがClickHouseへ未移行である THEN システム SHALL MVPではそのMCP toolを未提供またはnot_implementedとして扱い、追加移行を暗黙に要求しない

## Non-Functional Requirements

### Code Architecture and Modularity

- **Single Responsibility Principle**: ClickHouse DDL、同期処理、API層、フロントエンド切替はそれぞれ責務を分ける
- **Modular Design**: 第一弾の `collection_count_view` 移行を、次のendpoint移行へ再利用できる形にする
- **Dependency Management**: ClickHouse依存はAPI層・同期処理に閉じ込め、React UIへ漏らさない
- **Clear Interfaces**: APIレスポンスはPostgREST互換の明確な契約を持つ

### Performance

- `collection_count_view` 相当APIは、Postgresの全表集計ビューより低負荷かつ安定した応答を目指す
- ClickHouse側集計は `collection` 5900万行級のデータ増加を前提に設計する
- 差分同期とsnapshot更新は、Postgres本番DBに過度な負荷を与えないバッチ処理とする

### Security

- ClickHouse接続情報、認証情報、SQL実行権限をブラウザへ公開しない
- API層は必要最小限のqueryのみを実行し、任意SQL実行口にしない
- 既存の `readonly_user` / PostgREST 公開範囲を不用意に広げない

### Reliability

- Postgres経路への切り戻しを常に維持する
- バックフィルと差分同期は再実行・再開可能にする
- ClickHouse側のデータ不整合を検出するため、Postgres版との比較手順を持つ
- ClickHouse障害時に主要画面が完全停止しないよう、フォールバック方針を持つ

### Usability

- ダッシュボード利用者から見えるUIや操作方法を変えない
- コレクション一覧の表示項目、並び順、数値形式を既存と互換にする
- 移行中も既存URLまたは設定による切替で段階的に確認できる
