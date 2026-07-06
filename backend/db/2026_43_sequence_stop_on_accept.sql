-- ============================================================================
-- 2026_43_sequence_stop_on_accept.sql
--
-- WS2 — auto-stop enrollments when the LinkedIn connection is accepted.
--
-- Adds sequences.stop_on_connection_accept (per-sequence toggle, DEFAULT
-- false so no existing sequence changes behavior). When true, the
-- SequenceStepFirer stops an active enrollment the moment it observes a
-- connection acceptance that happened AFTER enrollment:
--
--   sequence_enrollments.status      = 'connected'
--   sequence_enrollments.stop_reason = 'connection_accepted'
--   pending scheduled/'sending' step-log rows → 'skipped'
--
-- 'connected' is a NEW terminal enrollment status, symmetric with 'replied'
-- (agreed 2026-07-06: "connected is fine if the actual reason is
-- connected"). No enrollment schema change needed — status is varchar(50),
-- stop_reason varchar(100), and idx_seq_enrollments_status_due is a partial
-- index on status='active' so terminal rows never touch it.
--
-- Post-enrollment guard: the firer only stops when
-- channel_data.linkedin.connected_at > enrolled_at. Enrolling an
-- already-connected prospect into a stop-on-accept sequence therefore does
-- NOT insta-stop (re-engagement sequences keep working).
--
-- Rollback:
--   ALTER TABLE sequences DROP COLUMN IF EXISTS stop_on_connection_accept;
--   -- Optional: revert stopped enrollments (audit first!):
--   -- UPDATE sequence_enrollments SET status='stopped'
--   --  WHERE status='connected' AND stop_reason='connection_accepted';
-- ============================================================================

BEGIN;

ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS stop_on_connection_accept boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sequences.stop_on_connection_accept IS
  'When true, the firer stops active enrollments (status=connected, stop_reason=connection_accepted) once the prospect''s LinkedIn connection is accepted after enrollment, and skips their pending step-log rows. Default false — opt-in per sequence from the builder UI.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'sequences' AND column_name = 'stop_on_connection_accept';
