/**
 * Calendar Sync Scheduler
 * Fetches calendar events from Outlook and stores to database
 *
 * MULTI-ORG changes:
 *   - findContactByEmail(client, orgId, email)
 *     contacts table has no user_id — scoped by org_id only
 *   - findActiveDeal(client, userId, orgId, accountId)
 *     deals scoped by user_id AND org_id
 *   - storeMeetingToDatabase(client, userId, orgId, meeting)
 *     dedup query includes org_id; meetings INSERT includes org_id
 *   - triggerCalendarSync(userId, options) — options.orgId required
 *     calendar_sync_history INSERT includes org_id
 *   - getCalendarSyncStatus(userId, orgId) — history scoped by org_id
 */

const { pool } = require('../config/database');
const { fetchCalendarEvents, parseEventToMeeting } = require('../services/calendarService');

/**
 * Find contact by email address.
 * contacts are org-scoped — no user_id column on that table.
 */
async function findContactByEmail(client, orgId, email) {
  if (!email) return null;

  const result = await client.query(
    `SELECT id, account_id FROM contacts
     WHERE org_id = $1
       AND LOWER(email) = LOWER($2)
       AND deleted_at IS NULL
     LIMIT 1`,
    [orgId, email]
  );

  return result.rows[0] || null;
}

/**
 * Find active deal for contact/account — scoped by user_id AND org_id.
 */
async function findActiveDeal(client, userId, orgId, accountId) {
  if (!accountId) return null;

  const result = await client.query(
    `SELECT id FROM deals
     WHERE user_id = $1
       AND org_id = $2
       AND account_id = $3
       AND stage NOT IN ('closed_won', 'closed_lost')
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, orgId, accountId]
  );

  return result.rows[0]?.id || null;
}

/**
 * Store meeting to database with deduplication.
 */
async function storeMeetingToDatabase(client, userId, orgId, meeting) {
  // Dedup scoped to user + org
  const existingCheck = await client.query(
    `SELECT id FROM meetings
     WHERE user_id = $1 AND org_id = $2 AND external_id = $3`,
    [userId, orgId, meeting.external_id]
  );

  if (existingCheck.rows.length > 0) {
    console.log(`⭐️ Skipping duplicate meeting: ${meeting.title}`);
    return { skipped: true, meetingId: existingCheck.rows[0].id };
  }

  // Try to find contact and deal from attendees/organizer
  let contactId = null;
  let dealId    = null;

  // Check organizer first
  if (meeting.organizer) {
    const contact = await findContactByEmail(client, orgId, meeting.organizer);
    if (contact) {
      contactId = contact.id;
      dealId    = await findActiveDeal(client, userId, orgId, contact.account_id);
    }
  }

  // If no contact found from organizer, check attendees
  if (!contactId && meeting.attendees?.length > 0) {
    for (const attendeeEmail of meeting.attendees) {
      const contact = await findContactByEmail(client, orgId, attendeeEmail);
      if (contact) {
        contactId = contact.id;
        dealId    = await findActiveDeal(client, userId, orgId, contact.account_id);
        break;
      }
    }
  }

  // Insert meeting with org_id
  const insertResult = await client.query(
    `INSERT INTO meetings (
      org_id, user_id, deal_id, title, description, meeting_type,
      start_time, end_time, location, status,
      external_id, source, external_data, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    RETURNING id`,
    [
      orgId,
      userId,
      dealId,
      meeting.title,
      meeting.description,
      meeting.meeting_type,
      meeting.start_time,
      meeting.end_time,
      meeting.location,
      meeting.status,
      meeting.external_id,
      meeting.source,
      JSON.stringify(meeting.external_data),
    ]
  );

  const newMeetingId = insertResult.rows[0].id;
  console.log(`✅ Stored meeting ${newMeetingId}: ${meeting.title}`);

  return { stored: true, meetingId: newMeetingId, dealId };
}

/**
 * Trigger calendar sync for a user.
 * @param {number} userId
 * @param {{ orgId: number, startDate?: string, endDate?: string, top?: number }} options
 */
async function triggerCalendarSync(userId, options = {}) {
  const { orgId } = options;
  const client = await pool.connect();

  try {
    console.log(`📅 Triggering calendar sync for user ${userId} org ${orgId}`);

    await client.query('BEGIN');

    // Create sync history record — includes org_id
    const syncHistoryResult = await client.query(
      `INSERT INTO calendar_sync_history
       (user_id, org_id, sync_type, status, created_at)
       VALUES ($1, $2, 'calendar', 'in_progress', NOW())
       RETURNING id`,
      [userId, orgId]
    );
    const syncHistoryId = syncHistoryResult.rows[0].id;

    // Get date range for sync (default: next 30 days)
    const startDate = options.startDate || new Date().toISOString();
    const endDate   = options.endDate   || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch calendar events from Outlook
    const result = await fetchCalendarEvents(userId, {
      top:           options.top || 100,
      startDateTime: startDate,
      endDateTime:   endDate,
    });

    console.log(`📅 Found ${result.events.length} calendar events for user ${userId}`);

    let stored  = 0;
    let skipped = 0;
    let failed  = 0;

    for (const event of result.events) {
      try {
        const meeting     = parseEventToMeeting(event);
        const storeResult = await storeMeetingToDatabase(client, userId, orgId, meeting);

        if (storeResult.skipped) skipped++;
        else if (storeResult.stored) stored++;
      } catch (error) {
        console.error(`❌ Error processing event "${event.subject}":`, error.message);
        failed++;
      }
    }

    // Update sync history
    await client.query(
      `UPDATE calendar_sync_history
       SET status = 'completed',
           items_processed = $2,
           items_failed = $3,
           last_sync_date = NOW()
       WHERE id = $1`,
      [syncHistoryId, stored, failed]
    );

    await client.query('COMMIT');

    console.log(`✅ Calendar sync completed: ${stored} stored, ${skipped} skipped, ${failed} failed`);

    return { success: true, eventsFound: result.events.length, stored, skipped, failed };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ Calendar sync failed for user ${userId}:`, error);

    try {
      await client.query(
        `UPDATE calendar_sync_history
         SET status = 'failed', error_message = $2
         WHERE id = (
           SELECT id FROM calendar_sync_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1
         )`,
        [userId, error.message]
      );
    } catch (updateError) {
      console.error('Failed to update sync history:', updateError);
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get calendar sync status for user, scoped to their current org.
 * @param {number} userId
 * @param {number} orgId
 */
async function getCalendarSyncStatus(userId, orgId) {
  const result = await pool.query(
    `SELECT * FROM calendar_sync_history
     WHERE user_id = $1 AND org_id = $2
     ORDER BY created_at DESC
     LIMIT 10`,
    [userId, orgId]
  );

  return result.rows;
}

module.exports = {
  triggerCalendarSync,
  getCalendarSyncStatus,
};
