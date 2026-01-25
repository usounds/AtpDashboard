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
-- Name: collection_lv2_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.collection_lv2_view AS
 SELECT DISTINCT concat(split_part(collection.collection, '.'::text, 1), '.', split_part(collection.collection, '.'::text, 2)) AS nsidlv2
   FROM public.collection
  WHERE (collection.collection ~~ '%.%'::text);


--
-- PostgreSQL database dump complete
--


