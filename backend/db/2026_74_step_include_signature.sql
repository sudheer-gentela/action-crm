-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_74_step_include_signature.sql   (Q3)
--
-- SAFE TO DEPLOY ALONE. Purely additive, and the default reproduces today's
-- behaviour exactly, so the column is inert until the firer change ships.
--
-- NUMBERING: 73 is taken by play_ownership_and_assignment_provenance. This is 74.
--
-- ── Why per-step rather than per-sequence ───────────────────────────────────
--
-- The sender's signature is appended unconditionally at send time
-- (SequenceStepFirer.js: appendSignature(sendBodyRaw, sender.signature)), with
-- no notion of position in a thread. A sequence-level mode ('all' / 'first_only'
-- / 'never') was the other option, but a per-step boolean expresses every one of
-- those cases and more — including "off on the first email, on for step 3" —
-- without inventing a vocabulary.
--
-- ── Default is true, deliberately ───────────────────────────────────────────
--
-- Every existing step keeps its signature. NOT NULL DEFAULT true means no
-- backfill and no behaviour change on deploy.
--
-- ── Read-side caveat: snapshots ─────────────────────────────────────────────
--
-- EnrollmentStepResolver resolves a step through
--   personalised_steps → steps_snapshot → variant → base sequence_steps
-- The base path is `SELECT * FROM sequence_steps`, so it picks this column up for
-- free. But steps_snapshot / personalised_steps are jsonb copies taken when the
-- enrollment was created, and existing ones predate this column — so the flag
-- will be UNDEFINED for in-flight enrollments.
--
-- The firer must therefore read it as `step.include_signature !== false`, which
-- treats undefined as true and keeps in-flight enrollments behaving as they do
-- today. Reading it as `=== true` would silently strip signatures from every
-- enrollment currently mid-sequence.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §0. PRE-FLIGHT — informational.
--
--   Query 1: how many enrollments hold a pre-column snapshot, i.e. how many will
--            rely on the undefined-means-true read above.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT count(*) AS enrollments_with_snapshot
--   FROM sequence_enrollments
--  WHERE steps_snapshot IS NOT NULL OR personalised_steps IS NOT NULL;


ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS include_signature boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.sequence_steps.include_signature IS
  'When false, the sender signature is NOT appended to this step''s outbound '
  'email. Default true preserves pre-2026_74 behaviour. Read as '
  '(include_signature !== false) so jsonb step snapshots taken before this '
  'column existed continue to include the signature.';


-- ───────────────────────────────────────────────────────────────────────────
-- §1. VERIFY before COMMIT.
--
--   Expect one row: boolean, NOT NULL, default true.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'sequence_steps' AND column_name = 'include_signature';

COMMIT;
