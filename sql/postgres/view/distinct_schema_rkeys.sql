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
-- Name: distinct_schema_rkeys; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.distinct_schema_rkeys AS
 SELECT DISTINCT collection.rkey
   FROM public.collection
  WHERE ((collection.collection = 'com.atproto.lexicon.schema'::text) AND (collection.did <> 'did:web:lexicon.store'::text));


--
-- PostgreSQL database dump complete
--


