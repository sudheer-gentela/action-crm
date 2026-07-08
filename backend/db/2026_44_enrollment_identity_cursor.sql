-- 2026_44_enrollment_identity_cursor.sql
--
-- Foundation for both propagation modes (live default + freeze opt-in).
-- Replaces the fragile ordinal cursor (current_step === step_order) with an
-- identity cursor, and adds a per-enrollment snapshot for frozen enrollments.
--
--   current_step_id       — the actual sequence_steps.id the prospect is on.
--                           ON DELETE SET NULL so a deleted step doesn't
--                           orphan the enrollment; the resolver re-anchors.
--   current_step_channel  — denormalized channel of the current step, so the
--                           firer's hot due-query no longer needs to join
--                           sequence_steps on step_order = current_step
--                           (which is exactly what breaks after a reorder).
--   steps_snapshot        — ordered plan captured at edit time for orgs on
--                           'freeze' propagation. NULL => resolve live.
--
-- current_step (ordinal) is intentionally KEPT as a denormalized fallback
-- anchor for re-anchoring when a step is deleted.
--
-- ── DRY RUN ────────────────────────────────────────────────────────────────
-- Scope of the backfill (how many active enrollments will get an identity
-- cursor, and how many can't be matched — those keep NULL and fall back to
-- the ordinal path in the resolver):
--
--   SELECT
--     count(*) FILTER (WHERE ss.id IS NOT NULL)  AS will_backfill,
--     count(*) FILTER (WHERE ss.id IS NULL)      AS unmatched
--   FROM sequence_enrollments se
--   LEFT JOIN sequence_steps ss
--     ON ss.sequence_id = se.sequence_id
--    AND ss.step_order  = se.current_step;
-- ───────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS current_step_id      integer,
  ADD COLUMN IF NOT EXISTS current_step_channel varchar(50),
  ADD COLUMN IF NOT EXISTS steps_snapshot       jsonb;

-- FK added separately so re-runs don't error if the column already existed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrollments_current_step_id_fkey'
  ) THEN
    ALTER TABLE public.sequence_enrollments
      ADD CONSTRAINT sequence_enrollments_current_step_id_fkey
      FOREIGN KEY (current_step_id)
      REFERENCES public.sequence_steps(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill identity cursor + channel from the current ordinal position.
UPDATE public.sequence_enrollments se
   SET current_step_id      = ss.id,
       current_step_channel = ss.channel
  FROM public.sequence_steps ss
 WHERE ss.sequence_id  = se.sequence_id
   AND ss.step_order   = se.current_step
   AND se.current_step_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_seq_enroll_current_step_id
  ON public.sequence_enrollments (current_step_id);

-- To dry-run: replace COMMIT with ROLLBACK, run the DRY RUN SELECT above,
-- then re-run with COMMIT.
COMMIT;
