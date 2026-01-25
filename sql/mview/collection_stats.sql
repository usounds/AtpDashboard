--
-- PostgreSQL database dump
--


-- Dumped from database version 14.11 (Debian 14.11-1.pgdg120+2)
-- Dumped by pg_dump version 18.0

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: collection_stats; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.collection_stats AS
 SELECT collection.collection,
    count(DISTINCT collection.did) AS unique_did,
    count(DISTINCT ROW(collection.did, collection.collection, collection.rkey)) AS unique_rkey,
    min(collection."createdAt") AS min_createdat,
    max(collection."createdAt") AS max_createdat,
    count(*) AS total_count
   FROM public.collection
  GROUP BY collection.collection
  WITH NO DATA;


--
-- Name: collection_stats_collection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX collection_stats_collection_idx ON public.collection_stats USING btree (collection);


--
-- PostgreSQL database dump complete
--


