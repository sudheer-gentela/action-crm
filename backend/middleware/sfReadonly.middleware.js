/**
 * sfReadonly.middleware.js
 *
 * DROP-IN LOCATION: backend/middleware/sfReadonly.middleware.js
 *
 * Field locking middleware for sf_primary sync mode.
 * When an org has Salesforce connected in sf_primary mode, GoWarm fields
 * that originate from Salesforce become read-only via the API.
 *
 * Usage — add to any route that updates SF-managed entities:
 *   router.patch('/:id', sfReadonly('deal', SF_LOCKED_FIELDS.deal), async (req, res) => { ... });
 *
 * Enforcement is two-layer:
 *   1. This middleware rejects PATCH/PUT attempts on locked fields (API layer)
 *   2. Frontend components check sfLockedFields prop and disable inputs (UI layer)
 *
 * Fields that are NEVER locked (GoWarm-owned regardless of sync mode):
 *   - playbook_id, playbook_stage, actions, plays, straps
 *   - tags, research_notes, internal notes
 *   - icp_score, icp_signals (GoWarm-generated)
 */

const { pool } = require('../config/database');

// Fields locked per entity when sf_primary mode is active
// These are the GoWarm column names that correspond to SF-managed fields
const SF_LOCKED_FIELDS = {
  deal: ['stage', 'value', 'expected_close_date', 'probability', 'name'],
  contact: ['first_name', 'last_name', 'email', 'phone', 'title', 'location', 'linkedin_url'],
  account: ['name', 'domain', 'industry', 'size', 'location', 'description'],
  prospect: ['first_name', 'last_name', 'email', 'phone', 'title', 'company_name', 'company_domain', 'company_industry'],
};

// Cache org integration settings per request cycle (10 second TTL)
const _cache = new Map();

async function _getOrgSyncMode(orgId) {
  const cacheKey = `sf_mode_${orgId}`;
  const cached   = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10000) return cached.mode;

  const res = await pool.query(
    `SELECT settings->>'sf_sync_mode' AS mode FROM org_integrations WHERE org_id = $1 AND provider = 'salesforce'`,
    [orgId]
  );
  const mode = res.rows[0]?.mode || null;
  _cache.set(cacheKey, { mode, ts: Date.now() });
  return mode;
}

/**
 * Middleware factory.
 *
 * @param {string}   entityType  - 'deal' | 'contact' | 'account' | 'prospect'
 * @param {string[]} lockedFields - Fields that cannot be updated in sf_primary mode.
 *                                  Defaults to SF_LOCKED_FIELDS[entityType].
 */
function sfReadonly(entityType, lockedFields) {
  const fields = lockedFields || SF_LOCKED_FIELDS[entityType] || [];

  return async (req, res, next) => {
    // Only applies to write operations
    if (!['PATCH', 'PUT', 'POST'].includes(req.method)) return next();
    if (!req.orgId) return next();
    if (fields.length === 0) return next();

    try {
      const mode = await _getOrgSyncMode(req.orgId);

      // sf_primary: GoWarm is read-only for SF-managed fields
      if (mode === 'sf_primary') {
        const body = req.body || {};
        const attemptedLockedFields = fields.filter(f => f in body && body[f] !== undefined);

        if (attemptedLockedFields.length > 0) {
          return res.status(403).json({
            success:  false,
            error:    'field_locked_by_integration',
            source:   'salesforce',
            fields:   attemptedLockedFields,
            message:  `These fields are managed by Salesforce and cannot be edited directly: ${attemptedLockedFields.join(', ')}. Change them in Salesforce and they will sync to GoWarm automatically.`,
          });
        }
      }

      next();
    } catch (err) {
      // Non-blocking — if we can't check the mode, allow the request
      console.warn('sfReadonly middleware error (allowing request):', err.message);
      next();
    }
  };
}

/**
 * Helper: get the list of locked fields for a given entity and org.
 * Used by the frontend API to know which fields to disable in forms.
 * Called via GET /api/salesforce/locked-fields/:entity
 */
async function getLockedFieldsForOrg(orgId, entityType) {
  try {
    const mode = await _getOrgSyncMode(orgId);
    if (mode !== 'sf_primary') return [];
    return SF_LOCKED_FIELDS[entityType] || [];
  } catch {
    return [];
  }
}

module.exports = { sfReadonly, getLockedFieldsForOrg, SF_LOCKED_FIELDS };
