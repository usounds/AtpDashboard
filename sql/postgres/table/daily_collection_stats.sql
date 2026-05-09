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
-- Name: daily_collection_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_collection_stats (
    day date NOT NULL,
    active_collection_count integer DEFAULT 0 NOT NULL,
    new_collection_count integer DEFAULT 0 NOT NULL,
    new_did_count integer DEFAULT 0 NOT NULL
);


--
-- Name: daily_collection_stats daily_collection_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_collection_stats
    ADD CONSTRAINT daily_collection_stats_pkey PRIMARY KEY (day);


--
-- PostgreSQL database dump complete
--


