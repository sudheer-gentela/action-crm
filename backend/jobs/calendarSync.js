/**
 * Calendar Sync Scheduler
 * backend/jobs/calendarSync.js
 *
 * Prospect support added:
 *   - findPersonByEmail() searches contacts first, then prospects
 *   - storeMeetingToDatabase sets prospect_id on the meeting when matched
 *   - meeting_attendees rows now carry either contact_id or prospect_id
 */

const { pool } = require('../config/database');
const {
  fetchCalendarEvents: fetchOutlookEvents,
  parseEventToMeeting: parseOutlookEvent,
} = require('../services/calendarService');
const { fetchCalendarEvents: fetchGoogleEvents } = require('../services/googleService');

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

// ── Unified person lookup — contacts first, then prospects ────────────────────
async function findPersonByEmail(client, orgId, email) {
  if (!email) return null;

  // 1. Check contacts
  const contactResult = await client.query(
    `SELECT id, account_id FROM contacts
     WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL
     LIMIT 1`,
    [orgId, email],
  );
  if (contactResult.rows.length > 0) {
    const c = contactResult.rows[0];
    return { type: 'contact', id: c.id, contact_id: c.id, prospect_id: null, account_id: c.account_id, deal_id: null };
  }

  // 2. Fall back to prospects
  const prospectResult = await client.query(
    `SELECT id, account_id, deal_id, contact_id FROM prospects
     WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL
     LIMIT 1`,
    [orgId, email],
  );
  if (prospectResult.rows.length > 0) {
    const p = prospectResult.rows[0];
    // If converted, use the linked contact
    if (p.contact_id) {
      return { type: 'contact', id: p.contact_id, contact_id: p.contact_id, prospect_id: null, account_id: p.account_id, deal_id: p.deal_id };
    }
    return { type: 'prospect', id: p.id, contact_id: null, prospect_id: p.id, account_id: p.account_id, deal_id: p.deal_id };
  }

  return null;
}

async function findActiveDeal(client, userId, orgId, accountId) {
  if (!accountId) return null;
  const result = await client.query(
    `SELECT id FROM deals
     WHERE user_id = $1 AND org_id = $2 AND account_id = $3
       AND stage NOT IN ('closed_won', 'closed_lost') AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId, orgId, accountId],
  );
  return result.rows[0]?.id || null;
}

async function storeMeetingToDatabase(client, userId, orgId, meeting) {
  const existingCheck = await client.query(
    `SELECT id FROM meetings WHERE user_id = $1 AND org_id = $2 AND external_id = $3`,
    [userId, orgId, meeting.external_id],
  );
  if (existingCheck.rows.length > 0) {
    console.log(`⭐️  Skipping duplicate meeting: ${meeting.title}`);
    return { skipped: true, meetingId: existingCheck.rows[0].id };
  }

  const allEmails = [...new Set([
    ...(meeting.organizer ? [meeting.organizer] : []),
    ...(meeting.attendees || []),
  ].map(e => e.toLowerCase()))];

  const personMap = {};
  for (const email of allEmails) {
    const person = await findPersonByEmail(client, orgId, email);
    if (person) personMap[email] = person;
  }
  const matchedPersons = Object.values(personMap);

  let dealId = null, accountId = null, prospectId = null;

  for (const person of matchedPersons) {
    if (!accountId && person.account_id) accountId = person.account_id;
    if (!dealId && person.deal_id)       dealId    = person.deal_id;
    if (!dealId && person.account_id)    dealId    = await findActiveDeal(client, userId, orgId, person.account_id);
    if (!prospectId && person.type === 'prospect') prospectId = person.prospect_id;
    if (dealId && accountId) break;
  }

  const insertResult = await client.query(
    `INSERT INTO meetings (
       org_id, user_id, deal_id, account_id, prospect_id,
       title, description, meeting_type,
       start_time, end_time, location, status,
       external_id, source, external_data, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
     RETURNING id`,
    [
      orgId, userId, dealId, accountId, prospectId,
      meeting.title, meeting.description, meeting.meeting_type,
      meeting.start_time, meeting.end_time, meeting.location, meeting.status,
      meeting.external_id, meeting.source, JSON.stringify(meeting.external_data),
    ],
  );

  const newMeetingId = insertResult.rows[0].id;
  console.log(`✅  Stored meeting ${newMeetingId}: "${meeting.title}" (${meeting.source})`);

  let attendeesLinked = 0;
  for (const person of matchedPersons) {
    try {
      if (person.type === 'contact') {
        await client.query(
          `INSERT INTO meeting_attendees (meeting_id, contact_id, org_id, attendance_status, source)
           VALUES ($1,$2,$3,'invited','calendar') ON CONFLICT DO NOTHING`,
          [newMeetingId, person.contact_id, orgId],
        );
      } else {
        await client.query(
          `INSERT INTO meeting_attendees (meeting_id, prospect_id, org_id, attendance_status, source)
           VALUES ($1,$2,$3,'invited','calendar') ON CONFLICT DO NOTHING`,
          [newMeetingId, person.prospect_id, orgId],
        );
      }
      attendeesLinked++;
    } catch (err) {
      console.error(`   ⚠️  Could not link ${person.type} ${person.id} to meeting ${newMeetingId}:`, err.message);
    }
  }
  if (attendeesLinked > 0) console.log(`   👥  Linked ${attendeesLinked} attendee(s) to meeting ${newMeetingId}`);

  return { stored: true, meetingId: newMeetingId, dealId, accountId, attendeesLinked };
}

async function triggerCalendarSync(userId, options = {}) {
  const { orgId } = options;
  const provider  = options.provider || 'outlook';
  const client    = await pool.connect();

  try {
    const providerLabel = provider === 'google' ? 'Google Calendar' : 'Outlook Calendar';
    console.log(`📅  Triggering ${providerLabel} sync for user ${userId} org ${orgId}`);
    await client.query('BEGIN');

    const syncHistoryResult = await client.query(
      `INSERT INTO calendar_sync_history (user_id, org_id, sync_type, status, created_at)
       VALUES ($1,$2,$3,'in_progress',NOW()) RETURNING id`,
      [userId, orgId, 'calendar_' + provider],
    );
    const syncHistoryId = syncHistoryResult.rows[0].id;

    const startDate = options.startDate || new Date().toISOString();
    const endDate   = options.endDate   || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    let rawEvents = [], parseFn;
    if (provider === 'google') {
      rawEvents = await fetchGoogleEvents(userId, { maxResults: options.top || 100, timeMin: startDate, timeMax: endDate });
      parseFn = parseGoogleEventToMeeting;
    } else {
      const result = await fetchOutlookEvents(userId, { top: options.top || 100, startDateTime: startDate, endDateTime: endDate });
      rawEvents = result.events || [];
      parseFn   = parseOutlookEvent;
    }

    console.log(`📅  Found ${rawEvents.length} ${providerLabel} events for user ${userId}`);

    let stored = 0, skipped = 0, failed = 0;
    const meetingIds = [];

    for (const event of rawEvents) {
      try {
        const meeting     = parseFn(event);
        const storeResult = await storeMeetingToDatabase(client, userId, orgId, meeting);
        if (storeResult.skipped)       skipped++;
        else if (storeResult.stored) { stored++; meetingIds.push(storeResult.meetingId); }
      } catch (error) {
        console.error(`❌  Error processing event "${event.subject || event.title || '(unknown)'}":`, error.message);
        failed++;
      }
    }

    await client.query(
      `UPDATE calendar_sync_history SET status='completed', items_processed=$2, items_failed=$3, last_sync_date=NOW() WHERE id=$1`,
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
        `UPDATE calendar_sync_history SET status='failed', error_message=$2
         WHERE id=(SELECT id FROM calendar_sync_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)`,
        [userId, error.message],
      );
    } catch (e) { console.error('Failed to update sync history:', e); }
    throw error;
  } finally {
    client.release();
  }
}

async function getCalendarSyncStatus(userId, orgId) {
  const result = await pool.query(
    `SELECT * FROM calendar_sync_history WHERE user_id=$1 AND org_id=$2 ORDER BY created_at DESC LIMIT 10`,
    [userId, orgId],
  );
  return result.rows;
}

module.exports = { triggerCalendarSync, getCalendarSyncStatus };
