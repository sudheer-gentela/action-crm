// ─────────────────────────────────────────────────────────────────────────────
// services/activityReportConfig.js
// ─────────────────────────────────────────────────────────────────────────────
// Roll-up definitions for the Activity reporting tab.
//
// A "definition" names which action-state atoms form the numerator and
// denominator of the completion metric. The API returns raw atoms only;
// all rate arithmetic happens client-side — definitions are how a chosen
// formula persists.
//
// Resolution order (client-side): user's active definition → org default →
// SYSTEM_DEFAULT. This service owns storage + validation of the first two.
//
// Storage:
//   • Org default  → org_action_config.activity_report (JSONB), same
//     INSERT … ON CONFLICT (org_id) pattern as linkedin_automation.
//   • User-saved   → user_preferences.preferences.activity_report:
//       { active: <name|null>, definitions: { <name>: {numerator, denominator} } }
//     Same jsonb_set slot pattern as the 'notifications' key
//     (see notificationService.setUserNotificationPrefs).
//
// The seven states are derived in routes/reporting.routes.js from
// status + completed_at/completed_by + auto_completed on both action tables
// (deals now use canonical 'not_started'; prospecting still uses 'pending'). Keep VALID_STATES in
// lockstep with that CASE expression.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const VALID_STATES = Object.freeze([
  'pending', 'in_progress', 'snoozed', 'skipped', 'failed',
  'rep_completed', 'auto_cleared',
]);

// Execution rate: rep-completed ÷ (everything except auto-cleared).
// Auto-cleared excluded from both sides — the engine closing an action is
// neither rep credit nor rep fault (agreed 2026-07-09).
const SYSTEM_DEFAULT = Object.freeze({
  numerator:   ['rep_completed'],
  denominator: ['pending', 'in_progress', 'snoozed', 'skipped', 'failed', 'rep_completed'],
});

const MAX_USER_DEFINITIONS = 10;
const MAX_NAME_LENGTH      = 40;

/**
 * Validate a {numerator, denominator} definition.
 * Throws with a caller-facing message on any problem.
 * Deliberately does NOT require numerator ⊆ denominator — formulas like
 * "auto-cleared ÷ generated" are legitimate. Only bucket names are policed.
 */
function validateDefinition(def) {
  if (!def || typeof def !== 'object') {
    throw new Error('definition must be an object { numerator, denominator }');
  }
  for (const side of ['numerator', 'denominator']) {
    const arr = def[side];
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(`definition.${side} must be a non-empty array of states`);
    }
    const seen = new Set();
    for (const s of arr) {
      if (!VALID_STATES.includes(s)) {
        throw new Error(`definition.${side} contains unknown state '${s}'. Valid: ${VALID_STATES.join(', ')}`);
      }
      if (seen.has(s)) throw new Error(`definition.${side} repeats state '${s}'`);
      seen.add(s);
    }
  }
  return { numerator: [...def.numerator], denominator: [...def.denominator] };
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}

// ─── Org default ─────────────────────────────────────────────────────────────

async function getOrgDefault(orgId) {
  const r = await pool.query(
    `SELECT activity_report FROM org_action_config WHERE org_id = $1`,
    [orgId]
  );
  const stored = r.rows[0]?.activity_report?.definition;
  if (stored) {
    try { return { definition: validateDefinition(stored), source: 'org' }; }
    catch (e) { /* corrupt config → fall back rather than break the tab */ }
  }
  return { definition: { ...SYSTEM_DEFAULT }, source: 'system' };
}

async function setOrgDefault(orgId, definition, updatedBy) {
  const clean = validateDefinition(definition);
  const payload = {
    definition: clean,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO org_action_config (org_id, activity_report, updated_at, updated_by)
          VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP, $3)
     ON CONFLICT (org_id) DO UPDATE
         SET activity_report = $2::jsonb,
             updated_at      = CURRENT_TIMESTAMP,
             updated_by      = $3`,
    [orgId, JSON.stringify(payload), updatedBy]
  );
  return { definition: clean, source: 'org' };
}

// ─── User definitions ────────────────────────────────────────────────────────

const EMPTY_USER_STATE = Object.freeze({ active: null, definitions: {} });

async function getUserState(userId, orgId) {
  const r = await pool.query(
    `SELECT preferences->'activity_report' AS ar
       FROM user_preferences WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId]
  );
  const raw = r.rows[0]?.ar;
  if (!raw || typeof raw !== 'object') return { ...EMPTY_USER_STATE };

  // Sanitize on read: drop any stored definition that no longer validates
  // (e.g. a state renamed in a future version), and clear a dangling active.
  const definitions = {};
  for (const [name, def] of Object.entries(raw.definitions || {})) {
    try { definitions[name] = validateDefinition(def); } catch (e) { /* drop */ }
  }
  const active = (typeof raw.active === 'string' && definitions[raw.active])
    ? raw.active : null;
  return { active, definitions };
}

async function _writeUserState(userId, orgId, state) {
  await pool.query(
    `INSERT INTO user_preferences (user_id, org_id, preferences)
          VALUES ($1, $2, jsonb_build_object('activity_report', $3::jsonb))
     ON CONFLICT (user_id, org_id) DO UPDATE
         SET preferences = jsonb_set(
               COALESCE(user_preferences.preferences, '{}'::jsonb),
               '{activity_report}',
               $3::jsonb
             ),
             updated_at = CURRENT_TIMESTAMP`,
    [userId, orgId, JSON.stringify(state)]
  );
  return state;
}

/** Save (create or overwrite) a named definition; optionally make it active. */
async function saveUserDefinition(userId, orgId, name, definition, { makeActive = true } = {}) {
  const cleanName = validateName(name);
  const cleanDef  = validateDefinition(definition);
  const state = await getUserState(userId, orgId);
  const isNew = !state.definitions[cleanName];
  if (isNew && Object.keys(state.definitions).length >= MAX_USER_DEFINITIONS) {
    throw new Error(`You can save up to ${MAX_USER_DEFINITIONS} definitions. Delete one first.`);
  }
  state.definitions[cleanName] = cleanDef;
  if (makeActive) state.active = cleanName;
  return _writeUserState(userId, orgId, state);
}

async function deleteUserDefinition(userId, orgId, name) {
  const state = await getUserState(userId, orgId);
  if (!state.definitions[name]) throw new Error(`No saved definition named '${name}'`);
  delete state.definitions[name];
  if (state.active === name) state.active = null;   // fall back to org default
  return _writeUserState(userId, orgId, state);
}

/** Set which definition is active. name=null → follow org default. */
async function setActiveDefinition(userId, orgId, name) {
  const state = await getUserState(userId, orgId);
  if (name !== null && !state.definitions[name]) {
    throw new Error(`No saved definition named '${name}'`);
  }
  state.active = name;
  return _writeUserState(userId, orgId, state);
}

module.exports = {
  VALID_STATES,
  SYSTEM_DEFAULT,
  MAX_USER_DEFINITIONS,
  validateDefinition,
  getOrgDefault,
  setOrgDefault,
  getUserState,
  saveUserDefinition,
  deleteUserDefinition,
  setActiveDefinition,
};
