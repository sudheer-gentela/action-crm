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

    // A newly approved vendor may already be bound to a conversation — the
    // relationship can be requested AFTER somebody bound the group, and
    // bindGroup refuses an account with no active row, so this is the moment
    // that binding's candidate set can first be derived.
    //
    // Fire-and-forget by design: the nightly reconciler is what guarantees
    // correctness, so failing an approval because a refresh hiccuped would
    // trade a real action for a set that would be right tomorrow anyway.
    require('./conversationCandidateSync.service')
      .resyncSoon(orgId, rows[0].account_id, 'relationship approved');

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
      RETURNING id, account_id`,
    [relationshipId, orgId]
  );
  if (!rows.length) throw Object.assign(new Error('Active relationship not found'), { status: 404 });

  // The candidate set is now stale in the way that matters most: it would keep
  // suggesting projects for a vendor we no longer work with. resyncForAccount
  // derives an EMPTY set for an ended relationship rather than skipping, so the
  // shortlist empties out. The binding itself survives — the group's history is
  // still organised around that vendor.
  require('./conversationCandidateSync.service')
    .resyncSoon(orgId, rows[0].account_id, 'relationship ended');

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

/**
 * The projects a vendor/partner account is ON, org-wide.
 *
 * DELIBERATELY NOT THE SAME FUNCTION as listProjectsForAccount above, and the
 * difference is the whole point of it existing:
 *
 *   listProjectsForAccount  — a READ, for a human looking at the vendor panel.
 *                             Scoped to what that viewer may see, so two people
 *                             legitimately get different counts.
 *   projectsForRelationship — a DERIVATION, for the candidate set of a bound
 *                             conversation. Org-wide, because a candidate set
 *                             is a property of the CONVERSATION, not of whoever
 *                             happened to click Bind. Scoping it to the binder
 *                             would produce a set that silently differs by who
 *                             clicked, and an attribution six months later that
 *                             cannot be explained.
 *
 * Anything that RENDERS the result must apply its own scoping. This returns
 * rows; it does not decide who may look at them.
 *
 * THREE EXCLUSIONS, each one a decision:
 *
 *   side IN ('vendor','partner')  — the same firm can be your customer on one
 *     project and your vendor on the next, with the same people. A Cloudsmith
 *     vendor group is about the projects Cloudsmith is a VENDOR on. Including
 *     the projects where they are the customer would widen the candidate set
 *     with projects the vendor group has no reason to discuss, and a wider
 *     candidate set is a worse one — narrowing is the entire mechanism.
 *
 *   the account is not the project's own customer — a project whose
 *     sales_handovers.account_id IS this account is that account's own
 *     engagement, not work they subcontract on. Excluded for the same reason.
 *
 *   status NOT IN ('draft','completed','cancelled')  — the established "active
 *     project" idiom in handover.service. A completed project should not start
 *     collecting new candidate matches; Phase 7's project-close nudge is the
 *     mechanism for what is already filed on it.
 *
 * Returns [{ handoverId, projectName, status, side }]. No relationship check
 * here — the caller validates that the account actually holds an active
 * vendor/partner row before deciding to derive anything.
 */
async function projectsForRelationship(orgId, accountId) {
  const id = parseInt(accountId, 10);
  if (!id) throw Object.assign(new Error('accountId is required'), { status: 400 });

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (h.id)
            h.id                     AS handover_id,
            COALESCE(h.name, d.name) AS project_name,
            h.status,
            pc.side
       FROM project_contacts pc
       JOIN contacts        c ON c.id = pc.contact_id AND c.org_id = pc.org_id
       JOIN sales_handovers h ON h.id = pc.context_id AND h.org_id = pc.org_id
       LEFT JOIN deals      d ON d.id = h.deal_id
      WHERE pc.org_id        = $1
        AND pc.context_type  = 'handover'
        AND c.account_id     = $2
        AND pc.side          IN ('vendor', 'partner')
        AND h.status         NOT IN ('draft', 'completed', 'cancelled')
        AND (h.account_id IS NULL OR h.account_id <> $2)
      -- DISTINCT ON collapses the several contacts one vendor has on a project
      -- into one candidate. listProjectsForAccount groups by side and can
      -- legitimately return the same project twice; a candidate set cannot.
      ORDER BY h.id, pc.side`,
    [orgId, id]
  );

  return rows.map(r => ({
    handoverId:  r.handover_id,
    projectName: r.project_name,
    status:      r.status,
    side:        r.side,
  }));
}

/**
 * The bound CONVERSATIONS for one vendor/partner account — the group chats
 * organised around this firm.
 *
 * VISIBILITY: the same rule as listProjectsForAccount, deliberately. The
 * registry is org-wide because who we buy from is not a secret, but a group's
 * SUBJECT LINE routinely names a project — "Cloudsmith <> Meridian Cutover" —
 * and leaking a project name through a group name is the same leak as leaking
 * it through the project list. So a conversation is visible when the viewer
 * can see AT LEAST ONE of that binding's candidate projects, or is a
 * participant in the group, or holds org scope.
 *
 * PARTICIPANCY IS PART OF THE RULE, not a bolt-on: someone actually in the
 * Cloudsmith group plainly knows it exists, and hiding a row from the person
 * who is sitting in the room would be theatre.
 *
 * CONSEQUENCE, matching the projects panel: two people can legitimately see
 * different conversation counts for the same vendor.
 *
 * THE UNASSIGNED COUNT is the number this whole design exists to surface — the
 * messages in this group that nobody has filed. Binding a group as a vendor
 * deliberately files nothing, and that trade is only defensible if the waiting
 * pile is visible where a person can act on it.
 *
 * The count is for the whole thread, not per viewer. Reaching the unassigned
 * pile is a steward decision taken at the filing screen, not a per-message
 * visibility one, so there is no per-viewer figure to report. What keeps that
 * honest is the row filter: the count only ever appears against a conversation
 * the viewer can already see.
 *
 * Returns one row per bound conversation, each carrying the deep links the UI
 * needs: `lastActivity` (to the message) and `resolveHref` (to the filing
 * queue, pre-filtered to this thread).
 */
async function listConversationsForAccount(orgId, userId, accountId, subordinateIds = []) {
  const id = parseInt(accountId, 10);
  if (!id) throw Object.assign(new Error('accountId is required'), { status: 400 });

  const cfg  = await projectSettings.get(orgId);
  const role = await projectSettings.resolveRole(orgId, userId);
  const seesEverything = projectSettings.canUseOrgScope(cfg, role);

  const viewerIds = cfg.team_scope_enabled
    ? [...new Set([Number(userId), ...(subordinateIds || []).map(Number)])].filter(Boolean)
    : [Number(userId)].filter(Boolean);

  // Which bindings this viewer may see at all.
  // Only bind $3 when the visibility clause actually references it. Passing an
  // unreferenced parameter makes Postgres raise 42P18 "could not determine data
  // type of parameter $3" — it cannot infer a type for a parameter that appears
  // nowhere, so an org-scope viewer would 500 on a query that is otherwise fine.
  const params = seesEverything ? [orgId, id] : [orgId, id, viewerIds];
  const visibility = seesEverything ? 'TRUE' : `(
       EXISTS (SELECT 1 FROM conversation_project_candidates cc
                 JOIN sales_handovers ch ON ch.id = cc.handover_id AND ch.org_id = cc.org_id
                WHERE cc.binding_id = b.id
                  AND (ch.assigned_service_owner_id = ANY($3::int[])
                       OR EXISTS (SELECT 1 FROM project_members pm
                                   WHERE pm.context_type = 'handover'
                                     AND pm.context_id   = ch.id
                                     AND pm.org_id       = ch.org_id
                                     AND pm.user_id      = ANY($3::int[])
                                     AND pm.status       = 'approved')))
    OR EXISTS (SELECT 1 FROM whatsapp_thread_participants wp
                WHERE wp.thread_id = t.id AND wp.org_id = t.org_id
                  AND wp.user_id = ANY($3::int[]))
  )`;

  const { rows } = await pool.query(
    `SELECT b.id                AS binding_id,
            b.thread_ref,
            b.bound_at,
            t.id                AS thread_id,
            COALESCE(t.group_subject, b.thread_ref) AS subject,
            (SELECT count(*)::int FROM conversation_project_candidates cc
              WHERE cc.binding_id = b.id)           AS candidate_count,
            (SELECT count(*)::int FROM whatsapp_messages m
              WHERE m.thread_id = t.id AND m.excluded_at IS NULL) AS message_count,
            lm.id               AS last_message_id,
            lm.sent_at          AS last_activity_at,
            lm.body             AS last_message_preview
       FROM conversation_bindings b
       JOIN whatsapp_threads t ON t.org_id = b.org_id
                              AND t.wa_group_id = b.thread_ref
                              AND t.kind = 'group'
       LEFT JOIN LATERAL (
         SELECT m.id, m.sent_at, left(m.body, 140) AS body
           FROM whatsapp_messages m
          WHERE m.thread_id = t.id AND m.excluded_at IS NULL
          ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
          LIMIT 1
       ) lm ON true
      WHERE b.org_id = $1
        AND b.binding_mode = 'account'
        AND b.bound_account_id = $2
        AND ${visibility}
      ORDER BY lm.sent_at DESC NULLS LAST`,
    params
  );

  if (!rows.length) return { conversations: [] };

  // Unassigned counts per thread.
  //
  // NOT routed through whatsappAccess.buildVisibilityClause. Its 'unassigned'
  // scope is `m.handover_id IS NULL` and nothing else — it does not filter by
  // viewer, because reaching the unassigned pile is a STEWARD decision taken at
  // the filing screen, not a per-message visibility one. Passing it through
  // here would imply a per-viewer count this product does not actually compute,
  // and it also raises 42P18: the clause never references the userId parameter,
  // so Postgres cannot infer a type for it.
  //
  // What makes this safe is the row filter above: the viewer only sees
  // conversations they hold a project role on or sit in as a participant. The
  // count belongs to a group they can already see, and whether they may act on
  // it is decided at resolveHref by the same steward rule as everywhere else.
  const threadIds = rows.map(r => r.thread_id);
  const { rows: counts } = await pool.query(
    `SELECT m.thread_id, count(*)::int AS n
       FROM whatsapp_messages m
      WHERE m.org_id = $1
        AND m.thread_id = ANY($2::int[])
        AND m.handover_id IS NULL
        AND m.excluded_at IS NULL
      GROUP BY m.thread_id`,
    [orgId, threadIds]
  );
  const unassigned = Object.fromEntries(counts.map(c => [c.thread_id, c.n]));

  return {
    conversations: rows.map(r => ({
      bindingId:      r.binding_id,
      threadId:       r.thread_id,
      threadRef:      r.thread_ref,
      subject:        r.subject,
      boundAt:        r.bound_at,
      candidateCount: r.candidate_count,
      messageCount:   r.message_count,
      lastActivity: r.last_message_id ? {
        messageId: r.last_message_id,
        at:        r.last_activity_at,
        preview:   r.last_message_preview,
        // Deep link to the message itself in the Communications view.
        href:      `#/communications?threadId=${r.thread_id}&messageId=${r.last_message_id}`,
      } : null,
      // The number, and the place to act on it. Counted through the viewer's own
      // visibility, so it is never a figure they cannot resolve.
      unassignedCount: unassigned[r.thread_id] || 0,
      resolveHref:     `#/communications?threadId=${r.thread_id}&filter=unassigned`,
    })),
  };
}

/**
 * Conversations that COULD be bound to this vendor but are not yet — what the
 * "Bind a conversation" picker on the vendor panel offers.
 *
 * TWO SOURCES, because the two thread kinds are found differently:
 *
 *   DIRECT  a 1:1 with somebody at this account. Found by contact link first
 *           (thread.contact_id → contacts.account_id), then by PHONE against
 *           that account's contacts — the fallback matters because a thread
 *           opened from an inbound message often has no contact_id at all
 *           (threadForInbound sets it only when a project lookup succeeds), and
 *           those are exactly the threads nobody has organised yet.
 *
 *   GROUP   captured session groups. There is no vendor signal on a group, so
 *           these cannot be narrowed by account — a group is offered because a
 *           human recognises the name. Only groups with a session row are
 *           listed, since only those can be bound.
 *
 * SCOPING mirrors listConversationsForAccount and, for groups, the triage rule
 * it has to agree with: a steward or org-scope viewer sees all captured groups;
 * everyone else sees only groups they were a participant in. A group SUBJECT
 * names projects, and this picker must not become the way around that.
 *
 * Already-bound conversations are excluded — they appear in the Conversations
 * panel instead, which is where changing one belongs.
 */
async function listBindableForAccount(orgId, userId, accountId, subordinateIds = []) {
  const id = parseInt(accountId, 10);
  if (!id) throw Object.assign(new Error('accountId is required'), { status: 400 });

  const cfg  = await projectSettings.get(orgId);
  const role = await projectSettings.resolveRole(orgId, userId);
  const orgScope = projectSettings.canUseOrgScope(cfg, role);

  const access = require('./whatsappAccess.service');
  const { steward } = await access.isSteward(orgId, userId);
  const seesAllGroups = orgScope || steward;

  const viewerIds = cfg.team_scope_enabled
    ? [...new Set([Number(userId), ...(subordinateIds || []).map(Number)])].filter(Boolean)
    : [Number(userId)].filter(Boolean);

  // ── direct threads with this account's people ──────────────────────────
  const { rows: direct } = await pool.query(
    `SELECT t.id            AS thread_id,
            t.wa_phone,
            t.handover_id,
            COALESCE(h.name, d.name)                     AS current_project,
            COALESCE(c.first_name || ' ' || c.last_name,
                     pc.first_name || ' ' || pc.last_name) AS person,
            (SELECT count(*)::int FROM whatsapp_messages m
              WHERE m.thread_id = t.id AND m.excluded_at IS NULL) AS message_count
       FROM whatsapp_threads t
       LEFT JOIN contacts c  ON c.id = t.contact_id AND c.org_id = t.org_id
       LEFT JOIN sales_handovers h ON h.id = t.handover_id
       LEFT JOIN deals d     ON d.id = h.deal_id
       -- Phone fallback: catches inbound-opened threads that were never linked
       -- to a contact record. Digits only, because stored numbers carry every
       -- punctuation style a human can invent.
       LEFT JOIN LATERAL (
         SELECT c2.first_name, c2.last_name
           FROM contacts c2
          WHERE c2.org_id = t.org_id AND c2.account_id = $2
            AND regexp_replace(COALESCE(c2.phone, ''), '[^0-9]', '', 'g') =
                regexp_replace(COALESCE(t.wa_phone, ''), '[^0-9]', '', 'g')
            AND COALESCE(c2.phone, '') <> ''
          LIMIT 1
       ) pc ON true
      WHERE t.org_id = $1
        AND t.kind = 'direct'
        AND (c.account_id = $2 OR pc.first_name IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_bindings b
           WHERE b.org_id = t.org_id AND b.channel = 'whatsapp'
             AND b.thread_ref = t.wa_phone)
      ORDER BY message_count DESC
      LIMIT 50`,
    [orgId, id]
  );

  // ── captured groups with no binding yet ────────────────────────────────
  const groupParams = seesAllGroups ? [orgId] : [orgId, viewerIds];
  const groupVisibility = seesAllGroups ? 'TRUE' : `EXISTS (
      SELECT 1 FROM whatsapp_thread_participants wp
       WHERE wp.thread_id = g.thread_id AND wp.org_id = g.org_id
         AND wp.user_id = ANY($2::int[]))`;

  const { rows: groups } = await pool.query(
    `SELECT g.id            AS group_id,
            g.thread_id,
            g.subject,
            g.message_count,
            t.handover_id,
            COALESCE(h.name, d.name) AS current_project
       FROM whatsapp_session_groups g
       JOIN whatsapp_threads t ON t.id = g.thread_id
       LEFT JOIN sales_handovers h ON h.id = t.handover_id
       LEFT JOIN deals d ON d.id = h.deal_id
      WHERE g.org_id = $1
        AND g.binding_status <> 'ignored'
        AND NOT EXISTS (
          SELECT 1 FROM conversation_bindings b
           WHERE b.org_id = g.org_id AND b.channel = 'whatsapp'
             AND b.thread_ref = t.wa_group_id)
        AND ${groupVisibility}
      ORDER BY g.last_message_at DESC NULLS LAST
      LIMIT 50`,
    groupParams
  );

  return {
    direct: direct.map(r => ({
      threadId:       r.thread_id,
      kind:           'direct',
      label:          r.person || r.wa_phone,
      phone:          r.wa_phone,
      messageCount:   r.message_count,
      currentProject: r.current_project || null,
      // Every bind that would clear an existing project link needs confirming.
      needsForce:     r.handover_id != null,
    })),
    groups: groups.map(r => ({
      threadId:       r.thread_id,
      groupId:        r.group_id,
      kind:           'group',
      label:          r.subject || `Group ${r.group_id}`,
      messageCount:   r.message_count,
      currentProject: r.current_project || null,
      needsForce:     r.handover_id != null,
    })),
    // Groups cannot be narrowed by account — there is no vendor signal on a
    // group — so the UI has to explain why the list is not pre-filtered.
    groupsScoped: !seesAllGroups,
  };
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
  listAccounts, listForAccount, listProjectsForAccount, projectsForRelationship, listConversationsForAccount, listBindableForAccount,
  request, review, end, listPending,
};
