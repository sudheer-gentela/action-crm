/**
 * whatsappSearch.service.js
 *
 * DROP-IN LOCATION: backend/services/whatsappSearch.service.js
 *
 * Self-service retrieval of captured messages, scoped by WhatsApp group
 * participation.
 *
 * THE ENTITLEMENT
 *   A user who was in the group can already read the message on their phone.
 *   Retrieving it here grants nothing new, so this needs no role — it is scoped
 *   by something externally verifiable rather than by a permission someone
 *   assigned. See whatsappAccess.service.js.
 *
 * THE THREE-WAY ANSWER
 *   The reason this file exists rather than a plain LIKE query. When someone
 *   cannot find a message they can see on their phone, "no results" is the
 *   worst possible response — it is true, useless, and indistinguishable from a
 *   broken feature. There are three real causes and each has a different next
 *   step:
 *
 *     NOT_CAPTURED     the group is not being captured at all
 *                      → offer a one-click capture request
 *     UNASSIGNED       captured, but filed to no project
 *                      → offer to file it
 *     ELSEWHERE        captured and filed to a project
 *                      → say which, and offer to move it if they may
 *
 *   Collapsing these into an empty list is what makes people stop trusting the
 *   feature. Most real misses are NOT_CAPTURED, which no amount of searching
 *   will fix.
 */

'use strict';

const { pool } = require('../config/database');
const access = require('./whatsappAccess.service');

const MAX_LIMIT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   q          free text against the message body
 *   from       sender phone or display name fragment
 *   dateFrom   ISO date
 *   dateTo     ISO date
 *   groupJid   restrict to one group
 *   handoverId restrict to one project
 *   scope      'all' (participant OR project member) | 'participant' |
 *              'assigned' | 'unassigned' (steward only)
 */
async function searchMessages(orgId, userId, opts = {}) {
  const {
    q = null, from = null, dateFrom = null, dateTo = null,
    groupJid = null, handoverId = null, scope = 'all',
    limit = 50, offset = 0,
  } = opts;

  // The unassigned queue is the one scope not covered by participation, so it
  // is the one that needs a grant.
  if (scope === 'unassigned') {
    const st = await access.isSteward(orgId, userId);
    if (!st.steward) {
      return { ok: false, code: 'NOT_STEWARD', error: 'Only a communications steward can view the unassigned queue.' };
    }
  }

  const vis = await access.buildVisibilityClause(orgId, userId, { scope, startIndex: 1 });
  const params = [...vis.params];
  const where = [vis.clause];
  let i = vis.nextIndex;
  const p = (v) => { params.push(v); return `$${i++}`; };

  if (q)          where.push(`m.body ILIKE ${p(`%${q}%`)}`);
  if (from)       where.push(`(m.from_phone ILIKE ${p(`%${from}%`)} OR m.from_name ILIKE ${p(`%${from}%`)})`);
  if (dateFrom)   where.push(`m.created_at >= ${p(dateFrom)}`);
  if (dateTo)     where.push(`m.created_at <= ${p(dateTo)}`);
  if (groupJid)   where.push(`t.wa_group_id = ${p(groupJid)}`);
  if (handoverId) where.push(`m.handover_id = ${p(parseInt(handoverId, 10))}`);

  const lim = p(Math.min(parseInt(limit, 10) || 50, MAX_LIMIT));
  const off = p(Math.max(parseInt(offset, 10) || 0, 0));

  const { rows } = await pool.query(
    `SELECT m.id, m.body, m.message_type, m.direction, m.from_phone, m.from_name,
            m.created_at, m.sent_at, m.handover_id, m.handover_source,
            m.capture_source, m.thread_id,
            t.wa_group_id, t.group_subject, t.kind,
            h.name AS project_name
       FROM whatsapp_messages m
       JOIN whatsapp_threads  t ON t.id = m.thread_id
       LEFT JOIN sales_handovers h ON h.id = m.handover_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );

  return { ok: true, messages: rows, scope };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnosis — why a search found nothing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run when searchMessages returns empty. Answers "why", using the group
 * membership recorded in 2026_105 for groups that are NOT captured.
 *
 * Returns an ordered list of possible explanations, most actionable first.
 */
async function diagnose(orgId, userId, opts = {}) {
  const { q = null } = opts;
  const findings = [];

  // 1. Is this user even linked to a WhatsApp identity? Without a verified
  //    number they are in no groups as far as we are concerned, and every
  //    search will be empty forever — worth saying so explicitly rather than
  //    letting them retry.
  const phone = await access.verifiedPhoneForUser(orgId, userId);
  if (!phone) {
    findings.push({
      code: 'NO_WHATSAPP_IDENTITY',
      severity: 'blocking',
      message: 'Your WhatsApp number has not been confirmed, so we cannot tell which groups you are in.',
      action: { type: 'contact_admin', label: 'Ask an admin to confirm your WhatsApp number' },
    });
    return { findings, groups: { captured: 0, uncaptured: 0 } };
  }

  // 2. Groups this user is in that are NOT being captured. Almost always the
  //    real answer when someone can see a message on their phone but not here.
  const { rows: uncaptured } = await pool.query(
    `SELECT g.id, g.group_jid, g.subject, g.participant_count, g.binding_status,
            EXISTS (SELECT 1 FROM whatsapp_capture_requests r
                     WHERE r.session_group_id = g.id AND r.status = 'pending') AS request_pending
       FROM whatsapp_session_group_members gm
       JOIN whatsapp_session_groups g ON g.id = gm.session_group_id
      WHERE gm.org_id = $1 AND gm.user_id = $2 AND gm.left_at IS NULL
        AND g.is_watched = false
      ORDER BY g.last_message_at DESC NULLS LAST
      LIMIT 25`,
    [orgId, userId]
  );

  if (uncaptured.length) {
    findings.push({
      code: 'NOT_CAPTURED',
      severity: 'actionable',
      message: uncaptured.length === 1
        ? `You are in 1 group that is not being captured. If the message was there, it was never stored.`
        : `You are in ${uncaptured.length} groups that are not being captured. If the message was in one of them, it was never stored.`,
      groups: uncaptured.map(g => ({
        id: g.id,
        jid: g.group_jid,
        subject: g.subject || '(no name)',
        participants: g.participant_count,
        requestPending: g.request_pending,
      })),
      action: { type: 'request_capture', label: 'Request capture for a group' },
    });
  }

  // 3. Captured groups the user is in — establishes whether search SHOULD have
  //    worked, which separates "wrong search terms" from "wrong expectations".
  const { rows: [cap] } = await pool.query(
    `SELECT count(*) AS n FROM whatsapp_thread_participants
      WHERE org_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [orgId, userId]
  );
  const capturedCount = Number(cap.n);

  if (capturedCount === 0 && uncaptured.length === 0) {
    findings.push({
      code: 'NO_GROUPS',
      severity: 'blocking',
      message: 'We have no record of you being in any WhatsApp group on the connected number.',
      action: { type: 'contact_admin', label: 'Check with an admin that the right number is connected' },
    });
  }

  // 4. Does the text exist somewhere this user cannot see? Deliberately reports
  //    only a COUNT and never the content or the project name — knowing that a
  //    match exists is a much smaller disclosure than reading it, and without
  //    this the user cannot tell "not captured" from "captured but not mine".
  if (q && capturedCount > 0) {
    const { rows: [hidden] } = await pool.query(
      `SELECT count(*) AS n
         FROM whatsapp_messages m
        WHERE m.org_id = $1 AND m.excluded_at IS NULL
          AND m.capture_source = 'session'
          AND m.body ILIKE $2
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_thread_participants wp
             WHERE wp.thread_id = m.thread_id AND wp.org_id = $1 AND wp.user_id = $3
          )`,
      [orgId, `%${q}%`, userId]
    );
    if (Number(hidden.n) > 0) {
      findings.push({
        code: 'EXISTS_BUT_NOT_YOURS',
        severity: 'informational',
        message: `${hidden.n} matching message${Number(hidden.n) === 1 ? '' : 's'} exist in groups you were not part of. You cannot view them here.`,
        action: { type: 'contact_steward', label: 'Ask a communications steward' },
      });
    }
  }

  if (!findings.length) {
    findings.push({
      code: 'NO_MATCH',
      severity: 'informational',
      message: 'Nothing matched in the groups you are in. Try fewer words, or widen the date range.',
      action: null,
    });
  }

  return {
    findings,
    groups: { captured: capturedCount, uncaptured: uncaptured.length },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture requests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask for a group to start being captured. Approval stays with an admin:
 * switching capture on is a data-retention decision about a room full of
 * people, not a convenience toggle for one of them.
 */
async function requestCapture(orgId, userId, sessionGroupId, { reason = null, suggestedHandoverId = null } = {}) {
  // You may only request a group you are actually in.
  const { rows: [member] } = await pool.query(
    `SELECT 1 FROM whatsapp_session_group_members
      WHERE org_id = $1 AND user_id = $2 AND session_group_id = $3 AND left_at IS NULL`,
    [orgId, userId, sessionGroupId]
  );
  if (!member) return { ok: false, code: 'NOT_A_MEMBER', error: 'You are not a member of that group.' };

  const { rows: [g] } = await pool.query(
    `SELECT id, is_watched, subject FROM whatsapp_session_groups WHERE id = $1 AND org_id = $2`,
    [sessionGroupId, orgId]
  );
  if (!g) return { ok: false, code: 'NOT_FOUND' };
  if (g.is_watched) return { ok: false, code: 'ALREADY_CAPTURED', error: 'That group is already being captured.' };

  const { rows: [req] } = await pool.query(
    `INSERT INTO whatsapp_capture_requests
       (org_id, session_group_id, requested_by, reason, suggested_handover_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (session_group_id) WHERE status = 'pending'
       DO UPDATE SET reason = COALESCE(EXCLUDED.reason, whatsapp_capture_requests.reason)
     RETURNING *`,
    [orgId, sessionGroupId, userId, reason, suggestedHandoverId]
  );
  return { ok: true, request: req, groupSubject: g.subject };
}

async function listCaptureRequests(orgId, { status = 'pending' } = {}) {
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.reason, r.created_at, r.suggested_handover_id,
            g.id AS session_group_id, g.subject, g.group_jid, g.participant_count,
            u.first_name, u.last_name, u.email,
            h.name AS suggested_project
       FROM whatsapp_capture_requests r
       JOIN whatsapp_session_groups g ON g.id = r.session_group_id
       JOIN users u ON u.id = r.requested_by
       LEFT JOIN sales_handovers h ON h.id = r.suggested_handover_id
      WHERE r.org_id = $1 AND r.status = $2
      ORDER BY r.created_at DESC`,
    [orgId, status]
  );
  return rows;
}

/**
 * Approve or decline. Approving switches capture on for the group and, when a
 * project was suggested, binds it — the two things the requester actually
 * wanted, done in one transaction so a half-applied approval is impossible.
 */
async function decideCaptureRequest(orgId, adminUserId, requestId, { approve, note = null }) {
  const { rows: [req] } = await pool.query(
    `SELECT * FROM whatsapp_capture_requests WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
    [requestId, orgId]
  );
  if (!req) return { ok: false, code: 'NOT_FOUND' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);

    await client.query(
      `UPDATE whatsapp_capture_requests
          SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3
        WHERE id = $4`,
      [approve ? 'approved' : 'declined', adminUserId, note, requestId]
    );

    if (approve) {
      await client.query(
        `UPDATE whatsapp_session_groups
            SET is_watched = true, watched_by = $1, watched_at = now(), updated_at = now()
          WHERE id = $2`,
        [adminUserId, req.session_group_id]
      );
    }

    await client.query('COMMIT');
    return { ok: true, approved: !!approve, sessionGroupId: req.session_group_id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Filing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * File, move, or un-file a message. handoverId === null means "send back to
 * unassigned"; authorisation for that is deliberately stricter — see
 * whatsappAccess.canMoveMessage.
 *
 * scope 'thread' moves every message currently filed the same way as this one,
 * which is what someone means by "this whole conversation belongs to Acme".
 */
async function fileMessage(orgId, userId, messageId, { handoverId = null, scope = 'message' } = {}) {
  if (!['message', 'thread'].includes(scope)) {
    return { ok: false, code: 'BAD_SCOPE', error: "scope must be 'message' or 'thread'" };
  }

  const auth = await access.canMoveMessage(orgId, userId, messageId, handoverId);
  if (!auth.ok) return auth;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);

    const { rows: moved } = await client.query(
      scope === 'thread'
        ? `UPDATE whatsapp_messages
              SET handover_id = $3, handover_source = 'manual',
                  handover_tagged_by = $4, handover_tagged_at = now()
            WHERE org_id = $1 AND thread_id = $2
              AND handover_id IS NOT DISTINCT FROM $5
              AND excluded_at IS NULL
            RETURNING id`
        : `UPDATE whatsapp_messages
              SET handover_id = $3, handover_source = 'manual',
                  handover_tagged_by = $4, handover_tagged_at = now()
            WHERE org_id = $1 AND thread_id = $2 AND id = $5
              AND excluded_at IS NULL
            RETURNING id`,
      scope === 'thread'
        ? [orgId, auth.threadId, handoverId, userId, auth.currentHandoverId]
        : [orgId, auth.threadId, handoverId, userId, messageId]
    );

    if (scope === 'thread') {
      await client.query(
        `UPDATE whatsapp_threads SET handover_id = $1, updated_at = now()
          WHERE id = $2 AND org_id = $3`,
        [handoverId, auth.threadId, orgId]
      );
    }

    await client.query('COMMIT');
    return {
      ok: true,
      moved: moved.length,
      from: auth.currentHandoverId,
      to: handoverId,
      scope,
      via: auth.sourceVia,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a message as not CRM material.
 *
 * The safe disposal path, and NOT deletion. A mis-filed message was still seen
 * by whoever had access to the project it landed on; erasing the row would
 * erase the evidence of that. Excluded messages disappear from every project
 * view and from search, and survive only for audit.
 */
async function excludeMessage(orgId, userId, messageId, reason = null) {
  const auth = await access.canMoveMessage(orgId, userId, messageId, null);
  // Exclusion is permitted wherever the user has SOURCE access, even when
  // un-assigning would not be — because it narrows exposure rather than
  // widening it.
  if (!auth.ok && auth.code !== 'CANNOT_UNASSIGN') return auth;

  const { rows } = await pool.query(
    `UPDATE whatsapp_messages
        SET excluded_at = now(), excluded_by = $1, exclude_reason = $2
      WHERE id = $3 AND org_id = $4 AND excluded_at IS NULL
      RETURNING id, handover_id`,
    [userId, reason, messageId, orgId]
  );
  if (!rows.length) return { ok: false, code: 'NOT_FOUND' };
  return { ok: true, messageId, wasOn: rows[0].handover_id };
}

/**
 * Audit view. Mis-attribution is a disclosure event: if a message sat on the
 * wrong project for three days, people with that project's access saw it. This
 * is what makes "who saw this?" answerable rather than reconstructed.
 */
async function recentMoves(orgId, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT m.id, m.handover_id, m.handover_tagged_at, m.handover_source,
            left(m.body, 80) AS preview,
            t.group_subject, t.wa_group_id,
            h.name AS project_name,
            u.first_name, u.last_name,
            m.excluded_at, m.exclude_reason,
            eu.first_name AS excluded_by_first, eu.last_name AS excluded_by_last
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
       LEFT JOIN sales_handovers h ON h.id = m.handover_id
       LEFT JOIN users u  ON u.id  = m.handover_tagged_by
       LEFT JOIN users eu ON eu.id = m.excluded_by
      WHERE m.org_id = $1
        AND (m.handover_tagged_at IS NOT NULL OR m.excluded_at IS NOT NULL)
      ORDER BY COALESCE(m.excluded_at, m.handover_tagged_at) DESC
      LIMIT $2`,
    [orgId, Math.min(parseInt(limit, 10) || 100, 500)]
  );
  return rows;
}

module.exports = {
  searchMessages,
  diagnose,
  requestCapture,
  listCaptureRequests,
  decideCaptureRequest,
  fileMessage,
  excludeMessage,
  recentMoves,
};
