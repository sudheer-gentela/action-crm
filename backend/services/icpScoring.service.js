// ─────────────────────────────────────────────────────────────────────────
// icpScoring.service.js
//
// Generic, configurable ICP scoring engine.
//
// Categories and rules are fully admin-configurable via
// organizations.settings.icp_config.  The 4 original categories
// (Firmographic, Persona, Engagement, Timing) ship as defaults that
// admins can rename, disable, reweight, or delete entirely.
//
// Config shape:
//   {
//     categories: [
//       {
//         key:            "firmographic",
//         label:          "Firmographic Fit",
//         enabled:        true,
//         weight:         40,
//         baseline_score: 50,
//         rules: [
//           {
//             field:              "company_industry",
//             match_type:         "contains_any",
//             target_values:      ["SaaS","Fintech"],
//             points_if_match:    25,
//             points_if_no_match: -5,
//             points_if_empty:    -10,
//             label:              "Industry match"
//           }, ...
//         ]
//       }, ...
//     ]
//   }
//
// Match types:
//   contains_any   — prospect field value is in the target_values list (case-insensitive)
//   contains_text  — prospect field contains any target_value as substring
//   greater_than   — numeric field > target_values[0]
//   less_than      — numeric field < target_values[0]
//   exists         — field is non-null and non-empty (for booleans: truthy)
//   tag_any        — jsonb array field contains any of the target values
//
// Built-in derived rule fields (prefixed with _) require DB lookups:
//   _response_rate, _days_since_response, _days_since_created,
//   _account_has_won_deal, _account_has_lost_deal, _account_has_active_deal
// ─────────────────────────────────────────────────────────────────────────

const db = require('../config/database');

// ── Default categories (shipped as presets) ──────────────────────────────

const DEFAULT_CATEGORIES = [
  {
    key: 'firmographic',
    label: 'Firmographic Fit',
    enabled: true,
    weight: 40,
    baseline_score: 50,
    rules: [
      { field: 'company_size',     match_type: 'contains_any',  target_values: ['50-200', '200-500', '500-1000'], points_if_match: 25, points_if_no_match: -10, points_if_empty: -15, label: 'Company size' },
      { field: 'company_industry', match_type: 'contains_any',  target_values: [],                                points_if_match: 25, points_if_no_match: -5,  points_if_empty: -10, label: 'Industry' },
      { field: 'location',         match_type: 'contains_text', target_values: [],                                points_if_match: 10, points_if_no_match: 0,   points_if_empty: 0,   label: 'Geography' },
    ],
  },
  {
    key: 'persona',
    label: 'Persona Fit',
    enabled: true,
    weight: 25,
    baseline_score: 40,
    rules: [
      { field: 'title', match_type: 'contains_text', target_values: ['C-Suite', 'VP', 'Director', 'Head of'],                                         points_if_match: 30, points_if_no_match: -10, points_if_empty: -10, label: 'Seniority' },
      { field: 'title', match_type: 'contains_text', target_values: ['Sales', 'Revenue', 'Business Development', 'Growth', 'Operations'],              points_if_match: 25, points_if_no_match: 0,   points_if_empty: 0,   label: 'Function alignment' },
      { field: 'title', match_type: 'contains_text', target_values: ['CEO', 'CRO', 'CTO', 'COO', 'VP', 'SVP', 'EVP', 'Director', 'Head of'],         points_if_match: 10, points_if_no_match: 0,   points_if_empty: 0,   label: 'Decision maker' },
    ],
  },
  {
    key: 'engagement',
    label: 'Engagement Signals',
    enabled: true,
    weight: 20,
    baseline_score: 30,
    rules: [
      { field: '_response_rate',       match_type: 'greater_than', target_values: [0.3],  points_if_match: 40, points_if_no_match: 0,   points_if_empty: 20, label: 'High response rate' },
      { field: '_response_rate',       match_type: 'greater_than', target_values: [0],    points_if_match: 20, points_if_no_match: -10, points_if_empty: 0,  label: 'Any response' },
      { field: '_days_since_response', match_type: 'less_than',    target_values: [7],    points_if_match: 20, points_if_no_match: 5,   points_if_empty: 0,  label: 'Recent response' },
    ],
  },
  {
    key: 'timing',
    label: 'Timing Signals',
    enabled: true,
    weight: 15,
    baseline_score: 50,
    rules: [
      { field: '_account_has_won_deal',    match_type: 'exists', target_values: [], points_if_match: 20,  points_if_no_match: 0, points_if_empty: 0, label: 'Existing customer' },
      { field: '_account_has_lost_deal',   match_type: 'exists', target_values: [], points_if_match: -10, points_if_no_match: 0, points_if_empty: 0, label: 'Lost deal penalty' },
      { field: '_account_has_active_deal', match_type: 'exists', target_values: [], points_if_match: 10,  points_if_no_match: 0, points_if_empty: 0, label: 'Active deal bonus' },
      { field: '_days_since_created',      match_type: 'less_than',    target_values: [7],  points_if_match: 10,  points_if_no_match: 0, points_if_empty: 0, label: 'Fresh lead' },
      { field: '_days_since_created',      match_type: 'greater_than', target_values: [60], points_if_match: -10, points_if_no_match: 0, points_if_empty: 0, label: 'Aging lead penalty' },
    ],
  },
];

// ── Field & match-type metadata (exposed to admin UI) ────────────────────

const AVAILABLE_FIELDS = [
  { key: 'title',            label: 'Title',            type: 'text',    group: 'Prospect' },
  { key: 'company_size',     label: 'Company Size',     type: 'text',    group: 'Company' },
  { key: 'company_industry', label: 'Industry',         type: 'text',    group: 'Company' },
  { key: 'company_name',     label: 'Company Name',     type: 'text',    group: 'Company' },
  { key: 'company_domain',   label: 'Company Domain',   type: 'text',    group: 'Company' },
  { key: 'location',         label: 'Location',         type: 'text',    group: 'Prospect' },
  { key: 'source',           label: 'Lead Source',      type: 'text',    group: 'Prospect' },
  { key: 'tags',             label: 'Tags',             type: 'tags',    group: 'Prospect' },
  { key: 'outreach_count',   label: 'Outreach Count',   type: 'number',  group: 'Engagement' },
  { key: 'response_count',   label: 'Response Count',   type: 'number',  group: 'Engagement' },
  { key: '_response_rate',          label: 'Response Rate',          type: 'number',  group: 'Derived' },
  { key: '_days_since_response',    label: 'Days Since Response',    type: 'number',  group: 'Derived' },
  { key: '_days_since_created',     label: 'Days Since Created',     type: 'number',  group: 'Derived' },
  { key: '_account_has_won_deal',   label: 'Account Has Won Deal',   type: 'boolean', group: 'Derived' },
  { key: '_account_has_lost_deal',  label: 'Account Has Lost Deal',  type: 'boolean', group: 'Derived' },
  { key: '_account_has_active_deal',label: 'Account Has Active Deal',type: 'boolean', group: 'Derived' },
];

const MATCH_TYPES = [
  { key: 'contains_any',  label: 'Is any of',           for_types: ['text'] },
  { key: 'contains_text', label: 'Contains text',       for_types: ['text'] },
  { key: 'greater_than',  label: 'Greater than',        for_types: ['number'] },
  { key: 'less_than',     label: 'Less than',           for_types: ['number'] },
  { key: 'exists',        label: 'Has value / Is true', for_types: ['text', 'number', 'boolean', 'tags'] },
  { key: 'tag_any',       label: 'Has any tag',         for_types: ['tags'] },
];


class IcpScoringService {

  // ── Score a single prospect ──────────────────────────────────────────

  static async score(prospect, orgId) {
    const config = await this.getConfig(orgId);
    const categories = (config.categories || []).filter(c => c.enabled);

    if (categories.length === 0) {
      const breakdown = { score: 0, categories: [], scoredAt: new Date().toISOString() };
      await this._persistScore(prospect.id, 0, breakdown);
      return breakdown;
    }

    // Pre-compute derived fields once
    const derived = await this._computeDerived(prospect, orgId);

    // Score each enabled category
    const scoredCategories = [];
    for (const cat of categories) {
      scoredCategories.push(this._scoreCategory(prospect, cat, derived));
    }

    // Weighted average
    const totalWeight = scoredCategories.reduce((sum, c) => sum + c.weight, 0);
    const compositeScore = totalWeight > 0
      ? Math.round(scoredCategories.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight)
      : 0;

    const breakdown = {
      score: compositeScore,
      categories: scoredCategories,
      scoredAt: new Date().toISOString(),
    };

    await this._persistScore(prospect.id, compositeScore, breakdown);
    return breakdown;
  }

  // ── Score one category ───────────────────────────────────────────────

  static _scoreCategory(prospect, category, derived) {
    let score = category.baseline_score ?? 50;
    const signals = [];

    for (const rule of (category.rules || [])) {
      const fieldValue = this._getFieldValue(prospect, rule.field, derived);
      const result = this._evaluateRule(rule, fieldValue);
      score += result.points;
      signals.push({
        label: rule.label || rule.field,
        field: rule.field,
        match: result.match,
        points: result.points,
        detail: result.detail,
      });
    }

    return {
      key: category.key,
      label: category.label,
      weight: category.weight,
      score: clamp(score),
      signals,
    };
  }

  // ── Rule evaluator ───────────────────────────────────────────────────

  static _evaluateRule(rule, fieldValue) {
    const isEmpty = fieldValue === null || fieldValue === undefined || fieldValue === '';
    const targets = rule.target_values || [];
    const label = rule.label || rule.field;

    if (isEmpty) {
      return { match: 'empty', points: rule.points_if_empty || 0, detail: `${label}: no data` };
    }

    let matched = false;
    const strVal = String(fieldValue).toLowerCase();

    switch (rule.match_type) {
      case 'contains_any':
        matched = targets.length === 0 || targets.some(t => strVal === String(t).toLowerCase());
        break;
      case 'contains_text':
        matched = targets.length === 0 || targets.some(t => strVal.includes(String(t).toLowerCase()));
        break;
      case 'greater_than': {
        const num = parseFloat(fieldValue);
        matched = !isNaN(num) && targets.length > 0 && num > parseFloat(targets[0]);
        break;
      }
      case 'less_than': {
        const num = parseFloat(fieldValue);
        matched = !isNaN(num) && targets.length > 0 && num < parseFloat(targets[0]);
        break;
      }
      case 'exists':
        matched = !!fieldValue;
        break;
      case 'tag_any': {
        const tags = Array.isArray(fieldValue) ? fieldValue.map(t => String(t).toLowerCase()) : [];
        matched = targets.some(t => tags.includes(String(t).toLowerCase()));
        break;
      }
      default:
        matched = false;
    }

    return {
      match: matched,
      points: matched ? (rule.points_if_match || 0) : (rule.points_if_no_match || 0),
      detail: matched ? `${label}: matched` : `${label}: no match`,
    };
  }

  // ── Field value resolver ─────────────────────────────────────────────

  static _getFieldValue(prospect, field, derived) {
    if (field.startsWith('_')) return derived[field] ?? null;
    return prospect[field] ?? null;
  }

  // ── Compute derived fields ───────────────────────────────────────────

  static async _computeDerived(prospect, orgId) {
    const derived = {};

    // Response rate
    derived._response_rate = prospect.outreach_count > 0
      ? prospect.response_count / prospect.outreach_count
      : null;

    // Days since response
    derived._days_since_response = prospect.last_response_at
      ? Math.floor((Date.now() - new Date(prospect.last_response_at)) / 86400000)
      : null;

    // Days since created
    derived._days_since_created = prospect.created_at
      ? Math.floor((Date.now() - new Date(prospect.created_at)) / 86400000)
      : null;

    // Account deal status
    derived._account_has_won_deal = false;
    derived._account_has_lost_deal = false;
    derived._account_has_active_deal = false;

    if (prospect.account_id || prospect.company_domain) {
      try {
        let query, params;
        if (prospect.account_id) {
          query = `SELECT stage FROM deals WHERE account_id = $1 AND org_id = $2`;
          params = [prospect.account_id, orgId];
        } else {
          query = `SELECT d.stage FROM deals d
                   JOIN accounts a ON d.account_id = a.id
                   WHERE a.org_id = $1 AND LOWER(a.domain) = LOWER($2)`;
          params = [orgId, prospect.company_domain];
        }
        const r = await db.query(query, params);
        const stages = r.rows.map(d => d.stage);
        derived._account_has_won_deal = stages.includes('closed_won');
        derived._account_has_lost_deal = stages.includes('closed_lost');
        derived._account_has_active_deal = stages.some(s => !['closed_won', 'closed_lost'].includes(s));
      } catch (err) {
        console.error('ICP derived fields — deal lookup error:', err.message);
      }
    }

    return derived;
  }

  // ── Bulk scoring ─────────────────────────────────────────────────────

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

  // ── Config management ────────────────────────────────────────────────

  static async getConfig(orgId) {
    try {
      const r = await db.query(
        `SELECT settings->'icp_config' AS icp_config FROM organizations WHERE id = $1`,
        [orgId]
      );
      const config = r.rows[0]?.icp_config;
      if (config && typeof config === 'object') {
        if (Array.isArray(config.categories) && config.categories.length > 0) {
          return config;
        }
        // Legacy flat config — migrate on read
        if (config.weights && !config.categories) {
          return this._migrateLegacyConfig(config);
        }
      }
    } catch (err) {
      console.error('IcpScoringService.getConfig error:', err.message);
    }
    return { categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)) };
  }

  static async saveConfig(orgId, config) {
    if (!config.categories || !Array.isArray(config.categories)) {
      throw new Error('config.categories must be an array');
    }
    for (const cat of config.categories) {
      if (!cat.key || !cat.label) throw new Error('Each category must have a key and label');
      if (typeof cat.weight !== 'number' || cat.weight < 0) throw new Error(`Invalid weight for "${cat.label}"`);
    }

    await db.query(
      `UPDATE organizations
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{icp_config}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(config), orgId]
    );
    return config;
  }

  static getFieldDefinitions() {
    return { fields: AVAILABLE_FIELDS, matchTypes: MATCH_TYPES };
  }

  static getDefaultCategories() {
    return JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  }

  // ── Legacy config migration ──────────────────────────────────────────

  static _migrateLegacyConfig(old) {
    const categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));

    if (old.weights) {
      for (const cat of categories) {
        if (old.weights[cat.key] !== undefined) cat.weight = old.weights[cat.key];
      }
    }

    const firmo = categories.find(c => c.key === 'firmographic');
    if (firmo) {
      const sizeRule = firmo.rules.find(r => r.field === 'company_size');
      if (sizeRule && Array.isArray(old.target_company_sizes)) sizeRule.target_values = old.target_company_sizes;
      const indRule = firmo.rules.find(r => r.field === 'company_industry');
      if (indRule && Array.isArray(old.target_industries)) indRule.target_values = old.target_industries;
      const geoRule = firmo.rules.find(r => r.field === 'location');
      if (geoRule && Array.isArray(old.target_geographies)) geoRule.target_values = old.target_geographies;
    }

    const persona = categories.find(c => c.key === 'persona');
    if (persona) {
      const senRule = persona.rules.find(r => r.label === 'Seniority');
      if (senRule && Array.isArray(old.target_seniority)) senRule.target_values = old.target_seniority;
      const funcRule = persona.rules.find(r => r.label === 'Function alignment');
      if (funcRule && Array.isArray(old.target_functions)) funcRule.target_values = old.target_functions;
      const dmRule = persona.rules.find(r => r.label === 'Decision maker');
      if (dmRule && Array.isArray(old.decision_maker_titles)) dmRule.target_values = old.decision_maker_titles;
    }

    const eng = categories.find(c => c.key === 'engagement');
    if (eng) {
      const rrRule = eng.rules.find(r => r.label === 'High response rate');
      if (rrRule && old.high_response_rate) rrRule.target_values = [old.high_response_rate];
      const recRule = eng.rules.find(r => r.label === 'Recent response');
      if (recRule && old.recent_response_days) recRule.target_values = [old.recent_response_days];
    }

    const timing = categories.find(c => c.key === 'timing');
    if (timing) {
      const wonRule = timing.rules.find(r => r.label === 'Existing customer');
      if (wonRule && old.existing_customer_bonus) wonRule.points_if_match = old.existing_customer_bonus;
      const lostRule = timing.rules.find(r => r.label === 'Lost deal penalty');
      if (lostRule && old.lost_deal_penalty) lostRule.points_if_match = old.lost_deal_penalty;
    }

    return { categories };
  }

  // ── Persistence ──────────────────────────────────────────────────────

  static async _persistScore(prospectId, score, breakdown) {
    await db.query(
      `UPDATE prospects
       SET icp_score = $1, icp_signals = $2, updated_at = NOW()
       WHERE id = $3`,
      [score, JSON.stringify(breakdown), prospectId]
    );
  }
}

function clamp(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = IcpScoringService;
