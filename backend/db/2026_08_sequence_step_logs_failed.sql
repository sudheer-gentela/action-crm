-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: sequence_step_logs.status += 'failed'
-- Sprint 4 (Group C) — corrected after first deploy attempt
-- ─────────────────────────────────────────────────────────────────────────────
-- Allowed values in production today (per row counts on 2026-05-22):
--   'sent'      — email draft was dispatched (the success state for email steps)
--   'draft'     — pending rep review
--   'completed' — non-email step marked done by rep (call / LinkedIn / task)
--   'skipped'   — draft discarded by rep
--
-- Older / legacy values still permitted by the existing constraint but not
-- observed in current data: 'active', 'replied'. We keep both in the new
-- allowed list to avoid breaking any code path that still writes them.
--
-- Adds: 'failed' (Sprint 4 — SequenceStepFirer per-step catch writes here)
--
-- Also adds an error_message TEXT column where the failure detail can live.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE sequence_step_logs
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Drop the existing status CHECK constraint, regardless of name.
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

-- Recreate with the full set of statuses actually in use, plus 'failed'.
ALTER TABLE sequence_step_logs
  ADD CONSTRAINT sequence_step_logs_status_check
  CHECK (status IN (
    'draft',      -- pending rep review
    'sent',       -- email dispatched (success for email steps)
    'completed',  -- non-email step marked done (call / LinkedIn / task)
    'replied',    -- prospect replied; enrollment auto-stopped
    'skipped',    -- draft discarded by rep
    'active',     -- legacy; retained for back-compat
    'failed'      -- new — written by SequenceStepFirer's per-step catch
  ));

-- Health-query index. Covers the rows the /sequences/health endpoint scans.
CREATE INDEX IF NOT EXISTS idx_sequence_step_logs_health
  ON sequence_step_logs (org_id, status, fired_at DESC)
  WHERE status IN ('failed', 'draft', 'sent', 'completed');

COMMIT;
