# Tasks Document

- [x] 0. MVP開始前のBaselineとStop/Continue条件を固定する
  - File: `docs/clickhouse-partial-migration-baseline.md`
  - 現行PostgREST `collection_count_view` の応答時間、payload size、可能な範囲のread loadを記録する
  - ClickHouse用VM/ストレージ/バックアップ/監視/運用時間の追加コスト見積もりを記録する
  - 3営業日のMVP Demo予算、月額5,000円相当の追加運用コスト上限、Stop/Continue条件を明文化する
  - Production Default Gateに必要な24時間観測項目を先に定義する
  - `public.collection` がappend-onlyとして扱えるか、削除/更新があり得るかを実DDL・運用前提・差分比較で確認する
  - append-onlyとして扱えない場合は、全量reconciliation、tombstone、update handlingのいずれかをMVP Demo前に実装しない限り `Stop` とする
  - 判断結果は `Stop`, `Continue Demo Only`, `Continue Toward Production Gate` のいずれかに固定し、owner/dateを記録する
  - _Leverage: `.spec-workflow/specs/clickhouse-partial-migration/design.md`, `.spec-workflow/specs/clickhouse-partial-migration/requirements.md`_
  - _Requirements: 7.1, 10.1, 10.5, 10.6, 12.4, 12.5_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Release Engineer | Task: Create the baseline and Stop/Continue gate document before implementation starts, covering current PostgREST performance/load, ClickHouse cost estimate, source mutability, 3-business-day MVP Demo budget, 24h Production Default evidence, and No-Go thresholds | Restrictions: Do not implement code in this task; do not assume ClickHouse Cloud; include resource/ops cost even when using OSS ClickHouse | _Leverage: design.md and requirements.md | _Requirements: 7.1, 10.1, 10.5, 10.6, 12.4, 12.5 | Success: Baseline document gives a clear owner-signed Stop/Continue decision before deeper implementation work_

- [x] 1. ClickHouse/Postgres DDLを追加する
  - File: `sql/clickhouse/001_collection_events.sql`
  - File: `sql/clickhouse/002_collection_count_snapshot.sql`
  - File: `sql/clickhouse/003_collection_count_refresh.sql`
  - File: `sql/postgres/clickhouse/sync_state.sql`
  - File: `sql/README.md`
  - `collection_events`, `collection_count_snapshot`, `collection_count_refresh_manifest` を作成する
  - Postgres側に `clickhouse_sync_checkpoints`, `clickhouse_sync_locks` を作成する
  - snapshot retention方針と保存容量測定queryを含める
  - event retentionはMVPでは削除しない方針を明記し、削除/TTLはowner承認事項にする
  - _Leverage: `sql/postgres/view/collection_count_view.sql`, design.md_
  - _Requirements: 1.1, 1.3, 3.1, 3.2, 4.3, 8.1, 9.1, 9.3, 12.4_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Database Engineer specializing in PostgreSQL and ClickHouse DDL | Task: Add idempotent ClickHouse and Postgres DDL for the partial migration, including event_key based events, snapshot/manifest tables, Postgres checkpoint/lock tables, snapshot retention, and storage measurement support | Restrictions: Do not start Task 1 until Task 0 has an owner-signed Continue decision; Stop means no ClickHouse DDL/workers/API work; do not modify source Postgres tables or existing views; do not add destructive TTL for raw events without owner approval; do not assume ClickHouse Cloud | _Leverage: design.md and sql/postgres/view/collection_count_view.sql | _Requirements: 1.1, 1.3, 3.1, 3.2, 4.3, 8.1, 9.1, 9.3, 12.4 | Success: DDL is idempotent, separates analytics from operational state, encodes event_key strategy, and supports cost/retention observation_

- [x] 2. event_key生成と日時正規化ユーティリティを実装する
  - File: `packages/clickhouse-tools/src/event-key.ts`
  - File: `packages/clickhouse-tools/src/event-key.test.ts`
  - `event_key = length-prefixed(did, collection, rkey, created_at_key)` を生成する
  - `"createdAt"` をUTC・microsecond精度の `created_at_key` に正規化する
  - NULLは `'<NULL>'` として扱う
  - delimiter衝突、Unicode、タイムゾーン差、同一入力の安定性をテストする
  - _Leverage: design.md_
  - _Requirements: 3.1, 9.1, 9.2_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript Developer specializing in deterministic data encoding | Task: Implement and test event_key generation and createdAt normalization for ClickHouse ingestion | Restrictions: Do not use ClickHouse-converted timestamps to generate keys; do not use ambiguous delimiter-only concatenation; keep functions deterministic and side-effect free | _Leverage: design.md | _Requirements: 3.1, 9.1, 9.2 | Success: Unit tests prove NULL, timezone, microsecond, unicode/string length, and duplicate input stability behavior_

- [x] 3. Hono APIのserver-side設定とセキュリティ制御を追加する
  - File: `packages/api/src/collection-count/config.ts`
  - File: `packages/api/src/collection-count/server.ts`
  - Hono Node APIを自サーバー上の別プロセスとして起動できる設定を追加する
  - Cloudflare Zero Trustで `/api/analytics/*` をHonoへ分ける前提のroute構造にする
  - server-only環境変数、CORS allowlist、rate limit、timeout、fallback閾値、TLS前提、ClickHouse user分離を設定する
  - Honoは既定で `127.0.0.1` またはprivate interfaceへbindし、Cloudflare Tunnel以外から直接公開しない
  - trusted proxy/forwarded headerの扱いを固定し、信頼できないforwarded headerで状態判定しない
  - fallback reason taxonomyを共有定数として定義する: `stale_snapshot`, `clickhouse_timeout`, `clickhouse_error`, `circuit_open`, `forced_fallback`, `fallback_failed`, `unavailable`
  - _Leverage: `package.json`, existing Vite env usage, design.md_
  - _Requirements: 1.4, 4.2, 5.1, 5.4, 10.1, 10.2, 11.3, 12.4, 13.6_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Backend Infrastructure Developer familiar with Hono and Cloudflare Zero Trust | Task: Add server-side Hono API configuration, route scaffolding, CORS/rate-limit/timeout settings, trusted proxy handling, fallback reason taxonomy, and server-only ClickHouse/Postgres/fallback config | Restrictions: Do not expose secrets through Vite env or client bundle; do not hard-code credentials; bind to loopback/private interface by default; do not implement MCP in MVP; fail fast with safe messages for missing or unsafe env vars | _Leverage: package.json and current env patterns | _Requirements: 1.4, 4.2, 5.1, 5.4, 10.1, 10.2, 11.3, 12.4 | Success: Hono server config is safe, validates required env, avoids direct public exposure, and provides shared fallback reason constants_

- [x] 4. MVP Demo用Backfill workerを実装する
  - File: `packages/clickhouse-tools/src/backfill-collection-events.ts`
  - Postgres `public.collection` を `(createdAt, did, collection, rkey)` 順でbatch取得する
  - `event_key`, `created_at`, `created_at_key` を付与してClickHouseへ投入する
  - MVP Demoではbounded one-shot/resumable importを実装し、production-grade定期同期はTask 8へ分離する
  - checkpoint更新、resume、最小限のPostgres lock、batch insertを実装する
  - `--dry-run`, `--limit`, `--resume-from`, `--batch-size`, `--max-runtime-minutes`, `--max-rows`, `--confirm-production` を実装する
  - NULL `createdAt` のtuple watermark順序、inclusive/exclusive境界、stable serializationを明文化する
  - checkpoint更新前クラッシュ、同一 `createdAt` 境界、NULL境界、重複replayのテストまたはfixtureを追加する
  - Task 0でappend-onlyが確認できない場合は、MVP DemoのGo判定前に全量reconciliation、tombstone、update handlingのいずれかを実装しない限り停止する
  - _Leverage: `packages/clickhouse-tools/src/event-key.ts`, `sql/postgres/clickhouse/sync_state.sql`, design.md_
  - _Requirements: 1.1, 1.4, 3.1, 4.1, 4.2, 4.3, 9.2, 9.3, 9.4, 9.5, 9.6_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Data Pipeline Engineer | Task: Implement the MVP Demo backfill worker with deterministic event_key generation, bounded batching, minimal Postgres lock/checkpoint state, resume support, and safe CLI flags | Restrictions: Do not advance checkpoint before ClickHouse insert succeeds; do not run production writes without --confirm-production; avoid unbounded Postgres reads; do not mutate source Postgres collection data; do not include production-grade scheduled sync in this task | _Leverage: event-key utility, DDL files, design.md | _Requirements: 1.1, 1.4, 3.1, 4.1, 4.2, 4.3, 9.2, 9.3, 9.5, 9.6 | Success: Worker supports dry run/limited/resume runs, prevents double counting through event_key aggregation, and stays within MVP Demo blast-radius limits_

- [x] 5. Snapshot refresh workerを実装する
  - File: `packages/clickhouse-tools/src/refresh-collection-count-snapshot.ts`
  - refresh開始時にmanifestへ `running` を記録する
  - `uniqExact(event_key)` で `total_count`, `recent_count`, `min`, `max` を集計する
  - `did:web:lexicon.store` 除外をfixtureで確認する
  - refresh成功後のみmanifestを `completed` にする
  - 失敗時は `failed` にしてAPIへ公開しない
  - refresh_idは実行ごとにglobally uniqueにし、retry時に同じrefresh_idを不用意に再利用しない
  - orphaned `running` manifestのexpiry/cleanup方針を実装する
  - snapshot insert後・manifest completed前にcrashした場合のretry-safe behaviorをテストする
  - _Leverage: ClickHouse DDL, design.md_
  - _Requirements: 2.1, 2.2, 3.2, 8.1, 8.2, 8.3, 8.5, 9.2, 10.3_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: ClickHouse Analytics Engineer | Task: Implement snapshot refresh using collection_events and refresh_manifest so only completed refreshes are published | Restrictions: Do not expose running or failed refreshes through the API path; do not group in the request path; use event_key for unique counting; preserve did:web:lexicon.store exclusion | _Leverage: ClickHouse DDL and design.md | _Requirements: 2.1, 2.2, 3.2, 8.1, 8.2, 8.3, 8.5, 9.2, 10.3 | Success: Refresh writes a new refresh_id, excludes lexicon.store, publishes only completed snapshots, and leaves previous completed snapshot usable on failure_

- [x] 6. Hono collection_count_view APIを実装する
  - File: `packages/api/src/collection-count/clickhouse.ts`
  - File: `packages/api/src/collection-count/fallback.ts`
  - File: `packages/api/src/collection-count/status.ts`
  - `GET /api/analytics/collection_count_view` をPostgREST互換JSONで返す
  - 最新completed refreshのみを読み、`SNAPSHOT_MAX_AGE_SECONDS` 超過時はfallbackする
  - timeout、circuit breaker、30秒cache、PostgREST fallback、kill switchを実装する
  - stale/fallback状態をstatus endpointとheadersで説明可能にする
  - `X-Data-Source`, `X-Fallback-Reason`, `X-Snapshot-Refresh-Id`, `X-Snapshot-Refreshed-At` を返す
  - ClickHouse staleかつPostgREST fallbackも失敗した場合は、古いClickHouse結果を返さず `503`, `Retry-After`, `X-Data-Source: unavailable`, `X-Fallback-Reason: fallback_failed` を返す
  - 既存PostgRESTレスポンスfixtureを用意し、query string、status code、null/date format、numeric serialization、ordering、必要headersの互換性を確認する
  - _Leverage: design.md, existing PostgREST endpoint_
  - _Requirements: 2.2, 2.3, 5.1, 5.2, 5.3, 5.4, 8.2, 8.3, 8.4, 8.5, 10.1, 10.2, 11.1, 11.3, 11.4, 11.5_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Backend API Engineer specializing in Hono and resilient read APIs | Task: Implement the self-hosted Hono collection_count_view API backed by completed ClickHouse snapshots with stale detection, PostgREST fallback, kill switch, circuit breaker, cache, headers, and status endpoint | Restrictions: Do not expose ClickHouse credentials or arbitrary SQL; do not read running/failed refreshes; FORCE_COLLECTION_COUNT_FALLBACK must override ClickHouse, cache, and circuit breaker | _Leverage: design.md and existing PostgREST endpoint | _Requirements: 2.2, 2.3, 5.1, 5.2, 5.3, 5.4, 8.2, 8.3, 8.4, 8.5, 10.1, 10.2, 11.1, 11.3, 11.4, 11.5 | Success: API returns compatible rows ordered by max desc, falls back on stale/failure/kill switch, exposes operational headers/status, and supports clickhouse-only comparison mode_

- [x] 7. ClickHouse-only比較スクリプトを実装する
  - File: `packages/clickhouse-tools/src/compare-collection-count-view.ts`
  - 既存PostgRESTとClickHouse-backed APIを比較する
  - `--clickhouse-only` では `X-Disable-Fallback: true` を送る
  - `X-Data-Source: clickhouse` でない場合は失敗にする
  - row count、collection set、count、recent_count、min、max、top100、sampleを比較してJSON/Markdown reportを出す
  - _Leverage: `packages/frontend/src/types/collection.ts`, Hono API, design.md_
  - _Requirements: 4.5, 7.1, 7.2, 8.6, 10.4, 10.5, 10.6_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Data Quality Engineer | Task: Implement a comparison script that validates PostgREST collection_count_view against the ClickHouse-backed API and prevents fallback from masking ClickHouse drift | Restrictions: Do not treat fallback responses as ClickHouse pass; do not require UI changes; keep reports deterministic and easy to archive | _Leverage: collection types, Hono API, design.md | _Requirements: 4.5, 7.1, 7.2, 8.6, 10.4, 10.5, 10.6 | Success: Script fails on mismatches or fallback in clickhouse-only mode and writes a report containing metrics, differences, data source headers, and Go/No-Go summary_

- [x] 8. Production Default Gate用の定期実行と24時間観測を追加する
  - File: `packages/clickhouse-tools/schedule-notes.md`
  - File: `docs/clickhouse-partial-migration-production-gate.md`
  - systemd/cron等でsyncとsnapshot refreshを定期実行する手順を定義する
  - refresh cadence、24h overlap-window sync、`--rescan-days 7` の遅延到着再走査、lock acquire/extend/release、fallback固定条件を明記する
  - production-grade同期hardeningとして、lock延長、crash retry、checkpoint boundary、遅延到着replayの追加検証を定義する
  - 24時間のcompare cadence、p95/error/fallback/sync-lag series、timestamped reports、Go/No-Go signer/ownerを記録する
  - compare diffがある場合はProduction DefaultをNo-Goにする
  - このタスクではproduction timer有効化やCloudflare route切替は行わず、別承認前提のcommands/docsだけを作る
  - _Leverage: backfill worker, refresh worker, compare script, design.md_
  - _Requirements: 7.4, 10.1, 10.2, 10.5, 10.6, 11.4, 12.5_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: SRE Release Engineer | Task: Define scheduled sync/refresh operation and 24h Production Default observation artifacts without defaulting production yet | Restrictions: Do not enable production default path automatically; do not ignore compare drift; keep scheduled commands safe and reversible | _Leverage: workers, compare script, design.md | _Requirements: 7.4, 10.1, 10.2, 10.5, 10.6, 11.4, 12.5 | Success: Production Default has concrete scheduled execution and 24h evidence requirements before any default cutover_

- [x] 9. フロントエンド取得先切替を実装する
  - File: `packages/frontend/src/config/endpoints.ts`
  - File: `packages/frontend/src/zustand/collectionStore.ts`
  - `VITE_COLLECTION_COUNT_ENDPOINT` を導入し、未設定時は既存PostgRESTへ戻す
  - Task 8のProduction Default GateがGo署名されるまで、本番/staging defaultの `VITE_COLLECTION_COUNT_ENDPOINT` はPostgRESTのままにする
  - Hono endpointはGate前にはdemoまたはcontrolled comparisonにだけ使う
  - UI構造は変更しない
  - stale/fallback時の利用者影響は、MVPではUI変更ではなくstatus/runbook/運用告知で扱うことを明記する
  - _Leverage: `packages/frontend/src/zustand/collectionStore.ts`, `packages/frontend/src/types/collection.ts`_
  - _Requirements: 2.3, 6.1, 6.2, 6.3, 6.4, 11.5_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Frontend Developer specializing in Vite and Zustand | Task: Add a configurable collection_count_view endpoint and wire collectionStore to it while preserving current UI behavior and default PostgREST fallback | Restrictions: Do not redesign the UI; do not put ClickHouse secrets in Vite env; keep default behavior identical when VITE_COLLECTION_COUNT_ENDPOINT is unset | _Leverage: existing collectionStore and collection types | _Requirements: 2.3, 6.1, 6.2, 6.3, 6.4, 11.5 | Success: Existing collection list still works by default, endpoint can be switched at build time, and stale/fallback communication path is documented without requiring UI redesign_

- [x] 10. Cloudflare Zero Trust配置メモとRunbookを作成する
  - File: `docs/clickhouse-partial-migration-runbook.md`
  - `/api/analytics/*` をHonoへ、既存view routeと `/rpc/*` をPostgRESTへ向けるCloudflare Tunnel routing例を書く
  - health check、force fallback、unlock worker、resume backfill、rebuild snapshot、compare `--clickhouse-only`、inspect logs、validate recoveryの具体コマンドを書く
  - 最初の5分の障害対応手順、incident record/postmortem template、原因/影響/復旧/再発防止、handoff ownerを書く
  - production cutover/rollback checklistを書く: owner承認、env/route変更、pre-check、live monitoring window、forced fallback、`VITE_COLLECTION_COUNT_ENDPOINT`またはCloudflare routeのrevert、handoff contact
  - operator向け告知テンプレートを書く: snapshot age、current source、user impact、mitigation、owner、next update time
  - 禁止操作、復旧確認、環境変数、ログ、コスト/負荷の撤退条件を書く
  - _Leverage: design.md, requirements.md_
  - _Requirements: 10.6, 11.1, 11.2, 11.4, 11.6, 12.4, 12.5, 13.6_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Site Reliability Engineer familiar with Cloudflare Zero Trust | Task: Create the operational runbook including Cloudflare routing, concrete commands, first-five-minute incident response, fallback decisions, recovery checks, postmortem template, and No-Go conditions | Restrictions: Do not leave abstract placeholders for critical recovery commands; do not instruct operators to expose secrets; keep commands prefixed with rtk where shell commands are shown | _Leverage: design.md and requirements.md | _Requirements: 10.6, 11.1, 11.2, 11.4, 11.6, 12.4, 12.5, 13.6 | Success: An operator can configure routing, handle incidents, force fallback, resume or repair sync, validate recovery, record incidents, and decide No-Go using the runbook alone_

- [x] 11. テストとビルド確認を行う
  - File: relevant test files for scripts/API/frontend
  - event_key unit test、watermark/lock test、snapshot fixture test、`did:web:lexicon.store` 除外test、orphaned refresh test、stale snapshot plus fallback outage test、timeout/rate-limit/CORS/trusted proxy test、clickhouse-only compare fallback検出test、frontend endpoint resolver testを追加する
  - Vite buildを実行する
  - Next.jsではないが、プロジェクト指示に従いビルドは権限付きで実行する
  - Task 12のGo/No-Go判断前に完了している必要がある
  - _Leverage: package scripts, existing test setup_
  - _Requirements: 3.3, 6.3, 8.1, 8.2, 8.3, 9.2, 9.3, 10.5, 11.1_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: QA Automation Engineer | Task: Add and run tests that verify event_key idempotency, watermark/lock safety, ClickHouse snapshot compatibility, stale/fallback outage behavior, security controls, clickhouse-only compare failure on fallback, PostgREST contract compatibility, and frontend endpoint switching; then run the project build with required permissions | Restrictions: Do not skip build failures; do not use live production writes in tests; keep test fixtures small and deterministic; do not implement deferred MCP tests until MCP is separately approved | _Leverage: existing package scripts and test setup | _Requirements: 3.3, 6.3, 8.1, 8.2, 8.3, 9.2, 9.3, 10.5, 11.1 | Success: Relevant MVP tests pass, build succeeds, and residual manual verification gaps are documented_

- [x] 12. MVP Go/No-Go reportを作成する
  - File: `docs/clickhouse-partial-migration-mvp-report.md`
  - Baseline、compare結果、Task 11のテスト/ビルド結果、p95、fallback率、ClickHouse serving ratio、PostgREST read load削減見込み、追加運用コストを記録する
  - MVP DemoとProduction Default Gateを分けて記録する
  - 最終判断は `Stop`, `Continue Demo Only`, `Continue Toward Production Gate` のいずれかに固定し、owner/dateと違反/達成した閾値を記録する
  - 増加collection/NSID reportは任意の内部検証artifactに留め、公開機能や次endpoint移行承認にしない
  - _Leverage: baseline document, compare script, API status endpoint, Task 11 verification results, design.md_
  - _Requirements: 7.1, 7.2, 10.1, 10.5, 10.6, 12.4, 12.5, 12.6, 13.1, 13.2, 13.7_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Analytics and Release Engineer | Task: Create MVP Go/No-Go report from baseline, verification results, and migrated read model evidence, separating MVP Demo from Production Default Gate | Restrictions: Do not mark Production Default as passed from MVP Demo alone; do not require unmigrated views or daily buckets; do not turn growth/NSID report into a public feature or next-endpoint approval; do not issue Continue unless Task 11 verification passed or residual risks are owner-accepted | _Leverage: baseline, compare script, API status, design.md | _Requirements: 7.1, 7.2, 10.1, 10.5, 10.6, 12.4, 12.5, 12.6, 13.1, 13.2, 13.7 | Success: Report supports an explicit Continue/No-Go decision without silently expanding scope_

## Post-MVP / Deferred

以下はMVP DemoおよびProduction Default Gateの範囲外である。Task 12で `Continue Toward Production Gate` が署名され、さらに別途MCP実装が承認されるまで着手しない。

- Post-MVP: MCP read-only analytics endpointを実装する
  - File: `packages/api/src/collection-count/mcp.ts`
  - File: `packages/api/src/collection-count/mcp-tools.ts`
  - `POST /api/mcp` をHono上に追加する
  - Production Default Gate後、かつ別承認後に着手する
  - MCP別承認後の初期版では `get_collection_snapshot_status` のみ許可し、その他は移行済みread modelで返せる場合だけ提供する
  - `get_new_nsids_this_week`, `get_top_event_nsids`, 週次ユーザー推移、collection推移は未移行データが必要なら `not_implemented` にする
  - _Leverage: design.md, requirements.md, MCP TypeScript SDK_
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_
  - _Prompt: Implement the task for spec clickhouse-partial-migration, first run spec-workflow-guide to get the workflow guide then implement the task: Role: Hono and MCP Developer | Task: Add a read-only MCP endpoint after the collection_count_view Production Default Gate, exposing only analytics available from migrated read models | Restrictions: Do not expose arbitrary SQL; do not add production write/admin tools; do not implement unmigrated daily buckets; return not_implemented for unavailable tools; protect route assumptions for Cloudflare Access | _Leverage: design.md, requirements.md, MCP TypeScript SDK | _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7 | Success: MCP endpoint remains read-only, does not expand MVP scope, and gracefully handles unavailable trend data_
