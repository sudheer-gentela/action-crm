// ─────────────────────────────────────────────────────────────────────────────
// icpScoring.service.js
//
// Scores a prospect against the org's Ideal Customer Profile (ICP).
// Configuration is stored in organizations.settings.icp_config JSONB.
//
// Score categories (default weights):
//   1. Firmographic Fit   (40%) — company size, industry, geography
//   2. Persona Fit        (25%) — title seniority, function alignment
//   3. Engagement Signals (20%) — response rate, outreach engagement
//   4. Timing Signals     (15%) — account relationship, prospect recency
//
// Each category scores 0–100, then weighted into a composite 0–100 score.
// Orgs can customise: target industries, target sizes, target titles,
// category weights, and scoring thresholds.
//
// The breakdown is returned as a JSONB object and stored in prospects.icp_signals.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');

// ── Default ICP Config (used when org has no custom config) ─────────────────

const DEFAULT_ICP_CONFIG = {
  weights: {
    firmographic: 40,
    persona: 25,
    engagement: 20,
    timing: 15,
  },

  // Firmographic criteria
  target_industries: [], // empty = all industries score equally
  target_company_sizes: ['50-200', '200-500', '500-1000'], // ideal ranges
  target_geographies: [], // empty = all geographies score equally

  // Persona criteria
  target_seniority: ['C-Suite', 'VP', 'Director', 'Head of'],
  target_functions: ['Sales', 'Revenue', 'Business Development', 'Growth', 'Operations'],
  decision_maker_titles: ['CEO', 'CRO', 'CTO', 'COO', 'VP', 'SVP', 'EVP', 'Director', 'Head of'],

  // Engagement thresholds
  high_response_rate: 0.3,    // 30%+ response rate = high score
  recent_response_days: 7,    // responded within 7 days = bonus

  // Timing thresholds
  existing_customer_bonus: 20, // bonus points for existing customers
  lost_deal_penalty: -10,      // penalty for previously lost deals
};

class IcpScoringService {

  /**
   * Score a prospect against the org's ICP config.
   * @param {object} prospect — full prospect row
   * @param {number} orgId
   * @returns {Promise<{score: number, breakdown: object}>}
   */
  static async score(prospect, orgId) {
    const config = await this.getConfig(orgId);

    const firmographic = this._scoreFirmographic(prospect, config);
    const persona      = this._scorePersona(prospect, config);
    const engagement   = this._scoreEngagement(prospect, config);
    const timing       = await this._scoreTiming(prospect, orgId, config);

    const weights = config.weights || DEFAULT_ICP_CONFIG.weights;
    const totalWeight = weights.firmographic + weights.persona + weights.engagement + weights.timing;

    const compositeScore = Math.round(
      (firmographic.score * weights.firmographic +
       persona.score      * weights.persona +
       engagement.score   * weights.engagement +
       timing.score       * weights.timing) / totalWeight
    );

    const breakdown = {
      score: compositeScore,
      firmographic,
      persona,
      engagement,
      timing,
      weights,
      scoredAt: new Date().toISOString(),
    };

    // Persist the score and breakdown
    await this._persistScore(prospect.id, compositeScore, breakdown);

    return breakdown;
  }

  /**
   * Bulk score all unscored prospects in an org.
   */
  static async scoreAll(orgId) {
    const result = await db.query(
      `SELECT * FROM prospects
       WHERE org_id = $1 AND deleted_at IS NULL
         AND (icp_score IS NULL OR icp_signals = '{}'::jsonb)
       ORDER BY created_at DESC`,
      [orgId]
    );

    let scored = 0;
    for (const prospect of result.rows) {
      try {
        await this.score(prospect, orgId);
        scored++;
      } catch (err) {
        console.error(`ICP scoring failed for prospect ${prospect.id}:`, err.message);
      }
    }
    return { scored, total: result.rows.length };
  }

  /**
   * Get the org's ICP config, falling back to defaults.
   */
  static async getConfig(orgId) {
    try {
      const r = await db.query(
        `SELECT settings->'icp_config' AS icp_config FROM organizations WHERE id = $1`,
        [orgId]
      );
      const config = r.rows[0]?.icp_config;
      if (config && typeof config === 'object' && Object.keys(config).length > 0) {
        return { ...DEFAULT_ICP_CONFIG, ...config };
      }
    } catch (err) {
      console.error('IcpScoringService.getConfig error:', err.message);
    }
    return { ...DEFAULT_ICP_CONFIG };
  }

  /**
   * Save org's ICP config.
   */
  static async saveConfig(orgId, config) {
    await db.query(
      `UPDATE organizations
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{icp_config}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(config), orgId]
    );
    return config;
  }

  // ── Category Scorers ──────────────────────────────────────────────────────

  /**
   * Firmographic Fit: company size, industry, geography
   */
  static _scoreFirmographic(prospect, config) {
    let score = 50; // baseline
    const signals = [];

    // Company size match
    if (prospect.company_size) {
      const targetSizes = config.target_company_sizes || DEFAULT_ICP_CONFIG.target_company_sizes;
      if (targetSizes.length > 0) {
        if (targetSizes.includes(prospect.company_size)) {
          score += 25;
          signals.push({ factor: 'company_size', match: true, detail: `${prospect.company_size} is in target range` });
        } else {
          score -= 10;
          signals.push({ factor: 'company_size', match: false, detail: `${prospect.company_size} outside target range` });
        }
      }
    } else {
      score -= 15;
      signals.push({ factor: 'company_size', match: false, detail: 'Unknown company size' });
    }

    // Industry match
    if (prospect.company_industry) {
      const targetIndustries = (config.target_industries || []).map(i => i.toLowerCase());
      if (targetIndustries.length > 0) {
        if (targetIndustries.includes(prospect.company_industry.toLowerCase())) {
          score += 25;
          signals.push({ factor: 'industry', match: true, detail: `${prospect.company_industry} is a target industry` });
        } else {
          score -= 5;
          signals.push({ factor: 'industry', match: false, detail: `${prospect.company_industry} not in target list` });
        }
      } else {
        score += 10; // no target filter = neutral positive
      }
    } else {
      score -= 10;
      signals.push({ factor: 'industry', match: false, detail: 'Unknown industry' });
    }

    // Geography match
    if (prospect.location) {
      const targetGeos = (config.target_geographies || []).map(g => g.toLowerCase());
      if (targetGeos.length > 0) {
        const locationLower = prospect.location.toLowerCase();
        if (targetGeos.some(g => locationLower.includes(g))) {
          score += 10;
          signals.push({ factor: 'geography', match: true, detail: `${prospect.location} matches target geography` });
        }
      }
    }

    return { score: clamp(score), signals };
  }

  /**
   * Persona Fit: title seniority, function alignment
   */
  static _scorePersona(prospect, config) {
    let score = 40; // baseline
    const signals = [];
    const title = (prospect.title || '').toLowerCase();

    if (!title) {
      return { score: 30, signals: [{ factor: 'title', match: false, detail: 'No title provided' }] };
    }

    // Seniority check
    const seniorityKeywords = (config.target_seniority || DEFAULT_ICP_CONFIG.target_seniority)
      .map(s => s.toLowerCase());
    const isSenior = seniorityKeywords.some(k => title.includes(k.toLowerCase()));

    if (isSenior) {
      score += 30;
      signals.push({ factor: 'seniority', match: true, detail: `"${prospect.title}" matches target seniority` });
    } else if (title.includes('manager') || title.includes('lead')) {
      score += 10;
      signals.push({ factor: 'seniority', match: 'partial', detail: `"${prospect.title}" is mid-level` });
    } else {
      score -= 10;
      signals.push({ factor: 'seniority', match: false, detail: `"${prospect.title}" below target seniority` });
    }

    // Function alignment
    const targetFunctions = (config.target_functions || DEFAULT_ICP_CONFIG.target_functions)
      .map(f => f.toLowerCase());
    const functionMatch = targetFunctions.some(f => title.includes(f));

    if (functionMatch) {
      score += 25;
      signals.push({ factor: 'function', match: true, detail: `Title aligns with target function` });
    }

    // Decision maker check
    const dmTitles = (config.decision_maker_titles || DEFAULT_ICP_CONFIG.decision_maker_titles)
      .map(t => t.toLowerCase());
    const isDecisionMaker = dmTitles.some(t => title.includes(t));

    if (isDecisionMaker) {
      score += 10;
      signals.push({ factor: 'decision_maker', match: true, detail: 'Likely decision maker' });
    }

    return { score: clamp(score), signals };
  }

  /**
   * Engagement Signals: response rate, outreach engagement
   */
  static _scoreEngagement(prospect, config) {
    let score = 30; // baseline for no engagement
    const signals = [];

    const highResponseRate = config.high_response_rate || DEFAULT_ICP_CONFIG.high_response_rate;

    // Never contacted = neutral (not negative)
    if (prospect.outreach_count === 0) {
      return { score: 50, signals: [{ factor: 'engagement', detail: 'Not yet contacted' }] };
    }

    // Response rate
    const responseRate = prospect.response_count / prospect.outreach_count;
    if (responseRate >= highResponseRate) {
      score += 40;
      signals.push({ factor: 'response_rate', match: true, detail: `${Math.round(responseRate * 100)}% response rate (above ${Math.round(highResponseRate * 100)}% target)` });
    } else if (responseRate > 0) {
      score += 20;
      signals.push({ factor: 'response_rate', match: 'partial', detail: `${Math.round(responseRate * 100)}% response rate` });
    } else {
      score -= 10;
      signals.push({ factor: 'response_rate', match: false, detail: `0% response rate after ${prospect.outreach_count} touches` });
    }

    // Recency of response
    if (prospect.last_response_at) {
      const daysSince = Math.floor((Date.now() - new Date(prospect.last_response_at)) / 86400000);
      const recentDays = config.recent_response_days || DEFAULT_ICP_CONFIG.recent_response_days;
      if (daysSince <= recentDays) {
        score += 20;
        signals.push({ factor: 'recency', match: true, detail: `Responded ${daysSince}d ago` });
      } else {
        score += 5;
        signals.push({ factor: 'recency', match: 'partial', detail: `Last response ${daysSince}d ago` });
      }
    }

    return { score: clamp(score), signals };
  }

  /**
   * Timing Signals: account relationship, prospect recency
   */
  static async _scoreTiming(prospect, orgId, config) {
    let score = 50; // baseline
    const signals = [];

    // Check account history
    if (prospect.account_id || prospect.company_domain) {
      try {
        let dealsQuery, dealsParams;
        if (prospect.account_id) {
          dealsQuery = `SELECT stage FROM deals WHERE account_id = $1 AND org_id = $2`;
          dealsParams = [prospect.account_id, orgId];
        } else {
          dealsQuery = `SELECT d.stage FROM deals d
                        JOIN accounts a ON d.account_id = a.id
                        WHERE a.org_id = $1 AND LOWER(a.domain) = LOWER($2)`;
          dealsParams = [orgId, prospect.company_domain];
        }
        const r = await db.query(dealsQuery, dealsParams);
        const stages = r.rows.map(d => d.stage);

        if (stages.includes('closed_won')) {
          const bonus = config.existing_customer_bonus || DEFAULT_ICP_CONFIG.existing_customer_bonus;
          score += bonus;
          signals.push({ factor: 'existing_customer', match: true, detail: `Account has won deal(s) — +${bonus} bonus` });
        } else if (stages.includes('closed_lost')) {
          const penalty = config.lost_deal_penalty || DEFAULT_ICP_CONFIG.lost_deal_penalty;
          score += penalty; // negative value
          signals.push({ factor: 'lost_account', match: false, detail: `Account has lost deal(s) — ${penalty} penalty` });
        }

        if (stages.some(s => !['closed_won', 'closed_lost'].includes(s))) {
          score += 10;
          signals.push({ factor: 'active_deal', match: true, detail: 'Account has active deal(s)' });
        }
      } catch (err) {
        console.error('ICP timing score - deal lookup error:', err.message);
      }
    }

    // Prospect freshness
    if (prospect.created_at) {
      const daysSinceCreated = Math.floor((Date.now() - new Date(prospect.created_at)) / 86400000);
      if (daysSinceCreated <= 7) {
        score += 10;
        signals.push({ factor: 'freshness', match: true, detail: `Created ${daysSinceCreated}d ago — fresh lead` });
      } else if (daysSinceCreated > 60) {
        score -= 10;
        signals.push({ factor: 'freshness', match: false, detail: `Created ${daysSinceCreated}d ago — aging lead` });
      }
    }

    return { score: clamp(score), signals };
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  static async _persistScore(prospectId, score, breakdown) {
    await db.query(
      `UPDATE prospects
       SET icp_score = $1,
           icp_signals = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [score, JSON.stringify(breakdown), prospectId]
    );
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function clamp(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = IcpScoringService;
