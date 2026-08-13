-- =====================================================================
-- 04b_map_user_org_scope.sql
--
-- Re-keys stg.map_user and adds the two columns the hardened preview
-- routes need, then grants access to Chandini (user 17).
--
-- WHY THE RE-KEY:
--   map_user_pkey is PRIMARY KEY (mongo_id), but resolveMongoUser()
--   looks up by pg_user_id. The old key therefore (a) allowed duplicate
--   pg_user_id rows, and (b) made it IMPOSSIBLE to map two Postgres
--   users to the same Mongo user — which is exactly what sharing
--   Pavan's data with a teammate requires.
--
-- WHY THE NEW COLUMNS:
--   org_id          — lets every preview endpoint verify the caller's
--                     org matches the mapping (req.orgId). Fails closed.
--   mongo_tenant_id — lets GET /preview/emails/:messageId filter
--                     stg.emails by tenant. That endpoint currently has
--                     NO scoping of any kind.
--
-- SCOPE: touches stg.map_user (ETL-only, 1 row today) and replaces one
-- view additively. NO public.* table is modified. NO app code writes to
-- stg.map_user, so there is no race with live traffic.
--
-- RUN THIS BEFORE deploying the patched preview.routes.js — the new
-- route code reads org_id and will fail closed until this lands.
--
--   psql "$DATABASE_URL" -f 04b_map_user_org_scope.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

\set org_id            112
\set aquarient_tenant  '6630baa9e336850c87a0a1d5'
\set pavan_pg_user     18
\set pavan_mongo_user  '6630bb9fe336850c87a0a1d6'
\set mate_pg_user      17
\set mate_email        'chandini.koppara@aquarient.com'

\echo ''
\echo '=== BEFORE: current mapping rows ==='
SELECT * FROM stg.map_user ORDER BY pg_user_id;

BEGIN;

-- ---------------------------------------------------------------------
-- Guard: the re-key requires pg_user_id to be unique and non-null.
-- Abort loudly rather than half-applying if that isn't true.
-- ---------------------------------------------------------------------
DO $$
DECLARE dup int; nulls int;
BEGIN
  SELECT count(*) INTO nulls FROM stg.map_user WHERE pg_user_id IS NULL;
  IF nulls > 0 THEN
    RAISE EXCEPTION 'HARD STOP: % row(s) in stg.map_user have a NULL pg_user_id; '
      'cannot make it the primary key. Inspect: SELECT * FROM stg.map_user;', nulls;
  END IF;

  SELECT count(*) INTO dup FROM (
    SELECT pg_user_id FROM stg.map_user GROUP BY pg_user_id HAVING count(*) > 1
  ) z;
  IF dup > 0 THEN
    RAISE EXCEPTION 'HARD STOP: % duplicate pg_user_id value(s) in stg.map_user. '
      'Resolve before re-keying.', dup;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. Re-key: mongo_id -> pg_user_id.
--    mongo_id keeps a plain index (it is still joined on by the views),
--    it just stops being unique — which is the whole point.
-- ---------------------------------------------------------------------
ALTER TABLE stg.map_user DROP CONSTRAINT IF EXISTS map_user_pkey;

ALTER TABLE stg.map_user ADD COLUMN IF NOT EXISTS org_id          integer;
ALTER TABLE stg.map_user ADD COLUMN IF NOT EXISTS mongo_tenant_id text;

ALTER TABLE stg.map_user ALTER COLUMN pg_user_id SET NOT NULL;
ALTER TABLE stg.map_user ADD CONSTRAINT map_user_pkey PRIMARY KEY (pg_user_id);

CREATE INDEX IF NOT EXISTS idx_map_user_mongo ON stg.map_user(mongo_id);

-- ---------------------------------------------------------------------
-- 2. Backfill Pavan's existing row with org + tenant.
-- ---------------------------------------------------------------------
UPDATE stg.map_user
   SET org_id          = :org_id,
       mongo_tenant_id = :'aquarient_tenant'
 WHERE pg_user_id = :pavan_pg_user;

-- ---------------------------------------------------------------------
-- 3. Grant Chandini (user 17) read access to Pavan's migrated data by
--    pointing her at the SAME Mongo user id. Only possible now that the
--    primary key is on pg_user_id.
--
--    Verified first that she really is user 17 in org 112 — a wrong id
--    here would expose Aquarient data to another org's user.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  SELECT u.id, u.email, u.org_id INTO r
    FROM public.users u
   WHERE u.id = 17;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HARD STOP: users.id=17 does not exist.';
  END IF;
  IF r.org_id IS DISTINCT FROM 112 THEN
    RAISE EXCEPTION 'HARD STOP: users.id=17 belongs to org %, not 112. '
      'Refusing to grant cross-org access.', r.org_id;
  END IF;
  IF lower(r.email) NOT LIKE '%chandini%' THEN
    RAISE EXCEPTION 'HARD STOP: users.id=17 is "%", which does not look like '
      'chandini.koppara@aquarient.com. Confirm the id before granting.', r.email;
  END IF;
END $$;

INSERT INTO stg.map_user (pg_user_id, mongo_id, email, org_id, mongo_tenant_id)
VALUES (:mate_pg_user, :'pavan_mongo_user', :'mate_email',
        :org_id, :'aquarient_tenant')
ON CONFLICT (pg_user_id) DO UPDATE
  SET mongo_id        = EXCLUDED.mongo_id,
      email           = EXCLUDED.email,
      org_id          = EXCLUDED.org_id,
      mongo_tenant_id = EXCLUDED.mongo_tenant_id;

-- ---------------------------------------------------------------------
-- 4. Expose the new columns on the view the routes read.
--    CREATE OR REPLACE VIEW permits APPENDING columns, so existing
--    consumers (pg_user_id, mongo_user_id, email) are untouched.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.user_map AS
SELECT pg_user_id,
       mongo_id AS mongo_user_id,
       email,
       org_id,
       mongo_tenant_id
  FROM stg.map_user;

-- ---------------------------------------------------------------------
-- 5. Final guard: every mapping row must carry an org, or the routes
--    fail closed for that user and the preview silently goes blank.
-- ---------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM stg.map_user WHERE org_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'HARD STOP: % mapping row(s) still have a NULL org_id. '
      'They would fail closed against the patched routes. Set org_id first.', n;
  END IF;
END $$;

COMMIT;

\echo ''
\echo '=== AFTER: mapping rows (both should show org 112 + tenant) ==='
SELECT m.pg_user_id, u.email AS pg_user_email, m.mongo_user_id,
       m.org_id, m.mongo_tenant_id
  FROM pavan_preview.user_map m
  LEFT JOIN public.users u ON u.id = m.pg_user_id
 ORDER BY m.pg_user_id;

\echo ''
\echo '=== Key layout (expect PRIMARY KEY on pg_user_id) ==='
SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'stg' AND t.relname = 'map_user'
 ORDER BY c.conname;

\echo ''
\echo 'Done. Deploy the patched preview.routes.js AFTER this has committed.'
\echo 'To reverse: DELETE FROM stg.map_user WHERE pg_user_id = 17;'
