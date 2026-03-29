// supportService.js
// Service / Customer Support module — core data access + business logic.
//
// Responsibilities:
//   - TRANSITIONS map + assertTransition() — same pattern as contractService.js
//   - SLA stamping: stampSLADueDates(), evaluateBreaches()
//   - Case number generation: nextCaseNumber()
//   - Playbook play firing: firePlaybookPlays(), getCaseContext()
//   - Full CRUD: listCases, getCase, createCase, updateCase
//   - Notes: addNote()
//   - Dashboard: getDashboard()
//   - Module: enableModule() — seeds SLA defaults on first enable
//   - SLA tier CRUD: listSlaTiers, createSlaTier, updateSlaTier
//   - Teams helpers: getSupportTeams(), getTeamMembers()
//   - Nightly sweep: runNightlySweep() — Phase 2 addition
//       Runs CasesRulesEngine diagnostic rules for every non-terminal case
//       in the org. Upserts alerts via ActionPersister, resolves stale ones.

const { pool, withOrgTransaction } = require('../config/database');
const PlaybookService = require('./playbook.service');
const { resolveChannel } = require('./playbook.service');
const { resolveForPlay } = require('./PlayRouteResolver');
const ActionPersister  = require('./ActionPersister');
const CasesRulesEngine = require('./CasesRulesEngine');

// ─────────────────────────────────────────────────────────────────────────────
// Status transition map
// Enforced in updateCase() — same pattern as contractService TRANSITIONS.
//
//   open → in_progress → pending_customer → resolved → closed
//   resolved → in_progress  (re-open)
//   closed is terminal
// ─────────────────────────────────────────────────────────────────────────────
const TRANSITIONS = {
  open:             ['in_progress'],
  in_progress:      ['pending_customer', 'resolved'],
  pending_customer: ['in_progress', 'resolved'],
  resolved:         ['closed', 'in_progress'],
  closed:           [],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    const err = new Error(`Cannot transition from '${from}' to '${to}'`);
    err.status = 400;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Case number generator
// Format: CASE-0001, CASE-0042 etc. — sequential per org.
// Uses a FOR UPDATE lock on the max row to avoid race conditions.
// ─────────────────────────────────────────────────────────────────────────────
async function nextCaseNumber(client, orgId) {
  const r = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(case_number FROM 6) AS INTEGER)), 0) + 1 AS next
     FROM cases
     WHERE org_id = $1
       AND case_number ~ '^CASE-[0-9]+$'
     FOR UPDATE`,
    [orgId]
  );
  const n = r.rows[0].next;
  return `CASE-${String(n).padStart(4, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLA helpers
// ─────────────────────────────────────────────────────────────────────────────

// Stamp response_due_at and resolution_due_at on a newly created case.
// Called inside createCase() transaction after the case row is inserted.
async function stampSLADueDates(client, caseId, slaTierId, createdAt) {
  if (!slaTierId) return;
  const tier = await client.query(
    `SELECT response_target_hours, resolution_target_hours
     FROM sla_tiers WHERE id = $1`,
    [slaTierId]
  );
  if (!tier.rows.length) return;
  const { response_target_hours, resolution_target_hours } = tier.rows[0];
  await client.query(
    `UPDATE cases SET
       response_due_at   = $1::timestamptz + ($2 * interval '1 hour'),
       resolution_due_at = $1::timestamptz + ($3 * interval '1 hour')
     WHERE id = $4`,
    [createdAt, response_target_hours, resolution_target_hours, caseId]
  );
}

// Evaluate and set breach flags. Called on every status change and note add.
// Returns { responseBreached, resolutionBreached }.
async function evaluateBreaches(client, caseId) {
  const r = await client.query(
    `SELECT response_due_at, resolution_due_at,
            first_responded_at, resolved_at, closed_at,
            response_breached, resolution_breached
     FROM cases WHERE id = $1`,
    [caseId]
  );
  if (!r.rows.length) return {};
  const c = r.rows[0];
  const now = new Date();

  const responseBreached =
    c.response_due_at &&
    !c.first_responded_at &&
    now > new Date(c.response_due_at);

  const resolutionBreached =
    c.resolution_due_at &&
    !c.resolved_at &&
    !c.closed_at &&
    now > new Date(c.resolution_due_at);

  // Only update if flags have changed — avoid unnecessary writes
  if (
    responseBreached   !== c.response_breached ||
    resolutionBreached !== c.resolution_breached
  ) {
    await client.query(
      `UPDATE cases SET response_breached = $1, resolution_breached = $2 WHERE id = $3`,
      [responseBreached, resolutionBreached, caseId]
    );
  }

  return { responseBreached, resolutionBreached };
}

// ─────────────────────────────────────────────────────────────────────────────
// Playbook play firing (B3 trigger)
// Called: on case creation (stageKey = 'open')
//         on every status change (stageKey = new status)
//
// Mirrors how deal-plays.routes.js fires plays on stage entry.
// Uses PlaybookService.getPlaysForStage() — works unchanged since
// stage_key is just a string; 'open' works the same as 'proposal'.
// ─────────────────────────────────────────────────────────────────────────────
async function firePlaybookPlays(orgId, caseId, stageKey) {
  try {
    // Get the active service playbook for this org
    const pbResult = await pool.query(
      `SELECT id FROM playbooks
       WHERE org_id = $1 AND type = 'service' AND is_active = TRUE
       ORDER BY is_default DESC, id ASC LIMIT 1`,
      [orgId]
    );
    if (!pbResult.rows.length) return; // no service playbook configured — silent exit

    const playbookId = pbResult.rows[0].id;
    const plays = await PlaybookService.getPlaysForStage(orgId, playbookId, stageKey);
    if (!plays.length) return;

    // Build case context for condition evaluation
    const context = await getCaseContext(caseId);

    // Load the case row once for assignment resolution
    const caseRow = await pool.query(
      `SELECT id, assigned_to, org_id FROM cases WHERE id = $1`,
      [caseId]
    );
    const caseEntity = caseRow.rows[0] || null;

    for (const play of plays) {
      // Evaluate fire_conditions — same evaluator used for deal plays
      const shouldFire = PlaybookService.evaluateConditions(play.fire_conditions, context);
      if (!shouldFire) continue;

      // Determine due_at from play.due_offset_days
      const dueAt = play.due_offset_days
        ? new Date(Date.now() + play.due_offset_days * 24 * 60 * 60 * 1000)
        : null;

      // Resolve assigned_role_id from play roles (first primary role)
      const primaryRole = play.roles?.find(r => r.ownership_type === 'primary') || play.roles?.[0];
      const assignedRoleId = primaryRole?.role_id || null;

      // Insert case_play — ON CONFLICT DO NOTHING preserves idempotency
      await pool.query(
        `INSERT INTO case_plays
           (org_id, case_id, play_id, status, assigned_role_id, due_at)
         VALUES ($1, $2, $3, 'pending', $4, $5)
         ON CONFLICT (case_id, play_id) DO NOTHING`,
        [orgId, caseId, play.id, assignedRoleId, dueAt]
      );

      // Resolve assignee user via PlayRouteResolver
      const assigneeIds = await resolveForPlay({
        orgId,
        roleKey:      primaryRole?.role_key || null,
        roleId:       primaryRole?.role_id  || null,
        entity:       caseEntity,
        entityType:   'case',
        callerUserId: caseEntity?.assigned_to || null,
      });

      // Insert into actions table (Phase 2 — cases now write actions too)
      for (const assigneeUserId of assigneeIds) {
        if (!assigneeUserId) continue;
        const { action_type, next_step, is_internal } = resolveChannel(play.channel);
        try {
          await pool.query(
            `INSERT INTO actions (
               org_id, user_id, case_id,
               title, description,
               type, action_type, priority,
               next_step, is_internal,
               source, source_rule,
               due_date, status, created_at
             ) VALUES (
               $1, $2, $3,
               $4, $5,
               $6, $6, $7,
               $8, $9,
               'playbook', 'playbook_play',
               $10, 'yet_to_start', NOW()
             )
             ON CONFLICT DO NOTHING`,
            [
              orgId, assigneeUserId, caseId,
              play.title, play.description || null,
              action_type, play.priority || 'medium',
              next_step, is_internal,
              dueAt,
            ]
          );
        } catch (actErr) {
          console.error(`supportService: actions INSERT failed for play ${play.id}:`, actErr.message);
        }
      }
    }
  } catch (err) {
    // Non-fatal — play firing failure should not block case operations
    console.error('supportService.firePlaybookPlays error:', err.message);
  }
}

// Build context object for PlaybookService.evaluateConditions().
// Shaped to match what the evaluator expects from DealContextBuilder,
// mapped to case semantics.
async function getCaseContext(caseId) {
  const r = await pool.query(
    `SELECT c.*,
            a.name AS account_name,
            EXTRACT(EPOCH FROM (NOW() - c.updated_at)) / 86400 AS days_in_status
     FROM cases c
     LEFT JOIN accounts a ON a.id = c.account_id
     WHERE c.id = $1`,
    [caseId]
  );
  if (!r.rows.length) return {};
  const c = r.rows[0];

  return {
    // Map case to 'deal' slot — condition evaluator reads deal.*
    deal: {
      id:              c.id,
      stage:           c.status,
      stage_changed_at: c.updated_at,
      account_id:      c.account_id,
    },
    derived: {
      daysInStage:    Math.floor(c.days_in_status || 0),
      daysUntilClose: null,             // not applicable for cases
      completedMeetings: [],
      upcomingMeetings:  [],
    },
    contacts:       [],
    emails:         [],
    files:          [],
    healthBreakdown: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Teams helpers
// Mirrors contractService getLegalFunctionTeamIds() pattern.
// Looks for teams with dimension='function' for assignment pickers.
// ─────────────────────────────────────────────────────────────────────────────
async function getSupportTeams(orgId) {
  const r = await pool.query(
    `SELECT id, name, description, settings
     FROM teams
     WHERE org_id = $1 AND is_active = TRUE
     ORDER BY name ASC`,
    [orgId]
  );
  return r.rows;
}

async function getTeamMembers(orgId, teamId) {
  const r = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.email,
            tm.role AS role_in_team
     FROM team_memberships tm
     JOIN users u      ON u.id  = tm.user_id
     JOIN org_users ou ON ou.user_id = tm.user_id AND ou.org_id = tm.org_id
     WHERE tm.team_id = $1
       AND tm.org_id  = $2
       AND ou.is_active = TRUE
     ORDER BY u.first_name, u.last_name`,
    [teamId, orgId]
  );
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLA Tiers CRUD
// ─────────────────────────────────────────────────────────────────────────────
async function listSlaTiers(orgId) {
  const r = await pool.query(
    `SELECT id, name, description, response_target_hours,
            resolution_target_hours, is_active, sort_order,
            created_at, updated_at
     FROM sla_tiers
     WHERE org_id = $1
     ORDER BY sort_order ASC, name ASC`,
    [orgId]
  );
  return r.rows.map(mapTier);
}

async function createSlaTier(orgId, { name, description, responseTargetHours, resolutionTargetHours }) {
  if (!name?.trim()) throw Object.assign(new Error('Tier name is required'), { status: 400 });

  const maxSort = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM sla_tiers WHERE org_id = $1`,
    [orgId]
  );

  const r = await pool.query(
    `INSERT INTO sla_tiers
       (org_id, name, description, response_target_hours, resolution_target_hours, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      orgId,
      name.trim(),
      description || null,
      responseTargetHours || 4,
      resolutionTargetHours || 24,
      maxSort.rows[0].next,
    ]
  );
  return mapTier(r.rows[0]);
}

async function updateSlaTier(orgId, id, data) {
  const check = await pool.query(
    `SELECT id FROM sla_tiers WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  );
  if (!check.rows.length) throw Object.assign(new Error('SLA tier not found'), { status: 404 });

  const sets = [];
  const params = [];
  let idx = 1;

  const fields = {
    name:                     data.name?.trim(),
    description:              data.description,
    response_target_hours:    data.responseTargetHours,
    resolution_target_hours:  data.resolutionTargetHours,
    is_active:                data.isActive,
    sort_order:               data.sortOrder,
  };

  for (const [col, val] of Object.entries(fields)) {
    if (val !== undefined) {
      sets.push(`${col} = $${idx}`);
      params.push(val);
      idx++;
    }
  }

  if (!sets.length) throw Object.assign(new Error('No fields to update'), { status: 400 });

  sets.push(`updated_at = NOW()`);
  params.push(id, orgId);

  const r = await pool.query(
    `UPDATE sla_tiers SET ${sets.join(', ')}
     WHERE id = $${idx} AND org_id = $${idx + 1}
     RETURNING *`,
    params
  );
  return mapTier(r.rows[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases — list
// ─────────────────────────────────────────────────────────────────────────────
async function listCases(orgId, userId, subordinateIds = [], {
  status, accountId, assignedTo, teamId, breach,
  priority, scope = 'mine', search, limit = 50, offset = 0,
} = {}) {
  let q = `
    SELECT
      c.id, c.case_number, c.subject, c.status, c.priority,
      c.response_due_at, c.resolution_due_at,
      c.first_responded_at, c.resolved_at, c.closed_at,
      c.response_breached, c.resolution_breached,
      c.tags, c.source, c.created_at, c.updated_at,
      c.account_id, c.contact_id, c.deal_id,
      c.assigned_to, c.assigned_team_id, c.sla_tier_id,
      -- Account
      a.name   AS account_name,
      -- Contact
      con.first_name AS contact_first_name,
      con.last_name  AS contact_last_name,
      -- Assigned user
      u.first_name AS assignee_first_name,
      u.last_name  AS assignee_last_name,
      -- Assigned team
      t.name AS team_name,
      -- SLA tier
      st.name AS sla_tier_name,
      st.response_target_hours,
      st.resolution_target_hours
    FROM cases c
    LEFT JOIN accounts a   ON a.id   = c.account_id
    LEFT JOIN contacts con ON con.id = c.contact_id
    LEFT JOIN users u      ON u.id   = c.assigned_to
    LEFT JOIN teams t      ON t.id   = c.assigned_team_id
    LEFT JOIN sla_tiers st ON st.id  = c.sla_tier_id
    WHERE c.org_id = $1
  `;

  const params = [orgId];
  let idx = 2;

  // Scope filter — mirrors deals.routes.js pattern
  if (scope === 'mine') {
    q += ` AND c.assigned_to = $${idx}`; params.push(userId); idx++;
  } else if (scope === 'team' && subordinateIds.length > 0) {
    const teamIds = [userId, ...subordinateIds];
    q += ` AND c.assigned_to = ANY($${idx}::int[])`; params.push(teamIds); idx++;
  }
  // scope === 'all' — no filter, org-wide

  if (status)    { q += ` AND c.status = $${idx}`;       params.push(status);    idx++; }
  if (accountId) { q += ` AND c.account_id = $${idx}`;   params.push(accountId); idx++; }
  if (assignedTo){ q += ` AND c.assigned_to = $${idx}`;  params.push(assignedTo);idx++; }
  if (teamId)    { q += ` AND c.assigned_team_id = $${idx}`; params.push(teamId);idx++; }
  if (priority)  { q += ` AND c.priority = $${idx}`;     params.push(priority);  idx++; }

  if (breach === 'response') {
    q += ` AND c.response_breached = TRUE`;
  } else if (breach === 'resolution') {
    q += ` AND c.resolution_breached = TRUE`;
  } else if (breach === 'any') {
    q += ` AND (c.response_breached = TRUE OR c.resolution_breached = TRUE)`;
  }

  if (search) {
    q += ` AND (c.subject ILIKE $${idx} OR c.case_number ILIKE $${idx})`;
    params.push(`%${search}%`); idx++;
  }

  q += ` ORDER BY c.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);

  const r = await pool.query(q, params);
  return r.rows.map(mapCaseRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases — get single with notes, history, plays
// ─────────────────────────────────────────────────────────────────────────────
async function getCase(orgId, caseId) {
  const r = await pool.query(
    `SELECT
      c.*,
      a.name   AS account_name,
      con.first_name AS contact_first_name,
      con.last_name  AS contact_last_name,
      d.name   AS deal_name,
      u.first_name AS assignee_first_name,
      u.last_name  AS assignee_last_name,
      t.name   AS team_name,
      st.name  AS sla_tier_name,
      st.response_target_hours,
      st.resolution_target_hours,
      cb.first_name AS creator_first_name,
      cb.last_name  AS creator_last_name
     FROM cases c
     LEFT JOIN accounts a   ON a.id   = c.account_id
     LEFT JOIN contacts con ON con.id = c.contact_id
     LEFT JOIN deals d      ON d.id   = c.deal_id
     LEFT JOIN users u      ON u.id   = c.assigned_to
     LEFT JOIN users cb     ON cb.id  = c.created_by
     LEFT JOIN teams t      ON t.id   = c.assigned_team_id
     LEFT JOIN sla_tiers st ON st.id  = c.sla_tier_id
     WHERE c.id = $1 AND c.org_id = $2`,
    [caseId, orgId]
  );
  if (!r.rows.length) throw Object.assign(new Error('Case not found'), { status: 404 });

  const [notes, history, plays] = await Promise.all([
    getCaseNotes(caseId, orgId),
    getCaseHistory(caseId, orgId),
    getCasePlays(caseId, orgId),
  ]);

  return { ...mapCaseRow(r.rows[0]), notes, history, plays };
}

async function getCaseNotes(caseId, orgId) {
  const r = await pool.query(
    `SELECT cn.id, cn.body, cn.note_type, cn.is_internal, cn.created_at,
            u.first_name AS author_first_name,
            u.last_name  AS author_last_name
     FROM case_notes cn
     LEFT JOIN users u ON u.id = cn.author_id
     WHERE cn.case_id = $1 AND cn.org_id = $2
     ORDER BY cn.created_at ASC`,
    [caseId, orgId]
  );
  return r.rows.map(row => ({
    id:         row.id,
    body:       row.body,
    noteType:   row.note_type,
    isInternal: row.is_internal,
    createdAt:  row.created_at,
    author:     row.author_first_name
      ? { firstName: row.author_first_name, lastName: row.author_last_name }
      : null,
  }));
}

async function getCaseHistory(caseId, orgId) {
  const r = await pool.query(
    `SELECT csh.id, csh.from_status, csh.to_status, csh.note, csh.changed_at,
            u.first_name AS changed_by_first_name,
            u.last_name  AS changed_by_last_name
     FROM case_status_history csh
     LEFT JOIN users u ON u.id = csh.changed_by
     WHERE csh.case_id = $1 AND csh.org_id = $2
     ORDER BY csh.changed_at ASC`,
    [caseId, orgId]
  );
  return r.rows.map(row => ({
    id:           row.id,
    fromStatus:   row.from_status,
    toStatus:     row.to_status,
    note:         row.note,
    changedAt:    row.changed_at,
    changedBy:    row.changed_by_first_name
      ? { firstName: row.changed_by_first_name, lastName: row.changed_by_last_name }
      : null,
  }));
}

async function getCasePlays(caseId, orgId) {
  const r = await pool.query(
    `SELECT cp.id, cp.status, cp.due_at, cp.completed_at, cp.created_at,
            pp.title, pp.description, pp.channel, pp.priority,
            u.first_name AS assignee_first_name,
            u.last_name  AS assignee_last_name,
            orole.name   AS role_name
     FROM case_plays cp
     JOIN playbook_plays pp ON pp.id = cp.play_id
     LEFT JOIN users u      ON u.id  = cp.assigned_to
     LEFT JOIN org_roles orole ON orole.id = cp.assigned_role_id
     WHERE cp.case_id = $1 AND cp.org_id = $2
     ORDER BY cp.created_at ASC`,
    [caseId, orgId]
  );
  return r.rows.map(row => ({
    id:          row.id,
    status:      row.status,
    dueAt:       row.due_at,
    completedAt: row.completed_at,
    createdAt:   row.created_at,
    play: {
      title:       row.title,
      description: row.description,
      channel:     row.channel,
      priority:    row.priority,
    },
    assignee: row.assignee_first_name
      ? { firstName: row.assignee_first_name, lastName: row.assignee_last_name }
      : null,
    roleName: row.role_name,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases — create
// ─────────────────────────────────────────────────────────────────────────────
async function createCase(orgId, userId, {
  subject, description, priority = 'medium',
  accountId, contactId, dealId,
  slaTierId, assignedTeamId, assignedTo,
  tags, source = 'manual', playbookId,
}) {
  if (!subject?.trim()) throw Object.assign(new Error('Subject is required'), { status: 400 });

  return withOrgTransaction(orgId, async (client) => {
    const caseNumber = await nextCaseNumber(client, orgId);
    const now = new Date();

    // If no SLA tier provided, inherit from account
    let resolvedTierId = slaTierId || null;
    if (!resolvedTierId && accountId) {
      const acct = await client.query(
        `SELECT sla_tier_id FROM accounts WHERE id = $1 AND org_id = $2`,
        [accountId, orgId]
      );
      resolvedTierId = acct.rows[0]?.sla_tier_id || null;
    }

    const r = await client.query(
      `INSERT INTO cases
         (org_id, case_number, subject, description, status, priority,
          account_id, contact_id, deal_id, sla_tier_id,
          assigned_team_id, assigned_to, created_by,
          tags, source, playbook_id, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, 'open', $5,
          $6, $7, $8, $9,
          $10, $11, $12,
          $13, $14, $15, $16, $16)
       RETURNING *`,
      [
        orgId, caseNumber, subject.trim(), description || null, priority,
        accountId || null, contactId || null, dealId || null, resolvedTierId,
        assignedTeamId || null, assignedTo || null, userId,
        tags || null, source, playbookId || null, now,
      ]
    );
    const newCase = r.rows[0];

    // Stamp SLA due dates
    await stampSLADueDates(client, newCase.id, resolvedTierId, now);

    // Status history — creation entry
    await client.query(
      `INSERT INTO case_status_history
         (org_id, case_id, from_status, to_status, changed_by, note, changed_at)
       VALUES ($1, $2, NULL, 'open', $3, 'Case created', $4)`,
      [orgId, newCase.id, userId, now]
    );

    return newCase;
  }).then(async (newCase) => {
    // Fire playbook plays outside the transaction — non-fatal if it fails
    await firePlaybookPlays(orgId, newCase.id, 'open');
    return getCase(orgId, newCase.id);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases — update (status change, reassignment, field edits)
// ─────────────────────────────────────────────────────────────────────────────
async function updateCase(orgId, caseId, userId, data) {
  const existing = await pool.query(
    `SELECT * FROM cases WHERE id = $1 AND org_id = $2`,
    [caseId, orgId]
  );
  if (!existing.rows.length) throw Object.assign(new Error('Case not found'), { status: 404 });
  const current = existing.rows[0];

  const {
    status, subject, description, priority,
    accountId, contactId, dealId,
    slaTierId, assignedTeamId, assignedTo,
    tags, note,
  } = data;

  // Validate status transition
  if (status && status !== current.status) {
    assertTransition(current.status, status);
  }

  return withOrgTransaction(orgId, async (client) => {
    const now = new Date();
    const sets = [];
    const params = [];
    let idx = 1;

    // Build dynamic SET clause
    const fieldMap = {
      subject:          subject?.trim(),
      description:      description,
      status:           status,
      priority:         priority,
      account_id:       accountId,
      contact_id:       contactId,
      deal_id:          dealId,
      sla_tier_id:      slaTierId,
      assigned_team_id: assignedTeamId,
      assigned_to:      assignedTo,
      tags:             tags,
    };

    for (const [col, val] of Object.entries(fieldMap)) {
      if (val !== undefined) {
        sets.push(`${col} = $${idx}`);
        params.push(val);
        idx++;
      }
    }

    // Status-specific timestamp updates
    if (status && status !== current.status) {
      if (status === 'resolved') {
        sets.push(`resolved_at = $${idx}`); params.push(now); idx++;
      }
      if (status === 'closed') {
        sets.push(`closed_at = $${idx}`); params.push(now); idx++;
      }
      // Moving away from resolved — clear resolved_at
      if (current.status === 'resolved' && status === 'in_progress') {
        sets.push(`resolved_at = NULL`);
      }
    }

    sets.push(`updated_at = $${idx}`); params.push(now); idx++;

    if (sets.length) {
      params.push(caseId, orgId);
      await client.query(
        `UPDATE cases SET ${sets.join(', ')}
         WHERE id = $${idx} AND org_id = $${idx + 1}`,
        params
      );
    }

    // Status change: history entry + system note + breach evaluation
    if (status && status !== current.status) {
      await client.query(
        `INSERT INTO case_status_history
           (org_id, case_id, from_status, to_status, changed_by, note, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, caseId, current.status, status, userId, note || null, now]
      );

      await client.query(
        `INSERT INTO case_notes
           (org_id, case_id, author_id, body, note_type, is_internal, created_at)
         VALUES ($1, $2, $3, $4, 'status_change', FALSE, $5)`,
        [
          orgId, caseId, userId,
          `Status changed from ${current.status.replace(/_/g, ' ')} to ${status.replace(/_/g, ' ')}`,
          now,
        ]
      );

      // Stamp first_responded_at when moving away from open
      if (current.status === 'open' && !current.first_responded_at) {
        await client.query(
          `UPDATE cases SET first_responded_at = $1 WHERE id = $2`,
          [now, caseId]
        );
      }

      await evaluateBreaches(client, caseId);
    }

    // Assignment change: system note
    if (assignedTo !== undefined && assignedTo !== current.assigned_to) {
      const userRow = assignedTo
        ? await client.query(`SELECT first_name, last_name FROM users WHERE id = $1`, [assignedTo])
        : null;
      const assigneeName = userRow?.rows[0]
        ? `${userRow.rows[0].first_name} ${userRow.rows[0].last_name}`
        : 'Unassigned';

      await client.query(
        `INSERT INTO case_notes
           (org_id, case_id, author_id, body, note_type, is_internal, created_at)
         VALUES ($1, $2, $3, $4, 'assignment', TRUE, $5)`,
        [orgId, caseId, userId, `Assigned to ${assigneeName}`, now]
      );
    }

    return;
  }).then(async () => {
    // Fire plays for new status outside transaction
    if (status && status !== current.status) {
      await firePlaybookPlays(orgId, caseId, status);
    }
    return getCase(orgId, caseId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases — add note
// ─────────────────────────────────────────────────────────────────────────────
async function addNote(orgId, caseId, userId, { body, isInternal = false }) {
  if (!body?.trim()) throw Object.assign(new Error('Note body is required'), { status: 400 });

  const caseRow = await pool.query(
    `SELECT id, created_by, first_responded_at, status FROM cases
     WHERE id = $1 AND org_id = $2`,
    [caseId, orgId]
  );
  if (!caseRow.rows.length) throw Object.assign(new Error('Case not found'), { status: 404 });
  const c = caseRow.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `INSERT INTO case_notes
         (org_id, case_id, author_id, body, note_type, is_internal, created_at)
       VALUES ($1, $2, $3, $4, 'comment', $5, NOW())
       RETURNING *`,
      [orgId, caseId, userId, body.trim(), isInternal]
    );

    // Stamp first_responded_at if this is the first note by someone other than creator
    if (!c.first_responded_at && userId !== c.created_by) {
      await client.query(
        `UPDATE cases SET first_responded_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [caseId]
      );
    }

    await evaluateBreaches(client, caseId);
    await client.query('COMMIT');
    return r.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases — update play status (complete / skip)
// ─────────────────────────────────────────────────────────────────────────────
async function updateCasePlay(orgId, caseId, playId, userId, { status }) {
  const validStatuses = ['pending', 'completed', 'skipped'];
  if (!validStatuses.includes(status)) {
    throw Object.assign(new Error(`Invalid play status: ${status}`), { status: 400 });
  }

  const r = await pool.query(
    `UPDATE case_plays
     SET status       = $1,
         completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE NULL END,
         updated_at   = NOW()
     WHERE id = $2 AND case_id = $3 AND org_id = $4
     RETURNING *`,
    [status, playId, caseId, orgId]
  );
  if (!r.rows.length) throw Object.assign(new Error('Play not found'), { status: 404 });
  return r.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────
async function getDashboard(orgId, userId, subordinateIds = [], scope = 'mine') {
  // Build user filter consistent with listCases scope
  let userFilter = '';
  let userParams = [orgId];
  if (scope === 'mine') {
    userFilter = `AND c.assigned_to = $2`;
    userParams.push(userId);
  } else if (scope === 'team' && subordinateIds.length > 0) {
    userFilter = `AND c.assigned_to = ANY($2::int[])`;
    userParams.push([userId, ...subordinateIds]);
  }

  const [stats, byAccount, byOwner, breachList] = await Promise.all([
    // Stats: totals by status + breach counts
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE c.status NOT IN ('closed'))           AS total_open,
         COUNT(*) FILTER (WHERE c.status = 'open')                    AS count_open,
         COUNT(*) FILTER (WHERE c.status = 'in_progress')             AS count_in_progress,
         COUNT(*) FILTER (WHERE c.status = 'pending_customer')        AS count_pending,
         COUNT(*) FILTER (WHERE c.status = 'resolved')                AS count_resolved,
         COUNT(*) FILTER (WHERE c.response_breached = TRUE
                           AND c.status NOT IN ('closed'))             AS response_breaches,
         COUNT(*) FILTER (WHERE c.resolution_breached = TRUE
                           AND c.status NOT IN ('closed'))             AS resolution_breaches,
         COUNT(*) FILTER (WHERE c.resolved_at >= NOW() - INTERVAL '1 day') AS resolved_today
       FROM cases c
       WHERE c.org_id = $1 ${userFilter}`,
      userParams
    ),

    // Open cases by account (top 5)
    pool.query(
      `SELECT a.id AS account_id, a.name AS account_name,
              COUNT(*) AS open_count,
              SUM(CASE WHEN c.response_breached OR c.resolution_breached THEN 1 ELSE 0 END) AS breach_count
       FROM cases c
       JOIN accounts a ON a.id = c.account_id
       WHERE c.org_id = $1
         AND c.status NOT IN ('closed')
         AND c.account_id IS NOT NULL
         ${userFilter.replace('AND c.assigned_to', 'AND c.assigned_to')}
       GROUP BY a.id, a.name
       ORDER BY open_count DESC
       LIMIT 5`,
      userParams
    ),

    // Cases by owner
    pool.query(
      `SELECT u.id AS user_id,
              u.first_name, u.last_name,
              COUNT(*) FILTER (WHERE c.status NOT IN ('closed')) AS open_count,
              COUNT(*) FILTER (WHERE c.status = 'resolved'
                                AND c.resolved_at >= NOW() - INTERVAL '7 days') AS resolved_this_week
       FROM cases c
       JOIN users u ON u.id = c.assigned_to
       WHERE c.org_id = $1
         AND c.assigned_to IS NOT NULL
         ${userFilter}
       GROUP BY u.id, u.first_name, u.last_name
       ORDER BY open_count DESC
       LIMIT 10`,
      userParams
    ),

    // Active SLA breach list (response or resolution)
    pool.query(
      `SELECT c.id, c.case_number, c.subject, c.status, c.priority,
              c.response_breached, c.resolution_breached,
              c.response_due_at, c.resolution_due_at,
              a.name AS account_name,
              u.first_name AS assignee_first_name,
              u.last_name  AS assignee_last_name
       FROM cases c
       LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN users u    ON u.id = c.assigned_to
       WHERE c.org_id = $1
         AND (c.response_breached = TRUE OR c.resolution_breached = TRUE)
         AND c.status NOT IN ('closed')
         ${userFilter}
       ORDER BY c.created_at ASC
       LIMIT 20`,
      userParams
    ),
  ]);

  const s = stats.rows[0];
  return {
    stats: {
      totalOpen:          parseInt(s.total_open),
      countOpen:          parseInt(s.count_open),
      countInProgress:    parseInt(s.count_in_progress),
      countPending:       parseInt(s.count_pending),
      countResolved:      parseInt(s.count_resolved),
      responseBreaches:   parseInt(s.response_breaches),
      resolutionBreaches: parseInt(s.resolution_breaches),
      resolvedToday:      parseInt(s.resolved_today),
    },
    byAccount: byAccount.rows.map(r => ({
      accountId:   r.account_id,
      accountName: r.account_name,
      openCount:   parseInt(r.open_count),
      breachCount: parseInt(r.breach_count),
    })),
    byOwner: byOwner.rows.map(r => ({
      userId:           r.user_id,
      firstName:        r.first_name,
      lastName:         r.last_name,
      openCount:        parseInt(r.open_count),
      resolvedThisWeek: parseInt(r.resolved_this_week),
    })),
    breachList: breachList.rows.map(mapCaseRow),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module — enable (seeds SLA defaults on first enable)
// ─────────────────────────────────────────────────────────────────────────────
async function enableModule(orgId) {
  // Seed default SLA tiers if none exist yet for this org
  const existing = await pool.query(
    `SELECT id FROM sla_tiers WHERE org_id = $1 LIMIT 1`,
    [orgId]
  );
  if (!existing.rows.length) {
    await pool.query(`SELECT seed_sla_defaults($1)`, [orgId]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mappers — all DB columns → camelCase
// ─────────────────────────────────────────────────────────────────────────────
function mapCaseRow(row) {
  return {
    id:                 row.id,
    caseNumber:         row.case_number,
    subject:            row.subject,
    description:        row.description,
    status:             row.status,
    priority:           row.priority,
    tags:               row.tags,
    source:             row.source,
    // SLA
    slaTierId:          row.sla_tier_id,
    slaTierName:        row.sla_tier_name    || null,
    responseTargetHours:   row.response_target_hours    || null,
    resolutionTargetHours: row.resolution_target_hours  || null,
    responseDueAt:      row.response_due_at,
    resolutionDueAt:    row.resolution_due_at,
    firstRespondedAt:   row.first_responded_at,
    resolvedAt:         row.resolved_at,
    closedAt:           row.closed_at,
    responseBreached:   row.response_breached,
    resolutionBreached: row.resolution_breached,
    // Links
    accountId:          row.account_id,
    accountName:        row.account_name     || null,
    contactId:          row.contact_id,
    contactName:        row.contact_first_name
      ? `${row.contact_first_name} ${row.contact_last_name}`
      : null,
    dealId:             row.deal_id,
    dealName:           row.deal_name        || null,
    // Assignment
    assignedTeamId:     row.assigned_team_id,
    teamName:           row.team_name        || null,
    assignedTo:         row.assigned_to,
    assigneeName:       row.assignee_first_name
      ? `${row.assignee_first_name} ${row.assignee_last_name}`
      : null,
    createdBy:          row.created_by,
    creatorName:        row.creator_first_name
      ? `${row.creator_first_name} ${row.creator_last_name}`
      : null,
    // Playbook
    playbookId:         row.playbook_id,
    // Timestamps
    createdAt:          row.created_at,
    updatedAt:          row.updated_at,
  };
}

function mapTier(row) {
  return {
    id:                    row.id,
    name:                  row.name,
    description:           row.description,
    responseTargetHours:   parseFloat(row.response_target_hours),
    resolutionTargetHours: parseFloat(row.resolution_target_hours),
    isActive:              row.is_active,
    sortOrder:             row.sort_order,
    createdAt:             row.created_at,
    updatedAt:             row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Nightly sweep — Phase 2
//
// runNightlySweep(orgId)
//   Called by syncScheduler at 01:30 UTC (after the deal sweep at 01:00).
//   Processes every non-terminal case for the org:
//     1. buildCaseContext(case)       — assemble derived fields
//     2. CasesRulesEngine.evaluate()  — pure rules, returns fired alerts
//     3. ActionPersister.upsertDiagnosticAlert() per fired rule
//     4. ActionPersister.resolveStaleDiagnostics() for conditions no longer true
//
// buildCaseContext(caseRow)
//   Exported separately so it can be called in tests or ad-hoc event triggers
//   without running the full sweep.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the context object expected by CasesRulesEngine.evaluate().
 *
 * Requires one extra query beyond the base case row to get:
 *   - daysSinceLastActivity (latest of updated_at and last note created_at)
 *   - daysSincePendingCustomer (when the case entered pending_customer)
 *
 * @param {object} caseRow  — raw row from the cases table
 * @returns {Promise<object>} context shaped for CasesRulesEngine
 */
async function buildCaseContext(caseRow) {
  const now = new Date();

  // Last note timestamp — activity that doesn't change updated_at on the case
  const noteResult = await pool.query(
    `SELECT MAX(created_at) AS last_note_at
     FROM case_notes
     WHERE case_id = $1`,
    [caseRow.id]
  );
  const lastNoteAt = noteResult.rows[0]?.last_note_at
    ? new Date(noteResult.rows[0].last_note_at)
    : null;

  // Most recent activity: latest of updated_at and last note
  const lastActivityAt = lastNoteAt && lastNoteAt > new Date(caseRow.updated_at)
    ? lastNoteAt
    : new Date(caseRow.updated_at);

  const daysSinceLastActivity = Math.floor(
    (now - lastActivityAt) / (1000 * 60 * 60 * 24)
  );

  // When did this case most recently enter pending_customer?
  // Used by case_pending_too_long rule. Null if not currently pending_customer.
  let daysSincePendingCustomer = null;
  if (caseRow.status === 'pending_customer') {
    const histResult = await pool.query(
      `SELECT changed_at
       FROM case_status_history
       WHERE case_id   = $1
         AND new_status = 'pending_customer'
       ORDER BY changed_at DESC
       LIMIT 1`,
      [caseRow.id]
    );
    if (histResult.rows.length > 0) {
      daysSincePendingCustomer = Math.floor(
        (now - new Date(histResult.rows[0].changed_at)) / (1000 * 60 * 60 * 24)
      );
    } else {
      // Fallback: no status history row — use updated_at as a conservative proxy
      daysSincePendingCustomer = daysSinceLastActivity;
    }
  }

  return {
    case:    caseRow,
    derived: {
      daysSinceLastActivity,
      daysSincePendingCustomer,
    },
  };
}

/**
 * Run the full nightly diagnostic sweep for all non-terminal cases in an org.
 *
 * @param {number} orgId
 * @returns {Promise<{ processed: number, alerts: number, resolved: number, errors: number }>}
 */
async function runNightlySweep(orgId) {
  const stats = { processed: 0, alerts: 0, resolved: 0, errors: 0 };

  // Fetch all non-terminal cases for the org.
  // We need the assigned_to for the userId param on upsertDiagnosticAlert.
  // When a case is unassigned, fall back to null — ActionPersister accepts null userId.
  let cases;
  try {
    const result = await pool.query(
      `SELECT id, case_number, status, priority,
              assigned_to, org_id,
              response_due_at, resolution_due_at,
              first_responded_at, resolved_at, closed_at,
              response_breached, resolution_breached,
              created_at, updated_at
       FROM cases
       WHERE org_id = $1
         AND status NOT IN ('resolved', 'closed')
       ORDER BY id ASC`,
      [orgId]
    );
    cases = result.rows;
  } catch (err) {
    console.error(`[CasesNightlySweep] Failed to fetch cases for org ${orgId}:`, err.message);
    return stats;
  }

  for (const caseRow of cases) {
    try {
      // Build derived context fields
      const ctx = await buildCaseContext(caseRow);

      // Run all diagnostic rules — pure, no DB
      const fired = CasesRulesEngine.evaluate(ctx);

      // Upsert each fired alert
      const firedSourceRules = [];
      for (const alert of fired) {
        const id = await ActionPersister.upsertDiagnosticAlert({
          entityType: 'case',
          entityId:   caseRow.id,
          sourceRule: alert.sourceRule,
          title:      alert.title,
          description: alert.description,
          priority:   alert.priority,
          nextStep:   alert.nextStep,
          orgId:      orgId,
          userId:     caseRow.assigned_to || null,
        });
        if (id != null) {
          firedSourceRules.push(alert.sourceRule);
          stats.alerts++;
        }
      }

      // Resolve any diagnostic alerts whose conditions are no longer true
      const resolvedCount = await ActionPersister.resolveStaleDiagnostics({
        entityType: 'case',
        entityId:   caseRow.id,
        firedRules: firedSourceRules,
        orgId:      orgId,
      });
      stats.resolved  += resolvedCount;
      stats.processed += 1;

    } catch (err) {
      console.error(
        `[CasesNightlySweep] Error processing case ${caseRow.id} (org ${orgId}):`,
        err.message
      );
      stats.errors++;
    }
  }

  console.log(
    `[CasesNightlySweep] org=${orgId} processed=${stats.processed} ` +
    `alerts=${stats.alerts} resolved=${stats.resolved} errors=${stats.errors}`
  );

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // SLA tiers
  listSlaTiers,
  createSlaTier,
  updateSlaTier,
  // Cases
  listCases,
  getCase,
  createCase,
  updateCase,
  addNote,
  updateCasePlay,
  // Dashboard
  getDashboard,
  // Teams
  getSupportTeams,
  getTeamMembers,
  // Module
  enableModule,
  // Nightly sweep — Phase 2
  runNightlySweep,
  buildCaseContext,   // exported for testing / ad-hoc event triggers
  // Exposed for testing
  TRANSITIONS,
};
