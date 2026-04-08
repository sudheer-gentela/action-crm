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
  draft:        ['submitted'],
  submitted:    ['draft', 'acknowledged'],   // draft = recall; acknowledged = service accepts
  acknowledged: ['in_progress'],
  in_progress:  [],                          // terminal for this module; Task 3 takes over
};

// Who can trigger each target status
const TRANSITION_ROLES = {
  submitted:    'sales',      // created_by / owner
  draft:        'sales',      // recall to draft from submitted
  acknowledged: 'service',   // assigned_service_owner
  in_progress:  'service',
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
  return {
    id:             row.id,
    handoverId:     row.handover_id,
    description:    row.description,
    commitmentType: row.commitment_type,
    createdBy:      row.created_by,
    createdAt:      row.created_at,
    createdByName:  row.created_by_name ?? null,
  };
}

function fmtPlay(row) {
  if (!row) return null;
  return {
    id:              row.id,             // sales_handover_plays.id
    playInstanceId:  row.play_instance_id,
    handoverId:      row.handover_id,
    completedAt:     row.completed_at,
    // from deal_play_instances
    title:           row.title,
    description:     row.description,
    channel:         row.channel,
    isGate:          row.is_gate,
    executionType:   row.execution_type,
    sortOrder:       row.sort_order,
    priority:        row.priority,
    status:          row.play_status,
    completedBy:     row.completed_by,
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
       COUNT(DISTINCT s.id)::int                 AS stakeholder_count
     FROM sales_handovers h
     JOIN deals    d      ON d.id  = h.deal_id
     JOIN accounts a      ON a.id  = h.account_id
     LEFT JOIN users u_so ON u_so.id = h.assigned_service_owner_id
     LEFT JOIN users u_cb ON u_cb.id = h.created_by
     LEFT JOIN sales_handover_plays shp ON shp.handover_id = h.id
     LEFT JOIN sales_handover_stakeholders s  ON s.handover_id = h.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY h.id, d.name, a.name, u_so.first_name, u_so.last_name, u_cb.first_name, u_cb.last_name
     ORDER BY h.created_at DESC`,
    params
  );

  return rows.map(r => ({
    ...fmt(r),
    totalPlays:      r.total_plays,
    completedPlays:  r.completed_plays,
    stakeholderCount: r.stakeholder_count,
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
       u_cb.first_name || ' ' || u_cb.last_name  AS created_by_name
     FROM sales_handovers h
     JOIN deals    d      ON d.id  = h.deal_id
     JOIN accounts a      ON a.id  = h.account_id
     LEFT JOIN users u_so ON u_so.id = h.assigned_service_owner_id
     LEFT JOIN users u_cb ON u_cb.id = h.created_by
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
  const plays = await _getPlays(handoverId);

  return { ...handover, stakeholders, commitments, plays };
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
 */
async function advanceStatus(handoverId, orgId, userId, toStatus) {
  const existing = await _getHandover(handoverId, orgId);

  assertTransition(existing.status, toStatus);

  // Gate check: cannot submit unless all is_gate plays are complete
  if (toStatus === 'submitted') {
    const { canSubmit, incompleteGates } = await canSubmit(handoverId, orgId);
    if (!canSubmit) {
      const titles = incompleteGates.map(g => `"${g.title}"`).join(', ');
      throw Object.assign(
        new Error(`Cannot submit: incomplete required sections: ${titles}`),
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

  const timestampField = {
    submitted:    'submitted_at',
    acknowledged: 'acknowledged_at',
  }[toStatus];

  const { rows } = await pool.query(
    `UPDATE sales_handovers
     SET status     = $1,
         ${timestampField ? `${timestampField} = NOW(),` : ''}
         updated_at = NOW()
     WHERE id = $2 AND org_id = $3
     RETURNING *`,
    [toStatus, handoverId, orgId]
  );

  return fmt(rows[0]);
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

async function addCommitment(handoverId, orgId, userId, data) {
  const { description, commitmentType = 'promise' } = data;

  if (!description) throw Object.assign(new Error('description is required'), { status: 400 });

  const { rows } = await pool.query(
    `INSERT INTO sales_handover_commitments
       (handover_id, org_id, description, commitment_type, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [handoverId, orgId, description.trim(), commitmentType, userId]
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

async function removeCommitment(handoverId, orgId, commitmentId) {
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
async function completePlay(handoverId, playInstanceId, userId, orgId) {
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
            u.first_name || ' ' || u.last_name AS created_by_name
     FROM sales_handover_commitments c
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.handover_id = $1 AND c.org_id = $2
     ORDER BY c.commitment_type ASC, c.created_at ASC`,
    [handoverId, orgId]
  );
  return rows.map(fmtCommitment);
}

async function _getPlays(handoverId) {
  const { rows } = await pool.query(
    `SELECT
       shp.id, shp.play_instance_id, shp.handover_id, shp.completed_at,
       dpi.title, dpi.description, dpi.channel, dpi.is_gate,
       dpi.execution_type, dpi.sort_order, dpi.priority,
       dpi.status AS play_status, dpi.completed_by
     FROM sales_handover_plays shp
     JOIN deal_play_instances dpi ON dpi.id = shp.play_instance_id
     WHERE shp.handover_id = $1
     ORDER BY dpi.sort_order ASC`,
    [handoverId]
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
         AND h.status != 'draft'
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
         AND h.status != 'draft'`,
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

module.exports = {
  initiate,
  list,
  getById,
  update,
  advanceStatus,
  canSubmit,
  addStakeholder,
  removeStakeholder,
  addCommitment,
  removeCommitment,
  completePlay,
  // Nightly sweep — Phase 2
  runNightlySweep,
  buildHandoverContext,   // exported for testing / ad-hoc event triggers
  // Event trigger — Phase 7
  generateForHandoverEvent,
};
