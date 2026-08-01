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
    status: row.status, reviewReason: row.review_reason,
    requestedBy: row.requested_by, requestedByName: row.requested_by_name,
    createdAt: row.created_at,
  };
}

async function listForHandover(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT pm.*, (u.first_name || ' ' || u.last_name) AS name, u.email,
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

  const decision = await autoApproveDecision(orgId, userId);
  // A project owner or org admin adding someone to their own project is not
  // making a request — they are staffing it. Approval exists to stop arbitrary
  // people granting access, which does not describe this caller.
  const byManager = await canManageProject(handoverId, orgId, requesterId);
  const auto      = decision.auto || byManager;
  const status    = auto ? 'approved' : 'pending';

  const { rows: [pm] } = await pool.query(
    `INSERT INTO project_members
       (org_id, context_type, context_id, user_id, role_id, custom_role, status,
        requested_by, reviewed_by, reviewed_at)
     VALUES ($1,'handover',$2,$3,$4,$5,$6,$7,
             CASE WHEN $6 = 'approved' THEN $7 ELSE NULL END,
             CASE WHEN $6 = 'approved' THEN now() ELSE NULL END)
     ON CONFLICT (context_type, context_id, user_id)
       DO UPDATE SET role_id = EXCLUDED.role_id, custom_role = EXCLUDED.custom_role
     RETURNING id`,
    [orgId, handoverId, userId, data.roleId || null, data.customRole || null, status, requesterId]);

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
  listForHandover, requestMember, reviewMember, removeMember,
  canManageProject, autoApproveDecision, selfExit,
};
