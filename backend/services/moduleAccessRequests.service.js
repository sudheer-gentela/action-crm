// ─────────────────────────────────────────────────────────────────────────────
// moduleAccessRequests.service.js
//
// On-behalf-of module access requests. A member who HAS a module can request it
// for a COLLEAGUE who doesn't; an admin approves (grants the colleague) or rejects
// with a reason. (Self-requests make no sense — if you can reach the module you
// already have it.)
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('../config/database');
const moduleAccess = require('./moduleAccess.service');

// Colleagues the requester can request for (other active members of the org).
async function colleagues(orgId, requesterId) {
  const { rows } = await pool.query(
    `SELECT u.id, (u.first_name || ' ' || u.last_name) AS name, u.email
       FROM org_users ou JOIN users u ON u.id = ou.user_id
      WHERE ou.org_id = $1 AND ou.is_active = TRUE AND u.id <> $2
      ORDER BY u.first_name, u.last_name`, [orgId, requesterId]);
  return { colleagues: rows };
}

// Modules the requester can grant a target: modules the requester HAS (and the org
// has enabled), minus what the target already has or has pending.
async function grantableFor(orgId, requesterId, targetUserId) {
  const [enabled, mine, theirs] = await Promise.all([
    moduleAccess.orgEnabledModules(orgId),
    moduleAccess.userModules(orgId, requesterId),
    moduleAccess.userModules(orgId, targetUserId),
  ]);
  const { rows: pend } = await pool.query(
    `SELECT module_key FROM module_access_requests
      WHERE org_id = $1 AND user_id = $2 AND status = 'pending'`, [orgId, targetUserId]);
  const pending = new Set(pend.map(r => r.module_key));
  const modules = enabled.filter(k => mine.has(k) && !theirs.has(k) && !pending.has(k));
  return { modules };
}

// Modules the requester themselves have (org-enabled) — offered when inviting a
// brand-new person, since the requester vouches for a module they use.
async function myGrantableModules(orgId, requesterId) {
  const [enabled, mine] = await Promise.all([
    moduleAccess.orgEnabledModules(orgId),
    moduleAccess.userModules(orgId, requesterId),
  ]);
  return { modules: enabled.filter(k => mine.has(k)) };
}

// Request access for a person who ISN'T in the system yet: creates a pending
// (admin-approved) invitation scoped to the requested module. On approval the
// invite email goes out; on acceptance the new user is provisioned with that module.
async function requestNewUser(orgId, requesterId, data) {
  const email = String(data.email || '').trim().toLowerCase();
  const moduleKey = data.moduleKey;
  if (!email) throw Object.assign(new Error('Enter an email'), { status: 400 });
  if (!moduleAccess.MODULE_KEYS.includes(moduleKey))
    throw Object.assign(new Error('Unknown module'), { status: 400 });

  const enabled = await moduleAccess.orgEnabledModules(orgId);
  if (!enabled.includes(moduleKey))
    throw Object.assign(new Error('That module is not enabled for this org'), { status: 400 });
  const mine = await moduleAccess.userModules(orgId, requesterId);
  if (!mine.has(moduleKey))
    throw Object.assign(new Error('You can only request modules you have access to yourself'), { status: 403 });

  const invites = require('./inviteProvisioning.service');
  const out = await invites.createInvite(orgId, requesterId, {
    email, role: 'member', modules: [moduleKey],
    requestedBy: requesterId, autoApprove: false,   // admin approves before the email is sent
  });
  return { invited: true, status: out.status };      // 'pending_approval'
}

async function request(orgId, requesterId, data) {
  const targetUserId = parseInt(data.targetUserId, 10);
  const moduleKey = data.moduleKey;
  if (!targetUserId) throw Object.assign(new Error('Pick a colleague'), { status: 400 });
  if (!moduleAccess.MODULE_KEYS.includes(moduleKey))
    throw Object.assign(new Error('Unknown module'), { status: 400 });

  const enabled = await moduleAccess.orgEnabledModules(orgId);
  if (!enabled.includes(moduleKey))
    throw Object.assign(new Error('That module is not enabled for this org'), { status: 400 });

  // Requester must have the module they're vouching for.
  const mine = await moduleAccess.userModules(orgId, requesterId);
  if (!mine.has(moduleKey))
    throw Object.assign(new Error('You can only request modules you have access to yourself'), { status: 403 });

  // Target must be an active member who lacks it.
  const { rows: [member] } = await pool.query(
    `SELECT 1 FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`, [orgId, targetUserId]);
  if (!member) throw Object.assign(new Error('That colleague is not an active member of this org'), { status: 400 });
  const theirs = await moduleAccess.userModules(orgId, targetUserId);
  if (theirs.has(moduleKey))
    throw Object.assign(new Error('They already have access to that module'), { status: 400 });

  await pool.query(
    `INSERT INTO module_access_requests (org_id, user_id, requested_by, module_key, reason)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id, user_id, module_key) WHERE status = 'pending' DO NOTHING`,
    [orgId, targetUserId, requesterId, moduleKey, data.reason || null]);
  return { requested: true };
}

// Requests the caller has made for others.
async function listMine(orgId, requesterId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.module_key, r.status, r.review_reason, r.created_at,
            (u.first_name || ' ' || u.last_name) AS for_name
       FROM module_access_requests r JOIN users u ON u.id = r.user_id
      WHERE r.org_id = $1 AND r.requested_by = $2 ORDER BY r.created_at DESC`, [orgId, requesterId]);
  return { requests: rows };
}

async function listPending(orgId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.module_key, r.reason, r.created_at,
            r.user_id,           (tu.first_name || ' ' || tu.last_name) AS for_name,  tu.email AS for_email,
            r.requested_by,      (ru.first_name || ' ' || ru.last_name) AS by_name
       FROM module_access_requests r
       JOIN users tu ON tu.id = r.user_id
       LEFT JOIN users ru ON ru.id = r.requested_by
      WHERE r.org_id = $1 AND r.status = 'pending' ORDER BY r.created_at`, [orgId]);
  return { requests: rows };
}

async function review(orgId, adminId, requestId, action, reason) {
  const { rows: [req] } = await pool.query(
    `SELECT * FROM module_access_requests WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
    [requestId, orgId]);
  if (!req) throw Object.assign(new Error('Request not found or already handled'), { status: 404 });

  if (action === 'approve') {
    await moduleAccess.grant(orgId, req.user_id, [req.module_key], adminId);   // grant the colleague
    await pool.query(
      `UPDATE module_access_requests SET status='approved', reviewed_by=$2, reviewed_at=now() WHERE id=$1`,
      [requestId, adminId]);
    return { id: requestId, status: 'approved' };
  }
  if (action === 'reject') {
    if (!reason || !String(reason).trim())
      throw Object.assign(new Error('A rejection reason is required'), { status: 400 });
    await pool.query(
      `UPDATE module_access_requests SET status='rejected', review_reason=$3, reviewed_by=$2, reviewed_at=now() WHERE id=$1`,
      [requestId, adminId, String(reason).trim()]);
    return { id: requestId, status: 'rejected' };
  }
  throw Object.assign(new Error("action must be 'approve' or 'reject'"), { status: 400 });
}

module.exports = { colleagues, grantableFor, myGrantableModules, request, requestNewUser, listMine, listPending, review };
