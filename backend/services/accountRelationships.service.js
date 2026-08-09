// ─────────────────────────────────────────────────────────────────────────────
// accountRelationships.service.js
//
// What an org IS to us — vendor, partner, reseller — as opposed to where it
// sits in the sales lifecycle, which is accounts.account_type and is left
// alone.
//
// Multi-valued on purpose. A Salesforce SI is very commonly both a customer and
// a partner, and an SI you subcontract to on one project is your customer on
// another. Folding 'vendor' into account_type would make that unrepresentable
// and would silently stop the churn play for an account that genuinely is a
// customer.
//
// APPROVAL is once, org-wide, per relationship — not per project. Approving
// "Cloudsmith is a vendor to us" every time someone adds them to an engagement
// would be noise. Approvers are NAMED USERS rather than a team, because
// org_users.role has no finance value and deriving it from teams would make the
// approver list a side effect of the org chart.
// ─────────────────────────────────────────────────────────────────────────────

const { pool }       = require('../config/database');
const projectSettings = require('./projectSettings.service');

const KINDS = ['vendor', 'partner', 'reseller'];

const APPROVAL_DEFAULTS = {
  // Admins can always approve, so an org that never configures this is not
  // stuck with a queue nobody can clear.
  admins: true,
  named_users: [],
};

function assertKind(relationship) {
  if (!KINDS.includes(relationship)) {
    throw Object.assign(new Error(`relationship must be one of: ${KINDS.join(', ')}`), { status: 400 });
  }
}

// ── Approver configuration ───────────────────────────────────────────────────

async function getApprovalPolicy(orgId) {
  const { rows } = await pool.query(
    `SELECT settings->'vendor_approval' AS cfg FROM organizations WHERE id = $1`, [orgId]);
  const s = rows[0]?.cfg && typeof rows[0].cfg === 'object' ? rows[0].cfg : {};
  return {
    ...APPROVAL_DEFAULTS,
    ...s,
    named_users: Array.isArray(s.named_users) ? s.named_users.map(Number).filter(Boolean) : [],
  };
}

async function setApprovalPolicy(orgId, patch = {}) {
  const next = await getApprovalPolicy(orgId);
  if (patch.admins !== undefined) next.admins = !!patch.admins;
  if (patch.named_users !== undefined) {
    if (!Array.isArray(patch.named_users)) {
      throw Object.assign(new Error('named_users must be an array of user ids'), { status: 400 });
    }
    next.named_users = [...new Set(patch.named_users.map(Number).filter(Boolean))];
  }
  if (!next.admins && !next.named_users.length) {
    throw Object.assign(
      new Error('Name at least one approver, or leave admins enabled — otherwise nothing can ever be approved.'),
      { status: 400 }
    );
  }
  await pool.query(
    `UPDATE organizations
        SET settings = jsonb_set(COALESCE(settings, '{}'), '{vendor_approval}', $1::jsonb, true)
      WHERE id = $2`,
    [JSON.stringify(next), orgId]
  );
  return next;
}

async function canApprove(orgId, userId) {
  if (!userId) return false;
  const policy = await getApprovalPolicy(orgId);
  if (policy.named_users.includes(Number(userId))) return true;
  if (!policy.admins) return false;
  const { rows } = await pool.query(
    `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  return ['owner', 'admin'].includes(rows[0]?.role);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Vendors (or partners) as ACCOUNTS. The screen is the account shape because
 * these are accounts — one join, no parallel entity.
 */
async function listAccounts(orgId, relationship, { status = 'active' } = {}) {
  assertKind(relationship);
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.domain, a.industry, a.size, a.location, a.owner_id, a.account_type,
            r.id AS relationship_id, r.status, r.approved_at, r.notes, r.created_at,
            (au.first_name || ' ' || au.last_name) AS approved_by_name,
            (cu.first_name || ' ' || cu.last_name) AS created_by_name
       FROM account_relationships r
       JOIN accounts a ON a.id = r.account_id AND a.deleted_at IS NULL
       LEFT JOIN users au ON au.id = r.approved_by
       LEFT JOIN users cu ON cu.id = r.created_by
      WHERE r.org_id = $1 AND r.relationship = $2
        AND ($3::text = 'all' OR r.status = $3)
      ORDER BY a.name`,
    [orgId, relationship, status]
  );
  return { accounts: rows };
}

/** Every relationship held by one account — for the account detail screen. */
async function listForAccount(orgId, accountId) {
  const { rows } = await pool.query(
    `SELECT id, relationship, status, approved_at, approved_by, ended_at, notes, created_at
       FROM account_relationships
      WHERE org_id = $1 AND account_id = $2
      ORDER BY relationship`,
    [orgId, accountId]
  );
  return { relationships: rows };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Ask for an account to be recognised as a vendor/partner/reseller.
 *
 * An approver raising it approves it in the same step — approval exists to stop
 * arbitrary people committing the org to a supplier, which does not describe
 * someone who already holds that authority. Same reasoning as
 * projectMembers.requestMember.
 */
async function request(orgId, userId, { accountId, relationship, notes }) {
  assertKind(relationship);
  const id = parseInt(accountId, 10);
  if (!id) throw Object.assign(new Error('Pick an account'), { status: 400 });

  const { rows: [acct] } = await pool.query(
    `SELECT id, name FROM accounts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId]);
  if (!acct) throw Object.assign(new Error('Account not found'), { status: 404 });

  const auto = await canApprove(orgId, userId);

  const { rows } = await pool.query(
    `INSERT INTO account_relationships
       (org_id, account_id, relationship, status, approved_by, approved_at, notes, created_by)
     VALUES ($1,$2,$3,$4,
             -- Explicit casts: inside a CASE compared against a text parameter,
             -- Postgres infers $5 as text and the insert fails on the integer
             -- column.
             CASE WHEN $4 = 'active' THEN $5::int ELSE NULL END,
             CASE WHEN $4 = 'active' THEN now() ELSE NULL END,
             $6,$5::int)
     ON CONFLICT (org_id, account_id, relationship)
       DO UPDATE SET
         notes  = COALESCE(EXCLUDED.notes, account_relationships.notes),
         -- Re-requesting something previously ended reopens it; an already
         -- active relationship is left exactly as it is.
         status = CASE WHEN account_relationships.status = 'active' THEN 'active'
                       ELSE EXCLUDED.status END,
         ended_at = NULL
     RETURNING id, status`,
    [orgId, id, relationship, auto ? 'active' : 'pending', userId, notes || null]
  );

  return {
    id: rows[0].id,
    status: rows[0].status,
    autoApproved: auto,
    accountName: acct.name,
  };
}

async function review(orgId, approverId, relationshipId, action, reason) {
  if (!(await canApprove(orgId, approverId))) {
    throw Object.assign(new Error('You are not set up to approve vendor relationships'), { status: 403 });
  }
  if (!['approve', 'reject'].includes(action)) {
    throw Object.assign(new Error("action must be 'approve' or 'reject'"), { status: 400 });
  }

  if (action === 'approve') {
    const { rows } = await pool.query(
      `UPDATE account_relationships
          SET status = 'active', approved_by = $3, approved_at = now(), ended_at = NULL
        WHERE id = $1 AND org_id = $2 AND status = 'pending'
        RETURNING id, account_id, relationship`,
      [relationshipId, orgId, approverId]
    );
    if (!rows.length) throw Object.assign(new Error('Request not found or already decided'), { status: 404 });
    return { id: rows[0].id, status: 'active' };
  }

  if (!reason || !String(reason).trim()) {
    throw Object.assign(new Error('A rejection reason is required'), { status: 400 });
  }
  const { rows } = await pool.query(
    `UPDATE account_relationships
        SET status = 'rejected', approved_by = $3, approved_at = now(),
            notes = COALESCE(notes || E'\\n', '') || $4
      WHERE id = $1 AND org_id = $2 AND status = 'pending'
      RETURNING id`,
    [relationshipId, orgId, approverId, `Rejected: ${String(reason).trim()}`]
  );
  if (!rows.length) throw Object.assign(new Error('Request not found or already decided'), { status: 404 });
  return { id: rows[0].id, status: 'rejected' };
}

/**
 * End a relationship. Kept as a row with ended_at rather than deleted — "we
 * stopped using Cloudsmith as a vendor in August" is a fact anyone reviewing a
 * past project needs, and the project_contacts rows referencing them remain
 * readable.
 */
async function end(orgId, userId, relationshipId) {
  if (!(await canApprove(orgId, userId))) {
    throw Object.assign(new Error('You are not set up to change vendor relationships'), { status: 403 });
  }
  const { rows } = await pool.query(
    `UPDATE account_relationships
        SET status = 'ended', ended_at = now()
      WHERE id = $1 AND org_id = $2 AND status = 'active'
      RETURNING id`,
    [relationshipId, orgId]
  );
  if (!rows.length) throw Object.assign(new Error('Active relationship not found'), { status: 404 });
  return { id: rows[0].id, status: 'ended' };
}

/**
 * The projects one vendor/partner account is involved in, with the SIDE they
 * hold on each and the people who carry it.
 *
 * Deliberately NOT filtered by relationship kind. `side` is per project — the
 * same firm is commonly a vendor on one engagement and a partner on the next,
 * and the SI you subcontract to is often your customer elsewhere. Filtering to
 * the tab you happened to be on would hide the one fact this panel exists to
 * show.
 *
 * VISIBILITY IS SCOPED, matching the project list rather than the registry.
 * The registry itself is org-wide and readable by anyone with the module — who
 * we buy from is not a secret. Which engagements exist and who staffs them is,
 * so this read mirrors handover.service's rule exactly: own the project, or
 * hold an APPROVED membership on it. 'pending' never counts, or requesting
 * access would grant it. Org-scope rights (admins, per org config) lift the
 * restriction; team scope widens it to subordinates when the org enables it.
 *
 * Consequence worth knowing: two people can see different project counts for
 * the same vendor. That is the intended trade — the alternative leaks project
 * names to people deliberately left off them.
 */
async function listProjectsForAccount(orgId, userId, accountId, subordinateIds = []) {
  const id = parseInt(accountId, 10);
  if (!id) throw Object.assign(new Error('accountId is required'), { status: 400 });

  const cfg  = await projectSettings.get(orgId);
  const role = await projectSettings.resolveRole(orgId, userId);
  const seesEverything = projectSettings.canUseOrgScope(cfg, role);

  const params = [orgId, id];
  let visibility = 'TRUE';

  if (!seesEverything) {
    const ids = cfg.team_scope_enabled
      ? [...new Set([Number(userId), ...(subordinateIds || []).map(Number)])].filter(Boolean)
      : [Number(userId)].filter(Boolean);
    params.push(ids);
    const p = `$${params.length}::int[]`;
    visibility = `(
         h.assigned_service_owner_id = ANY(${p})
      OR EXISTS (SELECT 1 FROM project_members pm
                  WHERE pm.context_type = 'handover'
                    AND pm.context_id   = h.id
                    AND pm.org_id       = h.org_id
                    AND pm.user_id      = ANY(${p})
                    AND pm.status       = 'approved')
    )`;
  }

  const { rows } = await pool.query(
    `SELECT h.id                       AS project_id,
            COALESCE(h.name, d.name)   AS project_name,
            h.status,
            pc.side,
            json_agg(
              json_build_object(
                'contactId', c.id,
                'name',      c.first_name || ' ' || c.last_name,
                'role',      COALESCE(cr.name, pc.role),
                'isPrimary', pc.is_primary
              ) ORDER BY pc.is_primary DESC, c.first_name
            ) AS people
       FROM project_contacts pc
       JOIN contacts c          ON c.id = pc.contact_id AND c.org_id = pc.org_id
       JOIN sales_handovers h   ON h.id = pc.context_id AND h.org_id = pc.org_id
       LEFT JOIN deals d        ON d.id = h.deal_id
       -- Role labels are per-side and per-org (contact_roles). Falling back to
       -- the raw key keeps a project readable if a label was retired.
       LEFT JOIN contact_roles cr ON cr.org_id = pc.org_id
                                 AND cr.side   = pc.side
                                 AND cr.key    = pc.role
      WHERE pc.org_id = $1
        AND pc.context_type = 'handover'
        AND c.account_id = $2
        AND ${visibility}
      GROUP BY h.id, h.name, d.name, h.status, pc.side
      ORDER BY project_name`,
    params
  );

  return { projects: rows, scoped: !seesEverything };
}

/** Pending items, for the shared approvals queue. */
async function listPending(orgId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.relationship, r.created_at, a.name AS account_name,
            (cu.first_name || ' ' || cu.last_name) AS by_name
       FROM account_relationships r
       JOIN accounts a ON a.id = r.account_id
       LEFT JOIN users cu ON cu.id = r.created_by
      WHERE r.org_id = $1 AND r.status = 'pending'`,
    [orgId]
  );
  return rows;
}

module.exports = {
  KINDS, APPROVAL_DEFAULTS,
  getApprovalPolicy, setApprovalPolicy, canApprove,
  listAccounts, listForAccount, listProjectsForAccount,
  request, review, end, listPending,
};
