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
-- Name: collection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection (
    did text NOT NULL,
    collection text NOT NULL,
    rkey text NOT NULL,
    "createdAt" timestamp without time zone
);


--
-- Name: collection_collection_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX collection_collection_created_at_idx ON public.collection USING btree (collection, "createdAt");


--
-- Name: idx_collection_stats_cover; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collection_stats_cover ON public.collection USING btree (collection, did, "createdAt");


--
-- Name: idx_collection_stats_full; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collection_stats_full ON public.collection USING btree (collection, did, rkey);


--
-- Name: unique_collection_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_collection_index ON public.collection USING btree (did, collection, rkey, "createdAt");


--
-- Name: collection collection_lv2_insert_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_lv2_insert_trg AFTER INSERT ON public.collection FOR EACH ROW EXECUTE FUNCTION public.update_collection_lv2_on_insert();


--
-- Name: collection collection_unique_did_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_unique_did_trg AFTER INSERT ON public.collection FOR EACH ROW EXECUTE FUNCTION public.unique_did_insert_trg();


--
-- PostgreSQL database dump complete
--


