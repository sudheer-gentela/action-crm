-- 2026_12_scheduled_sends.sql
--
-- Level 2 "scheduled auto-send" support.
--
-- Adds two new sequence_step_logs statuses to the existing check constraint:
--   'scheduled' — an auto-send email materialized AHEAD of its send time so the
--                 rep can see (and edit) the queued email and its
--                 scheduled_send_at. Editable; the timer is fixed.
--   'sending'   — transient claim state. The firer flips 'scheduled' → 'sending'
--                 atomically before dispatching, so overlapping cron ticks can't
--                 double-send. A reaper (SequenceStepFirer.reapStaleSending)
--                 fails+pauses any row stuck here past 30 min.
--
-- Lifecycle: scheduled → sending → sent | failed   (skipped on cancel/reply/stop)
--
-- Indexes:
--   idx_seq_step_logs_scheduled  — due-scan + the GET /scheduled reader.
--   uq_seq_step_logs_pending     — at most ONE pending (scheduled/sending) row
--                                  per (enrollment_id, sequence_step_id). Makes
--                                  materialize idempotent and prevents dup rows
--                                  across overlapping top-up passes / the firer
--                                  fallback INSERT.
--
-- Safe to run more than once. Because 'scheduled'/'sending' do not exist before
-- this migration, no rows can yet carry them, so the UNIQUE index build cannot
-- collide with existing data.
--
-- Dry-run: run inside the transaction below and `ROLLBACK` instead of `COMMIT`
-- to verify it applies cleanly without persisting.

BEGIN;

-- 1. Widen the status check constraint (drop + re-add with the two new values).
ALTER TABLE public.sequence_step_logs
  DROP CONSTRAINT IF EXISTS sequence_step_logs_status_check;

ALTER TABLE public.sequence_step_logs
  ADD CONSTRAINT sequence_step_logs_status_check
  CHECK (status::text = ANY (ARRAY[
    'draft'::character varying,
    'sent'::character varying,
    'completed'::character varying,
    'replied'::character varying,
    'skipped'::character varying,
    'active'::character varying,
    'failed'::character varying,
    'scheduled'::character varying,
    'sending'::character varying
  ]::text[]));

-- 2. Due-scan / reader index for scheduled rows.
CREATE INDEX IF NOT EXISTS idx_seq_step_logs_scheduled
  ON public.sequence_step_logs (scheduled_send_at)
  WHERE status::text = 'scheduled'::text;

-- 3. One pending row per (enrollment, step). Backs ON CONFLICT in materialize
--    and the firer's fallback INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seq_step_logs_pending
  ON public.sequence_step_logs (enrollment_id, sequence_step_id)
  WHERE status::text = ANY (ARRAY['scheduled'::text, 'sending'::text]);

COMMIT;
