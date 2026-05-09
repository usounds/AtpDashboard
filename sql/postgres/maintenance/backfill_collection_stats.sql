-- ==========================================
-- 初期データ移行（バックフィル）用スクリプト
-- ==========================================

-- 注意：このスクリプトは非常に重い処理を含みます。
-- 可能であれば、DBの負荷が低い時間帯に実行してください。

-- 1. collection_did テーブルの初期化
-- (過去のすべての Collection と DID の組み合わせを登録)
INSERT INTO public.collection_did (collection, did)
SELECT DISTINCT collection, did FROM public.collection
ON CONFLICT (collection, did) DO NOTHING;

-- 2. collection_stats テーブルの初期化
-- (過去の全データから統計を算出)
INSERT INTO public.collection_stats (collection, unique_did, unique_rkey, min_createdat, max_createdat, total_count)
SELECT 
    collection,
    count(DISTINCT did) as unique_did,
    count(DISTINCT rkey) as unique_rkey,
    min("createdAt") as min_createdat,
    max("createdAt") as max_createdat,
    count(*) as total_count
FROM public.collection
GROUP BY collection
ON CONFLICT (collection) DO UPDATE SET
    unique_did = EXCLUDED.unique_did,
    unique_rkey = EXCLUDED.unique_rkey,
    min_createdat = EXCLUDED.min_createdat,
    max_createdat = EXCLUDED.max_createdat,
    total_count = EXCLUDED.total_count;

-- ==========================================
-- [オプション] もし一度に実行してタイムアウトする場合の分割案
-- ==========================================
-- 以下の例のように、コレクション名（頭文字など）で区切って実行することを検討してください。
-- INSERT INTO ... SELECT ... FROM collection WHERE collection LIKE 'app.bsky.%' GROUP BY 1;
