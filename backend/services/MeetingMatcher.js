/**
 * MeetingMatcher.js
 * backend/services/MeetingMatcher.js
 *
 * Finds the CRM meeting matching a transcript.
 * Fuzzy match now checks both contacts AND prospects in meeting_attendees.
 */

const { pool } = require('../config/database');
const FUZZY_WINDOW_MS = 15 * 60 * 1000;

async function findMeeting(normalized, orgId, userId = null) {
  const client = await pool.connect();
  try {
    // Strategy 1: exact external_id match
    if (normalized.externalMeetingId) {
      const exact = await client.query(
        `SELECT id, user_id FROM meetings
         WHERE org_id = $1 AND external_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [orgId, String(normalized.externalMeetingId)],
      );
      if (exact.rows.length > 0) {
        console.log(`🎯 MeetingMatcher: EXACT match — meeting ${exact.rows[0].id}`);
        return { meetingId: exact.rows[0].id, confidence: 'exact', userId: exact.rows[0].user_id };
      }
    }

    // Strategy 2: time window + email overlap (contacts OR prospects)
    if (normalized.meetingStartTime && normalized.speakerEmails?.length > 0) {
      const startTime   = new Date(normalized.meetingStartTime);
      const windowStart = new Date(startTime.getTime() - FUZZY_WINDOW_MS).toISOString();
      const windowEnd   = new Date(startTime.getTime() + FUZZY_WINDOW_MS).toISOString();
      const lowerEmails = normalized.speakerEmails.map(e => e.toLowerCase());
      const userClause  = userId ? 'AND m.user_id = $4' : '';
      const params      = [orgId, windowStart, windowEnd];
      if (userId) params.push(userId);

      const candidates = await client.query(
        `SELECT DISTINCT m.id, m.user_id
         FROM meetings m
         LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
         LEFT JOIN contacts  c ON c.id  = ma.contact_id
         LEFT JOIN prospects p ON p.id  = ma.prospect_id
         WHERE m.org_id = $1
           AND m.start_time BETWEEN $2 AND $3
           AND m.deleted_at IS NULL
           ${userClause}
           AND (
             LOWER(c.email) = ANY($${params.length + 1}::text[])
             OR LOWER(p.email) = ANY($${params.length + 1}::text[])
           )
         ORDER BY m.id LIMIT 5`,
        [...params, lowerEmails],
      );

      if (candidates.rows.length > 0) {
        const match = candidates.rows[0];
        console.log(`🔍 MeetingMatcher: FUZZY match — meeting ${match.id}`);
        return { meetingId: match.id, confidence: 'fuzzy', userId: match.user_id };
      }
    }

    console.log(`❓ MeetingMatcher: NO match (provider: ${normalized.sourceProvider}, title: "${normalized.meetingTitle || 'unknown'}")`);
    return { meetingId: null, confidence: 'none', userId: null };

  } finally {
    client.release();
  }
}

module.exports = { findMeeting };
