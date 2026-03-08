// contractService.js
// Core CLM: CRUD, state machine, document versioning, amendment cloning.
// v2: in_review + review_sub_status replaces in_legal_review + with_sales.
//     review_sub_status: 'with_legal' | 'with_sales' | 'with_customer'
//     with_customer supports back-and-forth redline loops between Legal ↔ Customer.

const { pool, withOrgTransaction } = require('../config/database');

// ── Valid state transitions ─────────────────────────────────────────
// in_review covers what was previously in_legal_review + with_sales.
// Sub-status transitions are handled separately by handoffReview().
const TRANSITIONS = {
  draft:           ['in_review', 'cancelled', 'void'],
  in_review:       ['in_signatures', 'draft', 'cancelled', 'void'],
  in_signatures:   ['pending_booking', 'signed', 'in_review', 'cancelled', 'void'],
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

// ── Legal team helpers ──────────────────────────────────────────────
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
  const r = await pool.query(
    `SELECT u.department, ou.role
     FROM org_users ou
     JOIN users u ON u.id = ou.user_id
     WHERE ou.org_id = $1 AND ou.user_id = $2`,
    [orgId, userId]
  );
  const row = r.rows[0];
  if (!row) return false;
  if (row.department === 'legal') return true;
  return row.role === 'owner' || row.role === 'admin';
}

// ── Workflow config ─────────────────────────────────────────────────
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

// ── Immutable event log ─────────────────────────────────────────────
async function logEvent(client, { contractId, orgId, eventType, actorId, payload = {} }) {
  await client.query(
    `INSERT INTO contract_events (contract_id, org_id, event_type, actor_id, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [contractId, orgId, eventType, actorId || null, JSON.stringify(payload)]
  );
}

// ── Version number helpers ──────────────────────────────────────────
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

// ── Row formatter ───────────────────────────────────────────────────
function fmt(row) {
  return {
    id:                       row.id,
    orgId:                    row.org_id,
    dealId:                   row.deal_id,
    dealName:                 row.deal_name || null,
    parentContractId:         row.parent_contract_id,
    parentTitle:              row.parent_title || null,
    parentType:               row.parent_type  || null,
    parentStatus:             row.parent_status || null,
    title:                    row.title,
    contractType:             row.contract_type,
    status:                   row.status,
    reviewSubStatus:          row.review_sub_status,    // NEW: 'with_legal' | 'with_sales' | 'with_customer'
    legalQueue:               row.legal_queue,
    legalAssigneeId:          row.legal_assignee_id,
    legalAssigneeName:        row.la_first ? `${row.la_first} ${row.la_last}` : null,
    legalOwnerType:           row.legal_owner_type,
    internalApprovalStatus:   row.internal_approval_status,
    value:                    row.value ? parseFloat(row.value) : null,
    currency:                 row.currency,
    customerLegalName:        row.customer_legal_name,
    companyEntity:            row.company_entity,
    includeFullDpa:           row.include_full_dpa,
    terminationForConvenience: row.termination_for_convenience,
    tfcStartDate:             row.tfc_start_date,
    tfcEndDate:               row.tfc_end_date,
    specialTerms:             row.special_terms,
    agreementEndDate:         row.agreement_end_date,
    arrImpact:                row.arr_impact,
    amendmentSubtype:         row.amendment_subtype,
    customerInitiatedSigning: row.customer_initiated_signing,
    executedDocumentVersionId: row.executed_document_version_id,
    documentUrl:              row.document_url,
    documentProvider:         row.document_provider,
    effectiveDate:            row.effective_date,
    expiryDate:               row.expiry_date,
    ownerId:                  row.owner_id,
    ownerName:                row.ow_first ? `${row.ow_first} ${row.ow_last}` : null,
    ownerEmail:               row.ow_email || null,
    createdBy:                row.created_by,
    createdAt:                row.created_at,
    updatedAt:                row.updated_at,
  };
}

// ═══════════════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════════════
async function listContracts(orgId, { scope, status, reviewSubStatus, contractType, dealId, search, userId, legalMode } = {}) {
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
    // Legal queue: in_review/with_legal, not yet assigned
    q += ` AND c.status = 'in_review' AND c.review_sub_status = 'with_legal' AND c.legal_queue = TRUE`;
  } else if (legalMode === 'assigned') {
    // Legal assigned: in_review/with_legal, assigned to this user
    q += ` AND c.status = 'in_review' AND c.review_sub_status = 'with_legal' AND c.legal_assignee_id = $${p.length + 1}`;
    p.push(userId);
  } else if (scope !== 'org') {
    q += ` AND c.owner_id = $${p.length + 1}`;
    p.push(userId);
  }

  if (status)          { q += ` AND c.status = $${p.length+1}`;             p.push(status); }
  if (reviewSubStatus) { q += ` AND c.review_sub_status = $${p.length+1}`;  p.push(reviewSubStatus); }
  if (contractType)    { q += ` AND c.contract_type = $${p.length+1}`;      p.push(contractType); }
  if (dealId)          { q += ` AND c.deal_id = $${p.length+1}`;            p.push(parseInt(dealId, 10)); }
  if (search) {
    q += ` AND (c.title ILIKE $${p.length+1} OR c.customer_legal_name ILIKE $${p.length+1})`;
    p.push(`%${search}%`);
  }

  q += ' ORDER BY c.updated_at DESC';
  const r = await pool.query(q, p);
  return r.rows.map(fmt);
}

// ═══════════════════════════════════════════════════════════════════
// GET SINGLE (with all sub-entities)
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════
async function createContract(orgId, userId, data) {
  const {
    title, contractType = 'custom',
    dealId,
    parentContractId,
    value, currency = 'USD',
    effectiveDate, expiryDate,
    documentUrl, documentProvider = 'other', documentComment,
    customerLegalName,
    companyEntity,
    includeFullDpa = false,
    terminationForConvenience = false,
    tfcStartDate, tfcEndDate,
    specialTerms,
    agreementEndDate,
    arrImpact = false,
    amendmentSubtype,
  } = data;

  if (!title?.trim()) { const e = new Error('Title is required'); e.status = 400; throw e; }

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
          legal_owner_type, review_sub_status)
       VALUES ($1,$2,$3,$4,$5,'draft',
               $6,$7,
               $8,$9,
               $10,$11,
               $12,$13,$14,$15,
               $16,$17,
               $18,$19,
               $20,$21,
               $22,$22,
               'sales', NULL)
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

// ═══════════════════════════════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════════════════════════════
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
       title                       = COALESCE($3,  title),
       value                       = COALESCE($4,  value),
       currency                    = COALESCE($5,  currency),
       customer_legal_name         = COALESCE($6,  customer_legal_name),
       company_entity              = COALESCE($7,  company_entity),
       arr_impact                  = COALESCE($8,  arr_impact),
       effective_date              = COALESCE($9,  effective_date),
       expiry_date                 = COALESCE($10, expiry_date),
       deal_id                     = COALESCE($11, deal_id),
       parent_contract_id          = COALESCE($12, parent_contract_id),
       include_full_dpa            = COALESCE($13, include_full_dpa),
       termination_for_convenience = COALESCE($14, termination_for_convenience),
       tfc_start_date              = COALESCE($15, tfc_start_date),
       tfc_end_date                = COALESCE($16, tfc_end_date),
       special_terms               = COALESCE($17, special_terms),
       agreement_end_date          = COALESCE($18, agreement_end_date),
       amendment_subtype           = COALESCE($19, amendment_subtype),
       updated_at                  = NOW()
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

// ═══════════════════════════════════════════════════════════════════
// DELETE (soft, draft only)
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// UPLOAD DOCUMENT VERSION
// ═══════════════════════════════════════════════════════════════════
async function uploadDocumentVersion(orgId, contractId, userId, data) {
  const {
    documentUrl, documentProvider = 'other',
    versionType,
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
    // New round when Sales uploads a new major version after getting it back
    const roundNumber = (versionType === 'major' && cr.rows[0].review_sub_status === 'with_sales')
      ? lastRound + 1 : lastRound;

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

// ═══════════════════════════════════════════════════════════════════
// STATE TRANSITIONS — REVIEW CYCLE
// ═══════════════════════════════════════════════════════════════════

// submitForLegalReview: draft → in_review/with_legal
// Also used for resubmit-after-with_sales (with_sales → with_legal within in_review).
async function submitForLegalReview(orgId, contractId, userId, { assigneeUserId, assigneeId } = {}) {
  const effectiveAssignee = assigneeUserId || assigneeId || null;
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }

    const current = r.rows[0];
    const isFirstSubmit = current.status === 'draft';
    const isResubmit    = current.status === 'in_review' && current.review_sub_status === 'with_sales';

    if (!isFirstSubmit && !isResubmit) {
      const e = new Error(`Cannot submit for legal review from status '${current.status}' / sub-status '${current.review_sub_status}'`);
      e.status = 400; throw e;
    }

    if (effectiveAssignee) {
      const isLegal = await isLegalTeamMember(orgId, parseInt(effectiveAssignee, 10));
      if (!isLegal) {
        const e = new Error('Assignee must be a legal team member'); e.status = 400; throw e;
      }
    }

    const legalQueue = !effectiveAssignee;
    const assignee   = effectiveAssignee ? parseInt(effectiveAssignee, 10) : null;
    const ownerType  = legalQueue ? 'legal_queue' : 'legal_person';

    await client.query(
      `UPDATE contracts
       SET status='in_review', review_sub_status='with_legal',
           legal_queue=$3, legal_assignee_id=$4,
           legal_owner_type=$5, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, legalQueue, assignee, ownerType]
    );

    const eventType = isFirstSubmit ? 'submitted_for_legal_review' : 'resubmitted_to_legal';
    await logEvent(client, {
      contractId, orgId, eventType, actorId: userId,
      payload: { legalQueue, assigneeUserId: assignee, fromSubStatus: current.review_sub_status },
    });
    return { legalQueue, assigneeUserId: assignee };
  });
}

// Alias for explicit resubmit calls from with_sales or with_customer → with_legal
async function resubmitToLegal(orgId, contractId, userId) {
  return submitForLegalReview(orgId, contractId, userId, {});
}

// pickUpFromQueue: legal queue → legal person (in_review/with_legal stays)
async function pickUpFromQueue(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (r.rows[0].status !== 'in_review' || r.rows[0].review_sub_status !== 'with_legal') {
      const e = new Error('Contract is not in review with legal'); e.status = 400; throw e;
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

// reassignLegal: move to a different legal team member (stays with_legal)
async function reassignLegal(orgId, contractId, userId, newAssigneeId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (r.rows[0].status !== 'in_review') {
      const e = new Error('Contract is not in review'); e.status = 400; throw e;
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

// ═══════════════════════════════════════════════════════════════════
// handoffReview — unified sub-status handoff within in_review
//
// toSubStatus: 'with_legal' | 'with_sales' | 'with_customer'
//
// Allowed transitions (any direction is valid — redlines loop):
//   with_legal    → with_sales      (legal returns to sales for changes)
//   with_legal    → with_customer   (legal/sales sends draft to customer)
//   with_sales    → with_legal      (sales resubmits to legal)
//   with_sales    → with_customer   (sales sends draft directly to customer)
//   with_customer → with_legal      (customer returns redlines to legal)
//   with_customer → with_sales      (customer returns changes to sales to co-ordinate)
// ═══════════════════════════════════════════════════════════════════
async function handoffReview(orgId, contractId, userId, toSubStatus, { note } = {}) {
  const valid = ['with_legal', 'with_sales', 'with_customer'];
  if (!valid.includes(toSubStatus)) {
    const e = new Error(`toSubStatus must be one of: ${valid.join(', ')}`); e.status = 400; throw e;
  }

  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (r.rows[0].status !== 'in_review') {
      const e = new Error('Contract must be in_review to change sub-status'); e.status = 400; throw e;
    }

    const fromSubStatus = r.rows[0].review_sub_status;
    if (fromSubStatus === toSubStatus) {
      const e = new Error(`Contract is already ${toSubStatus}`); e.status = 400; throw e;
    }

    // Determine new legal_owner_type
    let newOwnerType;
    if (toSubStatus === 'with_legal') {
      // Keep existing assignee if present, otherwise back to queue
      const hasAssignee = !!r.rows[0].legal_assignee_id;
      newOwnerType = hasAssignee ? 'legal_person' : 'legal_queue';
    } else if (toSubStatus === 'with_sales') {
      newOwnerType = 'sales';
    } else {
      newOwnerType = 'customer';
    }

    await client.query(
      `UPDATE contracts
       SET review_sub_status=$3, legal_owner_type=$4, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, toSubStatus, newOwnerType]
    );

    // Descriptive event type for the timeline
    const EVENT_TYPES = {
      'with_legal-with_sales':      'returned_to_sales',
      'with_legal-with_customer':   'sent_to_customer_review',
      'with_sales-with_legal':      'resubmitted_to_legal',
      'with_sales-with_customer':   'sent_to_customer_review',
      'with_customer-with_legal':   'customer_returned_redlines',
      'with_customer-with_sales':   'customer_returned_to_sales',
    };
    const eventType = EVENT_TYPES[`${fromSubStatus}-${toSubStatus}`] || 'review_handoff';

    await logEvent(client, {
      contractId, orgId, eventType, actorId: userId,
      payload: { fromSubStatus, toSubStatus, note: note || null },
    });

    return {
      fromSubStatus,
      toSubStatus,
      ownerId: r.rows[0].owner_id,
      title:   r.rows[0].title,
    };
  });
}

// Convenience wrappers kept so existing route aliases still work cleanly
async function returnToSales(orgId, contractId, userId) {
  return handoffReview(orgId, contractId, userId, 'with_sales');
}

async function sendToCustomerReview(orgId, contractId, userId, { note } = {}) {
  return handoffReview(orgId, contractId, userId, 'with_customer', { note });
}

async function customerReturnedRedlines(orgId, contractId, userId, { note } = {}) {
  return handoffReview(orgId, contractId, userId, 'with_legal', { note });
}

// ═══════════════════════════════════════════════════════════════════
// sendForSignature: in_review → in_signatures
// ═══════════════════════════════════════════════════════════════════
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
      `UPDATE contracts
       SET status='in_signatures', review_sub_status=NULL, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, { contractId, orgId, eventType: 'sent_for_signature', actorId: userId });
    return { ownerId: c.owner_id, title: c.title, documentUrl: c.document_url };
  });
}

// ═══════════════════════════════════════════════════════════════════
// Remaining transitions (unchanged from v1 service)
// ═══════════════════════════════════════════════════════════════════

async function markSigned(orgId, contractId, userId) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
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
    if (from === 'in_signatures') to = 'in_review';   // back to review cycle
    else if (from === 'in_review') to = 'draft';
    else { const e = new Error(`Cannot recall from '${from}'`); e.status = 400; throw e; }

    // If recalling back to in_review, restore with_legal sub-status
    const subStatus = to === 'in_review' ? 'with_legal' : null;

    await client.query(
      `UPDATE contracts
       SET status=$3, review_sub_status=$4, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId, to, subStatus]
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
    if (['void','expired','terminated','cancelled','amended'].includes(r.rows[0].status)) {
      const e = new Error('Already terminal'); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts SET status='terminated', review_sub_status=NULL, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'terminated', actorId: userId,
      payload: { from: r.rows[0].status, reason },
    });
  });
}

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
      `UPDATE contracts SET status='terminated', review_sub_status=NULL, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'terminated', actorId: userId, payload: { reason },
    });
  });
}

async function cancelContract(orgId, contractId, userId, { reason } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const r = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!r.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const cancellable = ['draft', 'in_review', 'in_signatures', 'pending_booking'];
    if (!cancellable.includes(r.rows[0].status)) {
      const e = new Error(`Cannot cancel from status '${r.rows[0].status}'`); e.status = 400; throw e;
    }
    await client.query(
      `UPDATE contracts SET status='cancelled', review_sub_status=NULL, updated_at=NOW()
       WHERE id=$1 AND org_id=$2`,
      [contractId, orgId]
    );
    await logEvent(client, {
      contractId, orgId, eventType: 'cancelled', actorId: userId, payload: { reason },
    });
  });
}

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
       SET status='in_signatures', review_sub_status=NULL,
           customer_initiated_signing=TRUE, updated_at=NOW()
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

async function uploadExecutedDocument(orgId, contractId, userId, data) {
  const { documentUrl, documentProvider = 'other', versionComment } = data;
  if (!documentUrl) { const e = new Error('documentUrl required'); e.status = 400; throw e; }

  return withOrgTransaction(orgId, async (client) => {
    const cr = await client.query(
      `SELECT * FROM contracts WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [contractId, orgId]
    );
    if (!cr.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }

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

    await client.query(
      `UPDATE contracts
       SET status='pending_booking',
           review_sub_status=NULL,
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
      title:   cr.rows[0].title,
      ownerId: cr.rows[0].owner_id,
    };
  });
}

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
          expiry_date, owner_id, created_by, legal_owner_type, review_sub_status)
       VALUES ($1,$2,$3,$4,'amendment','draft',
               $5,$6,$7,$8,
               $9,$10,
               $11,$12,$13,$14,
               FALSE,
               $15,$16,$16,'sales',NULL)
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

async function getContractHierarchy(orgId, contractId) {
  // review_sub_status is a v2 column — omitted so this works on pre-migration DBs too.
  // Add it back after migration_clm_v2_clean.sql has been run on Railway.
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
              c.created_at, 0 AS level
       FROM contracts c JOIN root r ON c.id = r.id
       WHERE c.org_id = $2 AND c.deleted_at IS NULL
       UNION ALL
       SELECT c.id, c.parent_contract_id, c.title, c.contract_type, c.status,
              c.created_at, t.level + 1
       FROM contracts c JOIN tree t ON c.parent_contract_id = t.id
       WHERE c.org_id = $2 AND c.deleted_at IS NULL
     )
     SELECT * FROM tree ORDER BY level, created_at`,
    [contractId, orgId]
  );

  // Build nested tree object from flat rows
  const map = {};
  r.rows.forEach(row => { map[row.id] = { ...row, children: [] }; });
  let root = null;
  r.rows.forEach(row => {
    if (row.parent_contract_id && map[row.parent_contract_id]) {
      map[row.parent_contract_id].children.push(map[row.id]);
    } else {
      root = map[row.id];
    }
  });
  return root;
}

// ── Signatories ──────────────────────────────────────────────────────
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

// ── Cron ─────────────────────────────────────────────────────────────
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
  // Review cycle — primary entry points
  submitForLegalReview,
  pickUpFromQueue,
  reassignLegal,
  handoffReview,           // ← unified sub-status handoff
  // Convenience wrappers (call handoffReview internally)
  returnToSales,
  sendToCustomerReview,
  customerReturnedRedlines,
  // Alias kept for resubmit routes
  resubmitToLegal,
  // Signature + booking
  sendForSignature, markSigned, confirmBooking, activateContract,
  // Lifecycle
  recallContract, voidContract, amendContract,
  terminateContract, cancelContract,
  markCustomerInitiatedSigning, uploadExecutedDocument,
  // Hierarchy
  getContractHierarchy,
  // Signatories / notes
  addSignatory, removeSignatory, addNote,
  // Config / cron
  expireContracts, getWorkflowConfig, isResubmitRequired,
};
