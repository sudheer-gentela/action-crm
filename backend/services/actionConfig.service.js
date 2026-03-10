/**
 * Action Config Service
 * Manages per-user per-org configuration for action generation and completion detection.
 * 
 * MULTI-ORG: getConfig and updateConfig now require (userId, orgId).
 * The action_config table has UNIQUE(user_id, org_id) so one config per user per org.
 */

const db = require('../config/database');

class ActionConfigService {

  static async getConfig(userId, orgId) {
    try {
      const result = await db.query(
        'SELECT * FROM action_config WHERE user_id = $1 AND org_id = $2',
        [userId, orgId]
      );

      if (result.rows.length === 0) {
        return this.createDefaultConfig(userId, orgId);
      }

      const row = result.rows[0];
      // Normalise ai_settings — merge stored JSONB with defaults
      row.ai_settings = this._normaliseAiSettings(row.ai_settings);
      return row;
    } catch (error) {
      console.error('❌ Error in getConfig:', error.message);
      if (error.message && error.message.includes('does not exist')) {
        return this.getDefaults();
      }
      throw error;
    }
  }

  // Returns default ai_settings structure
  static _normaliseAiSettings(stored) {
    const defaults = {
      master_enabled: true,
      modules: {
        deals:       true,
        straps:      true,
        clm:         false,
        prospecting: false,
      },
    };
    if (!stored || typeof stored !== 'object') return defaults;
    return {
      master_enabled: stored.master_enabled ?? defaults.master_enabled,
      modules: {
        deals:       stored.modules?.deals       ?? defaults.modules.deals,
        straps:      stored.modules?.straps      ?? defaults.modules.straps,
        clm:         stored.modules?.clm         ?? defaults.modules.clm,
        prospecting: stored.modules?.prospecting ?? defaults.modules.prospecting,
      },
    };
  }

  // Check if AI is enabled for a specific module
  static isAiEnabledForModule(config, moduleName) {
    const settings = this._normaliseAiSettings(config?.ai_settings);
    return settings.master_enabled && (settings.modules[moduleName] ?? false);
  }

  static async createDefaultConfig(userId, orgId) {
    try {
      const result = await db.query(
        `INSERT INTO action_config (
          user_id, org_id,
          generation_mode,
          detection_mode,
          confidence_threshold,
          auto_complete_threshold
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, org_id) DO UPDATE
          SET updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
        [userId, orgId, 'playbook', 'hybrid', 70, 95]
      );
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error creating default config:', error.message);
      throw error;
    }
  }

  static async updateConfig(userId, orgId, updates) {
    try {
      const allowed = [
        'generation_mode', 'ai_enhanced_generation',
        'generate_on_stage_change', 'generate_on_meeting_scheduled',
        'generate_on_email_next_steps', 'detection_mode',
        'confidence_threshold', 'auto_complete_threshold',
        'enable_learning', 'detect_from_emails',
        'detect_from_meetings', 'detect_from_documents',
      ];

      const setClauses = [];
      const values = [];
      let paramCount = 1;

      Object.keys(updates).forEach(key => {
        if (allowed.includes(key)) {
          setClauses.push(`${key} = $${paramCount++}`);
          values.push(updates[key]);
        }
      });

      // Handle ai_settings JSONB separately — merge rather than overwrite
      if (updates.ai_settings !== undefined) {
        setClauses.push(`ai_settings = $${paramCount++}`);
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

      if (result.rows.length === 0) {
        return this.createDefaultConfig(userId, orgId);
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error updating action config:', error);
      throw error;
    }
  }

  static async isEnabled(userId, orgId, feature) {
    const config = await this.getConfig(userId, orgId);
    return config[feature] === true;
  }

  static getDefaults() {
    return {
      generation_mode:               'playbook',
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
