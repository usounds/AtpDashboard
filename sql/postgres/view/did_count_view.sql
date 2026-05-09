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
-- Name: did_count_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.did_count_view AS
 SELECT collection.did,
    count(*) AS count,
    min(collection."createdAt") AS min,
    max(collection."createdAt") AS max
   FROM public.collection
  GROUP BY collection.did
  ORDER BY (count(*)) DESC;


--
-- PostgreSQL database dump complete
--


