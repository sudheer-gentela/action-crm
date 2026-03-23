/**
 * AttendeeReconciler.js
 * backend/services/AttendeeReconciler.js
 *
 * Updates meeting_attendees attendance_status from transcript speaker emails.
 * Handles both contact rows and prospect rows in meeting_attendees.
 * Never modifies rows where source = 'manual'.
 */

const { pool } = require('../config/database');

async function reconcile(meetingId, orgId, speakerEmails) {
  if (!speakerEmails?.length) {
    console.log(`⚠️  AttendeeReconciler: no speaker emails for meeting ${meetingId}`);
    return { attended: 0, noShow: 0, newAttendees: 0 };
  }

  const client = await pool.connect();
  const lowerEmails = speakerEmails.map(e => e.toLowerCase());

  try {
    await client.query('BEGIN');

    // Fetch all existing attendee rows, joining both contacts and prospects for email
    const existingRows = await client.query(
      `SELECT
         ma.id, ma.contact_id, ma.prospect_id,
         ma.attendance_status, ma.source,
         COALESCE(c.email, p.email) AS email
       FROM meeting_attendees ma
       LEFT JOIN contacts  c ON c.id = ma.contact_id
       LEFT JOIN prospects p ON p.id = ma.prospect_id
       WHERE ma.meeting_id = $1 AND ma.org_id = $2`,
      [meetingId, orgId],
    );

    let attended = 0, noShow = 0, newAttendees = 0;
    const matchedEmails = new Set();

    // Update existing rows
    for (const row of existingRows.rows) {
      if (row.source === 'manual') continue;

      const emailMatches = lowerEmails.includes(row.email?.toLowerCase());

      if (emailMatches) {
        if (row.attendance_status !== 'attended') {
          await client.query(
            `UPDATE meeting_attendees SET attendance_status='attended', source='transcript' WHERE id=$1`,
            [row.id],
          );
          attended++;
        }
        matchedEmails.add(row.email?.toLowerCase());
      } else if (row.attendance_status === 'invited') {
        await client.query(
          `UPDATE meeting_attendees SET attendance_status='no_show', source='transcript' WHERE id=$1`,
          [row.id],
        );
        noShow++;
      }
    }

    // Find new attendees not on the invite list
    const unmatchedEmails = lowerEmails.filter(e => !matchedEmails.has(e));

    if (unmatchedEmails.length > 0) {
      // Check contacts
      const contactResult = await client.query(
        `SELECT id FROM contacts WHERE org_id=$1 AND LOWER(email)=ANY($2::text[]) AND deleted_at IS NULL`,
        [orgId, unmatchedEmails],
      );
      for (const contact of contactResult.rows) {
        await client.query(
          `INSERT INTO meeting_attendees (meeting_id, contact_id, org_id, attendance_status, source)
           VALUES ($1,$2,$3,'attended','transcript') ON CONFLICT DO NOTHING`,
          [meetingId, contact.id, orgId],
        );
        newAttendees++;
      }

      // Check prospects (for emails not matched to contacts)
      const matchedContactEmails = new Set(contactResult.rows.map(c => c.email?.toLowerCase()));
      const stillUnmatched = unmatchedEmails.filter(e => !matchedContactEmails.has(e));

      if (stillUnmatched.length > 0) {
        const prospectResult = await client.query(
          `SELECT id FROM prospects WHERE org_id=$1 AND LOWER(email)=ANY($2::text[]) AND deleted_at IS NULL`,
          [orgId, stillUnmatched],
        );
        for (const prospect of prospectResult.rows) {
          await client.query(
            `INSERT INTO meeting_attendees (meeting_id, prospect_id, org_id, attendance_status, source)
             VALUES ($1,$2,$3,'attended','transcript') ON CONFLICT DO NOTHING`,
            [meetingId, prospect.id, orgId],
          );
          newAttendees++;
        }
      }
    }

    await client.query('COMMIT');
    console.log(`👥 AttendeeReconciler meeting ${meetingId}: ${attended} attended, ${noShow} no-show, ${newAttendees} new`);
    return { attended, noShow, newAttendees };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { reconcile };
