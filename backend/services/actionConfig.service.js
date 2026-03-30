/**
 * ActionConfigService
 *
 * Manages per-user per-org configuration for action generation.
 *
 * KEY CHANGES IN THIS VERSION:
 *
 * 1. generation_mode is now a JSON array stored as text:
 *      ["playbook","rules","ai"]  — all three sources active
 *      ["playbook","rules"]       — no AI enhancement
 *      ["playbook"]               — playbook only
 *      []                         — manual (nothing auto-generates)
 *    Old string values ('hybrid','playbook','rules','manual') are normalised
 *    on read via _normaliseGenerationMode() for backward compatibility.
 *
 * 2. getConfigWithOrgDefaults(userId, orgId) — new method.
 *    Fetches org_action_config defaults and merges with user's action_config.
 *    User explicit values always win; missing user values fall back to org default;
 *    missing org values fall back to system defaults.
 *    This is the method routes should call — not bare getConfig().
 *
 * 3. getOrgDefaults(orgId) / setOrgDefaults(orgId, updates, updatedBy) — new.
 *    Read/write the org_action_config table.
 */

const db = require('../config/database');

// ── System-level defaults (lowest priority in the merge chain) ───────────────
const SYSTEM_DEFAULTS = {
  master_enabled:    true,
  modules: {
    deals:       true,
    straps:      true,
    clm:         false,
    prospecting: false,
  },
  generation_mode:   ['playbook', 'rules', 'ai'],
  ai_provider:       'anthropic',
  default_model:     'claude-haiku-4-5-20251001',
  strap_generation_mode: 'both',
  strap_ai_provider:     'anthropic',
};

class ActionConfigService {

  // ── Public: get user config merged with org defaults ─────────────────────
  // This is the method the route layer and actionsGenerator should use.
  // Returns a fully-resolved config object — no nulls for any known key.

  static async getConfigWithOrgDefaults(userId, orgId) {
    const [userRow, orgDefaults] = await Promise.all([
      this._getUserRow(userId, orgId),
      this.getOrgDefaults(orgId),
    ]);

    const userAI  = this._normaliseAiSettings(userRow?.ai_settings);
    const orgAI   = this._normaliseAiSettings(orgDefaults?.ai_settings);

    // Merge: user explicit → org default → system default
    // For each field: if the user row has an explicit value use it,
    // otherwise fall back to org, otherwise fall back to system.
    const merged = {
      // Scalar AI settings — user wins if they have an explicit (non-null) value
      master_enabled: userAI._userSet?.master_enabled
        ? userAI.master_enabled
        : (orgAI.master_enabled ?? SYSTEM_DEFAULTS.master_enabled),

      modules: {
        deals:       this._resolveModule('deals',       userAI, orgAI),
        straps:      this._resolveModule('straps',      userAI, orgAI),
        clm:         this._resolveModule('clm',         userAI, orgAI),
        prospecting: this._resolveModule('prospecting', userAI, orgAI),
      },

      generation_mode: userAI._userSet?.generation_mode
        ? userAI.generation_mode
        : (orgAI.generation_mode ?? SYSTEM_DEFAULTS.generation_mode),

      ai_provider: userAI._userSet?.ai_provider
        ? userAI.ai_provider
        : (orgAI.ai_provider ?? SYSTEM_DEFAULTS.ai_provider),

      default_model: userAI._userSet?.default_model
        ? userAI.default_model
        : (orgAI.default_model ?? SYSTEM_DEFAULTS.default_model),

      strap_generation_mode: userAI._userSet?.strap_generation_mode
        ? userAI.strap_generation_mode
        : (orgAI.strap_generation_mode ?? SYSTEM_DEFAULTS.strap_generation_mode),

      strap_ai_provider: userAI._userSet?.strap_ai_provider
        ? userAI.strap_ai_provider
        : (orgAI.strap_ai_provider ?? SYSTEM_DEFAULTS.strap_ai_provider),
    };

    // Return the full user row augmented with the resolved ai_settings
    const base = userRow || await this.createDefaultConfig(userId, orgId);
    return {
      ...base,
      ai_settings:     merged,
      // Expose org defaults so the frontend knows what to show in badges
      org_ai_settings: orgAI,
    };
  }

  // ── Public: legacy getConfig (per-user only, no org merge) ───────────────
  // Kept for backward compatibility — internal services that don't need the
  // org layer can still call this. actionsGenerator now uses getConfigWithOrgDefaults.

  static async getConfig(userId, orgId) {
    try {
      const row = await this._getUserRow(userId, orgId);
      if (!row) return this.createDefaultConfig(userId, orgId);
      row.ai_settings = this._normaliseAiSettings(row.ai_settings);
      row.generation_mode = this._normaliseGenerationMode(row.generation_mode);
      return row;
    } catch (error) {
      console.error('❌ Error in getConfig:', error.message);
      if (error.message?.includes('does not exist')) return this.getDefaults();
      throw error;
    }
  }

  // ── Public: update user config ────────────────────────────────────────────

  static async updateConfig(userId, orgId, updates) {
    try {
      const allowed = [
        'ai_enhanced_generation',
        'generate_on_stage_change', 'generate_on_meeting_scheduled',
        'generate_on_email_next_steps', 'detection_mode',
        'confidence_threshold', 'auto_complete_threshold',
        'enable_learning', 'detect_from_emails',
        'detect_from_meetings', 'detect_from_documents',
      ];

      const setClauses = [];
      const values     = [];
      let   paramCount = 1;

      Object.keys(updates).forEach(key => {
        if (allowed.includes(key)) {
          setClauses.push(`${key} = $${paramCount++}`);
          values.push(updates[key]);
        }
      });

      // generation_mode — store as JSON array string
      if (updates.generation_mode !== undefined) {
        const normalised = this._normaliseGenerationMode(updates.generation_mode);
        setClauses.push(`generation_mode = $${paramCount++}`);
        values.push(JSON.stringify(normalised));
      }

      // ai_settings JSONB — merge, never full-overwrite
      if (updates.ai_settings !== undefined) {
        setClauses.push(
          `ai_settings = COALESCE(ai_settings, '{}'::jsonb) || $${paramCount++}::jsonb`
        );
        values.push(JSON.stringify(updates.ai_settings));
      }

      if (setClauses.length === 0) throw new Error('No valid fields to update');

      values.push(userId, orgId);

      const result = await db.query(
        `UPDATE action_config
         SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $${paramCount} AND org_id = $${paramCount + 1}
         RETURNING *`,
        values
      );

      if (result.rows.length === 0) return this.createDefaultConfig(userId, orgId);

      const row = result.rows[0];
      row.ai_settings     = this._normaliseAiSettings(row.ai_settings);
      row.generation_mode = this._normaliseGenerationMode(row.generation_mode);
      return row;
    } catch (error) {
      console.error('Error updating action config:', error);
      throw error;
    }
  }

  // ── Public: org defaults ──────────────────────────────────────────────────

  static async getOrgDefaults(orgId) {
    try {
      const result = await db.query(
        'SELECT * FROM org_action_config WHERE org_id = $1',
        [orgId]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      row.ai_settings = this._normaliseAiSettings(row.ai_settings);
      return row;
    } catch (error) {
      // Table may not exist yet during migration window — fail gracefully
      console.warn('⚠️  getOrgDefaults: could not read org_action_config:', error.message);
      return null;
    }
  }

  static async setOrgDefaults(orgId, updates, updatedBy = null) {
    const allowed = ['master_enabled', 'modules', 'generation_mode',
                     'ai_provider', 'default_model',
                     'strap_generation_mode', 'strap_ai_provider'];

    const patch = {};
    for (const key of allowed) {
      if (key in updates) {
        patch[key] = key === 'generation_mode'
          ? this._normaliseGenerationMode(updates[key])
          : updates[key];
      }
    }

    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    const result = await db.query(
      `INSERT INTO org_action_config (org_id, ai_settings, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET ai_settings = org_action_config.ai_settings || $2::jsonb,
             updated_at  = CURRENT_TIMESTAMP,
             updated_by  = $3
       RETURNING *`,
      [orgId, JSON.stringify(patch), updatedBy]
    );

    const row = result.rows[0];
    row.ai_settings = this._normaliseAiSettings(row.ai_settings);
    return row;
  }

  // ── Public: module gate (used by ActionsAIEnhancer etc.) ─────────────────

  static isAiEnabledForModule(config, moduleName) {
    const settings = this._normaliseAiSettings(config?.ai_settings);
    return settings.master_enabled && (settings.modules[moduleName] ?? false);
  }

  // ── Public: generation sources helper ────────────────────────────────────
  // Returns the resolved array of active generation sources.
  // Empty array = manual mode (nothing auto-generates).

  static getGenerationSources(config) {
    const raw = config?.generation_mode ?? config?.ai_settings?.generation_mode;
    return this._normaliseGenerationMode(raw);
  }

  static isSourceEnabled(config, source) {
    return this.getGenerationSources(config).includes(source);
  }

  // ── Private: normalise generation_mode → always returns an array ─────────

  static _normaliseGenerationMode(raw) {
    if (Array.isArray(raw)) return raw;
    if (!raw) return [...SYSTEM_DEFAULTS.generation_mode];

    // Handle JSON-encoded array stored as string
    if (typeof raw === 'string' && raw.startsWith('[')) {
      try { return JSON.parse(raw); } catch (_) {}
    }

    // Map legacy string values
    switch (raw) {
      case 'hybrid':   return ['playbook', 'rules', 'ai'];
      case 'playbook': return ['playbook'];
      case 'rules':    return ['rules'];
      case 'manual':   return [];
      case 'ai':       return ['ai'];
      default:         return [...SYSTEM_DEFAULTS.generation_mode];
    }
  }

  // ── Private: normalise ai_settings ───────────────────────────────────────
  // Merges stored JSONB with system defaults so no key is ever missing.
  // Attaches a _userSet map so the merge layer knows which fields were
  // explicitly set by this user (vs. just being the default).

  static _normaliseAiSettings(stored) {
    const d = SYSTEM_DEFAULTS;

    if (!stored || typeof stored !== 'object') {
      return { ...d, modules: { ...d.modules }, generation_mode: [...d.generation_mode], _userSet: {} };
    }

    const userSet = {};
    const track   = (key, val) => { userSet[key] = true; return val; };

    return {
      master_enabled:    stored.master_enabled       !== undefined ? track('master_enabled', stored.master_enabled) : d.master_enabled,
      modules: {
        deals:       stored.modules?.deals       !== undefined ? track('deals',       stored.modules.deals)       : d.modules.deals,
        straps:      stored.modules?.straps      !== undefined ? track('straps',      stored.modules.straps)      : d.modules.straps,
        clm:         stored.modules?.clm         !== undefined ? track('clm',         stored.modules.clm)         : d.modules.clm,
        prospecting: stored.modules?.prospecting !== undefined ? track('prospecting', stored.modules.prospecting) : d.modules.prospecting,
      },
      generation_mode:       stored.generation_mode       !== undefined ? track('generation_mode',       this._normaliseGenerationMode(stored.generation_mode)) : [...d.generation_mode],
      ai_provider:           stored.ai_provider           !== undefined ? track('ai_provider',           stored.ai_provider)           : d.ai_provider,
      default_model:         stored.default_model         !== undefined ? track('default_model',         stored.default_model)         : d.default_model,
      strap_generation_mode: stored.strap_generation_mode !== undefined ? track('strap_generation_mode', stored.strap_generation_mode) : d.strap_generation_mode,
      strap_ai_provider:     stored.strap_ai_provider     !== undefined ? track('strap_ai_provider',     stored.strap_ai_provider)     : d.strap_ai_provider,
      _userSet: userSet,
    };
  }

  // ── Private: resolve a module toggle through the merge chain ─────────────

  static _resolveModule(mod, userAI, orgAI) {
    if (userAI._userSet?.[mod])       return userAI.modules[mod];
    if (orgAI.modules?.[mod] !== undefined) return orgAI.modules[mod];
    return SYSTEM_DEFAULTS.modules[mod] ?? false;
  }

  // ── Private: load user row ────────────────────────────────────────────────

  static async _getUserRow(userId, orgId) {
    const result = await db.query(
      'SELECT * FROM action_config WHERE user_id = $1 AND org_id = $2',
      [userId, orgId]
    );
    return result.rows[0] || null;
  }

  // ── createDefaultConfig ───────────────────────────────────────────────────

  static async createDefaultConfig(userId, orgId) {
    try {
      const result = await db.query(
        `INSERT INTO action_config (
           user_id, org_id,
           generation_mode, detection_mode,
           confidence_threshold, auto_complete_threshold
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, org_id) DO UPDATE
           SET updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, orgId, '["playbook","rules","ai"]', 'hybrid', 70, 95]
      );
      const row = result.rows[0];
      row.ai_settings     = this._normaliseAiSettings(row.ai_settings);
      row.generation_mode = this._normaliseGenerationMode(row.generation_mode);
      return row;
    } catch (error) {
      console.error('❌ Error creating default config:', error.message);
      throw error;
    }
  }

  static async isEnabled(userId, orgId, feature) {
    const config = await this.getConfig(userId, orgId);
    return config[feature] === true;
  }

  static getDefaults() {
    return {
      generation_mode:               ['playbook', 'rules', 'ai'],
      ai_enhanced_generation:        true,
      generate_on_stage_change:      true,
      generate_on_meeting_scheduled: false,
      generate_on_email_next_steps:  false,
      detection_mode:                'hybrid',
      confidence_threshold:          70,
      auto_complete_threshold:       95,
      enable_learning:               true,
      detect_from_emails:            true,
      detect_from_meetings:          true,
      detect_from_documents:         false,
    };
  }
}

module.exports = ActionConfigService;
