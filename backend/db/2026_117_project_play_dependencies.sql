-- =====================================================================
-- 2026_117_project_play_dependencies.sql
--
-- Task-level dependencies for PROJECT plays.
--
-- THE GAP
--   playbook_plays.depends_on has always existed, and
--   PlaybookPlayService._resolveDependenciesForProject reads it. But a
--   manually-added task has play_id NULL, and the resolver opens with:
--
--       if (!completedPlayId || !handoverId) return [];
--
--   so completing an ad-hoc task resolves nothing. Worse, the lookup is
--
--       LEFT JOIN playbook_plays pp ON pp.id = ppi.play_id
--       WHERE pp.depends_on IS NOT NULL AND $2 = ANY(pp.depends_on)
--
--   which can only ever match plays that came from a template. A
--   hand-built project — every project without a playbook — has no way to
--   express that task B follows task A.
--
-- TWO ID SPACES, DELIBERATELY NOT MERGED
--   playbook_plays.depends_on holds PLAY ids (template-level, shared by
--   every project using that playbook).
--   project_play_instances.depends_on holds INSTANCE ids (this project's
--   own tasks).
--
--   These are different id spaces over different tables. They must NOT be
--   COALESCEd into one expression — `$1 = ANY(COALESCE(a, b))` would
--   compare an instance id against play ids and match by coincidence.
--   The service keeps them as separate queries.
--
-- ELIGIBILITY, NOT BLOCKING
--   A dependent task stays 'not_started'; it is not forced to 'blocked'.
--   Whether it can be started is computed at READ time from whether its
--   prerequisites are done. That keeps a draft plan editable — adding a
--   dependency does not mutate the dependent task's status — while still
--   letting the API and UI refuse a start.
--
-- Run AFTER 2026_116.
--   psql "$DATABASE_URL" -f 2026_117_project_play_dependencies.sql
-- =====================================================================

BEGIN;

ALTER TABLE public.project_play_instances
  ADD COLUMN IF NOT EXISTS depends_on integer[];

COMMENT ON COLUMN public.project_play_instances.depends_on IS
  'Sibling project_play_instances.id values that must be completed or '
  'skipped before this task may start. INSTANCE ids — not the play ids in '
  'playbook_plays.depends_on. NULL/empty means no prerequisites.';

-- GIN supports the containment lookup used to find dependents of a task:
--   WHERE depends_on @> ARRAY[<id>]
CREATE INDEX IF NOT EXISTS idx_ppi_depends_on
  ON public.project_play_instances USING GIN (depends_on)
  WHERE depends_on IS NOT NULL;

-- A task cannot be its own prerequisite. Deeper cycles need graph traversal
-- and are rejected in the service layer (setPlayDependencies), mirroring how
-- parent_instance_id handles the same problem in 2026_109.
ALTER TABLE public.project_play_instances
  DROP CONSTRAINT IF EXISTS project_play_instances_depends_not_self;
ALTER TABLE public.project_play_instances
  ADD CONSTRAINT project_play_instances_depends_not_self
  CHECK (depends_on IS NULL OR NOT (id = ANY(depends_on)));

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== Column present? ==='
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'project_play_instances' AND column_name = 'depends_on';

\echo ''
\echo '=== Self-reference check rejects (expect an error below) ==='
DO $$
BEGIN
  BEGIN
    UPDATE public.project_play_instances
       SET depends_on = ARRAY[id]
     WHERE id = (SELECT min(id) FROM public.project_play_instances);
    RAISE NOTICE 'FAIL — self-dependency was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK — self-dependency rejected by constraint';
  END;
END $$;

\echo ''
\echo '=== Tasks with prerequisites (none yet on a fresh migration) ==='
SELECT handover_id, id, title, depends_on
  FROM public.project_play_instances
 WHERE depends_on IS NOT NULL AND array_length(depends_on, 1) > 0
 ORDER BY handover_id, id
 LIMIT 20;
