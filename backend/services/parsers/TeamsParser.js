/**
 * TeamsParser.js
 * backend/services/parsers/TeamsParser.js
 *
 * Handles Microsoft Teams transcript delivery via Graph API change notifications.
 *
 * Teams transcript flow (different from Zoom/Fireflies):
 *   1. Your Azure app subscribes to callTranscript change notifications
 *   2. Graph sends a POST to /webhooks/transcript/teams/org/:orgId when a transcript is ready
 *   3. The notification contains a callTranscriptId, NOT the transcript text itself
 *   4. We call Graph API to fetch the actual transcript content
 *   5. Parse and return NormalizedTranscript
 *
 * Required Azure App Registration permissions:
 *   CallRecords.Read.All (application permission, admin consent required)
 *   OnlineMeetingTranscript.Read.All (application permission, admin consent required)
 *
 * Environment variables needed:
 *   MICROSOFT_CLIENT_ID      — Azure app client ID (already set for Outlook)
 *   MICROSOFT_CLIENT_SECRET  — Azure app client secret (already set for Outlook)
 *   MICROSOFT_TENANT_ID      — Azure tenant ID (already set for Outlook)
 *
 * SETUP INSTRUCTIONS — Teams Transcript Webhook Subscription:
 *   1. In Azure portal → App Registrations → your app → API Permissions
 *      Add: CallRecords.Read.All (Application) + OnlineMeetingTranscript.Read.All (Application)
 *      Click "Grant admin consent"
 *
 *   2. Create a change notification subscription (run once, renews every ~60 days):
 *      POST https://graph.microsoft.com/v1.0/subscriptions
 *      {
 *        "changeType": "created",
 *        "notificationUrl": "https://your-railway-domain.railway.app/webhooks/transcript/teams/org/:orgId",
 *        "resource": "/communications/callTranscripts",
 *        "expirationDateTime": "<60 days from now>",
 *        "clientState": "<your webhook secret — same value stored in org_integrations>"
 *      }
 *      Note: Graph validates the notificationUrl before creating the subscription.
 *      The webhook route handles the validation challenge automatically.
 *
 *   3. Store the subscription ID — you will need to renew it before expiry.
 *      A renewal cron job will be added in a later phase.
 *
 *   4. Store the webhook secret (clientState value) in OrgAdmin → Meeting Settings.
 */

// ── Graph API token cache (reuses MICROSOFT_ env vars already set for Outlook) ─
let _graphToken    = null;
let _graphTokenExp = 0;

async function getGraphToken() {
  if (_graphToken && Date.now() < _graphTokenExp - 60_000) {
    return _graphToken;
  }

  const tenantId     = process.env.MICROSOFT_TENANT_ID;
  const clientId     = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Microsoft Graph credentials not configured. ' +
      'MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET must be set.'
    );
  }

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://graph.microsoft.com/.default',
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph token request failed: ${response.status} — ${body}`);
  }

  const data     = await response.json();
  _graphToken    = data.access_token;
  _graphTokenExp = Date.now() + (data.expires_in * 1000);

  return _graphToken;
}

// ── Fetch transcript content from Graph ───────────────────────────────────────
async function fetchTranscriptContent(callId, transcriptId) {
  const token = await getGraphToken();

  // Fetch the transcript metadata
  const metaRes = await fetch(
    `https://graph.microsoft.com/v1.0/communications/callRecords/${callId}/transcripts/${transcriptId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!metaRes.ok) {
    throw new Error(`Graph transcript metadata fetch failed: ${metaRes.status}`);
  }

  const meta = await metaRes.json();

  // Fetch the actual transcript content (VTT format)
  const contentRes = await fetch(
    `https://graph.microsoft.com/v1.0/communications/callRecords/${callId}/transcripts/${transcriptId}/content?$format=text/vtt`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!contentRes.ok) {
    throw new Error(`Graph transcript content fetch failed: ${contentRes.status}`);
  }

  const vttContent = await contentRes.text();
  return { meta, vttContent };
}

// ── Fetch call record metadata (for participant emails) ────────────────────────
async function fetchCallRecord(callId) {
  const token = await getGraphToken();

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/communications/callRecords/${callId}?$expand=sessions($expand=segments)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    // Non-fatal — we can proceed without participant emails
    console.warn(`⚠️  Could not fetch Teams call record ${callId}: ${response.status}`);
    return null;
  }

  return response.json();
}

// ── Parse Teams VTT format ────────────────────────────────────────────────────
//
// Teams VTT format:
//   WEBVTT
//
//   00:00:01.000 --> 00:00:05.000
//   <v John Smith>Hello everyone.</v>
//
//   00:00:06.000 --> 00:00:10.000
//   <v Jane Doe>Thanks for joining.</v>
//
function parseTeamsVtt(vttText) {
  const speakers  = {};
  const allText   = [];
  const lines     = vttText.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const timeParts = line.split('-->').map(t => t.trim());
      const startTime = timeParts[0];
      const endTime   = timeParts[1]?.split(' ')[0];

      i++;
      const cueLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        cueLines.push(lines[i].trim());
        i++;
      }

      const cueText = cueLines.join(' ');

      // Teams uses <v SpeakerName>text</v> format
      const voiceMatch = cueText.match(/<v ([^>]+)>(.+?)<\/v>/);
      if (voiceMatch) {
        const speakerName = voiceMatch[1].trim();
        const text        = voiceMatch[2].trim();

        if (!speakers[speakerName]) {
          speakers[speakerName] = { name: speakerName, email: null, segments: [] };
        }
        speakers[speakerName].segments.push({ start: startTime, end: endTime, text });
        allText.push(`${speakerName}: ${text}`);
      } else if (cueText && !cueText.startsWith('<')) {
        // Plain text without speaker tag
        allText.push(cueText);
      }
    }

    i++;
  }

  return {
    speakers:      Object.values(speakers),
    transcriptText: allText.join('\n'),
  };
}

// ── Extract participant emails from call record ────────────────────────────────
function extractParticipantEmails(callRecord) {
  if (!callRecord?.sessions) return {};

  const emailMap = {};
  callRecord.sessions.forEach(session => {
    (session.segments || []).forEach(segment => {
      const caller   = segment.caller;
      const callee   = segment.callee;
      if (caller?.displayName && caller?.identity?.user?.id) {
        emailMap[caller.displayName] = caller?.identity?.user?.userPrincipalName || null;
      }
      if (callee?.displayName && callee?.identity?.user?.id) {
        emailMap[callee.displayName] = callee?.identity?.user?.userPrincipalName || null;
      }
    });
  });

  return emailMap;
}

// ── Main parse function ───────────────────────────────────────────────────────
/**
 * Parse a Teams Graph API change notification.
 *
 * @param {object} body — raw webhook request body
 * @returns {Promise<NormalizedTranscript>}
 */
async function parse(body) {
  // Graph sends an array of change notifications
  const notifications = body.value;

  if (!Array.isArray(notifications) || notifications.length === 0) {
    throw new Error('Teams webhook: no notifications in payload');
  }

  // Process the first notification (we respond 202 quickly, process async)
  const notification = notifications[0];

  // Graph validates the notificationUrl with a validationToken query param —
  // this is handled in webhooks.routes.js before parse() is called
  if (notification.validationToken) {
    throw new Error('VALIDATION_CHALLENGE');
  }

  // Extract IDs from the resource URL
  // Format: communications/callRecords/{callId}/transcripts/{transcriptId}
  const resourceUrl = notification.resource || '';
  const resourceMatch = resourceUrl.match(
    /callRecords\/([^/]+)\/transcripts\/([^/]+)/
  );

  if (!resourceMatch) {
    throw new Error(`Cannot parse Teams resource URL: ${resourceUrl}`);
  }

  const callId       = resourceMatch[1];
  const transcriptId = resourceMatch[2];

  // Fetch transcript content and call record in parallel
  const [{ meta, vttContent }, callRecord] = await Promise.all([
    fetchTranscriptContent(callId, transcriptId),
    fetchCallRecord(callId).catch(() => null),  // non-fatal
  ]);

  const { speakers, transcriptText } = parseTeamsVtt(vttContent);

  // Enrich speaker emails from call record
  const emailMap = extractParticipantEmails(callRecord);
  speakers.forEach(speaker => {
    speaker.email = emailMap[speaker.name] || null;
  });

  const speakerEmails = speakers.map(s => s.email).filter(Boolean);

  // Extract meeting start time from notification or call record
  let meetingStartTime = null;
  if (callRecord?.startDateTime) {
    try { meetingStartTime = new Date(callRecord.startDateTime).toISOString(); } catch (_) {}
  } else if (notification.subscriptionExpirationDateTime) {
    // fallback — not accurate but better than nothing
  }

  // Duration from call record
  let durationMinutes = null;
  if (callRecord?.startDateTime && callRecord?.endDateTime) {
    try {
      const start = new Date(callRecord.startDateTime);
      const end   = new Date(callRecord.endDateTime);
      durationMinutes = Math.round((end - start) / 60000);
    } catch (_) {}
  }

  return {
    transcriptText,
    speakers,
    speakerEmails,
    durationMinutes,
    meetingStartTime,
    meetingTitle:      callRecord?.joinWebUrl || null,
    externalMeetingId: callId,
    sourceProvider:    'teams',
    rawPayload:        body,
  };
}

module.exports = { parse };
