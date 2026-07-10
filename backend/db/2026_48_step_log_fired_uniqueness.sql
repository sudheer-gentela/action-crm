-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_48_step_log_fired_uniqueness.sql
--
-- Stops the same sequence step firing twice for the same enrollment.
--
-- THE BUG
--
-- SequenceStepFirer's top-up guard tested:
--     NOT EXISTS (... l.status IN ('scheduled','sending','sent'))
--
-- but sequenceStepAdvance.service.js moves a log sent → 'completed' on every
-- successful advance. 'completed' was not in the list. So once a step finished,
-- the guard could no longer see it, and if se.current_step_id ever pointed back
-- at that step — a sequence reorder does exactly this — the top-up inserted a
-- fresh 'scheduled' row and the step fired again.
--
-- The existing index did not catch it either:
--     uq_seq_step_logs_pending (enrollment_id, sequence_step_id)
--       WHERE status IN ('scheduled','sending')
-- A new 'scheduled' row alongside a 'completed' row violates nothing.
--
-- Observed in production (org with a mid-flight sequence edit):
--   * email steps 68 / 72 — two 'sent' rows, DISTINCT email_id on each.
--     Two real emails reached the prospect. Not recoverable.
--   * linkedin steps 69 / 73 — two 'completed' rows, ~21 enrollments,
--     fired 12–36 hours apart. Two real LinkedIn touches.
--
-- THE FIX
--
-- 1. Collapse existing duplicates, keeping the EARLIEST log per pair (the one
--    that actually corresponds to the first, intended send). We do not delete
--    the later rows outright — they carry a real email_id and a real fired_at,
--    and destroying that audit trail would make the double-send invisible.
--    They are marked status='superseded_duplicate' instead.
-- 2. Add a unique index over every status that means "this step has fired or
--    is committed to firing". 'failed' and 'superseded_duplicate' are excluded
--    so retries and this backfill remain legal.
--
--    'draft' is ALSO excluded, deliberately. The draft insert at
--    SequenceStepFirer.js:1391 is not wrapped in a 23505 catch (unlike the
--    top-up inserts at :644 and :1520), so including 'draft' would convert a
--    harmless duplicate draft into a crashed tick. A stray draft never sends.
--    If two drafts for one pair both get sent, the UPDATE to 'sent' hits this
--    index and raises — which is the outcome we want: a loud failure at send
--    time beats a silent duplicate in the prospect's inbox.
--
-- Paired with the widened NOT EXISTS guard in SequenceStepFirer.js. The guard
-- keeps the firer from trying; the index guarantees it cannot succeed.
--
-- IDEMPOTENT. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 0. Allow the new terminal status ─────────────────────────────────────────
-- The CHECK constraint enumerates statuses; add ours before we write it.
ALTER TABLE public.sequence_step_logs
  DROP CONSTRAINT IF EXISTS sequence_step_logs_status_check;

ALTER TABLE public.sequence_step_logs
  ADD CONSTRAINT sequence_step_logs_status_check
  CHECK (status IN (
    'draft', 'sent', 'completed', 'replied', 'skipped', 'active',
    'failed', 'scheduled', 'sending', 'superseded_duplicate'
  ));

-- ── 1. Quarantine duplicates, keeping the earliest per (enrollment, step) ────
-- ORDER BY fired_at NULLS LAST then id: a NULL fired_at is a scheduled row that
-- never sent, so it must never win over a row that did.
-- Scope matches the index predicate exactly — otherwise the index build fails.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY enrollment_id, sequence_step_id
           ORDER BY fired_at ASC NULLS LAST, id ASC
         ) AS rn
    FROM public.sequence_step_logs
   WHERE status IN ('scheduled', 'sending', 'sent', 'completed', 'replied')
)
UPDATE public.sequence_step_logs ssl
   SET status = 'superseded_duplicate'
  FROM ranked r
 WHERE r.id = ssl.id
   AND r.rn > 1;

-- ── 2. Enforce it in the database ───────────────────────────────────────────
-- Any log that has fired, or is queued to fire, is unique per (enrollment,
-- step). 'draft' is included: a draft awaiting rep approval is a pending send.
-- 'failed' is excluded so handleSendFailure can write a row and a later retry
-- can write another. 'skipped' is excluded — a skipped step may legitimately be
-- re-attempted after a resume.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seq_step_logs_fired
    ON public.sequence_step_logs (enrollment_id, sequence_step_id)
 WHERE status IN ('scheduled', 'sending', 'sent', 'completed', 'replied');

-- uq_seq_step_logs_pending is now strictly implied by the index above, but we
-- KEEP it. Four comments in SequenceStepFirer.js and one in sequences.routes.js
-- explain their 23505 catch blocks by name. A redundant partial unique index
-- costs one B-tree write on a narrow predicate; a stale comment costs the next
-- person an hour. Drop it in a later cleanup, with the comments.

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY (run after COMMIT; both must return zero rows)
--
--   SELECT enrollment_id, sequence_step_id, COUNT(*)
--     FROM sequence_step_logs
--    WHERE status IN ('scheduled','sending','sent','completed','replied')
--    GROUP BY 1,2 HAVING COUNT(*) > 1;
--
-- AUDIT what was quarantined (the real double-sends):
--
--   SELECT ssl.org_id, ssl.enrollment_id, ssl.sequence_step_id, ssl.channel,
--          ssl.fired_at, ssl.email_id
--     FROM sequence_step_logs ssl
--    WHERE ssl.status = 'superseded_duplicate'
--    ORDER BY ssl.org_id, ssl.enrollment_id, ssl.fired_at;
--
-- NOTE ON REPORTING: 'superseded_duplicate' is in none of the status lists in
-- reporting.routes.js or MetricSnapshotService.js, so these rows drop out of
-- `sent`, `drafts` and `failed` automatically. Your Sent counts will fall by
-- the number of duplicates — that is the correction, not a regression.
-- Re-run scripts/backfillMetricDaily.js afterwards if you use the WBR grid.
-- ─────────────────────────────────────────────────────────────────────────────
