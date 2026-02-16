/**
 * Outlook Calendar Service
 * Fetches calendar events from Microsoft Graph API
 */

const { Client } = require('@microsoft/microsoft-graph-client');
const { getTokenByUserId, refreshUserToken } = require('./tokenService');

/**
 * Get Microsoft Graph client for calendar access
 */
async function getGraphClient(userId) {
  let tokenData = await getTokenByUserId(userId, 'outlook');
  
  // Check if token is expired
  const expiresAt = new Date(tokenData.expires_at);
  const now = new Date();
  
  if (now >= expiresAt) {
    // Refresh token
    tokenData = await refreshUserToken(userId, 'outlook');
  }
  
  return Client.init({
    authProvider: (done) => {
      done(null, tokenData.access_token);
    }
  });
}

/**
 * Fetch calendar events from Outlook
 * @param {number} userId - User ID
 * @param {object} options - Fetch options
 * @returns {Promise<Array>} Calendar events
 */
async function fetchCalendarEvents(userId, options = {}) {
  try {
    const client = await getGraphClient(userId);
    
    const {
      top = 100,
      skip = 0,
      orderBy = 'start/dateTime',
      startDateTime = null,
      endDateTime = null
    } = options;
    
    let query = client
      .api('/me/events')
      .select([
        'id',
        'subject',
        'body',
        'bodyPreview',
        'start',
        'end',
        'location',
        'attendees',
        'organizer',
        'isOnlineMeeting',
        'onlineMeetingUrl',
        'onlineMeetingProvider',
        'isCancelled',
        'responseStatus',
        'showAs',
        'importance',
        'sensitivity',
        'categories',
        'createdDateTime',
        'lastModifiedDateTime'
      ].join(','))
      .top(top)
      .skip(skip)
      .orderby(orderBy);
    
    // Apply date filters
    if (startDateTime && endDateTime) {
      const filter = `start/dateTime ge '${startDateTime}' and start/dateTime le '${endDateTime}'`;
      query = query.filter(filter);
    } else if (startDateTime) {
      query = query.filter(`start/dateTime ge '${startDateTime}'`);
    }
    
    const result = await query.get();
    
    return {
      events: result.value || [],
      hasMore: result['@odata.nextLink'] != null,
      nextLink: result['@odata.nextLink']
    };
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    throw new Error(`Failed to fetch calendar events: ${error.message}`);
  }
}

/**
 * Fetch single calendar event by ID
 */
async function fetchEventById(userId, eventId) {
  try {
    const client = await getGraphClient(userId);
    
    const event = await client
      .api(`/me/events/${eventId}`)
      .select([
        'id',
        'subject',
        'body',
        'start',
        'end',
        'location',
        'attendees',
        'organizer',
        'isOnlineMeeting',
        'onlineMeetingUrl',
        'isCancelled'
      ].join(','))
      .get();
    
    return event;
  } catch (error) {
    console.error('Error fetching event by ID:', error);
    throw new Error(`Failed to fetch event: ${error.message}`);
  }
}

/**
 * Parse Outlook event to meeting format
 */
function parseEventToMeeting(event) {
  return {
    external_id: event.id,
    source: 'outlook',
    title: event.subject || '(No Subject)',
    description: event.bodyPreview || event.body?.content || '',
    start_time: new Date(event.start.dateTime + 'Z'), // Add Z for UTC
    end_time: new Date(event.end.dateTime + 'Z'),
    location: event.location?.displayName || event.onlineMeetingUrl || null,
    meeting_type: event.isOnlineMeeting ? 'virtual' : 'in_person',
    status: event.isCancelled ? 'cancelled' : 
            event.responseStatus?.response === 'accepted' ? 'confirmed' :
            event.responseStatus?.response === 'tentativelyAccepted' ? 'tentative' :
            'scheduled',
    attendees: event.attendees?.map(a => a.emailAddress.address) || [],
    organizer: event.organizer?.emailAddress?.address,
    external_data: {
      onlineMeetingUrl: event.onlineMeetingUrl,
      onlineMeetingProvider: event.onlineMeetingProvider,
      importance: event.importance,
      showAs: event.showAs,
      categories: event.categories,
      lastModified: event.lastModifiedDateTime
    }
  };
}

module.exports = {
  fetchCalendarEvents,
  fetchEventById,
  parseEventToMeeting
};
