/**
 * Action Config Service
 * Manages user configuration for action generation and completion detection
 */

const db = require('../config/database');

class ActionConfigService {
  /**
   * Get user's action configuration
   */
  static async getConfig(userId) {
    console.log('🔧 ActionConfigService.getConfig called for userId:', userId);
    
    try {
      console.log('🔍 Querying action_config table...');
      const result = await db.query(
        'SELECT * FROM action_config WHERE user_id = $1',
        [userId]
      );
      
      console.log('📊 Query result:', result.rows.length, 'rows found');
      
      if (result.rows.length === 0) {
        // Create default config for user
        console.log('⚠️ No config found for user', userId, '- creating default');
        return this.createDefaultConfig(userId);
      }
      
      console.log('✅ Returning existing config');
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error in getConfig:', error.message);
      console.error('Full error:', error);
      
      // If table doesn't exist, return default config without trying to insert
      if (error.message && error.message.includes('does not exist')) {
        console.error('⚠️ action_config table does not exist. Please run the migration.');
        return this.getDefaults();
      }
      
      throw error;
    }
  }
  
  /**
   * Create default configuration for a user
   */
  static async createDefaultConfig(userId) {
    console.log('🆕 Creating default config for user:', userId);
    
    try {
      const result = await db.query(
        `INSERT INTO action_config (
          user_id, 
          generation_mode, 
          detection_mode,
          confidence_threshold,
          auto_complete_threshold
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE
        SET updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
        [userId, 'playbook', 'hybrid', 70, 95]
      );
      
      console.log('✅ Default config created successfully');
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error creating default config:', error.message);
      console.error('Full error:', error);
      throw error;
    }
  }
  
  /**
   * Update user's action configuration
   */
  static async updateConfig(userId, updates) {
    try {
      const allowed = [
        'generation_mode',
        'ai_enhanced_generation',
        'generate_on_stage_change',
        'generate_on_meeting_scheduled',
        'generate_on_email_next_steps',
        'detection_mode',
        'confidence_threshold',
        'auto_complete_threshold',
        'enable_learning',
        'detect_from_emails',
        'detect_from_meetings',
        'detect_from_documents'
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
      
      if (setClauses.length === 0) {
        throw new Error('No valid fields to update');
      }
      
      values.push(userId);
      
      const result = await db.query(
        `UPDATE action_config 
         SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $${paramCount}
         RETURNING *`,
        values
      );
      
      if (result.rows.length === 0) {
        // Config doesn't exist, create it
        return this.createDefaultConfig(userId);
      }
      
      return result.rows[0];
    } catch (error) {
      console.error('Error updating action config:', error);
      throw error;
    }
  }
  
  /**
   * Check if a feature is enabled for user
   */
  static async isEnabled(userId, feature) {
    const config = await this.getConfig(userId);
    return config[feature] === true;
  }
  
  /**
   * Get default configuration object
   */
  static getDefaults() {
    return {
      generation_mode: 'playbook',
      ai_enhanced_generation: true,
      generate_on_stage_change: true,
      generate_on_meeting_scheduled: false,
      generate_on_email_next_steps: false,
      detection_mode: 'hybrid',
      confidence_threshold: 70,
      auto_complete_threshold: 95,
      enable_learning: true,
      detect_from_emails: true,
      detect_from_meetings: true,
      detect_from_documents: false
    };
  }
}

module.exports = ActionConfigService;
