/**
 * FathomParser.js
 * backend/services/parsers/FathomParser.js
 *
 * Parses Fathom webhook payloads delivered when a call ends.
 * Fathom is a personal notetaker — configured per-rep via
 * SettingsView → Connections → Transcript Tools → Fathom.
 *
 * SETUP INSTRUCTIONS — Fathom Webhook:
 *   1. Rep logs into their Fathom account at fathom.video
 *   2. Settings → Integrations → Webhooks → Add endpoint
 *   3. Webhook URL: https://<railway-domain>/webhooks/transcript/fathom/user/:userId
 *      (the rep copies this URL from SettingsView → Transcript Tools → Fathom)
 *   4. Fathom shows a signing secret → rep pastes into SettingsView → Fathom → Connect
 *
 * Fathom webhook payload shape (as of 2025):
 *   {
 *     event: "call.completed",
 *     call: {
 *       id, title, started_at, ended_at, duration (seconds),
 *       recording_url, share_url,
 *       attendees: [{ name, email }],
 *     },
 *     transcript: {
 *       segments: [
 *         { speaker, text, start_time, end_time }
 *       ]
 *     },
 *     summary: {
 *       overview, action_items: [{ text, assignee, due_date }], topics: []
 *     }
 *   }
 *
 * Note: Fathom's payload shape evolves — the parser handles both
 * current and legacy field names defensively.
 */

/**
 * Parse a Fathom webhook payload.
 *
 * @param {object} body — raw webhook request body
 * @returns {NormalizedTranscript}
 */
function parse(body) {
  // Fathom wraps everything under body.call and body.transcript
  const call       = body.call       || body.meeting  || {};
  const transcript = body.transcript || {};
  const segments   = transcript.segments || body.segments || [];

  if (!segments.length && !body.transcript_text) {
    throw new Error('Fathom payload: no transcript segments found');
  }

  // ── Attendee email map ─────────────────────────────────────────
  const attendeeEmailMap = {};
  (call.attendees || body.attendees || []).forEach(a => {
    if (a.name && a.email) {
      attendeeEmailMap[a.name] = a.email;
    }
  });

  // ── Build speaker turns ────────────────────────────────────────
  const speakersMap = {};

  segments.forEach(segment => {
    const name = segment.speaker || 'Unknown';
    const text = segment.text    || '';

    if (!speakersMap[name]) {
      speakersMap[name] = {
        name,
        email:    attendeeEmailMap[name] || null,
        segments: [],
      };
    }

    speakersMap[name].segments.push({
      start: segment.start_time ?? segment.startTime ?? null,
      end:   segment.end_time   ?? segment.endTime   ?? null,
      text,
    });
  });

  const speakers      = Object.values(speakersMap);
  const speakerEmails = speakers.map(s => s.email).filter(Boolean);

  // ── Plain text transcript ──────────────────────────────────────
  let transcriptText;
  if (segments.length > 0) {
    transcriptText = segments
      .map(s => s.speaker ? `${s.speaker}: ${s.text}` : s.text)
      .join('\n');
  } else {
    transcriptText = body.transcript_text || '';
  }

  // ── Meeting metadata ───────────────────────────────────────────
  let meetingStartTime = null;
  const startedAt = call.started_at || call.start_time || body.started_at;
  if (startedAt) {
    try { meetingStartTime = new Date(startedAt).toISOString(); } catch (_) {}
  }

  let durationMinutes = null;
  if (call.duration) {
    durationMinutes = Math.round(call.duration / 60);
  } else if (call.started_at && call.ended_at) {
    try {
      const diff = new Date(call.ended_at) - new Date(call.started_at);
      durationMinutes = Math.round(diff / 60000);
    } catch (_) {}
  }

  return {
    transcriptText,
    speakers,
    speakerEmails,
    durationMinutes,
    meetingStartTime,
    meetingTitle:      call.title || body.title || null,
    externalMeetingId: call.id ? String(call.id) : null,
    sourceProvider:    'fathom',
    rawPayload:        body,
  };
}

module.exports = { parse };
