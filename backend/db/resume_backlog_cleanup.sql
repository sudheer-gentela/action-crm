-- ─────────────────────────────────────────────────────────────────────────────
-- resume_backlog_cleanup.sql   (one-time, run by hand)
--
-- Clears the auto-send-paused backlog left by the dead gowarm.info token, with
-- the split you asked for:
--   BLOCK A — the 23 Jun batch  → re-arm to 'scheduled' (sends, paced by the firer)
--   BLOCK B — everything older  → reset to 'draft'      (lands in "Preview drafts"
--                                                         for you to review & approve)
-- Both blocks reactivate the enrollment and complete the "fix & resume" action so
-- the overdue-action notifications stop. To zero the bell's 99+ badge afterwards,
-- click "Mark all read" once (the completed actions won't come back).
--
-- EDIT BEFORE RUNNING:
--   :ORG          → your org_id
--   the sender    → '%gowarm.info%' below (change if a different sender)
--   the boundary  → '2026-06-23 00:00+05:30' is local midnight IST. Adjust the
--                   date / offset if your "23 Jun" boundary differs.
--
-- Run each block's DRY RUN first; if the count looks right, run its APPLY.
-- ═════════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ BLOCK A — SEND: the 23 Jun gowarm.info batch                               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- A. DRY RUN
WITH targets AS (
  SELECT DISTINCT se.id
  FROM   sequence_enrollments se
  JOIN   sequence_step_logs   l ON l.enrollment_id = se.id
  WHERE  se.org_id = :ORG
    AND  se.status = 'paused' AND se.stop_reason = 'send_failed'
    AND  l.status = 'failed'
    AND  l.error_message ILIKE '%invalid_grant%'
    AND  l.error_message ILIKE '%gowarm.info%'
    AND  l.fired_at >= '2026-06-23 00:00+05:30'
    AND  l.fired_at <  '2026-06-24 00:00+05:30'
)
SELECT count(*) AS enrollments_to_send FROM targets;

-- A. APPLY
BEGIN;
WITH targets AS (
  SELECT DISTINCT se.id
  FROM   sequence_enrollments se
  JOIN   sequence_step_logs   l ON l.enrollment_id = se.id
  WHERE  se.org_id = :ORG
    AND  se.status = 'paused' AND se.stop_reason = 'send_failed'
    AND  l.status = 'failed'
    AND  l.error_message ILIKE '%invalid_grant%'
    AND  l.error_message ILIKE '%gowarm.info%'
    AND  l.fired_at >= '2026-06-23 00:00+05:30'
    AND  l.fired_at <  '2026-06-24 00:00+05:30'
),
rearm AS (
  UPDATE sequence_step_logs s
     SET status='scheduled', scheduled_send_at=NOW(), approved_at=NOW(),
         error_message=NULL, fired_at=NULL
   WHERE s.enrollment_id IN (SELECT id FROM targets)
     AND s.status='failed'
     AND s.error_message ILIKE '%invalid_grant%'
     AND s.error_message ILIKE '%gowarm.info%'
     AND s.fired_at >= '2026-06-23 00:00+05:30'
     AND s.fired_at <  '2026-06-24 00:00+05:30'
     AND NOT EXISTS (SELECT 1 FROM sequence_step_logs x
                      WHERE x.enrollment_id=s.enrollment_id
                        AND x.sequence_step_id=s.sequence_step_id
                        AND x.status IN ('scheduled','sending','draft'))
  RETURNING s.enrollment_id
),
react AS (
  UPDATE sequence_enrollments
     SET status='active', stop_reason=NULL,
         next_step_due=LEAST(COALESCE(next_step_due,NOW()),NOW())
   WHERE id IN (SELECT id FROM targets)
  RETURNING id
)
UPDATE prospecting_actions pa
   SET status='completed', completed_at=NOW()
 WHERE pa.org_id = :ORG AND pa.source='sequence_send_failed' AND pa.status<>'completed'
   AND (pa.metadata->>'enrollmentId')::int IN (SELECT id FROM react);
-- inspect the row counts, then:
COMMIT;   -- or ROLLBACK;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ BLOCK B — REVIEW: everything older than 23 Jun → drafts for approval       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- B. DRY RUN
WITH targets AS (
  SELECT DISTINCT se.id
  FROM   sequence_enrollments se
  JOIN   sequence_step_logs   l ON l.enrollment_id = se.id
  WHERE  se.org_id = :ORG
    AND  se.status = 'paused' AND se.stop_reason = 'send_failed'
    AND  l.status = 'failed'
    AND  l.error_message ILIKE '%invalid_grant%'
    AND  l.error_message ILIKE '%gowarm.info%'
    AND  l.fired_at <  '2026-06-23 00:00+05:30'
)
SELECT count(*) AS enrollments_to_review FROM targets;

-- B. APPLY
BEGIN;
WITH targets AS (
  SELECT DISTINCT se.id
  FROM   sequence_enrollments se
  JOIN   sequence_step_logs   l ON l.enrollment_id = se.id
  WHERE  se.org_id = :ORG
    AND  se.status = 'paused' AND se.stop_reason = 'send_failed'
    AND  l.status = 'failed'
    AND  l.error_message ILIKE '%invalid_grant%'
    AND  l.error_message ILIKE '%gowarm.info%'
    AND  l.fired_at <  '2026-06-23 00:00+05:30'
),
rearm AS (
  UPDATE sequence_step_logs s
     SET status='draft', approved_at=NULL, error_message=NULL, fired_at=NULL
   WHERE s.enrollment_id IN (SELECT id FROM targets)
     AND s.status='failed'
     AND s.error_message ILIKE '%invalid_grant%'
     AND s.error_message ILIKE '%gowarm.info%'
     AND s.fired_at <  '2026-06-23 00:00+05:30'
     AND NOT EXISTS (SELECT 1 FROM sequence_step_logs x
                      WHERE x.enrollment_id=s.enrollment_id
                        AND x.sequence_step_id=s.sequence_step_id
                        AND x.status IN ('scheduled','sending','draft'))
  RETURNING s.enrollment_id
),
react AS (
  UPDATE sequence_enrollments
     SET status='active', stop_reason=NULL,
         next_step_due=LEAST(COALESCE(next_step_due,NOW()),NOW())
   WHERE id IN (SELECT id FROM targets)
  RETURNING id
)
UPDATE prospecting_actions pa
   SET status='completed', completed_at=NOW()
 WHERE pa.org_id = :ORG AND pa.source='sequence_send_failed' AND pa.status<>'completed'
   AND (pa.metadata->>'enrollmentId')::int IN (SELECT id FROM react);
COMMIT;   -- or ROLLBACK;

-- After Block B, the re-drafted steps appear under Prospecting → a campaign →
-- "Preview drafts for some prospects". Review and approve them there at your pace;
-- approval runs the normal send guard (it checks the sender is healthy first).
