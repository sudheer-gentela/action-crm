// services/LinkedInFollowupActionService.js
//
// P5b — generates (and auto-resolves) the two Work-queue actions the message
// ledger makes possible:
//
//   1. reply_needs_response  — the prospect's latest counted inbound LinkedIn
//      message is newer than the rep's latest qualifying outbound and older
//      than REPLY_SLA_HOURS. "They replied; you haven't."
//   2. accepted_no_followup  — the connection was accepted (post-acceptance,
//      attributed) at least FOLLOWUP_SLA_DAYS ago and NO qualifying outbound
//      exists. "They said yes; you went quiet."
//
// "Qualifying outbound" is the F18 definition — an outbound message that is
// NOT the connection-request note:
//     occurred_at > GREATEST(request_sent_at + INVITE_NOTE_EXCLUSION,
//                            connected_at   - ACCEPT_TOLERANCE)
// Invite notes fire at request time by definition, so the request-time clause
// excludes exactly them without weakening the F11 coarse-timestamp tolerance.
//
// Idempotent both directions: an open action is never duplicated (source +
// prospect keyed), and when the condition clears (rep followed up / replied)
// the open action is auto-completed with an outcome, so the queue reflects
// reality without human garbage collection.
//
// Wiring: call runForOrg() from the existing nightly sweep, and/or expose the
// manual trigger route (see linkedin-connections.routes.js
// POST /generate-followup-actions). Pull-model caveat applies: these actions
// are only as fresh as the last message sync (design doc §11).

const REPLY_SLA_HOURS        = 24;   // "responded and you haven't in ~a day"
const FOLLOWUP_SLA_DAYS      = 1;    // "accepted and you haven't messaged in ~a day"
const INVITE_NOTE_EXCLUSION  = '2 hours';   // F18
const ACCEPT_TOLERANCE       = '48 hours';  // F11

// F18 qualifying-outbound EXISTS clause, parameterized on the prospect alias.
const QUALIFYING_OUTBOUND = (p) => `
  EXISTS (
    SELECT 1 FROM linkedin_message_events q
     WHERE q.org_id = ${p}.org_id AND q.prospect_id = ${p}.id
       AND q.direction = 'outbound'
       AND q.occurred_at > GREATEST(
             (${p}.channel_data->'linkedin'->>'request_sent_at')::timestamptz + interval '${INVITE_NOTE_EXCLUSION}',
             (${p}.channel_data->'linkedin'->>'connected_at')::timestamptz   - interval '${ACCEPT_TOLERANCE}')
  )`;

async function runForOrg(db, orgId) {
  const out = { org_id: orgId, created: {}, completed: {} };

  // ── 1a. reply_needs_response: CREATE ─────────────────────────────────────
  const replyCreate = await db.query(
    `WITH latest AS (
       SELECT p.id AS prospect_id, p.org_id, p.owner_id,
              trim(p.first_name || ' ' || p.last_name) AS name,
              max(i.occurred_at) FILTER (WHERE i.direction = 'inbound'  AND i.counted) AS last_inbound,
              max(i.occurred_at) FILTER (WHERE i.direction = 'outbound' AND i.counted) AS last_outbound,
              (SELECT lme.thread_urn FROM linkedin_message_events lme
                WHERE lme.org_id = p.org_id AND lme.prospect_id = p.id AND lme.thread_urn IS NOT NULL
                ORDER BY lme.occurred_at DESC LIMIT 1) AS thread_urn
         FROM prospects p
         JOIN linkedin_message_events i ON i.org_id = p.org_id AND i.prospect_id = p.id
        WHERE p.org_id = $1 AND p.deleted_at IS NULL
        GROUP BY p.id
     )
     INSERT INTO prospecting_actions
                 (org_id, user_id, prospect_id, title, description,
                  action_type, channel, status, priority, due_date, source, metadata)
     SELECT l.org_id, l.owner_id, l.prospect_id,
            'LinkedIn reply waiting — respond to ' || l.name,
            l.name || ' replied on LinkedIn ' ||
              round(EXTRACT(epoch FROM now() - l.last_inbound) / 3600) || 'h ago and has not been answered.',
            'outreach', 'linkedin', 'pending', 'high', now(),
            'linkedin_reply_needs_response',
            jsonb_build_object('lastInboundAt', l.last_inbound, 'threadUrn', l.thread_urn)
       FROM latest l
      WHERE l.last_inbound IS NOT NULL
        AND l.last_inbound < now() - ($2 || ' hours')::interval
        AND (l.last_outbound IS NULL OR l.last_outbound < l.last_inbound)
        AND NOT EXISTS (
              SELECT 1 FROM prospecting_actions pa
               WHERE pa.org_id = l.org_id AND pa.prospect_id = l.prospect_id
                 AND pa.source = 'linkedin_reply_needs_response'
                 AND pa.status NOT IN ('completed', 'dismissed'))
     RETURNING id`,
    [orgId, String(REPLY_SLA_HOURS)]
  );
  out.created.reply_needs_response = replyCreate.rowCount;

  // ── 1b. reply_needs_response: AUTO-COMPLETE when answered ────────────────
  const replyComplete = await db.query(
    `UPDATE prospecting_actions pa
        SET status = 'completed', completed_at = now(),
            outcome = 'auto: outbound sent after reply', updated_at = now()
      WHERE pa.org_id = $1
        AND pa.source = 'linkedin_reply_needs_response'
        AND pa.status NOT IN ('completed', 'dismissed')
        AND EXISTS (
              SELECT 1 FROM linkedin_message_events o
               WHERE o.org_id = pa.org_id AND o.prospect_id = pa.prospect_id
                 AND o.direction = 'outbound'
                 AND o.occurred_at > (pa.metadata->>'lastInboundAt')::timestamptz)
      RETURNING id`,
    [orgId]
  );
  out.completed.reply_needs_response = replyComplete.rowCount;

  // ── 2a. accepted_no_followup: CREATE ─────────────────────────────────────
  const acceptCreate = await db.query(
    `INSERT INTO prospecting_actions
                 (org_id, user_id, prospect_id, title, description,
                  action_type, channel, status, priority, due_date, source, metadata)
     SELECT p.org_id, p.owner_id, p.id,
            'Accepted, no follow-up — message ' || trim(p.first_name || ' ' || p.last_name),
            trim(p.first_name || ' ' || p.last_name) || ' accepted your connection request ' ||
              GREATEST(1, round(EXTRACT(epoch FROM now() - (p.channel_data->'linkedin'->>'connected_at')::timestamptz) / 86400)) ||
              ' day(s) ago and has not received a message.',
            'outreach', 'linkedin', 'pending', 'high', now(),
            'linkedin_accepted_no_followup',
            jsonb_build_object('connectedAt', p.channel_data->'linkedin'->>'connected_at')
       FROM prospects p
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
        AND p.channel_data->'linkedin'->>'request_sent_at' IS NOT NULL
        AND p.channel_data->'linkedin'->>'connected_at'    IS NOT NULL
        AND (p.channel_data->'linkedin'->>'connected_at')::timestamptz < now() - ($2 || ' days')::interval
        AND NOT ${QUALIFYING_OUTBOUND('p')}
        AND NOT EXISTS (
              SELECT 1 FROM prospecting_actions pa
               WHERE pa.org_id = p.org_id AND pa.prospect_id = p.id
                 AND pa.source = 'linkedin_accepted_no_followup'
                 AND pa.status NOT IN ('completed', 'dismissed'))
     RETURNING id`,
    [orgId, String(FOLLOWUP_SLA_DAYS)]
  );
  out.created.accepted_no_followup = acceptCreate.rowCount;

  // ── 2b. accepted_no_followup: AUTO-COMPLETE when followed up ─────────────
  const acceptComplete = await db.query(
    `UPDATE prospecting_actions pa
        SET status = 'completed', completed_at = now(),
            outcome = 'auto: follow-up message sent', updated_at = now()
       FROM prospects p
      WHERE p.id = pa.prospect_id AND p.org_id = pa.org_id
        AND pa.org_id = $1
        AND pa.source = 'linkedin_accepted_no_followup'
        AND pa.status NOT IN ('completed', 'dismissed')
        AND ${QUALIFYING_OUTBOUND('p')}
      RETURNING pa.id`,
    [orgId]
  );
  out.completed.accepted_no_followup = acceptComplete.rowCount;

  return out;
}

module.exports = {
  runForOrg,
  REPLY_SLA_HOURS,
  FOLLOWUP_SLA_DAYS,
};
