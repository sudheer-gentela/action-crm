/**
 * AttendeeReconciler.js
 * backend/services/AttendeeReconciler.js
 *
 * Given a matched meeting and a list of speaker emails from a transcript,
 * reconciles the meeting_attendees table:
 *
 *   invited  → attended   (speaker email matches an existing invited row)
 *   invited  → no_show    (invited but email NOT in speaker list)
 *   new      → attended   (speaker email not on invite list — joined anyway)
 *
 * CRITICAL RULE: rows where source = 'manual' are NEVER modified.
 * A rep's manual override always takes precedence over automated inference.
 */

const { pool } = require('../config/database');

/**
 * Reconcile attendees for a meeting based on transcript speaker emails.
 *
 * @param {number} meetingId
 * @param {number} orgId
 * @param {string[]} speakerEmails — flat list of emails from transcript
 * @returns {Promise<{ attended: number, noShow: number, newAttendees: number }>}
 */
async function reconcile(meetingId, orgId, speakerEmails) {
  if (!speakerEmails || speakerEmails.length === 0) {
    console.log(`⚠️  AttendeeReconciler: no speaker emails for meeting ${meetingId} — skipping`);
    return { attended: 0, noShow: 0, newAttendees: 0 };
  }

  const client = await pool.connect();
  const lowerEmails = speakerEmails.map(e => e.toLowerCase());

  try {
    await client.query('BEGIN');

    // ── Fetch existing attendee rows (skip source='manual') ───────
    const existingRows = await client.query(
      `SELECT ma.id, ma.contact_id, ma.attendance_status, ma.source, c.email
       FROM meeting_attendees ma
       JOIN contacts c ON c.id = ma.contact_id
       WHERE ma.meeting_id = $1
         AND ma.org_id     = $2`,
      [meetingId, orgId]
    );

    let attended    = 0;
    let noShow      = 0;
    let newAttendees = 0;

    const existingContactIds  = new Set(existingRows.rows.map(r => r.contact_id));
    const matchedContactEmails = new Set();

    // ── Update existing rows ──────────────────────────────────────
    for (const row of existingRows.rows) {
      // Never touch manual overrides
      if (row.source === 'manual') continue;

      const emailMatches = lowerEmails.includes(row.email?.toLowerCase());

      if (emailMatches) {
        if (row.attendance_status !== 'attended') {
          await client.query(
            `UPDATE meeting_attendees
             SET attendance_status = 'attended',
                 source            = 'transcript'
             WHERE id = $1`,
            [row.id]
          );
          attended++;
        }
        matchedContactEmails.add(row.email?.toLowerCase());
      } else {
        // Was invited but didn't appear in transcript
        if (row.attendance_status === 'invited') {
          await client.query(
            `UPDATE meeting_attendees
             SET attendance_status = 'no_show',
                 source            = 'transcript'
             WHERE id = $1`,
            [row.id]
          );
          noShow++;
        }
      }
    }

    // ── Find and insert new attendees (in transcript but not invited) ─
    const unmatchedEmails = lowerEmails.filter(
      email => !matchedContactEmails.has(email)
    );

    if (unmatchedEmails.length > 0) {
      // Look up contacts by email in this org
      const contactResult = await client.query(
        `SELECT id, email
         FROM contacts
         WHERE org_id      = $1
           AND LOWER(email) = ANY($2::text[])
           AND deleted_at   IS NULL`,
        [orgId, unmatchedEmails]
      );

      for (const contact of contactResult.rows) {
        // Skip if already in meeting_attendees (edge case)
        if (existingContactIds.has(contact.id)) continue;

        await client.query(
          `INSERT INTO meeting_attendees
             (meeting_id, contact_id, org_id, attendance_status, source)
           VALUES ($1, $2, $3, 'attended', 'transcript')
           ON CONFLICT DO NOTHING`,
          [meetingId, contact.id, orgId]
        );
        newAttendees++;
      }
    }

    await client.query('COMMIT');

    console.log(
      `👥 AttendeeReconciler meeting ${meetingId}: ` +
      `${attended} attended, ${noShow} no-show, ${newAttendees} new`
    );

    return { attended, noShow, newAttendees };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { reconcile };
