/**
 * agent.routes.js
 *
 * REST endpoints for the Agentic Framework.
 * Mounted at /api/agent in server.js.
 *
 * All routes require authenticateToken + orgContext (same pattern as actions.routes.js).
 * Proposals are scoped by org_id + user_id — users only see proposals for their own deals.
 *
 * FIXES applied:
 *   - POST /reject now passes req.orgId to AgentProposalService.reject() (security)
 *   - POST /bulk-approve now only executes proposals that were actually approved
 */

const express = require('express');
const router  = express.Router();
const authenticateToken    = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const AgentProposalService = require('../services/AgentProposalService');
const ProposalExecutor     = require('../services/ProposalExecutor');
const TokenTrackingService = require('../services/TokenTrackingService');

// ── Auth + org context on every route ────────────────────────
router.use(authenticateToken);
router.use(orgContext);

// ── Row mapper for consistent frontend shape ─────────────────
function mapProposalRow(row) {
  return {
    id:              row.id,
    orgId:           row.org_id,
    userId:          row.user_id,
    proposalType:    row.proposal_type,
    status:          row.status,
    payload:         typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}),
    originalPayload: row.original_payload ? (typeof row.original_payload === 'string' ? JSON.parse(row.original_payload) : row.original_payload) : null,
    reasoning:       row.reasoning,
    confidence:      row.confidence ? parseFloat(row.confidence) : null,
    source:          row.source,
    sourceContext:   row.source_context,
    executionResult: row.execution_result,
    reviewedBy:      row.reviewed_by,
    reviewerName:    row.reviewer_name || null,
    reviewedAt:      row.reviewed_at,
    rejectionReason: row.rejection_reason,
    executedAt:      row.executed_at,
    errorMessage:    row.error_message,
    retryCount:      row.retry_count,
    expiresAt:       row.expires_at,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
    // Joined deal/contact/account context
    deal: row.deal_name ? {
      id:     row.deal_id,
      name:   row.deal_name,
      value:  parseFloat(row.deal_value) || 0,
      stage:  row.deal_stage,
      health: row.deal_health,
    } : (row.deal_id ? { id: row.deal_id } : null),
    contact: row.contact_first_name ? {
      id:        row.contact_id,
      firstName: row.contact_first_name,
      lastName:  row.contact_last_name,
      email:     row.contact_email,
    } : (row.contact_id ? { id: row.contact_id } : null),
    account: row.account_name ? {
      id:   row.account_id,
      name: row.account_name,
    } : null,
    actionId: row.action_id,
    priorityScore: row.priority_score || null,
  };
}

// ── GET /proposals — list proposals ──────────────────────────
// Query params: status, proposalType, dealId, limit
router.get('/proposals', async (req, res) => {
  try {
    const { status, proposalType, dealId, limit } = req.query;
    const rows = await AgentProposalService.getPendingForUser(
      req.user.userId, req.orgId,
      { status: status || undefined, proposalType, dealId, limit }
    );
    res.json({ proposals: rows.map(mapProposalRow) });
  } catch (err) {
    console.error('GET /agent/proposals error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch proposals' } });
  }
});

// ── GET /proposals/count — pending count for badge ───────────
router.get('/proposals/count', async (req, res) => {
  try {
    const count = await AgentProposalService.getPendingCount(req.user.userId, req.orgId);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to get count' } });
  }
});

// ── GET /proposals/:id — single proposal with full context ───
router.get('/proposals/:id', async (req, res) => {
  try {
    const row = await AgentProposalService.getById(parseInt(req.params.id), req.orgId);
    if (!row) return res.status(404).json({ error: { message: 'Proposal not found' } });
    res.json({ proposal: mapProposalRow(row) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch proposal' } });
  }
});

// ── POST /proposals/:id/approve ──────────────────────────────
// Body: { modifiedPayload? }
router.post('/proposals/:id/approve', async (req, res) => {
  try {
    const { modifiedPayload } = req.body || {};
    const result = await AgentProposalService.approve(
      parseInt(req.params.id), req.user.userId, modifiedPayload || null
    );
    if (!result.success) {
      return res.status(400).json({ error: { message: result.error } });
    }

    // Execute immediately after approval
    const execResult = await ProposalExecutor.execute(result.proposal.id);

    res.json({
      proposal: mapProposalRow(result.proposal),
      execution: execResult,
    });
  } catch (err) {
    console.error('POST /proposals/:id/approve error:', err);
    res.status(500).json({ error: { message: 'Failed to approve proposal' } });
  }
});

// ── POST /proposals/:id/reject ───────────────────────────────
// Body: { reason? }
// FIX: Now passes req.orgId to service for org_id scoping
router.post('/proposals/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const result = await AgentProposalService.reject(
      parseInt(req.params.id), req.user.userId, reason || null, req.orgId
    );
    if (!result.success) {
      return res.status(400).json({ error: { message: result.error } });
    }
    res.json({ proposal: mapProposalRow(result.proposal) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to reject proposal' } });
  }
});

// ── PATCH /proposals/:id/payload — edit payload before approving
router.patch('/proposals/:id/payload', async (req, res) => {
  try {
    const { payload } = req.body;
    if (!payload) return res.status(400).json({ error: { message: 'payload is required' } });

    const db2 = require('../config/database');
    const result = await db2.query(
      `UPDATE agent_proposals
       SET original_payload = COALESCE(original_payload, payload),
           payload = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3 AND status = 'pending'
       RETURNING *`,
      [JSON.stringify(payload), parseInt(req.params.id), req.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Proposal not found or not pending' } });
    }
    res.json({ proposal: mapProposalRow(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update payload' } });
  }
});

// ── POST /proposals/bulk-approve ─────────────────────────────
// Body: { proposalIds: number[] }
// FIX: Now only executes proposals that were actually approved
router.post('/proposals/bulk-approve', async (req, res) => {
  try {
    const { proposalIds } = req.body;
    if (!proposalIds?.length) return res.status(400).json({ error: { message: 'proposalIds required' } });

    const result = await AgentProposalService.bulkApprove(proposalIds, req.user.userId, req.orgId);

    // Execute only the proposals that were actually approved (not already rejected, wrong org, etc.)
    const execResults = [];
    for (const id of (result.approvedIds || [])) {
      const execResult = await ProposalExecutor.execute(id);
      execResults.push({ id, ...execResult });
    }

    res.json({ ...result, executions: execResults });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to bulk approve' } });
  }
});

// ── POST /proposals/bulk-reject ──────────────────────────────
// Body: { proposalIds: number[], reason? }
router.post('/proposals/bulk-reject', async (req, res) => {
  try {
    const { proposalIds, reason } = req.body;
    if (!proposalIds?.length) return res.status(400).json({ error: { message: 'proposalIds required' } });

    const result = await AgentProposalService.bulkReject(proposalIds, req.user.userId, req.orgId, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to bulk reject' } });
  }
});

// ── GET /status — check if agentic framework is enabled ──────
router.get('/status', async (req, res) => {
  try {
    const gate = await AgentProposalService.isEnabled(req.orgId, req.user.userId);
    res.json({
      enabled:  gate.enabled,
      reason:   gate.reason,
      settings: gate.settings || null,
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to check status' } });
  }
});

// ── GET /deals/:dealId/proposals — proposals for a deal ──────
router.get('/deals/:dealId/proposals', async (req, res) => {
  try {
    const rows = await AgentProposalService.getByDeal(
      parseInt(req.params.dealId), req.orgId
    );
    res.json({ proposals: rows.map(mapProposalRow) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch deal proposals' } });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORG ADMIN ENDPOINTS (require admin/owner role)
// ═══════════════════════════════════════════════════════════════

// ── PATCH /admin/settings — toggle agentic framework ─────────
router.patch('/admin/settings', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const {
      agentic_framework_enabled,
      agentic_auto_expire_days,
      agentic_max_proposals_per_deal,
      agentic_min_confidence,
    } = req.body;
    const db2 = require('../config/database');

    // Build settings patch
    const patch = {};
    if (agentic_framework_enabled !== undefined) {
      patch.agentic_framework_enabled = !!agentic_framework_enabled;
    }
    if (agentic_auto_expire_days !== undefined) {
      patch.agentic_auto_expire_days = parseInt(agentic_auto_expire_days) || 7;
    }
    if (agentic_max_proposals_per_deal !== undefined) {
      patch.agentic_max_proposals_per_deal = Math.max(1, Math.min(50, parseInt(agentic_max_proposals_per_deal) || 10));
    }
    if (agentic_min_confidence !== undefined) {
      patch.agentic_min_confidence = Math.max(0, Math.min(1, parseFloat(agentic_min_confidence) || 0.40));
    }

    const result = await db2.query(
      `UPDATE organizations
       SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2
       RETURNING settings`,
      [JSON.stringify(patch), req.orgId]
    );

    res.json({ settings: result.rows[0]?.settings || {} });
  } catch (err) {
    console.error('PATCH /agent/admin/settings error:', err);
    res.status(500).json({ error: { message: 'Failed to update settings' } });
  }
});

// ── GET /admin/stats — proposal stats for org dashboard ──────
router.get('/admin/stats', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const stats = await AgentProposalService.getOrgStats(req.orgId, days);
    res.json({ stats, period: days });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch stats' } });
  }
});

// ── GET /admin/token-usage — token usage for org ─────────────
router.get('/admin/token-usage', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const usage = await TokenTrackingService.getOrgUsage(req.orgId, days);
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch token usage' } });
  }
});

// ── GET /token-usage — personal token usage (any user) ───────
router.get('/token-usage', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const usage = await TokenTrackingService.getUserUsage(req.user.userId, req.orgId, days);
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch token usage' } });
  }
});

module.exports = router;
