// contracts.routes.js
// All CLM endpoints. Middleware: authenticateToken → orgContext → requireModule('contracts')
// E-signature additions marked with ── ESIGN ──

const express  = require('express');
const router   = express.Router();
const db       = require('../config/database');
const auth     = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');

const CS  = require('../services/contractService');
const AS  = require('../services/contractApprovalService');
const NS  = require('../services/contractNotificationService');
const SS  = require('../services/signatureService');

// ── ESIGN: Webhook endpoint — MUST be before router.use(auth) ─────────────
// Zoho Sign (and other providers) POST to this URL without our JWT token.
// Path: POST /contracts/webhooks/esign/:provider
// e.g.  POST /contracts/webhooks/esign/zoho
router.post('/webhooks/esign/:provider', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const { provider } = req.params;
    const event = await SS.handleWebhook(provider, req.body, req.headers);

    if (event.event === 'completed' && event.requestId) {
      // Look up contract by esign_request_id
      const r = await db.query(
        `SELECT id, org_id, owner_id, title FROM contracts
         WHERE esign_request_id = $1 AND deleted_at IS NULL`,
        [event.requestId]
      );
      const contract = r.rows[0];

      if (contract) {
        // Update to signed status + persist signed document URL if provided
        const result = await CS.markSigned(contract.org_id, contract.id, null);

        if (event.signedDocumentUrl) {
          await db.query(
            `UPDATE contracts SET document_url = $2 WHERE id = $1`,
            [contract.id, event.signedDocumentUrl]
          );
        }

        NS.notifyAllSigned(
          contract.org_id, contract.id, contract.title, contract.owner_id
        ).catch(() => {});
      }
    }

    if (event.event === 'declined' && event.requestId) {
      const r = await db.query(
        `SELECT id, org_id, owner_id, title FROM contracts
         WHERE esign_request_id = $1 AND deleted_at IS NULL`,
        [event.requestId]
      );
      const contract = r.rows[0];
      if (contract) {
        // Log a contract event for the decline — owner will see it in the timeline
        await db.query(
          `INSERT INTO contract_events (contract_id, org_id, event_type, payload)
           VALUES ($1, $2, 'signature_declined', $3)`,
          [contract.id, contract.org_id, JSON.stringify({ declinedBy: event.declinedBy })]
        );
      }
    }

    // Always return 200 to Zoho — otherwise it will retry indefinitely
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Webhook] esign error:', err.message);
    // Still return 200 to prevent provider retry storms
    res.status(200).json({ received: true, error: err.message });
  }
});

// ── Auth + org context apply to all routes below ──────────────────────
router.use(auth);
router.use(orgContext);

const gate = requireModule('contracts');

// ── Module toggle (no gate — must work when disabled) ─────────────────
router.patch('/admin/module', requireRole('admin','owner'), async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: { message: 'enabled must be boolean' } });
    await db.query(
      `UPDATE organizations SET settings = jsonb_set(COALESCE(settings,'{}'),'{modules,contracts}',$2::jsonb,true) WHERE id=$1`,
      [req.orgId, JSON.stringify(enabled)]
    );
    requireModule.invalidate(req.orgId, 'contracts');
    res.json({ enabled });
  } catch (err) {
    console.error(err); res.status(500).json({ error: { message: 'Failed to update module' } });
  }
});

// ── ESIGN: Provider config routes (admin only, no module gate needed) ──
// These sit above router.use(gate) so they work regardless of module state

router.get('/admin/esign-config', requireRole('admin','owner'), async (req, res) => {
  try {
    const config = await SS.getEsignConfig(req.orgId);
    res.json({ config });
  } catch (err) {
    res.status(err.status||500).json({ error: { message: err.message } });
  }
});

router.put('/admin/esign-config', requireRole('admin','owner'), async (req, res) => {
  try {
    const { provider, client_id, client_secret, redirect_uri } = req.body;
    await SS.saveProviderConfig(req.orgId, { provider, client_id, client_secret, redirect_uri });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status||500).json({ error: { message: err.message } });
  }
});

router.get('/admin/esign-auth-url', requireRole('admin','owner'), async (req, res) => {
  try {
    const url = await SS.getAuthUrl(req.orgId);
    res.json({ url });
  } catch (err) {
    res.status(err.status||500).json({ error: { message: err.message } });
  }
});

router.post('/admin/esign-callback', requireRole('admin','owner'), async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: { message: 'code is required' } });
    const result = await SS.handleOAuthCallback(req.orgId, code);
    res.json(result);
  } catch (err) {
    res.status(err.status||500).json({ error: { message: err.message } });
  }
});

router.post('/admin/esign-disconnect', requireRole('admin','owner'), async (req, res) => {
  try {
    await SS.disconnectProvider(req.orgId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.get('/admin/esign-validate', requireRole('admin','owner'), async (req, res) => {
  try {
    const result = await SS.validateConnection(req.orgId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});


router.patch('/admin/esign-toggle', requireRole('admin','owner'), async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: { message: 'enabled (boolean) is required' } });
    await SS.toggleEsign(req.orgId, enabled);
    res.json({ success: true, enabled });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.delete('/admin/esign-config', requireRole('admin','owner'), async (req, res) => {
  try {
    await SS.removeOrgProvider(req.orgId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});
// ── All routes below require module enabled ────────────────────────────
router.use(gate);

// ── Legal team check (for frontend tab visibility) ────────────────────
router.get('/legal/team-status', async (req, res) => {
  try {
    const isLegalMember = await CS.isLegalTeamMember(req.orgId, req.userId);
    res.json({ isLegalMember });
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

// ── Legal inbox ────────────────────────────────────────────────────────
router.get('/legal/queue', async (req, res) => {
  try {
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    const contracts = await CS.listContracts(req.orgId, { legalMode: 'queue', userId: req.userId });
    res.json({ contracts });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

router.get('/legal/assigned', async (req, res) => {
  try {
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    const contracts = await CS.listContracts(req.orgId, { legalMode: 'assigned', userId: req.userId });
    res.json({ contracts });
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

// ── Pending approvals for current user ────────────────────────────────
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
  } catch (err) {
    res.status(err.status||500).json({ error: { message: err.message } });
  }
});

// ── Contracts CRUD ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { scope, status, contractType, dealId, search } = req.query;
    const contracts = await CS.listContracts(req.orgId, {
      scope, status, contractType, dealId, search, userId: req.userId,
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
  } catch (err) { res.status(500).json({ error: { message: 'Failed' } }); }
});

// ── Document versions ──────────────────────────────────────────────────
router.get('/:id/versions', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT cdv.*, u.first_name, u.last_name FROM contract_document_versions cdv
       LEFT JOIN users u ON u.id=cdv.uploaded_by
       WHERE cdv.contract_id=$1 AND cdv.org_id=$2 ORDER BY cdv.created_at DESC`,
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
      `SELECT title, legal_assignee_id, status FROM contracts WHERE id=$1`, [contractId]
    );
    const contract = ct.rows[0];
    if (contract?.legal_assignee_id) {
      NS.notifyResubmittedToLegal(
        req.orgId, contractId, contract.title,
        contract.legal_assignee_id, [], req.userId
      ).catch(() => {});
    }
    res.status(201).json({ version });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── Transitions ────────────────────────────────────────────────────────

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

router.post('/:id/pick-up', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    await CS.pickUpFromQueue(req.orgId, contractId, req.userId);
    const ct = await db.query(`SELECT title, owner_id FROM contracts WHERE id=$1`, [contractId]);
    if (ct.rows[0]) {
      NS.notifyLegalPickedUp(req.orgId, contractId, ct.rows[0].title, ct.rows[0].owner_id, req.userId).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

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

router.post('/:id/return-sales', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    if (!await CS.isLegalTeamMember(req.orgId, req.userId))
      return res.status(403).json({ error: { message: 'Legal team only' } });
    const result = await CS.returnToSales(req.orgId, contractId, req.userId);
    NS.notifyReturnedToSales(req.orgId, contractId, result.title, result.ownerId, req.userId).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/resubmit', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await CS.resubmitToLegal(req.orgId, contractId, req.userId);
    const ct = await db.query(`SELECT title, legal_assignee_id FROM contracts WHERE id=$1`, [contractId]);
    if (ct.rows[0]) {
      const legalTeam = result.legalQueue ? await CS.getLegalTeamUserIds(req.orgId) : [];
      NS.notifyResubmittedToLegal(
        req.orgId, contractId, ct.rows[0].title,
        ct.rows[0].legal_assignee_id, legalTeam, req.userId
      ).catch(() => {});
    }
    res.json({ result });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── ESIGN: send-signature now triggers provider ────────────────────────
router.post('/:id/send-signature', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);

    // 1. Update contract status to in_signatures (existing logic)
    const result = await CS.sendForSignature(req.orgId, contractId, req.userId);

    // 2. Fetch signatories for this contract
    const sigR = await db.query(
      `SELECT name, email, signatory_type, role
       FROM contract_signatories
       WHERE contract_id = $1 AND org_id = $2
       ORDER BY created_at ASC`,
      [contractId, req.orgId]
    );

    // 3. Trigger signing at provider (non-blocking if no provider configured)
    SS.triggerSigning(
      req.orgId,
      { id: contractId, title: result.title, documentUrl: result.documentUrl || null },
      sigR.rows
    ).catch(err => {
      // Log but don't fail the request — ActionCRM manual tracking still works
      console.error(`[send-signature] esign trigger failed for contract ${contractId}:`, err.message);
    });

    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message, code: err.code } }); }
});

router.post('/:id/mark-signed', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await CS.markSigned(req.orgId, contractId, req.userId);
    NS.notifyAllSigned(req.orgId, contractId, result.title, result.ownerId).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/activate', async (req, res) => {
  try {
    await CS.activateContract(req.orgId, parseInt(req.params.id,10), req.userId);
    res.json({ success: true });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

// ── ESIGN: recall and void cancel the signing request at provider ──────
router.post('/:id/recall', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    const result = await CS.recallContract(req.orgId, contractId, req.userId, req.body);
    SS.cancelSigning(req.orgId, contractId).catch(() => {});
    res.json({ result });
  } catch (err) { res.status(err.status||500).json({ error: { message: err.message } }); }
});

router.post('/:id/void', async (req, res) => {
  try {
    const contractId = parseInt(req.params.id,10);
    await CS.voidContract(req.orgId, contractId, req.userId, req.body);
    SS.cancelSigning(req.orgId, contractId).catch(() => {});
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

module.exports = router;
