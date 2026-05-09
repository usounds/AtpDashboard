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
-- Name: active_collection_summary_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.active_collection_summary_view AS
 WITH max_date AS (
         SELECT max(daily_collection_stats.day) AS latest_day
           FROM public.daily_collection_stats
        ), date_range AS (
         SELECT (generate_series(( SELECT (max_date.latest_day - '365 days'::interval)
                   FROM max_date), (( SELECT max_date.latest_day
                   FROM max_date))::timestamp without time zone, '1 day'::interval))::date AS day
        )
 SELECT ((( SELECT max_date.latest_day
           FROM max_date) - dr.day) + 1) AS day,
    COALESCE(d.active_collection_count, 0) AS count
   FROM (date_range dr
     LEFT JOIN public.daily_collection_stats d ON ((dr.day = d.day)))
  ORDER BY ((( SELECT max_date.latest_day
           FROM max_date) - dr.day) + 1);


--
-- PostgreSQL database dump complete
--


