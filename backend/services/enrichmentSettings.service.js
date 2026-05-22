/**
 * EnrichmentSettingsService
 *
 * Manages per-org enrichment configuration in
 * org_action_config.enrichment (JSONB).
 *
 * Configurable:
 *   - chain_company: ['coresignal', 'apollo'] — order of providers tried
 *                    for account/company enrichment.
 *   - chain_person:  ['apollo'] — order for person enrichment.
 *   - monthly_cap:   integer | null — hard stop after this many credits
 *                    in the current calendar month. null = unlimited.
 *
 * Mirrors the callSettings.service.js pattern: merge stored over defaults,
 * upsert via ON CONFLICT.
 */

const db = require('../config/database');

// System-level defaults. New providers added to the available set will
// NOT automatically join an org's chain — admins explicitly opt in.
const SYSTEM_DEFAULTS = {
  chain_company: ['coresignal', 'apollo'],
  chain_person:  ['apollo'],
  monthly_cap:   null,
};

const VALID_PROVIDERS = new Set(['coresignal', 'apollo']);

class EnrichmentSettingsService {

  static async getForOrg(orgId) {
    try {
      const result = await db.query(
        'SELECT enrichment FROM org_action_config WHERE org_id = $1',
        [orgId]
      );
      const stored = result.rows[0]?.enrichment || {};
      return this._merge(stored);
    } catch (err) {
      console.warn('⚠️  EnrichmentSettingsService.getForOrg failed:', err.message);
      return { ...SYSTEM_DEFAULTS };
    }
  }

  static async setForOrg(orgId, patch, updatedBy) {
    const validated = this._validatePatch(patch);

    const result = await db.query(
      `INSERT INTO org_action_config (org_id, enrichment, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET enrichment = org_action_config.enrichment || $2::jsonb,
             updated_at = CURRENT_TIMESTAMP,
             updated_by = $3
       RETURNING enrichment`,
      [orgId, JSON.stringify(validated), updatedBy]
    );

    return this._merge(result.rows[0]?.enrichment || {});
  }

  static _merge(stored) {
    const merged = { ...SYSTEM_DEFAULTS, ...stored };
    if (!Array.isArray(merged.chain_company) || merged.chain_company.length === 0) {
      merged.chain_company = [...SYSTEM_DEFAULTS.chain_company];
    }
    if (!Array.isArray(merged.chain_person) || merged.chain_person.length === 0) {
      merged.chain_person = [...SYSTEM_DEFAULTS.chain_person];
    }
    return merged;
  }

  static _validatePatch(patch) {
    if (!patch || typeof patch !== 'object') {
      const e = new Error('patch must be an object');
      e.code = 'INVALID_ENRICHMENT_CONFIG'; e.status = 400;
      throw e;
    }

    const out = {};

    if (patch.chain_company !== undefined) {
      if (!Array.isArray(patch.chain_company)) {
        throw _err('chain_company must be an array');
      }
      for (const p of patch.chain_company) {
        if (!VALID_PROVIDERS.has(p)) {
          throw _err(`unknown provider '${p}' in chain_company; allowed: ${[...VALID_PROVIDERS].join(', ')}`);
        }
      }
      // Dedup while preserving order — first occurrence wins.
      out.chain_company = [...new Set(patch.chain_company)];
    }

    if (patch.chain_person !== undefined) {
      if (!Array.isArray(patch.chain_person)) {
        throw _err('chain_person must be an array');
      }
      for (const p of patch.chain_person) {
        if (!VALID_PROVIDERS.has(p)) {
          throw _err(`unknown provider '${p}' in chain_person; allowed: ${[...VALID_PROVIDERS].join(', ')}`);
        }
      }
      out.chain_person = [...new Set(patch.chain_person)];
    }

    if (patch.monthly_cap !== undefined) {
      if (patch.monthly_cap === null) {
        out.monthly_cap = null;
      } else if (!Number.isInteger(patch.monthly_cap) || patch.monthly_cap < 0) {
        throw _err('monthly_cap must be a non-negative integer or null');
      } else {
        out.monthly_cap = patch.monthly_cap;
      }
    }

    return out;
  }
}

function _err(message) {
  const e = new Error(message);
  e.code = 'INVALID_ENRICHMENT_CONFIG';
  e.status = 400;
  return e;
}

module.exports = EnrichmentSettingsService;
module.exports.SYSTEM_DEFAULTS  = SYSTEM_DEFAULTS;
module.exports.VALID_PROVIDERS  = VALID_PROVIDERS;
