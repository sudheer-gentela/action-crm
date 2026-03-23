/**
 * Calendar Sync Scheduler
 * backend/jobs/calendarSync.js
 *
 * Phase 1 changes applied:
 *   - storeMeetingToDatabase now inserts ALL matched attendee contacts
 *     into meeting_attendees with attendance_status='invited', source='calendar'
 *   - meetings INSERT now includes account_id
 *   - triggerCalendarSync returns meetingIds[] for downstream use
 */

const { pool } = require('../config/database');
const {
  fetchCalendarEvents: fetchOutlookEvents,
  parseEventToMeeting: parseOutlookEvent,
} = require('../services/calendarService');
const { fetchCalendarEvents: fetchGoogleEvents } = require('../services/googleService');

// ── Google Calendar → meetings table mapper ──────────────────────────────────
function parseGoogleEventToMeeting(event) {
  const isAllDay = event.start && !event.start.includes('T');

  return {
    external_id:   event.id,
    source:        'google',
    title:         event.title || '(No title)',
    description:   event.description || '',
    start_time:    isAllDay ? new Date(event.start + 'T00:00:00') : new Date(event.start),
    end_time:      isAllDay ? new Date(event.end   + 'T23:59:59') : new Date(event.end),
    location:      event.location || null,
    meeting_type:  inferMeetingType(event),
    status:
      event.status === 'cancelled' ? 'cancelled'
      : (event.attendees || []).some(a => a.status === 'accepted') ? 'confirmed'
      : 'scheduled',
    attendees:  (event.attendees || []).map(a => a.email).filter(Boolean),
    organizer:  (event.attendees || []).find(a => a.organizer)?.email || null,
    external_data: {
      htmlLink:        event.htmlLink,
      attendeeDetails: event.attendees,
      isAllDay,
    },
  };
}

function inferMeetingType(event) {
  const text = ((event.title || '') + ' ' + (event.description || '')).toLowerCase();
  if (text.includes('demo'))                                    return 'demo';
  if (text.includes('discovery') || text.includes('intro'))    return 'discovery';
  if (text.includes('negotiat'))                               return 'negotiation';
  if (text.includes('follow up') || text.includes('follow-up')) return 'follow_up';
  if (text.includes('closing') || text.includes('sign'))       return 'closing';
  return 'other';
}

async function findContactByEmail(client, orgId, email) {
  if (!email) return null;

  const result = await client.query(
    `SELECT id, account_id
     FROM contacts
     WHERE org_id = $1
       AND LOWER(email) = LOWER($2)
       AND deleted_at IS NULL
     LIMIT 1`,
    [orgId, email],
  );

  return result.rows[0] || null;
}

async function findActiveDeal(client, userId, orgId, accountId) {
  if (!accountId) return null;

  const result = await client.query(
    `SELECT id FROM deals
     WHERE user_id    = $1
       AND org_id     = $2
       AND account_id = $3
       AND stage NOT IN ('closed_won', 'closed_lost')
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, orgId, accountId],
  );

  return result.rows[0]?.id || null;
}

async function storeMeetingToDatabase(client, userId, orgId, meeting) {
  // ── Deduplication ─────────────────────────────────────────────
  const existingCheck = await client.query(
    `SELECT id FROM meetings
     WHERE user_id = $1 AND org_id = $2 AND external_id = $3`,
    [userId, orgId, meeting.external_id],
  );

  if (existingCheck.rows.length > 0) {
    console.log(`⭐️  Skipping duplicate meeting: ${meeting.title}`);
    return { skipped: true, meetingId: existingCheck.rows[0].id };
  }

  // ── Resolve all attendee contacts ──────────────────────────────
  const allEmails   = [...new Set([
    ...(meeting.organizer ? [meeting.organizer] : []),
    ...(meeting.attendees || []),
  ].map(e => e.toLowerCase()))];

  const contactMap = {};
  for (const email of allEmails) {
    const contact = await findContactByEmail(client, orgId, email);
    if (contact) contactMap[email] = contact;
  }

  const matchedContacts = Object.values(contactMap);

  // ── Resolve deal + account ─────────────────────────────────────
  let dealId    = null;
  let accountId = null;

  for (const contact of matchedContacts) {
    if (contact.account_id) {
      accountId = contact.account_id;
      dealId    = await findActiveDeal(client, userId, orgId, contact.account_id);
      if (dealId) break;
    }
  }

  // ── Insert meeting ─────────────────────────────────────────────
  const insertResult = await client.query(
    `INSERT INTO meetings (
       org_id, user_id,
       deal_id, account_id,
       title, description, meeting_type,
       start_time, end_time, location, status,
       external_id, source, external_data,
       created_at
     ) VALUES (
       $1,  $2,
       $3,  $4,
       $5,  $6,  $7,
       $8,  $9,  $10, $11,
       $12, $13, $14,
       NOW()
     )
     RETURNING id`,
    [
      orgId,        userId,
      dealId,       accountId,
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
    ],
  );

  const newMeetingId = insertResult.rows[0].id;
  console.log(`✅  Stored meeting ${newMeetingId}: "${meeting.title}" (${meeting.source})`);

  // ── Populate meeting_attendees (Gap 1) ─────────────────────────
  let attendeesLinked = 0;
  for (const contact of matchedContacts) {
    try {
      await client.query(
        `INSERT INTO meeting_attendees
           (meeting_id, contact_id, org_id, attendance_status, source)
         VALUES ($1, $2, $3, 'invited', 'calendar')
         ON CONFLICT DO NOTHING`,
        [newMeetingId, contact.id, orgId],
      );
      attendeesLinked++;
    } catch (err) {
      console.error(`   ⚠️  Could not link contact ${contact.id} to meeting ${newMeetingId}:`, err.message);
    }
  }

  if (attendeesLinked > 0) {
    console.log(`   👥  Linked ${attendeesLinked} attendee(s) to meeting ${newMeetingId}`);
  }

  return { stored: true, meetingId: newMeetingId, dealId, accountId, attendeesLinked };
}

async function triggerCalendarSync(userId, options = {}) {
  const { orgId }  = options;
  const provider   = options.provider || 'outlook';
  const client     = await pool.connect();

  try {
    const providerLabel = provider === 'google' ? 'Google Calendar' : 'Outlook Calendar';
    console.log(`📅  Triggering ${providerLabel} sync for user ${userId} org ${orgId}`);

    await client.query('BEGIN');

    const syncHistoryResult = await client.query(
      `INSERT INTO calendar_sync_history
         (user_id, org_id, sync_type, status, created_at)
       VALUES ($1, $2, $3, 'in_progress', NOW())
       RETURNING id`,
      [userId, orgId, 'calendar_' + provider],
    );
    const syncHistoryId = syncHistoryResult.rows[0].id;

    const startDate = options.startDate || new Date().toISOString();
    const endDate   = options.endDate   || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    let rawEvents = [];
    let parseFn;

    if (provider === 'google') {
      rawEvents = await fetchGoogleEvents(userId, {
        maxResults: options.top || 100,
        timeMin:    startDate,
        timeMax:    endDate,
      });
      parseFn = parseGoogleEventToMeeting;
    } else {
      const result = await fetchOutlookEvents(userId, {
        top:           options.top || 100,
        startDateTime: startDate,
        endDateTime:   endDate,
      });
      rawEvents = result.events || [];
      parseFn   = parseOutlookEvent;
    }

    console.log(`📅  Found ${rawEvents.length} ${providerLabel} events for user ${userId}`);

    let stored    = 0;
    let skipped   = 0;
    let failed    = 0;
    const meetingIds = [];

    for (const event of rawEvents) {
      try {
        const meeting     = parseFn(event);
        const storeResult = await storeMeetingToDatabase(client, userId, orgId, meeting);

        if (storeResult.skipped)       skipped++;
        else if (storeResult.stored) { stored++; meetingIds.push(storeResult.meetingId); }
      } catch (error) {
        const eventTitle = event.subject || event.title || event.summary || '(unknown)';
        console.error(`❌  Error processing event "${eventTitle}":`, error.message);
        failed++;
      }
    }

    await client.query(
      `UPDATE calendar_sync_history
       SET status          = 'completed',
           items_processed = $2,
           items_failed    = $3,
           last_sync_date  = NOW()
       WHERE id = $1`,
      [syncHistoryId, stored, failed],
    );

    await client.query('COMMIT');

    console.log(`✅  ${providerLabel} sync done — ${stored} stored, ${skipped} skipped, ${failed} failed`);

    return { success: true, provider, eventsFound: rawEvents.length, stored, skipped, failed, meetingIds };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌  Calendar sync failed for user ${userId} (${provider}):`, error);

    try {
      await pool.query(
        `UPDATE calendar_sync_history
         SET status        = 'failed',
             error_message = $2
         WHERE id = (
           SELECT id FROM calendar_sync_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1
         )`,
        [userId, error.message],
      );
    } catch (updateError) {
      console.error('Failed to update sync history:', updateError);
    }

    throw error;
  } finally {
    client.release();
  }
}

async function getCalendarSyncStatus(userId, orgId) {
  const result = await pool.query(
    `SELECT * FROM calendar_sync_history
     WHERE user_id = $1 AND org_id = $2
     ORDER BY created_at DESC
     LIMIT 10`,
    [userId, orgId],
  );

  return result.rows;
}

module.exports = { triggerCalendarSync, getCalendarSyncStatus };
