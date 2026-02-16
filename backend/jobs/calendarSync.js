/**
 * Calendar Sync Scheduler
 * Fetches calendar events from Outlook and stores to database
 */

const { pool } = require('../config/database');
const { fetchCalendarEvents, parseEventToMeeting } = require('../services/calendarService');

/**
 * Find contact by email address
 */
async function findContactByEmail(client, userId, email) {
  if (!email) return null;
  
  const result = await client.query(
    `SELECT id, account_id FROM contacts 
     WHERE user_id = $1 
       AND LOWER(email) = LOWER($2)
       AND deleted_at IS NULL
     LIMIT 1`,
    [userId, email]
  );
  
  return result.rows[0] || null;
}

/**
 * Find active deal for contact/account
 */
async function findActiveDeal(client, userId, accountId) {
  if (!accountId) return null;
  
  const result = await client.query(
    `SELECT id FROM deals 
     WHERE user_id = $1 
       AND account_id = $2
       AND stage NOT IN ('closed_won', 'closed_lost')
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, accountId]
  );
  
  return result.rows[0]?.id || null;
}

/**
 * Store meeting to database with deduplication
 */
async function storeMeetingToDatabase(client, userId, meeting) {
  // Check for duplicate using external_id
  const existingCheck = await client.query(
    `SELECT id FROM meetings 
     WHERE user_id = $1 AND external_id = $2`,
    [userId, meeting.external_id]
  );
  
  if (existingCheck.rows.length > 0) {
    console.log(`⭐️ Skipping duplicate meeting: ${meeting.title}`);
    return { skipped: true, meetingId: existingCheck.rows[0].id };
  }
  
  // Try to find contact and deal from attendees/organizer
  let contactId = null;
  let dealId = null;
  
  // Check organizer first
  if (meeting.organizer) {
    const contact = await findContactByEmail(client, userId, meeting.organizer);
    if (contact) {
      contactId = contact.id;
      dealId = await findActiveDeal(client, userId, contact.account_id);
    }
  }
  
  // If no contact found, check attendees
  if (!contactId && meeting.attendees?.length > 0) {
    for (const attendeeEmail of meeting.attendees) {
      const contact = await findContactByEmail(client, userId, attendeeEmail);
      if (contact) {
        contactId = contact.id;
        dealId = await findActiveDeal(client, userId, contact.account_id);
        break;
      }
    }
  }
  
  // Insert meeting
  const insertResult = await client.query(
    `INSERT INTO meetings (
      user_id, deal_id, title, description, meeting_type,
      start_time, end_time, location, status,
      external_id, source, external_data, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    RETURNING id`,
    [
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
      JSON.stringify(meeting.external_data)
    ]
  );
  
  const newMeetingId = insertResult.rows[0].id;
  
  console.log(`✅ Stored meeting ${newMeetingId}: ${meeting.title}`);
  
  return { stored: true, meetingId: newMeetingId, dealId };
}

/**
 * Trigger calendar sync for a user
 */
async function triggerCalendarSync(userId, options = {}) {
  const client = await pool.connect();
  
  try {
    console.log(`📅 Triggering calendar sync for user ${userId}`);
    
    await client.query('BEGIN');
    
    // Create sync history record
    const syncHistoryResult = await client.query(
      `INSERT INTO calendar_sync_history 
       (user_id, sync_type, status, created_at)
       VALUES ($1, 'calendar', 'in_progress', NOW())
       RETURNING id`,
      [userId]
    );
    const syncHistoryId = syncHistoryResult.rows[0].id;
    
    // Get date range for sync (default: next 30 days)
    const startDate = options.startDate || new Date().toISOString();
    const endDate = options.endDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // Fetch calendar events from Outlook
    const result = await fetchCalendarEvents(userId, {
      top: options.top || 100,
      startDateTime: startDate,
      endDateTime: endDate
    });
    
    console.log(`📅 Found ${result.events.length} calendar events for user ${userId}`);
    
    // Process each event
    let stored = 0;
    let skipped = 0;
    let failed = 0;
    
    for (const event of result.events) {
      try {
        const meeting = parseEventToMeeting(event);
        const storeResult = await storeMeetingToDatabase(client, userId, meeting);
        
        if (storeResult.skipped) {
          skipped++;
        } else if (storeResult.stored) {
          stored++;
        }
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
    
    return {
      success: true,
      eventsFound: result.events.length,
      stored,
      skipped,
      failed
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ Calendar sync failed for user ${userId}:`, error);
    
    // Record failed sync
    try {
      await client.query(
        `UPDATE calendar_sync_history 
         SET status = 'failed',
             error_message = $2
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
 * Get calendar sync status for user
 */
async function getCalendarSyncStatus(userId) {
  const result = await pool.query(
    `SELECT * FROM calendar_sync_history 
     WHERE user_id = $1 
     ORDER BY created_at DESC 
     LIMIT 10`,
    [userId]
  );
  
  return result.rows;
}

module.exports = {
  triggerCalendarSync,
  getCalendarSyncStatus
};
