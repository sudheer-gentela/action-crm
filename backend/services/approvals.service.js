// ─────────────────────────────────────────────────────────────────────────────
// approvals.service.js
//
// One queue for the admin to close out. Aggregates every pending item that needs
// admin approval — module grants, scoped/new-user invites, and project-member
// requests — into a single normalized list, and dispatches approve/reject to the
// right underlying service.
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('../config/database');
const moduleAccessRequests = require('./moduleAccessRequests.service');
const inviteProvisioning   = require('./inviteProvisioning.service');
const projectMembers       = require('./projectMembers.service');
const accountRelationships = require('./accountRelationships.service');

const LABELS = { prospecting: 'Prospecting', contracts: 'Contracts', handovers: 'Handovers', service: 'Service', agency: 'Agency' };

async function listPending(orgId) {
  const [grants, invites, members, relationships] = await Promise.all([
    pool.query(
      `SELECT r.id, r.module_key, r.created_at,
              (tu.first_name || ' ' || tu.last_name) AS for_name, tu.email AS for_email,
              (ru.first_name || ' ' || ru.last_name) AS by_name
         FROM module_access_requests r
         JOIN users tu ON tu.id = r.user_id
         LEFT JOIN users ru ON ru.id = r.requested_by
        WHERE r.org_id = $1 AND r.status = 'pending'`, [orgId]),
    pool.query(
      `SELECT i.id, i.email, i.modules, i.context_type, i.created_at,
              (ru.first_name || ' ' || ru.last_name) AS by_name
         FROM org_invitations i
         LEFT JOIN users ru ON ru.id = i.requested_by
        WHERE i.org_id = $1 AND i.status = 'pending_approval'`, [orgId]),
    pool.query(
      `SELECT pm.id, pm.context_id, pm.created_at,
              (u.first_name || ' ' || u.last_name) AS for_name,
              r.name AS role_name,
              (ru.first_name || ' ' || ru.last_name) AS by_name,
              d.name AS project_name
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         LEFT JOIN org_roles r ON r.id = pm.role_id
         LEFT JOIN users ru ON ru.id = pm.requested_by
         LEFT JOIN sales_handovers h ON h.id = pm.context_id
         LEFT JOIN deals d ON d.id = h.deal_id
        WHERE pm.org_id = $1 AND pm.status = 'pending' AND pm.context_type = 'handover'`, [orgId]),
    accountRelationships.listPending(orgId),
  ]);

  const items = [];

  for (const r of grants.rows) items.push({
    type: 'module_grant', id: r.id, createdAt: r.created_at,
    title: `${r.for_name || r.for_email} needs ${LABELS[r.module_key] || r.module_key}`,
    sub: r.by_name ? `Module access · requested by ${r.by_name}` : 'Module access',
  });

  for (const i of invites.rows) {
    const mods = (Array.isArray(i.modules) ? i.modules : []).map(k => LABELS[k] || k).join(', ');
    items.push({
      type: 'invite', id: i.id, createdAt: i.created_at,
      title: `Invite ${i.email}`,
      sub: `New user${mods ? ` · ${mods}` : ''}${i.context_type === 'handover' ? ' · project' : ''}${i.by_name ? ` · by ${i.by_name}` : ''}`,
    });
  }

  for (const m of members.rows) items.push({
    type: 'project_member', id: m.id, contextId: m.context_id, createdAt: m.created_at,
    title: `${m.for_name} → ${m.project_name || 'project'}`,
    sub: `Project team${m.role_name ? ` · ${m.role_name}` : ''}${m.by_name ? ` · by ${m.by_name}` : ''}`,
  });

  // Vendor and partner relationships are approved ONCE, org-wide, by a named
  // approver — not per project. They land in the same queue so an admin has one
  // place to clear, but review() dispatches them to their own service, which
  // enforces the approver policy rather than plain org-admin.
  for (const r of relationships) items.push({
    type: 'account_relationship', id: r.id, createdAt: r.created_at,
    title: `${r.account_name} as ${r.relationship}`,
    sub: `Relationship${r.by_name ? ` · requested by ${r.by_name}` : ''}`,
  });

  items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { approvals: items, count: items.length };
}

async function review(orgId, adminId, { type, id, contextId, action, reason }) {
  id = parseInt(id, 10);
  if (type === 'module_grant') return moduleAccessRequests.review(orgId, adminId, id, action, reason);
  if (type === 'invite') {
    return action === 'approve'
      ? inviteProvisioning.approveInvite(orgId, adminId, id)
      : inviteProvisioning.rejectInvite(orgId, adminId, id, reason);
  }
  if (type === 'project_member') return projectMembers.reviewMember(parseInt(contextId, 10), orgId, adminId, id, action, reason);
  if (type === 'account_relationship') return accountRelationships.review(orgId, adminId, id, action, reason);
  throw Object.assign(new Error('Unknown approval type'), { status: 400 });
}

module.exports = { listPending, review };
