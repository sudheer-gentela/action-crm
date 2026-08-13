-- =====================================================================
-- 2026_110_project_play_split_fixups.sql
--
-- Follow-up to 2026_109. Two things:
--
--   1. REPAIRS an omission in 2026_109. project_play_assignees was
--      created without the UNIQUE (instance_id, user_id) constraint and
--      without the role_id / assigned_by foreign keys that
--      deal_play_assignees carries. The unique constraint is not
--      cosmetic: PlaybookPlayService.reassignPlay does
--          ON CONFLICT (instance_id, user_id) DO UPDATE
--      which raises "there is no unique or exclusion constraint matching
--      the ON CONFLICT specification" at runtime without it. Reassigning
--      a project play would have failed the first time anyone tried.
--
--   2. ADDS uq_actions_handover_play, mirroring uq_actions_deal_play /
--      uq_actions_contract_play / uq_actions_case_play. Without it,
--      _createActionForPlay cannot upsert idempotently for a project
--      that has no deal — the ON CONFLICT target would not exist and
--      re-activating a stage would create duplicate actions instead of
--      updating the existing one.
--
-- Safe to run more than once.
--
--   psql "$DATABASE_URL" -f 2026_110_project_play_split_fixups.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

BEGIN;

-- ---------------------------------------------------------------------
-- 1a. Unique assignee per instance.
--     Guard first: if duplicates somehow exist the ADD CONSTRAINT would
--     fail with a bare index error. Nothing writes this table yet (the
--     2026_109 verification recorded 0 rows migrated), so this is
--     belt-and-braces rather than an expected path.
-- ---------------------------------------------------------------------
DO $$
DECLARE dups int;
BEGIN
  SELECT count(*) INTO dups FROM (
    SELECT instance_id, user_id
      FROM public.project_play_assignees
     GROUP BY instance_id, user_id
    HAVING count(*) > 1
  ) z;
  IF dups > 0 THEN
    RAISE EXCEPTION 'HARD STOP: % duplicate (instance_id, user_id) pair(s) in '
      'project_play_assignees. Resolve before adding the unique constraint.', dups;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_play_assignees_instance_id_user_id_key'
  ) THEN
    ALTER TABLE public.project_play_assignees
      ADD CONSTRAINT project_play_assignees_instance_id_user_id_key
      UNIQUE (instance_id, user_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1b. The two foreign keys deal_play_assignees has and the mirror lacked.
--     role_id  -> org_roles  ON DELETE SET NULL  (a deleted role must not
--                                                 delete the assignment)
--     assigned_by -> users   (no cascade, matching the deal side)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'project_play_assignees_role_id_fkey') THEN
    ALTER TABLE public.project_play_assignees
      ADD CONSTRAINT project_play_assignees_role_id_fkey
      FOREIGN KEY (role_id) REFERENCES public.org_roles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'project_play_assignees_assigned_by_fkey') THEN
    ALTER TABLE public.project_play_assignees
      ADD CONSTRAINT project_play_assignees_assigned_by_fkey
      FOREIGN KEY (assigned_by) REFERENCES public.users(id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. Idempotent action upsert for project plays.
--
--    Mirrors uq_actions_deal_play exactly, keyed on handover_id. This is
--    what lets _createActionForPlay use
--        ON CONFLICT (handover_id, playbook_play_id)
--    for a project with no deal. Partial, so it constrains nothing for
--    deal, contract or case actions.
--
--    Built NOT CONCURRENTLY because we are inside a transaction and the
--    actions table is small enough (245 rows) that the brief lock is
--    immaterial. On a large table this would want CONCURRENTLY outside a
--    transaction instead.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_actions_handover_play
  ON public.actions USING btree (handover_id, playbook_play_id)
  WHERE ((handover_id IS NOT NULL) AND (playbook_play_id IS NOT NULL));

-- ---------------------------------------------------------------------
-- Verify everything landed before committing.
-- ---------------------------------------------------------------------
DO $$
DECLARE missing text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'project_play_assignees_instance_id_user_id_key')
    THEN missing := missing || ' unique(instance_id,user_id)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'project_play_assignees_role_id_fkey')
    THEN missing := missing || ' fk(role_id)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'project_play_assignees_assigned_by_fkey')
    THEN missing := missing || ' fk(assigned_by)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname = 'uq_actions_handover_play')
    THEN missing := missing || ' uq_actions_handover_play'; END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'HARD STOP: not created —%', missing;
  END IF;
END $$;

COMMIT;

\echo ''
\echo '=== project_play_assignees constraints (expect pkey, unique, 3 FKs) ==='
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.project_play_assignees'::regclass
 ORDER BY conname;

\echo ''
\echo '=== actions play-upsert indexes (handover must sit alongside the others) ==='
SELECT indexname FROM pg_indexes
 WHERE tablename = 'actions' AND indexname LIKE 'uq_actions_%_play'
 ORDER BY indexname;
