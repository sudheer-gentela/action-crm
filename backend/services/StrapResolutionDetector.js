/**
 * StrapResolutionDetector.js
 *
 * Detects when an active STRAP's hurdle has been resolved by observing
 * events from the existing pipelines. Entity-type aware.
 *
 * Integration points (called from AgentObserver, non-blocking):
 *   - checkFromEmail(dealId, orgId, userId)
 *   - checkFromHealthChange(dealId, orgId, userId, oldScore, newScore)
 *   - checkFromStageChange(entityType, entityId, orgId, userId, newStage)
 *   - checkFromActionCompleted(entityType, entityId, orgId, userId, action)
 *   - checkFromProspectEvent(prospectId, orgId, userId, eventType)
 */

const db                    = require('../config/database');
const StrapContextResolver  = require('./StrapContextResolver');
const StrapHurdleIdentifier = require('./StrapHurdleIdentifier');

class StrapResolutionDetector {

  /**
   * Check if an email event resolves the active STRAP for a deal.
   */
  static async checkFromEmail(dealId, orgId, userId) {
    try {
      await this._checkAndResolve('deal', dealId, orgId, userId, 'email_received');
    } catch (err) {
      console.error('🎯 STRAP resolution check (email) error:', err.message);
    }
  }

  /**
   * Check if a health score change resolves the active STRAP.
   */
  static async checkFromHealthChange(dealId, orgId, userId, oldScore, newScore) {
    try {
      // Significant improvement might resolve momentum/buyer_engagement hurdles
      if (newScore > oldScore && (newScore - oldScore) >= 10) {
        await this._checkAndResolve('deal', dealId, orgId, userId, 'health_improved');
      }
    } catch (err) {
      console.error('🎯 STRAP resolution check (health) error:', err.message);
    }
  }

  /**
   * Check if a stage change resolves the active STRAP.
   */
  static async checkFromStageChange(entityType, entityId, orgId, userId, newStage) {
    try {
      await this._checkAndResolve(entityType, entityId, orgId, userId, `stage_changed_to_${newStage}`);
    } catch (err) {
      console.error('🎯 STRAP resolution check (stage) error:', err.message);
    }
  }

  /**
   * Check if a completed action resolves the active STRAP.
   */
  static async checkFromActionCompleted(entityType, entityId, orgId, userId, action) {
    try {
      await this._checkAndResolve(entityType, entityId, orgId, userId, 'action_completed');
    } catch (err) {
      console.error('🎯 STRAP resolution check (action) error:', err.message);
    }
  }

  /**
   * Check if a prospect event resolves the active STRAP.
   */
  static async checkFromProspectEvent(prospectId, orgId, userId, eventType) {
    try {
      await this._checkAndResolve('prospect', prospectId, orgId, userId, eventType);
    } catch (err) {
      console.error('🎯 STRAP resolution check (prospect) error:', err.message);
    }
  }

  // ── Core resolution logic ─────────────────────────────────────────────────

  /**
   * Core pattern:
   *   1. Load active STRAP for entity
   *   2. Re-run hurdle identification with fresh context
   *   3. If top hurdle changed or no hurdle found → auto-resolve
   *   4. If same hurdle still present → do nothing
   */
  static async _checkAndResolve(entityType, entityId, orgId, userId, trigger) {
    // 1. Get active STRAP
    const activeStrap = await this._getActive(entityType, entityId, orgId);
    if (!activeStrap) return; // No active STRAP to check

    // 2. Build fresh context
    let context;
    try {
      context = await StrapContextResolver.resolve(entityType, entityId, userId, orgId);
    } catch (err) {
      // Context build failure (entity deleted, etc.) — don't resolve
      console.error(`🎯 STRAP context build failed for ${entityType}/${entityId}:`, err.message);
      return;
    }

    // 3. Re-identify top hurdle
    const currentHurdle = StrapHurdleIdentifier.identify(entityType, context);

    // 4. Determine if resolved
    const isResolved = !currentHurdle || currentHurdle.hurdleType !== activeStrap.hurdle_type;

    if (isResolved) {
      const note = currentHurdle
        ? `Auto-resolved: hurdle shifted from "${activeStrap.hurdle_type}" to "${currentHurdle.hurdleType}" (trigger: ${trigger})`
        : `Auto-resolved: no hurdle detected (trigger: ${trigger})`;

      await db.query(
        `UPDATE straps SET
           status = 'resolved',
           resolved_by = $1,
           resolved_at = NOW(),
           resolution_type = 'auto_detected',
           resolution_note = $2
         WHERE id = $3`,
        [userId, note, activeStrap.id]
      );

      console.log(`🎯 STRAP auto-resolved: #${activeStrap.id} ${entityType}/${entityId} — ${activeStrap.hurdle_type} (${trigger})`);

      // If a new hurdle was detected, auto-generate a new STRAP
      if (currentHurdle) {
        try {
          const StrapEngine = require('./StrapEngine');
          await StrapEngine.generate(entityType, entityId, userId, orgId, { useAI: true });
        } catch (err) {
          console.error('🎯 STRAP auto-regen after resolution failed:', err.message);
        }
      }
    }
  }

  static async _getActive(entityType, entityId, orgId) {
    const result = await db.query(
      `SELECT * FROM straps
       WHERE entity_type = $1 AND entity_id = $2 AND org_id = $3 AND status = 'active'
       LIMIT 1`,
      [entityType, entityId, orgId]
    );
    return result.rows[0] || null;
  }
}

module.exports = StrapResolutionDetector;
