-- 2026_17_draft_approval.sql
--
-- "Approve & queue" for manual-review (require_approval) sequences.
--
-- Lets a rep approve drafted emails for PACED sending instead of firing them
-- immediately. Approval flips a 'draft' row to a pending 'scheduled' row
-- (the same status the auto-send queue uses), so the firer's existing send
-- branch delivers it honoring per-account min-delay cooldown, daily limit,
-- and send window — rotating senders — exactly like autopilot.
--
-- 'Send Now' (POST /sequences/drafts/:logId/send) is unchanged: it remains an
-- immediate human override that bypasses the cooldown (daily limit still
-- enforced).
--
-- This migration only adds two nullable audit columns. The functional change
-- (draft -> scheduled) reuses columns/statuses that already exist:
--   * status 'scheduled'      (added in 2026_12_scheduled_sends.sql)
--   * scheduled_send_at        (already present)
--   * uq_seq_step_logs_pending (already enforces one pending row per step)
--
-- Safe to run more than once.

BEGIN;

ALTER TABLE public.sequence_step_logs
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by integer;

COMMENT ON COLUMN public.sequence_step_logs.approved_at IS
  'When a rep approved this draft for paced sending (draft -> scheduled). NULL for auto-send rows.';
COMMENT ON COLUMN public.sequence_step_logs.approved_by IS
  'users.id of the rep who approved the draft for paced sending. NULL for auto-send rows.';

COMMIT;
