// contractService.js
// Core CLM: CRUD, state machine, document versioning, amendment cloning.

const { pool, withOrgTransaction } = require('../config/database');

// ── Valid state transitions ───────────────────────────────────────────
const TRANSITIONS = {
  draft:           ['in_legal_review', 'void'],
  in_legal_review: ['with_sales', 'draft', 'void'],
  with_sales:      ['in_legal_review', 'in_signatures', 'void'],
  in_signatures:   ['signed', 'with_sales', 'void'],
  signed:          ['active', 'void'],
  active:          ['expired', 'void'],
  expired:         [],
  void:            [],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    const err = new Error(`Cannot transition from '${from}' to '${to}'`);
    err.status = 400; throw err;
  }
}

// ── Legal team helpers ────────────────────────────────────────────────
async function getLegalTeamUserIds(orgId) {
  const r = await pool.query(
    `SELECT DISTINCT tm.user_id FROM team_memberships tm
     JOIN teams t ON t.id = tm.team_id
     WHERE t.org_id = $1 AND t.dimension = 'legal'`,
    [orgId]
  );
  return r.rows.map(row => row.user_id);
}

async function isLegalTeamMember(orgId, userId) {
  // Check team dimension first
  const ids = await getLegalTeamUserIds(orgId);
  if (ids.includes(parseInt(userId, 10))) return true;
  // Also grant access to org owners and admins
  const r = await pool.query(
    `SELECT role FROM org_users WHERE org_id=$1 AND user_id=$2`,
    [orgId, userId]
  );
  const role = r.rows[0]?.role;
  return role === 'owner' || role === 'admin';
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
async function nextVersionLabel(client, contractId, versionType) {
  const r = await client.query(
    `SELECT version_label FROM contract_document_versions
     WHERE contract_id = $1 ORDER BY created_at ASC`, [contractId]
  );
  if (!r.rows.length) return '1.0';
  const last = r.rows[r.rows.length - 1].version_label || '1.0';
  const [maj, min] = last.split('.').map(n => parseInt(n, 10) || 0);
  return versionType === 'major' ? `${maj + 1}.0` : `${maj}.${min + 1}`;
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
    internalApprovalStatus: row.internal_approval_status,
    value:                  row.value ? parseFloat(row.value) : null,
    currency:               row.currency,
    customerLegalName:      row.customer_legal_name,
    companyEntity:          row.company_entity,
    arrImpact:              row.arr_impact,
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
      `SELECT cdv.*, u.first_name, u.last_name FROM contract_document_versions cdv
       LEFT JOIN users u ON u.id = cdv.uploaded_by
       WHERE cdv.contract_id=$1 ORDER BY cdv.created_at DESC`, [id]),
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
       WHERE parent_contract_id=$1 AND deleted_at IS NULL`, [id]),
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
// ════════════════════════════════════════════════════════════════════
async function createContract(orgId, userId, data) {
  const {
    title, contractType = 'custom', dealId, parentContractId,
    value, currency = 'USD', customerLegalName, companyEntity,
    arrImpact = false, effectiveDate, expiryDate,
    documentUrl, documentProvider = 'other', documentComment,
  } = data;
  if (!title?.trim()) { const e = new Error('Title is required'); e.status = 400; throw e; }

  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `INSERT INTO contracts
         (org_id,deal_id,parent_contract_id,title,contract_type,status,
          value,currency,customer_legal_name,company_entity,arr_impact,
          effective_date,expiry_date,document_url,document_provider,owner_id,created_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       RETURNING *`,
      [orgId, dealId||null, parentContractId||null, title.trim(), contractType,
       value||null, currency, customerLegalName||null, companyEntity||null, arrImpact,
       effectiveDate||null, expiryDate||null, documentUrl||null, documentProvider, userId]
    );
    const contract = r.rows[0];
    if (documentUrl) {
      await client.query(
        `INSERT INTO contract_document_versions
           (contract_id,org_id,document_url,document_provider,version_label,version_type,
            round_number,comment,uploaded_by,is_current)
         VALUES ($1,$2,$3,$4,'1.0','major',1,$5,$6,TRUE)`,
        [contract.id, orgId, documentUrl, documentProvider, documentComment||'Initial draft', userId]
      );
    }
    await logEvent(client, { contractId: contract.id, orgId, eventType: 'draft_created', actorId: userId });
    return contract;
  });
}

// ════════════════════════════════════════════════════════════════════
// UPDATE (any editable field)
// ════════════════════════════════════════════════════════════════════
async function updateContract(orgId, id, userId, data) {
  const existing = await pool.query(
    `SELECT id FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [id, orgId]
  );
  if (!existing.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
  const {
    title, value, currency, customerLegalName, companyEntity,
    arrImpact, effectiveDate, expiryDate, dealId, parentContractId,
  } = data;
  const r = await pool.query(
    `UPDATE contracts SET
       title               = COALESCE($3,  title),
       value               = COALESCE($4,  value),
       currency            = COALESCE($5,  currency),
       customer_legal_name = COALESCE($6,  customer_legal_name),
       company_entity      = COALESCE($7,  company_entity),
       arr_impact          = COALESCE($8,  arr_impact),
       effective_date      = COALESCE($9,  effective_date),
       expiry_date         = COALESCE($10, expiry_date),
       deal_id             = COALESCE($11, deal_id),
       parent_contract_id  = COALESCE($12, parent_contract_id)
     WHERE id=$1 AND org_id=$2 RETURNING *`,
    [id, orgId, title||null, value||null, currency||null, customerLegalName||null,
     companyEntity||null, arrImpact??null, effectiveDate||null, expiryDate||null,
     dealId||null, parentContractId||null]
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
// ════════════════════════════════════════════════════════════════════
async function uploadDocumentVersion(orgId, contractId, userId, data) {
  const { documentUrl, documentProvider = 'other', versionType, comment } = data;
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
    const contract = cr.rows[0];

    const label = await nextVersionLabel(client, contractId, versionType);

    const roundRes = await client.query(
      `SELECT COALESCE(MAX(round_number),1) AS r FROM contract_document_versions WHERE contract_id=$1`,
      [contractId]
    );
    const lastRound = parseInt(roundRes.rows[0].r, 10) || 1;
    const roundNumber = (versionType === 'major' && contract.status === 'with_sales')
      ? lastRound + 1 : lastRound;

    await client.query(
      `UPDATE contract_document_versions SET is_current=FALSE WHERE contract_id=$1`, [contractId]
    );
    const vr = await client.query(
      `INSERT INTO contract_document_versions
         (contract_id,org_id,document_url,document_provider,version_label,version_type,
          round_number,comment,uploaded_by,is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE) RETURNING *`,
      [contractId, orgId, documentUrl, documentProvider, label, versionType,
       roundNumber, comment||null, userId]
    );
    await client.query(
      `UPDATE contracts SET document_url=$3, document_provider=$4 WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, documentUrl, documentProvider]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'document_version_uploaded', actorId: userId,
      payload: { versionLabel: label, versionType, roundNumber, comment },
    });
    return vr.rows[0];
  });
}

// ════════════════════════════════════════════════════════════════════
// STATE TRANSITIONS
// ════════════════════════════════════════════════════════════════════

async function submitForLegalReview(orgId, contractId, userId, { assigneeUserId } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    assertTransition(r.rows[0].status, 'in_legal_review');
    const legalQueue  = !assigneeUserId;
    const assignee    = assigneeUserId ? parseInt(assigneeUserId, 10) : null;
    await client.query(
      `UPDATE contracts SET status='in_legal_review', legal_queue=$3, legal_assignee_id=$4
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, legalQueue, assignee]
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
      `UPDATE contracts SET legal_queue=FALSE, legal_assignee_id=$3 WHERE id=$1 AND org_id=$2`,
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
      `UPDATE contracts SET legal_queue=FALSE, legal_assignee_id=$3 WHERE id=$1 AND org_id=$2`,
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
      `UPDATE contracts SET status='with_sales' WHERE id=$1 AND org_id=$2`, [contractId, orgId]
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
    await client.query(
      `UPDATE contracts SET status='in_legal_review', legal_queue=$3 WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, legalQueue]
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
      `UPDATE contracts SET status='in_signatures' WHERE id=$1 AND org_id=$2`, [contractId, orgId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'sent_for_signature', actorId: userId });
    return { ownerId: c.owner_id, title: c.title };
  });
}

async function markSigned(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    assertTransition(r.rows[0].status, 'signed');
    await client.query(
      `UPDATE contracts SET status='signed' WHERE id=$1 AND org_id=$2`, [contractId, orgId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'signed_by_external', actorId: userId });
    return { ownerId: r.rows[0].owner_id, title: r.rows[0].title };
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
      `UPDATE contracts SET status='active' WHERE id=$1 AND org_id=$2`, [contractId, orgId]
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
      `UPDATE contracts SET status=$3 WHERE id=$1 AND org_id=$2`, [contractId, orgId, to]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'recalled', actorId: userId,
      payload: { from, to, reason },
    });
    return { newStatus: to };
  });
}

async function voidContract(orgId, contractId, userId, { reason } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (['void','expired'].includes(r.rows[0].status)) {
      const e = new Error('Already terminal'); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts SET status='void' WHERE id=$1 AND org_id=$2`, [contractId, orgId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'voided', actorId: userId,
      payload: { from: r.rows[0].status, reason },
    });
  });
}

async function amendContract(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const o = r.rows[0];
    if (!['active','signed'].includes(o.status)) {
      const e = new Error('Can only amend active or signed contracts'); e.status = 400; throw e;
    }
    const nr = await client.query(
      `INSERT INTO contracts
         (org_id,deal_id,parent_contract_id,title,contract_type,status,
          value,currency,customer_legal_name,company_entity,arr_impact,
          expiry_date,owner_id,created_by)
       VALUES ($1,$2,$3,$4,'amendment','draft',$5,$6,$7,$8,FALSE,$9,$10,$10)
       RETURNING *`,
      [orgId, o.deal_id, contractId, `Amendment to: ${o.title}`,
       o.value, o.currency, o.customer_legal_name, o.company_entity,
       o.expiry_date, userId]
    );
    const amendment = nr.rows[0];
    await logEvent(client, {
      contractId: amendment.id, orgId, eventType: 'amendment_created', actorId: userId,
      payload: { parentContractId: contractId, parentTitle: o.title },
    });
    await logEvent(client, {
      contractId, orgId, eventType: 'amendment_spawned', actorId: userId,
      payload: { amendmentContractId: amendment.id },
    });
    return amendment;
  });
}

// ── Signatories ───────────────────────────────────────────────────────
async function addSignatory(orgId, contractId, data) {
  const { name, email, signatoryType = 'external', role = 'signer' } = data;
  if (!name || !email) { const e = new Error('Name and email required'); e.status = 400; throw e; }
  const r = await pool.query(
    `INSERT INTO contract_signatories (contract_id,org_id,name,email,signatory_type,role)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [contractId, orgId, name, email, signatoryType, role]
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
    `INSERT INTO contract_events (contract_id,org_id,event_type,actor_id,payload)
     VALUES ($1,$2,'note_added',$3,$4)`,
    [contractId, orgId, userId, JSON.stringify({ note })]
  );
}

// ── Cron: expire active contracts ─────────────────────────────────────
async function expireContracts() {
  const r = await pool.query(
    `UPDATE contracts SET status='expired'
     WHERE status='active' AND expiry_date < CURRENT_DATE RETURNING id, org_id`
  );
  for (const row of r.rows) {
    await pool.query(
      `INSERT INTO contract_events (contract_id,org_id,event_type,payload)
       VALUES ($1,$2,'expired','{}')`, [row.id, row.org_id]
    ).catch(() => {});
  }
  return r.rowCount;
}

module.exports = {
  listContracts, getContract, createContract, updateContract, deleteContract,
  uploadDocumentVersion,
  submitForLegalReview, pickUpFromQueue, reassignLegal, returnToSales,
  resubmitToLegal, sendForSignature, markSigned, activateContract,
  recallContract, voidContract, amendContract,
  addSignatory, removeSignatory, addNote,
  expireContracts, getLegalTeamUserIds, isLegalTeamMember,
  getWorkflowConfig, isResubmitRequired,
};
