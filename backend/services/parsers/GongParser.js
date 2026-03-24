/**
 * GongParser.js
 * backend/services/parsers/GongParser.js
 *
 * Parses Gong webhook payloads (event: call.completed).
 * Gong sends enriched payloads with speaker turns, per-sentence sentiment,
 * topics, and trackers — no secondary API fetch required.
 *
 * SETUP INSTRUCTIONS — Gong Webhook:
 *   Org plan (all reps):
 *     1. Gong admin → Company Settings → Webhooks → Add endpoint
 *     2. Add webhook URL:
 *          https://your-railway-domain.railway.app/webhooks/transcript/gong/org/:orgId
 *     3. Select event: call.completed
 *     4. Copy the signing key shown → OrgAdmin Meeting Settings in ActionCRM
 *     5. Store as GONG_WEBHOOK_SECRET in org_integrations.credentials->>'webhook_secret'
 *
 *   Note: Gong webhooks require ISV/partner registration for production access.
 *   Docs: https://developers.gong.io/docs/webhooks
 *
 * Gong call.completed payload shape:
 *   {
 *     eventType: "call.completed",
 *     payload: {
 *       call: {
 *         id,
 *         title,
 *         scheduled,          // ISO start time
 *         duration,           // seconds
 *         parties: [
 *           { speakerId, name, emailAddress, affiliation }
 *         ],
 *         transcript: [
 *           {
 *             speakerId,
 *             topic,
 *             sentences: [
 *               { start, end, text, sentiment }   // start/end in seconds
 *             ]
 *           }
 *         ],
 *         topics: [...],
 *         trackers: [...]
 *       }
 *     }
 *   }
 */

/**
 * Parse a Gong call.completed webhook payload.
 *
 * @param {object} body — raw webhook request body (with _sourceProvider injected by route)
 * @returns {NormalizedTranscript}
 */
function parse(body) {
  // Gong wraps everything under payload.call
  const call = body?.payload?.call || body?.call || {};

  if (!call.id) {
    throw new Error('Gong payload: missing call.id — is this a call.completed event?');
  }

  const parties    = call.parties    || [];
  const transcript = call.transcript || [];

  // ── Build email lookup by speakerId ────────────────────────────
  // parties[].speakerId links to transcript[].speakerId
  const partyMap = {};   // speakerId → { name, email }
  parties.forEach(p => {
    partyMap[p.speakerId] = {
      name:  p.name         || 'Unknown',
      email: p.emailAddress || null,
    };
  });

  // ── Build speaker segments ──────────────────────────────────────
  // Gong groups sentences by speakerId + topic block; flatten into per-speaker segments
  const speakersMap = {};   // name → { name, email, segments[] }

  transcript.forEach(block => {
    const party = partyMap[block.speakerId] || { name: 'Unknown', email: null };
    const name  = party.name;

    if (!speakersMap[name]) {
      speakersMap[name] = {
        name,
        email:    party.email,
        segments: [],
      };
    }

    (block.sentences || []).forEach(sentence => {
      speakersMap[name].segments.push({
        start: sentence.start ?? null,
        end:   sentence.end   ?? null,
        text:  sentence.text  || '',
      });
    });
  });

  const speakers      = Object.values(speakersMap);
  const speakerEmails = speakers.map(s => s.email).filter(Boolean);

  // ── Build flat transcript text ──────────────────────────────────
  // Walk transcript blocks in order; within each block walk sentences
  const lines = [];
  transcript.forEach(block => {
    const name = (partyMap[block.speakerId] || {}).name || 'Unknown';
    (block.sentences || []).forEach(sentence => {
      const text = (sentence.text || '').trim();
      if (text) lines.push(`${name}: ${text}`);
    });
  });

  const transcriptText = lines.join('\n');

  if (!transcriptText) {
    throw new Error('Gong payload: transcript is empty');
  }

  // ── Meeting metadata ────────────────────────────────────────────
  let meetingStartTime = null;
  if (call.scheduled) {
    try {
      meetingStartTime = new Date(call.scheduled).toISOString();
    } catch (_) {}
  }

  const durationMinutes = call.duration
    ? Math.round(call.duration / 60)
    : null;

  return {
    transcriptText,
    speakers,
    speakerEmails,
    durationMinutes,
    meetingStartTime,
    meetingTitle:      call.title || null,
    externalMeetingId: call.id    || null,
    sourceProvider:    body._sourceProvider || 'gong',
    rawPayload:        body,
  };
}

module.exports = { parse };
