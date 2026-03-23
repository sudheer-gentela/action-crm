/**
 * MeetingMatcher.js
 * backend/services/MeetingMatcher.js
 *
 * Given a NormalizedTranscript and an org/user scope, finds the matching
 * meeting row in the database.
 *
 * Match strategy (in priority order):
 *   1. EXACT  — externalMeetingId matches meetings.external_id
 *   2. FUZZY  — meetingStartTime within ±15 minutes AND at least one
 *               speakerEmail matches a meeting_attendees contact email
 *   3. NONE   — no match found; transcript stored unlinked
 *
 * Returns:
 *   { meetingId: number, confidence: 'exact'|'fuzzy'|'none', userId: number|null }
 */

const { pool } = require('../config/database');

const FUZZY_WINDOW_MS = 15 * 60 * 1000;  // ±15 minutes

/**
 * Find a meeting for this transcript.
 *
 * @param {object} normalized — NormalizedTranscript from a parser
 * @param {number} orgId
 * @param {number|null} userId — null for org-level webhooks (match any user in org)
 * @returns {Promise<{ meetingId: number|null, confidence: string, userId: number|null }>}
 */
async function findMeeting(normalized, orgId, userId = null) {
  const client = await pool.connect();

  try {
    // ── Strategy 1: Exact external_id match ─────────────────────
    if (normalized.externalMeetingId) {
      const exact = await client.query(
        `SELECT id, user_id
         FROM meetings
         WHERE org_id     = $1
           AND external_id = $2
           AND deleted_at  IS NULL
         LIMIT 1`,
        [orgId, String(normalized.externalMeetingId)]
      );

      if (exact.rows.length > 0) {
        console.log(
          `🎯 MeetingMatcher: EXACT match — ` +
          `meeting ${exact.rows[0].id} via external_id ${normalized.externalMeetingId}`
        );
        return {
          meetingId:  exact.rows[0].id,
          confidence: 'exact',
          userId:     exact.rows[0].user_id,
        };
      }
    }

    // ── Strategy 2: Fuzzy — time window + email overlap ──────────
    if (normalized.meetingStartTime && normalized.speakerEmails?.length > 0) {
      const startTime   = new Date(normalized.meetingStartTime);
      const windowStart = new Date(startTime.getTime() - FUZZY_WINDOW_MS).toISOString();
      const windowEnd   = new Date(startTime.getTime() + FUZZY_WINDOW_MS).toISOString();

      // Find meetings in the time window for this org (scoped to user if provided)
      const userClause = userId ? 'AND m.user_id = $4' : '';
      const params     = [orgId, windowStart, windowEnd];
      if (userId) params.push(userId);

      const candidates = await client.query(
        `SELECT DISTINCT m.id, m.user_id
         FROM meetings m
         JOIN meeting_attendees ma ON ma.meeting_id = m.id
         JOIN contacts c           ON c.id = ma.contact_id
         WHERE m.org_id    = $1
           AND m.start_time BETWEEN $2 AND $3
           AND m.deleted_at IS NULL
           ${userClause}
           AND LOWER(c.email) = ANY($${params.length + 1}::text[])
         ORDER BY m.id
         LIMIT 5`,
        [...params, normalized.speakerEmails.map(e => e.toLowerCase())]
      );

      if (candidates.rows.length > 0) {
        // Take the first (closest to the window start would need extra sort — first is fine)
        const match = candidates.rows[0];
        console.log(
          `🔍 MeetingMatcher: FUZZY match — ` +
          `meeting ${match.id} via time window + email overlap`
        );
        return {
          meetingId:  match.id,
          confidence: 'fuzzy',
          userId:     match.user_id,
        };
      }
    }

    // ── Strategy 3: No match ─────────────────────────────────────
    console.log(
      `❓ MeetingMatcher: NO match for transcript ` +
      `(provider: ${normalized.sourceProvider}, ` +
      `title: "${normalized.meetingTitle || 'unknown'}", ` +
      `time: ${normalized.meetingStartTime || 'unknown'})`
    );

    return { meetingId: null, confidence: 'none', userId: null };

  } finally {
    client.release();
  }
}

module.exports = { findMeeting };
