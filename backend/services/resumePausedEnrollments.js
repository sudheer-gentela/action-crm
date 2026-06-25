/**
 * resumePausedEnrollments.js
 *
 * DROP-IN LOCATION: backend/services/resumePausedEnrollments.js  (NEW FILE)
 *
 * Resumes sequence enrollments that were paused by a sender's credential failure
 * (invalid_grant) once that sender is reconnected. failAndPause leaves three
 * things behind that reconnecting does NOT undo:
 *   - sequence_enrollments.status='paused', stop_reason='send_failed'
 *   - the step's sequence_step_logs row → status='failed'
 *   - a prospecting_actions "Auto-send paused — fix & resume" row (pending)
 * This re-arms the step, reactivates the enrollment, and completes the action.
 *
 * mode:
 *   'send'   → re-arm the failed step to 'scheduled' (the firer sends it, paced).
 *              Used by auto-resume-on-reconnect: the steps were already approved,
 *              so continue sending.
 *   'review' → re-arm to 'draft' instead, so it re-enters the "Preview drafts"
 *              approval queue for the rep to review before anything sends.
 *
 * Scope: only enrollments whose failed step error_message shows invalid_grant for
 * THIS sender's email, and (for auto-resume) only failures within a recency
 * window — so reconnecting can't blast a weeks-old stale backlog. The window is
 * SENDER_AUTO_RESUME_WINDOW_HOURS (default 96h); pass sinceHours=null to disable.
 *
 * Best-effort: never throws (must not break the OAuth callback). Returns counts.
 * Clearing the notification bell badge is left to the rep's "Mark all read" —
 * completing the actions stops new ones being generated.
 */

const { pool: defaultPool } = require('../config/database');

async function resumeAfterReconnect(db, { orgId, userId, senderEmail, sinceHours, mode = 'send' } = {}) {
  const conn = db || defaultPool;
  try {
    if (!orgId || !userId || !senderEmail) {
      return { enrollments: 0, rows: 0, actions: 0, skipped: 'missing args' };
    }
    const emailLike = '%' + senderEmail + '%';

    // Recency window (auto-resume only). null/undefined env → 96h; sinceHours=0
    // or negative → no window (resume regardless of age).
    let windowHours;
    if (sinceHours === null) windowHours = null;
    else if (Number.isFinite(sinceHours)) windowHours = sinceHours;
    else windowHours = parseInt(process.env.SENDER_AUTO_RESUME_WINDOW_HOURS || '', 10) || 96;
    const useWindow = Number.isFinite(windowHours) && windowHours > 0;

    // 1. Target enrollments paused by THIS sender's invalid_grant.
    const params = [orgId, userId, emailLike];
    let windowClause = '';
    if (useWindow) { params.push(String(windowHours)); windowClause = `AND l.fired_at >= NOW() - ($4 || ' hours')::interval`; }
    const { rows: targets } = await conn.query(
      `SELECT DISTINCT se.id
         FROM sequence_enrollments se
         JOIN sequence_step_logs l ON l.enrollment_id = se.id
        WHERE se.org_id = $1 AND se.enrolled_by = $2
          AND se.status = 'paused' AND se.stop_reason = 'send_failed'
          AND l.status = 'failed'
          AND l.error_message ILIKE '%invalid_grant%'
          AND l.error_message ILIKE $3
          ${windowClause}`,
      params
    );
    if (!targets.length) return { enrollments: 0, rows: 0, actions: 0 };
    const ids = targets.map(r => r.id);
    const newStatus = mode === 'review' ? 'draft' : 'scheduled';

    // 2. Re-arm the failed step(s). Match invalid_grant + sender BEFORE clearing
    //    error_message. Guard against creating a second pending row for a step.
    const rearm = await conn.query(
      `UPDATE sequence_step_logs s
          SET status            = $2,
              scheduled_send_at = CASE WHEN $2 = 'scheduled' THEN NOW() ELSE scheduled_send_at END,
              approved_at       = CASE WHEN $2 = 'scheduled' THEN NOW() ELSE NULL END,
              error_message     = NULL,
              fired_at          = NULL
        WHERE s.enrollment_id = ANY($1::int[])
          AND s.status = 'failed'
          AND s.error_message ILIKE '%invalid_grant%'
          AND s.error_message ILIKE $3
          AND NOT EXISTS (
            SELECT 1 FROM sequence_step_logs x
             WHERE x.enrollment_id    = s.enrollment_id
               AND x.sequence_step_id = s.sequence_step_id
               AND x.status IN ('scheduled','sending','draft'))`,
      [ids, newStatus, emailLike]
    );

    // 3. Reactivate the enrollments and make them due now.
    await conn.query(
      `UPDATE sequence_enrollments
          SET status = 'active', stop_reason = NULL,
              next_step_due = LEAST(COALESCE(next_step_due, NOW()), NOW())
        WHERE id = ANY($1::int[])`,
      [ids]
    );

    // 4. Complete the open "fix & resume" actions for these enrollments so the
    //    overdue-action notifications stop being generated.
    const acts = await conn.query(
      `UPDATE prospecting_actions
          SET status = 'completed', completed_at = NOW()
        WHERE org_id = $1
          AND source = 'sequence_send_failed'
          AND status <> 'completed'
          AND (metadata->>'enrollmentId')::int = ANY($2::int[])`,
      [orgId, ids]
    );

    return { enrollments: ids.length, rows: rearm.rowCount, actions: acts.rowCount, mode: newStatus === 'draft' ? 'review' : 'send' };
  } catch (e) {
    console.warn('resumeAfterReconnect failed:', e.message);
    return { enrollments: 0, rows: 0, actions: 0, error: e.message };
  }
}

module.exports = { resumeAfterReconnect };
