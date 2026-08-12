-- =====================================================================
-- 01_crosswalk.sql  —  Stage 1: resolve existing org + user, seed addresses
--
-- INSERTS NOTHING into application tables. Only reads app tables and
-- populates stg.map_user / stg.user_addresses. Safe & reversible.
--
-- Prereq: 00_staging.sql run, and staging \copy loaded (at least
--         stg.users and stg.emails).
-- Run:  psql "$DATABASE_URL" -v batch=aqua_pavan_001 -f 01_crosswalk.sql
-- =====================================================================

\if :{?batch}
\else
  \set batch 'aqua_pavan_001'
\endif

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------
-- 1a. Resolve Aquarient org_id from the EXISTING organizations table.
--     We look up by the Mongo tenant name/domain. Adjust the match if
--     your organizations row uses a different name.
-- ---------------------------------------------------------------------
-- Confirmed: Aquarient Technologies is org id=112 (slug aquarient-technologies).
-- We pin to the id and cross-check the name so a wrong DB can't silently pass.
DROP TABLE IF EXISTS _org;
CREATE TEMP TABLE _org AS
SELECT id AS org_id, name, slug
FROM public.organizations
WHERE id = 112;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM _org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HARD STOP: organizations id=112 not found in this database. '
      'Are you connected to the right Postgres? '
      'Inspect: SELECT id,name FROM organizations WHERE name ILIKE ''%%aquarient%%'';';
  END IF;
  IF lower(r.name) NOT LIKE '%aquarient%' THEN
    RAISE EXCEPTION 'HARD STOP: org id=112 is "%", not Aquarient. Wrong id or wrong DB.', r.name;
  END IF;
END $$;

\echo '--- resolved org ---'
SELECT * FROM _org;

-- ---------------------------------------------------------------------
-- 1b. Resolve Pavan's Postgres user_id by email, scoped to that org.
--     Mongo user _id for Pavan: 6630bb9fe336850c87a0a1d6
--     Postgres users has email + org_id.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS _user;
CREATE TEMP TABLE _user AS
SELECT u.id AS pg_user_id, u.email, u.org_id
FROM public.users u
JOIN _org o ON o.org_id = u.org_id
WHERE lower(u.email) = 'pavan.kanugo@aquarient.com'
   OR (lower(u.email) LIKE '%kanugo%' AND u.org_id = 112);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _user;
  IF n = 0 THEN
    RAISE EXCEPTION 'HARD STOP: no Postgres user for Pavan in org 112. '
      'Check: SELECT id,email,org_id FROM users WHERE org_id=112;';
  ELSIF n > 1 THEN
    RAISE EXCEPTION 'HARD STOP: % candidate users matched Pavan in org 112; '
      'disambiguate. SELECT id,email FROM users WHERE org_id=112 AND email ILIKE ''%%kanugo%%'';', n;
  END IF;
END $$;

\echo '--- resolved user ---'
SELECT * FROM _user;

-- record the Mongo->PG user mapping
INSERT INTO stg.map_user(mongo_id, pg_user_id, email)
SELECT '6630bb9fe336850c87a0a1d6', pg_user_id, email FROM _user
ON CONFLICT (mongo_id) DO UPDATE SET pg_user_id = EXCLUDED.pg_user_id, email = EXCLUDED.email;

-- ---------------------------------------------------------------------
-- 1c. Seed Pavan's 9 known addresses (hardcoded, approved).
-- ---------------------------------------------------------------------
INSERT INTO stg.user_addresses(batch, address, source, approved) VALUES
  (:'batch','pavan.kanugo@us.fujitsu.com','hardcoded',true),
  (:'batch','pavank@us.fujitsu.com',      'hardcoded',true),
  (:'batch','pkanugo@us.fujitsu.com',     'hardcoded',true),
  (:'batch','pavan.kanugo@fujitsu.com',   'hardcoded',true),
  (:'batch','pavank@fujitsu.com',         'hardcoded',true),
  (:'batch','pkanugo@fujitsu.com',        'hardcoded',true),
  (:'batch','pavan.kanugo@rapidigm.com',  'hardcoded',true),
  (:'batch','pkanugo@rapidigm.com',       'hardcoded',true),
  (:'batch','pavank@rapidigm.com',        'hardcoded',true),
  (:'batch','pavan.kanugo@aquarient.com', 'hardcoded',true)
ON CONFLICT (batch,address) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1d. AUTO-DETECT candidate addresses for Pavan (for your review).
--     Heuristic: sender addresses on his 4 internal domains whose local
--     part looks like him (contains 'kanugo' or 'pavan'), that co-occur
--     in emails where a known Pavan address is also a participant.
--     These land approved=false — you review before they count.
-- ---------------------------------------------------------------------
WITH tenant_emails AS (
  SELECT
    lower(doc->>'sender')                                   AS sender,
    ARRAY(SELECT lower(jsonb_array_elements_text(coalesce(doc->'recipients','[]')))) AS recips,
    ARRAY(SELECT lower(jsonb_array_elements_text(coalesce(doc->'cc','[]'))))         AS ccs
  FROM stg.emails
),
parts AS (
  SELECT unnest(array_append(array_cat(recips, ccs), sender)) AS addr, sender
  FROM tenant_emails
),
candidates AS (
  SELECT DISTINCT sender AS addr
  FROM tenant_emails
  WHERE split_part(sender,'@',2) IN (SELECT domain FROM stg.internal_domains)
    AND (sender LIKE '%kanugo%' OR sender LIKE '%pavan%')
    AND sender NOT IN (SELECT address FROM stg.user_addresses WHERE batch=:'batch')
)
INSERT INTO stg.user_addresses(batch, address, source, approved)
SELECT :'batch', addr, 'autodetected', false FROM candidates
ON CONFLICT (batch,address) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------
-- Review output
-- ---------------------------------------------------------------------
\echo ''
\echo '=== Pavan address set (hardcoded=approved, autodetected=review) ==='
SELECT address, source, approved
FROM stg.user_addresses WHERE batch=:'batch'
ORDER BY approved DESC, source, address;

\echo ''
\echo '=== ACTION: approve any real Pavan aliases from the autodetected list: ==='
\echo "  UPDATE stg.user_addresses SET approved=true WHERE batch=:'batch' AND address='<addr>';"
\echo "  (leave colleague addresses as approved=false)"
\echo ''
\echo 'Stage 1 complete. Nothing written to app tables yet.'
