CREATE TABLE IF NOT EXISTS public.clickhouse_sync_checkpoints
(
    name text PRIMARY KEY,
    watermark_created_at timestamptz,
    watermark_created_at_key text NOT NULL,
    watermark_did text NOT NULL,
    watermark_collection text NOT NULL,
    watermark_rkey text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.clickhouse_sync_locks
(
    name text PRIMARY KEY,
    holder text NOT NULL,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

COMMENT ON TABLE public.clickhouse_sync_checkpoints IS
    'Operational checkpoint state for ClickHouse collection backfill/sync workers.';

COMMENT ON TABLE public.clickhouse_sync_locks IS
    'Best-effort single-worker lock state for ClickHouse collection backfill/sync workers.';

COMMENT ON COLUMN public.clickhouse_sync_checkpoints.watermark_created_at_key IS
    'Worker-normalized Postgres createdAt key, using <NULL> for NULL createdAt.';

-- Lock acquisition pattern:
-- INSERT INTO public.clickhouse_sync_locks (name, holder, expires_at)
-- VALUES ($1, $2, now() + $3::interval)
-- ON CONFLICT (name) DO UPDATE
-- SET holder = EXCLUDED.holder,
--     acquired_at = now(),
--     expires_at = EXCLUDED.expires_at
-- WHERE public.clickhouse_sync_locks.expires_at < now()
-- RETURNING *;

-- Checkpoint observation:
-- SELECT *
-- FROM public.clickhouse_sync_checkpoints
-- ORDER BY updated_at DESC;
