// services/LinkedInConnectionSyncService.js
//
// Bulk reconciliation of LinkedIn connection activity scraped by the Chrome
// extension ("Check & update sent" / "Check & update accepted" buttons)
// against the org's prospects.
//
// Responsibilities:
//   1. Seat binding   — map the logged-in LinkedIn member (publicIdentifier
//                       from /voyager/api/me) to a GoWarm user. One seat per
//                       org binds to exactly one user; conflicts are rejected
//                       upstream with 409.
//   2. Slug matching  — resolve scraped /in/<slug> values to prospects using
//                       the SAME expression as /api/prospects/by-linkedin-url:
//                       lower(substring(linkedin_url from '/in/([^/?#]+)')).
//   3. Event apply    — write connection_request_sent / connection_accepted
//                       into prospects.channel_data.linkedin with MONOTONIC,
//                       idempotent semantics (re-sync is always a no-op),
//                       mirroring routes/prospects.routes.js POST
//                       /:id/linkedin-event for counters, stage auto-advance
//                       and prospecting_activities rows.
//
// IMPORTANT divergence from the manual /:id/linkedin-event endpoint:
//   manual logging allows re-logging (e.g. a second message_sent). This
//   service is machine-fed, so it NEVER re-applies a CONNECTION event the
//   prospect already has — status only moves forward, connected_at /
//   request_sent_at are never overwritten. That's what makes the popup
//   button safe to mash.
//
// MESSAGE events (message_sent / reply_received, added 2026-07 for the inbox
// harvest) have different idempotency: multiple messages are legitimate, so
// dedup lives in the linkedin_message_events ledger (2026_49), keyed on
// LinkedIn's stable backendUrn. The CALLER must insert the ledger row with
// ON CONFLICT DO NOTHING and invoke applyConnectionEvent EXACTLY ONCE per
// row that (a) actually inserted and (b) passes passesPostAcceptanceGate.
// Rows failing (b) are ledgered but never counted (design doc F14: a
// connection-request note renders as a thread message and must not mark an
// "accepted, never messaged" prospect as messaged).
//
// Every prospecting_activities INSERT includes org_id. Keep it that way.

const STATUS_ORDER = [
  'connection_request_sent',
  'connection_accepted',
  'message_sent',
  'reply_received',
  'meeting_booked',
];

// Stages where sequences/actions are assumed to have already counted outreach
// (mirror of the manual endpoint's dedup guard).
const OUTREACH_STAGES = ['outreach', 'engaged', 'discovery_call', 'qualified_sal', 'converted'];

// Policy switch — see route docs. When true (default), an acceptance for an
// owned, matched prospect is recorded even if GoWarm never logged the
// connection request (rep sent it outside GoWarm / before this feature).
// The activity metadata carries request_not_logged: true so it's auditable.
// Set to false to only record acceptances that follow a logged request.
const RECORD_ACCEPT_WITHOUT_LOGGED_REQUEST = true;

// Post-acceptance time gate (design doc §5.3 / F11 / F14). connected_at is
// timeText-derived and coarse — production shows inversions of days — so a
// strict `occurred_at > connected_at` would wrongly exclude genuine
// post-acceptance replies. 48h tolerance, evidenced by prospects 1237/1287/
// 267/1265. A message can only be COUNTED (bump message_count/reply_count/
// status) when this passes; it is still ledgered when it fails.
const POST_ACCEPTANCE_TOLERANCE_HOURS = 48;

function passesPostAcceptanceGate(li, occurredAtIso) {
  if (!li || !li.request_sent_at || !li.connected_at) return false; // attribution gate (D5)
  const occurred  = Date.parse(occurredAtIso);
  const connected = Date.parse(li.connected_at);
  if (!Number.isFinite(occurred) || !Number.isFinite(connected)) return false;
  return occurred > connected - POST_ACCEPTANCE_TOLERANCE_HOURS * 3600 * 1000;
}

function statusIdx(s) { return STATUS_ORDER.indexOf(s || ''); }

// ── Slug helpers ──────────────────────────────────────────────────────────────

// Same shape as prospects.routes.js / linkedin-profiles.routes.js. A scraped
// person row already carries publicIdentifier, but we defensively re-extract
// from url when it's missing.
function slugFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/in\/([^/?#]+)/);
  return m ? m[1] : null;
}

// Normalize one slug into its match variants. LinkedIn slugs with unicode
// names arrive percent-encoded in hrefs but may be stored decoded in
// prospects.linkedin_url (or vice versa) — match both spellings.
function slugVariants(raw) {
  if (!raw) return [];
  const out = new Set();
  const lowered = String(raw).toLowerCase();
  out.add(lowered);
  let decoded = lowered;
  try {
    decoded = decodeURIComponent(lowered);
    if (decoded) out.add(decoded);
  } catch (_) { /* malformed escape — keep raw only */ }
  // Only add an encoded variant when the input wasn't already encoded,
  // otherwise we'd produce a useless double-encoded string.
  if (decoded === lowered) {
    try {
      const enc = encodeURIComponent(lowered).toLowerCase();
      if (enc !== lowered) out.add(enc);
    } catch (_) {}
  }
  return [...out];
}

// ── Relative-time parsing ─────────────────────────────────────────────────────
//
// The DOM scrape captures card text like "Sent 6 days ago" / "Connected 2
// weeks ago". Parse it into an approximate occurred_at so velocity metrics
// aren't stamped with sync-click time. Coarse on purpose (months ≈ 30d).
// Returns { iso, source } — source is 'linkedin_relative' when parsed,
// 'auto' when we fell back to now.
function occurredAtFromTimeText(timeText, nowMs = Date.now()) {
  const auto = { iso: new Date(nowMs).toISOString(), source: 'auto' };
  if (!timeText) return auto;

  const m = String(timeText).match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) {
    if (/yesterday/i.test(timeText)) {
      return { iso: new Date(nowMs - 24 * 3600 * 1000).toISOString(), source: 'linkedin_relative' };
    }
    return auto;
  }
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return auto;
  const UNIT_MS = {
    minute: 60 * 1000,
    hour:   3600 * 1000,
    day:    24 * 3600 * 1000,
    week:   7 * 24 * 3600 * 1000,
    month:  30 * 24 * 3600 * 1000,
    year:   365 * 24 * 3600 * 1000,
  };
  const ms = n * UNIT_MS[m[2].toLowerCase()];
  // Clamp: never in the future, never absurdly old (10y).
  const t = Math.min(nowMs, Math.max(nowMs - ms, nowMs - 10 * UNIT_MS.year));
  return { iso: new Date(t).toISOString(), source: 'linkedin_relative' };
}

// ── Seat binding ──────────────────────────────────────────────────────────────
//
// Returns { ok: true, seat } or { ok: false, code: 'SEAT_CONFLICT', boundTo }.
// Runs on the caller's client (inside the reconcile transaction).
async function bindSeat(client, { orgId, userId, viewer }) {
  const slug = String(viewer.publicIdentifier).trim();

  const existing = await client.query(
    `SELECT id, user_id, display_name
       FROM user_linkedin_seats
      WHERE org_id = $1 AND lower(public_identifier) = lower($2)
      FOR UPDATE`,
    [orgId, slug]
  );

  if (existing.rows.length === 0) {
    const ins = await client.query(
      `INSERT INTO user_linkedin_seats
              (org_id, user_id, public_identifier, display_name, member_urn)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, public_identifier`,
      [orgId, userId, slug, viewer.name || null, viewer.memberUrn || null]
    );
    return { ok: true, seat: { ...ins.rows[0], newly_bound: true } };
  }

  const row = existing.rows[0];
  if (row.user_id !== userId) {
    // Whose seat is it? Resolve a friendly name for the error message.
    const u = await client.query(
      `SELECT first_name, last_name, email FROM users WHERE id = $1 AND org_id = $2`,
      [row.user_id, orgId]
    );
    const who = u.rows[0]
      ? `${u.rows[0].first_name} ${u.rows[0].last_name}`.trim() || u.rows[0].email
      : `user #${row.user_id}`;
    return { ok: false, code: 'SEAT_CONFLICT', boundTo: who, boundUserId: row.user_id };
  }

  await client.query(
    `UPDATE user_linkedin_seats
        SET last_seen_at = now(),
            display_name = COALESCE($3, display_name),
            member_urn   = COALESCE($4, member_urn)
      WHERE id = $1 AND org_id = $2`,
    [row.id, orgId, viewer.name || null, viewer.memberUrn || null]
  );
  return { ok: true, seat: { id: row.id, user_id: row.user_id, public_identifier: slug, newly_bound: false } };
}

// ── URN helpers (P3, inbox harvest) ──────────────────────────────────────────
//
// LinkedIn identifies the same member under multiple URN namespaces:
// messaging payloads use urn:li:fsd_profile:<id>, while /voyager/api/me can
// yield urn:li:fs_miniProfile:<id> (F10). The trailing <id> is the stable
// part — always compare on that, never the full string (design doc §5.2).
function normalizeUrnId(urn) {
  if (!urn) return null;
  const m = String(urn).match(/^urn:li:fs[a-z]*_(?:miniProfile|profile):([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

// Match prospects by member_urn (all owners; route partitions mine/others,
// mirroring matchProspectsBySlugs). URN-only per D2 — messaging payloads
// carry no slug, so there is no fallback.
async function matchProspectsByUrns(client, { orgId, urns }) {
  if (!urns.length) return [];
  const res = await client.query(
    `SELECT id, org_id, owner_id, first_name, last_name, company_name,
            stage, channel_data, outreach_count, member_urn
       FROM prospects
      WHERE org_id = $1
        AND deleted_at IS NULL
        AND member_urn = ANY($2::text[])`,
    [orgId, urns]
  );
  return res.rows;
}

// Direction of a harvested message (design doc §5.2, P1-confirmed).
// Primary signal: senderDistance === 'SELF' → outbound. Cross-check: the
// sender URN must agree (SELF ⇒ sender ≠ participant; non-SELF ⇒ sender ===
// participant). Any disagreement returns null and the CALLER MUST SKIP the
// message (D8 fail-closed) — wrong direction silently corrupts reply_count,
// the one metric this feature exists to produce.
function deriveDirection({ senderDistance, senderUrn, participantUrn }) {
  const senderId      = normalizeUrnId(senderUrn);
  const participantId = normalizeUrnId(participantUrn);
  if (!senderId || !participantId) return null;
  if (senderDistance === 'SELF') {
    return senderId === participantId ? null : 'outbound';   // SELF claiming to be the prospect → conflict
  }
  return senderId === participantId ? 'inbound' : null;       // non-SELF must BE the participant (1:1 threads)
}

// ── Prospect matching ─────────────────────────────────────────────────────────
//
// Match ALL org prospects by slug (no owner filter — the route partitions
// into "mine" vs "other owner" so the response can report both, while only
// "mine" are ever updated). Expression must stay byte-identical to the
// index in 2026_20_linkedin_connection_sync.sql.
async function matchProspectsBySlugs(client, { orgId, slugs }) {
  if (!slugs.length) return [];
  const res = await client.query(
    `SELECT id, org_id, owner_id, first_name, last_name, company_name,
            stage, channel_data, outreach_count,
            lower(substring(linkedin_url from '/in/([^/?#]+)')) AS slug
       FROM prospects
      WHERE org_id = $1
        AND deleted_at IS NULL
        AND linkedin_url IS NOT NULL
        AND lower(substring(linkedin_url from '/in/([^/?#]+)')) = ANY($2::text[])`,
    [orgId, slugs]
  );
  return res.rows;
}

// ── Event application (monotonic) ─────────────────────────────────────────────
//
// Applies ONE event to ONE prospect inside the caller's transaction.
// Returns { applied, action, reason } where action ∈
//   'updated' | 'timestamp_backfill' | 'already_recorded' | 'skipped_no_request'
//
// person  = { name, url, timeText } from the scrape (connection events).
// message = { urn, threadUrn, direction, occurredAtIso } from the inbox
//           harvest (message events; person may be omitted). Caller owns the
//           ledger insert + post-acceptance gate — see header.
async function applyConnectionEvent(client, {
  orgId, userId, prospect, event, person, viewerSlug, message,
}) {
  person = person || {};
  const channelData = prospect.channel_data || {};
  const li          = channelData.linkedin || {};
  const currentIdx  = statusIdx(li.connection_status);
  const newIdx      = statusIdx(event);

  const isMessageEvent = event === 'message_sent' || event === 'reply_received';
  const { iso: occurredAt, source: timeSource } = isMessageEvent
    ? { iso: (message && message.occurredAtIso) || new Date().toISOString(),
        source: (message && message.occurredAtIso) ? 'linkedin_delivered_at' : 'auto' }
    : occurredAtFromTimeText(person.timeText);
  const loggedAt = new Date().toISOString();

  let action = null;
  let requestNotLogged = false;

  if (event === 'connection_request_sent') {
    if (currentIdx >= newIdx) {
      // Already at/past sent. Backfill the timestamp if it's missing
      // (sequence logged status but not the time, or legacy data) — no
      // counters, no activity row beyond the backfill marker.
      if (!li.request_sent_at) {
        li.request_sent_at = occurredAt;
        action = 'timestamp_backfill';
      } else {
        return { applied: false, action: 'already_recorded' };
      }
    } else {
      li.connection_status = 'connection_request_sent';
      li.request_sent_at   = li.request_sent_at || occurredAt;
      action = 'updated';
    }
  } else if (event === 'connection_accepted') {
    if (li.connected_at) {
      return { applied: false, action: 'already_recorded' };
    }
    requestNotLogged = !li.request_sent_at && currentIdx < statusIdx('connection_request_sent');
    if (requestNotLogged && !RECORD_ACCEPT_WITHOUT_LOGGED_REQUEST) {
      return { applied: false, action: 'skipped_no_request' };
    }
    li.connected_at = occurredAt;
    // Only bump status forward — a prospect already at message_sent /
    // reply_received keeps the later status, we just fill connected_at.
    if (newIdx > currentIdx) li.connection_status = 'connection_accepted';
    action = 'updated';
  } else if (event === 'message_sent') {
    // Ledger (caller) guarantees this is a new, gate-passing message.
    // Timestamps only move FORWARD — thread pagination delivers old messages.
    if (!li.last_message_at || Date.parse(occurredAt) > Date.parse(li.last_message_at)) {
      li.last_message_at = occurredAt;
    }
    li.message_count = (li.message_count || 0) + 1;
    if (newIdx > currentIdx) li.connection_status = 'message_sent';
    action = 'updated';
  } else if (event === 'reply_received') {
    if (!li.last_reply_at || Date.parse(occurredAt) > Date.parse(li.last_reply_at)) {
      li.last_reply_at = occurredAt;
    }
    li.reply_count = (li.reply_count || 0) + 1;
    if (newIdx > currentIdx) li.connection_status = 'reply_received';
    action = 'updated';
  } else {
    throw new Error(`Unsupported sync event: ${event}`);
  }

  channelData.linkedin = li;

  // Counters + stage — mirror the manual endpoint:
  //   connection_request_sent / message_sent are outreach (count +
  //   last_outreach_at + stage auto-advance); reply_received is a response
  //   (response_count + last_response_at); connection_accepted is neither.
  //   Dedup guard (mirror of the manual endpoint's skipCount): when the
  //   prospect is already in an outreach+ stage AND this status was already
  //   logged, sequences/actions already counted the touch — update li.*
  //   fields but skip the aggregate counters.
  const alreadyInSeq   = OUTREACH_STAGES.includes(prospect.stage);
  const alreadyLogged  = currentIdx >= newIdx && newIdx >= 0;
  const skipCount      = alreadyInSeq && alreadyLogged;
  const isOutreach     = (event === 'connection_request_sent' || event === 'message_sent')
                         && action === 'updated';
  const isResponse     = event === 'reply_received' && action === 'updated';
  const countOutreach  = isOutreach && !skipCount;
  const countResponse  = isResponse && !skipCount;

  if (isOutreach && !skipCount && ['target', 'research'].includes(prospect.stage)) {
    await client.query(
      `UPDATE prospects SET stage = 'outreach', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND org_id = $2`,
      [prospect.id, orgId]
    );
    await client.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description)
       VALUES ($1, $2, $3, 'stage_change', 'Auto-advanced to outreach after LinkedIn outreach (connection sync)')`,
      [orgId, prospect.id, userId]
    );
  }

  await client.query(
    `UPDATE prospects SET
       channel_data     = $1::jsonb,
       last_outreach_at = CASE WHEN $2
                            THEN GREATEST(COALESCE(last_outreach_at, to_timestamp(0)), LEAST($5::timestamptz, CURRENT_TIMESTAMP))
                            ELSE last_outreach_at END,
       outreach_count   = CASE WHEN $2 THEN COALESCE(outreach_count, 0) + 1 ELSE outreach_count END,
       last_response_at = CASE WHEN $6
                            THEN GREATEST(COALESCE(last_response_at, to_timestamp(0)), LEAST($5::timestamptz, CURRENT_TIMESTAMP))
                            ELSE last_response_at END,
       response_count   = CASE WHEN $6 THEN COALESCE(response_count, 0) + 1 ELSE response_count END,
       updated_at       = CURRENT_TIMESTAMP
     WHERE id = $3 AND org_id = $4`,
    [JSON.stringify(channelData), countOutreach, prospect.id, orgId, occurredAt, countResponse]
  );

  const LABELS = {
    connection_request_sent: 'LinkedIn connection request sent',
    connection_accepted:     'LinkedIn connection accepted',
    message_sent:            'LinkedIn message sent',
    reply_received:          'LinkedIn reply received',
  };
  const desc = action === 'timestamp_backfill'
    ? `${LABELS[event]} — timestamp backfilled from LinkedIn`
    : isMessageEvent
      ? `${LABELS[event]} (inbox harvest)`
      : `${LABELS[event]} (synced from LinkedIn)`;

  await client.query(
    `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata, created_at)
     VALUES ($1, $2, $3, 'linkedin_event', $4, $5, $6)`,
    [
      orgId, prospect.id, userId, desc,
      JSON.stringify({
        event,
        channel: 'linkedin',
        source: isMessageEvent ? 'extension_message_sync' : 'extension_connection_sync',
        sync_action: action,
        occurred_at: occurredAt,
        logged_at:   loggedAt,
        time_source: timeSource,                 // 'linkedin_relative' | 'linkedin_delivered_at' | 'auto'
        time_text:   person.timeText || null,    // raw card text, audit (connection events)
        linkedin_seat: viewerSlug || null,       // which LinkedIn account this came from
        person_url:  person.url || null,
        message_urn: (message && message.urn)       || undefined,
        thread_urn:  (message && message.threadUrn) || undefined,
        direction:   (message && message.direction) || undefined,
        request_not_logged: requestNotLogged || undefined,
      }),
      occurredAt,
    ]
  );

  return { applied: true, action, occurredAt, requestNotLogged };
}

module.exports = {
  STATUS_ORDER,
  RECORD_ACCEPT_WITHOUT_LOGGED_REQUEST,
  POST_ACCEPTANCE_TOLERANCE_HOURS,
  passesPostAcceptanceGate,
  normalizeUrnId,
  deriveDirection,
  slugFromUrl,
  slugVariants,
  occurredAtFromTimeText,
  bindSeat,
  matchProspectsBySlugs,
  matchProspectsByUrns,
  applyConnectionEvent,
};
