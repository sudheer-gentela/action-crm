/**
 * ZoomParser.js
 * backend/services/parsers/ZoomParser.js
 *
 * Parses a Zoom webhook payload for the recording.transcript_files.completed event.
 *
 * Zoom webhook flow:
 *   1. Zoom sends POST to /webhooks/transcript/zoom_org/org/:orgId
 *   2. Payload contains a download_url for the VTT transcript file
 *   3. We fetch that URL using a Zoom download token (JWT or Server-to-Server OAuth)
 *   4. Parse the VTT into plain text + speaker turns
 *   5. Return NormalizedTranscript
 *
 * Zoom OAuth setup (required — see SETUP INSTRUCTIONS below):
 *   Environment variables needed:
 *     ZOOM_ACCOUNT_ID      — from Zoom Server-to-Server OAuth app
 *     ZOOM_CLIENT_ID       — from Zoom Server-to-Server OAuth app
 *     ZOOM_CLIENT_SECRET   — from Zoom Server-to-Server OAuth app
 *
 * SETUP INSTRUCTIONS — Zoom Server-to-Server OAuth App:
 *   1. Go to https://marketplace.zoom.us/ → Develop → Build App
 *   2. Choose "Server-to-Server OAuth"
 *   3. Add scopes: cloud_recording:read:list_user_recordings:admin
 *                  cloud_recording:read:recording_token:admin
 *   4. Copy Account ID, Client ID, Client Secret → Railway env vars
 *   5. Go to your Zoom account → Admin → Webhooks
 *   6. Create webhook endpoint: https://your-railway-domain.railway.app/webhooks/transcript/zoom_org/org/:orgId
 *   7. Subscribe to event: recording.transcript_files.completed
 *   8. Copy the webhook secret token → OrgAdmin Meeting Settings in ActionCRM
 */

const https = require('https');

// ── Zoom OAuth token cache (in-memory, refreshed before expiry) ───────────────
let _zoomToken     = null;
let _zoomTokenExp  = 0;

async function getZoomAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (_zoomToken && Date.now() < _zoomTokenExp - 60_000) {
    return _zoomToken;
  }

  const accountId    = process.env.ZOOM_ACCOUNT_ID;
  const clientId     = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error(
      'Zoom OAuth credentials not configured. ' +
      'Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in Railway env vars.'
    );
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    {
      method:  'POST',
      headers: { Authorization: `Basic ${credentials}` },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoom OAuth token request failed: ${response.status} — ${body}`);
  }

  const data = await response.json();
  _zoomToken    = data.access_token;
  _zoomTokenExp = Date.now() + (data.expires_in * 1000);

  return _zoomToken;
}

// ── Fetch the VTT file content from Zoom ─────────────────────────────────────
async function fetchVttFromZoom(downloadUrl) {
  const token = await getZoomAccessToken();

  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Zoom VTT file: ${response.status}`);
  }

  return response.text();
}

// ── Parse VTT format into speaker turns ──────────────────────────────────────
//
// Zoom VTT format:
//   WEBVTT
//
//   1
//   00:00:01.000 --> 00:00:04.000
//   John Smith: Hello everyone, welcome to the call.
//
//   2
//   00:00:05.000 --> 00:00:09.000
//   Jane Doe: Thanks for joining. Let's get started.
//
function parseVtt(vttText) {
  const speakers    = {};  // name → { name, segments: [] }
  const allText     = [];
  const lines       = vttText.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect timestamp line: "00:00:01.000 --> 00:00:04.000"
    if (line.includes('-->')) {
      const timeParts  = line.split('-->').map(t => t.trim());
      const startTime  = timeParts[0];
      const endTime    = timeParts[1]?.split(' ')[0]; // strip any positioning flags

      // Next line(s) are the cue text until blank line
      i++;
      const cueLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        cueLines.push(lines[i].trim());
        i++;
      }

      const cueText = cueLines.join(' ');

      // Try to extract speaker name — Zoom formats as "Name: text"
      const speakerMatch = cueText.match(/^([^:]{2,40}):\s(.+)/);
      if (speakerMatch) {
        const speakerName = speakerMatch[1].trim();
        const text        = speakerMatch[2].trim();

        if (!speakers[speakerName]) {
          speakers[speakerName] = { name: speakerName, email: null, segments: [] };
        }
        speakers[speakerName].segments.push({ start: startTime, end: endTime, text });
        allText.push(`${speakerName}: ${text}`);
      } else if (cueText) {
        // No speaker prefix — append to Unknown
        if (!speakers['Unknown']) {
          speakers['Unknown'] = { name: 'Unknown', email: null, segments: [] };
        }
        speakers['Unknown'].segments.push({ start: startTime, end: endTime, text: cueText });
        allText.push(cueText);
      }
    }

    i++;
  }

  return {
    speakers:    Object.values(speakers),
    transcriptText: allText.join('\n'),
  };
}

// ── Duration helper ───────────────────────────────────────────────────────────
function durationFromPayload(payload) {
  // payload.object.duration is in minutes for the whole recording
  return payload?.object?.duration || null;
}

// ── Main parse function ───────────────────────────────────────────────────────
/**
 * Parse a Zoom webhook payload.
 *
 * @param {object} body — raw webhook request body
 * @returns {Promise<NormalizedTranscript>}
 */
async function parse(body) {
  // Zoom sends a URL validation challenge on first setup — handle it
  if (body.event === 'endpoint.url_validation') {
    // Caller (webhooks.routes.js) handles the challenge response before calling parse()
    throw new Error('URL_VALIDATION_CHALLENGE');
  }

  if (body.event !== 'recording.transcript_files.completed') {
    throw new Error(`Unexpected Zoom event type: ${body.event}`);
  }

  const recordingObj = body.payload?.object;
  if (!recordingObj) {
    throw new Error('Zoom payload missing payload.object');
  }

  // Find the transcript file in the recording files array
  const transcriptFile = (recordingObj.recording_files || []).find(
    f => f.file_type === 'TRANSCRIPT' || f.file_extension === 'VTT'
  );

  if (!transcriptFile?.download_url) {
    throw new Error('No transcript VTT file found in Zoom payload');
  }

  // Fetch and parse the VTT
  const vttText = await fetchVttFromZoom(transcriptFile.download_url);
  const { speakers, transcriptText } = parseVtt(vttText);

  // Extract speaker emails from Zoom participant list if available
  const participants = recordingObj.participant_audio_files || [];
  const participantMap = {};
  participants.forEach(p => {
    if (p.file_name) participantMap[p.file_name] = p.user_email;
  });

  // Try to match speaker names to emails
  speakers.forEach(speaker => {
    speaker.email = participantMap[speaker.name] || null;
  });

  const speakerEmails = speakers
    .map(s => s.email)
    .filter(Boolean);

  // Parse meeting start time
  let meetingStartTime = null;
  if (recordingObj.start_time) {
    try { meetingStartTime = new Date(recordingObj.start_time).toISOString(); } catch (_) {}
  }

  return {
    transcriptText,
    speakers,
    speakerEmails,
    durationMinutes:   durationFromPayload(body.payload),
    meetingStartTime,
    meetingTitle:      recordingObj.topic || null,
    externalMeetingId: String(recordingObj.id || ''),
    sourceProvider:    'zoom_org',
    rawPayload:        body,
  };
}

module.exports = { parse };
