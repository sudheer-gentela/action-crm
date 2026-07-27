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
const { getDiagnosticRulesConfig }  = require('../routes/orgAdmin.routes');
const PlayCompletionService        = require('./PlayCompletionService');  // Phase 6

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

// Who can trigger each target status
const TRANSITION_ROLES = {
  submitted:    'sales',      // created_by / owner
  draft:        'sales',      // recall to draft from submitted
  acknowledged: 'service',   // assigned_service_owner
  in_progress:  'service',
  completed:    'service',   // service owner signs off delivery
  cancelled:    'either',    // either side can abandon (deal unwound, etc.)
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
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
    accountTeamId:     row.account_team_id,
    name:              row.name,
    handoverRole:      row.handover_role,
    relationshipNotes: row.relationship_notes,
    isPrimaryContact:  row.is_primary_contact,
    createdAt:         row.created_at,
    // joined contact fields
    contactEmail:      row.contact_email  ?? null,
    contactTitle:      row.contact_title  ?? null,
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
  // _getPlays() nor mapped here, so deal_play_instances.due_date — which the
  // playbook engine has been populating all along — was invisible to the
  // handover UI. Every deliverable looked undated.
  const isDone    = ['completed', 'skipped'].includes(row.play_status);
  const isOverdue = !isDone
    && row.due_date != null
    && new Date(row.due_date) < new Date(new Date().toDateString());

  return {
    id:              row.id,             // sales_handover_plays.id
    playInstanceId:  row.play_instance_id,
    handoverId:      row.handover_id,
    completedAt:     row.completed_at,
    // from deal_play_instances
    title:           row.title,
    description:     row.description,
    channel:         row.channel,
    stageKey:        row.stage_key ?? null,
    completionNote:  row.completion_note ?? null,
    completionEvidence: row.completion_evidence ?? null,
    isGate:          row.is_gate,
    executionType:   row.execution_type,
    sortOrder:       row.sort_order,
    priority:        row.priority,
    status:          row.play_status,
    completedBy:     row.completed_by,
    // ── deliverable tracking (2026_64) ──
    dueDate:         row.due_date   ?? null,
    dueAnchor:       row.due_anchor ?? 'created',
    isOverdue,
    daysOverdue:     isOverdue
      ? Math.floor((Date.now() - new Date(row.due_date)) / 86400000)
      : 0,
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
        `INSERT INTO sales_handover_stakeholders
           (handover_id, org_id, contact_id, name, handover_role)
         VALUES ($1, $2, $3, $4, $5)`,
        [h.id, orgId, contact.contact_id, contact.full_name, handoverRole]
      );
    }

    return h;
  });

  // Activate handover_s2i plays (outside transaction — PlaybookPlayService manages its own writes)
  if (playbookId) {
    try {
      const { instances, warnings: playWarnings } =
        await PlaybookPlayService.activateStageForPlaybook(
          dealId, 'closed_won', orgId, userId, playbookId
        );

      playWarnings.forEach(w => warnings.push(w));

      // Link play instances to handover via sales_handover_plays
      if (instances.length > 0) {
        const values = instances
          .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`)
          .join(', ');

        const params = [handover.id];
        for (const inst of instances) {
          params.push(inst.id, orgId);
        }

        await pool.query(
          `INSERT INTO sales_handover_plays (handover_id, play_instance_id, org_id)
           VALUES ${values}
           ON CONFLICT DO NOTHING`,
          params
        );
      }
    } catch (err) {
      warnings.push(`Play activation failed: ${err.message}`);
      console.error('Handover play activation error:', err);
    }
  }

  return { handover: fmt(handover), created: true, warnings };
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
async function list(orgId, userId, { scope = 'mine', status } = {}) {
  const params = [orgId];
  const conditions = ['h.org_id = $1'];

  if (scope === 'mine') {
    params.push(userId);
    conditions.push(`h.created_by = $${params.length}`);
  } else if (scope === 'assigned') {
    params.push(userId);
    conditions.push(`h.assigned_service_owner_id = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`h.status = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT
       h.*,
       d.name                                    AS deal_name,
       a.name                                    AS account_name,
       u_so.first_name || ' ' || u_so.last_name  AS service_owner_name,
       u_cb.first_name || ' ' || u_cb.last_name  AS created_by_name,
       COUNT(DISTINCT shp.id)::int               AS total_plays,
       COUNT(DISTINCT shp.id) FILTER (WHERE shp.completed_at IS NOT NULL)::int AS completed_plays,
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
     JOIN deals    d      ON d.id  = h.deal_id
     JOIN accounts a      ON a.id  = h.account_id
     LEFT JOIN users u_so ON u_so.id = h.assigned_service_owner_id
     LEFT JOIN users u_cb ON u_cb.id = h.created_by
     LEFT JOIN sales_handover_plays shp ON shp.handover_id = h.id
     LEFT JOIN sales_handover_stakeholders s  ON s.handover_id = h.id
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

async function getById(handoverId, orgId) {
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
     JOIN deals    d      ON d.id  = h.deal_id
     JOIN accounts a      ON a.id  = h.account_id
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

  // Load plays
  const plays = await _getPlays(handoverId, orgId);

  // Load the project team (deal_team_members → org_roles) so the Summary can
  // show who is on the project and the role each person plays.
  const dealTeam = await _getDealTeam(handover.dealId, orgId);

  const playbook = rows[0].playbook_name
    ? { id: handover.playbookId, name: rows[0].playbook_name, gateEnforcement: rows[0].playbook_gate_enforcement }
    : null;

  return { ...handover, stakeholders, commitments, plays, dealTeam, playbook };
}

/** Internal project team on the deal, with the org-role each member holds. */
async function _getDealTeam(dealId, orgId) {
  if (dealId == null) return [];
  const { rows } = await pool.query(
    `SELECT dtm.user_id,
            u.first_name || ' ' || u.last_name AS name,
            u.email,
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
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE core fields (draft only)
// ═══════════════════════════════════════════════════════════════════════════

async function update(handoverId, orgId, data) {
  const existing = await _getHandover(handoverId, orgId);

  if (existing.status !== 'draft') {
    throw Object.assign(new Error('Only draft handovers can be edited'), { status: 400 });
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

  assertTransition(existing.status, toStatus);

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

  // Permission check
  const requiredRole = TRANSITION_ROLES[toStatus];
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

  // On terminal transition, resolve any outstanding handover diagnostics so a
  // completed handover stops generating alerts in the rep's action queue.
  if (TERMINAL_STATUSES.has(toStatus)) {
    ActionPersister.resolveStaleDiagnostics(
      { orgId, entityType: 'handover', entityId: existing.dealId, firedRules: [] }
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

  return { canClose: blockers.length === 0, blockers, rollup: r };
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE CHECK — can this handover be submitted?
// ═══════════════════════════════════════════════════════════════════════════

async function canSubmit(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT shp.id, dpi.title, dpi.is_gate, dpi.status AS play_status
     FROM sales_handover_plays shp
     JOIN deal_play_instances dpi ON dpi.id = shp.play_instance_id
     WHERE shp.handover_id = $1 AND shp.org_id = $2
       AND dpi.is_gate = TRUE
       AND dpi.status NOT IN ('completed', 'skipped')`,
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

async function addStakeholder(handoverId, orgId, data) {
  const { contactId, accountTeamId, name, handoverRole = 'other', relationshipNotes, isPrimaryContact = false } = data;

  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });

  const { rows } = await pool.query(
    `INSERT INTO sales_handover_stakeholders
       (handover_id, org_id, contact_id, account_team_id, name, handover_role, relationship_notes, is_primary_contact)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [handoverId, orgId, contactId || null, accountTeamId || null, name.trim(), handoverRole, relationshipNotes || null, isPrimaryContact]
  );

  return fmtStakeholder(rows[0]);
}

async function removeStakeholder(handoverId, orgId, stakeholderId) {
  const { rowCount } = await pool.query(
    'DELETE FROM sales_handover_stakeholders WHERE id = $1 AND handover_id = $2 AND org_id = $3',
    [stakeholderId, handoverId, orgId]
  );
  if (rowCount === 0) throw Object.assign(new Error('Stakeholder not found'), { status: 404 });
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
 * Complete a handover play instance and sync the completed_at timestamp
 * in sales_handover_plays for efficient gate checking.
 *
 * @param {number} handoverId
 * @param {number} playInstanceId  — deal_play_instances.id
 * @param {number} userId
 * @param {number} orgId
 */
async function completePlay(handoverId, playInstanceId, userId, orgId, data = {}) {
  // Verify the play belongs to this handover
  const linkResult = await pool.query(
    'SELECT id FROM sales_handover_plays WHERE handover_id = $1 AND play_instance_id = $2',
    [handoverId, playInstanceId]
  );

  if (linkResult.rows.length === 0) {
    throw Object.assign(new Error('Play does not belong to this handover'), { status: 404 });
  }

  // Delegate to PlaybookPlayService
  const { instance } = await PlaybookPlayService.completePlay(playInstanceId, userId, orgId);

  // Sync completed_at in our join table
  await pool.query(
    `UPDATE sales_handover_plays
     SET completed_at = $1
     WHERE handover_id = $2 AND play_instance_id = $3`,
    [instance.completed_at, handoverId, playInstanceId]
  );

  // Phase 6 — fire next sequential play.
  // Handover actions use deal_id as the entity FK (architectural decision #7).
  // Load the deal_id from the handover row and pass module='handover'.
  // Non-blocking: next-play failure must not disrupt the completion response.
  if (instance.play_id) {
    pool.query(
      'SELECT deal_id FROM sales_handovers WHERE id = $1',
      [handoverId]
    ).then(r => {
      const dealId = r.rows[0]?.deal_id;
      if (!dealId) return;
      return PlayCompletionService.fireNextPlay('handover', dealId, instance.play_id, orgId, userId);
    }).catch(err => console.error(
      `[handover.service] next-play hook failed for handover ${handoverId} play ${instance.play_id}:`,
      err.message
    ));
  }

  // Manual completion evidence: a note + optional reference to the comm that
  // closed it (mirrors the actions-engine completion_evidence pattern).
  if (data.completionNote != null || data.completionEvidence != null) {
    await pool.query(
      `UPDATE deal_play_instances
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
    `SELECT s.*,
            c.email AS contact_email,
            c.title AS contact_title
     FROM sales_handover_stakeholders s
     LEFT JOIN contacts c ON c.id = s.contact_id
     WHERE s.handover_id = $1 AND s.org_id = $2
     ORDER BY s.is_primary_contact DESC, s.name ASC`,
    [handoverId, orgId]
  );
  return rows.map(fmtStakeholder);
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

async function _getPlays(handoverId, orgId) {
  // org_id added to the predicate: every other _get* helper in this file is
  // org-scoped and this one was not. Callers all pre-verify the handover via
  // _getHandover(), so this is defence in depth rather than a live leak — but
  // it removes the possibility of a future caller forgetting.
  const { rows } = await pool.query(
    `SELECT
       shp.id, shp.play_instance_id, shp.handover_id, shp.completed_at,
       dpi.title, dpi.description, dpi.channel, dpi.is_gate,
       dpi.stage_key,
       dpi.execution_type, dpi.sort_order, dpi.priority,
       dpi.status AS play_status, dpi.completed_by,
       dpi.due_date, dpi.due_anchor,
       dpi.completion_note, dpi.completion_evidence
     FROM sales_handover_plays shp
     JOIN deal_play_instances dpi ON dpi.id = shp.play_instance_id
     WHERE shp.handover_id = $1
       AND ($2::int IS NULL OR shp.org_id = $2)
     ORDER BY dpi.due_date ASC NULLS LAST, dpi.sort_order ASC`,
    [handoverId, orgId ?? null]
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
      // entityType='handover', entityId=deal_id — ActionPersister routes this
      // to the deal_id FK column in the actions table.
      const firedSourceRules = [];
      for (const alert of fired) {
        const id = await ActionPersister.upsertDiagnosticAlert({
          entityType: 'handover',
          entityId:   handoverRow.deal_id,   // deal_id, not handover.id
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

      // Resolve stale diagnostics.
      // Pass deal_id as entityId — matches how ActionPersister queries the FK.
      const resolvedCount = await ActionPersister.resolveStaleDiagnostics({
        entityType: 'handover',
        entityId:   handoverRow.deal_id,
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
      entityType: 'handover',
      entityId:   handoverRow.deal_id,   // deal_id, not handover.id
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
       JOIN deals    d ON d.id = h.deal_id
       JOIN accounts a ON a.id = h.account_id
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

  const emails = await pool.query(
    `SELECT e.id, e.direction, e.subject, e.body, e.from_address, e.to_address, e.cc_addresses,
            e.contact_id, ct.first_name || ' ' || ct.last_name AS contact_name,
            e.sent_at, e.created_at
       FROM emails e
       LEFT JOIN contacts ct ON ct.id = e.contact_id
      WHERE e.org_id = $1 AND e.deal_id = $2`,
    [orgId, dealId]
  );
  const wa = await pool.query(
    `SELECT m.id, m.direction, m.body, m.from_name, m.is_automated, m.status,
            COALESCE(m.sent_at, m.created_at) AS at,
            t.group_subject, t.contact_id, ct.first_name || ' ' || ct.last_name AS contact_name,
            (SELECT jsonb_agg(jsonb_build_object('name', p.display_name, 'side', p.side)
                              ORDER BY p.side, p.display_name)
               FROM whatsapp_thread_participants p WHERE p.thread_id = t.id) AS participants
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id
      WHERE t.org_id = $1 AND t.handover_id = $2`,
    [orgId, handoverId]
  );

  const outbound = d => d === 'sent' || d === 'outbound';
  const items = [
    ...emails.rows.map(e => ({
      id: `email-${e.id}`, channel: 'email',
      direction: outbound(e.direction) ? 'outbound' : 'inbound',
      from: outbound(e.direction) ? 'Delivery team' : (e.from_address || 'Customer'),
      subject: e.subject, body: e.body,
      at: e.sent_at || e.created_at, isAutomated: false,
      to: e.to_address || null, cc: _splitAddrs(e.cc_addresses),
      groupSubject: null, participants: [],
      contactId: e.contact_id || null, contactName: e.contact_name || null,
    })),
    ...wa.rows.map(m => ({
      id: `wa-${m.id}`, channel: 'whatsapp',
      direction: outbound(m.direction) ? 'outbound' : 'inbound',
      from: outbound(m.direction) ? 'Delivery team' : (m.from_name || 'Customer'),
      subject: null, body: m.body,
      at: m.at, isAutomated: !!m.is_automated,
      to: null, cc: [],
      groupSubject: m.group_subject || null, participants: m.participants || [],
      contactId: m.contact_id || null, contactName: m.contact_name || null,
    })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  return { items };
}

/** Every project a team member is on, with their role — the person drill-down. */
async function getTeamMemberProjects(userId, orgId) {
  const { rows } = await pool.query(
    `SELECT h.id AS handover_id, a.name AS account, d.name AS deal, h.status,
            r.name AS role_name, dtm.custom_role
       FROM deal_team_members dtm
       JOIN deals d ON d.id = dtm.deal_id
       JOIN accounts a ON a.id = d.account_id
       LEFT JOIN sales_handovers h ON h.deal_id = d.id AND h.org_id = dtm.org_id
       LEFT JOIN org_roles r ON r.id = dtm.role_id
      WHERE dtm.user_id = $1 AND dtm.org_id = $2
      ORDER BY d.close_date NULLS LAST, d.id`,
    [userId, orgId]
  );
  return rows.map(r => ({
    handoverId: r.handover_id, account: r.account, deal: r.deal,
    status: r.status, role: r.role_name || r.custom_role || 'Team member',
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
       JOIN accounts a ON a.id = h.account_id
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

module.exports = {
  initiate,
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
  addCommitment,
  updateCommitment,       // 2026_64 — commitment lifecycle
  removeCommitment,
  completePlay,
  // Nightly sweep — Phase 2
  runNightlySweep,
  buildHandoverContext,   // exported for testing / ad-hoc event triggers
  // Event trigger — Phase 7
  generateForHandoverEvent,
};
