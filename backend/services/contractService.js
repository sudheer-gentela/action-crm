// contractService.js
// Core CLM: CRUD, state machine, document versioning, amendment cloning.
// v2: department-based legal team, new statuses, major/minor versioning,
//     standalone contracts (no deal), new metadata fields, hierarchy.

const { pool, withOrgTransaction } = require('../config/database');

// ── Valid state transitions ───────────────────────────────────────────
// v2: added terminated, amended, cancelled, pending_booking
const TRANSITIONS = {
  draft:           ['in_legal_review', 'cancelled', 'void'],
  in_legal_review: ['with_sales', 'draft', 'cancelled', 'void'],
  with_sales:      ['in_legal_review', 'in_signatures', 'cancelled', 'void'],
  in_signatures:   ['pending_booking', 'signed', 'with_sales', 'cancelled', 'void'],
  signed:          ['pending_booking', 'active', 'void'],
  pending_booking: ['active', 'cancelled'],
  active:          ['expired', 'terminated', 'amended', 'void'],
  expired:         ['terminated'],
  terminated:      [],
  amended:         [],
  cancelled:       [],
  void:            [],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    const err = new Error(`Cannot transition from '${from}' to '${to}'`);
    err.status = 400; throw err;
  }
}

// ── Legal team helpers ────────────────────────────────────────────────
// v2: Uses users.department = 'legal' instead of team dimension.
// Admins and owners also have access to the legal queue.

async function getLegalTeamUserIds(orgId) {
  const r = await pool.query(
    `SELECT u.id AS user_id
     FROM org_users ou
     JOIN users u ON u.id = ou.user_id
     WHERE ou.org_id = $1
       AND u.department = 'legal'
       AND ou.is_active = TRUE`,
    [orgId]
  );
  return r.rows.map(row => row.user_id);
}

// v2: Returns full user objects for the legal team (for dropdowns etc.)
async function getLegalTeamMembers(orgId) {
  const r = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.department
     FROM org_users ou
     JOIN users u ON u.id = ou.user_id
     WHERE ou.org_id = $1
       AND u.department = 'legal'
       AND ou.is_active = TRUE
     ORDER BY u.first_name, u.last_name`,
    [orgId]
  );
  return r.rows;
}

async function isLegalTeamMember(orgId, userId) {
  // Department check — legal team members
  const r = await pool.query(
    `SELECT u.department, ou.role
     FROM org_users ou
     JOIN users u ON u.id = ou.user_id
     WHERE ou.org_id = $1 AND ou.user_id = $2`,
    [orgId, userId]
  );
  const row = r.rows[0];
  if (!row) return false;
  // Legal department members, or org admins/owners
  if (row.department === 'legal') return true;
  return row.role === 'owner' || row.role === 'admin';
}

// ── Workflow config (with defaults) ──────────────────────────────────
async function getWorkflowConfig(orgId) {
  const r = await pool.query(
    `SELECT * FROM contract_workflow_config WHERE org_id = $1`, [orgId]
  );
  return r.rows[0] || {
    return_to_sales_mode: 'manual', signature_gate: 'hard',
    nda_requires_internal_approval: false, nda_resubmit_required: true,
    msa_resubmit_required: false, sow_resubmit_required: false,
    order_form_resubmit_required: false, amendment_resubmit_required: false,
    custom_resubmit_required: false,
  };
}

function isResubmitRequired(config, contractType) {
  if (contractType === 'nda') return true;
  return config[`${contractType}_resubmit_required`] === true;
}

// ── Immutable event log ───────────────────────────────────────────────
async function logEvent(client, { contractId, orgId, eventType, actorId, payload = {} }) {
  await client.query(
    `INSERT INTO contract_events (contract_id, org_id, event_type, actor_id, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [contractId, orgId, eventType, actorId || null, JSON.stringify(payload)]
  );
}

// ── Version label computation ─────────────────────────────────────────
// v2: Returns { major, minor, label } — uses version_major/version_minor columns
async function nextVersionNumbers(client, contractId, versionType) {
  const r = await client.query(
    `SELECT version_major, version_minor
     FROM contract_document_versions
     WHERE contract_id = $1 AND is_superseded = FALSE
     ORDER BY version_major DESC, version_minor DESC
     LIMIT 1`,
    [contractId]
  );
  if (!r.rows.length) return { major: 1, minor: 0, label: '1.0' };
  const { version_major: maj, version_minor: min } = r.rows[0];
  if (versionType === 'major') {
    return { major: maj + 1, minor: 0, label: `${maj + 1}.0` };
  }
  return { major: maj, minor: min + 1, label: `${maj}.${min + 1}` };
}

// Keep legacy helper for backward compat
async function nextVersionLabel(client, contractId, versionType) {
  const v = await nextVersionNumbers(client, contractId, versionType);
  return v.label;
}

// ── Row formatter ─────────────────────────────────────────────────────
function fmt(row) {
  return {
    id:                     row.id,
    orgId:                  row.org_id,
    dealId:                 row.deal_id,
    dealName:               row.deal_name || null,
    parentContractId:       row.parent_contract_id,
    parentTitle:            row.parent_title || null,
    parentType:             row.parent_type  || null,
    parentStatus:           row.parent_status || null,
    title:                  row.title,
    contractType:           row.contract_type,
    status:                 row.status,
    legalQueue:             row.legal_queue,
    legalAssigneeId:        row.legal_assignee_id,
    legalAssigneeName:      row.la_first ? `${row.la_first} ${row.la_last}` : null,
    legalOwnerType:         row.legal_owner_type,
    internalApprovalStatus: row.internal_approval_status,
    value:                  row.value ? parseFloat(row.value) : null,
    currency:               row.currency,
    // v2 metadata fields
    customerLegalName:      row.customer_legal_name,
    companyEntity:          row.company_entity,
    includeFullDpa:         row.include_full_dpa,
    terminationForConvenience: row.termination_for_convenience,
    tfcStartDate:           row.tfc_start_date,
    tfcEndDate:             row.tfc_end_date,
    specialTerms:           row.special_terms,
    agreementEndDate:       row.agreement_end_date,
    // v2 workflow fields
    arrImpact:              row.arr_impact,
    amendmentSubtype:       row.amendment_subtype,
    customerInitiatedSigning: row.customer_initiated_signing,
    executedDocumentVersionId: row.executed_document_version_id,
    documentUrl:            row.document_url,
    documentProvider:       row.document_provider,
    effectiveDate:          row.effective_date,
    expiryDate:             row.expiry_date,
    ownerId:                row.owner_id,
    ownerName:              row.ow_first ? `${row.ow_first} ${row.ow_last}` : null,
    ownerEmail:             row.ow_email || null,
    createdBy:              row.created_by,
    createdAt:              row.created_at,
    updatedAt:              row.updated_at,
  };
}

// ════════════════════════════════════════════════════════════════════
// LIST
// ════════════════════════════════════════════════════════════════════
async function listContracts(orgId, { scope, status, contractType, dealId, search, userId, legalMode } = {}) {
  let q = `
    SELECT c.*,
      ow.first_name AS ow_first, ow.last_name AS ow_last, ow.email AS ow_email,
      la.first_name AS la_first, la.last_name  AS la_last,
      d.name AS deal_name,
      pc.title AS parent_title, pc.contract_type AS parent_type, pc.status AS parent_status
    FROM contracts c
    LEFT JOIN users ow ON ow.id = c.owner_id
    LEFT JOIN users la ON la.id = c.legal_assignee_id
    LEFT JOIN deals d  ON d.id  = c.deal_id
    LEFT JOIN contracts pc ON pc.id = c.parent_contract_id
    WHERE c.org_id = $1 AND c.deleted_at IS NULL
  `;
  const p = [orgId];

  if (legalMode === 'queue') {
    q += ` AND c.status = 'in_legal_review' AND c.legal_queue = TRUE`;
  } else if (legalMode === 'assigned') {
    q += ` AND c.status = 'in_legal_review' AND c.legal_assignee_id = $${p.length + 1}`;
    p.push(userId);
  } else if (scope !== 'org') {
    q += ` AND c.owner_id = $${p.length + 1}`;
    p.push(userId);
  }

  if (status)       { q += ` AND c.status = $${p.length+1}`;        p.push(status); }
  if (contractType) { q += ` AND c.contract_type = $${p.length+1}`; p.push(contractType); }
  if (dealId)       { q += ` AND c.deal_id = $${p.length+1}`;       p.push(parseInt(dealId,10)); }
  if (search) {
    q += ` AND (c.title ILIKE $${p.length+1} OR c.customer_legal_name ILIKE $${p.length+1})`;
    p.push(`%${search}%`);
  }

  q += ' ORDER BY c.updated_at DESC';
  const r = await pool.query(q, p);
  return r.rows.map(fmt);
}

// ════════════════════════════════════════════════════════════════════
// GET SINGLE (with all sub-entities)
// ════════════════════════════════════════════════════════════════════
async function getContract(orgId, id) {
  const [cr, vr, ar, sr, er, chr] = await Promise.all([
    pool.query(
      `SELECT c.*,
         ow.first_name AS ow_first, ow.last_name AS ow_last, ow.email AS ow_email,
         la.first_name AS la_first, la.last_name  AS la_last,
         d.name AS deal_name,
         pc.title AS parent_title, pc.contract_type AS parent_type, pc.status AS parent_status
       FROM contracts c
       LEFT JOIN users ow ON ow.id = c.owner_id
       LEFT JOIN users la ON la.id = c.legal_assignee_id
       LEFT JOIN deals d  ON d.id  = c.deal_id
       LEFT JOIN contracts pc ON pc.id = c.parent_contract_id
       WHERE c.id=$1 AND c.org_id=$2 AND c.deleted_at IS NULL`, [id, orgId]),
    pool.query(
      `SELECT cdv.*, u.first_name, u.last_name
       FROM contract_document_versions cdv
       LEFT JOIN users u ON u.id = cdv.uploaded_by
       WHERE cdv.contract_id=$1
       ORDER BY cdv.version_major DESC, cdv.version_minor DESC, cdv.created_at DESC`, [id]),
    pool.query(
      `SELECT ca.*, u.first_name, u.last_name, u.email FROM contract_approvals ca
       LEFT JOIN users u ON u.id = ca.approver_user_id
       WHERE ca.contract_id=$1 ORDER BY ca.step_order ASC`, [id]),
    pool.query(
      `SELECT * FROM contract_signatories WHERE contract_id=$1 ORDER BY created_at ASC`, [id]),
    pool.query(
      `SELECT ce.*, u.first_name, u.last_name FROM contract_events ce
       LEFT JOIN users u ON u.id = ce.actor_id
       WHERE ce.contract_id=$1 ORDER BY ce.created_at DESC`, [id]),
    pool.query(
      `SELECT id, title, contract_type, status, created_at FROM contracts
       WHERE parent_contract_id=$1 AND deleted_at IS NULL ORDER BY created_at ASC`, [id]),
  ]);
  if (!cr.rows[0]) return null;
  const contract = fmt(cr.rows[0]);
  contract.versions    = vr.rows;
  contract.approvals   = ar.rows;
  contract.signatories = sr.rows;
  contract.events      = er.rows;
  contract.children    = chr.rows;
  return contract;
}

// ════════════════════════════════════════════════════════════════════
// CREATE
// v2: deal_id now optional; all new metadata fields
// ════════════════════════════════════════════════════════════════════
async function createContract(orgId, userId, data) {
  const {
    title, contractType = 'custom',
    dealId,                      // v2: optional — NDAs and standalone amendments don't need a deal
    parentContractId,
    value, currency = 'USD',
    effectiveDate, expiryDate,
    documentUrl, documentProvider = 'other', documentComment,
    // v2 metadata fields
    customerLegalName,
    companyEntity,               // 'us' | 'uk' | 'de'
    includeFullDpa = false,
    terminationForConvenience = false,
    tfcStartDate, tfcEndDate,
    specialTerms,
    agreementEndDate,
    // v2 workflow fields
    arrImpact = false,
    amendmentSubtype,
  } = data;

  if (!title?.trim()) { const e = new Error('Title is required'); e.status = 400; throw e; }

  const validEntities = ['us', 'uk', 'de', null, undefined, ''];
  if (companyEntity && !['us','uk','de'].includes(companyEntity)) {
    const e = new Error('companyEntity must be us, uk, or de'); e.status = 400; throw e;
  }

  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `INSERT INTO contracts
         (org_id, deal_id, parent_contract_id, title, contract_type, status,
          value, currency,
          customer_legal_name, company_entity,
          include_full_dpa, termination_for_convenience,
          tfc_start_date, tfc_end_date, special_terms, agreement_end_date,
          arr_impact, amendment_subtype,
          effective_date, expiry_date,
          document_url, document_provider,
          owner_id, created_by,
          legal_owner_type)
       VALUES ($1,$2,$3,$4,$5,'draft',
               $6,$7,
               $8,$9,
               $10,$11,
               $12,$13,$14,$15,
               $16,$17,
               $18,$19,
               $20,$21,
               $22,$22,
               'sales')
       RETURNING *`,
      [
        orgId,
        dealId || null,
        parentContractId || null,
        title.trim(),
        contractType,
        value || null,
        currency,
        customerLegalName || null,
        companyEntity || null,
        !!includeFullDpa,
        !!terminationForConvenience,
        tfcStartDate || null,
        tfcEndDate || null,
        specialTerms || null,
        agreementEndDate || null,
        !!arrImpact,
        amendmentSubtype || null,
        effectiveDate || null,
        expiryDate || null,
        documentUrl || null,
        documentProvider,
        userId,
      ]
    );
    const contract = r.rows[0];
    if (documentUrl) {
      await client.query(
        `INSERT INTO contract_document_versions
           (contract_id, org_id, document_url, document_provider,
            version_label, version_type, version_major, version_minor,
            round_number, comment, upload_comment, uploaded_by, is_current, is_superseded)
         VALUES ($1,$2,$3,$4,'1.0','major',1,0,1,$5,$5,$6,TRUE,FALSE)`,
        [contract.id, orgId, documentUrl, documentProvider, documentComment || 'Initial draft', userId]
      );
    }
    await logEvent(client, { contractId: contract.id, orgId, eventType: 'draft_created', actorId: userId });
    return contract;
  });
}

// ════════════════════════════════════════════════════════════════════
// UPDATE (any editable field)
// v2: includes all new metadata fields
// ════════════════════════════════════════════════════════════════════
async function updateContract(orgId, id, userId, data) {
  const existing = await pool.query(
    `SELECT id FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [id, orgId]
  );
  if (!existing.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
  const {
    title, value, currency,
    customerLegalName, companyEntity,
    includeFullDpa, terminationForConvenience,
    tfcStartDate, tfcEndDate, specialTerms, agreementEndDate,
    arrImpact, amendmentSubtype,
    effectiveDate, expiryDate, dealId, parentContractId,
  } = data;
  const r = await pool.query(
    `UPDATE contracts SET
       title                      = COALESCE($3,  title),
       value                      = COALESCE($4,  value),
       currency                   = COALESCE($5,  currency),
       customer_legal_name        = COALESCE($6,  customer_legal_name),
       company_entity             = COALESCE($7,  company_entity),
       arr_impact                 = COALESCE($8,  arr_impact),
       effective_date             = COALESCE($9,  effective_date),
       expiry_date                = COALESCE($10, expiry_date),
       deal_id                    = COALESCE($11, deal_id),
       parent_contract_id         = COALESCE($12, parent_contract_id),
       include_full_dpa           = COALESCE($13, include_full_dpa),
       termination_for_convenience = COALESCE($14, termination_for_convenience),
       tfc_start_date             = COALESCE($15, tfc_start_date),
       tfc_end_date               = COALESCE($16, tfc_end_date),
       special_terms              = COALESCE($17, special_terms),
       agreement_end_date         = COALESCE($18, agreement_end_date),
       amendment_subtype          = COALESCE($19, amendment_subtype),
       updated_at                 = NOW()
     WHERE id=$1 AND org_id=$2 RETURNING *`,
    [
      id, orgId,
      title || null, value || null, currency || null,
      customerLegalName || null, companyEntity || null,
      arrImpact ?? null, effectiveDate || null, expiryDate || null,
      dealId || null, parentContractId || null,
      includeFullDpa ?? null, terminationForConvenience ?? null,
      tfcStartDate || null, tfcEndDate || null, specialTerms || null,
      agreementEndDate || null, amendmentSubtype || null,
    ]
  );
  return r.rows[0];
}

// ════════════════════════════════════════════════════════════════════
// DELETE (soft, draft only)
// ════════════════════════════════════════════════════════════════════
async function deleteContract(orgId, id) {
  const r = await pool.query(
    `SELECT status FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [id, orgId]
  );
  if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
  if (r.rows[0].status !== 'draft') {
    const e = new Error('Only draft contracts can be deleted'); e.status = 400; throw e;
  }
  await pool.query(`UPDATE contracts SET deleted_at=NOW() WHERE id=$1 AND org_id=$2`, [id, orgId]);
}

// ════════════════════════════════════════════════════════════════════
// UPLOAD DOCUMENT VERSION
// v2: major/minor version numbers, upload_comment, is_executed flag,
//     supersedes previous versions on major upload
// ════════════════════════════════════════════════════════════════════
async function uploadDocumentVersion(orgId, contractId, userId, data) {
  const {
    documentUrl, documentProvider = 'other',
    versionType,          // 'major' | 'minor'
    comment, uploadComment,
    isExecuted = false,
  } = data;
  if (!documentUrl) { const e = new Error('documentUrl required'); e.status = 400; throw e; }
  if (!['major','minor'].includes(versionType)) {
    const e = new Error('versionType must be major or minor'); e.status = 400; throw e;
  }

  return withOrgTransaction(orgId, async (client) => {
    const cr = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!cr.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }

    const { major, minor, label } = await nextVersionNumbers(client, contractId, versionType);

    const roundRes = await client.query(
      `SELECT COALESCE(MAX(round_number),1) AS r FROM contract_document_versions WHERE contract_id=$1`,
      [contractId]
    );
    const lastRound = parseInt(roundRes.rows[0].r, 10) || 1;
    const roundNumber = (versionType === 'major' && cr.rows[0].status === 'with_sales')
      ? lastRound + 1 : lastRound;

    // Mark all existing non-superseded versions as superseded when uploading a new major
    if (versionType === 'major') {
      await client.query(
        `UPDATE contract_document_versions
         SET is_superseded = TRUE, is_current = FALSE
         WHERE contract_id = $1 AND is_superseded = FALSE`,
        [contractId]
      );
    } else {
      await client.query(
        `UPDATE contract_document_versions SET is_current=FALSE WHERE contract_id=$1`, [contractId]
      );
    }

    const effectiveComment = comment || uploadComment || null;
    const vr = await client.query(
      `INSERT INTO contract_document_versions
         (contract_id, org_id, document_url, document_provider,
          version_label, version_type, version_major, version_minor,
          round_number, comment, upload_comment,
          uploaded_by, is_current, is_superseded, is_executed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,TRUE,FALSE,$12) RETURNING *`,
      [
        contractId, orgId, documentUrl, documentProvider,
        label, versionType, major, minor,
        roundNumber, effectiveComment,
        userId, !!isExecuted,
      ]
    );

    await client.query(
      `UPDATE contracts SET document_url=$3, document_provider=$4, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, documentUrl, documentProvider]
    );

    await logEvent(client, {
      contractId, orgId, eventType: 'document_version_uploaded', actorId: userId,
      payload: { versionLabel: label, versionType, roundNumber, comment: effectiveComment },
    });
    return vr.rows[0];
  });
}

// ════════════════════════════════════════════════════════════════════
// STATE TRANSITIONS
// ════════════════════════════════════════════════════════════════════

// v2: assigneeUserId still supported; also sets legal_owner_type
async function submitForLegalReview(orgId, contractId, userId, { assigneeUserId, assigneeId } = {}) {
  const effectiveAssignee = assigneeUserId || assigneeId || null;
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    assertTransition(r.rows[0].status, 'in_legal_review');

    // Validate assignee is actually legal if provided
    if (effectiveAssignee) {
      const isLegal = await isLegalTeamMember(orgId, parseInt(effectiveAssignee, 10));
      if (!isLegal) {
        const e = new Error('Assignee must be a legal team member'); e.status = 400; throw e;
      }
    }

    const legalQueue  = !effectiveAssignee;
    const assignee    = effectiveAssignee ? parseInt(effectiveAssignee, 10) : null;
    const ownerType   = legalQueue ? 'legal_queue' : 'legal_person';

    await client.query(
      `UPDATE contracts
       SET status='in_legal_review', legal_queue=$3, legal_assignee_id=$4,
           legal_owner_type=$5, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, legalQueue, assignee, ownerType]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'submitted_for_legal_review', actorId: userId,
      payload: { legalQueue, assigneeUserId: assignee },
    });
    return { legalQueue, assigneeUserId: assignee };
  });
}

async function pickUpFromQueue(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (r.rows[0].status !== 'in_legal_review') {
      const e = new Error('Not in legal review'); e.status = 400; throw e;
    }
    if (!r.rows[0].legal_queue) {
      const e = new Error('Already assigned'); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts
       SET legal_queue=FALSE, legal_assignee_id=$3, legal_owner_type='legal_person', updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, userId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'legal_picked_up', actorId: userId });
    return { legalAssigneeId: userId };
  });
}

async function reassignLegal(orgId, contractId, userId, newAssigneeId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (r.rows[0].status !== 'in_legal_review') {
      const e = new Error('Not in legal review'); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts
       SET legal_queue=FALSE, legal_assignee_id=$3, legal_owner_type='legal_person', updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, newAssigneeId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'legal_reassigned', actorId: userId,
      payload: { newAssigneeId },
    });
  });
}

async function returnToSales(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    assertTransition(r.rows[0].status, 'with_sales');
    await client.query(
      `UPDATE contracts
       SET status='with_sales', legal_owner_type='sales', updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'returned_to_sales', actorId: userId });
    return { ownerId: r.rows[0].owner_id, title: r.rows[0].title };
  });
}

async function resubmitToLegal(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    assertTransition(r.rows[0].status, 'in_legal_review');
    const priorAssignee = r.rows[0].legal_assignee_id;
    const legalQueue    = !priorAssignee;
    const ownerType     = legalQueue ? 'legal_queue' : 'legal_person';
    await client.query(
      `UPDATE contracts
       SET status='in_legal_review', legal_queue=$3, legal_owner_type=$4, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, legalQueue, ownerType]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'resubmitted_to_legal', actorId: userId,
      payload: { legalQueue, priorAssigneeId: priorAssignee },
    });
    return { legalQueue, priorAssigneeId: priorAssignee };
  });
}

async function sendForSignature(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT c.*, cwc.signature_gate, cwc.nda_requires_internal_approval
       FROM contracts c
       LEFT JOIN contract_workflow_config cwc ON cwc.org_id = c.org_id
       WHERE c.id=$1 AND c.org_id=$2 AND c.deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const c = r.rows[0];
    assertTransition(c.status, 'in_signatures');

    const ndaLighter = (c.contract_type === 'nda' && !c.nda_requires_internal_approval);
    const gate       = c.signature_gate || 'hard';
    if (gate === 'hard' && !ndaLighter && c.internal_approval_status !== 'approved') {
      const e = new Error('Internal approvals must be completed before sending for signature');
      e.status = 400; e.code = 'APPROVAL_GATE'; throw e;
    }
    await client.query(
      `UPDATE contracts SET status='in_signatures', updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'sent_for_signature', actorId: userId });
    return { ownerId: c.owner_id, title: c.title, documentUrl: c.document_url };
  });
}

// v2: transitions to pending_booking rather than directly to signed
async function markSigned(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    // Allow from in_signatures or signed (webhook may have set it to signed already)
    if (!['in_signatures', 'signed'].includes(r.rows[0].status)) {
      assertTransition(r.rows[0].status, 'pending_booking');
    }
    await client.query(
      `UPDATE contracts SET status='pending_booking', updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'signed_by_external', actorId: userId });
    return { ownerId: r.rows[0].owner_id, title: r.rows[0].title };
  });
}

// v2: NEW — confirm deal desk booking (pending_booking → active)
async function confirmBooking(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (r.rows[0].status !== 'pending_booking') {
      const e = new Error('Contract is not pending booking'); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts SET status='active', updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'booking_confirmed', actorId: userId });
  });
}

async function activateContract(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    assertTransition(r.rows[0].status, 'active');
    await client.query(
      `UPDATE contracts SET status='active', updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'activated', actorId: userId });
  });
}

async function recallContract(orgId, contractId, userId, { reason } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const from = r.rows[0].status;
    let to;
    if (from === 'in_signatures')  to = 'with_sales';
    else if (from === 'in_legal_review') to = 'draft';
    else { const e = new Error(`Cannot recall from '${from}'`); e.status = 400; throw e; }
    await client.query(
      `UPDATE contracts SET status=$3, updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, to]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'recalled', actorId: userId,
      payload: { from, to, reason },
    });
    return { newStatus: to };
  });
}

// v2: voidContract kept for backward compat; new code should use terminateContract/cancelContract
async function voidContract(orgId, contractId, userId, { reason } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (['void','expired','terminated','cancelled','amended'].includes(r.rows[0].status)) {
      const e = new Error('Already terminal'); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts SET status='terminated', updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'terminated', actorId: userId,
      payload: { from: r.rows[0].status, reason },
    });
  });
}

// v2: NEW — explicit terminate (active contracts that have ended)
async function terminateContract(orgId, contractId, userId, { reason } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const terminatable = ['active', 'signed', 'pending_booking', 'expired', 'void'];
    if (!terminatable.includes(r.rows[0].status)) {
      const e = new Error(`Cannot terminate from status '${r.rows[0].status}'`); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts SET status='terminated', updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'terminated', actorId: userId, payload: { reason },
    });
  });
}

// v2: NEW — cancel (never-executed contracts withdrawn before completion)
async function cancelContract(orgId, contractId, userId, { reason } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const cancellable = ['draft', 'in_legal_review', 'with_sales', 'in_signatures', 'pending_booking'];
    if (!cancellable.includes(r.rows[0].status)) {
      const e = new Error(`Cannot cancel from status '${r.rows[0].status}'`); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts SET status='cancelled', updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'cancelled', actorId: userId, payload: { reason },
    });
  });
}

// v2: NEW — mark customer as initiating the signature outside ActionCRM
async function markCustomerInitiatedSigning(orgId, contractId, userId, { note } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    assertTransition(r.rows[0].status, 'in_signatures');
    await client.query(
      `UPDATE contracts
       SET status='in_signatures', customer_initiated_signing=TRUE, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'customer_initiated_signing', actorId: userId,
      payload: { note: note || null },
    });
    return r.rows[0];
  });
}

// v2: NEW — upload the final executed/signed document + move to pending_booking
async function uploadExecutedDocument(orgId, contractId, userId, data) {
  const { documentUrl, documentProvider = 'other', versionComment } = data;
  if (!documentUrl) { const e = new Error('documentUrl required'); e.status = 400; throw e; }

  return withOrgTransaction(orgId, async (client) => {
    const cr = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!cr.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }

    // Upload as a new major version, flagged as executed
    const { major, minor, label } = await nextVersionNumbers(client, contractId, 'major');

    await client.query(
      `UPDATE contract_document_versions
       SET is_superseded=TRUE, is_current=FALSE
       WHERE contract_id=$1 AND is_superseded=FALSE`,
      [contractId]
    );

    const vr = await client.query(
      `INSERT INTO contract_document_versions
         (contract_id, org_id, document_url, document_provider,
          version_label, version_type, version_major, version_minor,
          upload_comment, comment,
          uploaded_by, is_current, is_superseded, is_executed)
       VALUES ($1,$2,$3,$4,$5,'major',$6,$7,$8,$8,$9,TRUE,FALSE,TRUE) RETURNING *`,
      [
        contractId, orgId, documentUrl, documentProvider,
        label, major, minor,
        versionComment || 'Executed document uploaded',
        userId,
      ]
    );

    // Store executed version reference + move to pending_booking
    await client.query(
      `UPDATE contracts
       SET status='pending_booking',
           executed_document_version_id=$3,
           document_url=$4,
           document_provider=$5,
           updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, vr.rows[0].id, documentUrl, documentProvider]
    );

    await logEvent(client, {
      contractId, orgId, eventType: 'executed_document_uploaded', actorId: userId,
      payload: { versionId: vr.rows[0].id },
    });

    return {
      version: vr.rows[0],
      title: cr.rows[0].title,
      ownerId: cr.rows[0].owner_id,
    };
  });
}

// v2: amendContract now marks the ORIGINAL as 'amended'
async function amendContract(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const o = r.rows[0];
    if (!['active','signed','pending_booking'].includes(o.status)) {
      const e = new Error('Can only amend active, signed, or pending-booking contracts'); e.status = 400; throw e;
    }
    const nr = await client.query(
      `INSERT INTO contracts
         (org_id, deal_id, parent_contract_id, title, contract_type, status,
          value, currency, customer_legal_name, company_entity,
          include_full_dpa, termination_for_convenience,
          tfc_start_date, tfc_end_date, special_terms, agreement_end_date,
          arr_impact,
          expiry_date, owner_id, created_by, legal_owner_type)
       VALUES ($1,$2,$3,$4,'amendment','draft',
               $5,$6,$7,$8,
               $9,$10,
               $11,$12,$13,$14,
               FALSE,
               $15,$16,$16,'sales')
       RETURNING *`,
      [
        orgId, o.deal_id, contractId, `Amendment to: ${o.title}`,
        o.value, o.currency, o.customer_legal_name, o.company_entity,
        o.include_full_dpa, o.termination_for_convenience,
        o.tfc_start_date, o.tfc_end_date, o.special_terms, o.agreement_end_date,
        o.expiry_date, userId,
      ]
    );
    const amendment = nr.rows[0];

    // v2: Mark the original contract as 'amended'
    await client.query(
      `UPDATE contracts SET status='amended', updated_at=NOW() WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );

    await logEvent(client, {
      contractId: amendment.id, orgId, eventType: 'amendment_created', actorId: userId,
      payload: { parentContractId: contractId, parentTitle: o.title },
    });
    await logEvent(client, {
      contractId, orgId, eventType: 'amended', actorId: userId,
      payload: { amendmentContractId: amendment.id },
    });
    return amendment;
  });
}

// v2: NEW — full contract hierarchy (root + all descendants via recursive CTE)
async function getContractHierarchy(orgId, contractId) {
  const r = await pool.query(
    `WITH RECURSIVE family AS (
       SELECT id, parent_contract_id, 0 AS depth
       FROM contracts
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT c.id, c.parent_contract_id, f.depth - 1
       FROM contracts c
       JOIN family f ON c.id = f.parent_contract_id
       WHERE c.org_id = $2 AND c.deleted_at IS NULL
     ),
     root AS (SELECT id FROM family ORDER BY depth ASC LIMIT 1),
     tree AS (
       SELECT c.id, c.parent_contract_id, c.title, c.contract_type, c.status,
              c.created_at, c.updated_at, 0 AS level
       FROM contracts c JOIN root r ON c.id = r.id
       WHERE c.org_id = $2 AND c.deleted_at IS NULL
       UNION ALL
       SELECT c.id, c.parent_contract_id, c.title, c.contract_type, c.status,
              c.created_at, c.updated_at, t.level + 1
       FROM contracts c JOIN tree t ON c.parent_contract_id = t.id
       WHERE c.org_id = $2 AND c.deleted_at IS NULL
     )
     SELECT * FROM tree ORDER BY level, created_at`,
    [contractId, orgId]
  );
  return r.rows;
}

// ── Signatories ───────────────────────────────────────────────────────
async function addSignatory(orgId, contractId, data) {
  const { name, email, signatoryType = 'external', role = 'signer', ccRecipients } = data;
  if (!name || !email) { const e = new Error('Name and email required'); e.status = 400; throw e; }
  const r = await pool.query(
    `INSERT INTO contract_signatories
       (contract_id, org_id, name, email, signatory_type, role, cc_recipients)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [contractId, orgId, name, email, signatoryType, role,
     JSON.stringify(ccRecipients || [])]
  );
  return r.rows[0];
}

async function removeSignatory(orgId, contractId, sigId) {
  await pool.query(
    `DELETE FROM contract_signatories WHERE id=$1 AND contract_id=$2 AND org_id=$3`,
    [sigId, contractId, orgId]
  );
}

async function addNote(orgId, contractId, userId, note) {
  await pool.query(
    `INSERT INTO contract_events (contract_id, org_id, event_type, actor_id, payload)
     VALUES ($1,$2,'note_added',$3,$4)`,
    [contractId, orgId, userId, JSON.stringify({ note })]
  );
}

// ── Cron: expire active contracts ─────────────────────────────────────
async function expireContracts() {
  const r = await pool.query(
    `UPDATE contracts SET status='expired', updated_at=NOW()
     WHERE status='active' AND expiry_date < CURRENT_DATE RETURNING id, org_id`
  );
  for (const row of r.rows) {
    await pool.query(
      `INSERT INTO contract_events (contract_id, org_id, event_type, payload)
       VALUES ($1,$2,'expired','{}')`, [row.id, row.org_id]
    ).catch(() => {});
  }
  return r.rowCount;
}

module.exports = {
  // List / read
  listContracts, getContract,
  // CRUD
  createContract, updateContract, deleteContract,
  // Document versions
  uploadDocumentVersion,
  // Legal team
  getLegalTeamUserIds, getLegalTeamMembers, isLegalTeamMember,
  // Transitions — existing
  submitForLegalReview, pickUpFromQueue, reassignLegal, returnToSales,
  resubmitToLegal, sendForSignature, markSigned, activateContract,
  recallContract, voidContract, amendContract,
  // Transitions — v2 new
  confirmBooking, terminateContract, cancelContract,
  markCustomerInitiatedSigning, uploadExecutedDocument,
  // Hierarchy
  getContractHierarchy,
  // Signatories / notes
  addSignatory, removeSignatory, addNote,
  // Config / cron
  expireContracts, getWorkflowConfig, isResubmitRequired,
};
