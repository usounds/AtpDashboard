-- 1. Insert missing data for 2026-01-24
-- We need to calculate both active_did_count AND new_did_count

WITH active_stats AS (
    SELECT "createdAt"::date as day, count(DISTINCT did) as active_did_count
    FROM collection
    WHERE "createdAt"::date >= '2026-01-24'
    GROUP BY 1
),
new_stats AS (
    SELECT first_day as day, count(*) as new_did_count
    FROM (
        SELECT did, min("createdAt")::date AS first_day
        FROM collection
        GROUP BY did
    ) AS first_seens
    WHERE first_day >= '2026-01-24'
    GROUP BY 1
)
INSERT INTO daily_active_did (day, active_did_count, new_did_count)
SELECT 
    COALESCE(a.day, n.day) as day,
    COALESCE(a.active_did_count, 0) as active_did_count,
    COALESCE(n.new_did_count, 0) as new_did_count
FROM active_stats a
FULL OUTER JOIN new_stats n ON a.day = n.day
ON CONFLICT (day) DO UPDATE 
SET 
    active_did_count = EXCLUDED.active_did_count,
    new_did_count = EXCLUDED.new_did_count;

-- 2. Improve the Views
-- View for Active DIDs
CREATE OR REPLACE VIEW public.active_did_summary_view AS
WITH max_date AS (
    SELECT max(day) AS latest_day FROM daily_active_did
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
    COALESCE(d.active_did_count, 0) AS count
FROM date_range dr
LEFT JOIN daily_active_did d ON dr.day = d.day
ORDER BY 1;

-- View for New DIDs
CREATE OR REPLACE VIEW public.new_did_summary_view AS
WITH max_date AS (
    SELECT max(day) AS latest_day FROM daily_active_did
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
    COALESCE(d.new_did_count, 0) AS count
FROM date_range dr
LEFT JOIN daily_active_did d ON dr.day = d.day
ORDER BY 1;
