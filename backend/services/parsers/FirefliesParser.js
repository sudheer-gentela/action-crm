/**
 * FirefliesParser.js
 * backend/services/parsers/FirefliesParser.js
 *
 * Parses Fireflies.ai webhook payloads.
 * Fireflies sends a POST when a transcript is ready — the payload contains
 * the full structured transcript, no secondary fetch required.
 *
 * SETUP INSTRUCTIONS — Fireflies Webhook:
 *   Org plan (all reps):
 *     1. Fireflies dashboard → Settings → Integrations → Webhooks
 *     2. Add webhook URL: https://your-railway-domain.railway.app/webhooks/transcript/fireflies_org/org/:orgId
 *     3. Copy the webhook token shown → OrgAdmin Meeting Settings in ActionCRM
 *
 *   Personal (individual rep):
 *     1. Rep goes to their Fireflies Settings → Integrations → Webhooks
 *     2. Add webhook URL: https://your-railway-domain.railway.app/webhooks/transcript/fireflies/user/:userId
 *     3. Rep pastes their webhook token into SettingsView → Transcript Tools → Fireflies
 *
 * Fireflies webhook payload shape:
 *   {
 *     meetingInfo: {
 *       title, date, duration (seconds), meeting_link,
 *       attendees: [{ displayName, email }]
 *     },
 *     sentences: [
 *       { index, speaker_id, speaker_name, text, start_time, end_time }
 *     ],
 *     summary: { overview, action_items, outline }
 *   }
 */

/**
 * Parse a Fireflies webhook payload.
 *
 * @param {object} body — raw webhook request body
 * @returns {NormalizedTranscript}
 */
function parse(body) {
  const meetingInfo = body.meetingInfo || body.meeting_info || {};
  const sentences   = body.sentences   || [];

  if (!sentences.length && !body.transcript) {
    throw new Error('Fireflies payload: no sentences or transcript found');
  }

  // ── Build speaker map ──────────────────────────────────────────
  // Fireflies identifies speakers by speaker_id within sentences.
  // Attendees list maps speaker names to emails.
  const attendeeEmailMap = {};
  (meetingInfo.attendees || []).forEach(a => {
    if (a.displayName && a.email) {
      attendeeEmailMap[a.displayName] = a.email;
    }
  });

  const speakersMap = {};  // speaker_name → { name, email, segments[] }

  sentences.forEach(sentence => {
    const name = sentence.speaker_name || sentence.speakerName || 'Unknown';
    const text = sentence.text || sentence.raw_text || '';

    if (!speakersMap[name]) {
      speakersMap[name] = {
        name,
        email:    attendeeEmailMap[name] || null,
        segments: [],
      };
    }

    speakersMap[name].segments.push({
      start: sentence.start_time ?? sentence.startTime ?? null,
      end:   sentence.end_time   ?? sentence.endTime   ?? null,
      text,
    });
  });

  const speakers      = Object.values(speakersMap);
  const speakerEmails = speakers.map(s => s.email).filter(Boolean);

  // ── Build plain text transcript ────────────────────────────────
  // If no sentences (older Fireflies payloads), fall back to body.transcript
  let transcriptText;
  if (sentences.length > 0) {
    transcriptText = sentences
      .map(s => {
        const name = s.speaker_name || s.speakerName || '';
        const text = s.text || s.raw_text || '';
        return name ? `${name}: ${text}` : text;
      })
      .join('\n');
  } else {
    transcriptText = body.transcript || '';
  }

  // ── Meeting metadata ───────────────────────────────────────────
  let meetingStartTime = null;
  if (meetingInfo.date) {
    try {
      // Fireflies sends date as Unix timestamp (seconds) or ISO string
      const raw = meetingInfo.date;
      meetingStartTime = typeof raw === 'number'
        ? new Date(raw * 1000).toISOString()
        : new Date(raw).toISOString();
    } catch (_) {}
  }

  const durationMinutes = meetingInfo.duration
    ? Math.round(meetingInfo.duration / 60)
    : null;

  return {
    transcriptText,
    speakers,
    speakerEmails,
    durationMinutes,
    meetingStartTime,
    meetingTitle:      meetingInfo.title || null,
    externalMeetingId: meetingInfo.meeting_link || null,
    sourceProvider:    body._sourceProvider || 'fireflies_org',  // set by webhook route
    rawPayload:        body,
  };
}

module.exports = { parse };
