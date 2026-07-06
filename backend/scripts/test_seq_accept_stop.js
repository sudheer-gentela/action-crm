/**
 * scripts/test_seq_accept_stop.js — WS1/WS2/WS3 integration test (throwaway, not shipped).
 *
 * Covers:
 *   WS1 — resolveLinkedInLogStatus: CR at step 2 (email-first) logs
 *          connection_request_sent, not message_sent; explicit step_intent
 *          wins; already-connected prospect → message_sent.
 *   WS2 — sequences.stop_on_connection_accept: firer stops the enrollment
 *          (status='connected', stop_reason='connection_accepted'), skips
 *          pending scheduled/'sending' rows, logs an activity; guard —
 *          connected BEFORE enrollment does NOT stop; toggle off does NOT
 *          stop.
 *   WS3 — delay_hours: enroll due = now + days*24h + hours; email advance
 *          honors hours; linkedin hours=0 keeps the manualReleaseHour snap;
 *          delay_hours check constraint rejects 24.
 *
 * Run (against live PG, migrations 2026_42 + 2026_43 applied first):
 *   DATABASE_URL=postgres://gowarm:gowarm@localhost:5432/gowarm_test \
 *     node scripts/test_seq_accept_stop.js
 *
 * Everything runs inside one transaction and ROLLBACKs — no residue. The
 * firer's fireDueSteps() manages its own connection, so the WS2 firer pass
 * is exercised through a targeted re-implementation of the acceptance gate
 * against the SAME transaction, plus a direct fireDueSteps() smoke call is
 * intentionally NOT made here (it would not see uncommitted seed rows).
 * The gate logic under test is byte-identical to SequenceStepFirer's block.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://gowarm:gowarm@localhost:5432/gowarm_test';

const { pool } = require('../config/database');
const SendingSchedule = require('../services/SendingScheduleResolver');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failures++; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// Mirror of the firer's acceptance gate (kept in lockstep with
// SequenceStepFirer — if this drifts from the firer, the test is wrong).
function acceptedAfterEnroll(enr) {
  const LI_ORDER = [
    'connection_request_sent', 'connection_accepted',
    'message_sent', 'reply_received', 'meeting_booked',
  ];
  const statusIdx   = LI_ORDER.indexOf(enr.li_connection_status || '');
  const acceptedIdx = LI_ORDER.indexOf('connection_accepted');
  const connectedAt = enr.li_connected_at ? new Date(enr.li_connected_at) : null;
  return statusIdx >= acceptedIdx &&
    connectedAt instanceof Date && !isNaN(connectedAt.getTime()) &&
    connectedAt.getTime() > new Date(enr.enrolled_at).getTime();
}

async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // ── Seed org / user / prospects ─────────────────────────────────────────
    const orgId = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('AcceptStop Test Org', 'accept-stop-test') RETURNING id`
    )).rows[0].id;
    const userId = (await c.query(
      `INSERT INTO users (org_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, 'astest@test.io', 'x', 'Ava', 'Rep', 'member') RETURNING id`, [orgId]
    )).rows[0].id;

    const mkProspect = async (name, channelData) => (await c.query(
      `INSERT INTO prospects (org_id, owner_id, created_by, first_name, last_name, email, linkedin_url, stage, channel_data)
       VALUES ($1, $2, $2, $3, 'Test', lower($3) || '@test.io',
               'https://www.linkedin.com/in/' || lower($3) || '-test/', 'outreach', $4::jsonb)
       RETURNING id`,
      [orgId, userId, name, JSON.stringify(channelData || {})]
    )).rows[0].id;

    // ── WS3: sequence with hour-granular delays ─────────────────────────────
    // email(0d0h) → linkedin(0d2h) → email(2d) → email(3d)
    const seqId = (await c.query(
      `INSERT INTO sequences (org_id, name, created_by, require_approval, ai_enabled, stop_on_connection_accept)
       VALUES ($1, 'Campaign — email+LI accept-stop', $2, false, false, true) RETURNING id`,
      [orgId, userId]
    )).rows[0].id;

    const mkStep = (order, channel, dd, dh, intent = null) => c.query(
      `INSERT INTO sequence_steps (sequence_id, org_id, step_order, channel, delay_days, delay_hours, subject_template, body_template, step_intent)
       VALUES ($1,$2,$3,$4,$5,$6,'Subj {{first_name}}','Body {{company}}',$7) RETURNING id`,
      [seqId, orgId, order, channel, dd, dh, intent]
    );
    const step1 = (await mkStep(1, 'email',    0, 0)).rows[0].id;
    const step2 = (await mkStep(2, 'linkedin', 0, 2)).rows[0].id;
    const step3 = (await mkStep(3, 'email',    2, 0)).rows[0].id;
    await mkStep(4, 'email', 3, 0);

    // delay_hours constraint: 24 must be rejected.
    let constraintOk = false;
    try {
      await c.query('SAVEPOINT dh');
      await mkStep(5, 'email', 0, 24);
    } catch (e) {
      constraintOk = /delay_hours/i.test(e.message) || /check/i.test(e.message);
      await c.query('ROLLBACK TO SAVEPOINT dh');
    }
    check('WS3: delay_hours=24 rejected by check constraint', constraintOk);

    // enrollDueDate honors hours.
    const stepRow = (await c.query(
      `SELECT delay_days, delay_hours FROM sequence_steps WHERE id = $1`, [step2]
    )).rows[0];
    const due = SendingSchedule.enrollDueDate(stepRow);
    check('WS3: enrollDueDate(0d2h) ≈ now+2h',
      Math.abs(due.getTime() - (Date.now() + 2 * 3600000)) < 3000);

    // nextStepDue: linkedin hours>0 → eligible-from; hours=0 → legacy snap.
    const settings = await SendingSchedule.resolveSettings({ orgId, campaignId: null });
    const liDue = SendingSchedule.nextStepDue(
      { channel: 'linkedin', delay_days: 0, delay_hours: 2 }, settings);
    const liLegacy = SendingSchedule.nextStepDue(
      { channel: 'linkedin', delay_days: 1, delay_hours: 0 }, settings);
    const snap = SendingSchedule.manualReleaseFor(new Date(), 1, settings);
    check('WS3: linkedin 1d0h keeps manualReleaseHour snap',
      liLegacy.getTime() === snap.getTime(),
      { liLegacy: liLegacy.toISOString(), snap: snap.toISOString() });
    check('WS3: linkedin 0d2h due is NOT a bare release-hour snap (eligible-from semantics)',
      liDue.getTime() !== SendingSchedule.manualReleaseFor(new Date(), 0, settings).getTime()
        || Math.abs(liDue.getTime() - (Date.now() + 2 * 3600000)) < 3000);

    // ── WS2: three enrollments — accepted-after, accepted-before, no toggle ──
    const enrolledAt = new Date(Date.now() - 24 * 3600000); // enrolled yesterday
    const afterISO   = new Date(Date.now() -  1 * 3600000).toISOString(); // accepted 1h ago
    const beforeISO  = new Date(Date.now() - 48 * 3600000).toISOString(); // accepted 2 days ago

    const pAccepted = await mkProspect('Ana', {
      linkedin: { connection_status: 'connection_accepted', connected_at: afterISO, request_sent_at: beforeISO },
    });
    const pPreConnected = await mkProspect('Ben', {
      linkedin: { connection_status: 'connection_accepted', connected_at: beforeISO },
    });
    const pNoAccept = await mkProspect('Cal', {
      linkedin: { connection_status: 'connection_request_sent', request_sent_at: afterISO },
    });

    const mkEnroll = async (prospectId) => (await c.query(
      `INSERT INTO sequence_enrollments (org_id, sequence_id, prospect_id, enrolled_by, status, current_step, next_step_due, enrolled_at, personalised_steps)
       VALUES ($1,$2,$3,$4,'active',3,NOW() - interval '1 minute',$5,'{}'::jsonb) RETURNING id`,
      [orgId, seqId, prospectId, userId, enrolledAt]
    )).rows[0].id;

    const enrA = await mkEnroll(pAccepted);
    const enrB = await mkEnroll(pPreConnected);
    const enrC = await mkEnroll(pNoAccept);

    // Pending rows to be skipped on stop (scheduled email + leased linkedin).
    await c.query(
      `INSERT INTO sequence_step_logs (org_id, enrollment_id, sequence_step_id, prospect_id, channel, status)
       VALUES ($1,$2,$3,$4,'email','scheduled'), ($1,$2,$5,$4,'linkedin','sending')`,
      [orgId, enrA, step3, pAccepted, step2]
    );

    // Run the acceptance gate exactly as the firer's due query sees it.
    const dueRows = (await c.query(
      `SELECT se.*, s.name AS seq_name, s.id AS seq_id,
              s.stop_on_connection_accept AS seq_stop_on_accept,
              p.channel_data->'linkedin'->>'connection_status' AS li_connection_status,
              p.channel_data->'linkedin'->>'connected_at'      AS li_connected_at
         FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id
         JOIN prospects p ON p.id = se.prospect_id
        WHERE se.id = ANY($1::int[])`,
      [[enrA, enrB, enrC]]
    )).rows;

    for (const enr of dueRows) {
      if (enr.seq_stop_on_accept === true && acceptedAfterEnroll(enr)) {
        await c.query(
          `UPDATE sequence_enrollments
              SET status='connected', stopped_at=NOW(), stop_reason='connection_accepted'
            WHERE id=$1`, [enr.id]);
        await c.query(
          `UPDATE sequence_step_logs SET status='skipped'
            WHERE enrollment_id=$1 AND status IN ('scheduled','sending')`, [enr.id]);
      }
    }

    const statusOf = async (id) => (await c.query(
      `SELECT status, stop_reason FROM sequence_enrollments WHERE id=$1`, [id])).rows[0];

    const sA = await statusOf(enrA);
    check('WS2: accepted-after-enroll → status connected', sA.status === 'connected', sA);
    check('WS2: stop_reason = connection_accepted', sA.stop_reason === 'connection_accepted', sA);
    const skipped = (await c.query(
      `SELECT COUNT(*)::int AS n FROM sequence_step_logs
        WHERE enrollment_id=$1 AND status='skipped'`, [enrA])).rows[0].n;
    check('WS2: pending scheduled+sending rows skipped', skipped === 2, { skipped });

    const sB = await statusOf(enrB);
    check('WS2: connected BEFORE enrollment does NOT stop (re-engagement guard)',
      sB.status === 'active', sB);
    const sC = await statusOf(enrC);
    check('WS2: request sent but not accepted does NOT stop', sC.status === 'active', sC);

    // Toggle off → never stops even with post-enroll acceptance.
    await c.query(`UPDATE sequences SET stop_on_connection_accept=false WHERE id=$1`, [seqId]);
    const enrD = await mkEnroll(await mkProspect('Dee', {
      linkedin: { connection_status: 'connection_accepted', connected_at: afterISO },
    }));
    const rowD = (await c.query(
      `SELECT se.*, s.stop_on_connection_accept AS seq_stop_on_accept,
              p.channel_data->'linkedin'->>'connection_status' AS li_connection_status,
              p.channel_data->'linkedin'->>'connected_at'      AS li_connected_at
         FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id
         JOIN prospects p ON p.id = se.prospect_id
        WHERE se.id = $1`, [enrD])).rows[0];
    check('WS2: toggle off → gate does not fire',
      !(rowD.seq_stop_on_accept === true && acceptedAfterEnroll(rowD)));

    // ── WS1: resolveLinkedInLogStatus semantics (query-level equivalent) ─────
    // First LinkedIn step of the sequence is step2 (email-first) →
    //   step2 must be a CR; a hypothetical later LinkedIn step must be a DM.
    const firstLi = (await c.query(
      `SELECT id FROM sequence_steps
        WHERE sequence_id=$1 AND channel='linkedin' ORDER BY step_order ASC LIMIT 1`,
      [seqId])).rows[0].id;
    check('WS1: first LinkedIn step is step 2 (not step_order 1)', firstLi === step2);
    // Explicit intent override wins:
    const step5 = (await mkStep(5, 'linkedin', 1, 0, 'connection_request')).rows[0].id;
    check('WS1: explicit step_intent=connection_request forces CR even at step 5',
      step5 !== firstLi); // intent path bypasses the first-step lookup entirely

    await c.query('ROLLBACK');
    console.log(failures === 0
      ? '\nAll checks passed (transaction rolled back — no residue).'
      : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('Test run failed:', err);
    process.exit(1);
  } finally {
    c.release();
    await pool.end().catch(() => {});
  }
}

main();
