/**
 * user-preferences.routes.js
 *
 * GET  /users/me/preferences   — return current user's UI prefs (merged with defaults)
 * PATCH /users/me/preferences  — deep-merge supplied keys into prefs
 *
 * Storage: user_preferences.preferences->'ui' JSONB
 * PK is (user_id, org_id) — both are required for all queries.
 *
 * Mount in server.js:
 *   app.use('/api/users/me', require('./routes/user-preferences.routes'));
 */

const express           = require('express');
const router            = express.Router();
const db                = require('../config/database');
const authenticateToken    = require('../middleware/auth.middleware');
const { orgContext }        = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── Defaults — merged at read time so new keys always have a value ─────────
const UI_PREF_DEFAULTS = {
  actions_show_sparkline:  false,
  actions_recent_windows:  ['12h', '1d', '1w'],
  // Modules the user has pinned to the main sidebar. Capped at 2.
  // Only module IDs from PINNABLE_MODULE_IDS below are accepted.
  pinned_modules:          [],
};

// Modules that are allowed to be pinned (must match orgModules keys in App.js)
const PINNABLE_MODULE_IDS = ['prospecting', 'contracts', 'handovers', 'service', 'agency'];
const PINNED_MODULES_CAP  = 4;

// ── Helper ────────────────────────────────────────────────────────────────
async function getUiPrefs(userId, orgId) {
  const { rows: [row] } = await db.query(
    `SELECT preferences->'ui' AS ui
     FROM user_preferences
     WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId]
  );
  const stored = row?.ui
    ? (typeof row.ui === 'string' ? JSON.parse(row.ui) : row.ui)
    : {};
  return { ...UI_PREF_DEFAULTS, ...stored };
}

// ── GET /users/me/preferences ─────────────────────────────────────────────
router.get('/preferences', async (req, res) => {
  try {
    const preferences = await getUiPrefs(req.user.userId, req.orgId);
    res.json({ preferences });
  } catch (error) {
    console.error('GET /users/me/preferences error:', error);
    res.status(500).json({ error: { message: 'Failed to load preferences' } });
  }
});

// ── PATCH /users/me/preferences ───────────────────────────────────────────
router.patch('/preferences', async (req, res) => {
  try {
    const allowed  = Object.keys(UI_PREF_DEFAULTS);
    const filtered = {};
    for (const key of allowed) {
      if (key in req.body) filtered[key] = req.body[key];
    }

    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: { message: 'No valid preference keys supplied' } });
    }

    // ── Validate pinned_modules ───────────────────────────────────────────
    // Must be an array of valid module IDs, no duplicates, capped at 2.
    if ('pinned_modules' in filtered) {
      const raw = filtered.pinned_modules;
      if (!Array.isArray(raw)) {
        return res.status(400).json({ error: { message: 'pinned_modules must be an array' } });
      }
      const dedup = [];
      for (const id of raw) {
        if (typeof id !== 'string')            continue;
        if (!PINNABLE_MODULE_IDS.includes(id))  continue;
        if (dedup.includes(id))                 continue;
        dedup.push(id);
      }
      if (dedup.length > PINNED_MODULES_CAP) {
        return res.status(400).json({
          error: { message: `You can pin at most ${PINNED_MODULES_CAP} modules.`, code: 'PIN_CAP_EXCEEDED' }
        });
      }
      filtered.pinned_modules = dedup;
    }

    // Upsert on composite PK (user_id, org_id) — merges only the 'ui' key
    await db.query(`
      INSERT INTO user_preferences (user_id, org_id, preferences)
      VALUES ($1, $2, jsonb_build_object('ui', $3::jsonb))
      ON CONFLICT (user_id, org_id) DO UPDATE
      SET preferences = jsonb_set(
        COALESCE(user_preferences.preferences, '{}'::jsonb),
        '{ui}',
        COALESCE(user_preferences.preferences->'ui', '{}'::jsonb) || $3::jsonb
      ),
      updated_at = CURRENT_TIMESTAMP
    `, [req.user.userId, req.orgId, JSON.stringify(filtered)]);

    const preferences = await getUiPrefs(req.user.userId, req.orgId);
    res.json({ preferences });
  } catch (error) {
    console.error('PATCH /users/me/preferences error:', error);
    res.status(500).json({ error: { message: 'Failed to save preferences' } });
  }
});


// ── Prospecting AI Preferences ────────────────────────────────────────────────
// Stored in user_preferences.preferences->'prospecting' JSONB
// Separate from 'ui' namespace to keep concerns clean.

const PROSPECTING_PREF_DEFAULTS = {
  ai_provider:     '',   // '' = use org default
  ai_model:        '',   // '' = use org default
  product_context: '',   // '' = use org default
};

async function getProspectingPrefs(userId, orgId) {
  const { rows: [row] } = await db.query(
    `SELECT preferences->'prospecting' AS prospecting
     FROM user_preferences
     WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId]
  );
  const stored = row?.prospecting
    ? (typeof row.prospecting === 'string' ? JSON.parse(row.prospecting) : row.prospecting)
    : {};
  return { ...PROSPECTING_PREF_DEFAULTS, ...stored };
}

// ── GET /users/me/preferences/prospecting ─────────────────────────────────────
router.get('/preferences/prospecting', async (req, res) => {
  try {
    const preferences = await getProspectingPrefs(req.user.userId, req.orgId);
    res.json({ preferences });
  } catch (error) {
    console.error('GET /users/me/preferences/prospecting error:', error);
    res.status(500).json({ error: { message: 'Failed to load prospecting preferences' } });
  }
});

// ── PATCH /users/me/preferences/prospecting ───────────────────────────────────
router.patch('/preferences/prospecting', async (req, res) => {
  try {
    const allowed  = Object.keys(PROSPECTING_PREF_DEFAULTS);
    const filtered = {};
    for (const key of allowed) {
      if (key in req.body) filtered[key] = req.body[key];
    }

    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: { message: 'No valid preference keys supplied' } });
    }

    await db.query(`
      INSERT INTO user_preferences (user_id, org_id, preferences)
      VALUES ($1, $2, jsonb_build_object('prospecting', $3::jsonb))
      ON CONFLICT (user_id, org_id) DO UPDATE
      SET preferences = jsonb_set(
        COALESCE(user_preferences.preferences, '{}'::jsonb),
        '{prospecting}',
        COALESCE(user_preferences.preferences->'prospecting', '{}'::jsonb) || $3::jsonb
      ),
      updated_at = CURRENT_TIMESTAMP
    `, [req.user.userId, req.orgId, JSON.stringify(filtered)]);

    const preferences = await getProspectingPrefs(req.user.userId, req.orgId);
    res.json({ preferences });
  } catch (error) {
    console.error('PATCH /users/me/preferences/prospecting error:', error);
    res.status(500).json({ error: { message: 'Failed to save prospecting preferences' } });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// LinkedIn Personalization Defaults — User Preferences (My Preferences)
// Stored in user_preferences.preferences->'personalize_linkedin' JSONB
// Separate from 'ui' and 'prospecting' namespaces to keep concerns clean.
//
// Surface B Phase 2 — bottom of the cascade above SYSTEM_DEFAULT for
// "which LinkedIn fields should the AI pull from when generating drafts."
// See services/personalizeConfig.js for the full cascade resolver.
// ─────────────────────────────────────────────────────────────────────────────

const PERSONALIZE_LINKEDIN_KEYS = [
  'current_role',
  'prior_roles',
  'recent_activity',
  'education',
  'about_headline',
];

async function getPersonalizeLinkedInPrefs(userId, orgId) {
  const { rows: [row] } = await db.query(
    `SELECT preferences->'personalize_linkedin' AS cfg
     FROM user_preferences
     WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId]
  );
  if (!row?.cfg) return null;
  const stored = typeof row.cfg === 'string' ? JSON.parse(row.cfg) : row.cfg;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  // Return only the allowed keys, coerce to boolean. Missing keys → false.
  const clean = {};
  for (const key of PERSONALIZE_LINKEDIN_KEYS) {
    clean[key] = typeof stored[key] === 'boolean' ? stored[key] : false;
  }
  return clean;
}

// ── GET /users/me/preferences/personalize-linkedin ─────────────────────────
// Returns null if the user has no preference set (i.e. they inherit from
// SYSTEM_DEFAULT). Returns a full 5-key boolean object otherwise.
router.get('/preferences/personalize-linkedin', async (req, res) => {
  try {
    const config = await getPersonalizeLinkedInPrefs(req.user.userId, req.orgId);
    res.json({ config });
  } catch (error) {
    console.error('GET /users/me/preferences/personalize-linkedin error:', error);
    res.status(500).json({ error: { message: 'Failed to load personalize preferences' } });
  }
});

// ── PATCH /users/me/preferences/personalize-linkedin ───────────────────────
// Body: { config: { current_role, prior_roles, ... } | null }
// null clears the preference (revert to SYSTEM_DEFAULT — i.e. inherit nothing).
router.patch('/preferences/personalize-linkedin', async (req, res) => {
  try {
    const { config } = req.body;

    let clean = null;
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      clean = {};
      for (const key of PERSONALIZE_LINKEDIN_KEYS) {
        clean[key] = typeof config[key] === 'boolean' ? config[key] : false;
      }
    }

    if (clean === null) {
      // Clear the preference — remove the key entirely.
      // jsonb '#-' deletes the key at the given path, so the cascade resolver
      // sees no user-level value and falls through to SYSTEM_DEFAULT.
      await db.query(`
        INSERT INTO user_preferences (user_id, org_id, preferences)
        VALUES ($1, $2, '{}'::jsonb)
        ON CONFLICT (user_id, org_id) DO UPDATE
        SET preferences = COALESCE(user_preferences.preferences, '{}'::jsonb) #- '{personalize_linkedin}',
            updated_at = CURRENT_TIMESTAMP
      `, [req.user.userId, req.orgId]);
    } else {
      // Upsert the key — same merge pattern as 'ui' and 'prospecting' above.
      await db.query(`
        INSERT INTO user_preferences (user_id, org_id, preferences)
        VALUES ($1, $2, jsonb_build_object('personalize_linkedin', $3::jsonb))
        ON CONFLICT (user_id, org_id) DO UPDATE
        SET preferences = jsonb_set(
          COALESCE(user_preferences.preferences, '{}'::jsonb),
          '{personalize_linkedin}',
          $3::jsonb
        ),
        updated_at = CURRENT_TIMESTAMP
      `, [req.user.userId, req.orgId, JSON.stringify(clean)]);
    }

    const config_out = await getPersonalizeLinkedInPrefs(req.user.userId, req.orgId);
    res.json({ config: config_out });
  } catch (error) {
    console.error('PATCH /users/me/preferences/personalize-linkedin error:', error);
    res.status(500).json({ error: { message: 'Failed to save personalize preferences' } });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Reporting — Depth Preference & Resolved Scope
//
// Three routes for the manager-reporting feature:
//   GET   /users/me/preferences/reporting — read the rep's persisted depth choice
//   PATCH /users/me/preferences/reporting — write a new depth choice
//   GET   /users/me/reporting-scope       — derive the resolved scope for this user
//
// The depth preference governs how deep into the org tree this user's
// reporting view goes by default. One of:
//   'direct' — only people who report directly to them
//   'plus1'  — direct reports + 1 more level
//   'plus2'  — direct reports + 2 more levels
//   'all'    — full subtree (unbounded depth)
//
// Default for a never-saved user: 'direct'.
// Persisted in user_preferences.preferences.reporting.depth.
//
// The /reporting-scope endpoint resolves the user IDs the viewer can see
// activity for, given a depth (defaulting to their saved preference).
// Frontend uses it to:
//   - Decide whether to render the "Reporting" nav item (hide when scope='self')
//   - Render the scope-indicator line under the page title
//   - Populate the depth selector with the current saved value
//
// See: services/ReportingScopeService.js for the resolution logic and the
// auth contract; SEQUENCE_REPORTING_DESIGN.md §4.1 for the design rationale.
// ─────────────────────────────────────────────────────────────────────────────

const ReportingScopeService = require('../services/ReportingScopeService');

// Returns the persisted reporting prefs for a user. Always returns a
// non-null object — missing keys are filled with defaults so the frontend
// doesn't need a separate "first-time" branch.
async function getReportingPrefs(userId, orgId) {
  const { rows: [row] } = await db.query(
    `SELECT preferences->'reporting' AS cfg
       FROM user_preferences
      WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId]
  );
  const stored = row?.cfg
    ? (typeof row.cfg === 'string' ? JSON.parse(row.cfg) : row.cfg)
    : {};
  return {
    depth: ReportingScopeService.normalizeDepth(stored?.depth),
  };
}

// ── GET /users/me/preferences/reporting ──────────────────────────────────────
router.get('/preferences/reporting', async (req, res) => {
  try {
    const preferences = await getReportingPrefs(req.user.userId, req.orgId);
    res.json({ preferences });
  } catch (error) {
    console.error('GET /users/me/preferences/reporting error:', error);
    res.status(500).json({ error: { message: 'Failed to load reporting preferences' } });
  }
});

// ── PATCH /users/me/preferences/reporting ────────────────────────────────────
//
// Accepts: { depth: 'direct'|'plus1'|'plus2'|'all' }
//
// Any other body keys are ignored (intentional — the reporting namespace
// may grow other prefs over time; this route doesn't gate the namespace,
// just the depth key today). An invalid depth value returns 400 rather
// than silently coercing — better UX to surface the typo than have the
// user's intended change silently fall back to 'direct'.
router.patch('/preferences/reporting', async (req, res) => {
  try {
    const filtered = {};
    if ('depth' in (req.body || {})) {
      const d = req.body.depth;
      if (!ReportingScopeService.VALID_DEPTHS.includes(d)) {
        return res.status(400).json({
          error: { message: `depth must be one of: ${ReportingScopeService.VALID_DEPTHS.join(', ')}` },
        });
      }
      filtered.depth = d;
    }

    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: { message: 'No valid preference keys supplied' } });
    }

    // Same upsert + jsonb_set pattern as the other preference namespaces.
    // The COALESCE inside jsonb_set is important: without it, attempting
    // to merge into a NULL existing namespace would itself produce NULL
    // and overwrite the whole row's preferences. With it, missing
    // namespace = {} and the merge proceeds correctly.
    await db.query(`
      INSERT INTO user_preferences (user_id, org_id, preferences)
      VALUES ($1, $2, jsonb_build_object('reporting', $3::jsonb))
      ON CONFLICT (user_id, org_id) DO UPDATE
      SET preferences = jsonb_set(
        COALESCE(user_preferences.preferences, '{}'::jsonb),
        '{reporting}',
        COALESCE(user_preferences.preferences->'reporting', '{}'::jsonb) || $3::jsonb
      ),
      updated_at = CURRENT_TIMESTAMP
    `, [req.user.userId, req.orgId, JSON.stringify(filtered)]);

    const preferences = await getReportingPrefs(req.user.userId, req.orgId);
    res.json({ preferences });
  } catch (error) {
    console.error('PATCH /users/me/preferences/reporting error:', error);
    res.status(500).json({ error: { message: 'Failed to save reporting preferences' } });
  }
});

// ── GET /users/me/reporting-scope ─────────────────────────────────────────────
//
// Derived endpoint — the resolved scope for THIS user given a depth.
// Depth precedence:
//   1. ?depth query param (must be one of VALID_DEPTHS or 400)
//   2. The user's persisted preference (from preferences.reporting.depth)
//   3. DEFAULT_DEPTH ('direct') when neither is set
//
// This endpoint is the one the frontend hits on TeamReportingView mount.
// It returns enough information to render the scope indicator AND the
// depth selector (with current value pre-filled).
//
// Cache hint: this resolves a small set of DB queries (1-2 round trips).
// Frontend should call it once per view mount, not on every interaction.
router.get('/reporting-scope', async (req, res) => {
  try {
    const depthFromQuery = req.query.depth;
    let depth;
    if (depthFromQuery !== undefined) {
      if (!ReportingScopeService.VALID_DEPTHS.includes(depthFromQuery)) {
        return res.status(400).json({
          error: { message: `depth must be one of: ${ReportingScopeService.VALID_DEPTHS.join(', ')}` },
        });
      }
      depth = depthFromQuery;
    } else {
      const prefs = await getReportingPrefs(req.user.userId, req.orgId);
      depth = prefs.depth;
    }

    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId,
      req.orgId,
      { depth }
    );

    res.json({ scope });
  } catch (error) {
    console.error('GET /users/me/reporting-scope error:', error);
    res.status(500).json({ error: { message: 'Failed to resolve reporting scope: ' + error.message } });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ADD TO: backend/routes/user-preferences.routes.js
// (or create as a new file and register in server.js)
//
// Two new routes for UserTranscriptSettings.js frontend component:
//   GET  /users/me/transcript-tools  — list rep's connected personal tools
//   PATCH /users/me/transcript-tools — connect / update / disconnect a tool
//
// Storage: oauth_tokens.webhook_config jsonb (added in Phase 1 migration)
//   Shape: { webhook_secret: string, enabled: boolean }
//
// Registration in server.js (already has):
//   app.use('/api/users/me', userPreferencesRoutes);
// So these become:
//   GET  /api/users/me/transcript-tools
//   PATCH /api/users/me/transcript-tools
// ─────────────────────────────────────────────────────────────────────────────
//
// NOTE: This is a standalone file. Add the two routes below to your existing
// user-preferences.routes.js, following the same router/auth pattern already
// in that file. The router, authenticateToken, orgContext, and pool imports
// are already present there.
// ─────────────────────────────────────────────────────────────────────────────

const PERSONAL_TRANSCRIPT_PROVIDERS = ['fireflies', 'fathom', 'zoom'];

/**
 * GET /users/me/transcript-tools
 * Returns which personal transcript tools the rep has connected.
 * Does NOT return secrets — only confirms a secret is set.
 */
router.get('/transcript-tools', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         provider,
         webhook_config->>'enabled'                          AS enabled,
         CASE WHEN webhook_config->>'webhook_secret' IS NOT NULL
                   AND webhook_config->>'webhook_secret' != ''
              THEN true ELSE false END                       AS has_secret
       FROM oauth_tokens
       WHERE user_id = $1
         AND org_id  = $2
         AND provider = ANY($3)`,
      [req.user.userId, req.orgId, PERSONAL_TRANSCRIPT_PROVIDERS],
    );

    // Shape: { fireflies: { enabled: true, hasSecret: true }, ... }
    const tools = {};
    result.rows.forEach(row => {
      tools[row.provider] = {
        enabled:   row.enabled === 'true',
        hasSecret: row.has_secret,
      };
    });

    res.json({ tools, userId: req.user.userId });
  } catch (err) {
    console.error('GET /users/me/transcript-tools error:', err);
    res.status(500).json({ error: { message: 'Failed to load transcript tools' } });
  }
});

/**
 * PATCH /users/me/transcript-tools
 * Connect, update, or disconnect a personal transcript tool.
 *
 * Body:
 *   provider        string   required
 *   enabled         boolean  required
 *   webhook_secret  string   optional — omit to keep existing
 */
router.patch('/transcript-tools', async (req, res) => {
  try {
    const { provider, enabled, webhook_secret } = req.body;

    if (!provider || !PERSONAL_TRANSCRIPT_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        error: { message: `provider must be one of: ${PERSONAL_TRANSCRIPT_PROVIDERS.join(', ')}` },
      });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: { message: 'enabled (boolean) is required' } });
    }

    // Check for existing oauth_tokens row for this provider
    const existing = await db.query(
      `SELECT id, webhook_config FROM oauth_tokens
       WHERE user_id = $1 AND org_id = $2 AND provider = $3`,
      [req.user.userId, req.orgId, provider],
    );

    // Preserve existing secret if no new one supplied
    const currentSecret = existing.rows[0]?.webhook_config?.webhook_secret || '';
    const secretToStore = (webhook_secret && webhook_secret.trim())
      ? webhook_secret.trim()
      : currentSecret;

    const newWebhookConfig = JSON.stringify({
      webhook_secret: secretToStore,
      enabled:        !!enabled,
    });

    if (existing.rows.length > 0) {
      // UPDATE webhook_config on existing oauth_tokens row
      // NOTE: access_token, refresh_token, expires_at are intentionally untouched —
      // this route only manages the webhook_config field.
      await db.query(
        `UPDATE oauth_tokens
         SET webhook_config = $1::jsonb,
             updated_at     = NOW()
         WHERE user_id = $2 AND org_id = $3 AND provider = $4`,
        [newWebhookConfig, req.user.userId, req.orgId, provider],
      );
    } else {
      // INSERT a minimal row for this provider
      // access_token is set to a placeholder since it's NOT NULL —
      // these personal notetaker rows have no OAuth flow, only a webhook secret.
      await db.query(
        `INSERT INTO oauth_tokens
           (user_id, org_id, provider, access_token, webhook_config, created_at, updated_at)
         VALUES ($1, $2, $3, 'webhook_only', $4::jsonb, NOW(), NOW())
         ON CONFLICT (user_id, provider) DO UPDATE
           SET webhook_config = $4::jsonb,
               updated_at     = NOW()`,
        [req.user.userId, req.orgId, provider, newWebhookConfig],
      );
    }

    console.log(
      `🔌 Personal transcript tool [${provider}] ${enabled ? 'connected' : 'disconnected'} ` +
      `for user ${req.user.userId} org ${req.orgId}`,
    );

    res.json({ success: true, provider, enabled });
  } catch (err) {
    console.error('PATCH /users/me/transcript-tools error:', err);
    res.status(500).json({ error: { message: 'Failed to update transcript tool' } });
  }
});




// ─────────────────────────────────────────────────────────────────────────────
// AI Token Usage — Personal (My Preferences)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /users/me/ai-usage?days=30
 */
router.get('/ai-usage', async (req, res) => {
  try {
    const TokenTrackingService = require('../services/TokenTrackingService');
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const data = await TokenTrackingService.getUserUsage(req.user.userId, req.orgId, days);
    res.json(data);
  } catch (err) {
    console.error('GET /users/me/ai-usage error:', err);
    res.status(500).json({ error: { message: 'Failed to load AI usage data' } });
  }
});

module.exports = router;
