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
 * TOKEN SEMANTICS (prompt caching, 2026_18 migration):
 *   prompt_tokens      = TOTAL input (uncached + cache reads + cache writes)
 *                        — unchanged meaning; all existing rollup queries and
 *                        the frontend usage panels keep working as-is.
 *   cache_read_tokens     = input served from the prompt cache (0.1x price)
 *   cache_creation_tokens = input written to the prompt cache (1.25x, 5m TTL)
 */

const db = require('../config/database');

// Anthropic prompt-cache pricing multipliers (applied to base input price):
//   5-minute cache writes: 1.25x   1-hour cache writes: 2x   cache reads: 0.1x
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;
const CACHE_READ_MULT     = 0.10;

// Approximate cost per token (USD), matched against the lowercased model
// string IN ORDER — first hit wins, so more specific patterns go first.
// (The old MODEL_COSTS map priced Haiku at 3.5-era rates and Opus at
// pre-4.7 rates; corrected here.)
const MODEL_COST_TABLE = [
  ['fable',    { input: 0.00001,   output: 0.00005  }],  // Fable 5:    $10 / $50 per MTok
  ['opus-4-8', { input: 0.000005,  output: 0.000025 }],  // Opus 4.8:   $5 / $25
  ['opus-4-7', { input: 0.000005,  output: 0.000025 }],  // Opus 4.7:   $5 / $25
  ['opus',     { input: 0.000015,  output: 0.000075 }],  // older Opus: $15 / $75
  ['sonnet',   { input: 0.000003,  output: 0.000015 }],  // Sonnet:     $3 / $15
  ['haiku-3',  { input: 0.0000008, output: 0.000004 }],  // Haiku 3.5:  $0.80 / $4
  ['haiku',    { input: 0.000001,  output: 0.000005 }],  // Haiku 4.5:  $1 / $5
];
const DEFAULT_COSTS = { input: 0.000001, output: 0.000005 }; // unknown → Haiku-class

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
   * @param {object} params.usage    - adapter usage object: { input_tokens (uncached),
   *                                   output_tokens, cache_read_input_tokens,
   *                                   cache_creation_input_tokens, cache_creation? }
   *                                   Legacy callers passing only
   *                                   { input_tokens, output_tokens } keep working.
   * @param {number} [params.dealId]
   * @param {number} [params.actionId]
   * @param {number} [params.proposalId]
   * @param {number} [params.emailId]
   */
  static async log(params) {
    const {
      orgId, userId, callType, model,
      provider, keySource,
      usage = {},
      dealId, actionId, proposalId, emailId,
    } = params;

    if (!orgId || !userId || !callType) return;

    // Total-input semantics: the adapters report input_tokens as UNCACHED
    // input only (matching the Anthropic API, where input_tokens counts
    // tokens after the last cache breakpoint). prompt_tokens stored here is
    // the full input so existing dashboards/rollups stay correct.
    const uncachedTokens    = usage.input_tokens  || 0;
    const cacheReadTokens   = usage.cache_read_input_tokens     || 0;
    const cacheWriteTokens  = usage.cache_creation_input_tokens || 0;
    const promptTokens      = uncachedTokens + cacheReadTokens + cacheWriteTokens;
    const completionTokens  = usage.output_tokens  || 0;
    const totalTokens       = promptTokens + completionTokens;
    const estimatedCost     = this._estimateCostFromUsage(model, usage);

    try {
      await db.query(
        `INSERT INTO ai_token_usage
           (org_id, user_id, call_type, model, provider, key_source,
            prompt_tokens, completion_tokens, total_tokens,
            cache_read_tokens, cache_creation_tokens,
            deal_id, action_id, proposal_id, email_id,
            estimated_cost_usd, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
        [
          orgId, userId, callType, model || null,
          provider || null, keySource || null,
          promptTokens, completionTokens, totalTokens,
          cacheReadTokens, cacheWriteTokens,
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

  /**
   * Back-compat alias: (model, promptTokens, completionTokens) with no cache
   * awareness. promptTokens is treated entirely as uncached input. Existing
   * callers keep working; new callers should prefer estimateCostFromUsage.
   *
   * @returns {number|null}   USD cost, or null if model is missing.
   */
  static estimateCost(model, promptTokens, completionTokens) {
    return this._estimateCostFromUsage(model, {
      input_tokens:  promptTokens,
      output_tokens: completionTokens,
    });
  }

  /**
   * Cache-aware cost estimation from a full adapter usage object.
   *
   * @param {string} model
   * @param {object} usage  { input_tokens, output_tokens,
   *                          cache_read_input_tokens, cache_creation_input_tokens,
   *                          cache_creation? }
   * @returns {number|null} USD cost, or null if model is missing.
   */
  static estimateCostFromUsage(model, usage) {
    return this._estimateCostFromUsage(model, usage);
  }

  static _ratesFor(model) {
    const modelLower = String(model).toLowerCase();
    for (const [pattern, rates] of MODEL_COST_TABLE) {
      if (modelLower.includes(pattern)) return rates;
    }
    return DEFAULT_COSTS;
  }

  static _estimateCostFromUsage(model, usage = {}) {
    if (!model) return null;
    const costs = this._ratesFor(model);

    const uncached = usage.input_tokens  || 0;
    const output   = usage.output_tokens || 0;
    const read     = usage.cache_read_input_tokens     || 0;
    const writeAll = usage.cache_creation_input_tokens || 0;

    // Prefer the 5m/1h breakdown when the API provides it (mixed-TTL
    // requests); otherwise treat all writes as 5-minute writes.
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
    const write5m = usage.cache_creation?.ephemeral_5m_input_tokens
      ?? Math.max(writeAll - write1h, 0);

    const cost =
      uncached * costs.input +
      write5m  * costs.input * CACHE_WRITE_5M_MULT +
      write1h  * costs.input * CACHE_WRITE_1H_MULT +
      read     * costs.input * CACHE_READ_MULT +
      output   * costs.output;

    return parseFloat(cost.toFixed(6));
  }
}

module.exports = TokenTrackingService;
