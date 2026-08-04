/**
 * whatsappAccess.service.js
 *
 * DROP-IN LOCATION: backend/services/whatsappAccess.service.js
 *
 * The single place that answers "may this user see this captured message?".
 *
 * THE MODEL — three independent entitlements, none implying another:
 *
 *   PARTICIPATION  You were in the WhatsApp group. You can already read the
 *                  message on your phone, so retrieving it here grants nothing
 *                  new. This is the primary entitlement and the reason
 *                  self-service search is safe.
 *
 *   PROJECT        You can file into a project (projectFiles.assertCanFile).
 *                  Lets you see messages already assigned to it.
 *
 *   STEWARD        An explicit org-wide grant to triage UNASSIGNED messages.
 *                  Handles only the residue no participant can self-serve.
 *
 * WHY A STEWARD IS NOT A SUPERUSER
 *   A steward may route an unassigned message into a project. They may NOT read
 *   messages already assigned to projects they are not a member of, and — the
 *   load-bearing part — they may NOT un-tag a message out of such a project.
 *   Without that restriction, "un-tag, then read from the unassigned pool" is a
 *   clean privilege-escalation path to every message in the org.
 *
 * WHY MEMBERSHIP IS TIME-BOUNDED
 *   whatsapp_thread_participants carries joined_at / left_at. Someone added to
 *   a group last week must not be able to pull three months of prior history —
 *   which is also exactly what WhatsApp itself does. Access follows the window
 *   during which the person was actually in the room.
 */

'use strict';

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/** The verified WhatsApp number for a user, or null. self_claimed does NOT count. */
async function verifiedPhoneForUser(orgId, userId) {
  const { rows: [u] } = await pool.query(
    `SELECT whatsapp_phone
       FROM users
      WHERE id = $1 AND org_id = $2
        AND whatsapp_phone IS NOT NULL
        AND whatsapp_phone_verified_at IS NOT NULL`,
    [userId, orgId]
  );
  return u?.whatsapp_phone || null;
}

/**
 * Assign and verify a user's WhatsApp number. Admin-only at the route layer.
 *
 * Verification here means "a human who knows the team confirmed it". That is
 * weaker than an OTP but honest about what it is, and it is the strongest thing
 * available while the session worker stays read-only. Once set, participant
 * rows are linked immediately so access takes effect without waiting for the
 * next message in each group.
 */
async function setUserWhatsAppPhone(orgId, actorUserId, targetUserId, rawPhone, { source = 'admin' } = {}) {
  const phone = String(rawPhone || '').replace(/[^0-9]/g, '');
  if (phone && phone.length < 8) {
    return { ok: false, code: 'BAD_PHONE', error: 'Enter the full number including country code.' };
  }

  // Clearing is always allowed and revokes access immediately.
  if (!phone) {
    await pool.query(
      `UPDATE users SET whatsapp_phone = NULL, whatsapp_phone_verified_at = NULL,
              whatsapp_phone_source = NULL, whatsapp_phone_set_by = $1
        WHERE id = $2 AND org_id = $3`,
      [actorUserId, targetUserId, orgId]
    );
    await pool.query(
      `UPDATE whatsapp_thread_participants SET user_id = NULL
        WHERE org_id = $1 AND user_id = $2`,
      [orgId, targetUserId]
    );
    return { ok: true, cleared: true };
  }

  // A duplicate would silently hand one user another's groups, because
  // participant matching is by phone.
  const { rows: [clash] } = await pool.query(
    `SELECT id, first_name, last_name FROM users
      WHERE org_id = $1 AND whatsapp_phone = $2 AND id <> $3`,
    [orgId, phone, targetUserId]
  );
  if (clash) {
    return {
      ok: false, code: 'PHONE_IN_USE',
      error: `That number is already assigned to ${clash.first_name} ${clash.last_name}.`,
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);

    await client.query(
      `UPDATE users
          SET whatsapp_phone = $1,
              whatsapp_phone_source = $2,
              whatsapp_phone_verified_at = CASE WHEN $2 = 'self_claimed' THEN NULL ELSE now() END,
              whatsapp_phone_set_by = $3,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $4 AND org_id = $5`,
      [phone, source, actorUserId, targetUserId, orgId]
    );

    // Any participant row already carrying this phone is this user. Marking
    // side='internal' also stops them being offered as a customer contact.
    const { rowCount: linked } = source === 'self_claimed' ? { rowCount: 0 } : await client.query(
      `UPDATE whatsapp_thread_participants
          SET user_id = $1, side = 'internal'
        WHERE org_id = $2 AND wa_phone = $3`,
      [targetUserId, orgId, phone]
    );

    await client.query('COMMIT');
    return { ok: true, phone, source, linkedParticipantRows: linked };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Called from the ingest path whenever a participant is seen, so a user who is
 * added to a group after their number was verified is linked on first message
 * rather than needing a backfill.
 */
async function linkParticipantIfKnown(orgId, threadId, waPhone) {
  if (!waPhone) return false;
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_thread_participants p
        SET user_id = u.id, side = 'internal'
       FROM users u
      WHERE p.org_id = $1 AND p.thread_id = $2 AND p.wa_phone = $3
        AND p.user_id IS NULL
        AND u.org_id = $1 AND u.whatsapp_phone = $3
        AND u.whatsapp_phone_verified_at IS NOT NULL`,
    [orgId, threadId, waPhone]
  );
  return rowCount > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entitlements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this user a communications steward?
 *
 * Org admins hold it implicitly — they can grant themselves anything, so
 * withholding it would be theatre rather than security, and making it implicit
 * at least keeps it visible. The user who connected the session holds it
 * implicitly too: they already chose which groups to capture and have seen the
 * group names, so denying them the queue creates a bottleneck for no privacy
 * gain.
 */
async function isSteward(orgId, userId) {
  const { rows: [r] } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM communication_stewards
                WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL) AS explicit_grant,
       EXISTS (SELECT 1 FROM users
                WHERE id = $2 AND org_id = $1 AND role IN ('admin','owner')) AS is_admin,
       EXISTS (SELECT 1 FROM whatsapp_sessions
                WHERE org_id = $1 AND created_by = $2 AND status <> 'disabled') AS connected_session`,
    [orgId, userId]
  );
  if (!r) return { steward: false };
  const via = r.explicit_grant ? 'grant'
            : r.is_admin ? 'admin'
            : r.connected_session ? 'session_owner'
            : null;
  return { steward: !!via, via };
}

/**
 * Thread ids the user was a participant of, with the window they were present.
 * This is the participation entitlement, and the reason self-service search
 * needs no role at all.
 */
async function participantThreadWindows(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT thread_id, joined_at, left_at
       FROM whatsapp_thread_participants
      WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId]
  );
  return rows;
}

/**
 * A SQL fragment restricting whatsapp_messages to what this user may see, plus
 * its bound parameters. Centralised so no caller can accidentally write a
 * looser query — every read path composes this rather than rolling its own.
 *
 * @param {object} opts
 *   scope: 'participant'  — only groups the user was in (default, safest)
 *          'assigned'     — only messages on projects they can file into
 *          'unassigned'   — the steward queue; requires isSteward
 *          'all'          — participant OR assigned, the normal search default
 */
async function buildVisibilityClause(orgId, userId, { scope = 'all', startIndex = 1 } = {}) {
  const params = [];
  let i = startIndex;
  const p = (v) => { params.push(v); return `$${i++}`; };

  const orgP  = p(orgId);
  const userP = p(userId);

  // Participation, time-bounded: access follows the window during which the
  // person was actually in the room.
  const participant = `
    EXISTS (
      SELECT 1 FROM whatsapp_thread_participants wp
       WHERE wp.thread_id = m.thread_id
         AND wp.org_id    = ${orgP}
         AND wp.user_id   = ${userP}
         AND (wp.joined_at IS NULL OR m.created_at >= wp.joined_at)
         AND (wp.left_at   IS NULL OR m.created_at <= wp.left_at)
    )`;

  // Project membership. Mirrors projectFiles.canFile — approved project_members
  // rows, or the org-admin/owner path that canManageFiles allows. Kept in SQL
  // rather than a per-row call so a search over thousands of messages is one
  // query instead of thousands.
  const assigned = `
    m.handover_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM project_members pm
         WHERE pm.context_type = 'handover'
           AND pm.context_id   = m.handover_id
           AND pm.org_id       = ${orgP}
           AND pm.user_id      = ${userP}
           AND pm.status       = 'approved'
      )
      OR EXISTS (
        SELECT 1 FROM users au
         WHERE au.id = ${userP} AND au.org_id = ${orgP}
           AND au.role IN ('admin','owner')
      )
    )`;

  const unassignedOnly = `m.handover_id IS NULL`;

  let clause;
  if (scope === 'participant')      clause = participant;
  else if (scope === 'assigned')    clause = assigned;
  else if (scope === 'unassigned')  clause = unassignedOnly;
  else                              clause = `(${participant} OR ${assigned})`;

  // Excluded messages are gone from every read path. They survive only for
  // audit, which reads the table directly rather than through this helper.
  return { clause: `(${clause}) AND m.excluded_at IS NULL AND m.org_id = ${orgP}`, params, nextIndex: i };
}

/**
 * Can this user file a message INTO this project? Delegates to the existing
 * projectFiles rule so there is one answer, not two that drift.
 */
async function canFileInto(orgId, userId, handoverId) {
  try {
    const projectFiles = require('./projectFiles.service');
    await projectFiles.assertCanFile(handoverId, orgId, userId);
    return true;
  } catch {
    return false;
  }
}

/**
 * The full authorisation decision for moving a message.
 *
 * TWO SIDES, BOTH REQUIRED:
 *   source      — you must be entitled to the message where it is now, either
 *                 as a group participant or as a member of its current project
 *   destination — you must be able to file into the target project
 *
 * A steward satisfies the source side ONLY when the message is unassigned. That
 * is what stops "un-tag, then read" from becoming a way to reach every message
 * in the org.
 */
async function canMoveMessage(orgId, userId, messageId, targetHandoverId) {
  const { rows: [m] } = await pool.query(
    `SELECT id, thread_id, handover_id, excluded_at FROM whatsapp_messages
      WHERE id = $1 AND org_id = $2`,
    [messageId, orgId]
  );
  if (!m) return { ok: false, code: 'NOT_FOUND' };

  // Source side
  const { rows: [src] } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM whatsapp_thread_participants wp
                WHERE wp.thread_id = $1 AND wp.org_id = $2 AND wp.user_id = $3) AS was_participant`,
    [m.thread_id, orgId, userId]
  );

  let sourceOk = src.was_participant;
  let sourceVia = src.was_participant ? 'participant' : null;

  if (!sourceOk && m.handover_id != null) {
    if (await canFileInto(orgId, userId, m.handover_id)) { sourceOk = true; sourceVia = 'project_member'; }
  }
  if (!sourceOk && m.handover_id == null) {
    const st = await isSteward(orgId, userId);
    if (st.steward) { sourceOk = true; sourceVia = `steward:${st.via}`; }
  }

  if (!sourceOk) {
    return {
      ok: false, code: 'NO_SOURCE_ACCESS',
      error: 'You were not in this WhatsApp group and are not a member of the project it is filed under.',
    };
  }

  // Destination side — null means "send back to unassigned".
  if (targetHandoverId != null && !(await canFileInto(orgId, userId, targetHandoverId))) {
    return { ok: false, code: 'NO_DESTINATION_ACCESS', error: 'You cannot file into that project.' };
  }

  // Un-tagging can WIDEN exposure: it moves a message from a project's members
  // to whoever can see the unassigned pool. If it was mis-filed precisely
  // because it was sensitive, that is the wrong remedy — exclusion is.
  if (targetHandoverId == null && m.handover_id != null && sourceVia === 'participant') {
    const st = await isSteward(orgId, userId);
    if (!st.steward && !(await canFileInto(orgId, userId, m.handover_id))) {
      return {
        ok: false, code: 'CANNOT_UNASSIGN',
        error: 'Only a project member or a communications steward can send a message back to the unassigned queue. You can exclude it instead.',
      };
    }
  }

  return { ok: true, sourceVia, currentHandoverId: m.handover_id, threadId: m.thread_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Steward grants
// ─────────────────────────────────────────────────────────────────────────────

async function listStewards(orgId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.granted_at, s.note,
            u.first_name, u.last_name, u.email,
            g.first_name AS granted_by_first, g.last_name AS granted_by_last
       FROM communication_stewards s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN users g ON g.id = s.granted_by
      WHERE s.org_id = $1 AND s.revoked_at IS NULL
      ORDER BY s.granted_at`,
    [orgId]
  );

  const { rows: implicit } = await pool.query(
    `SELECT id AS user_id, first_name, last_name, email, 'admin' AS via
       FROM users WHERE org_id = $1 AND role IN ('admin','owner')`,
    [orgId]
  );

  return {
    explicit: rows,
    implicit,
    // A queue nobody can drain fills up silently. Surfacing this matters more
    // than it looks: unassigned messages are invisible by design.
    warning: rows.length === 0
      ? 'No explicit stewards. Only org admins can triage unassigned messages, which usually makes them a bottleneck.'
      : null,
  };
}

async function grantSteward(orgId, actorUserId, userId, note = null) {
  const { rows: [u] } = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND org_id = $2`, [userId, orgId]);
  if (!u) return { ok: false, code: 'USER_NOT_FOUND' };

  const { rows: [row] } = await pool.query(
    `INSERT INTO communication_stewards (org_id, user_id, granted_by, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, user_id) WHERE revoked_at IS NULL
       DO UPDATE SET note = EXCLUDED.note
     RETURNING *`,
    [orgId, userId, actorUserId, note]
  );
  return { ok: true, steward: row };
}

async function revokeSteward(orgId, actorUserId, userId) {
  const { rowCount } = await pool.query(
    `UPDATE communication_stewards
        SET revoked_at = now(), revoked_by = $1
      WHERE org_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
    [actorUserId, orgId, userId]
  );
  return rowCount ? { ok: true } : { ok: false, code: 'NOT_FOUND' };
}

module.exports = {
  verifiedPhoneForUser,
  setUserWhatsAppPhone,
  linkParticipantIfKnown,
  isSteward,
  participantThreadWindows,
  buildVisibilityClause,
  canFileInto,
  canMoveMessage,
  listStewards,
  grantSteward,
  revokeSteward,
};
