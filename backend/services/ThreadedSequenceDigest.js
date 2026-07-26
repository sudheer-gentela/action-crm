// ─────────────────────────────────────────────────────────────────────────────
// services/ThreadedSequenceDigest.js  (2026_71)
//
// Daily roll-up for owners with threaded/pinned enrollments still parked by the
// 'defer' failover path (status='paused', stop_reason='thread_sender_blocked').
// The immediate alert fires once at the moment of pausing (pauseThreadBlocked in
// SequenceStepFirer); this job is the recurring nudge that keeps reminding the
// owner every day UNTIL they resolve it — reconnect the pinned mailbox, switch
// to another sender from the same user, or stop the sequence.
//
// Mirrors NetworkWeeklyDigest / contractNotificationService: pure logic invoked
// from the server.js cron. One digest notification per owner per run.
//
// Run daily from cron (e.g. 08:00 UTC):
//   const { sent } = await require('./services/ThreadedSequenceDigest').sendDailyDigests(pool);
//
// The scan rides the partial index idx_seq_enroll_thread_paused
// (org_id, enrolled_by) WHERE status='paused' AND stop_reason='thread_sender_blocked',
// so it stays flat regardless of total enrollment volume.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const ThreadedSequenceNotifier = require('./ThreadedSequenceNotifier');

async function sendDailyDigests(pool) {
  const client = await pool.connect();
  try {
    // All currently-blocked threaded enrollments, ordered so we can group by
    // (org, owner) in a single linear pass.
    const res = await client.query(
      `SELECT se.id           AS enrollment_id,
              se.org_id        AS org_id,
              se.enrolled_by   AS user_id,
              se.prospect_id   AS prospect_id,
              se.pinned_sender_account_id AS sender_id,
              s.id             AS seq_id,
              s.name           AS seq_name
         FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id
        WHERE se.status = 'paused'
          AND se.stop_reason = 'thread_sender_blocked'
        ORDER BY se.org_id, se.enrolled_by, s.name`
    );

    if (!res.rows.length) return { sent: 0, owners: 0, blocked: 0 };

    // Group by (org_id, user_id).
    const groups = new Map(); // key `${orgId}:${userId}` -> { orgId, userId, blocked: [] }
    for (const r of res.rows) {
      const key = `${r.org_id}:${r.user_id}`;
      if (!groups.has(key)) {
        groups.set(key, { orgId: r.org_id, userId: r.user_id, blocked: [] });
      }
      groups.get(key).blocked.push({
        enrollmentId: r.enrollment_id,
        seqId:        r.seq_id,
        seqName:      r.seq_name,
        senderId:     r.sender_id,
        prospectId:   r.prospect_id,
      });
    }

    let sent = 0;
    for (const { orgId, userId, blocked } of groups.values()) {
      try {
        await ThreadedSequenceNotifier.notifyDigest(client, { orgId, userId, blocked });
        sent++;
      } catch (e) {
        console.warn(`ThreadedSequenceDigest: notify failed for org ${orgId} user ${userId}:`, e.message);
      }
    }

    return { sent, owners: groups.size, blocked: res.rows.length };
  } finally {
    client.release();
  }
}

module.exports = { sendDailyDigests };
