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

// ── Auto-approve inputs ──────────────────────────────────────────────────────
async function seatAvailable(orgId) {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE) AS used,
            (SELECT max_users FROM organizations WHERE id = $1)                     AS cap`, [orgId]);
  return { used: Number(r.used), cap: Number(r.cap), available: Number(r.used) < Number(r.cap) };
}

async function shouldAutoApprove(orgId, targetUserId) {
  const { rows: [u] } = await pool.query(`SELECT email FROM users WHERE id = $1`, [targetUserId]);
  const dom = emailDomain(u?.email);
  if (!dom) return false;
  const { rows: [m] } = await pool.query(
    `SELECT 1 FROM org_email_domains WHERE org_id = $1 AND lower(domain) = $2 LIMIT 1`, [orgId, dom]);
  if (!m) return false;
  const seat = await seatAvailable(orgId);
  return seat.available;
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
  const userId = parseInt(data.userId, 10);
  if (!userId) throw Object.assign(new Error('Pick a user to add'), { status: 400 });

  // Must be an active member of this org.
  const { rows: [ok] } = await pool.query(
    `SELECT 1 FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`, [orgId, userId]);
  if (!ok) throw Object.assign(new Error('That user is not an active member of this org'), { status: 400 });

  const auto = await shouldAutoApprove(orgId, userId);
  const status = auto ? 'approved' : 'pending';

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

  return { id: pm.id, status, autoApproved: auto };
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
};
