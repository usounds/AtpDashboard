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
-- Name: collection_min_max_did_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.collection_min_max_did_view AS
 SELECT c1.collection,
    c1.did AS min_did,
    c1.rkey AS min_rkey,
    c1."createdAt" AS min_created_at,
    c2.did AS max_did,
    c2.rkey AS max_rkey,
    c2."createdAt" AS max_created_at
   FROM (( SELECT DISTINCT ON (collection.collection) collection.collection,
            collection.did,
            collection."createdAt",
            collection.rkey
           FROM public.collection
          ORDER BY collection.collection, collection."createdAt") c1
     JOIN ( SELECT DISTINCT ON (collection.collection) collection.collection,
            collection.did,
            collection."createdAt",
            collection.rkey
           FROM public.collection
          ORDER BY collection.collection, collection."createdAt" DESC) c2 ON ((c1.collection = c2.collection)));


--
-- PostgreSQL database dump complete
--


