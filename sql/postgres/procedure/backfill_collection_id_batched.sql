CREATE OR REPLACE PROCEDURE public.backfill_collection_id_batched(IN batch_limit integer DEFAULT 10000)
LANGUAGE plpgsql
AS $procedure$
DECLARE
    updated_count int;
BEGIN
    RAISE NOTICE 'Starting global backfill with batch size %...', batch_limit;

    LOOP
        -- Pick any chunk of rows that needs regularizing.
        -- CTID gives fast physical row access for this batched update.
        WITH batch AS (
            SELECT ctid, collection
            FROM public.collection
            WHERE collection_id IS NULL
            LIMIT batch_limit
        )
        UPDATE public.collection c
        SET collection_id = cn.id
        FROM batch b
        JOIN public.collection_names cn ON b.collection = cn.name
        WHERE c.ctid = b.ctid;

        GET DIAGNOSTICS updated_count = ROW_COUNT;
        RAISE NOTICE 'Updated % rows', updated_count;

        COMMIT;

        IF updated_count = 0 THEN
            EXIT;
        END IF;

        -- Optional: Sleep to reduce load.
        -- PERFORM pg_sleep(0.01);
    END LOOP;

    RAISE NOTICE 'Backfill complete.';
END;
$procedure$;
