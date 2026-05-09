CREATE MATERIALIZED VIEW IF NOT EXISTS public.collection_stats AS
 SELECT collection.collection,
    count(DISTINCT collection.did) AS unique_did,
    count(DISTINCT ROW(collection.did, collection.collection, collection.rkey)) AS unique_rkey,
    min(collection."createdAt") AS min_createdat,
    max(collection."createdAt") AS max_createdat,
    count(*) AS total_count
   FROM public.collection
  GROUP BY collection.collection
WITH DATA;

CREATE UNIQUE INDEX collection_stats_collection_idx
    ON public.collection_stats USING btree (collection);
