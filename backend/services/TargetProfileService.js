/**
 * services/TargetProfileService.js
 *
 * DROP-IN LOCATION: backend/services/TargetProfileService.js
 *
 * The org-shared TARGET PROFILES library (target_profiles) — Phase 3 of
 * Signal-Based Campaigns (D3/D4). A Target Profile is a reusable,
 * function-tagged Target Criteria set; a campaign STARTS FROM one.
 *
 * TEMPLATE, NOT LIVE LINK: applyToCampaign() COPIES a profile's criteria into
 * the campaign's targeting override at creation. Editing a profile later never
 * mutates campaigns already built from it — matching the copy-at-creation
 * semantics the config cascade already uses for other campaign overrides, and
 * avoiding the "someone edited the shared profile and silently changed 40
 * running campaigns" foot-gun.
 *
 * Criteria are validated through prospectingConfigSchema.cleanTargeting — the
 * SAME sanitizer the campaign config uses — so a profile's stored criteria and
 * a campaign's targeting override are guaranteed shape-identical. Signal
 * existence is NOT checked here (shape-only, like the config sanitizer); a
 * profile can reference a signal before it's catalogued.
 *
 * Org-shared (D10): every row is org-scoped; created_by ⇒ "rep-added".
 * No RLS — every query passes org_id explicitly. All methods accept an
 * optional `client` (pg client) for caller transactions.
 */

const { pool } = require('../config/database');
const { cleanTargeting } = require('../config/prospectingConfigSchema');

// snake_case-ish function keys (mirrors FunctionTaxonomyService).
const FUNCTION_KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;

function cleanFunctionTags(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const x of v) {
    const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
    if (!s || !FUNCTION_KEY_RE.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function rowToProfile(row) {
  if (!row) return null;
  const criteria = row.criteria && typeof row.criteria === 'object'
    ? row.criteria
    : { filters: [], prioritizers: [] };
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    functionTags: Array.isArray(row.function_tags) ? row.function_tags : [],
    criteria,
    createdBy: row.created_by,
    repAdded: row.created_by != null,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a Target Profile.
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {string}  opts.name
 * @param {string} [opts.description]
 * @param {string[]} [opts.functionTags=[]]  - [] = Any (D6)
 * @param {object} [opts.criteria]            - {filters,prioritizers}; sanitized
 * @param {number} [opts.createdBy]           - user id ⇒ "rep-added"
 * @param {object} [opts.client]
 */
async function createProfile({ orgId, name, description = null, functionTags = [], criteria = null, createdBy = null, client }) {
  if (!orgId) throw new Error('TargetProfileService.createProfile: orgId is required');
  if (typeof name !== 'string' || !name.trim()) throw new Error('profile name is required');

  const exec = client || pool;
  const cleanedCriteria = cleanTargeting(criteria);
  const tags = cleanFunctionTags(functionTags);

  const { rows } = await exec.query(
    `
    INSERT INTO target_profiles (org_id, name, description, function_tags, criteria, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
    `,
    [orgId, name.trim(), description, JSON.stringify(tags), JSON.stringify(cleanedCriteria), createdBy]
  ).catch((err) => {
    // Unique (org_id, lower(name)) WHERE active.
    if (err && err.code === '23505') {
      throw new Error(`a target profile named "${name.trim()}" already exists in this org`);
    }
    throw err;
  });

  return rowToProfile(rows[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List profiles. Optional functionTag filter (tag match OR tags=[]=Any).
 * Inactive excluded unless includeInactive.
 */
async function listProfiles({ orgId, functionTag = null, includeInactive = false, client } = {}) {
  if (!orgId) throw new Error('TargetProfileService.listProfiles: orgId is required');
  const exec = client || pool;

  const where = ['org_id = $1'];
  const params = [orgId];
  if (!includeInactive) where.push('active = true');
  if (functionTag) {
    params.push(JSON.stringify([functionTag]));
    where.push(`(function_tags = '[]'::jsonb OR function_tags @> $${params.length}::jsonb)`);
  }

  const { rows } = await exec.query(
    `SELECT * FROM target_profiles WHERE ${where.join(' AND ')} ORDER BY name ASC`,
    params
  );
  return rows.map(rowToProfile);
}

/** One profile by id (null if absent / other org). */
async function getProfile({ orgId, id, client }) {
  if (!orgId || !id) throw new Error('TargetProfileService.getProfile: orgId and id are required');
  const exec = client || pool;
  const { rows } = await exec.query(
    'SELECT * FROM target_profiles WHERE org_id = $1 AND id = $2',
    [orgId, id]
  );
  return rowToProfile(rows[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Update / retire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patch a profile. Only provided fields change. Criteria are re-sanitized.
 * Editing a profile does NOT touch campaigns built from it (template model).
 */
async function updateProfile({ orgId, id, patch, client }) {
  if (!orgId || !id) throw new Error('TargetProfileService.updateProfile: orgId and id are required');
  if (!patch || typeof patch !== 'object') throw new Error('TargetProfileService.updateProfile: patch object required');
  const exec = client || pool;

  const existing = await getProfile({ orgId, id, client });
  if (!existing) throw new Error('target profile not found');

  const sets = [];
  const params = [orgId, id];

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) throw new Error('profile name cannot be empty');
    params.push(patch.name.trim());
    sets.push(`name = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
    params.push(patch.description == null ? null : String(patch.description));
    sets.push(`description = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'functionTags')) {
    params.push(JSON.stringify(cleanFunctionTags(patch.functionTags)));
    sets.push(`function_tags = $${params.length}::jsonb`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'criteria')) {
    params.push(JSON.stringify(cleanTargeting(patch.criteria)));
    sets.push(`criteria = $${params.length}::jsonb`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'active')) {
    params.push(patch.active === true);
    sets.push(`active = $${params.length}`);
  }

  if (sets.length === 0) return existing;

  const { rows } = await exec.query(
    `UPDATE target_profiles SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING *`,
    params
  ).catch((err) => {
    if (err && err.code === '23505') throw new Error('a target profile with that name already exists in this org');
    throw err;
  });
  return rowToProfile(rows[0]);
}

/** Soft-retire (profiles may have been the seed for campaigns; never hard-delete). */
async function retireProfile({ orgId, id, client }) {
  return updateProfile({ orgId, id, patch: { active: false }, client });
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply (the campaign start-from-profile seed, D4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce the targeting block a new campaign should start with, seeded from a
 * profile and optionally merged with campaign-specific overrides supplied at
 * creation. Pure w.r.t. the campaign — returns a sanitized `targeting` object
 * the caller writes into prospecting_config_override.targeting. Does NOT store
 * anything or link the campaign to the profile (template semantics).
 *
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {number}  opts.profileId       - the profile to seed from
 * @param {object} [opts.overrides]      - extra/replacement targeting merged on top
 * @param {object} [opts.client]
 * @returns {Promise<object>} sanitized { filters, prioritizers, function_key? }
 */
async function applyToCampaign({ orgId, profileId, overrides = null, client }) {
  const profile = await getProfile({ orgId, id: profileId, client });
  if (!profile) throw new Error('target profile not found');

  // Start from the profile's (already-sanitized) criteria.
  const base = profile.criteria || { filters: [], prioritizers: [] };
  if (!overrides) return cleanTargeting(base);

  // Merge overrides on top: override criteria REPLACE base ones with the same
  // (signal_key, function_key); new ones append. cleanTargeting handles the
  // final de-dupe (last-wins) once we concatenate base-then-overrides.
  const ov = cleanTargeting(overrides);
  const merged = {
    filters: [...(base.filters || []), ...(ov.filters || [])],
    prioritizers: [...(base.prioritizers || []), ...(ov.prioritizers || [])],
    function_key: ov.function_key || base.function_key,
  };
  return cleanTargeting(merged);
}

module.exports = {
  createProfile,
  listProfiles,
  getProfile,
  updateProfile,
  retireProfile,
  applyToCampaign,
  // exported for tests / reuse
  cleanFunctionTags,
  rowToProfile,
};
