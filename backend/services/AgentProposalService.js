/**
 * AgentProposalService.js
 *
 * Core service for the Agentic Framework — manages proposal lifecycle:
 *   pending → approved → executing → executed (or rejected / failed)
 *
 * Every public method checks org-level agentic_framework_enabled before
 * creating proposals. User-level agentic_proposals_enabled is checked too.
 *
 * All queries are scoped by org_id to prevent cross-org leakage.
 */

const db = require('../config/database');

const VALID_PROPOSAL_TYPES = [
  'create_contact', 'update_deal_stage', 'draft_email',
  'schedule_meeting', 'flag_risk', 'update_contact', 'link_contact_deal',
];

const VALID_STATUSES = [
  'pending', 'approved', 'executing', 'executed', 'rejected', 'failed', 'expired',
];

// ── Defaults (overridable via org settings) ─────────────────────────────────
const DEFAULT_MAX_PROPOSALS_PER_DEAL_PER_DAY = 10;
const DEFAULT_MIN_CONFIDENCE = 0.40;

// ── Composite priority scoring ──────────────────────────────────────────────
// Weights for each signal that contributes to the priority score (0–100).

const TYPE_WEIGHTS = {
  flag_risk:         25,  // Risk flags are most urgent
  update_deal_stage: 20,  // Stage progression matters
  draft_email:       15,
  schedule_meeting:  15,
  create_contact:    10,
  update_contact:     8,
  link_contact_deal:  7,
};

function computePriorityScore(proposal, dealValue = 0) {
  let score = 0;

  // 1. Confidence (0–30 pts)
  const conf = parseFloat(proposal.confidence) || 0;
  score += conf * 30;

  // 2. Proposal type weight (0–25 pts)
  score += TYPE_WEIGHTS[proposal.proposal_type] || 5;

  // 3. Deal value signal (0–20 pts) — log scale so $1M isn't 10x $100k
  const dv = parseFloat(dealValue) || 0;
  if (dv > 0) {
    score += Math.min(20, Math.log10(dv + 1) * 4);
  }

  // 4. Urgency — expires soon (0–15 pts)
  if (proposal.expires_at) {
    const hoursLeft = (new Date(proposal.expires_at) - Date.now()) / 3600000;
    if (hoursLeft < 24)      score += 15;
    else if (hoursLeft < 72) score += 10;
    else if (hoursLeft < 168) score += 5;
  }

  // 5. Freshness bonus — newer proposals get a small bump (0–10 pts)
  if (proposal.created_at) {
    const hoursOld = (Date.now() - new Date(proposal.created_at)) / 3600000;
    if (hoursOld < 1)       score += 10;
    else if (hoursOld < 6)  score += 7;
    else if (hoursOld < 24) score += 4;
    else if (hoursOld < 72) score += 2;
  }

  return Math.round(Math.min(100, Math.max(0, score)));
}

class AgentProposalService {

  // ── Gate check ─────────────────────────────────────────────────────────────

  /**
   * Check if agentic framework is enabled for the org + user.
   * Returns { enabled, reason, settings } — settings includes configurable thresholds.
   */
  static async isEnabled(orgId, userId) {
    try {
      // Org-level gate
      const orgRes = await db.query(
        `SELECT settings FROM organizations WHERE id = $1`,
        [orgId]
      );
      if (orgRes.rows.length === 0) return { enabled: false, reason: 'org_not_found' };

      const settings = orgRes.rows[0].settings || {};
      if (!settings.agentic_framework_enabled) {
        return { enabled: false, reason: 'org_disabled' };
      }

      // User-level gate (action_config)
      const userRes = await db.query(
        `SELECT agentic_proposals_enabled FROM action_config
         WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId]
      );
      // If no config row exists, default is enabled (column default is true)
      if (userRes.rows.length > 0 && userRes.rows[0].agentic_proposals_enabled === false) {
        return { enabled: false, reason: 'user_disabled' };
      }

      return {
        enabled: true,
        reason: null,
        settings: {
          max_proposals_per_deal: settings.agentic_max_proposals_per_deal || DEFAULT_MAX_PROPOSALS_PER_DEAL_PER_DAY,
          min_confidence:         settings.agentic_min_confidence ?? DEFAULT_MIN_CONFIDENCE,
          auto_expire_days:       settings.agentic_auto_expire_days || 7,
        },
      };
    } catch (err) {
      console.error('AgentProposalService.isEnabled error:', err.message);
      return { enabled: false, reason: 'error' };
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a new proposal. Validates org/user gates and rate limits.
   *
   * @param {object} params
   * @param {number} params.orgId
   * @param {number} params.userId        - deal owner who should review
   * @param {string} params.proposalType  - one of VALID_PROPOSAL_TYPES
   * @param {object} params.payload       - the proposed mutation data
   * @param {string} params.reasoning     - AI explanation
   * @param {number} [params.confidence]  - 0.00–1.00
   * @param {string} params.source        - rules_engine | ai_enhancer | ai_processor | email_trigger
   * @param {object} [params.sourceContext]
   * @param {number} [params.dealId]
   * @param {number} [params.contactId]
   * @param {number} [params.accountId]
   * @param {number} [params.actionId]
   * @param {number} [params.autoExpireDays] - override org default
   * @returns {object} { success, proposal?, error? }
   */
  static async createProposal(params) {
    const {
      orgId, userId, proposalType, payload, reasoning,
      confidence, source, sourceContext,
      dealId, contactId, accountId, actionId,
      autoExpireDays,
    } = params;

    // Validate type
    if (!VALID_PROPOSAL_TYPES.includes(proposalType)) {
      return { success: false, error: `Invalid proposal_type: ${proposalType}` };
    }

    // Gate check (also returns org settings)
    const gate = await this.isEnabled(orgId, userId);
    if (!gate.enabled) {
      return { success: false, error: `Agentic framework disabled: ${gate.reason}` };
    }

    const orgSettings = gate.settings || {};

    // Confidence floor — reject proposals below the configured threshold
    const minConf = orgSettings.min_confidence ?? DEFAULT_MIN_CONFIDENCE;
    if (confidence != null && confidence < minConf) {
      console.log(`🤖 Agent: skipping low-confidence proposal (${confidence} < ${minConf}) — ${proposalType} for deal ${dealId || 'N/A'}`);
      return { success: false, error: `Confidence ${confidence} below threshold ${minConf}` };
    }

    // Rate limit per deal per day (configurable)
    const maxPerDeal = orgSettings.max_proposals_per_deal || DEFAULT_MAX_PROPOSALS_PER_DEAL_PER_DAY;
    if (dealId) {
      const countRes = await db.query(
        `SELECT COUNT(*) AS cnt FROM agent_proposals
         WHERE deal_id = $1 AND org_id = $2 AND created_at >= NOW() - INTERVAL '1 day'`,
        [dealId, orgId]
      );
      if (parseInt(countRes.rows[0].cnt) >= maxPerDeal) {
        return { success: false, error: `Rate limit: ${maxPerDeal} proposals/deal/day reached` };
      }
    }

    // Compute expiry
    let expiresAt = null;
    const expDays = autoExpireDays || await this._getOrgAutoExpireDays(orgId);
    if (expDays && expDays > 0) {
      expiresAt = new Date(Date.now() + expDays * 24 * 60 * 60 * 1000);
    }

    try {
      const result = await db.query(
        `INSERT INTO agent_proposals
           (org_id, user_id, deal_id, contact_id, account_id, action_id,
            proposal_type, status, payload, reasoning, confidence,
            source, source_context, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12,$13,NOW(),NOW())
         RETURNING *`,
        [
          orgId, userId, dealId || null, contactId || null, accountId || null, actionId || null,
          proposalType, JSON.stringify(payload), reasoning || null,
          confidence || null, source,
          sourceContext ? JSON.stringify(sourceContext) : null,
          expiresAt,
        ]
      );

      const proposal = result.rows[0];
      console.log(`🤖 Agent proposal created: ${proposalType} for deal ${dealId || 'N/A'} (id: ${proposal.id})`);
      return { success: true, proposal };
    } catch (err) {
      console.error('AgentProposalService.createProposal error:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── Approve ────────────────────────────────────────────────────────────────

  static async approve(proposalId, reviewerId, modifiedPayload = null) {
    try {
      // If payload was modified, store original for audit
      let updateClause = `
        status = 'approved', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()`;
      const params = [proposalId, reviewerId];

      if (modifiedPayload) {
        updateClause += `,
          original_payload = payload,
          payload = $3`;
        params.push(JSON.stringify(modifiedPayload));
      }

      const orgGuard = ` AND org_id = (SELECT org_id FROM agent_proposals WHERE id = $1)`;

      const result = await db.query(
        `UPDATE agent_proposals
         SET ${updateClause}
         WHERE id = $1 AND status = 'pending'${orgGuard}
         RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'Proposal not found or not in pending state' };
      }

      return { success: true, proposal: result.rows[0] };
    } catch (err) {
      console.error('AgentProposalService.approve error:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── Reject ─────────────────────────────────────────────────────────────────

  static async reject(proposalId, reviewerId, reason = null) {
    try {
      const result = await db.query(
        `UPDATE agent_proposals
         SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(),
             rejection_reason = $3, updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [proposalId, reviewerId, reason]
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'Proposal not found or not in pending state' };
      }

      return { success: true, proposal: result.rows[0] };
    } catch (err) {
      console.error('AgentProposalService.reject error:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── Bulk operations ────────────────────────────────────────────────────────

  static async bulkApprove(proposalIds, reviewerId, orgId) {
    if (!proposalIds?.length) return { success: true, count: 0 };
    try {
      const result = await db.query(
        `UPDATE agent_proposals
         SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1::int[]) AND org_id = $3 AND status = 'pending'
         RETURNING id`,
        [proposalIds, reviewerId, orgId]
      );
      return { success: true, count: result.rows.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  static async bulkReject(proposalIds, reviewerId, orgId, reason = null) {
    if (!proposalIds?.length) return { success: true, count: 0 };
    try {
      const result = await db.query(
        `UPDATE agent_proposals
         SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(),
             rejection_reason = $3, updated_at = NOW()
         WHERE id = ANY($1::int[]) AND org_id = $4 AND status = 'pending'
         RETURNING id`,
        [proposalIds, reviewerId, reason, orgId]
      );
      return { success: true, count: result.rows.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Mark executing / executed / failed ─────────────────────────────────────

  static async markExecuting(proposalId) {
    const result = await db.query(
      `UPDATE agent_proposals SET status = 'executing', updated_at = NOW()
       WHERE id = $1 AND status = 'approved' RETURNING *`,
      [proposalId]
    );
    return result.rows[0] || null;
  }

  static async markExecuted(proposalId, executionResult) {
    const result = await db.query(
      `UPDATE agent_proposals
       SET status = 'executed', executed_at = NOW(),
           execution_result = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [proposalId, JSON.stringify(executionResult)]
    );
    return result.rows[0] || null;
  }

  static async markFailed(proposalId, errorMessage) {
    const result = await db.query(
      `UPDATE agent_proposals
       SET status = 'failed', error_message = $2,
           retry_count = retry_count + 1, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [proposalId, errorMessage]
    );
    return result.rows[0] || null;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  static async getPendingForUser(userId, orgId, filters = {}) {
    let query = `
      SELECT ap.*,
             d.name AS deal_name, d.value AS deal_value, d.stage AS deal_stage,
             d.health AS deal_health, d.close_date AS deal_close_date,
             c.first_name AS contact_first_name, c.last_name AS contact_last_name,
             c.email AS contact_email,
             acc.name AS account_name
      FROM agent_proposals ap
      LEFT JOIN deals d      ON ap.deal_id    = d.id    AND d.org_id = ap.org_id
      LEFT JOIN contacts c   ON ap.contact_id = c.id    AND c.org_id = ap.org_id
      LEFT JOIN accounts acc ON ap.account_id = acc.id  AND acc.org_id = ap.org_id
      WHERE ap.org_id = $1 AND ap.user_id = $2`;

    const params = [orgId, userId];

    if (filters.status) {
      params.push(filters.status);
      query += ` AND ap.status = $${params.length}`;
    } else {
      query += ` AND ap.status = 'pending'`;
    }

    if (filters.proposalType) {
      params.push(filters.proposalType);
      query += ` AND ap.proposal_type = $${params.length}`;
    }

    if (filters.dealId) {
      params.push(parseInt(filters.dealId));
      query += ` AND ap.deal_id = $${params.length}`;
    }

    // Fetch all, then compute priority in-memory and sort
    query += ` ORDER BY ap.created_at DESC`;

    if (filters.limit) {
      // Fetch extra so we can re-sort by priority before limiting
      params.push(parseInt(filters.limit) * 3);
      query += ` LIMIT $${params.length}`;
    }

    const result = await db.query(query, params);

    // Attach computed priority_score to each row
    const rows = result.rows.map(row => ({
      ...row,
      priority_score: computePriorityScore(row, row.deal_value),
    }));

    // Sort by priority_score descending
    rows.sort((a, b) => b.priority_score - a.priority_score);

    // Apply actual limit after re-sort
    if (filters.limit) {
      return rows.slice(0, parseInt(filters.limit));
    }

    return rows;
  }

  static async getById(proposalId, orgId) {
    const result = await db.query(
      `SELECT ap.*,
              d.name AS deal_name, d.value AS deal_value, d.stage AS deal_stage,
              d.health AS deal_health,
              c.first_name AS contact_first_name, c.last_name AS contact_last_name,
              c.email AS contact_email,
              acc.name AS account_name,
              rev.first_name || ' ' || rev.last_name AS reviewer_name
       FROM agent_proposals ap
       LEFT JOIN deals d      ON ap.deal_id     = d.id   AND d.org_id = ap.org_id
       LEFT JOIN contacts c   ON ap.contact_id  = c.id   AND c.org_id = ap.org_id
       LEFT JOIN accounts acc ON ap.account_id  = acc.id AND acc.org_id = ap.org_id
       LEFT JOIN users rev    ON ap.reviewed_by  = rev.id
       WHERE ap.id = $1 AND ap.org_id = $2`,
      [proposalId, orgId]
    );
    return result.rows[0] || null;
  }

  static async getPendingCount(userId, orgId) {
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM agent_proposals
       WHERE user_id = $1 AND org_id = $2 AND status = 'pending'`,
      [userId, orgId]
    );
    return parseInt(result.rows[0].count) || 0;
  }

  static async getApproved(orgId) {
    const result = await db.query(
      `SELECT * FROM agent_proposals
       WHERE org_id = $1 AND status = 'approved'
       ORDER BY reviewed_at ASC`,
      [orgId]
    );
    return result.rows;
  }

  /**
   * Get proposal history for a deal (all statuses).
   */
  static async getByDeal(dealId, orgId) {
    const result = await db.query(
      `SELECT ap.*,
              rev.first_name || ' ' || rev.last_name AS reviewer_name
       FROM agent_proposals ap
       LEFT JOIN users rev ON ap.reviewed_by = rev.id
       WHERE ap.deal_id = $1 AND ap.org_id = $2
       ORDER BY ap.created_at DESC`,
      [dealId, orgId]
    );
    return result.rows;
  }

  // ── Expiry ─────────────────────────────────────────────────────────────────

  /**
   * Expire stale proposals. Run as a cron job.
   * Returns number of expired proposals.
   */
  static async expireStale() {
    try {
      const result = await db.query(
        `UPDATE agent_proposals
         SET status = 'expired', rejection_reason = 'auto_expired', updated_at = NOW()
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()
         RETURNING id`
      );
      const count = result.rows.length;
      if (count > 0) {
        console.log(`🕐 Agent: expired ${count} stale proposals`);
      }
      return count;
    } catch (err) {
      console.error('AgentProposalService.expireStale error:', err.message);
      return 0;
    }
  }

  // ── Stats (for org admin dashboard) ────────────────────────────────────────

  static async getOrgStats(orgId, days = 30) {
    try {
      const result = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
           COUNT(*) FILTER (WHERE status = 'approved')  AS approved,
           COUNT(*) FILTER (WHERE status = 'executed')  AS executed,
           COUNT(*) FILTER (WHERE status = 'rejected')  AS rejected,
           COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
           COUNT(*) FILTER (WHERE status = 'expired')   AS expired,
           COUNT(*)                                      AS total
         FROM agent_proposals
         WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2`,
        [orgId, days]
      );
      return result.rows[0];
    } catch (err) {
      console.error('AgentProposalService.getOrgStats error:', err.message);
      return { pending: 0, approved: 0, executed: 0, rejected: 0, failed: 0, expired: 0, total: 0 };
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  static async _getOrgAutoExpireDays(orgId) {
    try {
      const result = await db.query(
        `SELECT settings FROM organizations WHERE id = $1`, [orgId]
      );
      return result.rows[0]?.settings?.agentic_auto_expire_days || 7;
    } catch { return 7; }
  }
}

module.exports = AgentProposalService;
