-- 1. Insert missing Active Collections for 2026-01-24
INSERT INTO daily_collection_stats (day, active_collection_count)
SELECT "createdAt"::date as day, count(DISTINCT collection) as active_collection_count
FROM collection
WHERE "createdAt"::date >= '2026-01-24'
  AND did != 'did:web:lexicon.store'
GROUP BY 1
ON CONFLICT (day) DO UPDATE 
SET active_collection_count = EXCLUDED.active_collection_count;

-- 2. Insert missing New Collections for 2026-01-24
WITH first_seen AS (
    SELECT collection, min("createdAt")::date AS first_day
    FROM collection
    WHERE did != 'did:web:lexicon.store'
    GROUP BY collection
)
INSERT INTO daily_collection_stats (day, new_collection_count)
SELECT first_day, count(*)
FROM first_seen
WHERE first_day >= '2026-01-24'
GROUP BY first_day
ON CONFLICT (day) DO UPDATE 
SET new_collection_count = EXCLUDED.new_collection_count;

-- 3. (Optional) Improve Views to handle gaps
-- View for Active Collections
CREATE OR REPLACE VIEW public.active_collection_summary_view AS
WITH max_date AS (
    SELECT max(day) AS latest_day FROM daily_collection_stats
),
date_range AS (
    SELECT generate_series(
        (SELECT latest_day - '365 days'::interval FROM max_date),
        (SELECT latest_day FROM max_date),
        '1 day'::interval
    )::date AS day
)
SELECT 
    (SELECT latest_day FROM max_date) - dr.day + 1 AS day,
    COALESCE(d.active_collection_count, 0) AS count
FROM date_range dr
LEFT JOIN daily_collection_stats d ON dr.day = d.day
ORDER BY 1;

-- View for New Collections
CREATE OR REPLACE VIEW public.new_collection_summary_view AS
WITH max_date AS (
    SELECT max(day) AS latest_day FROM daily_collection_stats
),
date_range AS (
    SELECT generate_series(
        (SELECT latest_day - '365 days'::interval FROM max_date),
        (SELECT latest_day FROM max_date),
        '1 day'::interval
    )::date AS day
)
SELECT 
    (SELECT latest_day FROM max_date) - dr.day + 1 AS day,
    COALESCE(d.new_collection_count, 0) AS count
FROM date_range dr
LEFT JOIN daily_collection_stats d ON dr.day = d.day
ORDER BY 1;
