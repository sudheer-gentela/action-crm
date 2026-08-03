// ─────────────────────────────────────────────────────────────────────────────
// projectMembers.service.js
//
// Internal "project users" with a request → approve/reject workflow.
//
//   • Anyone with project access REQUESTS a user + project role.
//   • Auto-approve when the target user's email domain matches one of the org's
//     domains AND a seat is available (active org_users < organizations.max_users);
//     otherwise the request goes to an admin as 'pending'.
//   • Admins approve → 'approved', or reject with a reason → 'rejected'.
//
// Only links EXISTING users (from org_users). New-user-by-email provisioning is a
// separate, later build (needs the module-access model).
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('../config/database');

const emailDomain = (email) => String(email || '').split('@')[1]?.toLowerCase().trim() || '';

// ── Org email domains (used by auto-approve; managed in Org Settings) ─────────
async function listDomains(orgId) {
  const { rows } = await pool.query(
    `SELECT id, domain, created_at FROM org_email_domains WHERE org_id = $1 ORDER BY domain`, [orgId]);
  return { domains: rows };
}
async function addDomain(orgId, userId, domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^@/, '');
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
    throw Object.assign(new Error('Enter a valid domain, e.g. acme.com'), { status: 400 });
  await pool.query(
    `INSERT INTO org_email_domains (org_id, domain, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, lower(domain)) DO NOTHING`, [orgId, d, userId]);
  return listDomains(orgId);
}
async function removeDomain(orgId, id) {
  await pool.query(`DELETE FROM org_email_domains WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return listDomains(orgId);
}

// ── Authority ────────────────────────────────────────────────────────────────
/**
 * Who may add, approve and remove members on ONE project.
 *
 * Previously this was org admin only, which meant the person running a project
 * could not staff it — they could raise a request and then wait for an org
 * admin to approve their own team. The service owner and the creator are the
 * two people accountable for the project, so they get the same authority over
 * it that an org admin has.
 *
 * Scoped to the single project. Nothing here grants rights anywhere else.
 */
async function canManageProject(handoverId, orgId, userId) {
  if (!userId) return false;
  const { rows: [r] } = await pool.query(
    `SELECT ou.role AS org_role,
            h.assigned_service_owner_id,
            h.created_by
       FROM org_users ou
       LEFT JOIN sales_handovers h ON h.id = $3 AND h.org_id = $1
      WHERE ou.org_id = $1 AND ou.user_id = $2`,
    [orgId, userId, handoverId]
  );
  if (!r) return false;
  if (['admin', 'owner'].includes(r.org_role)) return true;
  return r.assigned_service_owner_id === userId || r.created_by === userId;
}

// ── Auto-approve inputs ──────────────────────────────────────────────────────
async function seatAvailable(orgId) {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE) AS used,
            (SELECT max_users FROM organizations WHERE id = $1)                     AS cap`, [orgId]);
  return { used: Number(r.used), cap: Number(r.cap), available: Number(r.used) < Number(r.cap) };
}

/**
 * Returns { auto, reason } rather than a bare boolean.
 *
 * The reason matters operationally. Nothing populates org_email_domains
 * automatically, so an org that never visited Org Admin → Email Domains has an
 * empty table and EVERY add lands in 'pending' — which reads as the feature
 * being broken rather than as a missing prerequisite. Naming the cause lets the
 * UI say so instead of silently queueing.
 */
async function autoApproveDecision(orgId, targetUserId) {
  const { rows: [u] } = await pool.query(`SELECT email FROM users WHERE id = $1`, [targetUserId]);
  const dom = emailDomain(u?.email);
  if (!dom) return { auto: false, reason: 'no_email_domain' };

  const { rows: domains } = await pool.query(
    `SELECT lower(domain) AS domain FROM org_email_domains WHERE org_id = $1`, [orgId]);

  if (!domains.length) return { auto: false, reason: 'no_org_domains_configured' };
  if (!domains.some(d => d.domain === dom)) return { auto: false, reason: 'domain_not_registered' };

  const seat = await seatAvailable(orgId);
  if (!seat.available) return { auto: false, reason: 'no_seats_available', seat };

  return { auto: true, reason: 'domain_verified' };
}

// Kept for callers that only need the boolean.
async function shouldAutoApprove(orgId, targetUserId) {
  return (await autoApproveDecision(orgId, targetUserId)).auto;
}

// ── Reads ────────────────────────────────────────────────────────────────────
function fmt(row) {
  return {
    id: row.id, userId: row.user_id, name: row.name, email: row.email,
    roleId: row.role_id, roleName: row.role_name, customRole: row.custom_role,
    side: row.side || 'delivery',
    email: row.email || null,
    phone: row.phone || null,
    whatsappPhone: row.whatsapp_phone || null,
    status: row.status, reviewReason: row.review_reason,
    requestedBy: row.requested_by, requestedByName: row.requested_by_name,
    createdAt: row.created_at,
  };
}

async function listForHandover(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT pm.*, (u.first_name || ' ' || u.last_name) AS name, u.email,
            u.phone, u.whatsapp_phone,
            r.name AS role_name, (ru.first_name || ' ' || ru.last_name) AS requested_by_name
       FROM project_members pm
       JOIN users u  ON u.id = pm.user_id
       LEFT JOIN org_roles r ON r.id = pm.role_id
       LEFT JOIN users ru ON ru.id = pm.requested_by
      WHERE pm.context_type = 'handover' AND pm.context_id = $1 AND pm.org_id = $2
      ORDER BY (pm.status = 'pending') DESC, name`,
    [handoverId, orgId]);
  return { members: rows.map(fmt) };
}

// ── Writes ───────────────────────────────────────────────────────────────────
async function requestMember(handoverId, orgId, requesterId, data) {
  // New-user path: an email that isn't an existing member → create a pending,
  // admin-approved invitation scoped to this project's module (handovers).
  if (data.email && !data.userId) {
    const email = String(data.email).trim().toLowerCase();
    const { rows: existing } = await pool.query(
      `SELECT ou.user_id FROM org_users ou JOIN users u ON u.id = ou.user_id
        WHERE ou.org_id = $1 AND lower(u.email) = $2 AND ou.is_active = TRUE`, [orgId, email]);
    if (existing.length) {
      // They already exist — fall through to the existing-user path.
      data.userId = existing[0].user_id;
    } else {
      const invites = require('./inviteProvisioning.service');
      const out = await invites.createInvite(orgId, requesterId, {
        email, role: 'member', roleId: data.roleId || null,
        modules: ['handovers'], contextType: 'handover', contextId: handoverId,
        reportsTo: data.reportsTo || null, requestedBy: requesterId,
        autoApprove: false,   // admin must approve before the invite email is sent
      });
      return { invited: true, status: out.status };   // 'pending_approval'
    }
  }

  const userId = parseInt(data.userId, 10);
  if (!userId) throw Object.assign(new Error('Pick a user to add'), { status: 400 });

  // Must be an active member of this org.
  const { rows: [ok] } = await pool.query(
    `SELECT 1 FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`, [orgId, userId]);
  if (!ok) throw Object.assign(new Error('That user is not an active member of this org'), { status: 400 });

  // 'internal_customer' is the person the work is FOR — the one who accepts it
  // as done. Stored as a side rather than a role name because closure sign-off
  // keys off it, and a role label can be renamed in the config screen.
  const side = data.side === 'internal_customer' ? 'internal_customer' : 'delivery';

  const decision = await autoApproveDecision(orgId, userId);
  // A project owner or org admin adding someone to their own project is not
  // making a request — they are staffing it. Approval exists to stop arbitrary
  // people granting access, which does not describe this caller.
  const byManager = await canManageProject(handoverId, orgId, requesterId);
  // ...but naming your own acceptor is exactly the thing sign-off exists to
  // prevent, so an internal customer always goes to an org admin.
  const auto      = side === 'internal_customer'
    ? false
    : (decision.auto || byManager);
  const status    = auto ? 'approved' : 'pending';

  const { rows: [pm] } = await pool.query(
    `INSERT INTO project_members
       (org_id, context_type, context_id, user_id, role_id, custom_role, status,
        requested_by, reviewed_by, reviewed_at, side)
     VALUES ($1,'handover',$2,$3,$4,$5,$6,$7::int,
             -- Explicit cast: $7 feeds both requested_by and, through a CASE
             -- compared against a text parameter, reviewed_by. Without it
             -- Postgres deduces conflicting types for the same parameter.
             CASE WHEN $6 = 'approved' THEN $7::int ELSE NULL END,
             CASE WHEN $6 = 'approved' THEN now() ELSE NULL END,
             $8)
     ON CONFLICT (context_type, context_id, user_id)
       DO UPDATE SET role_id = EXCLUDED.role_id, custom_role = EXCLUDED.custom_role,
                     side = EXCLUDED.side
     RETURNING id`,
    [orgId, handoverId, userId, data.roleId || null, data.customRole || null, status, requesterId, side]);

  return {
    id: pm.id,
    status,
    autoApproved: auto,
    // 'added_by_project_manager' | 'domain_verified' | why it went to pending.
    // The UI uses this to explain a pending row instead of leaving the adder
    // wondering why nothing happened.
    reason: auto ? (decision.auto ? decision.reason : 'added_by_project_manager') : decision.reason,
  };
}

/**
 * A member declines an invitation, or leaves a project they were on.
 *
 * Distinct from reviewMember(): that records an admin decision. This records
 * the member's own, and writes exit_at / exit_reason rather than the review_*
 * columns so the audit trail does not claim an admin acted.
 *
 * The row is kept, not deleted — "Deepa left this project on 3 Aug" is a fact
 * someone reviewing the project later needs, and a DELETE would erase it.
 */
async function selfExit(handoverId, orgId, userId, reason = null) {
  const { rows: [pm] } = await pool.query(
    `SELECT id, status FROM project_members
      WHERE context_type = 'handover' AND context_id = $1 AND org_id = $2 AND user_id = $3`,
    [handoverId, orgId, userId]);

  if (!pm) throw Object.assign(new Error('You are not on this project'), { status: 404 });
  if (['declined', 'left'].includes(pm.status)) return { id: pm.id, status: pm.status, alreadyExited: true };
  if (pm.status === 'rejected') throw Object.assign(new Error('That request was already rejected'), { status: 400 });

  // Turning down an invitation and stepping off a project are different facts.
  const next = pm.status === 'pending' ? 'declined' : 'left';

  await pool.query(
    `UPDATE project_members
        SET status = $2, exited_at = now(), exit_reason = $3
      WHERE id = $1`,
    [pm.id, next, reason || null]);

  return { id: pm.id, status: next, alreadyExited: false };
}

async function reviewMember(handoverId, orgId, adminId, memberId, action, reason) {
  const { rows: [pm] } = await pool.query(
    `SELECT * FROM project_members WHERE id = $1 AND org_id = $2 AND context_type = 'handover' AND context_id = $3`,
    [memberId, orgId, handoverId]);
  if (!pm) throw Object.assign(new Error('Request not found'), { status: 404 });

  if (action === 'approve') {
    await pool.query(
      `UPDATE project_members SET status='approved', reviewed_by=$2, reviewed_at=now(), review_reason=NULL WHERE id=$1`,
      [memberId, adminId]);
    return { id: memberId, status: 'approved' };
  }
  if (action === 'reject') {
    if (!reason || !String(reason).trim())
      throw Object.assign(new Error('A rejection reason is required'), { status: 400 });
    await pool.query(
      `UPDATE project_members SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_reason=$3 WHERE id=$1`,
      [memberId, adminId, String(reason).trim()]);
    return { id: memberId, status: 'rejected' };
  }
  throw Object.assign(new Error("action must be 'approve' or 'reject'"), { status: 400 });
}

/**
 * Change an existing member's role or side.
 *
 * There was no way to do this at all — the routes had add, review, remove and
 * self-exit, and the row rendered as flat text. So a member added as "Team
 * member" stayed one forever, and the open question of restoring somebody's
 * prior role after a Project Manager demotion had no mechanism behind it.
 *
 * Moving someone INTO internal_customer resets them to pending: they are being
 * made the acceptor of the work, which is an org-admin decision, not the
 * project manager's.
 */
async function changeRole(handoverId, orgId, memberId, patch = {}) {
  const { rows: [pm] } = await pool.query(
    `SELECT id, side, status FROM project_members
      WHERE id = $1 AND org_id = $2 AND context_type = 'handover' AND context_id = $3`,
    [memberId, orgId, handoverId]);
  if (!pm) throw Object.assign(new Error('Member not found'), { status: 404 });
  if (['declined', 'left', 'rejected'].includes(pm.status)) {
    throw Object.assign(new Error('That person is no longer on the project'), { status: 400 });
  }

  const sets = ['role_id = $3', 'custom_role = $4'];
  const vals = [memberId, orgId, patch.roleId || null, patch.customRole || null];

  if (patch.side !== undefined) {
    const side = patch.side === 'internal_customer' ? 'internal_customer' : 'delivery';
    vals.push(side); sets.push(`side = $${vals.length}`);
    if (side === 'internal_customer' && pm.side !== 'internal_customer') {
      sets.push(`status = 'pending'`, `reviewed_by = NULL`, `reviewed_at = NULL`);
    }
  }

  const { rows } = await pool.query(
    `UPDATE project_members SET ${sets.join(', ')}
      WHERE id = $1 AND org_id = $2
      RETURNING id, role_id, custom_role, side, status`,
    vals);
  return { member: rows[0] };
}

/**
 * Set a project member's contact phone numbers.
 *
 * WHY THIS EXISTS: on an internal project the team IS users, and users could
 * only ever edit their own phone (PATCH /user-phone/phone is WHERE id =
 * caller). So if somebody never set a number, the project could not WhatsApp
 * them and nobody could fix it. Contacts on a customer project had no such
 * problem, which is the asymmetry this closes.
 *
 * EMAIL IS NOT EDITABLE HERE, deliberately. users.email is the login identity —
 * sign-in, password reset, invitations and the oauth_tokens rows all hang off
 * it. Changing it from a project panel would be an account-takeover primitive
 * rather than a convenience. A wrong address is fixed by re-inviting.
 *
 * Gated on canManageProject: org admin/owner, the assigned Project Manager, or
 * the creator.
 */
async function updateMemberContact(handoverId, orgId, actorId, memberId, patch = {}) {
  if (!(await canManageProject(handoverId, orgId, actorId))) {
    throw Object.assign(
      new Error('Only an org admin or the Project Manager can edit a member\'s details'),
      { status: 403 });
  }

  const { rows: [pm] } = await pool.query(
    `SELECT pm.user_id FROM project_members pm
      WHERE pm.id = $1 AND pm.org_id = $2 AND pm.context_type = 'handover' AND pm.context_id = $3`,
    [memberId, orgId, handoverId]);
  if (!pm) throw Object.assign(new Error('Member not found'), { status: 404 });

  const sets = [];
  const vals = [pm.user_id, orgId];

  for (const [key, column] of [['phone', 'phone'], ['whatsappPhone', 'whatsapp_phone']]) {
    if (patch[key] === undefined) continue;
    const raw = patch[key];
    if (raw === null || String(raw).trim() === '') {
      sets.push(`${column} = NULL`);
      continue;
    }
    vals.push(normalisePhone(raw));
    sets.push(`${column} = $${vals.length}`);
  }
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1 AND org_id = $2
      RETURNING id, email, phone, whatsapp_phone`,
    vals);
  if (!rows.length) throw Object.assign(new Error('User not found in this org'), { status: 404 });
  return { user: rows[0] };
}

/**
 * Store E.164 — leading '+', country code included, digits only.
 *
 * WhatsApp matches an inbound sender with
 * regexp_replace(phone,'[^0-9]','','g') against Meta's full international
 * `from`, so a number saved without its country code silently never routes.
 * That failure is invisible — no error, the thread just never threads — so this
 * rejects rather than storing something that looks fine and is not.
 */
function normalisePhone(input) {
  const raw = String(input).trim();

  // A leading '+' is REQUIRED, and length alone cannot replace it. '7207583441'
  // is ten digits and would pass any plausible length check, then be stored as
  // '+7207583441' — a number whose "country code" is 72. There is no way to
  // infer the intended country from the digits, so the caller must say. The UI
  // supplies it from a country-code field; anything else is rejected rather
  // than guessed.
  if (!raw.startsWith('+')) {
    throw Object.assign(
      new Error('Include the country code, e.g. +91 7207583441. Without it WhatsApp cannot match this number.'),
      { status: 400 });
  }

  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) {   // E.164 caps at 15
    throw Object.assign(
      new Error('That does not look like a valid phone number.'),
      { status: 400 });
  }
  return `+${digits}`;
}

async function removeMember(handoverId, orgId, memberId) {
  const { rowCount } = await pool.query(
    `DELETE FROM project_members WHERE id=$1 AND org_id=$2 AND context_type='handover' AND context_id=$3`,
    [memberId, orgId, handoverId]);
  if (!rowCount) throw Object.assign(new Error('Member not found'), { status: 404 });
  return { deleted: true, id: memberId };
}

module.exports = {
  listDomains, addDomain, removeDomain,
  seatAvailable, shouldAutoApprove,
  listForHandover, requestMember, reviewMember, removeMember, changeRole,
  updateMemberContact,
  canManageProject, autoApproveDecision, selfExit,
};
