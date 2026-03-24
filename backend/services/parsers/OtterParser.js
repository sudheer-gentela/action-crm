/**
 * OtterParser.js
 * backend/services/parsers/OtterParser.js
 *
 * Parses Otter.ai webhook payloads.
 * Otter sends a POST when a transcript is ready — payload contains
 * the full structured transcript, no secondary fetch required.
 *
 * SETUP INSTRUCTIONS — Otter Webhook:
 *   Org plan (Otter for Business / Teams):
 *     1. otter.ai → Settings → Developer → Webhooks → Add Endpoint
 *     2. Add webhook URL:
 *          https://your-railway-domain.railway.app/webhooks/transcript/otter_org/org/:orgId
 *     3. Copy the webhook secret shown → OrgAdmin Meeting Settings in ActionCRM
 *     4. Store as OTTER_WEBHOOK_SECRET in org_integrations.credentials->>'webhook_secret'
 *
 *   Personal (individual rep):
 *     1. Rep goes to their otter.ai Settings → Developer → Webhooks
 *     2. Add webhook URL:
 *          https://your-railway-domain.railway.app/webhooks/transcript/otter/user/:userId
 *     3. Rep pastes their webhook secret into SettingsView → Transcript Tools → Otter
 *
 *   Signature: x-otter-signature header — HMAC-SHA256 of raw body with webhook secret.
 *   Docs: https://otter.ai/developer
 *
 * Otter webhook payload shape:
 *   {
 *     conversation_id: string,
 *     title:           string,
 *     start_time:      number,   // Unix timestamp (seconds)
 *     end_time:        number,   // Unix timestamp (seconds)
 *     speakers: [
 *       { id: string, name: string }
 *     ],
 *     transcripts: [
 *       {
 *         speaker_id:  string,
 *         start_time:  number,   // seconds from start of call
 *         end_time:    number,
 *         transcript:  string,
 *       }
 *     ]
 *   }
 */

/**
 * Parse an Otter webhook payload.
 *
 * @param {object} body — raw webhook request body (with _sourceProvider injected by route)
 * @returns {NormalizedTranscript}
 */
function parse(body) {
  const speakers    = body.speakers    || [];
  const transcripts = body.transcripts || [];

  if (!body.conversation_id) {
    throw new Error('Otter payload: missing conversation_id');
  }

  if (!transcripts.length) {
    throw new Error('Otter payload: no transcript segments found');
  }

  // ── Build speaker name lookup by id ────────────────────────────
  // Otter uses a numeric/string speaker_id; names are in a separate speakers array
  const speakerNameMap = {};   // id → name
  speakers.forEach(s => {
    speakerNameMap[s.id] = s.name || 'Unknown';
  });

  // ── Build speakers map with segments ───────────────────────────
  // Otter doesn't provide speaker emails — they can only be matched via
  // AttendeeReconciler against calendar attendees by name.
  const speakersMap = {};   // name → { name, email, segments[] }

  transcripts.forEach(seg => {
    const name = speakerNameMap[seg.speaker_id] || 'Unknown';

    if (!speakersMap[name]) {
      speakersMap[name] = {
        name,
        email:    null,   // Otter does not provide emails in webhook payload
        segments: [],
      };
    }

    speakersMap[name].segments.push({
      start: seg.start_time ?? null,
      end:   seg.end_time   ?? null,
      text:  seg.transcript || '',
    });
  });

  const normalizedSpeakers = Object.values(speakersMap);
  const speakerEmails      = [];   // Otter provides no emails; reconciler handles matching

  // ── Build plain text transcript ──────────────────────────────────
  const transcriptText = transcripts
    .map(seg => {
      const name = speakerNameMap[seg.speaker_id] || '';
      const text = (seg.transcript || '').trim();
      return name ? `${name}: ${text}` : text;
    })
    .filter(line => line.trim())
    .join('\n');

  if (!transcriptText) {
    throw new Error('Otter payload: transcript text is empty after parsing');
  }

  // ── Meeting metadata ────────────────────────────────────────────
  let meetingStartTime = null;
  if (body.start_time) {
    try {
      // Otter sends start_time as Unix timestamp in seconds
      meetingStartTime = new Date(body.start_time * 1000).toISOString();
    } catch (_) {}
  }

  let durationMinutes = null;
  if (body.start_time && body.end_time) {
    durationMinutes = Math.round((body.end_time - body.start_time) / 60);
  }

  return {
    transcriptText,
    speakers:          normalizedSpeakers,
    speakerEmails,
    durationMinutes,
    meetingStartTime,
    meetingTitle:      body.title             || null,
    externalMeetingId: body.conversation_id   || null,
    sourceProvider:    body._sourceProvider   || 'otter',
    rawPayload:        body,
  };
}

module.exports = { parse };
