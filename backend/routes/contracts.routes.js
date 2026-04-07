// contracts.routes.js
// All CLM endpoints. Middleware: authenticateToken → orgContext → requireModule('contracts')
// v2: in_review + review_sub_status replaces in_legal_review + with_sales.
//     New unified /handoff endpoint. Old endpoint names kept as aliases.

const express  = require('express');
const router   = express.Router();
const db       = require('../config/database');
const auth     = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');

const CS  = require('../services/contractService');
const AS  = require('../services/contractApprovalService');
const NS  = require('../services/contractNotificationService');
const ContractActionsGenerator = require('../services/ContractActionsGenerator');
const PlaybookActionGenerator  = require('../services/PlaybookActionGenerator');
const ActionWriter             = require('../services/ActionWriter');
const PlaybookService          = require('../services/playbook.service');

router.use(auth);
router.use(orgContext);

const gate = requireModule('contracts');

// ── Module toggle (no gate — must work when disabled) ─────────────────
router.patch('/admin/module', requireRole('admin','owner'), async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: { message: 'enabled must be boolean' } });
    // Read current allowed flag so we preserve it
    const cur = await db.query(
      `SELECT settings->>'modules'->>'contracts' AS val,
              (settings->'modules'->'contracts'->>'allowed')::boolean AS allowed
       FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const allowed = cur.rows[0]?.allowed ?? true;
    await db.query(
      `UPDATE organizations SET settings = jsonb_set(COALESCE(settings,'{}'),'{modules,contracts}',$2::jsonb,true) WHERE id=$1`,
      [req.orgId, JSON.stringify({ allowed, enabled })]
    );
    requireModule.invalidate(req.orgId, 'contracts');
    res.json({ enabled, allowed });
  } catch (err) {
    console.error(err); res.status(500).json({ error: { message: 'Failed to update module' } });
  }
});

// All routes below require module enabled
router.use(gate);

// ── Contract Templates ────────────────────────────────────────────────
// Table: contract_templates (already exists in DB)
// Columns: id, org_id, contract_type, name, description,
//          file_url, file_name, file_size, is_active, uploaded_by, created_at, updated_at
//
// NOTE: file_url is aliased as document_url in SELECT so ContractCreateModal
//       (which reads tpl.document_url) and OACLMTemplates (which reads t.file_url)
//       both receive what they expect from a single response shape.

// GET /templates — all active templates for this org (used by OACLMTemplates)
router.get('/templates', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, org_id, contract_type, name, description,
              file_url, file_url AS document_url, file_name, file_size,
              is_active, uploaded_by, created_at, updated_at
       FROM contract_templates
       WHERE org_id = $1 AND is_active = TRUE
       ORDER BY contract_type, name`,
      [req.orgId]
    );
    res.json({ templates: r.rows });
  } catch (err) {
    console.error('GET /contracts/templates error:', err);
    res.status(500).json({ error: { message: 'Failed to load templates' } });
  }
});

// GET /templates/by-type/:contractType — filtered by type (used by ContractCreateModal)
// MUST stay before /:id routes so Express does not match 'by-type' as a contract id.
router.get('/templates/by-type/:contractType', async (req, res) => {
  try {
    const { contractType } = req.params;
    const r = await db.query(
      `SELECT id, org_id, contract_type, name, description,
              file_url, file_url AS document_url, file_name, file_size,
              is_active, uploaded_by, created_at, updated_at
       FROM contract_templates
       WHERE org_id = $1 AND contract_type = $2 AND is_active = TRUE
       ORDER BY name`,
      [req.orgId, contractType]
    );
    res.json({ templates: r.rows });
  } catch (err) {
    console.error('GET /contracts/templates/by-type error:', err);
    res.status(500).json({ error: { message: 'Failed to load templates' } });
  }
});

// POST /templates — create template (admin/owner only, used by OACLMTemplates)
// Payload: { contractType, name, description?, fileUrl, fileName?, fileSize? }
router.post('/templates', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const { contractType, name, description = '', fileUrl, fileName = '', fileSize = null } = req.body;
    if (!contractType || !name?.trim() || !fileUrl?.trim()) {
      return res.status(400).json({ error: { message: 'contractType, name, and fileUrl are required' } });
    }
    const r = await db.query(
      `INSERT INTO contract_templates
         (org_id, contract_type, name, description, file_url, file_name, file_size, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, org_id, contract_type, name, description,
                 file_url, file_url AS document_url, file_name, file_size,
                 is_active, uploaded_by, created_at, updated_at`,
      [req.orgId, contractType, name.trim(), description, fileUrl.trim(), fileName, fileSize, req.userId]
    );
    res.status(201).json({ template: r.rows[0] });
  } catch (err) {
    console.error('POST /contracts/templates error:', err);
    res.status(500).json({ error: { message: 'Failed to create template' } });
  }
});

// DELETE /templates/:id — soft delete (admin/owner only, used by OACLMTemplates)
router.delete('/templates/:id', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const check = await db.query(
      `SELECT id FROM contract_templates WHERE id = $1 AND org_id = $2 AND is_active = TRUE`,
      [id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Template not found' } });
    }
    await db.query(
      `UPDATE contract_templates SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /contracts/templates/:id error:', err);
    res.status(500).json({ error: { message: 'Failed to delete template' } });
  }
});

// ── Legal team ────────────────────────────────────────────────────────
router.get('/legal/team-status', async (req, res) => {
  try {
    const isLegalMember = await CS.isLegalTeamMember(req.orgId, req.userId);
    const legalTeam = await CS.getLegalTeamMembers(req.orgId);
    res.json({ isLegalMember, legalTeam });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

router.get('/legal/members', async (req, res) => {
  try {
    const members = await CS.getLegalTeamMembers(req.orgId);
    res.json({ members });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

// Legal queue: in_review/with_legal contracts not yet assigned
router.get('/legal/queue', async (req, res) => {
  try {
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    const contracts = await CS.listContracts(req.orgId, { legalMode: 'queue', userId: req.userId });
    res.json({ contracts });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

// Legal assigned: in_review/with_legal contracts assigned to this user
router.get('/legal/assigned', async (req, res) => {
  try {
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    const contracts = await CS.listContracts(req.orgId, { legalMode: 'assigned', userId: req.userId });
    res.json({ contracts });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

// ── Admin: workflow config ─────────────────────────────────────────────
router.get('/admin/workflow-config', requireRole('admin','owner'), async (req, res) => {
  try {
    const config = await CS.getWorkflowConfig(req.orgId);
    res.json({ config });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to fetch config' } }); }
});

router.put('/admin/workflow-config', requireRole('admin','owner'), async (req, res) => {
  try {
    const {
      return_to_sales_mode, signature_gate, nda_requires_internal_approval,
      msa_resubmit_required, sow_resubmit_required, order_form_resubmit_required,
      amendment_resubmit_required, custom_resubmit_required,
    } = req.body;
    const r = await db.query(
      `INSERT INTO contract_workflow_config
         (org_id,return_to_sales_mode,signature_gate,nda_requires_internal_approval,
          nda_resubmit_required,msa_resubmit_required,sow_resubmit_required,
          order_form_resubmit_required,amendment_resubmit_required,custom_resubmit_required)
       VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7,$8,$9)
       ON CONFLICT (org_id) DO UPDATE SET
         return_to_sales_mode=$2, signature_gate=$3,
         nda_requires_internal_approval=$4,
         msa_resubmit_required=$5, sow_resubmit_required=$6,
         order_form_resubmit_required=$7, amendment_resubmit_required=$8,
         custom_resubmit_required=$9, updated_at=NOW()
       RETURNING *`,
      [req.orgId,
       return_to_sales_mode||'manual', signature_gate||'hard',
       !!nda_requires_internal_approval,
       !!msa_resubmit_required, !!sow_resubmit_required,
       !!order_form_resubmit_required, !!amendment_resubmit_required, !!custom_resubmit_required]
    );
    res.json({ config: r.rows[0] });
  } catch (err) {
    console.error(err); res.status(500).json({ error: { message: 'Failed to save config' } });
  }
});

// ── Admin: approval config ─────────────────────────────────────────────
router.get('/admin/approval-config', requireRole('admin','owner'), async (req, res) => {
  try { res.json({ config: await AS.getApprovalConfig(req.orgId) }); }
  catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

router.put('/admin/approval-config', requireRole('admin','owner'), async (req, res) => {
  try {
    const { rules } = req.body;
    if (!Array.isArray(rules)) return res.status(400).json({ error: { message: 'rules must be array' } });
    await AS.saveApprovalConfig(req.orgId, rules);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to save approval config' } }); }
});

// ── Pending approvals ─────────────────────────────────────────────────
router.get('/approvals/pending', async (req, res) => {
  try { res.json({ approvals: await AS.getPendingApprovals(req.orgId, req.userId) }); }
  catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

router.post('/approvals/:aId/decide', async (req, res) => {
  try {
    const { decision, note } = req.body;
    if (!['approved','rejected'].includes(decision))
      return res.status(400).json({ error: { message: 'decision must be approved or rejected' } });
    const result = await AS.processDecision(req.orgId, parseInt(req.params.aId,10), req.userId, decision, note);
    const ct = await db.query(`SELECT title FROM contracts WHERE id=$1`, [result.contractId]);
    const title = ct.rows[0]?.title || 'Contract';
    if (result.outcome === 'rejected') {
      NS.notifyApprovalRejected(req.orgId, result.contractId, title, result.ownerId, req.userId).catch(() => {});
    } else if (result.outcome === 'all_approved') {
      NS.notifyApprovalCompleted(req.orgId, result.contractId, title, result.ownerId).catch(() => {});
    } else if (result.nextApproverIds?.length) {
      NS.notifyNextApprovers(req.orgId, result.contractId, title, result.nextApproverIds).catch(() => {});
    }
    res.json({ result });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── Bulk submit to legal ──────────────────────────────────────────────
router.post('/bulk-submit-legal', async (req, res) => {
  try {
    const { contractIds, assigneeUserId } = req.body;
    if (!Array.isArray(contractIds) || contractIds.length === 0)
      return res.status(400).json({ error: { message: 'contractIds array required' } });
    if (contractIds.length > 50)
      return res.status(400).json({ error: { message: 'Maximum 50 contracts per bulk operation' } });
    const results = [];
    for (const id of contractIds) {
      try {
        const result = await CS.submitForLegalReview(
          req.orgId, parseInt(id, 10), req.userId,
          assigneeUserId ? { assigneeUserId } : {}
        );
        const ct = await db.query(`SELECT title FROM contracts WHERE id=$1`, [id]);
        const title = ct.rows[0]?.title;
        if (result.legalQueue) {
          NS.notifyLegalQueueSubmission(req.orgId, id, title, req.userId).catch(() => {});
        } else {
          NS.notifyLegalAssigneeSubmission(req.orgId, id, title, req.userId, result.assigneeUserId).catch(() => {});
        }
        results.push({ id, success: true });
      } catch (e) {
        results.push({ id, success: false, error: e.message });
      }
    }
    const failed = results.filter(r => !r.success);
    res.json({
      results,
      summary: { total: contractIds.length, succeeded: contractIds.length - failed.length, failed: failed.length },
    });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── Contracts CRUD ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { scope, status, reviewSubStatus, contractType, dealId, search } = req.query;
    const contracts = await CS.listContracts(req.orgId, {
      scope, status, reviewSubStatus, contractType, dealId, search, userId: req.userId,
    });
    res.json({ contracts });
  } catch (err) { console.error(err); res.status(500).json({ error: { message: 'Failed to fetch contracts' } }); }
});

router.get('/:id', async (req, res) => {
  try {
    const c = await CS.getContract(req.orgId, parseInt(req.params.id,10));
    if (!c) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ contract: c });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

router.post('/', async (req, res) => {
  try {
    const contract = await CS.createContract(req.orgId, req.userId, req.body);
    res.status(201).json({ contract });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.put('/:id', async (req, res) => {
  try {
    const c = await CS.updateContract(req.orgId, parseInt(req.params.id,10), req.userId, req.body);
    res.json({ contract: c });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await CS.deleteContract(req.orgId, parseInt(req.params.id,10));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: 'Failed' } }); }
});

// ── Document versions ──────────────────────────────────────────────────
router.get('/:id/versions', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT cdv.*, u.first_name, u.last_name FROM contract_document_versions cdv
       LEFT JOIN users u ON u.id=cdv.uploaded_by
       WHERE cdv.contract_id=$1 AND cdv.org_id=$2
       ORDER BY cdv.version_major DESC, cdv.version_minor DESC, cdv.created_at DESC`,
      [parseInt(req.params.id,10), req.orgId]
    );
    res.json({ versions: r.rows });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

router.post('/:id/versions', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const version = await CS.uploadDocumentVersion(req.orgId, contractId, req.userId, req.body);
    const ct = await db.query(
      `SELECT title, legal_assignee_id, status, review_sub_status FROM contracts WHERE id=$1`,
      [contractId]
    );
    const contract = ct.rows[0];
    // Notify legal assignee when sales uploads a new version while with_sales
    if (contract?.legal_assignee_id && contract?.review_sub_status === 'with_sales') {
      NS.notifyResubmittedToLegal(req.orgId, contractId, contract.title, contract.legal_assignee_id, [], req.userId).catch(() => {});
    }
    res.status(201).json({ version });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── Transitions ────────────────────────────────────────────────────────

// Submit draft to legal review (draft → in_review/with_legal)
router.post('/:id/submit-legal', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await CS.submitForLegalReview(req.orgId, contractId, req.userId, req.body);
    const ct = await db.query(`SELECT title FROM contracts WHERE id=$1`, [contractId]);
    const title = ct.rows[0]?.title;
    if (result.legalQueue) {
      NS.notifyLegalQueueSubmission(req.orgId, contractId, title, req.userId).catch(() => {});
    } else {
      NS.notifyLegalAssigneeSubmission(req.orgId, contractId, title, req.userId, result.assigneeUserId).catch(() => {});
    }
    res.json({ result });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// Pick up from queue (with_legal queue → assigned to self)
router.post('/:id/pick-up', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    await CS.pickUpFromQueue(req.orgId, contractId, req.userId);
    const ct = await db.query(`SELECT title, owner_id FROM contracts WHERE id=$1`, [contractId]);
    if (ct.rows[0]) NS.notifyLegalPickedUp(req.orgId, contractId, ct.rows[0].title, ct.rows[0].owner_id, req.userId).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// Reassign to a different legal team member
router.post('/:id/reassign', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const { newAssigneeId } = req.body;
    if (!newAssigneeId) return res.status(400).json({ error: { message: 'newAssigneeId required' } });
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    await CS.reassignLegal(req.orgId, contractId, req.userId, parseInt(newAssigneeId,10));
    const ct = await db.query(`SELECT title FROM contracts WHERE id=$1`, [contractId]);
    NS.notifyLegalReassigned(req.orgId, contractId, ct.rows[0]?.title, parseInt(newAssigneeId,10), req.userId).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── HANDOFF — unified sub-status transition endpoint ─────────────────
// POST /:id/handoff  body: { toSubStatus: 'with_legal' | 'with_sales' | 'with_customer', note? }
//
// Covers all handoff directions within in_review:
//   Legal → Sales (return for changes)
//   Legal → Customer (send draft for customer review)
//   Sales → Legal (resubmit after making changes)
//   Sales → Customer (pass draft to customer)
//   Customer → Legal (customer returns redlines)
//   Customer → Sales (customer routes back to Sales to co-ordinate)
router.post('/:id/handoff', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const { toSubStatus, note } = req.body;
    if (!toSubStatus) return res.status(400).json({ error: { message: 'toSubStatus required' } });

    const result = await CS.handoffReview(req.orgId, contractId, req.userId, toSubStatus, { note });

    // Notifications based on direction
    if (toSubStatus === 'with_sales') {
      NS.notifyReturnedToSales(req.orgId, contractId, result.title, result.ownerId, req.userId).catch(() => {});
    } else if (toSubStatus === 'with_legal') {
      const ct = await db.query(`SELECT legal_assignee_id FROM contracts WHERE id=$1`, [contractId]);
      const assigneeId = ct.rows[0]?.legal_assignee_id;
      const legalTeam  = assigneeId ? [] : await CS.getLegalTeamUserIds(req.orgId);
      NS.notifyResubmittedToLegal(req.orgId, contractId, result.title, assigneeId, legalTeam, req.userId).catch(() => {});
    }
    // with_customer: notify owner that draft has been sent to customer

    // Regenerate CLM actions for the new status (non-blocking)
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (handoff ${contractId}):`, err.message));

    res.json({ result });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── LEGACY ALIASES — kept so old frontend calls don't break ──────────
// return-sales: with_legal → with_sales
router.post('/:id/return-sales', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    const result = await CS.handoffReview(req.orgId, contractId, req.userId, 'with_sales');
    NS.notifyReturnedToSales(req.orgId, contractId, result.title, result.ownerId, req.userId).catch(() => {});
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (return-sales ${contractId}):`, err.message));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// resubmit: with_sales → with_legal
router.post('/:id/resubmit', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await CS.handoffReview(req.orgId, contractId, req.userId, 'with_legal');
    const ct = await db.query(`SELECT legal_assignee_id FROM contracts WHERE id=$1`, [contractId]);
    const assigneeId = ct.rows[0]?.legal_assignee_id;
    const legalTeam  = assigneeId ? [] : await CS.getLegalTeamUserIds(req.orgId);
    NS.notifyResubmittedToLegal(req.orgId, contractId, result.title, assigneeId, legalTeam, req.userId).catch(() => {});
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (resubmit ${contractId}):`, err.message));
    res.json({ result });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── Send for signature ─────────────────────────────────────────────────
router.post('/:id/send-signature', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    await CS.sendForSignature(req.orgId, contractId, req.userId);
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (send-signature ${contractId}):`, err.message));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message, code: err.code } }); }
});

// Legal-initiated send-for-signature
router.post('/:id/legal-send-signature', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    await CS.sendForSignature(req.orgId, contractId, req.userId);
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (legal-send-sig ${contractId}):`, err.message));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message, code: err.code } }); }
});

router.post('/:id/mark-signed', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await CS.markSigned(req.orgId, contractId, req.userId);
    NS.notifyAllSigned(req.orgId, contractId, result.title, result.ownerId).catch(() => {});
    NS.notifyPendingBooking(req.orgId, contractId, result.title, result.ownerId).catch(() => {});
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (mark-signed ${contractId}):`, err.message));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/activate', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    await CS.activateContract(req.orgId, contractId, req.userId);
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (activate ${contractId}):`, err.message));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/confirm-booking', async (req, res) => {
  try {
    await CS.confirmBooking(req.orgId, parseInt(req.params.id,10), req.userId);
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/recall', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await CS.recallContract(req.orgId, contractId, req.userId, req.body);
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (recall ${contractId}):`, err.message));
    res.json({ result });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/void', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    await CS.voidContract(req.orgId, contractId, req.userId, req.body);
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (void ${contractId}):`, err.message));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/terminate', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    await CS.terminateContract(req.orgId, contractId, req.userId, req.body);
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (terminate ${contractId}):`, err.message));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    await CS.cancelContract(req.orgId, contractId, req.userId, req.body);
    ContractActionsGenerator.generateForContract(contractId)
      .catch(err => console.error(`CLM action regen error (cancel ${contractId}):`, err.message));
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/amend', async (req, res) => {
  try {
    const contract = await CS.amendContract(req.orgId, parseInt(req.params.id,10), req.userId);
    res.status(201).json({ contract });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/start-approval', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await AS.startApprovalChain(req.orgId, contractId, req.userId);
    if (!result.autoApproved && result.approvers.length) {
      const ct = await db.query(`SELECT title FROM contracts WHERE id=$1`, [contractId]);
      const ids = [...new Set(result.approvers.map(a => a.approver_user_id))];
      NS.notifyApprovalNeeded(req.orgId, contractId, ct.rows[0]?.title, ids).catch(() => {});
    }
    res.json({ result });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/customer-signing', async (req, res) => {
  try {
    await CS.markCustomerInitiatedSigning(req.orgId, parseInt(req.params.id,10), req.userId, req.body);
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/upload-executed', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await CS.uploadExecutedDocument(req.orgId, contractId, req.userId, req.body);
    NS.notifyAllSigned(req.orgId, contractId, result.title, result.ownerId).catch(() => {});
    NS.notifyPendingBooking(req.orgId, contractId, result.title, result.ownerId).catch(() => {});
    res.status(201).json({ version: result.version });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── Hierarchy ──────────────────────────────────────────────────────────
router.get('/:id/hierarchy', async (req, res) => {
  try {
    const root = await CS.getContractHierarchy(req.orgId, parseInt(req.params.id,10));
    res.json({ root });
  } catch (err) {
    console.error('GET hierarchy error:', err);
    res.status(500).json({ error: { message: err.message || 'Failed to fetch hierarchy' } });
  }
});

// ── Signatories ────────────────────────────────────────────────────────
router.post('/:id/signatories', async (req, res) => {
  try {
    const s = await CS.addSignatory(req.orgId, parseInt(req.params.id,10), req.body);
    res.status(201).json({ signatory: s });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.delete('/:id/signatories/:sid', async (req, res) => {
  try {
    await CS.removeSignatory(req.orgId, parseInt(req.params.id,10), parseInt(req.params.sid,10));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

// ── Notes ──────────────────────────────────────────────────────────────
router.post('/:id/notes', async (req, res) => {
  try {
    const { note } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: { message: 'Note required' } });
    await CS.addNote(req.orgId, parseInt(req.params.id,10), req.userId, note);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});


// ── POST /:id/generate-actions ───────────────────────────────────────────────
// Generate actions from the CLM playbook for a contract's current status.
//
// Body: {
//   mode?:        'template' | 'ai',   — defaults to 'template'
//   stageKey?:    string,              — defaults to contract.status
//   deduplicate?: boolean,             — default true
// }
router.post('/:id/generate-actions', gate, async (req, res) => {
  try {
    const contractId = parseInt(req.params.id, 10);
    const userId     = req.user?.userId || req.userId;
    const orgId      = req.orgId;
    const { mode = 'template', deduplicate = true } = req.body;

    // Load contract
    const contractRes = await db.query(
      'SELECT * FROM contracts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [contractId, orgId]
    );
    if (contractRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contract not found' } });
    }
    const contract = contractRes.rows[0];
    const stageKey = req.body.stageKey || contract.status;

    // Build a lightweight context object for PlaybookActionGenerator
    // (contracts don't have a full context builder yet — use what we have)
    const context = {
      contract,
      entityType:           'contract',
      playbookStageGuidance: null,
      orgId,
      userId,
    };

    // Resolve playbook — use contract's explicit playbook_id or org CLM default
    const resolvedPlaybookId = contract.playbook_id
      || (await PlaybookService.getDefaultPlaybookForEntity(orgId, 'contract'))?.id
      || null;

    // Generate action rows
    const { actions, playbookId, playbookName, mode: effectiveMode } =
      await PlaybookActionGenerator.generate({
        entityType: 'contract',
        context,
        playbookId: resolvedPlaybookId,
        stageKey,
        mode,
        orgId,
        userId,
      });

    if (actions.length === 0) {
      return res.json({
        inserted: 0, skipped: 0,
        playbookName: playbookName || null,
        mode: effectiveMode,
        message: playbookName
          ? `No plays defined for status "${stageKey}" in "${playbookName}"`
          : 'No CLM playbook found',
      });
    }

    // Write to actions table (with contract_id FK)
    const result = await ActionWriter.write({
      entityType:        'contract',
      entityId:          contractId,
      actions,
      playbookId,
      playbookName,
      orgId,
      userId:            contract.owner_id || userId,
      deduplicateSource: deduplicate ? 'playbook' : null,
    });

    res.json({
      inserted:     result.inserted,
      skipped:      result.skipped,
      playbookName: playbookName || null,
      mode:         effectiveMode,
      message:      `Generated ${result.inserted} action(s) from "${playbookName || 'CLM playbook'}"`,
    });

  } catch (err) {
    console.error('generate-actions (contract) error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});




module.exports = router;
