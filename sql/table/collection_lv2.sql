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
-- Name: collection_lv2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_lv2 (
    nsidlv2 text NOT NULL
);


--
-- Name: collection_lv2 collection_lv2_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_lv2
    ADD CONSTRAINT collection_lv2_pkey PRIMARY KEY (nsidlv2);


--
-- PostgreSQL database dump complete
--


