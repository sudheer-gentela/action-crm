-- =====================================================================
-- 2026_120_play_notes.sql
--
-- Notes on a project checklist task.
--
-- THE GAP
--   A task carries a completion_note (one field, written once, at the
--   moment it is closed) and play_evidence (a WhatsApp message accepted
--   as proof). Neither is a running commentary. There is nowhere to put
--   "waiting on the client's drawings", "revised approach agreed on the
--   call", "this slipped because the crane was double-booked" — the
--   sentences a Project Manager reads six weeks later when they are
--   trying to work out what happened.
--
--   So that context currently lives in WhatsApp, and Plan vs Actual can
--   show that a task ran eleven days late without being able to show why.
--
-- OPEN AND CLOSED TASKS BOTH
--   Notes attach to a task in ANY status. The reviewing case is the
--   stronger one: annotating a finished task is exactly what someone
--   does when a project is being written up. There is deliberately no
--   status predicate anywhere in this feature.
--
-- APPEND-ONLY, LIKE case_notes
--   Same column shape as case_notes / prospect_notes: org_id, parent id,
--   author_id, body, note_type CHECK, is_internal, created_at. A note is
--   never edited — a correction is a second note. Removal is a soft
--   delete so that "Ravi posted this and then withdrew it" survives.
--
-- WHY THE TRIGGER HAS NO DELETE BRANCH
--   play_evidence took the other route: trg_play_evidence_immutable
--   raises on DELETE, while play_evidence_instance_fkey is ON DELETE
--   CASCADE. Those two contradict each other, and the contradiction is
--   live today —
--
--     INSERT INTO project_play_instances (id, ...) VALUES (999, ...);
--     INSERT INTO play_evidence (project_play_instance_id, ...) VALUES (999, ...);
--     DELETE FROM project_play_instances WHERE id = 999;
--     ERROR: play_evidence is append-only: revoke it instead of deleting
--
--   so handover.service.removePlay() cannot delete an ad-hoc task that
--   has evidence on it. (Not fixed here — flagged, and left alone,
--   because changing it is a decision about evidence, not about notes.)
--
--   This trigger therefore guards UPDATE only. Deleting the task takes
--   its notes with it, which is right: the notes are about the task, and
--   without the task they are orphan sentences. The service never issues
--   a hard DELETE against this table.
--
-- Run AFTER 2026_119.
--   psql "$DATABASE_URL" -f 2026_120_play_notes.sql
-- =====================================================================

BEGIN;

-- ── 1. The table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.play_notes (
  id                       serial PRIMARY KEY,
  org_id                   integer NOT NULL
                             REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_play_instance_id integer NOT NULL
                             REFERENCES public.project_play_instances(id) ON DELETE CASCADE,
  author_id                integer
                             REFERENCES public.users(id) ON DELETE SET NULL,
  body                     text NOT NULL,
  note_type                character varying(30) DEFAULT 'comment' NOT NULL,
  is_internal              boolean DEFAULT false NOT NULL,
  created_at               timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at               timestamp with time zone,
  deleted_by               integer
                             REFERENCES public.users(id) ON DELETE SET NULL,

  -- A blank note is not a note. Checked here as well as in the service
  -- because '   ' passes a NOT NULL and reads as data.
  CONSTRAINT play_notes_body_not_blank_chk
    CHECK (btrim(body) <> ''),

  -- 'system' is reserved for machine-written notes (a future automation
  -- recording why it moved a date). The service refuses it from a user,
  -- so a 'system' note is always genuinely one.
  CONSTRAINT play_notes_note_type_check
    CHECK (((note_type)::text = ANY ((ARRAY[
      'comment'::character varying,
      'blocker'::character varying,
      'decision'::character varying,
      'system'::character varying])::text[]))),

  -- Half a deletion is worse than none: a row with deleted_at and no
  -- deleted_by cannot answer the only question a tombstone exists for.
  CONSTRAINT play_notes_delete_shape_chk
    CHECK ((deleted_at IS NULL     AND deleted_by IS NULL)
        OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

COMMENT ON TABLE public.play_notes IS
  'Append-only running commentary on one project checklist task '
  '(project_play_instances). Distinct from project_play_instances.completion_note, '
  'which is the single sentence written when the task is closed, and from '
  'play_evidence, which is an artefact accepted as proof. Notes may be added to a '
  'task in any status, open or closed.';

COMMENT ON COLUMN public.play_notes.is_internal IS
  'TRUE = delivery side only. Hidden from project members whose project_members.side '
  'is ''internal_customer'' — the person who signs the work off. Has no effect on a '
  'customer project: external stakeholders have no login and never read this table.';

COMMENT ON COLUMN public.play_notes.deleted_at IS
  'Soft delete. The row is retained so that a withdrawn note is still attributable; '
  'reads exclude it. Set by the author or by someone who can manage the project.';

-- ── 2. Indexes ───────────────────────────────────────────────────────
--
-- The one hot read is "the live notes on this task, newest first", which
-- this covers end to end. org_id is in the predicate of every service
-- query as defence in depth rather than as a selective filter, so it is
-- deliberately not the leading column.
CREATE INDEX IF NOT EXISTS idx_play_notes_instance
  ON public.play_notes (project_play_instance_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Supports the per-task counts joined onto the checklist and onto Plan
-- vs Actual, which touch every task on a project at once.
CREATE INDEX IF NOT EXISTS idx_play_notes_org
  ON public.play_notes (org_id);

CREATE INDEX IF NOT EXISTS idx_play_notes_author
  ON public.play_notes (author_id);

-- ── 3. Append-only enforcement ───────────────────────────────────────
--
-- UPDATE only — see the header for why DELETE is left to the cascade.

CREATE OR REPLACE FUNCTION public.play_notes_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'play_note % is already deleted and cannot be changed', OLD.id;
  END IF;

  IF NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'play_note % is append-only; the only permitted update is a deletion. Post a correcting note instead.', OLD.id;
  END IF;

  IF NEW.id                       IS DISTINCT FROM OLD.id
     OR NEW.org_id                IS DISTINCT FROM OLD.org_id
     OR NEW.project_play_instance_id IS DISTINCT FROM OLD.project_play_instance_id
     OR NEW.author_id             IS DISTINCT FROM OLD.author_id
     OR NEW.body                  IS DISTINCT FROM OLD.body
     OR NEW.note_type             IS DISTINCT FROM OLD.note_type
     OR NEW.is_internal           IS DISTINCT FROM OLD.is_internal
     OR NEW.created_at            IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'play_note % is immutable; only deleted_at and deleted_by may be set', OLD.id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_play_notes_append_only ON public.play_notes;
CREATE TRIGGER trg_play_notes_append_only
  BEFORE UPDATE ON public.play_notes
  FOR EACH ROW EXECUTE FUNCTION public.play_notes_append_only();

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== Table present? ==='
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'play_notes'
 ORDER BY ordinal_position;

\echo ''
\echo '=== Indexes ==='
SELECT indexname FROM pg_indexes
 WHERE tablename = 'play_notes'
 ORDER BY indexname;

\echo ''
\echo '=== Trigger ==='
SELECT tgname FROM pg_trigger
 WHERE tgrelid = 'public.play_notes'::regclass AND NOT tgisinternal;

\echo ''
\echo '=== Tasks eligible for notes (all statuses, open and closed) ==='
SELECT status, count(*) AS tasks
  FROM public.project_play_instances
 GROUP BY status
 ORDER BY status;
