-- =====================================================================
-- 00_staging.sql  —  Stage 0: staging tables + teardown infrastructure
-- Mongo acms-db  ->  existing Postgres schema.  Aquarient / Pavan, pass 1.
--
-- Safe to run repeatedly. Creates ONLY staging + safety objects.
-- Does NOT touch any application table.
-- =====================================================================

-- --- batch identifier for this whole load (change per attempt) ----------
-- We reference it as a psql variable :batch when running.  Default here so
-- the file also works if run without -v.
\if :{?batch}
\else
  \set batch 'aqua_pavan_001'
\endif

CREATE SCHEMA IF NOT EXISTS stg;

-- one raw jsonb table per NDJSON file we will \copy in
CREATE TABLE IF NOT EXISTS stg.contacts                  (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.contact_custom_attrs      (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.tenant_user_contact_lists (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.tenant_contact_records    (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.emails                    (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.user_linkedin_connections (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.linkedin_messages         (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.linkedin_message_history  (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.contact_organizations     (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.users                     (doc jsonb);
CREATE TABLE IF NOT EXISTS stg.tenants                   (doc jsonb);

-- --- teardown safety net: every inserted PK is logged here --------------
CREATE TABLE IF NOT EXISTS etl_row_log (
  batch      text        NOT NULL,
  table_name text        NOT NULL,
  row_id     bigint      NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_etl_row_log_batch ON etl_row_log(batch);

-- --- crosswalk + user-address tables (ETL-scoped, in stg) ---------------
CREATE TABLE IF NOT EXISTS stg.map_user (
  mongo_id    text PRIMARY KEY,
  pg_user_id  int  NOT NULL,
  email       text
);

-- Pavan's own addresses (the user side) — used to compute email direction.
CREATE TABLE IF NOT EXISTS stg.user_addresses (
  batch    text NOT NULL,
  address  text NOT NULL,
  source   text NOT NULL,            -- 'hardcoded' | 'autodetected'
  approved boolean DEFAULT true,     -- autodetected candidates start false
  UNIQUE (batch, address)
);

-- The 4 internal domains (colleague vs external classification).
CREATE TABLE IF NOT EXISTS stg.internal_domains (
  domain text PRIMARY KEY
);
INSERT INTO stg.internal_domains(domain) VALUES
  ('fujitsu.com'), ('us.fujitsu.com'), ('rapidigm.com'), ('aquarient.com')
ON CONFLICT DO NOTHING;

\echo 'Stage 0 complete: staging schema, etl_row_log, crosswalk tables ready.'
\echo 'Now run the \copy commands (see COPY_COMMANDS.txt), then 01_crosswalk.sql'
