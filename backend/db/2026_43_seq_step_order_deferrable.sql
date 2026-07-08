-- 2026_43_seq_step_order_deferrable.sql
--
-- Fixes the reorder-crash: the per-row UPDATE loop in
-- POST /api/sequences/:id/steps/reorder collides with the NON-deferrable
-- UNIQUE (sequence_id, step_order) constraint at an intermediate row and
-- 500s + rolls back. Making the constraint DEFERRABLE INITIALLY DEFERRED
-- moves the uniqueness check to COMMIT, so the loop can pass through a
-- temporarily-colliding intermediate state and still land on a valid
-- permutation. No application code change is required for this specific fix.
--
-- Safe: nothing references this constraint as an FK target or ON CONFLICT
-- arbiter (verified against schema.sql). Idempotent via IF EXISTS.
--
-- ── DRY RUN ────────────────────────────────────────────────────────────────
-- Inspect the current constraint before applying:
--
--   SELECT conname, condeferrable, condeferred
--     FROM pg_constraint
--    WHERE conname = 'sequence_steps_sequence_id_step_order_key';
--
-- Expect condeferrable=f, condeferred=f before; t/t after.
-- ───────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.sequence_steps
  DROP CONSTRAINT IF EXISTS sequence_steps_sequence_id_step_order_key;

ALTER TABLE public.sequence_steps
  ADD CONSTRAINT sequence_steps_sequence_id_step_order_key
    UNIQUE (sequence_id, step_order) DEFERRABLE INITIALLY DEFERRED;

-- To dry-run: replace COMMIT with ROLLBACK, run the DRY RUN SELECT, then re-run
-- with COMMIT once satisfied.
COMMIT;
