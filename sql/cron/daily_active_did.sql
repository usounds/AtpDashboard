INSERT INTO public.daily_active_did (day, active_did_count, new_did_count)
SELECT today_activity.day, today_activity.active_count, COALESCE(new_user_activity.new_count, 0)
FROM (
    SELECT date_trunc('day', collection."createdAt")::date AS day, count(DISTINCT did) AS active_count
    FROM collection
    WHERE collection."createdAt" >= date_trunc('day', now() - interval '1 day')
    AND collection."createdAt" < date_trunc('day', now())
    GROUP BY 1
) AS today_activity
LEFT JOIN (
    SELECT first_day, count(*) AS new_count
    FROM (
        SELECT did, min(collection."createdAt")::date AS first_day
        FROM collection
        GROUP BY did
    ) AS first_seens
    WHERE first_day = (current_date - interval '1 day')
    GROUP BY 1
) AS new_user_activity ON today_activity.day = new_user_activity.first_day
ON CONFLICT (day) DO UPDATE SET active_did_count = EXCLUDED.active_did_count, new_did_count = EXCLUDED.new_did_count;
