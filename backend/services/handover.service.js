// ─────────────────────────────────────────────────────────────────────────────
// handover.service.js
//
// Core service for the Sales → Implementation Handover module.
//
// Responsibilities:
//   - initiate()      — called on closed_won; creates draft + activates plays
//   - list()          — sales "my handovers" + service "assigned to me"
//   - getById()       — full detail with stakeholders, commitments, plays
//   - update()        — edit core fields (draft only)
//   - advanceStatus() — status machine with permission checks
//   - stakeholder CRUD
//   - commitment CRUD
//   - completePlay()  — delegate to PlaybookPlayService + sync handover_plays
//   - canSubmit()     — gate check: all is_gate plays completed
//   - runNightlySweep() — Phase 2: HandoverRulesEngine diagnostic sweep
//   - generateForHandoverEvent() — Phase 7: ad-hoc diagnostic re-run for one
//       handover triggered by a discrete event (kickoff meeting created,
//       new commitment added, etc.)
//   - addCommitment() — Phase 8 addition: fires generateForHandoverEvent
//       non-blocking after insert so handover_stalled resolves immediately
// ─────────────────────────────────────────────────────────────────────────────

const { pool, withOrgTransaction } = require('../config/database');
const PlaybookPlayService          = require('./PlaybookPlayService');
const ActionPersister              = require('./ActionPersister');
const HandoverRulesEngine          = require('./HandoverRulesEngine');
const projectMembers               = require('./projectMembers.service');

async function _isOrgAdmin(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  return ['admin', 'owner'].includes(rows[0]?.role);
}
const { getDiagnosticRulesConfig }  = require('../routes/orgAdmin.routes');
const PlayCompletionService        = require('./PlayCompletionService');  // Phase 6
const projectSettings              = require('./projectSettings.service');   // 2026-08 scope config
const hierarchyService             = require('./hierarchyService');

// ── Status machine ────────────────────────────────────────────────────────────

const TRANSITIONS = {
  draft:        ['submitted', 'cancelled'],
  submitted:    ['draft', 'acknowledged', 'cancelled'],  // draft = recall; acknowledged = service accepts
  acknowledged: ['in_progress', 'cancelled'],
  in_progress:  ['completed', 'cancelled'],
  completed:    [],                          // terminal
  cancelled:    [],                          // terminal
};

// Terminal statuses — used by the sweep to skip dead handovers and by the
// list view to default-hide them.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);

// ── Plan-vs-actual helpers (2026_111) ────────────────────────────────────────

/**
 * Normalise a date column to 'YYYY-MM-DD'.
 *
 * pg returns DATE as a JS Date in local time. Comparing that to the
 * 'YYYY-MM-DD' string the client sends via `new Date(x) === new Date(y)` or
 * naive string compare produces spurious differences either side of midnight,
 * which would log a revision for a save that changed nothing.
 */
function toDateStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * May this user reset the baseline on this project?
 *
 * Three routes in: org admin/owner, the two people accountable for the project
 * (service owner, creator) — both already covered by canManageProject — or an
 * approved member explicitly granted can_rebaseline.
 *
 * The grant is per-project by design. Someone overseeing one delivery should
 * not thereby be able to reset baselines on every other project in the org.
 */
async function canRebaseline(handoverId, orgId, userId) {
  if (!userId) return false;
  if (await projectMembers.canManageProject(handoverId, orgId, userId)) return true;

  const { rows: [m] } = await pool.query(
    `SELECT 1
       FROM project_members
      WHERE org_id = $1 AND context_type = 'handover' AND context_id = $2
        AND user_id = $3 AND status = 'approved' AND exited_at IS NULL
        AND can_rebaseline = TRUE
      LIMIT 1`,
    [orgId, handoverId, userId]
  );
  return Boolean(m);
}


// Who can trigger each target status
const TRANSITION_ROLES = {
  submitted:    'sales',      // created_by / owner
  draft:        'sales',      // recall to draft from submitted
  acknowledged: 'service',   // assigned_service_owner
  in_progress:  'service',
  completed:    'service',   // service owner signs off delivery
  cancelled:    'either',    // either side can abandon (deal unwound, etc.)
};

// Internal projects have no second party. 'submitted' and 'acknowledged' exist
// to make the sales-to-service transfer of responsibility explicit and
// timestamped; with nobody on the other side they are two clicks of ceremony,
// and 'submitted' additionally locks editing. So internal projects go straight
// from draft to in_progress.
const INTERNAL_TRANSITIONS = {
  draft:        ['in_progress', 'cancelled'],
  in_progress:  ['draft', 'completed', 'cancelled'],   // draft = reopen for rework
  submitted:    ['draft', 'in_progress', 'cancelled'], // legacy rows, if any
  acknowledged: ['in_progress', 'cancelled'],
  completed:    ['in_progress'],                       // reopen a project closed too early
  cancelled:    [],
};

function transitionsFor(kind) {
  return kind === 'internal' ? INTERNAL_TRANSITIONS : TRANSITIONS;
}

function assertTransition(from, to, kind = 'customer') {
  if (!transitionsFor(kind)[from]?.includes(to)) {
    const err = new Error(`Cannot transition from '${from}' to '${to}'`);
    err.status = 400;
    throw err;
  }
}

// ── Row formatters ────────────────────────────────────────────────────────────

function fmt(row) {
  if (!row) return null;
  return {
    id:                     row.id,
    orgId:                  row.org_id,
    dealId:                 row.deal_id,
    accountId:              row.account_id,
    assignedServiceOwnerId: row.assigned_service_owner_id,
    status:                 row.status,
    goLiveDate:             row.go_live_date,
    contractValue:          row.contract_value,
    managerLabel:           row.manager_label || null,
    // ── internal projects (2026_87) ──
    projectKind:            row.project_kind || 'customer',
    budget:                 row.budget ?? null,
    name:                   row.name ?? null,
    // One label the UI can rely on. A project with no deal has no deal name to
    // borrow, so its own name is the only source; customer projects keep
    // showing the deal name so nothing changes for existing rows.
    projectName:            row.name || row.deal_name || null,
    commercialTermsSummary: row.commercial_terms_summary,
    playbookId:             row.playbook_id,
    createdBy:              row.created_by,
    submittedAt:            row.submitted_at,
    acknowledgedAt:         row.acknowledged_at,
    // ── closure (2026_64) ──
    // These columns exist on sales_handovers and are returned by getById()/
    // advanceStatus(), but were previously dropped here — so the closure_summary
    // a rep is REQUIRED to enter when cancelling was write-only and invisible in
    // the UI. Mapped now (additive; no query or behaviour change).
    completedAt:            row.completed_at   ?? null,
    completedBy:            row.completed_by   ?? null,
    cancelledAt:            row.cancelled_at   ?? null,
    cancelledBy:            row.cancelled_by   ?? null,
    closureSummary:         row.closure_summary ?? null,
    updatedAt:              row.updated_at,
    createdAt:              row.created_at,
    // joined
    dealName:               row.deal_name    ?? null,
    accountName:            row.account_name ?? null,
    serviceOwnerName:       row.service_owner_name ?? null,
    createdByName:          row.created_by_name    ?? null,
  };
}

function fmtStakeholder(row) {
  if (!row) return null;
  return {
    id:                row.id,
    handoverId:        row.handover_id,
    contactId:         row.contact_id,
    accountTeamId:     null,
    name:              row.name,
    handoverRole:      row.handover_role,
    // Which side of the table, for THIS project. Defaulted rather than left
    // undefined so a caller that predates 2026_93 still gets a usable value.
    side:              row.side ?? 'customer',
    // Resolved from contact_roles; falls back to the raw key when the role was
    // later deactivated, so the row still renders.
    handoverRoleLabel: row.handover_role_label ?? row.handover_role,
    accountName:       row.account_name ?? null,
    relationshipNotes: row.relationship_notes,
    isPrimaryContact:  row.is_primary_contact,
    createdAt:         row.created_at,
    // joined contact fields
    contactEmail:      row.contact_email  ?? null,
    contactTitle:      row.contact_title  ?? null,
    contactPhone:      row.contact_phone  ?? null,
  };
}

function fmtCommitment(row) {
  if (!row) return null;

  const isTerminal = ['met', 'waived', 'breached'].includes(row.status);
  const isOverdue  = !isTerminal
    && row.due_date != null
    && new Date(row.due_date) < new Date(new Date().toDateString());

  return {
    id:             row.id,
    handoverId:     row.handover_id,
    description:    row.description,
    commitmentType: row.commitment_type,
    // ── deliverable tracking (2026_64) ──
    dueDate:        row.due_date  ?? null,
    ownerUserId:    row.owner_user_id ?? null,
    status:         row.status    ?? 'open',
    closedAt:       row.closed_at ?? null,
    closedBy:       row.closed_by ?? null,
    closureNote:    row.closure_note ?? null,
    isOverdue,
    daysOverdue:    isOverdue
      ? Math.floor((Date.now() - new Date(row.due_date)) / 86400000)
      : 0,
    createdBy:      row.created_by,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at ?? null,
    createdByName:  row.created_by_name ?? null,
    ownerName:      row.owner_name      ?? null,
    closedByName:   row.closed_by_name  ?? null,
  };
}

function fmtPlay(row) {
  if (!row) return null;

  // BUGFIX: due_date, due_anchor and updated_at were being neither SELECTed in
  // _getPlays() nor mapped here, so the instance's due_date — which the
  // playbook engine has been populating all along — was invisible to the
  // handover UI. Every deliverable looked undated.
  const isDone    = ['completed', 'skipped'].includes(row.play_status);
  const isOverdue = !isDone
    && row.due_date != null
    && new Date(row.due_date) < new Date(new Date().toDateString());

  return {
    id:              row.id,             // project_play_instances.id
    playInstanceId:  row.play_instance_id,
    handoverId:      row.handover_id,
    completedAt:     row.completed_at,
    // from project_play_instances
    title:           row.title,
    description:     row.description,
    channel:         row.channel,
    stageKey:        row.stage_key ?? null,
    // 2026_115: resolved display name + order for the stage. Undefined on
    // callers that build a play row without the stage joins, so the frontend
    // keeps its own label fallback rather than rendering blank.
    stageName:       row.stage_name ?? null,
    stageSortOrder:  row.stage_sort_order ?? null,
    // 2026_117. dependsOn is the stored prerequisite list; blockedBy is the
    // subset still outstanding. Both undefined on callers that build a play
    // row without the dependency sub-select, hence the ?? fallbacks.
    dependsOn:       row.depends_on ?? [],
    blockedBy:       row.blocked_by ?? [],
    // 2026_118. Names of earlier stages holding this one shut. Separate from
    // blockedBy so the UI can say WHY — "waiting on Core Model Pipeline" reads
    // very differently from "waiting on task X".
    stageGating:     row.stage_gating ?? 'none',
    stageBlockedBy:  row.stage_blocked_by ?? [],
    // Baseline is what the Change-date dialog compares against; without it
    // the dialog cannot show what was originally committed.
    baselineDueDate: row.baseline_due_date ?? null,
    baselineSource:  row.baseline_source ?? null,
    completionNote:  row.completion_note ?? null,
    completionEvidence: row.completion_evidence ?? null,
    isGate:          row.is_gate,
    executionType:   row.execution_type,
    sortOrder:       row.sort_order,
    priority:        row.priority,
    status:          row.play_status,
    completedBy:     row.completed_by,
    completedByName: row.completed_by_name ?? null,
    // ── ownership + provenance ──
    ownerUserId:     row.owner_user_id ?? null,
    ownerName:       row.owner_name    ?? null,
    playbookName:    row.playbook_name ?? null,
    // Ad-hoc items are added directly on the handover — no playbook, no template.
    isCustom:        row.play_id == null && row.playbook_id == null,
    // ── deliverable tracking (2026_64) ──
    dueDate:         row.due_date   ?? null,
    dueAnchor:       row.due_anchor ?? 'created',
    isOverdue,
    daysOverdue:     isOverdue
      ? Math.floor((Date.now() - new Date(row.due_date)) / 86400000)
      : 0,
    // ── notes (2026_120) ──
    // Undefined on callers that build a play row without the notes sub-select,
    // hence the ?? fallback — the badge then simply does not render.
    noteCount:       row.note_count ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INITIATE — called when deal enters closed_won
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a draft handover for a newly-won deal, activate the handover_s2i
 * playbook plays, and pre-populate stakeholders from deal_contacts.
 *
 * Idempotent — if a handover already exists for this deal, returns existing.
 *
 * @param {number} dealId
 * @param {number} orgId
 * @param {number} userId  — the user who triggered the stage change
 * @returns {{ handover: object, created: boolean, warnings: string[] }}
 */
async function initiate(dealId, orgId, userId) {
  const warnings = [];

  // Check idempotency
  const existing = await pool.query(
    'SELECT * FROM sales_handovers WHERE deal_id = $1 AND org_id = $2',
    [dealId, orgId]
  );

  if (existing.rows.length > 0) {
    return { handover: fmt(existing.rows[0]), created: false, warnings: [] };
  }

  // Pull deal + account
  const dealResult = await pool.query(
    `SELECT d.id, d.name, d.value, d.account_id, a.name AS account_name
     FROM deals d JOIN accounts a ON a.id = d.account_id
     WHERE d.id = $1 AND d.org_id = $2`,
    [dealId, orgId]
  );

  if (dealResult.rows.length === 0) {
    throw Object.assign(new Error('Deal not found'), { status: 404 });
  }

  const deal = dealResult.rows[0];

  // Find org default handover_s2i playbook
  const playbookResult = await pool.query(
    `SELECT id FROM playbooks
     WHERE org_id = $1 AND type = 'handover_s2i' AND is_default = TRUE
     LIMIT 1`,
    [orgId]
  );

  const playbookId = playbookResult.rows[0]?.id ?? null;

  if (!playbookId) {
    warnings.push('No default handover_s2i playbook found — handover created without plays');
  }

  // Create handover + pre-populate stakeholders in a transaction
  const handover = await withOrgTransaction(orgId, async (client) => {
    // Insert handover record
    const hResult = await client.query(
      `INSERT INTO sales_handovers
         (org_id, deal_id, account_id, status, contract_value, playbook_id, created_by)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6)
       RETURNING *`,
      [orgId, dealId, deal.account_id, deal.value || null, playbookId, userId]
    );

    const h = hResult.rows[0];

    // Pre-populate stakeholders from deal_contacts
    const contactsResult = await client.query(
      `SELECT dc.contact_id, dc.role,
              c.first_name || ' ' || c.last_name AS full_name,
              c.email, c.title
       FROM deal_contacts dc
       JOIN contacts c ON c.id = dc.contact_id
       WHERE dc.deal_id = $1`,
      [dealId]
    );

    for (const contact of contactsResult.rows) {
      // Map deal_contact role to handover_role
      const handoverRole = _mapDealContactRole(contact.role);

      await client.query(
        `INSERT INTO project_contacts
           (org_id, context_type, context_id, contact_id, role, created_by)
         VALUES ($1, 'handover', $2, $3, $4, $5)
         ON CONFLICT (context_type, context_id, contact_id) DO NOTHING`,
        [orgId, h.id, contact.contact_id, handoverRole, userId]
      );
    }

    // The person who closed the deal joins the project team as an approved
    // member. Without this they are attached only via created_by, so any view
    // built on membership loses them the moment the "From my deals" tab is
    // hidden — and that tab is off by default.
    //
    // Inserted unconditionally approved rather than through
    // projectMembers.addMember(): that path consults the org's auto-approve
    // config and can land on 'pending', which would leave the closer waiting
    // for someone to approve them onto their own handover.
    await client.query(
      `INSERT INTO project_members
         (org_id, context_type, context_id, user_id, custom_role, status,
          requested_by, reviewed_by, reviewed_at)
       VALUES ($1, 'handover', $2, $3, 'Sales owner', 'approved', $3, $3, now())
       ON CONFLICT (context_type, context_id, user_id) DO NOTHING`,
      [orgId, h.id, userId]
    );

    return h;
  });

  // Activate handover_s2i plays (outside transaction — PlaybookPlayService manages its own writes)
  //
  // 2026_109: this used activateStageForPlaybook(dealId, …), which wrote the
  // plays into deal_play_instances and then linked them to the project through
  // sales_handover_plays. That is why every project play in the database had
  // handover_id NULL and was reachable only via the link table.
  //
  // It now uses the project path, which writes project_play_instances with
  // handover_id set. The sales_handover_plays insert is gone with it: one link,
  // not two that can disagree.
  if (playbookId) {
    try {
      // 2026_116: stages first, then plays — same reason as setPlaybook.
      await _materializeStagesFromCatalogue(handover.id, orgId, playbookId, userId);

      const { instances, warnings: playWarnings } =
        await PlaybookPlayService.activateStageForProject(
          handover.id, 'closed_won', orgId, userId, playbookId
        );

      playWarnings.forEach(w => warnings.push(w));
      void instances;
    } catch (err) {
      warnings.push(`Play activation failed: ${err.message}`);
      console.error('Handover play activation error:', err);
    }
  }

  return { handover: fmt(handover), created: true, warnings };
}

/**
 * Create a project that does not come from a won deal.
 *
 *   kind 'internal' — run inside the org. No account, no deal; the DB CHECK
 *                     enforces that. Budget is allowed here and only here.
 *   kind 'customer' — the documented exception: delivery for an account that
 *                     never went through the pipeline. Requires an account.
 *
 * Deliberately does NOT reuse initiate(): that path is deal-driven, idempotent
 * on deal_id, copies contract_value from the deal and activates the closed_won
 * playbook stage. None of that applies here, and bending it to fit would make
 * both paths harder to reason about.
 *
 * The creator joins as an approved member for the same reason as in initiate() —
 * otherwise they are attached by created_by alone and lose the project as soon
 * as the "From my deals" tab is hidden.
 */
async function createProject(orgId, userId, data = {}) {
  const kind = data.kind === 'internal' ? 'internal' : 'customer';
  const name = (data.name || '').trim();

  if (!name) {
    throw Object.assign(new Error('A project name is required'), { status: 400 });
  }

  let accountId = null;
  if (kind === 'customer') {
    accountId = parseInt(data.accountId, 10);
    if (!accountId) {
      throw Object.assign(new Error('A customer project needs an account'), { status: 400 });
    }
    const { rows } = await pool.query(
      'SELECT 1 FROM accounts WHERE id = $1 AND org_id = $2', [accountId, orgId]);
    if (!rows.length) {
      throw Object.assign(new Error('Account not found'), { status: 404 });
    }
  }

  // Budget is internal-only; silently dropping it for a customer project is
  // kinder than a CHECK violation the caller cannot interpret.
  const budget = kind === 'internal' && data.budget != null && data.budget !== ''
    ? data.budget
    : null;

  const serviceOwnerId = data.assignedServiceOwnerId
    ? parseInt(data.assignedServiceOwnerId, 10)
    : null;

  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO sales_handovers
         (org_id, project_kind, name, account_id, deal_id, budget,
          assigned_service_owner_id, go_live_date, status, created_by)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, 'draft', $8)
       RETURNING *`,
      [orgId, kind, name, accountId, budget, serviceOwnerId, data.goLiveDate || null, userId]
    );
    const h = rows[0];

    await client.query(
      `INSERT INTO project_members
         (org_id, context_type, context_id, user_id, custom_role, status,
          requested_by, reviewed_by, reviewed_at)
       VALUES ($1, 'handover', $2, $3, 'Project creator', 'approved', $3, $3, now())
       ON CONFLICT (context_type, context_id, user_id) DO NOTHING`,
      [orgId, h.id, userId]
    );

    return fmt(h);
  });
}

/**
 * Attach a playbook to a project and activate its first stage.
 *
 * playbook_id had only ever been written by initiate(), from the org's default
 * handover_s2i playbook — so a project created any other way had no route to
 * one and its checklist stayed permanently empty.
 *
 * Activation is best-effort and reported: linking the playbook is the durable
 * change, and a stage that produces no plays should not roll that back. The
 * caller gets the warnings so the UI can say what happened.
 */
/**
 * Cancel the in-flight work belonging to a playbook being replaced.
 *
 * Cancelled, never deleted. "What was on the old checklist and how far had we
 * got" is exactly what someone asks after a swap, and a DELETE would erase it.
 *
 * Completed and skipped plays are left alone — that work genuinely happened and
 * rewriting its status would falsify the record. Only open work is closed.
 *
 * Actions are cancelled in the same sweep. Without that, a rep keeps seeing
 * items in their queue for a checklist the project has abandoned, which is how
 * an action list stops being trusted.
 */
async function _cancelOpenPlaybookWork(handoverId, orgId, userId, oldPlaybookId) {
  const OPEN = ['not_started', 'in_progress', 'blocked', 'snoozed'];

  // Actions first: once the instances are cancelled their ids are harder to
  // find, and an orphaned open action is worse than an orphaned cancelled play.
  const { rowCount: actions } = await pool.query(
    `UPDATE actions SET status = 'cancelled', updated_at = now()
      WHERE org_id = $1
        AND status = ANY($2::text[])
        AND id IN (
          -- Filtered on the ACTION being open, deliberately not the play.
          -- A play that was skipped can still have left an open action behind,
          -- and after a swap no open action from the old checklist should
          -- survive — that is precisely the orphan this sweep exists to stop.
          SELECT ppi.action_id FROM project_play_instances ppi
           WHERE ppi.handover_id = $3
             AND ppi.action_id IS NOT NULL
             AND (ppi.playbook_id = $4 OR ppi.playbook_id IS NULL)
        )`,
    [orgId, OPEN, handoverId, oldPlaybookId]);

  const { rowCount: plays } = await pool.query(
    `UPDATE project_play_instances
        SET status = 'cancelled', updated_at = now()
      WHERE handover_id = $1 AND org_id = $2
        AND status = ANY($3::text[])
        AND (playbook_id = $4 OR playbook_id IS NULL)`,
    [handoverId, orgId, OPEN, oldPlaybookId]);

  return { plays, actions };
}

async function setPlaybook(handoverId, orgId, userId, playbookId, stageKey = null, replace = false) {
  const { rows: [h] } = await pool.query(
    `SELECT id, deal_id, playbook_id, project_kind FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]);
  if (!h) throw Object.assign(new Error('Project not found'), { status: 404 });

  const { rows: [pb] } = await pool.query(
    `SELECT id, name, type FROM playbooks WHERE id = $1 AND org_id = $2`, [playbookId, orgId]);
  if (!pb) throw Object.assign(new Error('Playbook not found'), { status: 404 });

  // ── Swapping an existing playbook ──────────────────────────────────────
  // Previously refused outright. Now allowed, but only deliberately: the caller
  // must pass replace=true, because swapping cancels work that is already in
  // flight and should never happen as a side effect of a mis-click.
  const isSwap = Boolean(h.playbook_id && h.playbook_id !== playbookId);
  if (isSwap && !replace) {
    throw Object.assign(
      new Error('This project already has a playbook. Confirm the change to replace it — open plays and their actions will be cancelled.'),
      { status: 409, code: 'PLAYBOOK_ALREADY_LINKED' });
  }

  let cancelled = { plays: 0, actions: 0 };
  if (isSwap) {
    cancelled = await _cancelOpenPlaybookWork(handoverId, orgId, userId, h.playbook_id);
    await pool.query(
      `UPDATE sales_handovers
          SET previous_playbook_id = $1, playbook_changed_at = now(), playbook_changed_by = $2
        WHERE id = $3 AND org_id = $4`,
      [h.playbook_id, userId, handoverId, orgId]);
  }

  await pool.query(
    `UPDATE sales_handovers SET playbook_id = $1, updated_at = now() WHERE id = $2 AND org_id = $3`,
    [playbookId, handoverId, orgId]);

  // 2026_116: copy the org stage catalogue into the project, mirroring how
  // plays are materialized. Runs BEFORE stage activation so the plays about to
  // be created already have their stage defined and ordered — otherwise the
  // first render sorts them NULLS LAST.
  await _materializeStagesFromCatalogue(handoverId, orgId, playbookId, userId);

  // First stage of the playbook, unless the caller named one.
  let stage = stageKey;
  if (!stage) {
    const { rows: [st] } = await pool.query(
      `SELECT key FROM playbook_stages
        WHERE playbook_id = $1 AND org_id = $2 AND is_active = TRUE
        ORDER BY sort_order ASC LIMIT 1`, [playbookId, orgId]);
    stage = st?.key || null;
  }
  if (!stage) {
    return { playbookId, playbookName: pb.name, activated: 0,
             warnings: ['Playbook linked, but it has no stages to activate'] };
  }

  const PlaybookPlayService = require('./PlaybookPlayService');
  try {
    // 2026_109: previously a project WITH a deal took the deal path
    // (activateStageForPlaybook -> deal_play_instances + sales_handover_plays)
    // and only a deal-less project took the project path. That split by
    // provenance is exactly what the migration removed: a project's plays
    // belong to the project regardless of how the project came to exist.
    //
    // activateStageForPlaybook now has no callers. It is left in place rather
    // than deleted so this change can be reverted without restoring code.
    const { instances, warnings } =
      await PlaybookPlayService.activateStageForProject(handoverId, stage, orgId, userId, playbookId);

    return {
      playbookId, playbookName: pb.name, stage,
      activated: instances.length,
      replaced: isSwap,
      cancelled,
      warnings,
    };
  } catch (err) {
    console.error('setPlaybook activation error:', err);
    return { playbookId, playbookName: pb.name, stage, activated: 0,
             warnings: [`Playbook linked, but activation failed: ${err.message}`] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {number} orgId
 * @param {number} userId
 * @param {{ scope: 'mine'|'assigned'|'all', status?: string }} opts
 *   mine     — handovers created by userId (sales view)
 *   assigned — handovers where assigned_service_owner_id = userId (service view)
 *   all      — all org handovers (admin)
 */
async function list(orgId, userId, { scope = 'mine', status, kind = null, subordinateIds = [], userRole = null } = {}) {
  const params = [orgId];
  const conditions = ['h.org_id = $1'];

  // 'mine' and 'assigned' keep their original meaning so the existing two tabs
  // are untouched. 'team' and 'org' are the rollup scopes (2026-08) and read
  // their owner column from per-org config.
  if (scope === 'mine') {
    params.push(userId);
    conditions.push(`h.created_by = $${params.length}`);

  } else if (scope === 'assigned') {
    // "My work" — every project I have a role on, not only the ones I own.
    // Membership is via project_members, which is the internal team (external
    // people live in project_contacts). Only 'approved' counts: a 'pending'
    // row is an unreviewed access request, and honouring it here would let
    // anyone see a project just by asking.
    params.push(userId);
    const me = `$${params.length}`;
    conditions.push(`(
         h.assigned_service_owner_id = ${me}
      OR EXISTS (SELECT 1 FROM project_members pm
                  WHERE pm.context_type = 'handover'
                    AND pm.context_id   = h.id
                    AND pm.org_id       = h.org_id
                    AND pm.user_id      = ${me}
                    AND pm.status       = 'approved')
    )`);

  } else if (scope === 'team') {
    const cfg = await projectSettings.get(orgId);
    if (cfg.rollup_basis !== 'people') {
      const e = new Error(`rollup_basis '${cfg.rollup_basis}' is not implemented yet`);
      e.status = 501; throw e;
    }
    if (!cfg.team_scope_enabled) {
      const e = new Error('Team scope is disabled for this organization');
      e.status = 403; throw e;
    }

    const col     = projectSettings.ownerColumn(cfg);
    const teamIds = [...new Set([userId, ...(subordinateIds || [])])];
    params.push(teamIds);
    const ids = `$${params.length}::int[]`;
    // Mirrors 'assigned': ownership OR approved membership. Without the second
    // half a manager would see strictly fewer projects than their own reports
    // can see, which reads as data missing rather than as a scope rule.
    const owned = `(
         h.${col} = ANY(${ids})
      OR EXISTS (SELECT 1 FROM project_members pm
                  WHERE pm.context_type = 'handover'
                    AND pm.context_id   = h.id
                    AND pm.org_id       = h.org_id
                    AND pm.user_id      = ANY(${ids})
                    AND pm.status       = 'approved')
    )`;

    // A project with no service owner belongs to nobody and would otherwise be
    // invisible to everyone except its creator — precisely the case a head of
    // projects needs to catch. Surface it here and flag it in the payload.
    conditions.push(
      cfg.show_unassigned_in_team_scope
        ? `(${owned} OR h.assigned_service_owner_id IS NULL)`
        : owned
    );

  } else if (scope === 'org') {
    const cfg = await projectSettings.get(orgId);
    if (!projectSettings.canUseOrgScope(cfg, userRole)) {
      const e = new Error('You do not have permission to view all organization projects');
      e.status = 403; throw e;
    }
    // no owner filter — every project in the org
  }

  if (status) {
    params.push(status);
    conditions.push(`h.status = $${params.length}`);
  }

  // 'customer' | 'internal'. Omitted means both — the mixed view, where the UI
  // shows revenue and budget as separate cards rather than one merged total.
  if (kind === 'customer' || kind === 'internal') {
    params.push(kind);
    conditions.push(`h.project_kind = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT
       h.*,
       d.name                                    AS deal_name,
       a.name                                    AS account_name,
       u_so.first_name || ' ' || u_so.last_name  AS service_owner_name,
       u_cb.first_name || ' ' || u_cb.last_name  AS created_by_name,
       COUNT(DISTINCT shp.id)::int               AS total_plays,
       COUNT(DISTINCT shp.id) FILTER (WHERE shp.status = 'completed')::int AS completed_plays,
       COUNT(DISTINCT s.id)::int                 AS stakeholder_count,
       -- Deliverable rollup (2026_64). 1:1 with the handover, so joining it
       -- neither multiplies rows nor disturbs the COUNT(DISTINCT ...) above.
       r.plays_overdue::int                      AS r_plays_overdue,
       r.gates_open::int                         AS r_gates_open,
       r.commitments_total::int                  AS r_commitments_total,
       r.commitments_closed::int                 AS r_commitments_closed,
       r.commitments_overdue::int                AS r_commitments_overdue,
       r.days_to_go_live                         AS r_days_to_go_live,
       r.is_closeable                            AS r_is_closeable
     FROM sales_handovers h
     LEFT JOIN deals    d ON d.id  = h.deal_id
     LEFT JOIN accounts a ON a.id  = h.account_id
     LEFT JOIN users u_so ON u_so.id = h.assigned_service_owner_id
     LEFT JOIN users u_cb ON u_cb.id = h.created_by
     LEFT JOIN project_play_instances shp ON shp.handover_id = h.id
     LEFT JOIN project_contacts s  ON s.context_type = 'handover' AND s.context_id = h.id
     LEFT JOIN handover_deliverable_rollup r  ON r.handover_id = h.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY h.id, d.name, a.name, u_so.first_name, u_so.last_name, u_cb.first_name, u_cb.last_name,
              r.plays_overdue, r.gates_open, r.commitments_total, r.commitments_closed,
              r.commitments_overdue, r.days_to_go_live, r.is_closeable
     ORDER BY h.created_at DESC`,
    params
  );

  return rows.map(r => ({
    ...fmt(r),
    // Explicit rather than letting the UI infer from a null name: an
    // unassigned project is an operational state to act on, not missing data.
    isUnassigned:    r.assigned_service_owner_id == null,
    totalPlays:      r.total_plays,
    completedPlays:  r.completed_plays,
    stakeholderCount: r.stakeholder_count,
    // Deliverable rollup (2026_64) — drives the list-row chips.
    playsOverdue:       r.r_plays_overdue        ?? 0,
    gatesOpen:          r.r_gates_open           ?? 0,
    commitmentsTotal:   r.r_commitments_total    ?? 0,
    commitmentsClosed:  r.r_commitments_closed   ?? 0,
    commitmentsOverdue: r.r_commitments_overdue  ?? 0,
    daysToGoLive:       r.r_days_to_go_live      ?? null,
    isCloseable:        r.r_is_closeable         ?? null,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// GET BY ID — full detail
// ═══════════════════════════════════════════════════════════════════════════

async function getById(handoverId, orgId, userId = null) {
  const { rows } = await pool.query(
    `SELECT
       h.*,
       d.name                                    AS deal_name,
       d.stage                                   AS deal_stage,
       a.name                                    AS account_name,
       u_so.first_name || ' ' || u_so.last_name  AS service_owner_name,
       u_cb.first_name || ' ' || u_cb.last_name  AS created_by_name,
       pb.name                                   AS playbook_name,
       pb.gate_enforcement                       AS playbook_gate_enforcement
     FROM sales_handovers h
     LEFT JOIN deals    d ON d.id  = h.deal_id
     LEFT JOIN accounts a ON a.id  = h.account_id
     LEFT JOIN users u_so ON u_so.id = h.assigned_service_owner_id
     LEFT JOIN users u_cb ON u_cb.id = h.created_by
     LEFT JOIN playbooks pb ON pb.id = h.playbook_id
     WHERE h.id = $1 AND h.org_id = $2`,
    [handoverId, orgId]
  );

  if (rows.length === 0) throw Object.assign(new Error('Handover not found'), { status: 404 });

  const handover = fmt(rows[0]);

  // Load stakeholders
  const stakeholders = await _getStakeholders(handoverId, orgId);

  // Load commitments
  const commitments = await _getCommitments(handoverId, orgId);

  // Who the viewer is relative to this project (2026_120). Resolved once and
  // used for both the note badges below and canAddNotes, rather than twice.
  const noteCtx = userId ? await _projectNoteContext(handoverId, orgId, userId) : null;

  // Load plays
  const plays = await _getPlays(handoverId, orgId, !!noteCtx?.isInternalCustomer);

  // Load the project team (deal_team_members → org_roles) so the Summary can
  // show who is on the project and the role each person plays.
  const dealTeam = await _getDealTeam(handover.dealId, orgId);

  const playbook = rows[0].playbook_name
    ? { id: handover.playbookId, name: rows[0].playbook_name, gateEnforcement: rows[0].playbook_gate_enforcement }
    : null;

  return {
    ...handover, stakeholders, commitments, plays, dealTeam, playbook,
    contactAddPolicy:      rows[0].contact_add_policy || { deal_owner: true, service_owner: true, admins: true, named_users: [] },
    canAddContacts:        userId ? await canAddContacts(handoverId, orgId, userId) : false,
    canEditContactPolicy:  userId ? await canEditContactPolicy(handoverId, orgId, userId) : false,
    projectMembers:        (await projectMembers.listForHandover(handoverId, orgId)).members,
    canRequestMember:      !!userId,
    isProjectAdmin:        userId ? await _isOrgAdmin(orgId, userId) : false,
    canSeeCommercial:      userId ? await canSeeTab(handoverId, orgId, userId, 'commercial') : false,
    canManageTabAccess:    userId ? await canManageTabAccess(handoverId, orgId, userId) : false,
    // 2026_120. Deliberately NOT salesCanEdit, which is `isDraft && …` — notes
    // are most useful once a project is running, which is exactly when that
    // flag is false.
    canAddNotes:           !!noteCtx?.canNote,
    canMarkNotesInternal:  !!noteCtx?.canNote && !noteCtx?.isInternalCustomer,
    commercialViewers:     (await getTabViewers(handoverId, orgId, 'commercial')).viewers,
    signoff:               await _signoffState(handoverId, orgId),
  };
}

/** Internal project team on the deal, with the org-role each member holds. */
async function _getDealTeam(dealId, orgId) {
  if (dealId == null) return [];
  const { rows } = await pool.query(
    `SELECT dtm.user_id,
            u.first_name || ' ' || u.last_name AS name,
            u.email,
            -- The person drawer edits these. Without them it opened with empty
            -- boxes over a number that already existed, and the first blur
            -- wrote NULL over it.
            u.phone, u.whatsapp_phone,
            r.name AS role_name, r.key AS role_key,
            dtm.custom_role, r.sort_order
       FROM deal_team_members dtm
       JOIN users u ON u.id = dtm.user_id
       LEFT JOIN org_roles r ON r.id = dtm.role_id
      WHERE dtm.deal_id = $1 AND dtm.org_id = $2
      ORDER BY r.sort_order NULLS LAST, dtm.id`,
    [dealId, orgId]
  );
  return rows.map(row => ({
    userId:  row.user_id,
    name:    row.name,
    email:   row.email,
    role:    row.role_name || row.custom_role || 'Team member',
    roleKey: row.role_key || null,
    // Same keys the project-members list uses, so the person drawer reads one
    // shape regardless of which list opened it.
    phone:         row.phone || null,
    whatsappPhone: row.whatsapp_phone || null,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE core fields (draft only)
// ═══════════════════════════════════════════════════════════════════════════

async function update(handoverId, orgId, data) {
  const existing = await _getHandover(handoverId, orgId);

  // Editing used to stop at 'draft'. That made sense when a submitted handover
  // was a document being passed between two parties, but a project is a live
  // thing — dates move, owners change, budgets get revised — and locking those
  // fields the moment work starts forced people to recall a project to draft to
  // correct a typo.
  //
  // Now blocked only once the project is terminal. A completed or cancelled
  // project is a record of what happened and must not be rewritten; reopen it
  // first if it genuinely needs to change.
  if (TERMINAL_STATUSES.has(existing.status)) {
    throw Object.assign(
      new Error(`A ${existing.status} project cannot be edited. Reopen it first if it needs to change.`),
      { status: 400 });
  }

  const {
    assignedServiceOwnerId,
    goLiveDate,
    contractValue,
    commercialTermsSummary,
  } = data;

  const { rows } = await pool.query(
    `UPDATE sales_handovers
     SET assigned_service_owner_id = COALESCE($1, assigned_service_owner_id),
         go_live_date              = COALESCE($2, go_live_date),
         contract_value            = COALESCE($3, contract_value),
         commercial_terms_summary  = COALESCE($4, commercial_terms_summary),
         updated_at                = NOW()
     WHERE id = $5 AND org_id = $6
     RETURNING *`,
    [
      assignedServiceOwnerId ?? null,
      goLiveDate ?? null,
      contractValue ?? null,
      commercialTermsSummary ?? null,
      handoverId,
      orgId,
    ]
  );

  // Keep project membership in step with the owner column. Without this the
  // person accountable for the project is missing from "Project team & roles",
  // and every view built on membership silently excludes them.
  const newOwnerId = rows[0]?.assigned_service_owner_id;
  if (newOwnerId) {
    await pool.query(
      `INSERT INTO project_members
         (org_id, context_type, context_id, user_id, custom_role, status,
          requested_by, reviewed_by, reviewed_at)
       VALUES ($1, 'handover', $2, $3, 'Project owner', 'approved', $3, $3, now())
       ON CONFLICT (context_type, context_id, user_id) DO UPDATE
         SET status      = 'approved',
             -- The label MUST be re-applied here. Without it, promoting someone
             -- already on the team (very common — they were demoted by an
             -- earlier reassignment) left them as 'Team member', and the demote
             -- below then cleared the outgoing owner too, leaving the project
             -- with no owner at all despite the column being set.
             custom_role = 'Project owner',
             exited_at   = NULL,
             exit_reason = NULL`,
      [orgId, handoverId, newOwnerId]
    ).catch(err => console.warn('[handover] owner membership sync failed:', err.message));

    // Reassigning the owner must also un-label the previous one, or the project
    // ends up showing two "Project owner" rows — the column holds one person,
    // so the team list must not claim otherwise.
    //
    // Demoted rather than removed: the outgoing owner is usually still involved,
    // and deleting the row would also discard their membership history. Only
    // rows carrying the label WE applied are touched — a member with a
    // hand-entered role keeps it.
    await pool.query(
      `UPDATE project_members
          SET custom_role = 'Team member'
        WHERE context_type = 'handover'
          AND context_id   = $1
          AND org_id       = $2
          AND user_id     <> $3
          AND custom_role  = 'Project owner'`,
      [handoverId, orgId, newOwnerId]
    ).catch(err => console.warn('[handover] previous owner demotion failed:', err.message));
  }

  return fmt(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// ADVANCE STATUS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {number} handoverId
 * @param {number} orgId
 * @param {number} userId
 * @param {string} toStatus
 * @param {string} [closureSummary]  — required for 'cancelled', optional for 'completed'
 */
async function advanceStatus(handoverId, orgId, userId, toStatus, closureSummary = null) {
  const existing = await _getHandover(handoverId, orgId);

  assertTransition(existing.status, toStatus, existing.projectKind || 'customer');

  // Gate check: cannot submit unless all is_gate plays are complete
  //
  // BUGFIX: this block previously read
  //     const { canSubmit, incompleteGates } = await canSubmit(handoverId, orgId);
  // The `const canSubmit` destructure creates a block-scoped binding that
  // SHADOWS the module-level canSubmit() function, and the initialiser then
  // references that binding while it is still in its temporal dead zone.
  // Result: every single submit threw
  //     ReferenceError: Cannot access 'canSubmit' before initialization
  // and the route returned a 500 — the gate was never actually evaluated,
  // because nothing got as far as evaluating it. Renaming the destructured
  // field resolves the shadowing.
  if (toStatus === 'submitted') {
    const gateCheck = await canSubmit(handoverId, orgId);
    if (!gateCheck.canSubmit) {
      const titles = gateCheck.incompleteGates.map(g => `"${g.title}"`).join(', ');
      throw Object.assign(
        new Error(`Cannot submit: incomplete required sections: ${titles}`),
        { status: 400 }
      );
    }
  }

  // Closure gate: cannot complete unless every gate play AND every commitment
  // has reached a terminal state. Mirrors the submit gate above.
  if (toStatus === 'completed') {
    const closeCheck = await canClose(handoverId, orgId);
    if (!closeCheck.canClose) {
      throw Object.assign(
        new Error(`Cannot complete: ${closeCheck.blockers.join('; ')}`),
        { status: 400 }
      );
    }
  }

  // Permission check.
  // On an internal project the sales/service split does not exist — the creator
  // and the project manager are the two accountable people. Gating 'in_progress'
  // on the service role would stop a creator from starting their own project
  // whenever someone else is named manager.
  const isInternalKind = (existing.projectKind || 'customer') === 'internal';
  const requiredRole = isInternalKind ? 'either' : TRANSITION_ROLES[toStatus];
  if (requiredRole === 'sales' && existing.createdBy !== userId) {
    throw Object.assign(new Error('Only the handover creator can perform this action'), { status: 403 });
  }
  if (requiredRole === 'service' && existing.assignedServiceOwnerId !== userId) {
    throw Object.assign(new Error('Only the assigned service owner can perform this action'), { status: 403 });
  }
  if (requiredRole === 'either'
      && existing.createdBy !== userId
      && existing.assignedServiceOwnerId !== userId) {
    throw Object.assign(
      new Error('Only the handover creator or assigned service owner can perform this action'),
      { status: 403 }
    );
  }

  // Cancelling destroys the delivery commitment, so it must be explained.
  // Completion does not require a summary, but accepts one.
  if (toStatus === 'cancelled' && !String(closureSummary || '').trim()) {
    throw Object.assign(
      new Error('closureSummary is required when cancelling a handover'),
      { status: 400 }
    );
  }

  const timestampField = {
    submitted:    'submitted_at',
    acknowledged: 'acknowledged_at',
    completed:    'completed_at',
    cancelled:    'cancelled_at',
  }[toStatus];

  const actorField = {
    completed: 'completed_by',
    cancelled: 'cancelled_by',
  }[toStatus];

  const sets = ['status = $1'];
  const params = [toStatus];

  if (timestampField) sets.push(`${timestampField} = NOW()`);
  if (actorField) {
    params.push(userId);
    sets.push(`${actorField} = $${params.length}`);
  }
  if (TERMINAL_STATUSES.has(toStatus) && closureSummary != null) {
    params.push(String(closureSummary).trim());
    sets.push(`closure_summary = $${params.length}`);
  }
  sets.push('updated_at = NOW()');

  params.push(handoverId, orgId);

  const { rows } = await pool.query(
    `UPDATE sales_handovers
     SET ${sets.join(', ')}
     WHERE id = $${params.length - 1} AND org_id = $${params.length}
     RETURNING *`,
    params
  );

  // 2026_118: leaving draft freezes the plan.
  //
  // Fires on the transition OUT of 'draft' — 'submitted' for customer
  // projects, 'in_progress' for internal ones — rather than at 'in_progress'
  // for both. A customer plan sits in submitted/acknowledged while the
  // delivery team reviews it; that is exactly when the dates must stop moving.
  //
  // Awaited, not fire-and-forget: the caller reloads the checklist immediately
  // and would otherwise race the recompute and render stale dates.
  if (existing.status === 'draft' && toStatus !== 'draft') {
    try {
      await freezePlanOnStart(handoverId, orgId);
    } catch (err) {
      // A failed freeze must not strand the project mid-transition — the
      // status change is the user's intent and has already been written.
      console.error(
        `[handover.service] plan freeze failed (handover=${handoverId}):`, err.message);
    }
  }

  // On terminal transition, resolve any outstanding handover diagnostics so a
  // completed handover stops generating alerts in the rep's action queue.
  if (TERMINAL_STATUSES.has(toStatus)) {
    ActionPersister.resolveStaleDiagnostics(
      { orgId, entityType: 'project', entityId: handoverId, firedRules: [] }
    ).catch(err => console.error(
      `[handover.service] diagnostic cleanup failed (handover=${handoverId}):`, err.message
    ));
  }

  return fmt(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLOSURE GATE — can this handover be marked completed?
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A handover may only be completed when every required (is_gate) play and
 * every commitment has reached a terminal state. Reads the rollup view so the
 * predicate lives in exactly one place (see 2026_64 migration).
 *
 * @param {number} handoverId
 * @param {number} orgId
 * @returns {Promise<{canClose:boolean, blockers:string[], rollup:object|null}>}
 */
async function canClose(handoverId, orgId) {
  const { rows: [r] } = await pool.query(
    `SELECT * FROM handover_deliverable_rollup
     WHERE handover_id = $1 AND org_id = $2`,
    [handoverId, orgId]
  );

  if (!r) return { canClose: false, blockers: ['Handover not found'], rollup: null };

  const blockers = [];
  if (Number(r.gates_open) > 0) {
    blockers.push(`${r.gates_open} required section${r.gates_open === '1' ? '' : 's'} still open`);
  }
  const openCommitments = Number(r.commitments_total) - Number(r.commitments_closed);
  if (openCommitments > 0) {
    blockers.push(`${openCommitments} commitment${openCommitments === 1 ? '' : 's'} not yet resolved`);
  }

  // Internal-customer sign-off.
  //
  // Only bites when BOTH are true: the org has turned the hard gate on, AND an
  // internal customer has actually been named on this project. Gating a project
  // that has no named acceptor would strand it with nobody able to unblock it —
  // so an org that switches to 'hard' does not retroactively freeze every
  // project that predates the setting.
  const signoff = await _signoffState(handoverId, orgId);
  if (signoff.mode === 'hard' && signoff.acceptors.length && !signoff.signedOffAt) {
    const names = signoff.acceptors.map(a => a.name).join(', ');
    blockers.push(`awaiting sign-off from ${names}`);
  }

  return { canClose: blockers.length === 0, blockers, rollup: r, signoff };
}

/**
 * Who has to accept this project, whether they have, and whether it blocks.
 *
 * Acceptors are project_members with side = 'internal_customer' — users, never
 * contacts. The person the work is FOR.
 */
async function _signoffState(handoverId, orgId) {
  const projectSettings = require('./projectSettings.service');
  const cfg = await projectSettings.get(orgId);

  const { rows } = await pool.query(
    `SELECT pm.user_id, (u.first_name || ' ' || u.last_name) AS name
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.context_type = 'handover' AND pm.context_id = $1 AND pm.org_id = $2
        AND pm.side = 'internal_customer' AND pm.status = 'approved'
      ORDER BY name`,
    [handoverId, orgId]
  );

  const { rows: [h] } = await pool.query(
    `SELECT signed_off_by, signed_off_at, signoff_note,
            (su.first_name || ' ' || su.last_name) AS signed_off_by_name
       FROM sales_handovers sh
       LEFT JOIN users su ON su.id = sh.signed_off_by
      WHERE sh.id = $1 AND sh.org_id = $2`,
    [handoverId, orgId]
  );

  return {
    mode:            cfg.closure_signoff_mode || 'soft',
    acceptors:       rows.map(r => ({ userId: r.user_id, name: r.name })),
    signedOffAt:     h?.signed_off_at || null,
    signedOffBy:     h?.signed_off_by || null,
    signedOffByName: h?.signed_off_by_name || null,
    note:            h?.signoff_note || null,
  };
}

/**
 * Record that the internal customer accepts the project as done.
 *
 * Only a named acceptor may do this. Deliberately NOT open to the project
 * manager or an org admin — the whole point is that somebody other than the
 * people doing the work agrees it is finished, and letting an admin sign on
 * their behalf would make the record say something untrue.
 */
async function signOff(handoverId, orgId, userId, note = null) {
  const state = await _signoffState(handoverId, orgId);

  if (!state.acceptors.length) {
    throw Object.assign(
      new Error('No internal customer has been named on this project yet. Add one to the Customer team first.'),
      { status: 400 });
  }
  if (!state.acceptors.some(a => a.userId === userId)) {
    throw Object.assign(
      new Error('Only the named internal customer can sign this project off'), { status: 403 });
  }
  if (state.signedOffAt) return { alreadySignedOff: true, ...state };

  const { rows } = await pool.query(
    `UPDATE sales_handovers
        SET signed_off_by = $3, signed_off_at = now(), signoff_note = $4
      WHERE id = $1 AND org_id = $2
      RETURNING signed_off_at`,
    [handoverId, orgId, userId, note ? String(note).trim() : null]
  );
  if (!rows.length) throw Object.assign(new Error('Project not found'), { status: 404 });

  return { ...(await _signoffState(handoverId, orgId)), alreadySignedOff: false };
}

/** Withdraw a sign-off. Same authority as giving it. */
async function revokeSignOff(handoverId, orgId, userId) {
  const state = await _signoffState(handoverId, orgId);
  if (!state.acceptors.some(a => a.userId === userId)) {
    throw Object.assign(new Error('Only the named internal customer can withdraw sign-off'), { status: 403 });
  }
  await pool.query(
    `UPDATE sales_handovers SET signed_off_by = NULL, signed_off_at = NULL, signoff_note = NULL
      WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
  return _signoffState(handoverId, orgId);
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE CHECK — can this handover be submitted?
// ═══════════════════════════════════════════════════════════════════════════

async function canSubmit(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT ppi.id, ppi.title, ppi.is_gate, ppi.status AS play_status
     FROM project_play_instances ppi
     WHERE ppi.handover_id = $1 AND ppi.org_id = $2
       AND ppi.is_gate = TRUE
       AND ppi.status NOT IN ('completed', 'skipped')`,
    [handoverId, orgId]
  );

  return {
    canSubmit:      rows.length === 0,
    incompleteGates: rows.map(r => ({ id: r.id, title: r.title, status: r.play_status })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAKEHOLDER CRUD
// ═══════════════════════════════════════════════════════════════════════════

async function addStakeholder(handoverId, orgId, userId, data) {
  if (!(await canAddContacts(handoverId, orgId, userId)))
    throw Object.assign(new Error('You do not have permission to add contacts to this project'), { status: 403 });

  let contactId = data.contactId ? parseInt(data.contactId, 10) : null;

  // Create a new contact when one wasn't picked (name + optional phone/email).
  if (!contactId) {
    const full = String(data.name || '').trim();
    if (!full) throw Object.assign(new Error('Select an existing contact or provide a name'), { status: 400 });
    const parts = full.split(/\s+/);
    const first = parts.shift();
    const last  = parts.join(' ') || first;   // contacts.last_name is NOT NULL
    const { rows: [ho] } = await pool.query(
      `SELECT account_id FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
    const { rows: [c] } = await pool.query(
      `INSERT INTO contacts (org_id, account_id, first_name, last_name, phone, email)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, ho?.account_id ?? null, first, last, data.phone || null, data.email || null]);
    contactId = c.id;
  }

  // Which side of the table this person sits on, for THIS project. Not derived
  // from their account: the same firm is a vendor on one project and the
  // customer on the next, with the same people.
  const side = ['customer', 'vendor', 'partner'].includes(data.side) ? data.side : 'customer';

  // project_contacts_role_chk was dropped in 2026_93 because roles are
  // configurable, so this is the only thing between a typo and an unrenderable
  // label.
  const contactRoles = require('./contactRoles.service');
  const role = await contactRoles.resolveRoleKey(orgId, side, data.handoverRole || data.role || 'other');

  const { rows: [pc] } = await pool.query(
    `INSERT INTO project_contacts
       (org_id, context_type, context_id, contact_id, role, side, is_primary, notes, created_by)
     VALUES ($1, 'handover', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (context_type, context_id, contact_id)
       DO UPDATE SET role = EXCLUDED.role, side = EXCLUDED.side,
                     is_primary = EXCLUDED.is_primary, notes = EXCLUDED.notes
     RETURNING id`,
    [orgId, handoverId, contactId, role, side, !!data.isPrimaryContact, data.relationshipNotes || null, userId]);

  // A vendor or partner joining a project changes which projects that account's
  // bound conversations could be about — the candidate shortlist Phase 3 files
  // against. Only the vendor sides matter: a customer-side contact does not
  // widen any vendor group's shortlist.
  //
  // Fire-and-forget. The nightly reconciler is the guarantee; this only saves
  // the rep waiting until tomorrow for the new project to appear.
  if (side === 'vendor' || side === 'partner') {
    const sync = require('./conversationCandidateSync.service');
    sync.accountForContact(orgId, contactId)
      .then(accountId => sync.resyncSoon(orgId, accountId, 'vendor added to project'))
      .catch(err => console.warn(`[candidate-sync] stakeholder add hook: ${err.message}`));
  }

  const list = await _getStakeholders(handoverId, orgId);
  return list.find(s => s.id === pc.id) || null;
}

async function removeStakeholder(handoverId, orgId, stakeholderId) {
  // Read the contact and side BEFORE the delete — afterwards there is nothing
  // left to resolve the account from, and the candidate set cannot be corrected
  // without knowing which account to recompute.
  const { rows: [before] } = await pool.query(
    `SELECT contact_id, side FROM project_contacts
      WHERE id = $1 AND context_type = 'handover' AND context_id = $2 AND org_id = $3`,
    [stakeholderId, handoverId, orgId]
  );

  const { rowCount } = await pool.query(
    `DELETE FROM project_contacts
      WHERE id = $1 AND context_type = 'handover' AND context_id = $2 AND org_id = $3`,
    [stakeholderId, handoverId, orgId]
  );
  if (rowCount === 0) throw Object.assign(new Error('Project contact not found'), { status: 404 });

  // Removing the LAST vendor contact on a project drops it from that account's
  // shortlist. Removing one of several changes nothing — resyncForAccount
  // recomputes rather than decrements, so it gets that right without this hook
  // needing to know how many were left.
  if (before && (before.side === 'vendor' || before.side === 'partner')) {
    const sync = require('./conversationCandidateSync.service');
    sync.accountForContact(orgId, before.contact_id)
      .then(accountId => sync.resyncSoon(orgId, accountId, 'vendor removed from project'))
      .catch(err => console.warn(`[candidate-sync] stakeholder remove hook: ${err.message}`));
  }

  return { deleted: true, id: stakeholderId };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMITMENT CRUD
// ═══════════════════════════════════════════════════════════════════════════

const COMMITMENT_STATUSES = ['open', 'in_progress', 'met', 'waived', 'breached'];
const COMMITMENT_TERMINAL = ['met', 'waived', 'breached'];

async function addCommitment(handoverId, orgId, userId, data) {
  const {
    description,
    commitmentType = 'promise',
    dueDate     = null,
    ownerUserId = null,
  } = data;

  if (!description) throw Object.assign(new Error('description is required'), { status: 400 });

  const { rows } = await pool.query(
    `INSERT INTO sales_handover_commitments
       (handover_id, org_id, description, commitment_type, created_by, due_date, owner_user_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
     RETURNING *`,
    [handoverId, orgId, description.trim(), commitmentType, userId,
     dueDate || null, ownerUserId || null]
  );

  // Phase 8 — re-run diagnostic rules after a commitment is added.
  // Resolves handover_stalled (activity occurred) and may set
  // handover_commitment_overdue if the commitment already has a past due_date.
  // Non-blocking: commitment creation is never delayed by this.
  generateForHandoverEvent(handoverId, orgId, 'commitment_added')
    .catch(err => console.error(
      `[handover.service] addCommitment event trigger error (handover=${handoverId}):`,
      err.message
    ));

  return fmtCommitment(rows[0]);
}

/**
 * Update a commitment: retarget its date/owner, or drive it to closure.
 *
 * This is the endpoint the module was missing entirely — a commitment could
 * only be created or destroyed, which is why "tracked to closure" was not
 * expressible. Closing a commitment stamps closed_at/closed_by server-side;
 * the client never supplies those.
 *
 * @param {object} data  { description?, commitmentType?, dueDate?, ownerUserId?,
 *                         status?, closureNote? }
 */
async function updateCommitment(handoverId, orgId, userId, commitmentId, data) {
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM sales_handover_commitments WHERE id = $1 AND handover_id = $2 AND org_id = $3',
    [commitmentId, handoverId, orgId]
  );
  if (!existing) throw Object.assign(new Error('Commitment not found'), { status: 404 });

  const sets = [];
  const params = [];
  const push = (frag, val) => { params.push(val); sets.push(`${frag} = $${params.length}`); };

  if (data.description !== undefined) {
    if (!String(data.description).trim()) {
      throw Object.assign(new Error('description cannot be empty'), { status: 400 });
    }
    push('description', String(data.description).trim());
  }
  if (data.commitmentType !== undefined) push('commitment_type', data.commitmentType);
  if (data.dueDate     !== undefined) push('due_date',      data.dueDate || null);
  if (data.ownerUserId !== undefined) push('owner_user_id', data.ownerUserId || null);

  if (data.status !== undefined) {
    if (!COMMITMENT_STATUSES.includes(data.status)) {
      throw Object.assign(
        new Error(`status must be one of: ${COMMITMENT_STATUSES.join(', ')}`),
        { status: 400 }
      );
    }

    const goingTerminal   = COMMITMENT_TERMINAL.includes(data.status);
    const needsExplanation = ['waived', 'breached'].includes(data.status);
    const note = data.closureNote !== undefined ? data.closureNote : existing.closure_note;

    if (needsExplanation && !String(note || '').trim()) {
      throw Object.assign(
        new Error(`closureNote is required when marking a commitment '${data.status}'`),
        { status: 400 }
      );
    }

    push('status', data.status);

    if (goingTerminal) {
      // Preserve the original closure stamp if it was already terminal —
      // re-saving a closed commitment shouldn't rewrite who closed it.
      if (!COMMITMENT_TERMINAL.includes(existing.status)) {
        sets.push('closed_at = NOW()');
        push('closed_by', userId);
      }
    } else {
      // Reopening: clear the stamp so the DB CHECK stays satisfied.
      sets.push('closed_at = NULL', 'closed_by = NULL');
    }
  }

  if (data.closureNote !== undefined) push('closure_note', data.closureNote || null);

  if (sets.length === 0) return fmtCommitment(existing);

  params.push(commitmentId, handoverId, orgId);
  const { rows } = await pool.query(
    `UPDATE sales_handover_commitments
     SET ${sets.join(', ')}
     WHERE id = $${params.length - 2} AND handover_id = $${params.length - 1} AND org_id = $${params.length}
     RETURNING *`,
    params
  );

  // Append to the activity log (what happened on this deliverable).
  const _updated = rows[0];
  const _evs = [];
  if (data.status !== undefined && data.status !== existing.status) {
    const isClose = COMMITMENT_TERMINAL.includes(data.status);
    _evs.push([isClose ? 'closed' : 'status_change',
               isClose ? (_updated.closure_note || null) : null, existing.status, data.status]);
  }
  if (data.ownerUserId !== undefined && (data.ownerUserId || null) !== existing.owner_user_id) {
    _evs.push(['owner_change', null, null, null]);
  }
  for (const [etype, detail, from, to] of _evs) {
    await pool.query(
      `INSERT INTO sales_handover_commitment_events
         (commitment_id, org_id, event_type, detail, from_status, to_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [commitmentId, orgId, etype, detail, from, to, userId]
    );
  }

  // Re-run diagnostics: closing the last overdue commitment should clear
  // handover_commitment_overdue immediately, not at 01:45 tomorrow.
  generateForHandoverEvent(handoverId, orgId, 'commitment_updated')
    .catch(err => console.error(
      `[handover.service] updateCommitment event trigger error (handover=${handoverId}):`,
      err.message
    ));

  return fmtCommitment(rows[0]);
}

async function removeCommitment(handoverId, orgId, commitmentId) {
  // NOTE: deletion remains available, but the UI should now route "this is
  // done"/"we didn't do it" through updateCommitment() instead. Deleting a
  // commitment erases the evidence that a promise was ever made, which is
  // precisely the record you want at renewal time.
  const { rowCount } = await pool.query(
    'DELETE FROM sales_handover_commitments WHERE id = $1 AND handover_id = $2 AND org_id = $3',
    [commitmentId, handoverId, orgId]
  );
  if (rowCount === 0) throw Object.assign(new Error('Commitment not found'), { status: 404 });
  return { deleted: true, id: commitmentId };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETE A PLAY (handover-aware wrapper around PlaybookPlayService)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Complete a handover play instance. completed_at lives on the instance
 * itself; there is no longer a link table to keep in step.
 *
 * @param {number} handoverId
 * @param {number} playInstanceId  — project_play_instances.id
 * @param {number} userId
 * @param {number} orgId
 */
async function completePlay(handoverId, playInstanceId, userId, orgId, data = {}) {
  // Verify the play belongs to this handover
  const linkResult = await pool.query(
    'SELECT id FROM project_play_instances WHERE handover_id = $1 AND id = $2 AND org_id = $3',
    [handoverId, playInstanceId, orgId]
  );

  if (linkResult.rows.length === 0) {
    throw Object.assign(new Error('Play does not belong to this handover'), { status: 404 });
  }

  // 2026_117: the same prerequisite rule that blocks Start also blocks Done.
  // Guarding only the start would leave the rule trivially bypassable — a user
  // who cannot start a task could still mark it complete, which is the more
  // consequential action of the two.
  const stageBlockers = await _stageBlockers(playInstanceId, orgId);
  if (stageBlockers.length) {
    throw Object.assign(
      new Error(`This stage is locked until ${stageBlockers.join(', ')} clears its gates.`),
      { status: 409, code: 'STAGE_LOCKED', stageBlockedBy: stageBlockers });
  }

  const outstanding = await _outstandingPrereqs(playInstanceId, orgId);
  if (outstanding.length) {
    throw Object.assign(
      new Error(`Blocked by: ${outstanding.map(p => p.title).join(', ')}. `
              + 'Complete those first, or remove the dependency.'),
      { status: 409, code: 'PREREQ_INCOMPLETE', blockedBy: outstanding });
  }

  // 2026_118: evidence requirement. Enforced server-side as well as in the UI
  // — a disabled button is a hint, not a rule, and this endpoint is reachable
  // directly.
  //
  // The evidence REFERENCE is what satisfies the requirement, not the note: a
  // note is free text anyone can fill with anything, whereas the evidence
  // field points at the artefact that closed the task.
  const policy = await _evidencePolicy(handoverId, orgId);
  const { rows: [gateRow] } = await pool.query(
    `SELECT is_gate FROM project_play_instances WHERE id = $1 AND org_id = $2`,
    [playInstanceId, orgId]);
  const needsEvidence = policy.required
    || (policy.requiredForGates && gateRow?.is_gate === true);
  const hasEvidence = Boolean(
    data?.completionEvidence && String(data.completionEvidence.snippet || '').trim());
  if (needsEvidence && !hasEvidence) {
    throw Object.assign(
      new Error(gateRow?.is_gate
        ? 'This is a gate task — evidence is required to close it.'
        : 'Evidence is required to close tasks on this project.'),
      { status: 400, code: 'EVIDENCE_REQUIRED' });
  }

  // Delegate to the project-scoped method. The deal-scoped completePlay()
  // reads deal_play_instances and would no longer find this row.
  const { instance } = await PlaybookPlayService.completePlayForProject(
    playInstanceId, userId, orgId
  );

  // No link-table sync: completed_at lives on the instance itself now, and
  // sales_handover_plays is no longer written.

  // Phase 6 — fire next sequential play.
  //
  // 2026_109: this used to load the handover's deal_id and pass that, because
  // MODULE_CONFIG.handover keyed actions off deal_id. It now passes the
  // project id directly, which is what makes this work for an internal
  // project — those have no deal, so the old code returned early and no next
  // play ever fired for them.
  //
  // Non-blocking: next-play failure must not disrupt the completion response.
  if (instance.play_id) {
    Promise.resolve(
      PlayCompletionService.fireNextPlay('handover', handoverId, instance.play_id, orgId, userId)
    ).catch(err => console.error(
      `[handover.service] next-play hook failed for handover ${handoverId} play ${instance.play_id}:`,
      err.message
    ));
  }

  // Manual completion evidence: a note + optional reference to the comm that
  // closed it (mirrors the actions-engine completion_evidence pattern).
  if (data.completionNote != null || data.completionEvidence != null) {
    await pool.query(
      `UPDATE project_play_instances
          SET completion_note = COALESCE($1, completion_note),
              completion_evidence = COALESCE($2::jsonb, completion_evidence)
        WHERE id = $3 AND org_id = $4`,
      [data.completionNote ?? null,
       data.completionEvidence != null ? JSON.stringify(data.completionEvidence) : null,
       playInstanceId, orgId]
    );
  }

  return { instance };
}

// ═══════════════════════════════════════════════════════════════════════════
// AD-HOC CHECKLIST ITEMS — added directly on a handover (not from a playbook)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add a one-off checklist item to a handover. It is a deal_play_instance with
 * no playbook/template behind it (play_id and playbook_id NULL) — so it never
 * fires downstream plays and is safe to delete. It shows in the checklist under
 * an "Added on this handover" group.
 */
async function addPlay(handoverId, orgId, userId, data = {}) {
  const title = (data.title || '').trim();
  if (!title) throw Object.assign(new Error('A title is required.'), { status: 400 });

  const { rows: [h] } = await pool.query(
    `SELECT deal_id FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]
  );
  if (!h) throw Object.assign(new Error('Handover not found'), { status: 404 });

  const ownerUserId = data.ownerUserId ? parseInt(data.ownerUserId, 10) : null;
  const isGate = data.isGate === true;
  const dueDate = data.dueDate || null;

  // stage_key: an ad-hoc item now joins a real stage when the caller names
  // one. It previously always went to 'custom', which parked every ad-hoc
  // play outside the project's actual phases.
  //
  // 2026_115: normalised through _stageKeyFrom so "UAT" and "uat" land in one
  // group, and auto-registered in project_stages if unknown — a stage_key
  // with no definition anywhere still sorts NULLS LAST, so creating the play
  // without the definition would put it in the wrong place on the very first
  // render.
  const stageKey = _stageKeyFrom(data.stageKey) || 'custom';
  if (stageKey !== 'custom') {
    await _ensureStageExists(handoverId, orgId, userId, stageKey, data.stageName);
  }

  // sort_order: previously hardcoded 9000, so every ad-hoc play tied with
  // every other and their relative order was whatever Postgres returned.
  // Now it lands at the end of its stage, on the sparse 10-step scale that
  // leaves room to insert between two existing plays.
  const { rows: [{ next_order: nextOrder }] } = await pool.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order
       FROM project_play_instances
      WHERE handover_id = $1 AND org_id = $2 AND stage_key = $3`,
    [handoverId, orgId, stageKey]
  );

  const { rows: [inst] } = await pool.query(
    `INSERT INTO project_play_instances
       (handover_id, org_id, playbook_id, play_id, stage_key, title, description,
        channel, priority, execution_type, is_gate, due_date, due_anchor,
        sort_order, status, owner_user_id)
     VALUES ($1, $2, NULL, NULL, $3, $4, $5,
             'internal_task', 'medium', 'parallel', $6, $7, 'created',
             $8, 'not_started', $9)
     RETURNING id`,
    [handoverId, orgId, stageKey, title, (data.description || '').trim() || null,
     isGate, dueDate, nextOrder, ownerUserId]
  );

  const plays = await _getPlays(handoverId, orgId);
  return { play: plays.find(p => p.playInstanceId === inst.id) || null };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT STAGES (2026_115)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalise a user-supplied stage name into a stable key.
 *
 * Lowercased, non-alphanumerics collapsed to underscores. This is what stops
 * "UAT", "uat" and "U.A.T." becoming three separate groups on the same
 * project — the single most likely way a free-text stage field degrades once
 * a few hundred projects are using it.
 */
function _stageKeyFrom(input) {
  return String(input || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/**
 * Copy the org's stage catalogue for a playbook's pipeline into a project.
 *
 * 2026_116. This is the stage-level equivalent of what
 * PlaybookPlayService already does for plays: playbook_plays ->
 * project_play_instances. The project ends up owning its stages, so editing
 * the org catalogue later does not relabel or reorder a running project.
 *
 * Existing rows are left alone (ON CONFLICT DO NOTHING) — a stage the project
 * has already renamed or repositioned must not be reset by a playbook swap.
 *
 * The pipeline mapping MUST stay in step with playbook-plays.routes.js, which
 * validates stage keys on the way in. If the two diverge, a stage key
 * validates at creation and then fails to resolve at read time.
 */
async function _materializeStagesFromCatalogue(handoverId, orgId, playbookId, userId = null) {
  if (!playbookId) return { materialized: 0 };

  const { rows: [pb] } = await pool.query(
    `SELECT type FROM playbooks WHERE id = $1 AND org_id = $2`, [playbookId, orgId]);
  if (!pb) return { materialized: 0 };

  const SALES_LEGACY = ['sales', 'custom', 'market', 'product'];
  const pipeline = SALES_LEGACY.includes(pb.type) ? 'sales' : pb.type;

  const { rowCount } = await pool.query(
    `INSERT INTO project_stages (handover_id, org_id, key, name, sort_order, source, created_by)
     SELECT $1, $2, pls.key, pls.name, pls.sort_order, 'catalogue', $4
       FROM pipeline_stages pls
      WHERE pls.org_id = $2 AND pls.pipeline = $3 AND pls.is_active = TRUE
     ON CONFLICT (handover_id, key) DO NOTHING`,
    [handoverId, orgId, pipeline, userId]);

  // The ad-hoc bucket always exists. Named to match what the UI showed before
  // project_stages became authoritative — do not change this string.
  await pool.query(
    `INSERT INTO project_stages (handover_id, org_id, key, name, sort_order, source, created_by)
     VALUES ($1, $2, 'custom', 'Added on this project', 9000, 'custom', $3)
     ON CONFLICT (handover_id, key) DO NOTHING`,
    [handoverId, orgId, userId]);

  return { materialized: rowCount, pipeline };
}

/**
 * Make sure a stage_key has a definition before a play is filed under it.
 *
 * No-op when the project's playbook already defines the key — that row takes
 * precedence anyway. Otherwise inserts a project_stages row at the end.
 */
async function _ensureStageExists(handoverId, orgId, userId, key, displayName = null) {
  if (!key) return;

  // 2026_116: project_stages is authoritative, so there is no longer any
  // "another table already owns this key" case to check. A key with no row
  // here has no definition at all and would sort NULLS LAST.
  const name = (displayName || '').trim()
    || key.replace(/_+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const { rows: [{ next_order: next }] } = await pool.query(
    `SELECT COALESCE(MAX(sort_order) FILTER (WHERE key <> 'custom'), 0) + 10 AS next_order
       FROM project_stages WHERE handover_id = $1 AND org_id = $2`,
    [handoverId, orgId]);

  await pool.query(
    `INSERT INTO project_stages (handover_id, org_id, key, name, sort_order, source, created_by)
     VALUES ($1, $2, $3, $4, $5, 'custom', $6)
     ON CONFLICT (handover_id, key) DO UPDATE SET is_active = TRUE, updated_at = now()`,
    [handoverId, orgId, key, name, next, userId]);
}

/**
 * Stages available on a project, in run order.
 *
 * Merges the project's playbook stages (if it has a playbook) with its own
 * project_stages rows. `source` tells the caller which is which so the UI can
 * disable rename/reorder on playbook-owned stages — those belong to the
 * template and editing them here would silently diverge one project from
 * every other project using that playbook.
 */
async function listStages(handoverId, orgId) {
  const { rows: [h] } = await pool.query(
    `SELECT id, playbook_id FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]);
  if (!h) throw Object.assign(new Error('Project not found'), { status: 404 });

  // 2026_116: one table, one read. This previously UNIONed playbook_stages
  // with project_stages and deduplicated by precedence in JS — machinery that
  // existed to serve a COALESCE that no longer exists.
  const { rows } = await pool.query(
    `SELECT pst.key, pst.name, pst.sort_order, pst.source, pst.gating,
            (SELECT count(*)::int FROM project_play_instances dpi
              WHERE dpi.handover_id = pst.handover_id
                AND dpi.stage_key = pst.key) AS in_use
       FROM project_stages pst
      WHERE pst.handover_id = $1 AND pst.org_id = $2 AND pst.is_active = TRUE
      ORDER BY pst.sort_order ASC, pst.key ASC`,
    [handoverId, orgId]);

  return {
    // Every stage is now project-owned and therefore editable — the project
    // holds a copy, so renaming one cannot affect any other project.
    stages: rows.map(r => ({
      key: r.key, name: r.name, sortOrder: r.sort_order,
      source: r.source, gating: r.gating || 'none', inUse: r.in_use, canEdit: true,
    })),
    hasPlaybook: Boolean(h.playbook_id),
  };
}

/**
 * Create a stage on a project.
 *
 * Lands at the end unless sortOrder is given, on the same sparse 10-step
 * scale addPlay uses so a later insert can sit between two stages without
 * renumbering.
 */
async function addStage(handoverId, orgId, userId, data = {}) {
  const name = (data.name || '').trim();
  if (!name) throw Object.assign(new Error('A stage name is required.'), { status: 400 });

  const key = _stageKeyFrom(data.key || name);
  if (!key) throw Object.assign(new Error('Stage name must contain letters or numbers.'), { status: 400 });

  const { rows: [h] } = await pool.query(
    `SELECT id FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]);
  if (!h) throw Object.assign(new Error('Project not found'), { status: 404 });

  // 2026_116: no playbook-ownership check any more. Stages are materialized
  // per project, so a duplicate key is caught by the (handover_id, key)
  // unique constraint and handled by the upsert below — it can no longer be
  // a silently-ignored row shadowed by another table.

  let sortOrder = Number.isInteger(data.sortOrder) ? data.sortOrder : null;
  if (sortOrder == null) {
    const { rows: [{ next_order: next }] } = await pool.query(
      // 'custom' sits at 9000 as the permanent tail, so a new stage must land
      // below it rather than after it.
      `SELECT COALESCE(MAX(sort_order) FILTER (WHERE key <> 'custom'), 0) + 10 AS next_order
         FROM project_stages WHERE handover_id = $1 AND org_id = $2`,
      [handoverId, orgId]);
    sortOrder = next;
  }

  const { rows: [row] } = await pool.query(
    `INSERT INTO project_stages (handover_id, org_id, key, name, sort_order, source, created_by)
     VALUES ($1, $2, $3, $4, $5, 'custom', $6)
     ON CONFLICT (handover_id, key)
       DO UPDATE SET is_active = TRUE, name = EXCLUDED.name, updated_at = now()
     RETURNING key, name, sort_order, source`,
    [handoverId, orgId, key, name, sortOrder, userId]);

  return { stage: { key: row.key, name: row.name, sortOrder: row.sort_order,
                    source: row.source, canEdit: true, inUse: 0 } };
}

/**
 * Rename or reorder project-owned stages.
 *
 * Accepts a full ordered list so a drag-reorder is one atomic call rather
 * than N racing PATCHes. Playbook-owned keys in the payload are ignored
 * rather than rejected: the client can send the list it rendered without
 * having to filter it first.
 */
async function updateStages(handoverId, orgId, stages = []) {
  if (!Array.isArray(stages) || !stages.length) {
    throw Object.assign(new Error('stages must be a non-empty array.'), { status: 400 });
  }

  const { rows: [h] } = await pool.query(
    `SELECT id FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
  if (!h) throw Object.assign(new Error('Project not found'), { status: 404 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let i = 0;
    for (const s of stages) {
      const key = _stageKeyFrom(s.key);
      if (!key) continue;
      const name = (s.name || '').trim();
      const order = Number.isInteger(s.sortOrder) ? s.sortOrder
                  : (key === 'custom' ? 9000 : (i + 1) * 10);
      // 2026_118: gating is optional in the payload. NULL leaves it alone, so
      // a client that predates stage gating can still save names and order
      // without silently resetting every stage to 'none'.
      const gating = ['none', 'gates', 'strict'].includes(s.gating) ? s.gating : null;
      await client.query(
        `UPDATE project_stages
            SET name       = COALESCE(NULLIF($4, ''), name),
                sort_order = $5,
                gating     = COALESCE($6, gating)
          WHERE handover_id = $1 AND org_id = $2 AND key = $3`,
        [handoverId, orgId, key, name, order, gating]);
      i++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return listStages(handoverId, orgId);
}

/**
 * Deactivate a stage.
 *
 * Refused while plays still reference it — orphaning them would drop those
 * plays back to NULL sort_order and alphabetical placement, which is exactly
 * the bug 2026_115 fixes. Soft delete, so a stage that gets re-added keeps
 * its previous ordering.
 */
async function removeStage(handoverId, orgId, stageKey) {
  const key = _stageKeyFrom(stageKey);
  if (!key) throw Object.assign(new Error('stageKey is required.'), { status: 400 });

  const { rows: [{ count }] } = await pool.query(
    `SELECT count(*)::int AS count FROM project_play_instances
      WHERE handover_id = $1 AND org_id = $2 AND stage_key = $3`,
    [handoverId, orgId, key]);
  if (count > 0) {
    throw Object.assign(
      new Error(`This stage still has ${count} task${count === 1 ? '' : 's'}. Move or remove them first.`),
      { status: 409, code: 'STAGE_NOT_EMPTY' });
  }

  const { rowCount } = await pool.query(
    `UPDATE project_stages SET is_active = FALSE
      WHERE handover_id = $1 AND org_id = $2 AND key = $3`,
    [handoverId, orgId, key]);
  if (!rowCount) throw Object.assign(new Error('Stage not found on this project.'), { status: 404 });

  return listStages(handoverId, orgId);
}

/**
 * Prerequisites of a task that are not yet satisfied.
 *
 * Shared by the start guard and the completion guard so both answer the
 * question identically. Returns [] when the task is startable.
 */
async function _outstandingPrereqs(playInstanceId, orgId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.status
       FROM project_play_instances p
       JOIN project_play_instances d ON d.id = ANY(p.depends_on)
      WHERE p.id = $1 AND p.org_id = $2
        AND d.status NOT IN ('completed', 'skipped')
      ORDER BY d.id`,
    [playInstanceId, orgId]);
  return rows;
}

/**
 * Set a task's prerequisites.
 *
 * Rejects, in order:
 *   - prerequisites that are not tasks on the same project (cross-project
 *     dependencies would let one project's status changes silently gate
 *     another's)
 *   - self-reference (also enforced by a CHECK constraint)
 *   - cycles, found by walking the proposed graph. The DB constraint only
 *     catches the length-1 case; A->B->A needs traversal.
 *
 * Setting dependencies does NOT change the dependent task's status. It stays
 * 'not_started' and is merely un-startable until its prerequisites are done —
 * so a plan can be wired up while it is still being drafted.
 */
async function setPlayDependencies(handoverId, orgId, playInstanceId, dependsOn = []) {
  const ids = [...new Set((dependsOn || [])
    .map(n => parseInt(n, 10))
    .filter(Number.isInteger))];

  const { rows: [self] } = await pool.query(
    `SELECT id FROM project_play_instances
      WHERE id = $1 AND handover_id = $2 AND org_id = $3`,
    [playInstanceId, handoverId, orgId]);
  if (!self) throw Object.assign(new Error('Task not found on this project.'), { status: 404 });

  if (ids.includes(playInstanceId)) {
    throw Object.assign(new Error('A task cannot depend on itself.'), { status: 400 });
  }

  if (ids.length) {
    const { rows: valid } = await pool.query(
      `SELECT id FROM project_play_instances
        WHERE id = ANY($1::int[]) AND handover_id = $2 AND org_id = $3`,
      [ids, handoverId, orgId]);
    if (valid.length !== ids.length) {
      const found = new Set(valid.map(r => r.id));
      throw Object.assign(
        new Error(`Not tasks on this project: ${ids.filter(i => !found.has(i)).join(', ')}`),
        { status: 400, code: 'PREREQ_NOT_ON_PROJECT' });
    }

    // Cycle check. Walk upward from each proposed prerequisite through the
    // dependency graph; if this task is reachable, the edge would close a loop.
    const { rows: cyc } = await pool.query(
      `WITH RECURSIVE up(id) AS (
         SELECT unnest($1::int[])
         UNION
         SELECT unnest(p.depends_on)
           FROM project_play_instances p
           JOIN up ON up.id = p.id
          WHERE p.depends_on IS NOT NULL
       )
       SELECT 1 FROM up WHERE id = $2 LIMIT 1`,
      [ids, playInstanceId]);
    if (cyc.length) {
      throw Object.assign(
        new Error('That would create a circular dependency.'),
        { status: 409, code: 'DEPENDENCY_CYCLE' });
    }
  }

  await pool.query(
    `UPDATE project_play_instances
        SET depends_on = $1, updated_at = now()
      WHERE id = $2 AND org_id = $3`,
    [ids.length ? ids : null, playInstanceId, orgId]);

  return { playInstanceId, dependsOn: ids, blockedBy: await _outstandingPrereqs(playInstanceId, orgId) };
}

/**
 * Earlier stages holding this task's stage shut.  (2026_118)
 *
 * Mirrors the stage_blocked_by sub-select in _getPlays. Both must agree: the
 * query decides what the button looks like, this decides whether the API
 * accepts the click.
 */
async function _stageBlockers(playInstanceId, orgId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT COALESCE(ps2.name, e.stage_key) AS stage_name
       FROM project_play_instances p
       JOIN project_stages pst
             ON pst.handover_id = p.handover_id AND pst.key = p.stage_key
            AND pst.is_active = TRUE
       JOIN project_play_instances e ON e.handover_id = p.handover_id
       LEFT JOIN project_stages ps2
              ON ps2.handover_id = e.handover_id AND ps2.key = e.stage_key
             AND ps2.is_active = TRUE
      WHERE p.id = $1 AND p.org_id = $2
        AND pst.gating <> 'none'
        AND e.status NOT IN ('completed', 'skipped')
        AND ps2.sort_order < pst.sort_order
        AND (pst.gating = 'strict' OR (pst.gating = 'gates' AND e.is_gate = TRUE))`,
    [playInstanceId, orgId]);
  return rows.map(r => r.stage_name);
}

/**
 * Effective evidence policy for a project.  (2026_118)
 *
 * Org default from organizations.settings.evidence, overridden per project by
 * sales_handovers.evidence_config. Org-level lives in the same jsonb settings
 * blob as modules and diagnostic_rules, so it is managed from Org Admin with
 * no new convention.
 */
async function getEvidencePolicy(handoverId, orgId) {
  return _evidencePolicy(handoverId, orgId);
}

async function _evidencePolicy(handoverId, orgId) {
  const { rows: [r] } = await pool.query(
    `SELECT o.settings->'evidence' AS org_cfg, h.evidence_config AS project_cfg
       FROM sales_handovers h
       JOIN organizations o ON o.id = h.org_id
      WHERE h.id = $1 AND h.org_id = $2`,
    [handoverId, orgId]);

  const org  = r?.org_cfg || {};
  const proj = r?.project_cfg || {};
  return {
    // Defaults match the migration: not required generally, required on gates.
    required:         proj.required         ?? org.required         ?? false,
    requiredForGates: proj.requiredForGates ?? org.requiredForGates ?? true,
  };
}

/**
 * Freeze the plan when a project leaves draft.  (2026_118)
 *
 * While baseline_frozen_at is NULL the plan is PROVISIONAL: due-date edits
 * move baseline_due_date silently, so a project being drafted does not
 * accumulate imaginary slip. This is the moment that stops.
 *
 * Fires on leaving 'draft' — 'submitted' for customer projects, 'in_progress'
 * for internal ones. Not at 'in_progress' for both: a customer plan sits in
 * submitted/acknowledged while the delivery team reviews it, and that is
 * exactly when the dates must stop moving.
 *
 * Three things happen, in order:
 *   1. started_at is recorded (the anchor for due_anchor='project_start')
 *   2. project_start-anchored plays get real dates for the first time
 *   3. every provisional baseline is promoted to 'original'
 *
 * Idempotent: a project already frozen is left alone, so re-entering draft
 * and leaving again cannot silently rewrite a committed plan.
 */
async function freezePlanOnStart(handoverId, orgId, startDate = null) {
  const { rows: [h] } = await pool.query(
    `SELECT id, status, started_at, baseline_frozen_at
       FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]);
  if (!h) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (h.baseline_frozen_at) return { alreadyFrozen: true, recomputed: 0, promoted: 0 };

  const started = startDate || new Date().toISOString().slice(0, 10);

  await pool.query(
    `UPDATE sales_handovers
        SET started_at = COALESCE(started_at, $2::date),
            baseline_frozen_at = now(),
            updated_at = now()
      WHERE id = $1 AND org_id = $3`,
    [handoverId, started, orgId]);

  // Resolve project_start-anchored dates. Until now these were NULL because
  // there was no start date to offset from.
  const { rowCount: recomputed } = await pool.query(
    `UPDATE project_play_instances
        SET due_date = ($2::date + COALESCE(due_offset_days, 0)),
            updated_at = now()
      WHERE handover_id = $1 AND org_id = $3
        AND due_anchor = 'project_start'
        AND status NOT IN ('completed', 'skipped')`,
    [handoverId, started, orgId]);

  // Promote provisional baselines to the committed plan.
  //
  // Scoped to 'inferred' and NULL. A baseline already marked 'original' or
  // 'rebaselined' represents a real commitment someone made and must never be
  // silently overwritten — that is the difference between freezing a plan and
  // erasing its history.
  const { rowCount: promoted } = await pool.query(
    `UPDATE project_play_instances
        SET baseline_due_date = due_date,
            baseline_source   = 'original',
            updated_at = now()
      WHERE handover_id = $1 AND org_id = $2
        AND (baseline_source IS NULL OR baseline_source = 'inferred')`,
    [handoverId, orgId]);

  return { alreadyFrozen: false, startedAt: started, recomputed, promoted };
}

/**
 * What Start/Submit would do to the dates, without doing it.  (2026_118)
 *
 * Powers the review step. Project 91 is the reason it exists: its tasks carry
 * 'created'-anchored dates computed weeks before the project started, so
 * freezing as-is would enshrine ~30 days of phantom slip as the official plan
 * — and every correction after that becomes a tracked rebaseline needing a
 * reason. Better to show the dates and let them be fixed first.
 */
async function getStartPreview(handoverId, orgId, startDate = null) {
  const { rows: [h] } = await pool.query(
    `SELECT id, status, started_at, baseline_frozen_at, go_live_date
       FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]);
  if (!h) throw Object.assign(new Error('Project not found'), { status: 404 });

  const started = startDate || new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT dpi.id, dpi.title, dpi.stage_key, dpi.due_anchor, dpi.due_offset_days,
            dpi.due_date, dpi.baseline_source, dpi.is_gate, dpi.status,
            pst.name AS stage_name, pst.sort_order AS stage_sort_order,
            CASE WHEN dpi.due_anchor = 'project_start'
                 THEN ($3::date + COALESCE(dpi.due_offset_days, 0))
                 ELSE dpi.due_date
            END AS computed_due_date
       FROM project_play_instances dpi
       LEFT JOIN project_stages pst
              ON pst.handover_id = dpi.handover_id AND pst.key = dpi.stage_key
             AND pst.is_active = TRUE
      WHERE dpi.handover_id = $1 AND dpi.org_id = $2
      ORDER BY pst.sort_order ASC NULLS LAST, dpi.stage_key, dpi.sort_order, dpi.id`,
    [handoverId, orgId, started]);

  const toStr = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

  const tasks = rows.map(r => {
    const current  = toStr(r.due_date);
    const computed = toStr(r.computed_due_date);
    return {
      playInstanceId: r.id,
      title:      r.title,
      stageKey:   r.stage_key,
      stageName:  r.stage_name || null,
      isGate:     r.is_gate,
      status:     r.status,
      dueAnchor:  r.due_anchor,
      offsetDays: r.due_offset_days,
      currentDueDate:  current,
      computedDueDate: computed,
      changes:    current !== computed,
      // Flags a date that predates the start — the phantom-overdue case the
      // reviewer most needs to see.
      staleDate:  Boolean(current) && current < started
                  && r.due_anchor !== 'project_start',
    };
  });

  return {
    handoverId,
    status: h.status,
    startDate: started,
    alreadyFrozen: Boolean(h.baseline_frozen_at),
    goLiveDate: toStr(h.go_live_date),
    counts: {
      total:    tasks.length,
      changing: tasks.filter(t => t.changes).length,
      stale:    tasks.filter(t => t.staleDate).length,
      undated:  tasks.filter(t => !t.computedDueDate).length,
    },
    tasks,
  };
}

/**
 * Reposition plays within a project.
 *
 * Takes an ordered list of play instance ids and renumbers them on the sparse
 * 10-step scale (10, 20, 30 …) that addPlay also uses, so a later insert can
 * still land between two existing plays without renumbering the whole stage.
 *
 * Reordering only became meaningful once _getPlays stopped sorting by due_date
 * first — before that, sort_order was a tiebreak and dragging a play had no
 * visible effect.
 *
 * Scoped to one stage at a time. Reordering across stages would silently move
 * plays between phases, which is a different operation and belongs in
 * updatePlay({ stageKey }) where it is explicit.
 *
 * @param {number}   handoverId
 * @param {number}   orgId
 * @param {string}   stageKey        stage whose plays are being reordered
 * @param {number[]} orderedIds      play instance ids, in the desired order
 */
async function reorderPlays(handoverId, orgId, stageKey, orderedIds) {
  const stage = (stageKey || '').trim();
  if (!stage) {
    throw Object.assign(new Error('stageKey is required.'), { status: 400 });
  }
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw Object.assign(new Error('An ordered list of play ids is required.'), { status: 400 });
  }

  const ids = orderedIds.map(n => parseInt(n, 10));
  if (ids.some(n => !Number.isFinite(n))) {
    throw Object.assign(new Error('All play ids must be numbers.'), { status: 400 });
  }
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('The same play appears more than once.'), { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Every id must belong to this project AND this stage. Verified inside the
    // transaction: a partial renumbering is worse than a rejected one, because
    // it leaves the checklist in an order nobody chose.
    const { rows: owned } = await client.query(
      `SELECT id FROM project_play_instances
        WHERE handover_id = $1 AND org_id = $2 AND stage_key = $3 AND id = ANY($4::int[])`,
      [handoverId, orgId, stage, ids]
    );
    if (owned.length !== ids.length) {
      const found = new Set(owned.map(r => r.id));
      const bad = ids.filter(i => !found.has(i));
      throw Object.assign(
        new Error(`These plays are not in stage "${stage}" on this project: ${bad.join(', ')}`),
        { status: 400 }
      );
    }

    // The caller must supply the WHOLE stage. A partial list would renumber a
    // subset onto the same scale as the plays it omitted, interleaving them
    // unpredictably.
    const { rows: [{ count: stageCount }] } = await client.query(
      `SELECT count(*)::int AS count FROM project_play_instances
        WHERE handover_id = $1 AND org_id = $2 AND stage_key = $3`,
      [handoverId, orgId, stage]
    );
    if (stageCount !== ids.length) {
      throw Object.assign(
        new Error(`Stage "${stage}" has ${stageCount} plays but ${ids.length} were supplied. Send the full stage.`),
        { status: 400 }
      );
    }

    // Single statement rather than a loop: sort_order has no unique constraint,
    // so intermediate collisions are harmless, but one round trip on a slow
    // disk beats N.
    await client.query(
      `UPDATE project_play_instances AS p
          SET sort_order = v.new_order, updated_at = now()
         FROM (SELECT unnest($1::int[]) AS id,
                      generate_subscripts($1::int[], 1) * 10 AS new_order) AS v
        WHERE p.id = v.id AND p.handover_id = $2 AND p.org_id = $3`,
      [ids, handoverId, orgId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const plays = await _getPlays(handoverId, orgId);
  return { plays: plays.filter(p => p.stageKey === stage) };
}

// ═══════════════════════════════════════════════════════════════════════════
// EVIDENCE — proof that a play was actually done (2026_111)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Accept evidence for a play. TWO SOURCES, one row shape (2026_124).
 *
 *   whatsappMessageId → channel 'whatsapp'. A message already captured on
 *                       this org, plus a snapshot of its content AND, new in
 *                       2026_124, of its stored media.
 *   storageFileId     → channel 'file'. A document already in the org's
 *                       Drive/OneDrive, normally one this project just
 *                       uploaded via uploadPlayEvidenceFile().
 *
 * Stores a live link AND a snapshot in both cases. The snapshot is not
 * redundancy: conversation bindings re-file messages between projects, and a
 * file can be moved or unshared in Drive. The link keeps it openable; the
 * snapshot preserves what the approver actually saw when they signed off.
 *
 * The row is immutable once written (trg_play_evidence_immutable). A mistake
 * is corrected by revoking, never by editing.
 */
async function addPlayEvidence(handoverId, orgId, playInstanceId, userId, data = {}) {
  const { rows: [play] } = await pool.query(
    `SELECT id FROM project_play_instances
      WHERE id = $1 AND handover_id = $2 AND org_id = $3`,
    [playInstanceId, handoverId, orgId]
  );
  if (!play) {
    throw Object.assign(new Error('Play does not belong to this project'), { status: 404 });
  }

  const messageId = data.whatsappMessageId ? parseInt(data.whatsappMessageId, 10) : null;
  const fileId    = data.storageFileId     ? parseInt(data.storageFileId, 10)     : null;

  if (!messageId && !fileId) {
    throw Object.assign(
      new Error('Attach a WhatsApp message or a file as evidence.'), { status: 400 });
  }
  if (messageId && fileId) {
    // One row, one artefact. Two would make "what was accepted" ambiguous and
    // revocation would withdraw both together whether or not that was meant.
    throw Object.assign(
      new Error('Attach either a message or a file, not both. Add a second piece of evidence instead.'),
      { status: 400 });
  }

  const warnings = [];
  const note = (data.note || '').trim() || null;

  // ── File evidence ──────────────────────────────────────────────────────
  if (fileId) {
    // Org-scoped, and scoped to THIS project. storage_files.handover_id is the
    // effective project; without the second predicate a caller could cite a
    // document belonging to another project by guessing an id.
    const { rows: [f] } = await pool.query(
      `SELECT id, file_name, mime_type, file_size, web_url, handover_id
         FROM storage_files
        WHERE id = $1 AND org_id = $2`,
      [fileId, orgId]
    );
    if (!f) throw Object.assign(new Error('File not found.'), { status: 404 });
    if (f.handover_id && f.handover_id !== handoverId) {
      throw Object.assign(
        new Error('That file is filed against a different project.'), { status: 400 });
    }
    if (!f.handover_id) {
      // Not fatal — an untagged document is still a real file the approver
      // chose. Recorded so the UI can say the link is looser than it looks.
      warnings.push('That file is not tagged to this project.');
    }

    const { rows: [row] } = await pool.query(
      `INSERT INTO play_evidence
         (org_id, project_play_instance_id, channel, storage_file_id,
          snapshot_file_name, snapshot_mime_type, snapshot_file_size,
          snapshot_web_url, note, accepted_by)
       VALUES ($1, $2, 'file', $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, accepted_at`,
      [orgId, playInstanceId, fileId,
       f.file_name || null, f.mime_type || null, f.file_size || null,
       f.web_url || null, note, userId]
    );
    return { evidenceId: row.id, acceptedAt: row.accepted_at, warnings };
  }

  // ── WhatsApp evidence ──────────────────────────────────────────────────
  // Org-scoped read. Without this a caller could snapshot a message belonging
  // to another tenant by guessing an id.
  //
  // 2026_124 adds the media columns: accepting a photo used to record the
  // caption and nothing about the picture, and media is reaped on a retention
  // schedule (media_expires_at / media_removed_at), so proof of completion
  // quietly decayed into a caption.
  const { rows: [msg] } = await pool.query(
    `SELECT m.id, m.thread_id, m.body, m.from_name, m.from_phone, m.sent_at,
            m.handover_id, m.storage_file_id, m.media_mime_type, m.media_filename,
            sf.file_size AS media_file_size, sf.web_url AS media_web_url
       FROM whatsapp_messages m
       LEFT JOIN storage_files sf ON sf.id = m.storage_file_id
      WHERE m.id = $1 AND m.org_id = $2`,
    [messageId, orgId]
  );
  if (!msg) {
    throw Object.assign(new Error('Message not found.'), { status: 404 });
  }

  // Not an error: a message may legitimately predate the project being tagged,
  // and refusing would make evidence unusable for exactly the historic threads
  // this feature exists to surface. Recorded as a warning so the UI can say so.
  if (msg.handover_id && msg.handover_id !== handoverId) {
    warnings.push('That message is currently filed against a different project.');
  }

  const { rows: [row] } = await pool.query(
    `INSERT INTO play_evidence
       (org_id, project_play_instance_id, channel, whatsapp_message_id,
        snapshot_body, snapshot_sender, snapshot_sent_at, snapshot_thread_id,
        storage_file_id, snapshot_file_name, snapshot_mime_type,
        snapshot_file_size, snapshot_web_url,
        note, accepted_by)
     VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, accepted_at`,
    [orgId, playInstanceId, messageId,
     msg.body || null,
     msg.from_name || msg.from_phone || null,
     msg.sent_at || null,
     msg.thread_id || null,
     msg.storage_file_id || null,
     msg.media_filename || null,
     msg.media_mime_type || null,
     msg.media_file_size || null,
     msg.media_web_url || null,
     note,
     userId]
  );

  return { evidenceId: row.id, acceptedAt: row.accepted_at, warnings };
}

/**
 * Upload a file straight onto a task as evidence.
 *
 * The bytes never touch Postgres. This delegates to
 * projectFiles.uploadLocalFile(), which pushes to the org's Google Drive or
 * OneDrive through StorageProviderFactory and writes the storage_files row —
 * the same path, folder and credential as any other project attachment. All
 * this adds is the play_evidence row pointing at the result.
 *
 * If the project has no upload folder the underlying call refuses with an
 * actionable message rather than falling back to a blob table. That is a
 * deliberate choice: site photos in the database would land in every nightly
 * backup and every restore, and "storage is configured" is a one-time setup
 * problem, not a per-upload one.
 */
async function uploadPlayEvidenceFile(handoverId, orgId, playInstanceId, userId, file = {}) {
  await _requirePlayOnProject(handoverId, orgId, playInstanceId);

  const projectFiles = require('./projectFiles.service');
  const { file: stored, folderName } = await projectFiles.uploadLocalFile(
    handoverId, orgId, userId,
    { fileName: file.fileName, mimeType: file.mimeType, buffer: file.buffer }
  );

  const result = await addPlayEvidence(handoverId, orgId, playInstanceId, userId, {
    storageFileId: stored.id,
    note: file.note,
  });

  return { ...result, file: stored, folderName };
}

/**
 * List evidence for a play. Revoked rows are returned too, flagged — hiding
 * them would make the audit trail useless for the question it exists to
 * answer ("what was accepted, and what was withdrawn").
 */
async function listPlayEvidence(handoverId, orgId, playInstanceId) {
  const { rows } = await pool.query(
    `SELECT e.id, e.channel, e.whatsapp_message_id,
            e.snapshot_body, e.snapshot_sender, e.snapshot_sent_at,
            e.snapshot_thread_id, e.note,
            e.storage_file_id, e.snapshot_file_name, e.snapshot_mime_type,
            e.snapshot_file_size, e.snapshot_web_url,
            e.accepted_at, e.revoked_at, e.revoke_reason,
            au.first_name || ' ' || au.last_name AS accepted_by_name,
            ru.first_name || ' ' || ru.last_name AS revoked_by_name,
            -- has the message since been re-filed elsewhere?
            m.handover_id AS message_handover_id,
            -- is the underlying file still there to open?
            sf.id IS NOT NULL AS file_live
       FROM play_evidence e
       JOIN project_play_instances p ON p.id = e.project_play_instance_id
       LEFT JOIN users au ON au.id = e.accepted_by
       LEFT JOIN users ru ON ru.id = e.revoked_by
       LEFT JOIN whatsapp_messages m ON m.id = e.whatsapp_message_id
       LEFT JOIN storage_files sf    ON sf.id = e.storage_file_id
      WHERE e.project_play_instance_id = $1
        AND e.org_id = $2
        AND p.handover_id = $3
      ORDER BY e.accepted_at DESC`,
    [playInstanceId, orgId, handoverId]
  );

  return {
    evidence: rows.map(r => ({
      id:            r.id,
      channel:       r.channel,
      messageId:     r.whatsapp_message_id,
      threadId:      r.snapshot_thread_id,
      body:          r.snapshot_body,
      sender:        r.snapshot_sender,
      sentAt:        r.snapshot_sent_at,
      note:          r.note,
      // ── file / media (2026_124) ──
      // Present on channel 'file', and on 'whatsapp' when the message carried
      // media. fileLive says whether the live link still resolves; the
      // snapshot fields are always what was accepted.
      storageFileId: r.storage_file_id,
      fileName:      r.snapshot_file_name,
      mimeType:      r.snapshot_mime_type,
      fileSize:      r.snapshot_file_size != null ? Number(r.snapshot_file_size) : null,
      webUrl:        r.snapshot_web_url,
      isImage:       /^image\//i.test(r.snapshot_mime_type || ''),
      fileLive:      !!r.file_live,
      acceptedAt:    r.accepted_at,
      acceptedBy:    r.accepted_by_name,
      revoked:       r.revoked_at != null,
      revokedAt:     r.revoked_at,
      revokedBy:     r.revoked_by_name,
      revokeReason:  r.revoke_reason,
      // true when the underlying message has since moved to another project,
      // so the UI can show the snapshot without implying live linkage.
      messageMoved:  r.message_handover_id != null && r.message_handover_id !== handoverId,
    })),
  };
}

/**
 * Withdraw evidence. Never a delete — the row stays, flagged, with who and why.
 * A system that cannot correct a mistake gets worked around; one that erases
 * the correction cannot be audited. This does both jobs.
 */
async function revokePlayEvidence(handoverId, orgId, evidenceId, userId, reason) {
  const r = (reason || '').trim();
  if (!r) {
    throw Object.assign(new Error('A reason is required to withdraw evidence.'), { status: 400 });
  }

  const { rows: [ev] } = await pool.query(
    `SELECT e.id, e.revoked_at
       FROM play_evidence e
       JOIN project_play_instances p ON p.id = e.project_play_instance_id
      WHERE e.id = $1 AND e.org_id = $2 AND p.handover_id = $3`,
    [evidenceId, orgId, handoverId]
  );
  if (!ev) throw Object.assign(new Error('Evidence not found.'), { status: 404 });
  if (ev.revoked_at) {
    throw Object.assign(new Error('That evidence has already been withdrawn.'), { status: 409 });
  }

  await pool.query(
    `UPDATE play_evidence
        SET revoked_at = now(), revoked_by = $1, revoke_reason = $2
      WHERE id = $3`,
    [userId, r, evidenceId]
  );

  return { revoked: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTES — running commentary on one checklist task (2026_120)
//
// Distinct from the two things that already existed and were mistaken for
// this:
//   completion_note   one sentence, written once, at the moment of closing
//   play_evidence     an artefact accepted as proof that it was done
//
// A note is neither. It is what someone says about the task WHILE it is
// happening, or afterwards when the project is being written up. Notes may be
// added to a task in ANY status — there is no open/closed predicate anywhere
// in this feature, deliberately, because the reviewing case (annotating a
// finished task) is the stronger of the two.
//
// Append-only. A note is never edited; a correction is a second note.
// ═══════════════════════════════════════════════════════════════════════════

/** Note types a HUMAN may write. 'system' exists in the CHECK for future
 *  machine-written notes and is refused here, so a 'system' note is always
 *  genuinely one. */
const NOTE_TYPES = ['comment', 'blocker', 'decision'];
const NOTE_MAX_LENGTH = 4000;

/**
 * Who this user is, relative to ONE project — the single query behind both
 * "may they write a note" and "which notes may they read".
 *
 * Returns null when the project does not exist in this org, or the caller is
 * not an active member of the org. Both are 404-shaped, not 403-shaped: a
 * caller who cannot see the project should not learn it exists.
 */
async function _projectNoteContext(handoverId, orgId, userId) {
  if (!userId) return null;

  const { rows: [r] } = await pool.query(
    `SELECT
       ou.role AS org_role,
       h.assigned_service_owner_id,
       h.created_by,
       -- Only an APPROVED membership counts. A pending request is someone
       -- asking for access, and 'left' / 'declined' / 'rejected' rows are
       -- retained as history (see projectMembers.selfExit) — treating any of
       -- them as access would hand the project back to someone who left it.
       (SELECT pm.side
          FROM project_members pm
         WHERE pm.context_type = 'handover' AND pm.context_id = h.id
           AND pm.org_id = h.org_id AND pm.user_id = ou.user_id
           AND pm.status = 'approved'
         LIMIT 1) AS member_side,
       -- A project derived from a deal staffs itself from deal_team_members
       -- and may have no project_members rows at all, so this is not a
       -- redundant second check — for those projects it is the only one.
       EXISTS (SELECT 1 FROM deal_team_members dtm
                WHERE dtm.deal_id = h.deal_id AND dtm.org_id = h.org_id
                  AND dtm.user_id = ou.user_id) AS on_deal_team,
       -- Everyone accountable for the project, for the hierarchy check below.
       ARRAY(
         SELECT DISTINCT x FROM unnest(ARRAY[h.assigned_service_owner_id, h.created_by]
           || COALESCE((SELECT array_agg(pm2.user_id)
                          FROM project_members pm2
                         WHERE pm2.context_type = 'handover' AND pm2.context_id = h.id
                           AND pm2.org_id = h.org_id AND pm2.status = 'approved'), '{}')
           || COALESCE((SELECT array_agg(dtm2.user_id)
                          FROM deal_team_members dtm2
                         WHERE dtm2.deal_id = h.deal_id AND dtm2.org_id = h.org_id), '{}')
         ) AS x WHERE x IS NOT NULL
       ) AS project_user_ids
     FROM org_users ou
     JOIN sales_handovers h ON h.id = $3 AND h.org_id = $1
    WHERE ou.org_id = $1 AND ou.user_id = $2 AND ou.is_active = TRUE`,
    [orgId, userId, handoverId]
  );
  if (!r) return null;

  const isAdmin        = ['admin', 'owner'].includes(r.org_role);
  const isServiceOwner = r.assigned_service_owner_id === userId;
  const isCreator      = r.created_by === userId;
  const isMember       = r.member_side != null || r.on_deal_team;

  // "…or their manager." Read literally: the manager of anyone ON the project,
  // not only of the Project Manager. A regional head reviewing a site they do
  // not personally sit on is the case this exists for.
  //
  // Deliberately NOT gated on projectSettings.commercial_follows_hierarchy the
  // way _isAboveServiceOwner is — that flag guards commercial figures, and a
  // note about a crane being double-booked is not commercial data.
  //
  // Fails closed: any error resolving the hierarchy denies rather than grants.
  let isManagerOfMember = false;
  if (!isAdmin && !isServiceOwner && !isCreator && !isMember) {
    try {
      const subs = await hierarchyService.getSubordinates(orgId, userId);
      const onProject = new Set((r.project_user_ids || []).map(Number));
      isManagerOfMember = (subs || []).some(id => onProject.has(Number(id)));
    } catch (err) {
      console.warn('[handover] note hierarchy check failed:', err.message);
      isManagerOfMember = false;
    }
  }

  return {
    isAdmin,
    // The acceptor of the work. Decides which notes they may READ, and it wins
    // over isAdmin: the whole point of an internal note is to be invisible to
    // the person signing off, and an acceptor who also happens to be an org
    // admin is still the acceptor.
    isInternalCustomer: r.member_side === 'internal_customer',
    canNote: isAdmin || isServiceOwner || isCreator || isMember || isManagerOfMember,
  };
}

/**
 * May this user write a note on this project? Exposed so the UI can hide the
 * composer rather than offer it and then be refused.
 */
async function canNoteOnProject(handoverId, orgId, userId) {
  const ctx = await _projectNoteContext(handoverId, orgId, userId);
  return !!ctx && ctx.canNote;
}

/**
 * The viewer's note posture on one project, for callers OUTSIDE this service —
 * currently the Plan vs Actual route, which needs to know whether to count
 * internal notes.
 *
 * Fails closed on both counts: an unresolvable viewer may not write, and is
 * treated as an acceptor for reading, so internal notes stay hidden.
 */
async function getNoteVisibility(handoverId, orgId, userId) {
  const ctx = await _projectNoteContext(handoverId, orgId, userId);
  if (!ctx) return { canNote: false, hideInternalNotes: true };
  return { canNote: ctx.canNote, hideInternalNotes: ctx.isInternalCustomer };
}

/** Resolve a play to its project, org-scoped. Shared by all three writers. */
async function _requirePlayOnProject(handoverId, orgId, playInstanceId) {
  const { rows: [play] } = await pool.query(
    `SELECT id, status FROM project_play_instances
      WHERE id = $1 AND handover_id = $2 AND org_id = $3`,
    [playInstanceId, handoverId, orgId]
  );
  if (!play) {
    throw Object.assign(new Error('Task does not belong to this project'), { status: 404 });
  }
  return play;
}

function fmtNote(row, viewerId, canManage) {
  return {
    id:         row.id,
    body:       row.body,
    noteType:   row.note_type,
    isInternal: row.is_internal,
    authorId:   row.author_id,
    // Null when the author's account has since been removed — the note stays,
    // attributed to nobody, rather than disappearing with them.
    authorName: row.author_name || null,
    createdAt:  row.created_at,
    // 2026_124. Files live in the org's Drive/OneDrive; these are references
    // plus a snapshot of the file's identity. isImage drives thumbnailing.
    attachments: (row.attachments || []).map(a => ({
      ...a,
      fileSize: a.fileSize != null ? Number(a.fileSize) : null,
      isImage:  /^image\//i.test(a.mimeType || ''),
    })),
    // Computed here rather than in the client so the delete rule lives in one
    // place and the button cannot drift from what the API will actually allow.
    canDelete:  canManage || (row.author_id != null && row.author_id === viewerId),
  };
}

/**
 * Add a note to a task — open or closed.
 *
 * @param {object} data { body, noteType?, isInternal? }
 */
async function addPlayNote(handoverId, orgId, playInstanceId, userId, data = {}) {
  const ctx = await _projectNoteContext(handoverId, orgId, userId);
  if (!ctx) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!ctx.canNote) {
    throw Object.assign(
      new Error('Only people on this project, or their manager, can add notes here'),
      { status: 403 });
  }

  await _requirePlayOnProject(handoverId, orgId, playInstanceId);

  const body = String(data.body ?? '').trim();
  if (!body) throw Object.assign(new Error('A note cannot be empty'), { status: 400 });
  if (body.length > NOTE_MAX_LENGTH) {
    throw Object.assign(
      new Error(`A note cannot be longer than ${NOTE_MAX_LENGTH} characters`),
      { status: 400 });
  }

  const noteType = data.noteType ? String(data.noteType) : 'comment';
  if (!NOTE_TYPES.includes(noteType)) {
    throw Object.assign(
      new Error(`noteType must be one of: ${NOTE_TYPES.join(', ')}`), { status: 400 });
  }

  // An acceptor cannot mark their own note internal — internal means "hidden
  // from the acceptor", so it would hide the note from its own author.
  const isInternal = ctx.isInternalCustomer ? false : !!data.isInternal;

  const { rows: [row] } = await pool.query(
    `INSERT INTO play_notes
       (org_id, project_play_instance_id, author_id, body, note_type, is_internal)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [orgId, playInstanceId, userId, body, noteType, isInternal]
  );

  return { noteId: row.id, createdAt: row.created_at };
}

/**
 * Notes on one task, newest first.
 *
 * Deleted notes are excluded for everyone. The rows survive in the table so a
 * withdrawn note is still attributable if anyone ever needs to ask, but a
 * tombstone in the thread would be noise on what is meant to read as a
 * conversation.
 */
async function listPlayNotes(handoverId, orgId, playInstanceId, userId) {
  const ctx = await _projectNoteContext(handoverId, orgId, userId);
  if (!ctx) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!ctx.canNote) {
    throw Object.assign(new Error('You do not have access to this project'), { status: 403 });
  }

  await _requirePlayOnProject(handoverId, orgId, playInstanceId);

  const canManage = await projectMembers.canManageProject(handoverId, orgId, userId);

  const { rows } = await pool.query(
    `SELECT n.id, n.body, n.note_type, n.is_internal, n.author_id, n.created_at,
            u.first_name || ' ' || u.last_name AS author_name,
            -- 2026_124. Attachments come back with the note rather than on a
            -- second call: a note with a photo is one thing to read, and a
            -- per-note round trip would make a ten-note thread eleven requests.
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id',            a.id,
                       'storageFileId', a.storage_file_id,
                       'fileName',      a.file_name,
                       'mimeType',      a.mime_type,
                       'fileSize',      a.file_size,
                       'webUrl',        a.web_url,
                       'fileLive',      (sf.id IS NOT NULL))
                     ORDER BY a.created_at, a.id)
                FROM play_note_attachments a
                LEFT JOIN storage_files sf ON sf.id = a.storage_file_id
               WHERE a.play_note_id = n.id AND a.org_id = n.org_id
            ), '[]'::json) AS attachments
       FROM play_notes n
       JOIN project_play_instances p ON p.id = n.project_play_instance_id
       LEFT JOIN users u ON u.id = n.author_id
      WHERE n.project_play_instance_id = $1
        AND n.org_id = $2
        AND p.handover_id = $3
        AND n.deleted_at IS NULL
        -- $4 = the viewer is the acceptor of this work, so delivery-side
        -- notes are not theirs to read.
        AND ($4::boolean IS NOT TRUE OR n.is_internal = FALSE)
      ORDER BY n.created_at DESC, n.id DESC`,
    [playInstanceId, orgId, handoverId, ctx.isInternalCustomer]
  );

  return {
    notes: rows.map(r => fmtNote(r, userId, canManage)),
    // Lets the UI decide whether to render the composer and the internal
    // toggle without a second round trip.
    canAdd:         ctx.canNote,
    canMarkInternal: !ctx.isInternalCustomer,
  };
}

/**
 * Attach a file to an existing note (2026_124).
 *
 * Same storage path as evidence and as any other project attachment — the
 * bytes go to the org's Drive/OneDrive via projectFiles.uploadLocalFile() and
 * never into Postgres.
 *
 * Deliberately a second step rather than part of addPlayNote: a multipart
 * upload can fail on the network long after the sentence was typed, and losing
 * the note because the photo failed would be the wrong trade. The note is
 * written first and stands on its own; the photo joins it.
 *
 * Anyone who could write the note can attach to it — including a manager
 * adding a photo to someone else's note during a review. Attachments are
 * additive and attributed, so this cannot be used to alter what was said.
 */
async function addPlayNoteAttachment(handoverId, orgId, noteId, userId, file = {}) {
  const ctx = await _projectNoteContext(handoverId, orgId, userId);
  if (!ctx) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!ctx.canNote) {
    throw Object.assign(
      new Error('Only people on this project, or their manager, can attach files here'),
      { status: 403 });
  }

  // The note must be live and on THIS project. Attaching to a withdrawn note
  // would put a file somewhere nobody can see it.
  const { rows: [note] } = await pool.query(
    `SELECT n.id, n.is_internal
       FROM play_notes n
       JOIN project_play_instances p ON p.id = n.project_play_instance_id
      WHERE n.id = $1 AND n.org_id = $2 AND p.handover_id = $3
        AND n.deleted_at IS NULL`,
    [noteId, orgId, handoverId]
  );
  if (!note) throw Object.assign(new Error('Note not found'), { status: 404 });
  if (note.is_internal && ctx.isInternalCustomer) {
    // Belt and braces: the acceptor cannot see this note, so they cannot be
    // attaching to it. Reaching here means a stale id, not a legitimate act.
    throw Object.assign(new Error('Note not found'), { status: 404 });
  }

  const projectFiles = require('./projectFiles.service');
  const { file: stored, folderName } = await projectFiles.uploadLocalFile(
    handoverId, orgId, userId,
    { fileName: file.fileName, mimeType: file.mimeType, buffer: file.buffer }
  );

  const { rows: [row] } = await pool.query(
    `INSERT INTO play_note_attachments
       (org_id, play_note_id, storage_file_id, file_name, mime_type,
        file_size, web_url, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [orgId, noteId, stored.id, stored.file_name || file.fileName || 'upload',
     file.mimeType || null, (file.buffer && file.buffer.length) || null,
     stored.web_url || null, userId]
  );

  return { attachmentId: row.id, createdAt: row.created_at, file: stored, folderName };
}

/**
 * Withdraw a note. Soft delete — the author and the text stay in the table.
 *
 * The author may withdraw their own; anyone who can manage the project may
 * withdraw any. That second half is not tidiness: a note naming the wrong
 * person, or containing something that should not have been written down, is
 * a thing the person accountable for the project has to be able to remove
 * without a database session.
 */
async function deletePlayNote(handoverId, orgId, noteId, userId) {
  const ctx = await _projectNoteContext(handoverId, orgId, userId);
  if (!ctx) throw Object.assign(new Error('Project not found'), { status: 404 });

  const { rows: [note] } = await pool.query(
    `SELECT n.id, n.author_id, n.deleted_at
       FROM play_notes n
       JOIN project_play_instances p ON p.id = n.project_play_instance_id
      WHERE n.id = $1 AND n.org_id = $2 AND p.handover_id = $3`,
    [noteId, orgId, handoverId]
  );
  if (!note) throw Object.assign(new Error('Note not found'), { status: 404 });
  if (note.deleted_at) {
    throw Object.assign(new Error('That note has already been removed'), { status: 409 });
  }

  const canManage = await projectMembers.canManageProject(handoverId, orgId, userId);
  const isAuthor  = note.author_id != null && note.author_id === userId;
  if (!canManage && !isAuthor) {
    throw Object.assign(
      new Error('Only the author or the Project Manager can remove a note'), { status: 403 });
  }

  await pool.query(
    `UPDATE play_notes SET deleted_at = now(), deleted_by = $1 WHERE id = $2`,
    [userId, noteId]
  );

  return { deleted: true, id: noteId };
}

/**
 * The full date history for one play, newest first.
 */
async function listPlayRevisions(handoverId, orgId, playInstanceId) {
  const { rows } = await pool.query(
    `SELECT rv.id, rv.from_due_date, rv.to_due_date, rv.reason,
            rv.is_rebaseline, rv.previous_baseline_date, rv.revised_at,
            u.first_name || ' ' || u.last_name AS revised_by_name
       FROM play_due_date_revisions rv
       JOIN project_play_instances p ON p.id = rv.project_play_instance_id
       LEFT JOIN users u ON u.id = rv.revised_by
      WHERE rv.project_play_instance_id = $1
        AND rv.org_id = $2
        AND p.handover_id = $3
      ORDER BY rv.revised_at DESC`,
    [playInstanceId, orgId, handoverId]
  );

  return {
    revisions: rows.map(r => ({
      id:               r.id,
      fromDueDate:      r.from_due_date,
      toDueDate:        r.to_due_date,
      reason:           r.reason,
      isRebaseline:     r.is_rebaseline,
      previousBaseline: r.previous_baseline_date,
      revisedAt:        r.revised_at,
      revisedBy:        r.revised_by_name,
    })),
  };
}

/**
 * Remove an ad-hoc checklist item. Guardrail: only items that are genuinely
 * ad-hoc (no playbook, no template) can be deleted here — playbook-driven rows
 * are managed through the playbook, not deleted off a single handover.
 */
async function removePlay(handoverId, orgId, playInstanceId) {
  const { rows: [inst] } = await pool.query(
    `SELECT ppi.id
       FROM project_play_instances ppi
      WHERE ppi.handover_id = $1 AND ppi.id = $2 AND ppi.org_id = $3
        AND ppi.play_id IS NULL AND ppi.playbook_id IS NULL`,
    [handoverId, playInstanceId, orgId]
  );
  if (!inst) {
    throw Object.assign(new Error('Only items added on this handover can be removed here.'), { status: 400 });
  }

  // Single delete. This previously removed the sales_handover_plays link AND
  // the deal_play_instances row. Deleting from deal_play_instances now would
  // destroy the stale pre-migration copy that 2026_109 deliberately retained
  // as the rollback path, so it is gone.
  await pool.query(
    `DELETE FROM project_play_instances WHERE handover_id = $1 AND id = $2 AND org_id = $3`,
    [handoverId, playInstanceId, orgId]
  );
  return { removed: true };
}

/**
 * Edit a checklist item on a handover. Updates only the per-instance fields
 * (title, description, owner, due date, gate) on project_play_instances — it never
 * touches the playbook template, so an edit is scoped to THIS handover. Only the
 * keys present in `data` are changed. Completion stays a separate path
 * (completePlay), so status can't be silently flipped here.
 */
async function updatePlay(handoverId, orgId, playInstanceId, data = {}, userId = null) {
  // Current state is needed, not just existence: a date change has to record
  // where it moved FROM, and a rebaseline has to record the baseline it
  // replaced. Reading after the UPDATE would lose both.
  const { rows: link } = await pool.query(
    `SELECT ppi.id, ppi.due_date, ppi.baseline_due_date, ppi.baseline_source
       FROM project_play_instances ppi
      WHERE ppi.handover_id = $1 AND ppi.id = $2 AND ppi.org_id = $3`,
    [handoverId, playInstanceId, orgId]
  );
  if (link.length === 0) {
    throw Object.assign(new Error('Play does not belong to this handover'), { status: 404 });
  }
  const current = link[0];

  const has = k => Object.prototype.hasOwnProperty.call(data, k);
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (has('title')) {
    const t = (data.title || '').trim();
    if (!t) throw Object.assign(new Error('A title is required.'), { status: 400 });
    add('title', t);
  }
  if (has('description')) add('description', (data.description || '').trim() || null);
  if (has('ownerUserId')) add('owner_user_id', data.ownerUserId ? parseInt(data.ownerUserId, 10) : null);
  // ── Due date: recorded, never silent ────────────────────────────────────
  // Moving a planned date is the single act that makes a variance report
  // either meaningful or worthless, and nothing recorded it before. Not
  // blocked for non-managers (deliberate — recording is the improvement),
  // but always attributed.
  const newDue = has('dueDate') ? (data.dueDate || null) : undefined;
  const dueChanged = newDue !== undefined
    && String(current.due_date ? toDateStr(current.due_date) : '') !== String(newDue || '');
  const wantsRebaseline = data.rebaseline === true;

  if (has('dueDate')) add('due_date', newDue);

  // 2026_118: while the plan is provisional (project still in draft, so
  // baseline_frozen_at is NULL) a due-date change moves the baseline with it.
  //
  // Without this, every date typed while drafting is recorded as slip against
  // whatever the row happened to contain first, and Plan vs Actual is wrong
  // for the project's whole life. Nothing is being hidden: there is no
  // committed plan to slip against until the project leaves draft.
  let provisional = false;
  if (dueChanged && !wantsRebaseline) {
    const { rows: [hb] } = await pool.query(
      `SELECT baseline_frozen_at FROM sales_handovers WHERE id = $1 AND org_id = $2`,
      [handoverId, orgId]);
    if (hb && !hb.baseline_frozen_at) {
      provisional = true;
      add('baseline_due_date', newDue);
      add('baseline_source', 'inferred');   // still provisional, not committed
    }
  }

  // A rebaseline is an authorised replan, not an edit. Gated, and it must say
  // why — otherwise it is indistinguishable from quietly covering a slip.
  if (wantsRebaseline) {
    if (!dueChanged) {
      throw Object.assign(
        new Error('A rebaseline needs a new due date.'), { status: 400 });
    }
    const reason = (data.reason || '').trim();
    if (!reason) {
      throw Object.assign(
        new Error('A rebaseline needs a reason.'), { status: 400 });
    }
    const allowed = await canRebaseline(handoverId, orgId, userId);
    if (!allowed) {
      throw Object.assign(
        new Error('You do not have permission to rebaseline this project.'), { status: 403 });
    }
    add('baseline_due_date', newDue);
    add('baseline_source', 'rebaselined');
  }

  if (has('isGate'))      add('is_gate', data.isGate === true);

  // sortOrder / stageKey: a template could previously be renamed and re-dated
  // but never restructured, which made a playbook only superficially editable.
  // Moving a play between stages or repositioning it within one is what makes
  // an EPC and a software playbook genuinely different shapes.
  if (has('sortOrder')) {
    const so = parseInt(data.sortOrder, 10);
    if (!Number.isFinite(so) || so < 0) {
      throw Object.assign(new Error('sortOrder must be a non-negative number.'), { status: 400 });
    }
    add('sort_order', so);
  }
  if (has('status')) {
    // In-flight status only. 'completed' and 'skipped' are deliberately NOT
    // settable here: completePlay() delegates to PlaybookPlayService, which
    // enforces gates, records completed_at/completed_by, captures evidence and
    // unlocks dependent plays. Letting a plain PATCH write 'completed' would
    // skip all of that and leave completed_at NULL, which the checklist reads
    // as "done but with no completion date".
    const ALLOWED = ['not_started', 'in_progress', 'blocked'];
    const st = String(data.status || '').trim();
    if (!ALLOWED.includes(st)) {
      throw Object.assign(
        new Error(`status must be one of: ${ALLOWED.join(', ')}. Use the complete endpoint to finish a task.`),
        { status: 400, code: 'STATUS_NOT_SETTABLE' });
    }
    // 2026_117: a task cannot be started while prerequisites are outstanding.
    // Enforced here and not only in the UI — a disabled button is a hint, not
    // a rule, and the PATCH is reachable directly.
    //
    // Only 'in_progress' is guarded: moving back to 'not_started' or flagging
    // 'blocked' must always be possible, or a task started before a dependency
    // was added could never be reset.
    if (st === 'in_progress') {
      const stageBlockers = await _stageBlockers(playInstanceId, orgId);
      if (stageBlockers.length) {
        throw Object.assign(
          new Error(`This stage is locked until ${stageBlockers.join(', ')} clears its gates.`),
          { status: 409, code: 'STAGE_LOCKED', stageBlockedBy: stageBlockers });
      }
      const outstanding = await _outstandingPrereqs(playInstanceId, orgId);
      if (outstanding.length) {
        throw Object.assign(
          new Error(`Blocked by: ${outstanding.map(p => p.title).join(', ')}. `
                  + 'Complete those first, or remove the dependency.'),
          { status: 409, code: 'PREREQ_INCOMPLETE', blockedBy: outstanding });
      }
    }

    // Moving a finished play back to an in-flight status has to clear the
    // completion trail too, or the row claims both.
    add('status', st);
    add('completed_at', null);
    add('completed_by', null);
  }

  if (has('stageKey')) {
    // 2026_115: same normalisation and auto-registration as addPlay. Moving a
    // play into a stage with no definition would place it correctly in the
    // group but order that group alphabetically.
    const sk = _stageKeyFrom(data.stageKey);
    if (!sk) throw Object.assign(new Error('stageKey cannot be blank.'), { status: 400 });
    if (sk !== 'custom') {
      await _ensureStageExists(handoverId, orgId, userId, sk, data.stageName);
    }
    add('stage_key', sk);
  }

  // A date change and its audit row must land together or not at all.
  //
  // These were previously two independent pool.query() calls. If the revision
  // INSERT failed — revised_by is NOT NULL, so a caller that omitted userId
  // was enough — the UPDATE had already committed and the date moved with no
  // record of it. That is precisely the state the audit trail exists to make
  // impossible, so both statements now share one transaction.
  if (dueChanged && !userId) {
    throw Object.assign(
      new Error('A date change must be attributed to a user.'), { status: 400 });
  }

  if (sets.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      params.push(playInstanceId, orgId);
      await client.query(
        `UPDATE project_play_instances SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND org_id = $${params.length}`,
        params
      );

      // Only an actual movement is recorded — a no-op save is not a revision.
      if (dueChanged) {
        await client.query(
          `INSERT INTO play_due_date_revisions
             (org_id, source_module, project_play_instance_id,
              from_due_date, to_due_date, reason, is_rebaseline,
              previous_baseline_date, revised_by)
           VALUES ($1, 'project', $2, $3, $4, $5, $6, $7, $8)`,
          [orgId, playInstanceId,
           current.due_date || null, newDue,
           (data.reason || '').trim() || null,
           wantsRebaseline,
           wantsRebaseline ? (current.baseline_due_date || null) : null,
           userId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const plays = await _getPlays(handoverId, orgId);
  return { play: plays.find(p => p.playInstanceId === playInstanceId) || null };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function _getHandover(handoverId, orgId) {
  const { rows } = await pool.query(
    'SELECT * FROM sales_handovers WHERE id = $1 AND org_id = $2',
    [handoverId, orgId]
  );
  if (rows.length === 0) throw Object.assign(new Error('Handover not found'), { status: 404 });
  return fmt(rows[0]);
}

async function _getStakeholders(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT pc.id,
            pc.context_id                        AS handover_id,
            pc.contact_id,
            pc.role                              AS handover_role,
            pc.side                              AS side,
            cr.name                              AS handover_role_label,
            pc.is_primary                        AS is_primary_contact,
            pc.notes                             AS relationship_notes,
            pc.created_at,
            (c.first_name || ' ' || c.last_name) AS name,
            c.email                              AS contact_email,
            c.title                              AS contact_title,
            c.phone                              AS contact_phone,
            a.name                               AS account_name
     FROM project_contacts pc
     JOIN contacts c ON c.id = pc.contact_id
     LEFT JOIN accounts a ON a.id = c.account_id
     -- Roles are configurable now (2026_93), so the label comes from
     -- contact_roles rather than a hard-coded map. LEFT JOIN so a row whose
     -- role was later deactivated still renders, using its raw key.
     LEFT JOIN contact_roles cr
            ON cr.org_id = pc.org_id AND cr.side = pc.side AND cr.key = pc.role
     WHERE pc.context_type = 'handover' AND pc.context_id = $1 AND pc.org_id = $2
     ORDER BY pc.side, pc.is_primary DESC, name ASC`,
    [handoverId, orgId]
  );
  return rows.map(fmtStakeholder);
}

// ── Project-contact add policy ───────────────────────────────────────────────
async function _policyContext(handoverId, orgId, userId) {
  const { rows: [h] } = await pool.query(
    `SELECT h.assigned_service_owner_id, h.contact_add_policy, d.owner_id AS deal_owner_id
       FROM sales_handovers h LEFT JOIN deals d ON d.id = h.deal_id
      WHERE h.id = $1 AND h.org_id = $2`, [handoverId, orgId]);
  if (!h) return null;
  const { rows: [ou] } = await pool.query(
    `SELECT role FROM org_users WHERE user_id = $1 AND org_id = $2`, [userId, orgId]);
  const policy = h.contact_add_policy || { deal_owner: true, service_owner: true, admins: true, named_users: [] };
  return {
    policy,
    isAdmin: ou?.role === 'admin',
    isDealOwner: userId === h.deal_owner_id,
    isServiceOwner: userId === h.assigned_service_owner_id,
  };
}

async function canAddContacts(handoverId, orgId, userId) {
  const ctx = await _policyContext(handoverId, orgId, userId);
  if (!ctx) return false;
  const p = ctx.policy;
  const named = Array.isArray(p.named_users) ? p.named_users.map(Number) : [];
  return (!!p.admins && ctx.isAdmin)
      || (!!p.deal_owner && ctx.isDealOwner)
      || (!!p.service_owner && ctx.isServiceOwner)
      || named.includes(Number(userId));
}

// The fixed editor set — deal owner, service owner, or admin — may configure the policy.
async function canEditContactPolicy(handoverId, orgId, userId) {
  const ctx = await _policyContext(handoverId, orgId, userId);
  return !!ctx && (ctx.isAdmin || ctx.isDealOwner || ctx.isServiceOwner);
}

async function getContactPolicy(handoverId, orgId) {
  const { rows: [h] } = await pool.query(
    `SELECT contact_add_policy FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
  return h?.contact_add_policy || { deal_owner: true, service_owner: true, admins: true, named_users: [] };
}

async function setContactPolicy(handoverId, orgId, userId, policy) {
  if (!(await canEditContactPolicy(handoverId, orgId, userId)))
    throw Object.assign(new Error('You cannot configure who adds contacts on this project'), { status: 403 });
  const clean = {
    deal_owner:    !!policy.deal_owner,
    service_owner: !!policy.service_owner,
    admins:        !!policy.admins,
    named_users:   Array.isArray(policy.named_users) ? policy.named_users.map(Number).filter(Boolean) : [],
  };
  await pool.query(`UPDATE sales_handovers SET contact_add_policy = $3 WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId, JSON.stringify(clean)]);
  return { policy: clean };
}

async function _getCommitments(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT c.*,
            u.first_name  || ' ' || u.last_name  AS created_by_name,
            uo.first_name || ' ' || uo.last_name AS owner_name,
            uc.first_name || ' ' || uc.last_name AS closed_by_name
     FROM sales_handover_commitments c
     LEFT JOIN users u  ON u.id  = c.created_by
     LEFT JOIN users uo ON uo.id = c.owner_user_id
     LEFT JOIN users uc ON uc.id = c.closed_by
     WHERE c.handover_id = $1 AND c.org_id = $2
     ORDER BY
       -- open work first, soonest due at the top; closed items sink
       (c.status IN ('met','waived','breached')) ASC,
       c.due_date ASC NULLS LAST,
       c.commitment_type ASC,
       c.created_at ASC`,
    [handoverId, orgId]
  );
  return rows.map(fmtCommitment);
}

/**
 * @param {boolean} hideInternalNotes — the viewer is the acceptor of this
 *   work, so internal notes must not be COUNTED either. A badge reading "4"
 *   over a list that renders two is worse than no badge: it tells the acceptor
 *   there is something they are not being shown.
 *
 *   Only _getHandover() passes it. The other callers return plays as the
 *   response to a write, and the acceptor does not perform those writes.
 */
async function _getPlays(handoverId, orgId, hideInternalNotes = false) {
  // org_id added to the predicate: every other _get* helper in this file is
  // org-scoped and this one was not. Callers all pre-verify the handover via
  // _getHandover(), so this is defence in depth rather than a live leak — but
  // it removes the possibility of a future caller forgetting.
  const { rows } = await pool.query(
    `SELECT
       dpi.id,
       dpi.id   AS play_instance_id,
       dpi.handover_id,
       dpi.completed_at,
       dpi.title, dpi.description, dpi.channel, dpi.is_gate,
       dpi.stage_key,
       dpi.execution_type, dpi.sort_order, dpi.priority,
       dpi.status AS play_status, dpi.completed_by,
       dpi.due_date, dpi.due_anchor,
       dpi.baseline_due_date, dpi.baseline_source,
       dpi.completion_note, dpi.completion_evidence,
       dpi.play_id, dpi.playbook_id, dpi.owner_user_id,
       ou.first_name || ' ' || ou.last_name AS owner_name,
       cu.first_name || ' ' || cu.last_name AS completed_by_name,
       pb.name AS playbook_name,
       -- 2026_116: project_stages is the single source of truth for this
       -- project's stages, materialized from the org catalogue at creation
       -- the same way project_play_instances materializes playbook_plays.
       -- No COALESCE against playbook_stages — that table is dead (its only
       -- write endpoint returns 400 unconditionally) and duplicating
       -- precedence logic across readers is what let ordering drift before.
       pst.name       AS stage_name,
       pst.sort_order AS stage_sort_order,
       dpi.depends_on,
       pst.gating AS stage_gating,
       -- 2026_118 stage gating (gate-only by default). A stage is locked while
       -- an EARLIER stage still has an incomplete gate. Not "any incomplete
       -- task": one forgotten checklist item should not freeze a project, and
       -- is_gate already marks the steps that genuinely matter.
       --
       -- Evaluated per row rather than per stage so it composes with the
       -- per-task dependency check in blocked_by — a task is startable only
       -- when BOTH come back clear.
       --
       -- DISTINCT is applied with a plain subquery rather than a derived
       -- table: a derived table referencing dpi/pst from the outer query
       -- would need LATERAL, and json_agg(DISTINCT ...) over the correlated
       -- select achieves the same de-duplication without it.
       COALESCE((
         SELECT json_agg(DISTINCT COALESCE(ps2.name, e.stage_key))
           FROM project_play_instances e
           LEFT JOIN project_stages ps2
                  ON ps2.handover_id = e.handover_id AND ps2.key = e.stage_key
                 AND ps2.is_active = TRUE
          WHERE e.handover_id = dpi.handover_id
            AND e.status NOT IN ('completed', 'skipped')
            AND ps2.sort_order < pst.sort_order
            AND (pst.gating = 'strict' OR (pst.gating = 'gates' AND e.is_gate = TRUE))
       ), '[]'::json) AS stage_blocked_by,
       -- 2026_117: the prerequisites that are NOT yet satisfied. Computed
       -- here rather than in the client so the same rule drives the UI, the
       -- API guard, and any future reporting — a task is startable iff this
       -- comes back empty.
       --
       -- 'skipped' counts as satisfied: skipping is a deliberate decision that
       -- the step will not happen, and PlaybookPlayService.skipPlayForProject
       -- already resolves downstream dependencies the same way completion does.
       COALESCE((
         SELECT json_agg(json_build_object(
                  'id', d.id, 'title', d.title, 'status', d.status)
                  ORDER BY d.id)
           FROM project_play_instances d
          WHERE d.id = ANY(dpi.depends_on)
            AND d.status NOT IN ('completed', 'skipped')
       ), '[]'::json) AS blocked_by,
       -- 2026_120: how many live notes sit on this task, so the checklist can
       -- show that an explanation exists without fetching every note on every
       -- task up front. The notes themselves are loaded on expand.
       (SELECT count(*)
          FROM play_notes n
         WHERE n.project_play_instance_id = dpi.id
           AND n.deleted_at IS NULL
           AND ($3::boolean IS NOT TRUE OR n.is_internal = FALSE))::int AS note_count
     FROM project_play_instances dpi
     LEFT JOIN users ou     ON ou.id = dpi.owner_user_id
     LEFT JOIN users cu     ON cu.id = dpi.completed_by
     LEFT JOIN playbooks pb ON pb.id = dpi.playbook_id
     LEFT JOIN project_stages pst ON pst.handover_id = dpi.handover_id
                                 AND pst.key = dpi.stage_key
                                 AND pst.is_active = TRUE
     WHERE dpi.handover_id = $1
       AND ($2::int IS NULL OR dpi.org_id = $2)
     -- Plan order first, date as the tiebreak.
     --
     -- This was ORDER BY due_date, sort_order — date-driven, so the checklist
     -- read as a to-do list rather than a plan and reordering a play had no
     -- visible effect. Stage sequence now leads, then position within the
     -- stage, then date. A stage with no definition still sorts last rather
     -- than jumping to the front, though after 2026_116 that should not
     -- happen: every key in use is materialized.
     ORDER BY pst.sort_order ASC NULLS LAST,
              dpi.stage_key ASC,
              dpi.sort_order ASC,
              dpi.due_date ASC NULLS LAST,
              dpi.id ASC`,
    [handoverId, orgId ?? null, !!hideInternalNotes]
  );
  return rows.map(fmtPlay);
}

/**
 * Map a deal_contacts.role string to a handover_role enum value.
 * Unmapped roles default to 'other'.
 */
function _mapDealContactRole(dealRole) {
  const map = {
    decision_maker:    'go_live_approver',
    champion:          'implementation_lead',
    technical_contact: 'technical_lead',
    economic_buyer:    'exec_sponsor',
    user:              'day_to_day_admin',
    influencer:        'other',
  };
  return map[dealRole] ?? 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Nightly sweep — Phase 2
//
// runNightlySweep(orgId)
//   Called by syncScheduler at 01:45 UTC.
//   Processes every non-draft handover for the org:
//     1. buildHandoverContext(handover) — assemble derived fields
//     2. HandoverRulesEngine.evaluate() — pure rules, returns fired alerts
//     3. ActionPersister.upsertDiagnosticAlert() per fired rule
//        entityType='handover' → writes to actions table using deal_id FK
//     4. ActionPersister.resolveStaleDiagnostics() for cleared conditions
//
// Architectural note:
//   entityId passed to ActionPersister is the DEAL_ID, not the handover id.
//   This is the confirmed pattern from Section 13 point 7 of the handover doc.
//   ActionPersister's FK_COLUMN map routes entityType='handover' → deal_id.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the context object expected by HandoverRulesEngine.evaluate().
 *
 * @param {object} handoverRow  — raw row from sales_handovers
 * @returns {Promise<object>}   context shaped for HandoverRulesEngine
 */
async function buildHandoverContext(handoverRow) {
  const now = new Date();

  const daysSinceCreated = Math.floor(
    (now - new Date(handoverRow.created_at)) / (1000 * 60 * 60 * 24)
  );

  const daysSinceLastActivity = Math.floor(
    (now - new Date(handoverRow.updated_at)) / (1000 * 60 * 60 * 24)
  );

  // Check for any kickoff meeting linked to this handover
  const meetingResult = await pool.query(
    `SELECT id FROM meetings
     WHERE handover_id = $1
     LIMIT 1`,
    [handoverRow.id]
  );
  const hasKickoffMeeting = meetingResult.rows.length > 0;

  // Find commitments with a due_date that has passed
  // Requires the due_date column added by migration_phase2.sql
  const overdueResult = await pool.query(
    `SELECT id, description, commitment_type, due_date
     FROM sales_handover_commitments
     WHERE handover_id = $1
       AND due_date IS NOT NULL
       AND due_date < CURRENT_DATE`,
    [handoverRow.id]
  );
  const overdueCommitments = overdueResult.rows;

  // Find which required stakeholder roles are present
  const stakeholderResult = await pool.query(
    `SELECT DISTINCT handover_role
     FROM sales_handover_stakeholders
     WHERE handover_id = $1`,
    [handoverRow.id]
  );
  const presentRoles = new Set(stakeholderResult.rows.map(r => r.handover_role));
  const missingRequiredRoles = HandoverRulesEngine.REQUIRED_ROLES.filter(
    role => !presentRoles.has(role)
  );

  // Brief completeness: go_live_date set + commercial_terms_summary populated
  // Add more required fields here as the brief spec grows
  const briefIsComplete =
    handoverRow.go_live_date            != null &&
    handoverRow.commercial_terms_summary != null &&
    handoverRow.commercial_terms_summary.trim().length > 0;

  return {
    handover: handoverRow,
    derived: {
      daysSinceCreated,
      daysSinceLastActivity,
      hasKickoffMeeting,
      overdueCommitments,
      missingRequiredRoles,
      briefIsComplete,
    },
  };
}

/**
 * Run the full nightly diagnostic sweep for all active handovers in an org.
 *
 * "Active" means any status that is not 'draft' — submitted, acknowledged,
 * and in_progress handovers all require monitoring.
 *
 * @param {number} orgId
 * @returns {Promise<{ processed: number, alerts: number, resolved: number, errors: number }>}
 */
async function runNightlySweep(orgId) {
  const stats = { processed: 0, alerts: 0, resolved: 0, errors: 0 };

  // Load org diagnostic rules config once for entire sweep
  let handoverConfig = {};
  try {
    const rulesConfig  = await getDiagnosticRulesConfig(orgId);
    handoverConfig     = rulesConfig.handovers || {};
  } catch (_) { /* use engine defaults */ }

  let handovers;
  try {
    const result = await pool.query(
      `SELECT h.id, h.org_id, h.deal_id, h.account_id,
              h.assigned_service_owner_id,
              h.status, h.go_live_date,
              h.commercial_terms_summary,
              h.submitted_at, h.acknowledged_at,
              h.created_at, h.updated_at
       FROM sales_handovers h
       WHERE h.org_id = $1
         AND h.status NOT IN ('draft', 'completed', 'cancelled')
       ORDER BY h.id ASC`,
      [orgId]
    );
    handovers = result.rows;
  } catch (err) {
    console.error(`[HandoverNightlySweep] Failed to fetch handovers for org ${orgId}:`, err.message);
    return stats;
  }

  for (const handoverRow of handovers) {
    try {
      // Build derived context fields
      const ctx = await buildHandoverContext(handoverRow);

      // Run all diagnostic rules — pure, no DB
      const fired = HandoverRulesEngine.evaluate(ctx, handoverConfig);

      // Upsert each fired alert.
      //
      // 2026_119: entityType='project', entityId=handover.id. This was
      // 'handover' with deal_id, which meant INTERNAL projects — where
      // sales_handovers_kind_shape_chk forces deal_id NULL — could not be
      // persisted at all: the partial index did not apply and ON CONFLICT
      // matched nothing. dealId is still passed so customer projects keep
      // their deal link and anything reading by deal keeps working.
      const firedSourceRules = [];
      for (const alert of fired) {
        const id = await ActionPersister.upsertDiagnosticAlert({
          entityType: 'project',
          entityId:   handoverRow.id,
          dealId:     handoverRow.deal_id || null,
          sourceRule: alert.sourceRule,
          title:      alert.title,
          description: alert.description,
          priority:   alert.priority,
          nextStep:   alert.nextStep,
          orgId:      orgId,
          userId:     handoverRow.assigned_service_owner_id || null,
        });
        if (id != null) {
          firedSourceRules.push(alert.sourceRule);
          stats.alerts++;
        }
      }

      // Resolve stale diagnostics. Must key the same way the upsert did, or
      // alerts written against handover_id would never be cleared.
      const resolvedCount = await ActionPersister.resolveStaleDiagnostics({
        entityType: 'project',
        entityId:   handoverRow.id,
        firedRules: firedSourceRules,
        orgId:      orgId,
      });
      stats.resolved  += resolvedCount;
      stats.processed += 1;

    } catch (err) {
      console.error(
        `[HandoverNightlySweep] Error processing handover ${handoverRow.id} ` +
        `(deal ${handoverRow.deal_id}, org ${orgId}):`,
        err.message
      );
      stats.errors++;
    }
  }

  console.log(
    `[HandoverNightlySweep] org=${orgId} processed=${stats.processed} ` +
    `alerts=${stats.alerts} resolved=${stats.resolved} errors=${stats.errors}`
  );

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event trigger — Phase 7
//
// generateForHandoverEvent(handoverId, orgId, eventType)
//
//   Ad-hoc diagnostic re-run for a single handover triggered by a discrete
//   real-time event. Runs HandoverRulesEngine + upsert + resolve for just
//   this handover, producing the same result the nightly sweep would produce
//   the following morning.
//
//   IMPORTANT: entityId passed to ActionPersister is the DEAL_ID (not the
//   handover id) — consistent with the architectural decision confirmed in
//   handover doc Section 13 point 7. This function resolves the deal_id
//   from the handover row before calling ActionPersister.
//
//   Supported eventType values (informational — logged only, not branched on):
//     'kickoff_meeting_created'   — a meeting with handover_id set was created
//     'kickoff_meeting_completed' — kickoff meeting marked completed
//     'commitment_added'          — new commitment row created
//     'commitment_updated'        — commitment due_date changed or status updated
//     'stakeholder_added'         — new stakeholder attached
//     'brief_updated'             — go_live_date or commercial_terms_summary changed
//
//   Callers fire this non-blocking:
//     generateForHandoverEvent(handoverId, orgId, 'commitment_added')
//       .catch(err => console.error('Handover event trigger error:', err.message));
//
//   Skips draft handovers silently (consistent with nightly sweep filter).
//   Skips if handover not found (org_id mismatch).
//
// @param {number} handoverId
// @param {number} orgId
// @param {string} eventType
// @returns {Promise<{ alerts: number, resolved: number }>}
// ─────────────────────────────────────────────────────────────────────────────

async function generateForHandoverEvent(handoverId, orgId, eventType) {
  try {
    // Load handover — skip drafts (consistent with nightly sweep)
    const result = await pool.query(
      `SELECT h.id, h.org_id, h.deal_id, h.account_id,
              h.assigned_service_owner_id,
              h.status, h.go_live_date,
              h.commercial_terms_summary,
              h.submitted_at, h.acknowledged_at,
              h.created_at, h.updated_at
       FROM sales_handovers h
       WHERE h.id = $1
         AND h.org_id = $2
         AND h.status NOT IN ('draft', 'completed', 'cancelled')`,
      [handoverId, orgId]
    );

    if (result.rows.length === 0) {
      // Silently skip — draft or not found
      return { alerts: 0, resolved: 0 };
    }

    const handoverRow = result.rows[0];

    console.log(
      `[HandoverEventTrigger] handover=${handoverId} event=${eventType} ` +
      `deal=${handoverRow.deal_id} org=${orgId}`
    );

    const ctx   = await buildHandoverContext(handoverRow);

    let handoverConfigEvent = {};
    try {
      const rulesConfig      = await getDiagnosticRulesConfig(orgId);
      handoverConfigEvent    = rulesConfig.handovers || {};
    } catch (_) {}
    const fired = HandoverRulesEngine.evaluate(ctx, handoverConfigEvent);

    const firedSourceRules = [];
    let totalAlerts = 0;

    for (const alert of fired) {
      const id = await ActionPersister.upsertDiagnosticAlert({
        entityType:  'handover',
        entityId:    handoverRow.deal_id,   // deal_id, not handover.id — architectural decision #7
        sourceRule:  alert.sourceRule,
        title:       alert.title,
        description: alert.description,
        priority:    alert.priority,
        nextStep:    alert.nextStep,
        orgId,
        userId:      handoverRow.assigned_service_owner_id || null,
      });
      if (id != null) {
        firedSourceRules.push(alert.sourceRule);
        totalAlerts++;
      }
    }

    const totalResolved = await ActionPersister.resolveStaleDiagnostics({
      entityType: 'project',
      entityId:   handoverRow.id,
      firedRules: firedSourceRules,
      orgId,
    });

    console.log(
      `[HandoverEventTrigger] handover=${handoverId} event=${eventType} ` +
      `alerts=${totalAlerts} resolved=${totalResolved}`
    );

    return { alerts: totalAlerts, resolved: totalResolved };

  } catch (err) {
    console.error(
      `handover.service.generateForHandoverEvent error ` +
      `(handover=${handoverId} event=${eventType}):`,
      err.message
    );
    return { alerts: 0, resolved: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// ── Assignable users ──────────────────────────────────────────────────────────
// Org-scoped, non-super list of members who can own a commitment (or, later, be
// picked as a service owner). Membership + active state live in org_users — NOT
// on users — and a user can belong to multiple orgs, so we scope through
// org_users rather than users.org_id.
async function listAssignableUsers(orgId) {
  const { rows } = await pool.query(
    `SELECT u.id,
            u.first_name,
            u.last_name,
            u.first_name || ' ' || u.last_name AS name,
            u.email,
            ou.role
     FROM org_users ou
     JOIN users u ON u.id = ou.user_id
     WHERE ou.org_id = $1 AND ou.is_active = TRUE
     ORDER BY u.first_name, u.last_name`,
    [orgId]
  );
  return rows.map(r => ({
    id:        r.id,
    name:      r.name,
    firstName: r.first_name,
    lastName:  r.last_name,
    email:     r.email,
    role:      r.role,
  }));
}

/**
 * Portfolio aggregation for the Handovers → Dashboard tab. Reads every
 * (non-cancelled) handover for the org, joins the deliverable rollup, project
 * type, rain (risk/red_flag commitments) and next action, then derives the
 * dashboard KPIs, distributions, rain-impact and risk matrix in one pass.
 * Everything is computed from the tables — nothing is stored.
 */
async function getPortfolio(orgId) {
  const { rows } = await pool.query(
    `SELECT h.id AS handover_id, h.status, h.go_live_date,
            a.name AS account, d.name AS deal,
            a.external_refs->>'project_type' AS project_type,
            COALESCE(r.plays_done, 0)::int    AS plays_done,
            COALESCE(r.plays_total, 0)::int   AS plays_total,
            COALESCE(r.plays_overdue, 0)::int AS plays_overdue,
            COALESCE(r.gates_open, 0)::int    AS gates_open,
            (SELECT max(CASE c.commitment_type WHEN 'red_flag' THEN 2 WHEN 'risk' THEN 1 ELSE 0 END)
               FROM sales_handover_commitments c
              WHERE c.handover_id = h.id
                AND c.commitment_type IN ('risk','red_flag')
                AND c.status NOT IN ('met','waived')) AS rain_sev,
            (SELECT c.description FROM sales_handover_commitments c
              WHERE c.handover_id = h.id AND c.status IN ('open','in_progress')
              ORDER BY c.due_date NULLS LAST, c.id LIMIT 1) AS next_action
       FROM sales_handovers h
       LEFT JOIN deals    d ON d.id = h.deal_id
       LEFT JOIN accounts a ON a.id = h.account_id
       LEFT JOIN handover_deliverable_rollup r ON r.handover_id = h.id
      WHERE h.org_id = $1 AND h.status <> 'cancelled'
      ORDER BY d.close_date NULLS LAST, h.id`,
    [orgId]
  );

  const kpis = { total: rows.length, on_track: 0, in_progress: 0, ready_to_start: 0,
                 yet_to_start: 0, completed: 0, rain_affected: 0 };
  const statusDistribution = {}, typeDistribution = {};
  const rainImpact = { high: 0, medium: 0, none: 0 };
  const riskMatrix = { high: 0, medium: 0, low: 0 };

  const projects = rows.map(r => {
    const sev = Number(r.rain_sev) || 0;
    const rain = sev === 2 ? 'high' : sev === 1 ? 'medium' : 'none';
    const progress = r.plays_total > 0 ? Math.round((r.plays_done / r.plays_total) * 100) : 0;

    let status;
    switch (r.status) {
      case 'draft':        status = 'yet_to_start';   break;
      case 'submitted':
      case 'acknowledged': status = 'ready_to_start'; break;
      case 'completed':    status = 'completed';      break;
      default:             status = sev > 0 ? 'in_progress' : 'on_track';
    }

    let risk;
    if (r.status === 'completed')      risk = 'low';
    else if (sev === 2)                risk = 'high';
    else if (sev === 1)                risk = 'medium';
    else if ((status === 'on_track' || status === 'in_progress') && r.plays_overdue > 0) risk = 'medium';
    else                               risk = 'low';

    kpis[status] += 1;
    if (rain !== 'none') kpis.rain_affected += 1;
    statusDistribution[status] = (statusDistribution[status] || 0) + 1;
    const t = r.project_type || 'Other';
    typeDistribution[t] = (typeDistribution[t] || 0) + 1;
    rainImpact[rain] += 1;
    riskMatrix[risk] += 1;

    return {
      handoverId: r.handover_id,
      account: r.account,
      deal: r.deal,
      projectType: r.project_type || 'Other',
      status,
      progress,
      rain,
      nextAction: r.next_action || null,
      goLiveDate: r.go_live_date,
    };
  });

  return { kpis, statusDistribution, typeDistribution, rainImpact, riskMatrix, projects };
}

/**
 * Unified customer communications for a handover: emails on the deal + WhatsApp
 * messages on the handover thread, merged and time-ordered. Powers the
 * Communications tab.
 */
async function getCommunications(handoverId, orgId) {
  const { rows: hrows } = await pool.query(
    `SELECT deal_id FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]
  );
  if (hrows.length === 0) throw Object.assign(new Error('Handover not found'), { status: 404 });
  const dealId = hrows[0].deal_id;

  // Deal-tagged OR project-tagged. Two changes from before:
  //
  //   • dealId may be NULL (internal projects have no deal), in which case the
  //     old `e.deal_id = $2` matched nothing and the tab showed no mail at all.
  //   • project-tagged mail is org-scoped, not user-scoped — tagging a thread
  //     publishes every mailbox copy to the project's members, which is the
  //     point of thread-level tagging.
  //
  // DISTINCT ON collapses those copies. One message in three colleagues'
  // mailboxes is three rows (Graph issues a message id per mailbox), and
  // without this the Communications tab shows it three times. The surviving row
  // is the one that carries the most context — a resolved contact first, then
  // lowest id for stability.
  const emailThreads = require('./emailThreads.service');
  const emails = await pool.query(
    `SELECT DISTINCT ON (${emailThreads.DEDUPE_KEY})
            e.id, e.direction, e.subject, e.body, e.from_address, e.to_address, e.cc_addresses,
            e.contact_id, ct.first_name || ' ' || ct.last_name AS contact_name,
            e.user_id AS sender_user_id, su.first_name || ' ' || su.last_name AS sender_name,
            e.sent_at, e.created_at, e.conversation_id, e.handover_id, e.tag_source
       FROM emails e
       LEFT JOIN contacts ct ON ct.id = e.contact_id
       LEFT JOIN users su ON su.id = e.user_id
      WHERE e.org_id = $1
        AND e.deleted_at IS NULL
        AND e.hidden_at IS NULL
        AND ( ($2::int IS NOT NULL AND e.deal_id = $2) OR e.handover_id = $3 )
      ORDER BY ${emailThreads.DEDUPE_KEY}, (e.contact_id IS NOT NULL) DESC, e.id`,
    [orgId, dealId, handoverId]
  );
  const wa = await pool.query(
    `SELECT m.id, m.direction, m.body, m.from_name, m.is_automated, m.status,
            m.handover_id, m.handover_source, m.thread_id,
            m.sent_by_user_id AS sender_user_id, su.first_name || ' ' || su.last_name AS sender_name,
            COALESCE(m.sent_at, m.created_at) AS at,
            t.group_subject, t.contact_id, ct.first_name || ' ' || ct.last_name AS contact_name,
            (SELECT jsonb_agg(jsonb_build_object('name', p.display_name, 'side', p.side)
                              ORDER BY p.side, p.display_name)
               FROM whatsapp_thread_participants p WHERE p.thread_id = t.id) AS participants
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id
       LEFT JOIN users su ON su.id = m.sent_by_user_id
      -- PRECEDENCE, not OR. One person has exactly ONE direct thread, so a
      -- message sent to them from a second project lands on the thread the
      -- first project owns. The MESSAGE says which project it belongs to; the
      -- thread's project is only the fallback for a message that never got one.
      --
      -- This was "t.handover_id = $2 OR m.handover_id = $2", which fixed the
      -- second project seeing nothing but left the first project seeing
      -- everything — every message on that person's conversation showed up
      -- under whichever project happened to open it, including the other
      -- project's templates and the replies to them.
      WHERE t.org_id = $1
        AND ( m.handover_id = $2
           OR (m.handover_id IS NULL AND t.handover_id = $2) )`,
    [orgId, handoverId]
  );

  // ── Microsoft Teams ──────────────────────────────────────────────────────
  //
  // Same precedence rule as WhatsApp, for the same reason: the MESSAGE says
  // which project it belongs to, and the thread's project is only the fallback
  // for a message that never got one. A channel covering several projects has
  // per-thread attribution, so reading the conversation's project instead would
  // pull every thread in that channel into whichever project asked.
  //
  // is_system_event is excluded here, not just indexed against. "Call started"
  // and "member removed" are not communications — they are Teams describing
  // itself, and a handover timeline that shows them buries the commitments it
  // exists to surface.
  //
  // deleted_at is excluded too, but the ROW is not deleted — see 2026_126. A
  // message removed in Teams stops appearing here while any play evidence
  // pointing at it still resolves to the body frozen at capture.
  const teams = await pool.query(
    `SELECT m.id, m.body_current, m.body_text, m.from_display_name, m.from_user_id,
            m.sent_at, m.edited_at, m.message_type, m.mentions,
            m.handover_id, m.attribution_source, m.thread_id,
            su.first_name || ' ' || su.last_name AS sender_name,
            c.display_name AS conversation_name, c.kind, c.team_name,
            t.subject AS thread_subject,
            (SELECT jsonb_agg(jsonb_build_object(
                      'name', p.display_name, 'external', p.is_external)
                             ORDER BY p.display_name)
               FROM msteams_conversation_participants p
              WHERE p.conversation_id = c.id) AS participants,
            (SELECT jsonb_agg(jsonb_build_object(
                      'name', a.snapshot_file_name, 'url', a.content_url,
                      'status', a.media_status))
               FROM msteams_message_attachments a
              WHERE a.message_id = m.id AND a.media_status <> 'skipped') AS attachments
       FROM msteams_messages m
       JOIN msteams_conversations c ON c.id = m.conversation_id
       JOIN msteams_threads t       ON t.id = m.thread_id
       LEFT JOIN users su ON su.id = m.from_user_id
      WHERE m.org_id = $1
        AND m.excluded_at IS NULL
        AND m.deleted_at  IS NULL
        AND m.is_system_event = false
        AND ( m.handover_id = $2
           OR (m.handover_id IS NULL AND t.handover_id = $2) )`,
    [orgId, handoverId]
  );

  const outbound = d => d === 'sent' || d === 'outbound';
  const items = [
    ...emails.rows.map(e => ({
      id: `email-${e.id}`, channel: 'email',
      direction: outbound(e.direction) ? 'outbound' : 'inbound',
      from: outbound(e.direction) ? (e.sender_name || 'Delivery team') : (e.from_address || 'Customer'),
      subject: e.subject, body: e.body,
      at: e.sent_at || e.created_at, isAutomated: false,
      to: e.to_address || null, cc: _splitAddrs(e.cc_addresses),
      groupSubject: null, participants: [],
      contactId: e.contact_id || null, contactName: e.contact_name || null,
      senderUserId: e.sender_user_id || null, senderName: e.sender_name || null,
      // Needed by the UI to file or unfile the conversation this message belongs
      // to. tagSource distinguishes a thread the team filed from a message that
      // merely arrived on a deal.
      emailId: e.id, conversationId: e.conversation_id || null,
      handoverId: e.handover_id || null, tagSource: e.tag_source || null,
    })),
    ...wa.rows.map(m => ({
      id: `wa-${m.id}`, channel: 'whatsapp',
      direction: outbound(m.direction) ? 'outbound' : 'inbound',
      from: outbound(m.direction) ? (m.sender_name || 'Delivery team') : (m.from_name || 'Customer'),
      subject: null, body: m.body,
      at: m.at, isAutomated: !!m.is_automated,
      to: null, cc: [],
      groupSubject: m.group_subject || null, participants: m.participants || [],
      contactId: m.contact_id || null, contactName: m.contact_name || null,
      senderUserId: m.sender_user_id || null, senderName: m.sender_name || null,
      // Needed by the UI to move a misfiled message. handoverSource says how it
      // got here ('recent_outbound' is a guess; 'manual' is somebody's decision)
      // so the panel can show whether it is worth second-guessing.
      waMessageId: m.id, threadId: m.thread_id || null,
      handoverId: m.handover_id || null, handoverSource: m.handover_source || null,
    })),
    ...teams.rows.map(m => ({
      id: `teams-${m.id}`, channel: 'teams',
      // Teams has no inbound/outbound: everyone in a chat is a peer, and unlike
      // email or a WhatsApp business number there is no "our side" endpoint to
      // measure against. Direction is derived from whether the sender resolved
      // to a GoWarmCRM user, which is the closest honest equivalent — and it
      // degrades to 'inbound' for a colleague who has not connected Teams,
      // which is the safer error of the two.
      direction: m.from_user_id ? 'outbound' : 'inbound',
      from: m.from_display_name || m.sender_name || 'Unknown',
      // A channel thread's subject is the nearest thing Teams has to a subject
      // line. Chats have none, hence the null.
      subject: m.thread_subject || null,
      // body_current, not body_original: the timeline shows what the message
      // says NOW. Play evidence resolves to body_original instead, which is the
      // whole point of holding both.
      body: m.body_current,
      bodyText: m.body_text,
      at: m.sent_at, isAutomated: false,
      to: null, cc: [],
      groupSubject: m.conversation_name || null,
      participants: m.participants || [],
      contactId: null, contactName: null,
      senderUserId: m.from_user_id || null, senderName: m.sender_name || null,
      // Needed by the UI to move a misfiled message, same as WhatsApp.
      // attributionSource says how it got here — 'binding' and 'thread_root'
      // are inherited, 'manual' is somebody's decision — so the panel can show
      // whether it is worth second-guessing.
      teamsMessageId: m.id, threadId: m.thread_id || null,
      handoverId: m.handover_id || null, attributionSource: m.attribution_source || null,
      conversationKind: m.kind || null, teamName: m.team_name || null,
      editedAt: m.edited_at || null,
      attachments: m.attachments || [],
      mentions: m.mentions || [],
    })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  // ── Who's on the project (to flag participants who aren't) ──
  const [memberRows, stakeRows, orgUserRows] = await Promise.all([
    pool.query(`SELECT pm.user_id, u.email, u.first_name || ' ' || u.last_name AS name
                  FROM project_members pm JOIN users u ON u.id = pm.user_id
                 WHERE pm.context_type = 'handover' AND pm.context_id = $1 AND pm.org_id = $2 AND pm.status = 'approved'`, [handoverId, orgId]),
    pool.query(`SELECT pc.contact_id, c.email, c.first_name || ' ' || c.last_name AS name
                  FROM project_contacts pc JOIN contacts c ON c.id = pc.contact_id
                 WHERE pc.context_type = 'handover' AND pc.context_id = $1 AND pc.org_id = $2`, [handoverId, orgId]),
    pool.query(`SELECT u.id, LOWER(u.email) AS email FROM org_users ou JOIN users u ON u.id = ou.user_id
                 WHERE ou.org_id = $1 AND ou.is_active = TRUE AND u.email IS NOT NULL`, [orgId]),
  ]);
  const knownUserIds    = new Set(memberRows.rows.map(r => r.user_id));
  const knownContactIds = new Set(stakeRows.rows.map(r => r.contact_id));
  const knownEmails     = new Set([...memberRows.rows, ...stakeRows.rows].map(r => (r.email || '').toLowerCase()).filter(Boolean));
  const orgUserByEmail  = new Map(orgUserRows.rows.map(r => [r.email, r.id]));

  const peopleMap = new Map();
  const addP = (p) => { if (!peopleMap.has(p.key)) peopleMap.set(p.key, p); };
  for (const it of items) {
    const keys = [];
    if (it.contactId) {
      const k = `contact:${it.contactId}`; keys.push(k);
      addP({ key: k, type: 'contact', name: it.contactName || 'Contact', contactId: it.contactId, onProject: knownContactIds.has(it.contactId) });
    }
    if (it.senderUserId) {
      const k = `user:${it.senderUserId}`; keys.push(k);
      addP({ key: k, type: 'user', name: it.senderName || 'Team member', userId: it.senderUserId, onProject: knownUserIds.has(it.senderUserId) });
    }
    const addrs = [];
    if (it.channel === 'email') {
      if (it.direction === 'inbound' && it.from && it.from.includes('@')) addrs.push(it.from);
      if (it.direction === 'outbound') { if (it.to) addrs.push(it.to); (it.cc || []).forEach(a => addrs.push(a)); }
    }
    for (const raw of addrs) {
      const email = String(raw).trim().toLowerCase();
      if (!email.includes('@') || knownEmails.has(email)) continue;
      const k = `email:${email}`; keys.push(k);
      const matchedUserId = orgUserByEmail.get(email) || null;
      addP({ key: k, type: matchedUserId ? 'offteam_user' : 'external', name: String(raw).trim(), email, matchedUserId, onProject: false });
    }
    it.participantKeys = keys;
  }
  const people = [...peopleMap.values()]
    .sort((a, b) => (a.onProject === b.onProject ? 0 : a.onProject ? -1 : 1) || a.name.localeCompare(b.name));

  return { items, people };
}

/** Every project a team member is on, with their role — the person drill-down. */
async function getTeamMemberProjects(userId, orgId) {
  // Rewritten 2026-08. The previous version started FROM deal_team_members and
  // inner-joined deals, which answered "which deals is this person on" — not
  // "which projects". It missed internal projects entirely (no deal), and
  // missed anyone attached to a project without being on the originating deal
  // team, which is now the common case.
  //
  // Starts from the project and unions the three ways someone can be attached.
  const { rows } = await pool.query(
    `SELECT h.id AS handover_id,
            h.project_kind,
            COALESCE(h.name, d.name)          AS project,
            d.name                            AS deal,
            a.name                            AS account,
            h.status,
            h.go_live_date,
            h.contract_value,
            h.budget,
            (h.assigned_service_owner_id = $1) AS is_service_owner,
            COALESCE(orole.name, pm.custom_role, dtmrole.name, dtm.custom_role) AS role_name
       FROM sales_handovers h
       LEFT JOIN deals    d ON d.id = h.deal_id
       LEFT JOIN accounts a ON a.id = h.account_id
       LEFT JOIN project_members pm
              ON pm.context_type = 'handover' AND pm.context_id = h.id
             AND pm.org_id = h.org_id AND pm.user_id = $1 AND pm.status = 'approved'
       LEFT JOIN org_roles orole  ON orole.id = pm.role_id
       LEFT JOIN deal_team_members dtm
              ON dtm.deal_id = h.deal_id AND dtm.org_id = h.org_id AND dtm.user_id = $1
       LEFT JOIN org_roles dtmrole ON dtmrole.id = dtm.role_id
      WHERE h.org_id = $2
        AND (h.assigned_service_owner_id = $1 OR pm.id IS NOT NULL OR dtm.id IS NOT NULL)
      ORDER BY h.go_live_date NULLS LAST, h.id`,
    [userId, orgId]
  );

  return rows.map(r => ({
    handoverId:   r.handover_id,
    projectKind:  r.project_kind || 'customer',
    project:      r.project || `Project #${r.handover_id}`,
    deal:         r.deal    || null,
    // Internal projects have no account by design, so say so rather than
    // rendering a blank cell that reads as missing data.
    account:      r.account || (r.project_kind === 'internal' ? 'Internal project' : null),
    status:       r.status,
    goLiveDate:   r.go_live_date,
    contractValue: r.contract_value ?? null,
    budget:        r.budget ?? null,
    // Service owner wins: it is the accountable role, whatever else they hold.
    role: r.is_service_owner ? 'Service owner' : (r.role_name || 'Team member'),
  }));
}

/**
 * Individual dashboard for a team member: the projects they're on, the
 * deliverables they own (what's pending on them), and recent communications
 * across their projects. Powers the person side-panel.
 */

// Split a stored recipient list ("a@x, b@y" or "a@x; b@y") into clean addresses.
function _splitAddrs(s) {
  return s ? String(s).split(/[;,]/).map(x => x.trim()).filter(Boolean) : [];
}

// Shape a raw email / whatsapp row into the unified communication object used by
// the comms drill-downs. Carries recipients so the detail view can show who a
// message went to: email To/Cc, and the WhatsApp group's participants.
function _mapComm(m) {
  const isOut = m.direction === 'sent' || m.direction === 'outbound';
  return {
    id:          `${m.channel}-${m.id}`,
    channel:     m.channel,
    direction:   isOut ? 'outbound' : 'inbound',
    account:     m.account,
    subject:     m.subject,
    body:        m.body,
    at:          m.at,
    from:        isOut ? 'Delivery team' : (m.from_address || 'Customer'),
    to:          m.to_address || null,
    cc:          _splitAddrs(m.cc_addresses),
    groupSubject: m.group_subject || null,
    participants: m.participants || [],
    contactId:   m.contact_id || null,
    contactName: m.contact_name || null,
  };
}

async function getPersonDashboard(userId, orgId) {
  const { rows: [person] } = await pool.query(
    `SELECT id, first_name || ' ' || last_name AS name, email FROM users WHERE id = $1`,
    [userId]
  );

  const projects = await getTeamMemberProjects(userId, orgId);

  const { rows: deliverables } = await pool.query(
    `SELECT c.id, c.description, c.status, c.due_date, c.commitment_type,
            a.name AS account, h.id AS handover_id
       FROM sales_handover_commitments c
       JOIN sales_handovers h ON h.id = c.handover_id
       LEFT JOIN accounts a ON a.id = h.account_id
      WHERE c.org_id = $2 AND c.owner_user_id = $1
      ORDER BY (c.status IN ('open','in_progress')) DESC, c.due_date NULLS LAST, c.id`,
    [userId, orgId]
  );

  const { rows: emails } = await pool.query(
    `SELECT e.id, 'email' AS channel, e.direction, e.subject, e.body,
            e.from_address, e.to_address, e.cc_addresses,
            e.contact_id, ct.first_name || ' ' || ct.last_name AS contact_name,
            COALESCE(e.sent_at, e.created_at) AS at, a.name AS account
       FROM emails e
       JOIN accounts a ON a.id = (SELECT account_id FROM deals WHERE id = e.deal_id)
       LEFT JOIN contacts ct ON ct.id = e.contact_id
      WHERE e.org_id = $2 AND e.deal_id IN (SELECT deal_id FROM deal_team_members WHERE user_id = $1 AND org_id = $2)`,
    [userId, orgId]
  );
  const { rows: wa } = await pool.query(
    `SELECT m.id, 'whatsapp' AS channel, m.direction, NULL AS subject, m.body,
            m.from_name AS from_address, COALESCE(m.sent_at, m.created_at) AS at, a.name AS account,
            t.group_subject,
            t.contact_id, ct.first_name || ' ' || ct.last_name AS contact_name,
            (SELECT jsonb_agg(jsonb_build_object('name', p.display_name, 'side', p.side)
                              ORDER BY p.side, p.display_name)
               FROM whatsapp_thread_participants p WHERE p.thread_id = t.id) AS participants
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id
      WHERE t.org_id = $2 AND t.deal_id IN (SELECT deal_id FROM deal_team_members WHERE user_id = $1 AND org_id = $2)`,
    [userId, orgId]
  );
  const communications = [...emails, ...wa]
    .map(_mapComm)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 15);

  return {
    person: person || { id: userId, name: 'Unknown', email: null },
    projects,
    deliverables: deliverables.map(d => ({
      id: d.id, description: d.description, status: d.status, dueDate: d.due_date,
      commitmentType: d.commitment_type, account: d.account, handoverId: d.handover_id,
      pending: ['open', 'in_progress'].includes(d.status),
    })),
    communications,
  };
}

/**
 * All communications tied to a single CUSTOMER contact — the "click the customer"
 * drill-down. Shows the conversation from that one contact to the delivery team,
 * with recipients (email To/Cc, WhatsApp group participants) on each message.
 */
async function getContactCommunications(contactId, orgId) {
  const { rows: [contact] } = await pool.query(
    `SELECT c.id, c.first_name || ' ' || c.last_name AS name, c.email, c.title, c.phone,
            a.name AS account
       FROM contacts c
       LEFT JOIN accounts a ON a.id = c.account_id
      WHERE c.id = $1 AND c.org_id = $2`,
    [contactId, orgId]
  );
  if (!contact) throw Object.assign(new Error('Contact not found'), { status: 404 });

  const { rows: emails } = await pool.query(
    `SELECT e.id, 'email' AS channel, e.direction, e.subject, e.body,
            e.from_address, e.to_address, e.cc_addresses,
            COALESCE(e.sent_at, e.created_at) AS at, a.name AS account
       FROM emails e
       JOIN accounts a ON a.id = (SELECT account_id FROM deals WHERE id = e.deal_id)
      WHERE e.org_id = $2 AND e.contact_id = $1`,
    [contactId, orgId]
  );
  const { rows: wa } = await pool.query(
    `SELECT m.id, 'whatsapp' AS channel, m.direction, NULL AS subject, m.body,
            m.from_name AS from_address, COALESCE(m.sent_at, m.created_at) AS at, a.name AS account,
            t.group_subject,
            (SELECT jsonb_agg(jsonb_build_object('name', p.display_name, 'side', p.side)
                              ORDER BY p.side, p.display_name)
               FROM whatsapp_thread_participants p WHERE p.thread_id = t.id) AS participants
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
       JOIN accounts a ON a.id = t.account_id
      WHERE t.org_id = $2 AND t.contact_id = $1`,
    [contactId, orgId]
  );

  const communications = [...emails, ...wa]
    .map(_mapComm)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 50);

  return {
    contact: {
      id: contact.id, name: contact.name, email: contact.email,
      title: contact.title, account: contact.account,
    },
    communications,
  };
}

/** A deliverable's target + activity timeline — the deliverable drill-down. */
async function getCommitmentActivity(commitmentId, orgId) {
  const { rows: [c] } = await pool.query(
    `SELECT c.*, u.first_name || ' ' || u.last_name AS owner_name,
            cb.first_name || ' ' || cb.last_name AS closed_by_name
       FROM sales_handover_commitments c
       LEFT JOIN users u  ON u.id  = c.owner_user_id
       LEFT JOIN users cb ON cb.id = c.closed_by
      WHERE c.id = $1 AND c.org_id = $2`,
    [commitmentId, orgId]
  );
  if (!c) throw Object.assign(new Error('Commitment not found'), { status: 404 });
  const { rows: events } = await pool.query(
    `SELECT e.event_type, e.detail, e.from_status, e.to_status, e.created_at,
            u.first_name || ' ' || u.last_name AS actor
       FROM sales_handover_commitment_events e
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.commitment_id = $1 AND e.org_id = $2
      ORDER BY e.created_at`,
    [commitmentId, orgId]
  );
  return { commitment: fmtCommitment(c), events };
}

// ── Project-level actions (next steps) — tied to the project's deal ───────────
async function _projectDealId(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT deal_id FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
  if (!rows[0]) throw Object.assign(new Error('Project not found'), { status: 404 });
  return rows[0].deal_id;
}

async function listActions(handoverId, orgId) {
  const dealId = await _projectDealId(handoverId, orgId);
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.description, a.due_date, a.status, a.priority, a.user_id,
            (u.first_name || ' ' || u.last_name) AS owner_name
       FROM actions a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.org_id = $1 AND a.deal_id = $2
      ORDER BY CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END,
               a.due_date ASC NULLS LAST, a.id DESC`, [orgId, dealId]);
  return {
    actions: rows.map(r => ({
      id: r.id, title: r.title, description: r.description, dueDate: r.due_date,
      status: r.status || 'not_started', priority: r.priority,
      ownerUserId: r.user_id, ownerName: r.owner_name || 'Unassigned',
    })),
  };
}

async function createAction(handoverId, orgId, creatorId, data) {
  const dealId = await _projectDealId(handoverId, orgId);
  const title = String(data.title || '').trim();
  if (!title) throw Object.assign(new Error('Title is required'), { status: 400 });
  const ownerUserId = data.ownerUserId ? parseInt(data.ownerUserId, 10) : creatorId;
  const dueDate = data.dueDate || null;
  const { rows } = await pool.query(
    `INSERT INTO actions (org_id, user_id, deal_id, type, action_type, priority, title, due_date, status, source, source_module)
     VALUES ($1, $2, $3, 'follow_up', 'follow_up', 'medium', $4, $5, 'not_started', 'manual', 'handovers')
     RETURNING id`, [orgId, ownerUserId, dealId, title, dueDate]);
  return { id: rows[0].id };
}

async function completeAction(handoverId, orgId, actionId) {
  const dealId = await _projectDealId(handoverId, orgId);
  const { rowCount } = await pool.query(
    `UPDATE actions SET status = 'completed'
      WHERE id = $1 AND org_id = $2 AND deal_id = $3`, [actionId, orgId, dealId]);
  if (!rowCount) throw Object.assign(new Error('Action not found for this project'), { status: 404 });
  return { ok: true };
}

// ── Restricted-tab visibility (named viewers + role) ─────────────────────────
async function _dealOwnerId(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT d.owner_id FROM sales_handovers h JOIN deals d ON d.id = h.deal_id WHERE h.id = $1 AND h.org_id = $2`, [handoverId, orgId]);
  return rows[0]?.owner_id ?? null;
}
async function _isInternal(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT project_kind FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
  return rows[0]?.project_kind === 'internal';
}
async function _serviceOwnerId(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT assigned_service_owner_id FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
  return rows[0]?.assigned_service_owner_id ?? null;
}
async function canManageTabAccess(handoverId, orgId, userId) {
  if (!userId) return false;
  if (await _isOrgAdmin(orgId, userId)) return true;
  const so = await _serviceOwnerId(handoverId, orgId);
  if (so === userId) return true;
  return _isAboveServiceOwner(orgId, userId, so);
}

/**
 * True when `userId` sits above `serviceOwnerId` in the org reporting lines and
 * the org has commercial_follows_hierarchy enabled.
 *
 * Deliberately fails closed: any error resolving the hierarchy denies access
 * rather than granting it. A visibility check is the wrong place to be
 * optimistic.
 */
async function _isAboveServiceOwner(orgId, userId, serviceOwnerId) {
  if (!serviceOwnerId || serviceOwnerId === userId) return false;
  try {
    const cfg = await projectSettings.get(orgId);
    if (!cfg.commercial_follows_hierarchy) return false;
    if (cfg.rollup_basis !== 'people') return false;
    const subs = await hierarchyService.getSubordinates(orgId, userId);
    return Array.isArray(subs) && subs.includes(serviceOwnerId);
  } catch (err) {
    console.warn('[handover] hierarchy tab check failed:', err.message);
    return false;
  }
}
async function canSeeTab(handoverId, orgId, userId, tabKey) {
  if (!userId) return false;
  // An internal project has no contract and no deal owner, so the commercial
  // tab has nothing to show. Hide it rather than rendering an empty panel.
  if (tabKey === 'commercial' && await _isInternal(handoverId, orgId)) return false;
  if (await _isOrgAdmin(orgId, userId)) return true;
  const [so, dealOwner] = await Promise.all([_serviceOwnerId(handoverId, orgId), _dealOwnerId(handoverId, orgId)]);
  if (so === userId || dealOwner === userId) return true;
  // Anyone above the service owner in the reporting line, when the org has
  // opted in. Without this a manager can open their report's project but finds
  // the commercial tab silently missing, with nothing explaining why.
  if (await _isAboveServiceOwner(orgId, userId, so)) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM project_tab_viewers WHERE handover_id = $1 AND tab_key = $2 AND user_id = $3`, [handoverId, tabKey, userId]);
  return rows.length > 0;
}
async function getTabViewers(handoverId, orgId, tabKey) {
  const { rows } = await pool.query(
    `SELECT v.user_id, u.first_name || ' ' || u.last_name AS name, u.email
       FROM project_tab_viewers v JOIN users u ON u.id = v.user_id
      WHERE v.handover_id = $1 AND v.org_id = $2 AND v.tab_key = $3
      ORDER BY name`, [handoverId, orgId, tabKey]);
  return { viewers: rows.map(r => ({ userId: r.user_id, name: r.name, email: r.email })) };
}
async function setTabViewers(handoverId, orgId, userId, tabKey, userIds) {
  if (!(await canManageTabAccess(handoverId, orgId, userId)))
    throw Object.assign(new Error('Not allowed to manage tab access'), { status: 403 });
  const ids = [...new Set((userIds || []).map(x => parseInt(x, 10)).filter(Boolean))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM project_tab_viewers WHERE handover_id = $1 AND org_id = $2 AND tab_key = $3`, [handoverId, orgId, tabKey]);
    for (const uid of ids) {
      await client.query(
        `INSERT INTO project_tab_viewers (org_id, handover_id, tab_key, user_id, created_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (handover_id, tab_key, user_id) DO NOTHING`,
        [orgId, handoverId, tabKey, uid, userId]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return getTabViewers(handoverId, orgId, tabKey);
}

module.exports = {
  signOff,
  revokeSignOff,
  canSeeTab,
  getTabViewers,
  setTabViewers,
  listActions,
  createAction,
  completeAction,
  initiate,
  createProject,           // standalone / internal projects (2026_87)
  setPlaybook,             // attach + activate a playbook (2026_89)
  list,
  getTeamMemberProjects,  // person drill-down
  getPersonDashboard,     // person side-panel (individual dashboard)
  getContactCommunications, // customer-contact comms drill-down
  getCommitmentActivity,  // deliverable drill-down
  getPortfolio,           // Dashboard tab — portfolio aggregation
  getCommunications,      // Communications tab — email + WhatsApp timeline
  listAssignableUsers,    // org-scoped member list for owner pickers
  getById,
  update,
  advanceStatus,
  canSubmit,
  canClose,               // 2026_64 — closure gate
  addStakeholder,
  removeStakeholder,
  getContactPolicy,
  setContactPolicy,
  canAddContacts,
  addCommitment,
  updateCommitment,       // 2026_64 — commitment lifecycle
  removeCommitment,
  completePlay,
  addPlay,                 // ad-hoc checklist item — add
  removePlay,              // ad-hoc checklist item — remove
  updatePlay,              // checklist item — edit fields
  reorderPlays,            // checklist items — reposition within a stage (A5)
  setPlayDependencies,     // task prerequisites (2026_117)
  freezePlanOnStart,       // baseline freeze on leaving draft (2026_118)
  getEvidencePolicy,       // effective evidence policy
  getStartPreview,         // review-dates step
  listStages,              // project stages — read (2026_115)
  addStage,                // project stages — create
  updateStages,            // project stages — rename / reorder
  removeStage,             // project stages — soft delete, refuses if in use
  addPlayEvidence,         // evidence — attach a WhatsApp message (2026_111)
  listPlayEvidence,        // evidence — list, including withdrawn
  revokePlayEvidence,      // evidence — withdraw, never delete
  uploadPlayEvidenceFile,  // evidence — upload a file to Drive/OneDrive (2026_124)
  addPlayNoteAttachment,   // notes — attach a file to a note (2026_124)
  addPlayNote,             // notes — add to a task in any status (2026_120)
  listPlayNotes,           // notes — list live notes, newest first
  deletePlayNote,          // notes — soft delete by author or project manager
  canNoteOnProject,        // permission probe for the UI
  getNoteVisibility,       // note posture, for callers outside this service
  listPlayRevisions,       // date history for one play
  canRebaseline,           // permission probe for the UI
  // Nightly sweep — Phase 2
  runNightlySweep,
  buildHandoverContext,   // exported for testing / ad-hoc event triggers
  // Event trigger — Phase 7
  generateForHandoverEvent,
};
