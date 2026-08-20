-- =====================================================================
-- 2026_123_super_admin_audit_detachable.sql
--
-- Lets a platform audit row outlive the user it names.
--
-- THE PROBLEM
--   super_admin_audit_log.super_admin_id is NOT NULL with a NO ACTION FK
--   to users(id). superAdmin.routes.js already tries to detach it during
--   org deletion:
--
--     UPDATE super_admin_audit_log SET super_admin_id = NULL WHERE ...
--
--   which cannot succeed against a NOT NULL column. The statement was
--   written with the right intent — keep the log row, lose the
--   attribution — against a column that does not permit it.
--
-- WHY NOT JUST DELETE THE ROWS
--   Every other blocking table in that flow is org-scoped: it belongs to
--   the organisation being deleted and is going away regardless. This one
--   is not. super_admin_audit_log is PLATFORM history — the record of what
--   super admins did across all orgs, including to other orgs. Deleting a
--   slice of it because one organisation was removed destroys evidence
--   that has nothing to do with that organisation.
--
--   So the column becomes nullable and the FK becomes ON DELETE SET NULL:
--   the entry survives, saying what was done and when, and only the name
--   is lost. That is the same trade every other attribution column in
--   that flow already makes.
--
-- NOT A BACKFILL
--   No existing row changes. Rows only acquire NULL when the user they
--   name is deleted, which today cannot happen at all.
--
-- Run AFTER 2026_122.
--   psql "$DATABASE_URL" -f 2026_123_super_admin_audit_detachable.sql
-- =====================================================================

BEGIN;

ALTER TABLE public.super_admin_audit_log
  ALTER COLUMN super_admin_id DROP NOT NULL;

ALTER TABLE public.super_admin_audit_log
  DROP CONSTRAINT IF EXISTS super_admin_audit_log_super_admin_id_fkey;

ALTER TABLE public.super_admin_audit_log
  ADD CONSTRAINT super_admin_audit_log_super_admin_id_fkey
  FOREIGN KEY (super_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.super_admin_audit_log.super_admin_id IS
  'The super admin who performed the action. NULL once that user has been '
  'deleted (2026_123): the audit entry is platform history and outlives the '
  'account it names — what was done and when survives, only the attribution '
  'is lost. Readers must treat NULL as "deleted user", not as "no actor".';

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== Column is now nullable, FK now SET NULL ==='
SELECT a.attname, a.attnotnull AS not_null, con.confdeltype AS on_delete
  FROM pg_attribute a
  JOIN pg_constraint con ON con.conrelid = a.attrelid AND a.attnum = ANY(con.conkey)
 WHERE a.attrelid = 'public.super_admin_audit_log'::regclass
   AND a.attname = 'super_admin_id'
   AND con.contype = 'f';

\echo ''
\echo '=== Existing rows are untouched ==='
SELECT count(*) AS total,
       count(*) FILTER (WHERE super_admin_id IS NULL) AS unattributed
  FROM public.super_admin_audit_log;
