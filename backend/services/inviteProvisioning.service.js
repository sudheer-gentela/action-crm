// ─────────────────────────────────────────────────────────────────────────────
// inviteProvisioning.service.js
//
// New-user provisioning via invitations:
//   • createInvite  — seat-check, persist scope, send email (or hold for approval)
//   • approveInvite / rejectInvite — admin gate for project-context invites
//   • getByToken    — public preview for the accept page
//   • acceptInvite  — create user (password-set) → org_user → grant scoped modules
//                     → place in org_hierarchy (reports_to fallback) → add to project
//   • notifySeatExceeded — email demo@gowarmcrm.com to kick off provisioning
//
// Email goes through systemMailer (env SMTP). Seat gate: active org_users < max_users.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { sendSystemEmail } = require('./systemMailer');
const moduleAccess = require('./moduleAccess.service');

const APP_URL = process.env.APP_URL || 'https://app.gowarmcrm.com';
const SUPPORT_EMAIL = process.env.PROVISIONING_ALERT_EMAIL || 'demo@gowarmcrm.com';

async function seatAvailable(orgId) {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE) AS used,
            (SELECT max_users FROM organizations WHERE id = $1)                     AS cap`, [orgId]);
  return { used: Number(r.used), cap: Number(r.cap), available: Number(r.used) < Number(r.cap) };
}

async function notifySeatExceeded(orgId, email, context) {
  const { rows: [o] } = await pool.query(`SELECT name, max_users FROM organizations WHERE id = $1`, [orgId]);
  await sendSystemEmail({
    to: SUPPORT_EMAIL,
    subject: `[GoWarmCRM] Seat limit reached — org ${o?.name || orgId}`,
    html: `<p>An attempt to add a user exceeded the seat limit and was blocked.</p>
           <ul>
             <li>Org: <b>${o?.name || orgId}</b> (id ${orgId})</li>
             <li>Seat cap: <b>${o?.max_users}</b></li>
             <li>Attempted invitee: <b>${email || '—'}</b></li>
             <li>Context: ${context || 'manual add'}</li>
           </ul>
           <p>Please provision additional seats to continue.</p>`,
  });
}

function acceptUrl(token) { return `${APP_URL}/#/accept-invite?token=${token}`; }

async function sendInviteEmail(invite, orgName, inviterName) {
  return sendSystemEmail({
    to: invite.email,
    subject: `You've been invited to ${orgName} on GoWarmCRM`,
    html: `<p>${inviterName || 'An admin'} has invited you to join <b>${orgName}</b> on GoWarmCRM.</p>
           <p><a href="${acceptUrl(invite.token)}">Accept your invitation and set your password</a></p>
           <p>This link expires in 7 days.</p>
           ${invite.message ? `<p>Message: ${invite.message}</p>` : ''}`,
    text: `You've been invited to join ${orgName} on GoWarmCRM. Accept: ${acceptUrl(invite.token)}`,
  });
}

/**
 * Create an invitation. autoApprove=true (admin-initiated) sends the email now;
 * false (project-context, new user) holds at pending_approval for admin review.
 */
async function createInvite(orgId, invitedBy, data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!email) throw Object.assign(new Error('Email is required'), { status: 400 });

  // Already a member?
  const { rows: ex } = await pool.query(
    `SELECT 1 FROM org_users ou JOIN users u ON u.id = ou.user_id
      WHERE ou.org_id = $1 AND lower(u.email) = $2 AND ou.is_active = TRUE`, [orgId, email]);
  if (ex.length) throw Object.assign(new Error('That person is already a member of this org'), { status: 400 });

  // Seat gate.
  const seat = await seatAvailable(orgId);
  if (!seat.available) {
    await notifySeatExceeded(orgId, email, data.contextType ? `project ${data.contextId}` : 'invite');
    throw Object.assign(new Error('No seats available — GoWarmCRM support has been notified to provision more.'),
      { status: 409, code: 'NO_SEATS' });
  }

  const token   = crypto.randomBytes(32).toString('hex');
  const modules = Array.isArray(data.modules) ? data.modules.filter(k => moduleAccess.MODULE_KEYS.includes(k)) : [];
  const autoApprove = data.autoApprove !== false;   // default true (admin-initiated)
  const status  = autoApprove ? 'approved' : 'pending_approval';

  const { rows: [inv] } = await pool.query(
    `INSERT INTO org_invitations
       (org_id, email, role, token, invited_by, requested_by, message,
        modules, role_id, context_type, context_id, reports_to, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
     RETURNING *`,
    [orgId, email, data.role || 'member', token, invitedBy, data.requestedBy || invitedBy, data.message || null,
     JSON.stringify(modules), data.roleId || null, data.contextType || null, data.contextId || null,
     data.reportsTo || null, status]);

  if (status === 'approved') {
    const { rows: [o] } = await pool.query(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
    const { rows: [iu] } = await pool.query(`SELECT first_name || ' ' || last_name AS name FROM users WHERE id = $1`, [invitedBy]);
    await sendInviteEmail(inv, o?.name || 'your team', iu?.name);
  }
  return { invitation: inv, status };
}

async function approveInvite(orgId, adminId, inviteId) {
  const { rows: [inv] } = await pool.query(
    `UPDATE org_invitations SET status='approved', approved_by=$3
      WHERE id=$1 AND org_id=$2 AND status='pending_approval' RETURNING *`,
    [inviteId, orgId, adminId]);
  if (!inv) throw Object.assign(new Error('Invitation not found or not pending'), { status: 404 });
  const { rows: [o] } = await pool.query(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
  await sendInviteEmail(inv, o?.name || 'your team');
  return { invitation: inv };
}

async function rejectInvite(orgId, adminId, inviteId, reason) {
  const { rows: [inv] } = await pool.query(
    `UPDATE org_invitations SET status='rejected', approved_by=$3, message=COALESCE($4, message)
      WHERE id=$1 AND org_id=$2 AND status='pending_approval' RETURNING id`,
    [inviteId, orgId, adminId, reason || null]);
  if (!inv) throw Object.assign(new Error('Invitation not found or not pending'), { status: 404 });
  return { id: inv.id, status: 'rejected' };
}

// Public preview for the accept page.
async function getByToken(token) {
  const { rows: [inv] } = await pool.query(
    `SELECT oi.email, oi.status, oi.expires_at, o.name AS org_name
       FROM org_invitations oi JOIN organizations o ON o.id = oi.org_id
      WHERE oi.token = $1`, [token]);
  if (!inv) throw Object.assign(new Error('Invitation not found'), { status: 404 });
  if (inv.status === 'accepted') throw Object.assign(new Error('This invitation has already been used'), { status: 400 });
  if (inv.status !== 'approved')  throw Object.assign(new Error('This invitation is not active'), { status: 400 });
  if (new Date(inv.expires_at) < new Date()) throw Object.assign(new Error('This invitation has expired'), { status: 400 });
  return { email: inv.email, orgName: inv.org_name };
}

// reports_to fallback: requested (if in hierarchy) → project manager/service owner → requester.
async function resolveReportsTo(orgId, invite) {
  const inHierarchy = async (uid) => {
    if (!uid) return false;
    const { rows } = await pool.query(`SELECT 1 FROM org_hierarchy WHERE org_id=$1 AND user_id=$2`, [orgId, uid]);
    return rows.length > 0;
  };
  if (await inHierarchy(invite.reports_to)) return invite.reports_to;

  if (invite.context_type === 'handover' && invite.context_id) {
    // project manager: a project_member with PM-ish role, else the handover's service owner
    const { rows: pm } = await pool.query(
      `SELECT pm.user_id FROM project_members pm
         LEFT JOIN org_roles r ON r.id = pm.role_id
        WHERE pm.context_type='handover' AND pm.context_id=$1 AND pm.status='approved'
          AND (lower(r.key) LIKE '%project_manager%' OR lower(r.name) LIKE '%project manager%')
        LIMIT 1`, [invite.context_id]);
    if (pm[0]?.user_id && await inHierarchy(pm[0].user_id)) return pm[0].user_id;
    const { rows: so } = await pool.query(
      `SELECT assigned_service_owner_id FROM sales_handovers WHERE id=$1`, [invite.context_id]);
    if (so[0]?.assigned_service_owner_id && await inHierarchy(so[0].assigned_service_owner_id))
      return so[0].assigned_service_owner_id;
  }
  if (await inHierarchy(invite.requested_by)) return invite.requested_by;
  return null;   // top-level if nothing resolves
}

/**
 * Accept an invitation: create the user, add to org, grant scoped modules, place
 * in hierarchy, and (project-context) add to the project. Password-set flow.
 */
async function acceptInvite(token, { firstName, lastName, password }) {
  if (!password || password.length < 8)
    throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });

  const { rows: [inv] } = await pool.query(`SELECT * FROM org_invitations WHERE token = $1`, [token]);
  if (!inv) throw Object.assign(new Error('Invitation not found'), { status: 404 });
  if (inv.status === 'accepted') throw Object.assign(new Error('Already used'), { status: 400 });
  if (inv.status !== 'approved')  throw Object.assign(new Error('Invitation is not active'), { status: 400 });
  if (new Date(inv.expires_at) < new Date()) throw Object.assign(new Error('Invitation expired'), { status: 400 });

  const seat = await seatAvailable(inv.org_id);
  if (!seat.available) {
    await notifySeatExceeded(inv.org_id, inv.email, 'accept');
    throw Object.assign(new Error('No seats available — support has been notified.'), { status: 409, code: 'NO_SEATS' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reuse an existing user with this email, else create one.
    let { rows: [user] } = await client.query(`SELECT id FROM users WHERE lower(email) = $1`, [inv.email]);
    if (!user) {
      const hash = await bcrypt.hash(password, 12);
      ({ rows: [user] } = await client.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, org_id, created_at)
         VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
        [inv.email, hash, (firstName || '').trim() || inv.email.split('@')[0], (lastName || '').trim() || '', inv.org_id]));
    }

    await client.query(
      `INSERT INTO org_users (org_id, user_id, role, is_active, joined_at)
       VALUES ($1,$2,$3,TRUE, now())
       ON CONFLICT (org_id, user_id) DO UPDATE SET is_active = TRUE, role = EXCLUDED.role`,
      [inv.org_id, user.id, inv.role || 'member']);

    // Grant the SCOPED modules on the invite.
    const scope = Array.isArray(inv.modules) ? inv.modules : [];
    for (const k of scope) {
      await client.query(
        `INSERT INTO user_module_access (org_id, user_id, module_key, granted_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [inv.org_id, user.id, k, inv.approved_by || inv.invited_by]);
    }

    // Hierarchy placement (fallback chain), only if not already placed.
    const reportsTo = await resolveReportsTo(inv.org_id, inv);
    await client.query(
      `INSERT INTO org_hierarchy (org_id, user_id, reports_to, hierarchy_role, relationship_type)
       VALUES ($1,$2,$3,'rep','solid')
       ON CONFLICT DO NOTHING`, [inv.org_id, user.id, reportsTo]).catch(() => {});

    // Project add (approved, since the invite itself was admin-approved).
    if (inv.context_type === 'handover' && inv.context_id) {
      await client.query(
        `INSERT INTO project_members
           (org_id, context_type, context_id, user_id, role_id, status, requested_by, reviewed_by, reviewed_at)
         VALUES ($1,'handover',$2,$3,$4,'approved',$5,$6, now())
         ON CONFLICT (context_type, context_id, user_id) DO NOTHING`,
        [inv.org_id, inv.context_id, user.id, inv.role_id || null, inv.requested_by, inv.approved_by]);
    }

    await client.query(`UPDATE org_invitations SET accepted_at = now(), status = 'accepted' WHERE id = $1`, [inv.id]);
    await client.query('COMMIT');
    moduleAccess.invalidate(inv.org_id, user.id);
    return { userId: user.id, orgId: inv.org_id };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = {
  createInvite, approveInvite, rejectInvite, getByToken, acceptInvite,
  seatAvailable, notifySeatExceeded,
};
