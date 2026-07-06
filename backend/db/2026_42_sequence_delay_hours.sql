-- ============================================================================
-- 2026_42_sequence_delay_hours.sql
--
-- WS3 — hour-granular sequence step delays.
--
-- Adds sequence_steps.delay_hours ALONGSIDE delay_days (additive, no data
-- migration, no behavior change for existing rows). Effective delay for a
-- step is (delay_days * 24 + delay_hours) hours from the previous step.
--
-- Semantics (agreed 2026-07-06):
--   * delay_hours = 0            → existing behavior, byte-identical.
--                                  Manual channels (linkedin/task/call) snap
--                                  to the org's manualReleaseHour as before.
--   * delay_hours > 0            → the step becomes ELIGIBLE at
--                                  previous-step-time + total delay. Manual
--                                  channels skip the release-hour snap and
--                                  are only clamped FORWARD if the computed
--                                  time lands on a non-allowed send-window
--                                  day. Actual actioning still depends on the
--                                  firer tick (every minute) and, for
--                                  LinkedIn auto-send, the extension poll +
--                                  human-hours window + jitter.
--
-- Constraint: 0–23. Whole days belong in delay_days; keeping hours sub-day
-- keeps the builder UI and the mental model unambiguous.
--
-- Rollback:
--   ALTER TABLE sequence_steps DROP COLUMN IF EXISTS delay_hours;
-- ============================================================================

BEGIN;

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS delay_hours integer NOT NULL DEFAULT 0;

-- Add the range check only if it doesn't exist yet (re-run safe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sequence_steps_delay_hours_chk'
       AND conrelid = 'sequence_steps'::regclass
  ) THEN
    ALTER TABLE sequence_steps
      ADD CONSTRAINT sequence_steps_delay_hours_chk
      CHECK (delay_hours >= 0 AND delay_hours <= 23);
  END IF;
END $$;

COMMENT ON COLUMN sequence_steps.delay_hours IS
  'Sub-day delay (0-23h) added to delay_days. Effective delay = delay_days*24 + delay_hours hours from the previous step. Hours > 0 on a manual channel (linkedin/task/call) bypasses the manualReleaseHour snap: the step is eligible from prev + delay, clamped forward only across disallowed send-window days.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'sequence_steps' AND column_name = 'delay_hours';
-- SELECT conname FROM pg_constraint WHERE conname = 'sequence_steps_delay_hours_chk';
