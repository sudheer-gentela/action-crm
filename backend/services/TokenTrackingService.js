/**
 * TokenTrackingService.js
 *
 * Logs AI token usage per user, per call type, per org.
 * Called after every Anthropic API call to record consumption.
 *
 * Provides aggregation queries for:
 *   - Org admin dashboard (aggregate across org)
 *   - User settings (personal usage)
 *
 * MODEL PRICING (approximate, for cost estimation):
 *   claude-haiku-4-5:  $0.80/M input, $4.00/M output
 *   claude-sonnet-4:   $3.00/M input, $15.00/M output
 */

const db = require('../config/database');

// Approximate cost per token (USD) by model family
const MODEL_COSTS = {
  'claude-haiku':  { input: 0.0000008,  output: 0.000004 },
  'claude-sonnet': { input: 0.000003,   output: 0.000015 },
  'claude-opus':   { input: 0.000015,   output: 0.000075 },
};

// Map call_type → product module (for module-level rollups)
const MODULE_MAP = {
  action_generation:              'deals',
  ai_enhancement:                 'deals',
  email_analysis:                 'deals',
  deal_health_check:              'deals',
  context_suggest:                'deals',
  agent_proposal:                 'deals',
  prospecting_research:           'prospecting',
  prospecting_research_account:   'prospecting',
  prospecting_draft:              'prospecting',
};

const MODULE_LABELS = {
  deals:        'Deals & CRM',
  prospecting:  'Prospecting',
  other:        'Other',
};

class TokenTrackingService {

  /**
   * Log a single AI call's token usage.
   *
   * @param {object} params
   * @param {number} params.orgId
   * @param {number} params.userId
   * @param {string} params.callType - action_generation | ai_enhancement | email_analysis |
   *                                   deal_health_check | context_suggest | agent_proposal
   * @param {string} params.model    - e.g. 'claude-haiku-4-5-20251001'
   * @param {object} params.usage    - { input_tokens, output_tokens } from Anthropic response
   * @param {number} [params.dealId]
   * @param {number} [params.actionId]
   * @param {number} [params.proposalId]
   * @param {number} [params.emailId]
   */
  static async log(params) {
    const {
      orgId, userId, callType, model,
      usage = {},
      dealId, actionId, proposalId, emailId,
    } = params;

    if (!orgId || !userId || !callType) return;

    const promptTokens     = usage.input_tokens  || 0;
    const completionTokens = usage.output_tokens  || 0;
    const totalTokens      = promptTokens + completionTokens;
    const estimatedCost    = this._estimateCost(model, promptTokens, completionTokens);

    try {
      await db.query(
        `INSERT INTO ai_token_usage
           (org_id, user_id, call_type, model,
            prompt_tokens, completion_tokens, total_tokens,
            deal_id, action_id, proposal_id, email_id,
            estimated_cost_usd, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
        [
          orgId, userId, callType, model || null,
          promptTokens, completionTokens, totalTokens,
          dealId || null, actionId || null, proposalId || null, emailId || null,
          estimatedCost,
        ]
      );
    } catch (err) {
      // Non-fatal — don't crash the main flow
      console.error('TokenTrackingService.log error:', err.message);
    }
  }

  /**
   * Get aggregate token usage for an org (admin dashboard).
   * Returns daily totals for the last N days, plus per-user breakdown.
   */
  static async getOrgUsage(orgId, days = 30) {
    try {
      const [dailyRes, byUserRes, byTypeRes, totalRes, byModuleRes, byUserModuleRes] = await Promise.all([
        // Daily totals
        db.query(
          `SELECT DATE(created_at) AS day,
                  SUM(prompt_tokens)     AS prompt_tokens,
                  SUM(completion_tokens) AS completion_tokens,
                  SUM(total_tokens)      AS total_tokens,
                  SUM(estimated_cost_usd) AS estimated_cost,
                  COUNT(*)               AS call_count
           FROM ai_token_usage
           WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
           GROUP BY DATE(created_at)
           ORDER BY day DESC`,
          [orgId, days]
        ),
        // Per-user breakdown
        db.query(
          `SELECT t.user_id,
                  u.first_name || ' ' || u.last_name AS user_name,
                  u.email AS user_email,
                  SUM(t.total_tokens)      AS total_tokens,
                  SUM(t.estimated_cost_usd) AS estimated_cost,
                  COUNT(*)                 AS call_count
           FROM ai_token_usage t
           JOIN users u ON u.id = t.user_id
           WHERE t.org_id = $1 AND t.created_at >= NOW() - INTERVAL '1 day' * $2
           GROUP BY t.user_id, u.first_name, u.last_name, u.email
           ORDER BY total_tokens DESC`,
          [orgId, days]
        ),
        // Per call-type breakdown
        db.query(
          `SELECT call_type,
                  SUM(total_tokens)      AS total_tokens,
                  SUM(estimated_cost_usd) AS estimated_cost,
                  COUNT(*)               AS call_count
           FROM ai_token_usage
           WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
           GROUP BY call_type
           ORDER BY total_tokens DESC`,
          [orgId, days]
        ),
        // Grand total
        db.query(
          `SELECT SUM(total_tokens) AS total_tokens,
                  SUM(estimated_cost_usd) AS estimated_cost,
                  COUNT(*) AS call_count
           FROM ai_token_usage
           WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2`,
          [orgId, days]
        ),
        // By module (derived from call_type)
        db.query(
          `SELECT call_type,
                  SUM(total_tokens)       AS total_tokens,
                  SUM(estimated_cost_usd) AS estimated_cost,
                  COUNT(*)                AS call_count
           FROM ai_token_usage
           WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
           GROUP BY call_type`,
          [orgId, days]
        ),
        // By user + module (for per-user module breakdown)
        db.query(
          `SELECT t.user_id,
                  u.first_name || ' ' || u.last_name AS user_name,
                  t.call_type,
                  SUM(t.total_tokens)       AS total_tokens,
                  SUM(t.estimated_cost_usd) AS estimated_cost,
                  COUNT(*)                  AS call_count
           FROM ai_token_usage t
           JOIN users u ON u.id = t.user_id
           WHERE t.org_id = $1 AND t.created_at >= NOW() - INTERVAL '1 day' * $2
           GROUP BY t.user_id, u.first_name, u.last_name, t.call_type
           ORDER BY t.user_id, total_tokens DESC`,
          [orgId, days]
        ),
      ]);

      // Roll up call_type rows into module buckets
      const moduleMap = {};
      for (const row of byModuleRes.rows) {
        const mod = MODULE_MAP[row.call_type] || 'other';
        if (!moduleMap[mod]) moduleMap[mod] = { module: mod, label: MODULE_LABELS[mod] || mod, total_tokens: 0, estimated_cost: 0, call_count: 0 };
        moduleMap[mod].total_tokens    += parseInt(row.total_tokens)    || 0;
        moduleMap[mod].estimated_cost  += parseFloat(row.estimated_cost) || 0;
        moduleMap[mod].call_count      += parseInt(row.call_count)      || 0;
      }
      const byModule = Object.values(moduleMap).sort((a, b) => b.total_tokens - a.total_tokens);

      // Per-user module breakdown: { userId -> { userName, modules: { mod -> stats } } }
      const userModuleMap = {};
      for (const row of byUserModuleRes.rows) {
        if (!userModuleMap[row.user_id]) userModuleMap[row.user_id] = { user_id: row.user_id, user_name: row.user_name, modules: {} };
        const mod = MODULE_MAP[row.call_type] || 'other';
        const um  = userModuleMap[row.user_id].modules;
        if (!um[mod]) um[mod] = { module: mod, label: MODULE_LABELS[mod] || mod, total_tokens: 0, estimated_cost: 0, call_count: 0 };
        um[mod].total_tokens   += parseInt(row.total_tokens)    || 0;
        um[mod].estimated_cost += parseFloat(row.estimated_cost) || 0;
        um[mod].call_count     += parseInt(row.call_count)      || 0;
      }
      // Merge module breakdown into byUser rows
      const byUserWithModules = byUserRes.rows.map(u => ({
        ...u,
        modules: Object.values(userModuleMap[u.user_id]?.modules || {}).sort((a, b) => b.total_tokens - a.total_tokens),
      }));

      return {
        daily:   dailyRes.rows,
        byUser:  byUserWithModules,
        byType:  byTypeRes.rows,
        byModule,
        totals:  totalRes.rows[0] || { total_tokens: 0, estimated_cost: 0, call_count: 0 },
        period:  days,
      };
    } catch (err) {
      console.error('TokenTrackingService.getOrgUsage error:', err.message);
      return { daily: [], byUser: [], byType: [], totals: { total_tokens: 0, estimated_cost: 0, call_count: 0 }, period: days };
    }
  }

  /**
   * Get personal token usage for a user (Settings view).
   */
  static async getUserUsage(userId, orgId, days = 30) {
    try {
      const [dailyRes, byTypeRes, totalRes, byModuleRes] = await Promise.all([
        db.query(
          `SELECT DATE(created_at) AS day,
                  SUM(total_tokens) AS total_tokens,
                  SUM(estimated_cost_usd) AS estimated_cost,
                  COUNT(*) AS call_count
           FROM ai_token_usage
           WHERE user_id = $1 AND org_id = $2 AND created_at >= NOW() - INTERVAL '1 day' * $3
           GROUP BY DATE(created_at)
           ORDER BY day DESC`,
          [userId, orgId, days]
        ),
        db.query(
          `SELECT call_type,
                  SUM(total_tokens) AS total_tokens,
                  SUM(estimated_cost_usd) AS estimated_cost,
                  COUNT(*) AS call_count
           FROM ai_token_usage
           WHERE user_id = $1 AND org_id = $2 AND created_at >= NOW() - INTERVAL '1 day' * $3
           GROUP BY call_type
           ORDER BY total_tokens DESC`,
          [userId, orgId, days]
        ),
        db.query(
          `SELECT SUM(total_tokens) AS total_tokens,
                  SUM(estimated_cost_usd) AS estimated_cost,
                  COUNT(*) AS call_count
           FROM ai_token_usage
           WHERE user_id = $1 AND org_id = $2 AND created_at >= NOW() - INTERVAL '1 day' * $3`,
          [userId, orgId, days]
        ),
        // By module (derived from call_type)
        db.query(
          `SELECT call_type,
                  SUM(total_tokens)       AS total_tokens,
                  SUM(estimated_cost_usd) AS estimated_cost,
                  COUNT(*)                AS call_count
           FROM ai_token_usage
           WHERE user_id = $1 AND org_id = $2 AND created_at >= NOW() - INTERVAL '1 day' * $3
           GROUP BY call_type`,
          [userId, orgId, days]
        ),
      ]);

      // Roll up into module buckets
      const moduleMap = {};
      for (const row of byModuleRes.rows) {
        const mod = MODULE_MAP[row.call_type] || 'other';
        if (!moduleMap[mod]) moduleMap[mod] = { module: mod, label: MODULE_LABELS[mod] || mod, total_tokens: 0, estimated_cost: 0, call_count: 0 };
        moduleMap[mod].total_tokens   += parseInt(row.total_tokens)    || 0;
        moduleMap[mod].estimated_cost += parseFloat(row.estimated_cost) || 0;
        moduleMap[mod].call_count     += parseInt(row.call_count)      || 0;
      }
      const byModule = Object.values(moduleMap).sort((a, b) => b.total_tokens - a.total_tokens);

      return {
        daily:    dailyRes.rows,
        byType:   byTypeRes.rows,
        byModule,
        totals:   totalRes.rows[0] || { total_tokens: 0, estimated_cost: 0, call_count: 0 },
        period:   days,
      };
    } catch (err) {
      console.error('TokenTrackingService.getUserUsage error:', err.message);
      return { daily: [], byType: [], totals: { total_tokens: 0, estimated_cost: 0, call_count: 0 }, period: days };
    }
  }

  // ── Private ──────────────────────────────────────────────────

  static _estimateCost(model, promptTokens, completionTokens) {
    if (!model) return null;
    const modelLower = model.toLowerCase();
    let costs = MODEL_COSTS['claude-haiku']; // default
    if (modelLower.includes('sonnet')) costs = MODEL_COSTS['claude-sonnet'];
    else if (modelLower.includes('opus'))   costs = MODEL_COSTS['claude-opus'];

    return parseFloat(
      ((promptTokens * costs.input) + (completionTokens * costs.output)).toFixed(6)
    );
  }
}

module.exports = TokenTrackingService;
