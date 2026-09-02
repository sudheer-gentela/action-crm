-- =====================================================================
-- 2026_136_task_linked_daily_work.sql
--
-- Links a daily work item to a project task, so that someone working on a
-- task says what they did ONCE and it appears in their My day, on their
-- manager's People screen, and against the task on the project.
--
-- ── THE SHAPE ────────────────────────────────────────────────────────
--
-- ONE daily work item per (person, task). Created the first time that
-- person posts an update on that task; closed when the task closes, or
-- when the project the task belongs to closes or is retired.
--
-- The item is anchored to the PROJECT, not the task — anchor_kind stays
-- 'handover' and chk_dwi_anchor_kind is untouched. The task link is a
-- separate column. "Daily work is not anchored to a task" holds
-- literally: the anchor field still names the project and the anchor
-- picker (dailyWork.getAnchorOptions) is unchanged.
--
-- ── WHY THE TEXT LIVES IN EXACTLY ONE ROW ────────────────────────────
--
-- play_notes is APPEND-ONLY, enforced by play_notes_append_only():
-- "the only permitted update is a deletion. Post a correcting note
-- instead." daily_work_entries are MUTABLE — upserted by saveDay,
-- carrying last_edited_by, updated_at and written_on.
--
-- Copying the text into both would make one of those integrity models a
-- lie. So there is one row, a daily_work_entries row, and the task reads
-- it. Editing from either screen edits the same row: nothing to
-- reconcile, no sync to drift.
--
-- play_notes is NOT replaced. It keeps carrying blockers, decisions and
-- system events, which genuinely should be immutable.
--
-- What protects the project's record is the write path that already
-- exists. Only two statements in the whole backend touch
-- daily_work_entries: the upsert in saveDay and the activity_type_key-only
-- UPDATE in mergeActivityType. saveDay refuses any date outside
-- today − BACKFILL_DAYS … today, and refuses a blank description before
-- the upsert. Inside that window an edit is a correction, attributed by
-- last_edited_by; outside it there is no code path that accepts a change.
-- No new rule is needed here.
--
-- ── WHY THE LINK IS ON THE ITEM, NOT THE ENTRY ───────────────────────
--
-- An item corresponds to exactly one task, so an entry-level column
-- would carry the same value on every entry of that item and would admit
-- states where the two disagree.
--
-- ── WHAT THIS MIGRATION DOES NOT TOUCH ───────────────────────────────
--
-- No change to daily_work_items.anchor_kind or its CHECK. No change to
-- daily_work_entries, play_notes or play_evidence. No column is added to
-- project_play_instances — estimate ranges were considered and dropped:
-- the plan is dates, and a duration that nothing consumes at freeze time
-- is a number that goes stale in the schema.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The link.
--
-- ── ON DELETE: NO ACTION, DELIBERATELY, NOT RESTRICT ─────────────────
--
-- Both refuse to let a task be deleted while someone's logged work
-- points at it, which is the behaviour wanted: removePlay() hard-deletes
-- ad-hoc tasks, and every bulk-imported task is ad-hoc (play_id and
-- playbook_id NULL). Deleting one must not take somebody's day with it.
--
-- The difference is WHEN the check runs, and it matters here. RESTRICT
-- fires immediately, even when the referencing row is itself being
-- removed by another cascade in the same statement. NO ACTION defers to
-- end of statement, by which time that cascade has run.
--
-- This codebase has exactly that case. organizations -> daily_work_items
-- is ON DELETE CASCADE (2026_131), and organizations -> sales_handovers
-- -> project_play_instances is ON DELETE CASCADE as well. Deleting an
-- organization therefore removes both sides in one statement. Under
-- RESTRICT that delete would abort depending on which cascade Postgres
-- happened to process first; under NO ACTION it succeeds, because by the
-- time the constraint is checked there is nothing left referencing
-- anything.
--
-- So: NO ACTION at the schema level, and a sentence a human can read in
-- removePlay() — "two people have logged work against this task" — so
-- the ordinary case never reaches the constraint at all. A raw FK
-- violation surfacing in the Projects UI would be the failure this pair
-- exists to avoid.
-- ---------------------------------------------------------------------
ALTER TABLE public.daily_work_items
  ADD COLUMN IF NOT EXISTS play_instance_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'daily_work_items_play_instance_fkey'
       AND conrelid = 'public.daily_work_items'::regclass
  ) THEN
    ALTER TABLE public.daily_work_items
      ADD CONSTRAINT daily_work_items_play_instance_fkey
      FOREIGN KEY (play_instance_id)
      REFERENCES public.project_play_instances(id);   -- ON DELETE NO ACTION
  END IF;
END $$;

COMMENT ON COLUMN public.daily_work_items.play_instance_id IS
  'The project task this item tracks. NULL for ordinary items. Set once at '
  'creation and never moved: the link cannot be severed or repointed, because '
  'a second way for the project record and the person''s log to disagree is '
  'exactly what one shared row exists to prevent. As of 2026_136.';

-- ---------------------------------------------------------------------
-- 2. One item per person per task.
--
-- PARTIAL, so the thousands of ordinary items — every one of which has
-- play_instance_id NULL — stay out of the index entirely. A plain UNIQUE
-- would also work, since NULLs do not collide by default, but it would
-- carry every row in the table to enforce a rule that applies to a
-- minority of them.
--
-- (owner_user_id, play_instance_id) rather than
-- (org_id, owner_user_id, play_instance_id): project_play_instances.id is
-- a global serial, so a task id already implies its org. The org column
-- is still carried on the row and every query predicates on it.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_dwi_owner_play
  ON public.daily_work_items (owner_user_id, play_instance_id)
  WHERE play_instance_id IS NOT NULL;

-- The lookup the other direction: given a task, find its items. Used by
-- both triggers below and by the days-logged column on plan vs actual.
-- The unique index above leads with owner_user_id and cannot serve it.
CREATE INDEX IF NOT EXISTS idx_dwi_play_instance
  ON public.daily_work_items (play_instance_id)
  WHERE play_instance_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. A linked item is assigned work.
--
-- chk_dwi_status_by_kind gives 'assigned' the statuses
-- yet_to_start | in_progress | in_review | completed | dropped, and
-- 'recurring' only active | retired. The triggers below close a linked
-- item by writing 'completed' or 'dropped', which are legal for
-- 'assigned' and illegal for 'recurring' — so without this constraint a
-- linked recurring item would make the trigger raise a check violation
-- from inside an unrelated task update, which is a very hard failure to
-- read.
--
-- It is also the right rule on its own terms. A task is a finite
-- deliverable; that is what 'assigned' means here.
-- ---------------------------------------------------------------------
ALTER TABLE public.daily_work_items
  DROP CONSTRAINT IF EXISTS chk_dwi_linked_is_assigned;
ALTER TABLE public.daily_work_items
  ADD CONSTRAINT chk_dwi_linked_is_assigned
  CHECK (play_instance_id IS NULL OR kind = 'assigned');

-- ---------------------------------------------------------------------
-- 4. Closing a task closes its items.
--
-- ── WHY A TRIGGER AND NOT AN APPLICATION HOOK ────────────────────────
--
-- Because there is no single writer of a task's status to hook into. At
-- the time of writing, a task reaches a terminal state through at least:
--
--   handover.service.completePlay -> PlaybookPlayService
--   playReview.service            — four separate statements
--   handover.service.setPlaybook(replace = true) — bulk-cancels every
--                                   open play when a playbook is swapped
--   PlaybookPlayService           — activation and reset paths
--
-- Six-plus call sites today, and the seventh will be added by someone
-- who has never read this file. An item left open against a closed task
-- reappears on that person's My day every morning with no way to retire
-- it — updateItem refuses to retire a linked item on purpose — so the
-- cost of missing one path is a permanent ghost row.
--
-- The precedent is trg_reschedule_go_live: AFTER UPDATE OF <column> on
-- the table that owns the fact, doing the derived write in one place.
--
-- ── DIRECTION ────────────────────────────────────────────────────────
--
-- ONE WAY ONLY. The task drives the item. Nothing here ever writes a
-- task's status, and posting a daily update never closes a task —
-- saveDay refuses 'completed' and 'dropped' on a linked item, so
-- completion keeps passing through whatever gating, review and evidence
-- rules apply to that project.
--
-- ── MAPPING ──────────────────────────────────────────────────────────
--
--   task completed             -> item 'completed'
--   task skipped or cancelled  -> item 'dropped'
--
-- Both are terminal for an assigned item. Items already terminal are
-- left alone, so a task reopened and re-closed does not move a closed_at
-- that was already right.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_daily_work_items_for_play() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- Statement-level no-ops are common on this table: due-date shifts,
  -- sort_order rewrites and baseline promotion all UPDATE rows without
  -- touching status. AFTER UPDATE OF status still fires for those if the
  -- column is in the SET list at all, so the comparison is what actually
  -- decides.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  IF NEW.status NOT IN ('completed', 'skipped', 'cancelled') THEN
    RETURN NULL;
  END IF;

  UPDATE public.daily_work_items
     SET status     = CASE WHEN NEW.status = 'completed'
                           THEN 'completed' ELSE 'dropped' END,
         closed_at  = now(),
         updated_at = now()
   WHERE play_instance_id = NEW.id
     AND org_id = NEW.org_id
     AND status NOT IN ('completed', 'dropped');

  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_close_daily_work_items_for_play
  ON public.project_play_instances;
CREATE TRIGGER trg_close_daily_work_items_for_play
  AFTER UPDATE OF status ON public.project_play_instances
  FOR EACH ROW EXECUTE FUNCTION public.close_daily_work_items_for_play();

-- ---------------------------------------------------------------------
-- 5. Closing or retiring a PROJECT closes its tasks' items.
--
-- ── WHY THIS SECOND TRIGGER IS NOT REDUNDANT ─────────────────────────
--
-- Completing, cancelling or retiring a project does NOT cascade to its
-- tasks — verified: updateStatus() writes sales_handovers only, and
-- retire() writes retired_at only. The tasks stay open by design.
--
-- Every read the person sees, though, already excludes them.
-- getPersonProjectItems filters on
--   h.status NOT IN ('completed','cancelled') AND h.retired_at IS NULL,
-- so the task vanishes from "My project work" the moment the project
-- closes. Without this trigger the linked item would survive that
-- vanishing: still open on My day, still counted, with the task that was
-- its only route to closure now invisible and never reaching a terminal
-- status of its own. A row nobody can see the reason for and nobody can
-- retire.
--
-- ── MAPPING ──────────────────────────────────────────────────────────
--
--   project completed              -> item 'completed'
--   project cancelled or retired   -> item 'dropped'
--
-- Retirement is a TIMESTAMP, not a seventh status (2026_133), which is
-- why this trigger watches both columns. A retired initiative's status
-- is typically still 'in_progress', so the CASE below falls to 'dropped'
-- for it, which is right: the work stopped, it did not finish.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_daily_work_items_for_project() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  IF NOT (
       (NEW.status IN ('completed', 'cancelled')
        AND NEW.status IS DISTINCT FROM OLD.status)
    OR (NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL)
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.daily_work_items i
     SET status     = CASE WHEN NEW.status = 'completed'
                           THEN 'completed' ELSE 'dropped' END,
         closed_at  = now(),
         updated_at = now()
   WHERE i.org_id = NEW.org_id
     AND i.play_instance_id IS NOT NULL
     AND i.status NOT IN ('completed', 'dropped')
     AND EXISTS (
           SELECT 1 FROM public.project_play_instances p
            WHERE p.id = i.play_instance_id
              AND p.handover_id = NEW.id
              AND p.org_id = NEW.org_id);

  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_close_daily_work_items_for_project
  ON public.sales_handovers;
CREATE TRIGGER trg_close_daily_work_items_for_project
  AFTER UPDATE OF status, retired_at ON public.sales_handovers
  FOR EACH ROW EXECUTE FUNCTION public.close_daily_work_items_for_project();

COMMIT;

-- =====================================================================
-- VERIFY (run after COMMIT; all should come back clean)
-- =====================================================================
--
-- 1. The column, the constraint and the two indexes exist. Expect 1 row
--    with linked_is_assigned = t, and 2 index rows.
--
--   SELECT count(*) FILTER (WHERE conname = 'chk_dwi_linked_is_assigned') = 1
--            AS linked_is_assigned
--     FROM pg_constraint WHERE conrelid = 'daily_work_items'::regclass;
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'daily_work_items'
--      AND indexname IN ('uq_dwi_owner_play', 'idx_dwi_play_instance');
--
-- 2. The foreign key is NO ACTION, not RESTRICT or CASCADE. confdeltype
--    must be 'a'. ('r' = RESTRICT, 'c' = CASCADE, 'n' = SET NULL.)
--
--   SELECT conname, confdeltype FROM pg_constraint
--    WHERE conname = 'daily_work_items_play_instance_fkey';
--
-- 3. Both triggers are attached. Expect 2 rows.
--
--   SELECT tgname, tgrelid::regclass FROM pg_trigger
--    WHERE tgname IN ('trg_close_daily_work_items_for_play',
--                     'trg_close_daily_work_items_for_project');
--
-- 4. Nothing existing was disturbed. Every current item is unlinked, and
--    the anchor CHECK is unchanged. Both must return 0.
--
--   SELECT count(*) FROM daily_work_items WHERE play_instance_id IS NOT NULL;
--
--   SELECT count(*) FROM daily_work_items
--    WHERE play_instance_id IS NOT NULL AND kind <> 'assigned';
--
-- 5. Behavioural checks — run scripts/verify_task_linked_136.js, which
--    proves: the unique index rejects a second item for the same
--    (person, task) and permits one per person; the CHECK rejects a
--    linked recurring item; completing a task closes its items as
--    'completed' and cancelling closes them as 'dropped'; retiring a
--    project closes items on its tasks; an already-closed item is not
--    re-closed; and deleting a task with a linked item is refused.
--
-- =====================================================================
-- Deploy notes — what breaks if a piece is missing
--
-- 1. Without chk_dwi_linked_is_assigned, a linked recurring item makes
--    both triggers raise chk_dwi_status_by_kind from inside a task
--    update — the completion fails, and the error names a constraint on
--    a table the person was not touching.
--
-- 2. Without idx_dwi_play_instance, both triggers sequential-scan
--    daily_work_items on every task closure, and the days-logged column
--    on plan vs actual does it once per task on the page.
--
-- 3. Without the project trigger, closing a project leaves live items
--    against tasks that are no longer reachable from any screen, and
--    updateItem refuses to retire them.
--
-- 4. With ON DELETE RESTRICT instead of NO ACTION, deleting an
--    organization can fail on this constraint. See section 1.
--
-- 5. Nothing here changes any read. Until the service writes
--    play_instance_id, applying this migration is invisible in the
--    product — schema first, verified, then the module.
-- =====================================================================
