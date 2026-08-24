-- =====================================================================
-- 2026_130_play_review_workflow.sql
--
-- The review loop on a project checklist task.
--
--   assignee  →  in_review  →  manager approves  →  completed/skipped/cancelled
--                     ↑                 │
--                     └──── rejects ────┘  (back to in_progress)
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────
--
--   1. 'in_review' as a first-class status, so a project can be asked
--      "what is sitting with me to review?" as a query rather than by
--      eyeballing a checklist. It is deliberately NOT a flag on top of
--      in_progress — a flag would keep those tasks mixed into the
--      in-progress count everywhere and the question would stay
--      unanswerable.
--
--   2. review_target_status. 'in_review' alone does not say what is
--      being ASKED for. A submission can be a request to complete, to
--      skip, or to cancel, and the manager needs to know which before
--      they approve. Without this column the three requests are
--      indistinguishable once submitted.
--
--   3. review_evidence. Evidence is now captured at SUBMISSION, not at
--      completion — a manager cannot judge a submission with nothing to
--      look at. Carried through to completion so approval does not
--      demand it a second time.
--
--   4. fired_action_ids. Completing a play fires the next play and
--      unblocks dependents, both of which create rows in `actions`. If a
--      manager then rejects that completion, those actions must be
--      withdrawn or the project shows work queued off a completion that
--      has been revoked. Nothing recorded WHICH actions a given
--      completion produced, so nothing could withdraw them. This column
--      is that record.
--
--   5. project_play_status_transitions — the audit trail. A status that
--      can move backwards needs one: without it, a task that went
--      in_progress → in_review → in_progress → in_review reads in the
--      database as though it had never left in_progress, and the reason
--      the manager gave the first time is gone.
--
--   6. project_play_watchers — the per-project people alerted alongside
--      the Project Manager. Per project by design; the org-wide default
--      lives in organizations.settings->'project_access' and is copied
--      in, not read through, so changing the org default never silently
--      re-points alerts on a project already running.
--
-- ── NOT DONE HERE ────────────────────────────────────────────────────
--
--   PlaybookPlayService.completePlayForProject() and skipPlayForProject()
--   both guard on `status IN ('not_started','in_progress','blocked',
--   'snoozed')`. Neither includes 'in_review', so approving out of review
--   would silently match zero rows and raise "Play instance not found or
--   already completed". Those two guards MUST be widened in the same
--   deploy as this migration.
--
--   Likewise _resolveDependenciesForProject() reads project_play_assignees
--   to decide who owns an unblocked play. Nothing populates that table for
--   projects — reassignPlayForProject() is its only writer and no route
--   reaches it — so unblocked plays currently land in nobody's queue. It
--   must be repointed at project_play_instances.owner_user_id.
--
-- Run AFTER 2026_129.
--   psql "$DATABASE_URL" -f 2026_130_play_review_workflow.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

BEGIN;

-- ---------------------------------------------------------------------
-- 1. 'in_review' joins the status vocabulary.
--
-- Recreated rather than ALTERed: a CHECK constraint has no ADD VALUE.
-- Every existing value is carried over verbatim — this widens the set,
-- it never narrows it, so no existing row can be invalidated.
-- ---------------------------------------------------------------------
ALTER TABLE public.project_play_instances
  DROP CONSTRAINT IF EXISTS project_play_instances_status_check;

ALTER TABLE public.project_play_instances
  ADD CONSTRAINT project_play_instances_status_check
  CHECK (status = ANY (ARRAY[
    'not_started'::text, 'in_progress'::text, 'blocked'::text,
    'snoozed'::text, 'in_review'::text, 'completed'::text,
    'skipped'::text, 'cancelled'::text
  ]));

-- ---------------------------------------------------------------------
-- 2. Review state on the instance.
--
-- All four columns are NULL for a task that is not under review and are
-- cleared on approve and on reject. They describe an in-flight
-- submission, not history — history is the transitions table below.
-- ---------------------------------------------------------------------
ALTER TABLE public.project_play_instances
  ADD COLUMN IF NOT EXISTS review_target_status text,
  ADD COLUMN IF NOT EXISTS review_submitted_at  timestamp with time zone,
  ADD COLUMN IF NOT EXISTS review_submitted_by  integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS review_evidence      jsonb,
  ADD COLUMN IF NOT EXISTS fired_action_ids     integer[];

ALTER TABLE public.project_play_instances
  DROP CONSTRAINT IF EXISTS project_play_instances_review_target_chk;
ALTER TABLE public.project_play_instances
  ADD CONSTRAINT project_play_instances_review_target_chk
  CHECK (review_target_status IS NULL
         OR review_target_status = ANY (ARRAY['completed'::text, 'skipped'::text, 'cancelled'::text]));

-- A task sitting in review must say what it is asking for. Enforced in
-- the database and not only in the service: a row in 'in_review' with a
-- NULL target is one a manager cannot act on, and it would be created by
-- any future write path that forgets the column.
ALTER TABLE public.project_play_instances
  DROP CONSTRAINT IF EXISTS project_play_instances_review_complete_chk;
ALTER TABLE public.project_play_instances
  ADD CONSTRAINT project_play_instances_review_complete_chk
  CHECK (status <> 'in_review' OR review_target_status IS NOT NULL);

COMMENT ON COLUMN public.project_play_instances.review_target_status IS
  'What the submitter is asking for: completed | skipped | cancelled. '
  'NULL unless status = ''in_review''. As of 2026_130.';
COMMENT ON COLUMN public.project_play_instances.review_evidence IS
  'Evidence captured at submission ({snippet, ...}). Carried into '
  'completion_evidence on approval so approval does not re-demand it.';
COMMENT ON COLUMN public.project_play_instances.fired_action_ids IS
  'actions.id rows created as a CONSEQUENCE of this play completing '
  '(next-play chain + dependents unblocked). Cancelled when a completion '
  'is rejected, un-cancelled if it is later re-approved.';

-- The "what is waiting on me" query this whole feature exists to serve.
CREATE INDEX IF NOT EXISTS idx_ppi_in_review
  ON public.project_play_instances (org_id, handover_id)
  WHERE status = 'in_review';

-- ---------------------------------------------------------------------
-- 3. Transition audit.
--
-- Append-only by convention (no UPDATE path in the service). Deliberately
-- NOT a trigger on project_play_instances: a trigger would record every
-- status write including the ones the playbook engine makes when
-- instantiating a stage, and drown the human decisions this exists to
-- preserve. The service writes here on the review path only.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_play_status_transitions (
  id                       serial PRIMARY KEY,
  org_id                   integer NOT NULL
                             REFERENCES public.organizations(id) ON DELETE CASCADE,
  handover_id              integer NOT NULL,
  project_play_instance_id integer NOT NULL
                             REFERENCES public.project_play_instances(id) ON DELETE CASCADE,
  from_status              text NOT NULL,
  to_status                text NOT NULL,
  -- The requested end state on a submission. NULL on an approve/reject,
  -- where to_status already says what happened.
  target_status            text,
  actor_id                 integer REFERENCES public.users(id) ON DELETE SET NULL,
  -- Required on a rejection by the service. A rejection with no reason is
  -- the thing this feature exists to prevent.
  reason                   text,
  evidence                 jsonb,
  created_at               timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ppst_instance
  ON public.project_play_status_transitions (project_play_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppst_handover
  ON public.project_play_status_transitions (org_id, handover_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 4. Per-project review watchers.
--
-- Who is alerted alongside the Project Manager when a task on THIS
-- project moves through review. The Project Manager
-- (sales_handovers.assigned_service_owner_id) and the creator are always
-- notified and are deliberately NOT rows here — a membership table that
-- can be emptied must not be able to silence the two people accountable
-- for the project.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_play_watchers (
  id          serial PRIMARY KEY,
  org_id      integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  handover_id integer NOT NULL,
  user_id     integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_by  integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (handover_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ppw_handover
  ON public.project_play_watchers (org_id, handover_id);

COMMIT;

-- =====================================================================
-- VERIFY (run after COMMIT; all three should come back clean)
-- =====================================================================
-- 1. The widened status set is in place:
--      SELECT pg_get_constraintdef(oid) FROM pg_constraint
--       WHERE conname = 'project_play_instances_status_check';
--
-- 2. No row is stranded in review with nothing to approve (expect 0):
--      SELECT count(*) FROM project_play_instances
--       WHERE status = 'in_review' AND review_target_status IS NULL;
--
-- 3. 'system' is available as a note_type, since the reject path writes
--    the manager's reason into play_notes (expect it in the CHECK):
--      SELECT pg_get_constraintdef(oid) FROM pg_constraint
--       WHERE conname LIKE 'play_notes_note_type%';
-- =====================================================================
