INSERT INTO public.daily_collection_stats (day, active_collection_count)
SELECT date_trunc('day', collection."createdAt")::date, count(DISTINCT collection.collection)
FROM collection
WHERE collection."createdAt" >= date_trunc('day', now() - interval '1 day')
AND collection."createdAt" < date_trunc('day', now())
AND collection.did != 'did:web:lexicon.store'
GROUP BY 1
ON CONFLICT (day) DO UPDATE SET active_collection_count = EXCLUDED.active_collection_count;

WITH first_seen AS (
    SELECT collection.collection, min(collection."createdAt")::date AS first_day
    FROM collection
    WHERE collection.did != 'did:web:lexicon.store'
    GROUP BY collection.collection
)
INSERT INTO public.daily_collection_stats (day, new_collection_count)
SELECT first_day, count(*)
FROM first_seen
WHERE first_day = current_date - interval '1 day'
GROUP BY first_day
ON CONFLICT (day) DO UPDATE SET new_collection_count = EXCLUDED.new_collection_count;
