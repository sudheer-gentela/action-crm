// ─────────────────────────────────────────────────────────────────────────────
// services/personalizeConfig.js
//
// Single source of truth for resolving the effective LinkedIn personalization
// config for a (user, sequence, step) tuple.
//
// Cascade — first non-null wins:
//   1. step.personalize_config             (most specific override)
//   2. sequence.personalize_config_default (sequence-level default)
//   3. user_preferences.preferences->'personalize_linkedin'
//                                          (rep's personal default)
//   4. SYSTEM_DEFAULT                      (all fields off)
//
// "NULL" at any level means "inherit from the next level."
// ─────────────────────────────────────────────────────────────────────────────

// Five fixed dimensions — do not add/remove without product approval.
const DIMENSIONS = [
  'current_role',     // headline + experience[0]
  'prior_roles',      // experience[1..]
  'recent_activity',  // activity array
  'education',        // education array
  'about_headline',   // about + headline together
];

const SYSTEM_DEFAULT = {
  current_role:    false,
  prior_roles:     false,
  recent_activity: false,
  education:       false,
  about_headline:  false,
};

/**
 * Coerce an arbitrary stored value to a valid 5-key boolean config object.
 * Returns null if the input is null/undefined/non-object — callers treat
 * null as "inherit from next level in cascade".
 *
 * Accepts both jsonb objects (already parsed by node-postgres) and
 * stringified jsonb (defensive — different drivers behave differently).
 */
function normalizeConfig(value) {
  if (value === null || value === undefined) return null;

  let obj = value;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const clean = {};
  for (const key of DIMENSIONS) {
    clean[key] = typeof obj[key] === 'boolean' ? obj[key] : false;
  }
  return clean;
}

/**
 * Resolve the effective personalize config for a (user, sequence, step) tuple.
 *
 * @param {object}  db                 — pg pool or client with .query()
 * @param {object}  ctx
 * @param {number}  ctx.userId         — req.user.userId
 * @param {number}  ctx.orgId          — req.orgId
 * @param {object}  [ctx.sequence]     — sequence row (must have personalize_config_default)
 * @param {object}  [ctx.step]         — step row (must have personalize_config)
 *
 * @returns {Promise<{config: object, source: string}>}
 *          config — full 5-key boolean object
 *          source — which level provided the value:
 *                   'step' | 'sequence' | 'user' | 'system'
 */
async function resolvePersonalizeConfig(db, { userId, orgId, sequence, step }) {
  // 1. Step-level override
  const stepCfg = normalizeConfig(step?.personalize_config);
  if (stepCfg) return { config: stepCfg, source: 'step' };

  // 2. Sequence-level default
  const seqCfg = normalizeConfig(sequence?.personalize_config_default);
  if (seqCfg) return { config: seqCfg, source: 'sequence' };

  // 3. User-level preference
  if (userId && orgId) {
    try {
      const r = await db.query(
        `SELECT preferences->'personalize_linkedin' AS cfg
           FROM user_preferences
          WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId]
      );
      const userCfg = normalizeConfig(r.rows[0]?.cfg);
      if (userCfg) return { config: userCfg, source: 'user' };
    } catch (err) {
      // Non-fatal — fall through to system default
      console.warn('resolvePersonalizeConfig: user pref lookup failed:', err.message);
    }
  }

  // 4. System default
  return { config: { ...SYSTEM_DEFAULT }, source: 'system' };
}

module.exports = {
  resolvePersonalizeConfig,
  normalizeConfig,
  SYSTEM_DEFAULT,
  DIMENSIONS,
};
