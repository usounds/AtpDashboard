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

--
-- Name: collection_count_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.collection_count_view AS
 SELECT collection.collection,
    count(*) AS count,
    count(*) FILTER (WHERE (collection."createdAt" >= (now() - '72:00:00'::interval))) AS recent_count,
    min(collection."createdAt") AS min,
    max(collection."createdAt") AS max
   FROM public.collection
  WHERE (collection.did <> 'did:web:lexicon.store'::text)
  GROUP BY collection.collection
  ORDER BY (max(collection."createdAt")) DESC;


--
-- PostgreSQL database dump complete
--


