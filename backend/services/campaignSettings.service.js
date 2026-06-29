/**
 * CampaignSettingsService
 *
 * Manages per-org campaign-level settings stored in
 * org_action_config.campaign_settings (JSONB).
 *
 * This follows the exact one-blob-per-domain convention already used by
 * CallSettingsService (org_action_config.call_settings) and
 * EnrichmentSettingsService (org_action_config.enrichment): a dedicated JSONB
 * column, a SYSTEM_DEFAULTS object, getForOrg() (merge over defaults, safe
 * fallback) and setForOrg() (validate + upsert with a JSONB merge).
 *
 * Settings:
 *   - owner_delete_enabled (boolean, default TRUE):
 *       The org-wide switch for the campaign-delete permission model. When
 *       TRUE, a campaign's OWNER may run the cascade delete on their own
 *       campaign (subject to the per-campaign delete_locked flag). When FALSE,
 *       only org admins/owners may cascade-delete. Admins/owners are NEVER
 *       restricted by this switch — it gates owners only.
 *
 *       ABSENT ⇒ TRUE. A fresh org with an empty '{}' blob therefore behaves
 *       as "owners may delete", matching the agreed default-ON semantics.
 *
 * Stored values merge over SYSTEM_DEFAULTS so partial configs still resolve to
 * a complete object. New keys added to SYSTEM_DEFAULTS automatically apply to
 * every org without requiring a config update.
 */

const db = require('../config/database');

// ── System-level defaults — apply when an org has no per-org override ────────
const SYSTEM_DEFAULTS = {
  owner_delete_enabled: true,
  // Prospecting ownership model: when TRUE, a manager may edit items owned by
  // their subordinates without a per-owner grant. ABSENT ⇒ FALSE (managers are
  // view-only on subordinates' items unless the owner grants access). Read by
  // services/AccessPolicy.js canEditItem.
  manager_can_edit: false,
  // Prospect cross-owner visibility: when TRUE, a rep may open the FULL detail
  // of a prospect only when its owner is within their reporting scope (self /
  // their team for a manager / all for an admin). Prospects owned outside that
  // scope return a restricted payload so the UI can show "owned by <name>,
  // another rep in your org" without leaking detail. ABSENT ⇒ FALSE ⇒ current
  // behavior: anyone in the org may open any prospect's detail (owner is
  // highlighted in the UI either way). Read by GET /prospects/:id.
  restrict_prospect_view_to_scope: false,
};

class CampaignSettingsService {

  // ── Public: get the org's effective campaign settings ─────────────────────
  // Merges stored per-org settings over SYSTEM_DEFAULTS. Always returns a
  // complete object — no missing keys. Safe to call even if the org has no
  // org_action_config row yet, or if the campaign_settings column has not been
  // created on this environment yet (returns SYSTEM_DEFAULTS).
  static async getForOrg(orgId) {
    try {
      const result = await db.query(
        'SELECT campaign_settings FROM org_action_config WHERE org_id = $1',
        [orgId]
      );
      const stored = result.rows[0]?.campaign_settings || {};
      return this._merge(stored);
    } catch (err) {
      // Column may not exist yet during the migration window — fall back to
      // defaults rather than 500ing. Deleting must keep working (owners
      // allowed by default), so the fallback is the permissive default.
      console.warn('⚠️  CampaignSettingsService.getForOrg failed:', err.message);
      return { ...SYSTEM_DEFAULTS };
    }
  }

  // ── Public: update the org's campaign settings ────────────────────────────
  // Validates the patch before writing. Unknown keys are silently dropped
  // (defense against a UI mistake polluting the JSONB blob). Throws on a
  // bad value type with a descriptive, 400-coded error.
  static async setForOrg(orgId, patch, updatedBy = null) {
    const validated = this._validatePatch(patch);

    const result = await db.query(
      `INSERT INTO org_action_config (org_id, campaign_settings, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET campaign_settings = org_action_config.campaign_settings || $2::jsonb,
             updated_at        = CURRENT_TIMESTAMP,
             updated_by        = $3
       RETURNING campaign_settings`,
      [orgId, JSON.stringify(validated), updatedBy]
    );

    return this._merge(result.rows[0]?.campaign_settings || {});
  }

  // ── Internal: merge stored over defaults ─────────────────────────────────
  static _merge(stored) {
    const safe = (stored && typeof stored === 'object') ? stored : {};
    return { ...SYSTEM_DEFAULTS, ...safe };
  }

  // ── Internal: validate a patch ───────────────────────────────────────────
  static _validatePatch(patch) {
    if (!patch || typeof patch !== 'object') {
      throw _err('patch must be an object');
    }

    const out = {};
    const ALLOWED_KEYS = new Set(Object.keys(SYSTEM_DEFAULTS));

    for (const [key, val] of Object.entries(patch)) {
      if (!ALLOWED_KEYS.has(key)) continue;  // drop unknown

      switch (key) {
        case 'owner_delete_enabled':
          if (typeof val !== 'boolean') {
            throw _err('owner_delete_enabled must be a boolean');
          }
          out[key] = val;
          break;

        case 'manager_can_edit':
          if (typeof val !== 'boolean') {
            throw _err('manager_can_edit must be a boolean');
          }
          out[key] = val;
          break;

        case 'restrict_prospect_view_to_scope':
          if (typeof val !== 'boolean') {
            throw _err('restrict_prospect_view_to_scope must be a boolean');
          }
          out[key] = val;
          break;
      }
    }

    if (Object.keys(out).length === 0) {
      throw _err('No valid fields to update');
    }
    return out;
  }
}

function _err(message) {
  const e = new Error(message);
  e.code = 'INVALID_CAMPAIGN_SETTINGS';
  e.status = 400;
  return e;
}

module.exports = CampaignSettingsService;
module.exports.SYSTEM_DEFAULTS = SYSTEM_DEFAULTS;
