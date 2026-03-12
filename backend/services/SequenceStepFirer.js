/**
 * SequenceStepFirer.js
 *
 * Service called directly by the node-cron job in server.js.
 * Follows the exact pattern of AgentProposalService / contractService:
 *   - No HTTP self-call
 *   - Called as: await SequenceStepFirer.fireDueSteps()
 *   - Returns { fired, stopped, errors }
 *
 * Logic:
 *   1. Find all active enrollments where next_step_due <= now
 *   2. For each: check for inbound reply → auto-stop if found
 *   3. Fire the current step (email → insert into emails table)
 *      Uses personalised_steps JSONB from enrollment if present,
 *      otherwise falls back to renderTemplate on the master template.
 *   4. Log to sequence_step_logs
 *   5. Advance to next step, or mark complete
 */

const { pool } = require('../config/database');

// ── Template renderer ─────────────────────────────────────────────────────────
function renderTemplate(template, prospect, account) {
  if (!template) return '';
  const vars = {
    first_name: prospect.first_name   || '',
    last_name:  prospect.last_name    || '',
    full_name:  `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim(),
    title:      prospect.title        || '',
    company:    account?.name         || prospect.company_name || '',
    industry:   account?.industry     || prospect.company_industry || '',
    domain:     account?.domain       || prospect.company_domain  || '',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function calcDueDate(delayDays) {
  const d = new Date();
  d.setDate(d.getDate() + (parseInt(delayDays) || 0));
  return d;
}

// ── Main export ───────────────────────────────────────────────────────────────

const SequenceStepFirer = {
  /**
   * Fire all due sequence steps across all orgs.
   * Safe to call on a schedule — processes up to 100 enrollments per run.
   * @returns {{ fired: number, stopped: number, errors: number }}
   */
  async fireDueSteps() {
    let fired = 0, stopped = 0, errors = 0;

    const client = await pool.connect();
    try {
      // Grab up to 100 due enrollments across all orgs
      const dueRes = await client.query(
        `SELECT se.*, s.id AS seq_id
           FROM sequence_enrollments se
           JOIN sequences s ON s.id = se.sequence_id
          WHERE se.status = 'active'
            AND se.next_step_due <= NOW()
          LIMIT 100`
      );

      for (const enrollment of dueRes.rows) {
        try {
          // ── Auto-stop check: inbound reply received since enrollment ──────
          const replyCheck = await client.query(
            `SELECT id FROM emails
              WHERE prospect_id = $1
                AND direction IN ('inbound', 'received')
                AND sent_at > $2
              LIMIT 1`,
            [enrollment.prospect_id, enrollment.enrolled_at]
          );

          if (replyCheck.rows.length > 0) {
            await client.query(
              `UPDATE sequence_enrollments
                  SET status='replied', stopped_at=NOW(), stop_reason='replied'
                WHERE id=$1`,
              [enrollment.id]
            );
            stopped++;
            continue;
          }

          // ── Get the current step ──────────────────────────────────────────
          const stepRes = await client.query(
            `SELECT * FROM sequence_steps
              WHERE sequence_id=$1 AND step_order=$2`,
            [enrollment.seq_id, enrollment.current_step]
          );

          if (!stepRes.rows.length) {
            // No step found — sequence is complete
            await client.query(
              `UPDATE sequence_enrollments
                  SET status='completed', completed_at=NOW()
                WHERE id=$1`,
              [enrollment.id]
            );
            fired++;
            continue;
          }

          const step = stepRes.rows[0];

          // ── Load prospect + account for template rendering ────────────────
          const pRes = await client.query(
            `SELECT p.*, a.name AS account_name, a.domain AS account_domain,
                    a.industry AS account_industry
               FROM prospects p
          LEFT JOIN accounts a ON a.id = p.account_id
              WHERE p.id=$1`,
            [enrollment.prospect_id]
          );
          const prospect = pRes.rows[0];
          const account  = prospect
            ? { name: prospect.account_name, domain: prospect.account_domain, industry: prospect.account_industry }
            : null;

          // FIX 2: use AI-personalised content if stored on enrollment,
          // otherwise fall back to rendering the master template.
          // personalised_steps is keyed by step_order (may be int or string key).
          const personalisedSteps = enrollment.personalised_steps || {};
          const personalisedStep  = personalisedSteps[step.step_order]
                                 ?? personalisedSteps[String(step.step_order)];

          const subject = personalisedStep?.subject
            ? personalisedStep.subject
            : renderTemplate(step.subject_template, prospect || {}, account);

          const body = personalisedStep?.body
            ? personalisedStep.body
            : renderTemplate(step.body_template, prospect || {}, account);

          // ── Fire the step ─────────────────────────────────────────────────
          let emailId = null;

          if (step.channel === 'email' && prospect?.email) {
            const emailRes = await client.query(
              `INSERT INTO emails
                           (org_id, user_id, direction, subject, body,
                            to_address, prospect_id, sent_at)
                    VALUES ($1, $2, 'outbound', $3, $4, $5, $6, NOW())
                 RETURNING id`,
              [
                enrollment.org_id,
                enrollment.enrolled_by,
                subject,
                body,
                prospect.email,
                enrollment.prospect_id,
              ]
            );
            emailId = emailRes.rows[0].id;
          }
          // Non-email channels (call, task, linkedin) are logged but not auto-sent —
          // they surface as tasks for the rep to action manually.

          // ── Log the step ──────────────────────────────────────────────────
          await client.query(
            `INSERT INTO sequence_step_logs
                         (org_id, enrollment_id, sequence_step_id, prospect_id,
                          channel, status, subject, body, email_id)
                  VALUES ($1, $2, $3, $4, $5, 'sent', $6, $7, $8)`,
            [
              enrollment.org_id,
              enrollment.id,
              step.id,
              enrollment.prospect_id,
              step.channel,
              subject,
              body,
              emailId,
            ]
          );

          // ── Advance to next step or mark complete ─────────────────────────
          const nextStepRes = await client.query(
            `SELECT * FROM sequence_steps
              WHERE sequence_id=$1 AND step_order=$2`,
            [enrollment.seq_id, enrollment.current_step + 1]
          );

          if (nextStepRes.rows.length) {
            const nextStep = nextStepRes.rows[0];
            await client.query(
              `UPDATE sequence_enrollments
                  SET current_step=$1, next_step_due=$2
                WHERE id=$3`,
              [enrollment.current_step + 1, calcDueDate(nextStep.delay_days), enrollment.id]
            );
          } else {
            await client.query(
              `UPDATE sequence_enrollments
                  SET status='completed', completed_at=NOW()
                WHERE id=$1`,
              [enrollment.id]
            );
          }

          fired++;
        } catch (stepErr) {
          console.error(
            `📨 SequenceStepFirer: error on enrollment ${enrollment.id}:`,
            stepErr.message
          );
          errors++;
        }
      }
    } finally {
      client.release();
    }

    return { fired, stopped, errors };
  },
};

module.exports = SequenceStepFirer;
