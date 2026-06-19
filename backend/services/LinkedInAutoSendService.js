// services/LinkedInAutoSendService.js
//
// Server side of the OPTIONAL, opt-in LinkedIn connection-request auto-send.
//
// The flow, end to end:
//   1. SequenceStepFirer materializes an eligible connection_request step as a
//      sequence_step_logs row: status='scheduled', channel='linkedin', body=the
//      ≤280-char personalized note. (It NEVER sends — see the firer's gate.)
//   2. The browser extension, running in the rep's own authenticated LinkedIn
//      session, calls claimForSeat() to LEASE a small batch (scheduled→sending,
//      stamping claimed_by_seat + lease_expires_at). The per-seat daily cap is
//      enforced HERE, server-side, from confirmed-sent rows — so it survives an
//      extension reinstall and can't be bypassed client-side.
//   3. For each leased row the extension navigates to the profile, clicks
//      Connect with the note, and calls either:
//        • confirmSent()    → sending→sent, advances the enrollment, and records
//                             connection_request_sent through the SAME
//                             LinkedInConnectionSyncService.applyConnectionEvent
//                             used by the manual popup sync, so counters / stage
//                             auto-advance / activity rows are byte-identical.
//        • reportFailure()  → sending→failed, pauses the enrollment (no retry),
//                             surfaces a fix-and-resume action for the owner.
//   4. reclaimExpiredLeases() (a cron sweep) returns any 'sending' LinkedIn row
//      whose lease expired back to 'scheduled' so it can be re-offered — covers
//      the rep closing the browser between claim and confirm. (The email reaper
//      in SequenceStepFirer is explicitly scoped to channel='email' so it never
//      touches these.)
//
// Seat model: identical to LinkedInConnectionSyncService — viewer.publicIdentifier
// is bound to the GoWarm user via user_linkedin_seats; a seat owned by a
// different teammate is rejected with SEAT_CONFLICT. A rep can only ever claim /
// confirm rows on enrollments they themselves own (se.enrolled_by = userId).
//
// IMPORTANT: every write here runs on the caller's transaction client.

const SendingSchedule = require('./SendingScheduleResolver');
const Sync            = require('./LinkedInConnectionSyncService');

// Rolling-window cap is intentionally 24h (not a calendar day): it's strictly
// safer against a midnight reset being gamed, and it lines up naturally with the
// rep's local human-hours window the extension enforces. Counted from confirmed
// 'sent' rows attributed to this seat.
async function countSeatSendsLast24h(client, { orgId, seatSlug }) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM sequence_step_logs
      WHERE org_id = $1
        AND channel = 'linkedin'
        AND status  = 'sent'
        AND claimed_by_seat = $2
        AND fired_at > NOW() - INTERVAL '24 hours'`,
    [orgId, seatSlug]
  );
  return r.rows[0]?.n || 0;
}

// ── Claim ─────────────────────────────────────────────────────────────────────
//
// Atomically lease up to `limit` scheduled LinkedIn connection-request rows for
// this seat, capped by remaining daily budget. SKIP LOCKED so two concurrent
// extension instances (two browsers / two service-worker wakeups) never grab the
// same row.
//
// Returns {
//   claimed: [ { logId, enrollmentId, stepId, prospectId, note,
//                prospect: { name, linkedinUrl } } ],
//   remainingBudget,           // after this claim
//   cappedOut                  // true if the daily cap blocked further claims
// }
async function claimForSeat(client, { orgId, userId, seatSlug, limit, leaseMinutes, dailyCap }) {
  const sent24h        = await countSeatSendsLast24h(client, { orgId, seatSlug });
  const remainingBudget = Math.max(0, (dailyCap || 0) - sent24h);
  if (remainingBudget <= 0) {
    return { claimed: [], remainingBudget: 0, cappedOut: true };
  }
  const take = Math.max(0, Math.min(Number(limit) || 0, remainingBudget));
  if (take === 0) {
    return { claimed: [], remainingBudget, cappedOut: false };
  }

  // Lease: scheduled → sending, oldest first, SKIP LOCKED for concurrency.
  const leased = await client.query(
    `WITH picked AS (
       SELECT l.id
         FROM sequence_step_logs l
         JOIN sequence_enrollments se ON se.id = l.enrollment_id
        WHERE l.org_id  = $1
          AND l.channel = 'linkedin'
          AND l.status  = 'scheduled'
          AND se.enrolled_by = $2
          AND se.status = 'active'
        ORDER BY l.scheduled_send_at ASC, l.id ASC
        LIMIT $3
        FOR UPDATE OF l SKIP LOCKED
     )
     UPDATE sequence_step_logs l
        SET status           = 'sending',
            claimed_by_seat  = $4,
            lease_expires_at = NOW() + ($5 || ' minutes')::interval,
            fired_at         = NOW()
       FROM picked
      WHERE l.id = picked.id
      RETURNING l.id AS log_id, l.enrollment_id, l.sequence_step_id,
                l.prospect_id, l.body`,
    [orgId, userId, take, seatSlug, String(leaseMinutes)]
  );

  if (leased.rows.length === 0) {
    return { claimed: [], remainingBudget, cappedOut: false };
  }

  // Hydrate prospect name + linkedin_url for navigation. Owner scoping already
  // guaranteed by the lease join; re-scope here defensively.
  const prospectIds = [...new Set(leased.rows.map(r => r.prospect_id))];
  const pRes = await client.query(
    `SELECT id, first_name, last_name, linkedin_url, member_urn
       FROM prospects
      WHERE org_id = $1 AND id = ANY($2::int[])`,
    [orgId, prospectIds]
  );
  const pById = new Map(pRes.rows.map(p => [p.id, p]));

  const claimed = leased.rows.map(r => {
    const p = pById.get(r.prospect_id) || {};
    return {
      logId:        r.log_id,
      enrollmentId: r.enrollment_id,
      stepId:       r.sequence_step_id,
      prospectId:   r.prospect_id,
      note:         r.body || '',
      prospect: {
        name:        `${p.first_name || ''} ${p.last_name || ''}`.trim() || null,
        linkedinUrl: p.linkedin_url || null,
        memberUrn:   p.member_urn || null,
      },
    };
  });

  // Defensive: a leased row with no usable LinkedIn URL can never be actuated.
  // Release it immediately (back to scheduled is wrong — it'd just re-lease and
  // loop), so fail+pause it instead via reportFailure semantics. Keep it simple:
  // flip to failed with a clear reason and drop it from the returned batch.
  const actionable = [];
  for (const c of claimed) {
    if (!c.prospect.linkedinUrl) {
      await _failRow(client, {
        orgId, logId: c.logId, enrollmentId: c.enrollmentId, stepId: c.stepId,
        prospectId: c.prospectId, userId,
        reason: 'Prospect has no LinkedIn URL — cannot auto-send a connection request.',
      });
    } else {
      actionable.push(c);
    }
  }

  return {
    claimed: actionable,
    remainingBudget: remainingBudget - actionable.length,
    cappedOut: actionable.length >= remainingBudget,
  };
}

// ── Confirm ─────────────────────────────────────────────────────────────────
//
// The extension reports a successful click. Validate the lease ownership, flip
// sending→sent, record the connection_request_sent event (counter/stage parity),
// and advance the enrollment exactly like the email SEND branch does.
//
// `timeText` is optional ("Just now") — passed through to applyConnectionEvent
// for occurred_at parsing parity, though for a fresh send it'll resolve to now.
async function confirmSent(client, { orgId, userId, seatSlug, logId, timeText }) {
  // Lock the leased row + its enrollment. Must be MY seat's in-flight lease.
  const rowRes = await client.query(
    `SELECT l.id, l.enrollment_id, l.sequence_step_id, l.prospect_id,
            se.sequence_id, se.current_step, se.enrolled_by,
            s.name AS seq_name
       FROM sequence_step_logs l
       JOIN sequence_enrollments se ON se.id = l.enrollment_id
       JOIN sequences s             ON s.id  = se.sequence_id
      WHERE l.id = $1 AND l.org_id = $2
        AND l.channel = 'linkedin' AND l.status = 'sending'
        AND l.claimed_by_seat = $3
        AND se.enrolled_by = $4
      FOR UPDATE OF l, se`,
    [logId, orgId, seatSlug, userId]
  );
  if (rowRes.rows.length === 0) {
    // Either already finalized, lease reclaimed, or not this seat's row.
    return { ok: false, code: 'NOT_CLAIMABLE' };
  }
  const row = rowRes.rows[0];

  // Finalize: sending → sent, clear the lease.
  await client.query(
    `UPDATE sequence_step_logs
        SET status='sent', fired_at=NOW(), lease_expires_at=NULL
      WHERE id=$1`,
    [row.id]
  );

  // Record the outreach event with full manual-path parity (counters, stage
  // auto-advance, activity row). Load the prospect in the shape
  // applyConnectionEvent expects.
  const pRes = await client.query(
    `SELECT id, org_id, owner_id, first_name, last_name, company_name,
            stage, channel_data, outreach_count,
            lower(substring(linkedin_url from '/in/([^/?#]+)')) AS slug
       FROM prospects
      WHERE id = $1 AND org_id = $2`,
    [row.prospect_id, orgId]
  );
  if (pRes.rows.length) {
    try {
      await Sync.applyConnectionEvent(client, {
        orgId, userId,
        prospect: pRes.rows[0],
        event: 'connection_request_sent',
        person: { name: null, url: pRes.rows[0].slug ? `https://www.linkedin.com/in/${pRes.rows[0].slug}/` : null, timeText: timeText || null },
        viewerSlug: seatSlug,
      });
    } catch (evErr) {
      // The send DID happen; don't fail the confirm over a bookkeeping error.
      console.warn(`LinkedInAutoSendService.confirmSent: applyConnectionEvent failed for prospect ${row.prospect_id}: ${evErr.message}`);
    }
  }

  // A compact sequence-step activity for the outreach timeline (mirrors the
  // 'sequence_step_sent' email activity).
  try {
    await client.query(
      `INSERT INTO prospecting_activities
                   (org_id, prospect_id, user_id, activity_type, description, metadata)
            VALUES ($1, $2, $3, 'sequence_step_sent', $4, $5)`,
      [orgId, row.prospect_id, userId,
       `LinkedIn connection request auto-sent — ${row.seq_name} step ${row.current_step}`,
       JSON.stringify({
         enrollmentId: row.enrollment_id, sequenceId: row.sequence_id,
         stepOrder: row.current_step, stepId: row.sequence_step_id,
         channel: 'linkedin', step_intent: 'connection_request',
         auto_sent: true, linkedin_seat: seatSlug,
       })]
    );
  } catch (actErr) {
    console.warn(`LinkedInAutoSendService.confirmSent: activity log failed for enrollment ${row.enrollment_id}:`, actErr.message);
  }

  // Advance the enrollment — identical shape to the firer's email advance.
  const settings = await SendingSchedule.resolveSettings({ orgId });
  const nextStepRes = await client.query(
    `SELECT * FROM sequence_steps WHERE sequence_id=$1 AND step_order=$2`,
    [row.sequence_id, row.current_step + 1]
  );
  if (nextStepRes.rows.length) {
    const nextStep = nextStepRes.rows[0];
    await client.query(
      `UPDATE sequence_enrollments
          SET current_step=$1, next_step_due=$2
        WHERE id=$3`,
      [row.current_step + 1, SendingSchedule.nextStepDue(nextStep, settings), row.enrollment_id]
    );
  } else {
    await client.query(
      `UPDATE sequence_enrollments
          SET status='completed', completed_at=NOW()
        WHERE id=$1`,
      [row.enrollment_id]
    );
  }

  return { ok: true, advanced: nextStepRes.rows.length > 0 };
}

// ── Report failure ───────────────────────────────────────────────────────────
//
// The extension hit a hard problem on this row (Connect button gone, profile
// unreachable, or — passed up but handled at the run level — a challenge). Flip
// sending→failed and pause the enrollment so a human looks. Seat-scoped.
async function reportFailure(client, { orgId, userId, seatSlug, logId, reason }) {
  const rowRes = await client.query(
    `SELECT l.id, l.enrollment_id, l.sequence_step_id, l.prospect_id,
            se.current_step, se.enrolled_by, s.name AS seq_name
       FROM sequence_step_logs l
       JOIN sequence_enrollments se ON se.id = l.enrollment_id
       JOIN sequences s             ON s.id  = se.sequence_id
      WHERE l.id = $1 AND l.org_id = $2
        AND l.channel = 'linkedin' AND l.status = 'sending'
        AND l.claimed_by_seat = $3
        AND se.enrolled_by = $4
      FOR UPDATE OF l, se`,
    [logId, orgId, seatSlug, userId]
  );
  if (rowRes.rows.length === 0) return { ok: false, code: 'NOT_CLAIMABLE' };
  const row = rowRes.rows[0];

  await _failRow(client, {
    orgId, logId: row.id, enrollmentId: row.enrollment_id, stepId: row.sequence_step_id,
    prospectId: row.prospect_id, userId, seqName: row.seq_name, stepOrder: row.current_step,
    reason: reason || 'LinkedIn auto-send failed',
  });
  return { ok: true };
}

// Shared fail path: row → failed, enrollment → paused (no retry), activity +
// owner action. LinkedIn-specific copy (the email failAndPause talks about
// reconnecting a sender, which is meaningless here).
async function _failRow(client, { orgId, logId, enrollmentId, stepId, prospectId, userId, seqName, stepOrder, reason }) {
  const errMsg = String(reason || 'LinkedIn auto-send failed').slice(0, 1000);

  await client.query(
    `UPDATE sequence_step_logs
        SET status='failed', error_message=$2, fired_at=NOW(), lease_expires_at=NULL
      WHERE id=$1`,
    [logId, errMsg]
  );
  await client.query(
    `UPDATE sequence_enrollments
        SET status='paused', stop_reason='linkedin_autosend_failed'
      WHERE id=$1 AND status='active'`,
    [enrollmentId]
  );
  try {
    await client.query(
      `INSERT INTO prospecting_activities
                   (org_id, prospect_id, user_id, activity_type, description, metadata)
            VALUES ($1, $2, $3, 'sequence_send_failed', $4, $5)`,
      [orgId, prospectId, userId,
       `LinkedIn auto-send paused — ${seqName || 'sequence'} step ${stepOrder ?? '?'}: ${errMsg}`,
       JSON.stringify({ enrollmentId, stepId, stepOrder: stepOrder ?? null, reason: errMsg, channel: 'linkedin' })]
    );
  } catch (e) {
    console.warn(`LinkedInAutoSendService._failRow: activity log failed for enrollment ${enrollmentId}:`, e.message);
  }
  try {
    await client.query(
      `INSERT INTO prospecting_actions
                   (org_id, user_id, prospect_id, title, description,
                    action_type, channel, status, priority, due_date, source, metadata)
       SELECT $1, $2, $3,
              'LinkedIn auto-send paused — review & resume',
              $4, 'outreach', 'linkedin', 'pending', 'high', NOW(),
              'linkedin_autosend_failed',
              jsonb_build_object('enrollmentId', $5::int, 'stepId', $6::int,
                                 'stepOrder', $7::int, 'reason', $8::text)
        WHERE NOT EXISTS (
          SELECT 1 FROM prospecting_actions pa
           WHERE pa.source = 'linkedin_autosend_failed'
             AND (pa.metadata->>'enrollmentId')::int = $5::int
             AND (pa.metadata->>'stepId')::int       = $6::int
             AND pa.status != 'completed'
        )`,
      [orgId, userId, prospectId,
       `The LinkedIn connection request for ${seqName || 'this sequence'} step ${stepOrder ?? '?'} could not be auto-sent: ${errMsg}. `
         + `Send it manually from the prospect, then resume the enrollment.`,
       enrollmentId, stepId, stepOrder ?? 0, errMsg]
    );
  } catch (e) {
    console.warn(`LinkedInAutoSendService._failRow: action insert failed for enrollment ${enrollmentId}:`, e.message);
  }
}

// ── Reclaim expired leases (cron sweep) ───────────────────────────────────────
//
// Return any 'sending' LinkedIn row whose lease expired back to 'scheduled' so a
// later claim can re-offer it. This is the SAFE counterpart to the email reaper:
// an expired lease almost always means the rep closed the browser BEFORE the
// click happened (the extension confirms immediately after a successful click),
// so re-offering is correct and idempotent. Runs on its own pool client.
async function reclaimExpiredLeases(pool) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `UPDATE sequence_step_logs
          SET status='scheduled', claimed_by_seat=NULL, lease_expires_at=NULL
        WHERE channel='linkedin' AND status='sending'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < NOW()
        RETURNING id`
    );
    const n = r.rowCount || 0;
    if (n > 0) console.log(`🔗 LinkedInAutoSend.reclaimExpiredLeases: reclaimed ${n} expired lease(s) → scheduled`);
    return { reclaimed: n };
  } catch (err) {
    console.error('LinkedInAutoSend.reclaimExpiredLeases error:', err.message);
    return { reclaimed: 0 };
  } finally {
    client.release();
  }
}

module.exports = {
  countSeatSendsLast24h,
  claimForSeat,
  confirmSent,
  reportFailure,
  reclaimExpiredLeases,
};
