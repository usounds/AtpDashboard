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
-- Name: new_creators_last_7days; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.new_creators_last_7days AS
 SELECT count(*) AS count
   FROM ( SELECT event_logs.creator_did,
            min(event_logs.create_at) AS first_seen
           FROM public.event_logs
          GROUP BY event_logs.creator_did) t
  WHERE (t.first_seen >= (now() - '7 days'::interval));


--
-- PostgreSQL database dump complete
--


