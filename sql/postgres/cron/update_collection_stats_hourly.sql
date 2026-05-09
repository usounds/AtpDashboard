-- 1. 直近1時間分の新規データを抽出して集計
WITH recent_data AS (
    SELECT 
        collection,
        did,
        rkey,
        "createdAt"
    FROM public.collection
    WHERE "createdAt" >= date_trunc('hour', now() - interval '1 hour')
      AND "createdAt" < date_trunc('hour', now())
),
-- 2. 新規に参加した DID を抽出し、補助テーブルに保存。成功した（新しく挿入された）件数のみをカウント
new_dids AS (
    INSERT INTO public.collection_did (collection, did)
    SELECT DISTINCT collection, did FROM recent_data
    ON CONFLICT (collection, did) DO NOTHING
    RETURNING collection
),
new_did_counts AS (
    SELECT collection, count(*) as new_did_count 
    FROM new_dids 
    GROUP BY collection
),
-- 3. 1時間分のその他の集計（レコード数、ユニークRKey数、最小・最大日時など）
hourly_stats AS (
    SELECT 
        collection,
        count(DISTINCT rkey) as new_rkey_count,
        min("createdAt") as new_min,
        max("createdAt") as new_max,
        count(*) as new_total
    FROM recent_data
    GROUP BY collection
)
-- 4. 実テーブル collection_stats を UPSERT（既存の値に加算）
INSERT INTO public.collection_stats (collection, unique_did, unique_rkey, min_createdat, max_createdat, total_count)
SELECT 
    h.collection, 
    COALESCE(d.new_did_count, 0), 
    h.new_rkey_count, 
    h.new_min, 
    h.new_max, 
    h.new_total
FROM hourly_stats h
LEFT JOIN new_did_counts d ON h.collection = d.collection
ON CONFLICT (collection) DO UPDATE SET 
    unique_did = collection_stats.unique_did + EXCLUDED.unique_did,
    unique_rkey = collection_stats.unique_rkey + EXCLUDED.unique_rkey,
    min_createdat = LEAST(collection_stats.min_createdat, EXCLUDED.min_createdat),
    max_createdat = GREATEST(collection_stats.max_createdat, EXCLUDED.max_createdat),
    total_count = collection_stats.total_count + EXCLUDED.total_count;
