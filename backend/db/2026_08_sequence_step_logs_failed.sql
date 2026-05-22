-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: sequence_step_logs.status += 'failed'
-- Sprint 4 (Group C)
-- ─────────────────────────────────────────────────────────────────────────────
-- Today's allowed values: 'draft', 'active', 'completed', 'replied'.
-- We add 'failed' so the SequenceStepFirer can write a log row when a per-
-- step send/draft throws, instead of silently logging to console only.
-- Without this, the new sequence-health endpoint has nothing to read.
--
-- Also adds an `error_message TEXT` column where the failure detail can live.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE sequence_step_logs
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Drop and re-add the status CHECK constraint with the expanded value set.
-- Constraint name varies by environment (some orgs run with the implicit
-- name, others have a custom one). Use a DO block that finds it dynamically.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'sequence_step_logs'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE sequence_step_logs DROP CONSTRAINT %I', rec.conname);
    RAISE NOTICE 'Dropped old status check: %', rec.conname;
  END LOOP;
END $$;

ALTER TABLE sequence_step_logs
  ADD CONSTRAINT sequence_step_logs_status_check
  CHECK (status IN ('draft', 'active', 'completed', 'replied', 'failed'));

-- Index for the health query — counts of failed/draft rows in the last 24h/7d.
-- Partial index on the rows we'll actually scan keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_sequence_step_logs_health
  ON sequence_step_logs (org_id, status, fired_at DESC)
  WHERE status IN ('failed', 'draft', 'completed');

COMMIT;
