/**
 * SequenceStepAdvanceService
 *
 * Encapsulates the cross-table writes that happen when a non-email sequence
 * step is completed. Extracted from the inline logic in
 * routes/sequences.routes.js POST /drafts/:logId/complete so the same path
 * can be triggered from /api/prospect-calls POST (when a call is logged with
 * sequence_step_log_id set).
 *
 * Side effects when advancing a step:
 *   1. Mark the sequence_step_logs row as completed (status='completed', fired_at=NOW())
 *   2. Bump prospects.outreach_count and last_outreach_at
 *   3. Auto-advance prospect stage to 'outreach' if currently target/research
 *   4. Move the sequence_enrollments cursor forward, or mark enrollment completed
 *   5. Mark any linked prospecting_actions completed (so they disappear from ActionsView)
 *   6. Write a prospecting_activities row for the step completion
 *
 * Phase 2 specifics:
 *   - The old /complete endpoint stays for backward compat — it handles
 *     LinkedIn and task channels. For call channel, the recommended path
 *     is POST /api/prospect-calls (with sequence_step_log_id), which calls
 *     this helper after writing the call.
 *   - do_not_call outcome (per product decision): continue and try next
 *     step. The step is marked completed regardless of outcome. No special
 *     handling here.
 */

class SequenceStepAdvanceService {

  // ── Public: advance a sequence step ──────────────────────────────────────
  // Takes a db client in an open transaction (caller manages BEGIN/COMMIT).
  //
  // Args:
  //   client    — pg client with active transaction
  //   stepLogId — sequence_step_logs.id to advance
  //   orgId     — for org scoping
  //   userId    — user causing the advancement (the rep who logged the call)
  //
  // Returns: { advanced: bool, completed_enrollment: bool, step_log_id, channel }
  //          - advanced=false means the step was already completed
  //
  // Throws: on data integrity issues (step_log not found, etc.)
  static async advanceStep(client, stepLogId, orgId, userId) {
    // Load the step log + enrollment + step + sequence context.
    const ctxRes = await client.query(
      `SELECT ssl.id           AS step_log_id,
              ssl.status       AS step_log_status,
              ssl.prospect_id,
              ss.step_order,
              ss.channel,
              se.id            AS enrollment_id,
              se.current_step,
              se.sequence_id,
              s.name           AS sequence_name
         FROM sequence_step_logs ssl
         JOIN sequence_steps ss        ON ss.id = ssl.sequence_step_id
         JOIN sequence_enrollments se  ON se.id = ssl.enrollment_id
         JOIN sequences s              ON s.id  = se.sequence_id
        WHERE ssl.id = $1 AND ssl.org_id = $2`,
      [stepLogId, orgId]
    );

    if (ctxRes.rows.length === 0) {
      const err = new Error(`Sequence step log ${stepLogId} not found in org ${orgId}`);
      err.code = 'STEP_LOG_NOT_FOUND';
      throw err;
    }
    const ctx = ctxRes.rows[0];

    // Idempotency — if already completed, do nothing.
    if (ctx.step_log_status === 'completed') {
      return { advanced: false, completed_enrollment: false, step_log_id: ctx.step_log_id, channel: ctx.channel };
    }

    // 1. Mark the step log completed.
    await client.query(
      `UPDATE sequence_step_logs
          SET status='completed', fired_at=NOW()
        WHERE id=$1`,
      [ctx.step_log_id]
    );

    // 2. Bump prospect outreach tracking.
    await client.query(
      `UPDATE prospects
          SET outreach_count    = outreach_count + 1,
              last_outreach_at  = CURRENT_TIMESTAMP,
              updated_at        = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [ctx.prospect_id]
    );

    // 3. Auto-advance stage on first outreach. Mirrors the existing
    // /complete endpoint behavior — first call/touch lifts the prospect
    // from target/research into outreach.
    const stageRes = await client.query(
      'SELECT stage FROM prospects WHERE id = $1',
      [ctx.prospect_id]
    );
    if (['target', 'research'].includes(stageRes.rows[0]?.stage)) {
      await client.query(
        `UPDATE prospects
            SET stage='outreach',
                stage_changed_at=CURRENT_TIMESTAMP,
                updated_at=CURRENT_TIMESTAMP
          WHERE id=$1`,
        [ctx.prospect_id]
      );
    }

    // 4. Advance enrollment.
    let completedEnrollment = false;
    const nextStepRes = await client.query(
      `SELECT * FROM sequence_steps
        WHERE sequence_id=$1 AND step_order=$2`,
      [ctx.sequence_id, ctx.current_step + 1]
    );
    if (nextStepRes.rows.length) {
      const ns = nextStepRes.rows[0];
      const nextDue = new Date();
      nextDue.setDate(nextDue.getDate() + (parseInt(ns.delay_days) || 0));
      await client.query(
        `UPDATE sequence_enrollments
            SET current_step=$1, next_step_due=$2
          WHERE id=$3`,
        [ctx.current_step + 1, nextDue, ctx.enrollment_id]
      );
    } else {
      await client.query(
        `UPDATE sequence_enrollments
            SET status='completed', completed_at=NOW()
          WHERE id=$1`,
        [ctx.enrollment_id]
      );
      completedEnrollment = true;
    }

    // 5. Mark linked prospecting_actions completed (removes from ActionsView).
    await client.query(
      `UPDATE prospecting_actions
          SET status='completed',
              completed_at=CURRENT_TIMESTAMP,
              completed_by=$1,
              outcome='completed_manually',
              updated_at=CURRENT_TIMESTAMP
        WHERE org_id=$2
          AND source='sequence_draft'
          AND (metadata->>'draftLogId')::int = $3
          AND status != 'completed'`,
      [userId, orgId, ctx.step_log_id]
    );

    // 6. Activity log.
    await client.query(
      `INSERT INTO prospecting_activities
         (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'sequence_step_completed', $3, $4)`,
      [
        ctx.prospect_id,
        userId,
        `${ctx.channel} step completed — ${ctx.sequence_name} step ${ctx.step_order}`,
        JSON.stringify({
          enrollmentId: ctx.enrollment_id,
          draftLogId:   ctx.step_log_id,
          stepOrder:    ctx.step_order,
          channel:      ctx.channel,
        }),
      ]
    );

    return {
      advanced: true,
      completed_enrollment: completedEnrollment,
      step_log_id: ctx.step_log_id,
      channel: ctx.channel,
    };
  }
}

module.exports = SequenceStepAdvanceService;
