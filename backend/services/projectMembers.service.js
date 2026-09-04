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
 * 2026_137 ADDS THE FOURTH ROUTE: an approved project_members row carrying
 * can_manage.
 *
 * WHY IT WAS NEEDED. The three original routes are all columns on
 * sales_handovers, so authority could only ever belong to two named people plus
 * the org's admins. A project with a delivery lead who is neither the named
 * service owner nor the person who happened to click Create had nobody on the
 * team able to approve a submission — every review had to go to an org admin
 * who was not on the project and had no basis to judge the evidence. That is
 * how a review queue stops being read.
 *
 * WHAT IT DOES NOT DO. Nothing here grants rights on any other project, or
 * anywhere in the org. can_manage is a per-row flag on a per-project table; the
 * query below is scoped by context_id, so a member with it on project 41 is an
 * ordinary member on project 42.
 *
 * ONE QUERY, NOT TWO. The EXISTS rides along with the org_users/sales_handovers
 * lookup that was already here. This function is called on the hot path — once
 * per getById, once per review transition, once per member route — and adding a
 * second round trip to it would be felt on the checklist.
 *
 * ORDER OF THE PREDICATES MATTERS FOR TRUTH, NOT SPEED. 'approved' is tested
 * because a 'pending' row is an unreviewed request to join, and honouring a
 * flag on one would let an unapproved person manage the project. exited_at is
 * tested for the reader rather than out of necessity — 2026_88's CHECK already
 * constrains a non-NULL exited_at to status IN ('declined','left'), so
 * 'approved' implies it is NULL — but someone reading this should not have to
 * know that to believe the query.
 */
async function canManageProject(handoverId, orgId, userId) {
  if (!userId) return false;
  const { rows: [r] } = await pool.query(
    `SELECT ou.role AS org_role,
            h.assigned_service_owner_id,
            h.created_by,
            EXISTS (
              SELECT 1 FROM project_members pm
               WHERE pm.context_type = 'handover'
                 AND pm.context_id   = $3
                 AND pm.org_id       = $1
                 AND pm.user_id      = $2
                 AND pm.status       = 'approved'
                 AND pm.exited_at IS NULL
                 AND pm.can_manage   = TRUE
            ) AS member_can_manage
       FROM org_users ou
       LEFT JOIN sales_handovers h ON h.id = $3 AND h.org_id = $1
      WHERE ou.org_id = $1 AND ou.user_id = $2`,
    [orgId, userId, handoverId]
  );
  if (!r) return false;
  if (['admin', 'owner'].includes(r.org_role)) return true;
  if (r.member_can_manage === true) return true;
  return r.assigned_service_owner_id === userId || r.created_by === userId;
}

/**
 * The same rule as canManageProject, expressed as SQL a caller can paste into
 * a larger query.
 *
 * WHY THIS EXISTS. playReview.myReviewQueue answers "everything awaiting MY
 * review across every project" in one query. It cannot call canManageProject
 * once per project — that is N round trips to render one screen — so it
 * re-expressed the rule inline, and the copy silently fell out of date the
 * moment can_manage was added: a member granted authority would see approve
 * buttons on the project and an empty review queue, which reads as the queue
 * being broken.
 *
 * Exporting the fragment does not make the duplication go away, but it makes it
 * a SHARED duplication — there is now one place to change, and a grep for this
 * function name finds every query that depends on the rule.
 *
 * @param {string} handoverAlias  the sales_handovers alias in the caller's FROM
 * @param {string} userParam      the caller's placeholder for the user id, e.g. '$2'
 * @param {string} orgParam       the caller's placeholder for the org id, e.g. '$1'
 * @returns {string} a boolean SQL expression — does NOT include the org-admin
 *   arm, which callers already resolve separately because it needs no join.
 */
function manageableProjectSql(handoverAlias, userParam, orgParam) {
  return `(
       ${handoverAlias}.assigned_service_owner_id = ${userParam}
    OR ${handoverAlias}.created_by = ${userParam}
    OR EXISTS (SELECT 1 FROM project_members pm
                WHERE pm.context_type = 'handover'
                  AND pm.context_id   = ${handoverAlias}.id
                  AND pm.org_id       = ${orgParam}
                  AND pm.user_id      = ${userParam}
                  AND pm.status       = 'approved'
                  AND pm.exited_at IS NULL
                  AND pm.can_manage   = TRUE)
  )`;
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
    id: row.id, userId: row.user_id, name: row.name, email: row.email || null,
    roleId: row.role_id, roleName: row.role_name, customRole: row.custom_role,
    side: row.side || 'delivery',
    phone: row.phone || null,
    whatsappPhone: row.whatsapp_phone || null,
    // 2026_137. Sent so the member row can render the badge and the toggle.
    // Without it the client had no way to show that a person holds project
    // authority, and an invisible permission is one nobody can audit.
    //
    // can_rebaseline has been on this table since 2026_129 and was never
    // returned — handover.service.canRebaseline reads it server-side, so the
    // flag worked but was unseeable and unsettable. Surfaced here for the same
    // reason: the People card is where someone goes to ask who can do what.
    canManage: row.can_manage === true,
    canRebaseline: row.can_rebaseline === true,
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

  // can_manage is deliberately NOT settable at add time, and the INSERT does
  // not name the column so it takes its DEFAULT false.
  //
  // Adding someone and granting them authority over the project are two
  // decisions, and collapsing them into one form field is how the second gets
  // made by accident while making the first. It is granted afterwards, on a row
  // that is already approved, through changeRole — which is also the only place
  // it can be audited as a deliberate act.
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
 *
 * 2026_137: authority lapses with the membership and needs no separate step.
 * canManageProject tests status = 'approved', and this writes 'declined' or
 * 'left', so the flag stops being read the moment someone steps off. It is left
 * SET on the row rather than cleared, so that re-approving a person who
 * previously ran the project restores what they had instead of silently
 * demoting them.
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
      `UPDATE project_members SET status='approved', reviewed_by=$2, reviewed_at=now(), review_reason=NULL,
              exited_at = NULL, exit_reason = NULL
        WHERE id=$1`,
      [memberId, adminId]);
    return { id: memberId, status: 'approved' };
  }
  if (action === 'reject') {
    if (!reason || !String(reason).trim())
      throw Object.assign(new Error('A rejection reason is required'), { status: 400 });
    await pool.query(
      `UPDATE project_members SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_reason=$3,
              exited_at = NULL, exit_reason = NULL
        WHERE id=$1`,
      [memberId, adminId, String(reason).trim()]);
    return { id: memberId, status: 'rejected' };
  }
  throw Object.assign(new Error("action must be 'approve' or 'reject'"), { status: 400 });
}

/**
 * Change an existing member's role, side, or project authority.
 *
 * There was no way to do this at all — the routes had add, review, remove and
 * self-exit, and the row rendered as flat text. So a member added as "Team
 * member" stayed one forever, and the open question of restoring somebody's
 * prior role after a Project Manager demotion had no mechanism behind it.
 *
 * Moving someone INTO internal_customer resets them to pending: they are being
 * made the acceptor of the work, which is an org-admin decision, not the
 * project manager's.
 *
 * ── 2026_137: can_manage ────────────────────────────────────────────────────
 *
 * Three rules, each of which closes a way the flag could otherwise be granted
 * to someone who should not hold it.
 *
 * 1. THE ROW MUST BE 'approved'. A pending row is an unreviewed request to
 *    join. Granting authority on one would mean a project manager could add a
 *    stranger and immediately make them a manager, with no approval step
 *    anywhere in the sequence — which is the exact hole the pending state
 *    exists to plug. Refused rather than silently ignored: a toggle that
 *    reports success and does nothing is worse than one that says no.
 *
 * 2. NOT ON AN internal_customer. This is the same separation of duties that
 *    already governs this table — requestMember refuses to auto-approve an
 *    internal customer even when a project manager adds them, because "naming
 *    your own acceptor is exactly the thing sign-off exists to prevent". The
 *    acceptor of the work must not also be the person who approves the tasks
 *    that make it up; that collapses the two-party check that project sign-off
 *    is FOR. If this turns out to be too strict in practice it is one clause to
 *    remove, and nothing else depends on it.
 *
 * 3. THE SIDE SWITCH CLEARS IT. Moving an existing manager into
 *    internal_customer already resets status to 'pending'. Without also
 *    clearing can_manage the flag would sit dormant on the row and come back
 *    the moment an admin approved them as the acceptor — restoring, by that
 *    unrelated click, exactly the combination rule 2 refuses to create
 *    directly. Written into the same statement so the two can never be applied
 *    apart.
 *
 * WHO CALLS THIS is enforced one layer up: the route is behind `canManage`,
 * which is org admin OR canManageProject. So a manager can hand authority
 * onward, but only to someone already an approved member of this project. The
 * chain is closed — it cannot reach anyone who is not already on the team.
 */
async function changeRole(handoverId, orgId, memberId, patch = {}) {
  const { rows: [pm] } = await pool.query(
    `SELECT id, side, status, can_manage FROM project_members
      WHERE id = $1 AND org_id = $2 AND context_type = 'handover' AND context_id = $3`,
    [memberId, orgId, handoverId]);
  if (!pm) throw Object.assign(new Error('Member not found'), { status: 404 });
  if (['declined', 'left', 'rejected'].includes(pm.status)) {
    throw Object.assign(new Error('That person is no longer on the project'), { status: 400 });
  }

  const sets = ['role_id = $3', 'custom_role = $4'];
  const vals = [memberId, orgId, patch.roleId || null, patch.customRole || null];

  // Resolved before the side clause so that a patch carrying BOTH
  // `side: 'internal_customer'` and `canManage: true` is refused rather than
  // half-applied. Reading the incoming side rather than the stored one is what
  // makes that work — pm.side is still 'delivery' at this point.
  const nextSide = patch.side !== undefined
    ? (patch.side === 'internal_customer' ? 'internal_customer' : 'delivery')
    : pm.side;

  if (patch.canManage !== undefined) {
    const grant = patch.canManage === true;
    if (grant && pm.status !== 'approved') {
      throw Object.assign(
        new Error('Approve this person onto the project before giving them project authority.'),
        { status: 400, code: 'MEMBER_NOT_APPROVED' });
    }
    if (grant && nextSide === 'internal_customer') {
      throw Object.assign(
        new Error('The internal customer accepts the work and cannot also approve the tasks that make it up.'),
        { status: 400, code: 'ACCEPTOR_CANNOT_MANAGE' });
    }
    vals.push(grant); sets.push(`can_manage = $${vals.length}`);
  }

  if (patch.side !== undefined) {
    vals.push(nextSide); sets.push(`side = $${vals.length}`);
    if (nextSide === 'internal_customer' && pm.side !== 'internal_customer') {
      sets.push(`status = 'pending'`, `reviewed_by = NULL`, `reviewed_at = NULL`);
      // Unconditional, and deliberately not merged with the patch.canManage
      // branch above: this must fire whether or not the caller mentioned the
      // flag. A manager being made the acceptor is the common case, and the
      // caller has no reason to think about can_manage while doing it.
      sets.push(`can_manage = FALSE`);
    }
  }

  const { rows } = await pool.query(
    `UPDATE project_members SET ${sets.join(', ')}
      WHERE id = $1 AND org_id = $2
      RETURNING id, role_id, custom_role, side, status, can_manage`,
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
 * Gated on canManageProject: org admin/owner, the assigned Project Manager, the
 * creator, or a member granted can_manage.
 */
/**
 * Set a project person's phone numbers, keyed on the USER rather than a
 * project_members row.
 *
 * WHY BOTH EXIST: a project has two kinds of internal people. On a project
 * derived from a deal the team comes from deal_team_members, which has no
 * project_members row at all — so the member-id version could not reach them,
 * and their numbers were uneditable. Phone is a property of the PERSON, not of
 * a particular membership, so keying on user_id is the honest shape.
 *
 * The target must be on THIS project by one route or the other. Without that
 * check, canManageProject on any project would let someone edit the contact
 * details of anyone in the org.
 */
async function updateUserContact(handoverId, orgId, actorId, targetUserId, patch = {}) {
  if (!(await canManageProject(handoverId, orgId, actorId))) {
    throw Object.assign(
      new Error('Only an org admin or the Project Manager can edit a member\'s details'),
      { status: 403 });
  }

  const { rows: [onProject] } = await pool.query(
    `SELECT 1 AS ok
       FROM sales_handovers h
      WHERE h.id = $1 AND h.org_id = $2
        AND ( EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.context_type = 'handover' AND pm.context_id = h.id
                         AND pm.org_id = h.org_id AND pm.user_id = $3)
           OR EXISTS (SELECT 1 FROM deal_team_members dtm
                       WHERE dtm.deal_id = h.deal_id AND dtm.org_id = h.org_id
                         AND dtm.user_id = $3) )`,
    [handoverId, orgId, targetUserId]
  );
  if (!onProject) {
    throw Object.assign(new Error('That person is not on this project'), { status: 404 });
  }

  return applyContactPatch(targetUserId, orgId, patch);
}

/** Shared write, so the two entry points cannot drift apart. */
async function applyContactPatch(userId, orgId, patch) {
  const sets = [];
  const vals = [userId, orgId];

  for (const [key, column] of [['phone', 'phone'], ['whatsappPhone', 'whatsapp_phone']]) {
    if (patch[key] === undefined) continue;
    const raw = patch[key];
    if (raw === null || String(raw).trim() === '') { sets.push(`${column} = NULL`); continue; }
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

  return applyContactPatch(pm.user_id, orgId, patch);
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
  updateUserContact,
  canManageProject, manageableProjectSql, autoApproveDecision, selfExit,
};
