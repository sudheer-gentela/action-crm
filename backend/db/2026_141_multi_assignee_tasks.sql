-- =====================================================================
-- 2026_141_multi_assignee_tasks.sql
--
-- Several people may be assigned to one project task. The task still has
-- ONE owner; the assignees are everyone who works on it and logs against
-- it.
--
-- ── WHY THERE IS NO NEW TABLE ────────────────────────────────────────
--
-- project_play_assignees was created by 2026_109 and given
-- project_play_assignees_instance_id_user_id_key UNIQUE (instance_id,
-- user_id) by 2026_110, with idx_ppa_instance and idx_ppa_user on both
-- sides. It is the right shape and it has been indexed the whole time.
--
-- It has also been EMPTY in every live org since the day it was made:
-- its only writer, PlaybookPlayService.reassignPlayForProject(), is
-- reachable from no route — only from scripts/phase109_acceptance.js.
-- 2026_130 was a bugfix that switched a read OFF this table for exactly
-- that reason, and playReview.service.js documents it as a table that
-- "looks like a second answer but is not one".
--
-- After this migration it IS the answer, and the two triggers below are
-- what make that safe to rely on.
--
-- ── OWNER IS ALWAYS ALSO AN ASSIGNEE ─────────────────────────────────
--
-- The alternative was to leave the two columns independent and write
-- every read as (owner_user_id = $1 OR EXISTS (assignee row)). That
-- works and needs no backfill, but it puts the same rule in six queries
-- and admits a state — owner not assigned to their own task — that means
-- nothing and that somebody would eventually have to interpret.
--
-- So: one predicate, EXISTS against this table, and a trigger that makes
-- the owner's row an invariant rather than a convention. Reads after this
-- migration do NOT test owner_user_id at all, and that is only correct
-- because trg_sync_play_owner_assignee below cannot be forgotten.
--
-- ── WHY A TRIGGER AND NOT AN APPLICATION HOOK ────────────────────────
--
-- Same reasoning as 2026_136, and the same evidence. There is no single
-- writer of owner_user_id to hook into. At the time of writing it is set
-- by at least:
--
--   handover.service.updatePlay        — the inline owner chip
--   handover.service.setPlaybook       — carryOwners on playbook swap
--   handover.service (bulk insert)     — plan creation
--   planImport.service                 — imported plans
--   PlaybookPlayService                — activation and reset paths
--
-- Five call sites today, and the sixth will be added by someone who has
-- never read this file. A missed sync means the owner silently loses
-- their own task from My day, which reads as data loss, not as a bug.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ──────────────────────────────────
--
-- No team_id column. Assigning to a whole team was considered and
-- dropped: work handed to eight people is work nobody has to move first,
-- which is the same failure resolveActorRole already refuses when it
-- declines to let anyone inherit an unassigned task by being nearby.
-- People are picked individually. Nothing here references teams,
-- team_memberships or team_dimensions.
--
-- No change to project_play_instances. owner_user_id keeps its meaning
-- and every existing reader of it — playReview's authority model,
-- dependencyNotifier, playReviewNotifier, planVariance — is untouched,
-- and stays single-recipient.
--
-- No RLS. project_play_assignees has none, in common with every table
-- added after the CRM era. This migration does not widen that gap and
-- does not close it.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Backfill: every current owner becomes an assignee.
--
-- This must run BEFORE the triggers are created, and it is what makes
-- the new read predicate correct for rows that already exist. Without
-- it, every task assigned before today would vanish from its own owner's
-- My day the moment the read path changes.
--
-- assigned_by is the owner themselves rather than NULL or a system id:
-- the column means "who put this person here", and for a backfilled row
-- the honest answer is that nobody did it today — it is a restatement of
-- a decision already recorded on the instance. Attributing it to the
-- owner keeps the FK satisfied and does not invent an actor who never
-- acted.
--
-- created_at is NOT defaulted to now(). These assignments are as old as
-- the task, and stamping them today would make every historical task
-- look freshly staffed.
--
-- ON CONFLICT DO NOTHING against the 2026_110 unique key, so re-running
-- this migration is safe and so any row reassignPlayForProject() left
-- behind in a test org is preserved rather than duplicated.
-- ---------------------------------------------------------------------
INSERT INTO public.project_play_assignees (instance_id, user_id, assigned_by, created_at)
SELECT p.id, p.owner_user_id, p.owner_user_id, p.created_at
  FROM public.project_play_instances p
 WHERE p.owner_user_id IS NOT NULL
ON CONFLICT (instance_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. The owner is an assignee, now and forever.
--
-- AFTER INSERT OR UPDATE OF owner_user_id, so a plan created with owners
-- and an owner changed later both land here.
--
-- ── THE PRIOR OWNER IS NOT REMOVED ───────────────────────────────────
--
-- Reassigning ownership from Priya to Arun leaves Priya assigned. This
-- is deliberate and it is the decision most likely to be questioned
-- later, so: losing ownership is not the same as leaving the task. Priya
-- is usually still working on it, and very often still has an open
-- daily_work_items row against it (uq_dwi_owner_play) with entries under
-- it. Dropping her silently, as a side effect of a change to a different
-- field, would take a task off her My day that she is still doing — and
-- there would be no record of why.
--
-- Removing someone is therefore always an explicit act, through
-- projectPlayAssignees.setAssignees(). If Priya is genuinely off the
-- task, a manager unticks her.
--
-- ── NULL OWNER ───────────────────────────────────────────────────────
--
-- An unassigned task (owner_user_id NULL) adds nobody. resolveActorRole
-- already resolves such a task to 'manager' or null; this keeps the two
-- consistent rather than inventing an assignee for a task that has no
-- owner.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_play_owner_assignee() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  IF NEW.owner_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- UPDATE fires on any statement naming owner_user_id in its SET list,
  -- including the many that rewrite it to the value it already held.
  -- The comparison, not the trigger event, is what decides.
  IF TG_OP = 'UPDATE' AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.project_play_assignees (instance_id, user_id, assigned_by)
  VALUES (NEW.id, NEW.owner_user_id, NEW.owner_user_id)
  ON CONFLICT (instance_id, user_id) DO NOTHING;

  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_sync_play_owner_assignee
  ON public.project_play_instances;
CREATE TRIGGER trg_sync_play_owner_assignee
  AFTER INSERT OR UPDATE OF owner_user_id ON public.project_play_instances
  FOR EACH ROW EXECUTE FUNCTION public.sync_play_owner_assignee();

-- ---------------------------------------------------------------------
-- 3. The owner's own row cannot be deleted while they are the owner.
--
-- Without this, one DELETE undoes the invariant section 2 exists to
-- create, and the six reads that no longer test owner_user_id would stop
-- seeing the owner on their own task. The service refuses this too; this
-- is the copy that holds when someone is in psql at 2am.
--
-- ── WHY IT TESTS FOR THE PARENT ──────────────────────────────────────
--
-- project_play_assignees.instance_id is ON DELETE CASCADE (2026_109), so
-- deleting a task deletes its assignee rows — and this trigger fires for
-- each of them. During that cascade the parent row is going away, and a
-- guard that only compared user ids would abort the delete of any task
-- that had an owner.
--
-- The EXISTS below is therefore doing two jobs: it refuses the delete
-- when the task is still there and this person still owns it, and it
-- permits it when the task itself is being removed. Same class of
-- problem as the NO ACTION / RESTRICT choice in 2026_136 — the guard has
-- to know the difference between "you may not do this" and "this is
-- already being cleaned up".
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_play_owner_assignee() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project_play_instances p
     WHERE p.id = OLD.instance_id
       AND p.owner_user_id = OLD.user_id
  ) THEN
    RAISE EXCEPTION
      'Cannot unassign the owner of a task. Change the owner first.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS trg_protect_play_owner_assignee
  ON public.project_play_assignees;
CREATE TRIGGER trg_protect_play_owner_assignee
  BEFORE DELETE ON public.project_play_assignees
  FOR EACH ROW EXECUTE FUNCTION public.protect_play_owner_assignee();

-- ---------------------------------------------------------------------
-- 4. Say so in the schema.
--
-- The table carried no comment and read as dead for four migrations.
-- Anyone who greps it next should not have to reconstruct that history
-- from playReview.service.js.
-- ---------------------------------------------------------------------
COMMENT ON TABLE public.project_play_assignees IS
  'Everyone assigned to a task: who works on it and may log daily work '
  'against it. Created empty by 2026_109 and unreachable from any route '
  'until 2026_141, which backfilled it and made it authoritative. The '
  'task''s owner_user_id ALWAYS has a row here '
  '(trg_sync_play_owner_assignee), so reads test this table alone and '
  'never owner_user_id. Removing someone is always explicit; changing '
  'the owner does not unassign the previous one.';

COMMIT;

-- =====================================================================
-- VERIFY (run after COMMIT; all should come back clean)
-- =====================================================================
--
-- 1. Every owned task has its owner assigned. MUST be 0.
--
--   SELECT count(*) FROM project_play_instances p
--    WHERE p.owner_user_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM project_play_assignees a
--                       WHERE a.instance_id = p.id
--                         AND a.user_id = p.owner_user_id);
--
-- 2. No assignee row points at a task in another org. There is no org_id
--    on this table — instance_id implies the org, exactly as
--    uq_dwi_owner_play relies on play ids being globally unique. MUST be 0.
--
--   SELECT count(*) FROM project_play_assignees a
--    WHERE NOT EXISTS (SELECT 1 FROM project_play_instances p
--                       WHERE p.id = a.instance_id);
--
-- 3. Both triggers are attached. Expect 2 rows.
--
--   SELECT tgname, tgrelid::regclass FROM pg_trigger
--    WHERE tgname IN ('trg_sync_play_owner_assignee',
--                     'trg_protect_play_owner_assignee');
--
-- 4. The 2026_110 unique key is still the thing the upserts land on.
--
--   SELECT conname FROM pg_constraint
--    WHERE conname = 'project_play_assignees_instance_id_user_id_key';
--
-- 5. Behavioural — run scripts/verify_multi_assignee_141.js, which proves:
--    a second row for the same (task, person) is rejected; a non-member
--    is refused; changing the owner adds the new one and KEEPS the old;
--    deleting the owner's assignee row is refused; deleting the TASK
--    still cascades its assignee rows away; and closing a task closes
--    the linked daily work items of every assignee, not just the owner.
--
-- =====================================================================
-- Deploy notes — what breaks if a piece is missing
--
-- 1. Without section 1, the read-path change hides every pre-existing
--    task from its own owner. This is the ordering that matters: the
--    backfill must be committed before the service is deployed.
--
-- 2. Without section 2, the invariant lasts exactly until the next owner
--    change, and the failure is invisible — the task simply stops
--    appearing on someone's My day with no error anywhere.
--
-- 3. Without section 3, a single DELETE reopens the same hole.
--
-- 4. Applying this migration is INVISIBLE in the product until the
--    service reads the table. Schema first, verified, then the module —
--    the same order 2026_136 used.
-- =====================================================================
