// services/NetworkJobChangeConfig.js
//
// Org→user config cascade for network job-change behavior (Design & Execution
// Tracker §G-P1), mirroring LinkedInAutomationConfig:
//   • ORG layer  — org_action_config.network_jobchange (JSONB partial), merged
//                  over SYSTEM_DEFAULTS.
//   • USER layer — user_preferences.preferences->'network_jobchange' (partial),
//                  merged over the org layer.
// Always returns a complete, resolved object. Callers inside a transaction pass
// their own client so org + user are read on the same snapshot.

'use strict';

const db = require('../config/database');

const SYSTEM_DEFAULTS = {
  auto_promote_on_move: true,        // D2 — auto-promote a qualifying move to a prospect
  notify_scope:         'all',       // D10 — 'all' | 'champion_left'
  export_cadence:       'weekly',    // D5  — 'on_demand'|'weekly'|'biweekly'|'monthly'
};

class NetworkJobChangeConfig {
  static _merge(stored) {
    return { ...SYSTEM_DEFAULTS, ...(stored || {}) };
  }

  // ── ORG layer ──────────────────────────────────────────────────────────────
  static async getForOrg(orgId, database = db) {
    try {
      const r = await database.query(
        'SELECT network_jobchange FROM org_action_config WHERE org_id = $1',
        [orgId]
      );
      return this._merge(r.rows[0]?.network_jobchange || {});
    } catch (err) {
      console.warn('⚠️  NetworkJobChangeConfig.getForOrg failed:', err.message);
      return this._merge({});
    }
  }

  // ── ORG layer: update (settings UI later) ───────────────────────────────────
  static async setForOrg(orgId, patch, updatedBy, database = db) {
    const r = await database.query(
      `INSERT INTO org_action_config (org_id, network_jobchange, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET network_jobchange = org_action_config.network_jobchange || $2::jsonb,
             updated_at        = CURRENT_TIMESTAMP,
             updated_by        = $3
       RETURNING network_jobchange`,
      [orgId, JSON.stringify(patch || {}), updatedBy]
    );
    return this._merge(r.rows[0].network_jobchange || {});
  }

  // ── Resolved org→user effective config ──────────────────────────────────────
  static async resolveForUser(database, { orgId, userId }) {
    const org = await this.getForOrg(orgId, database);
    let userBucket = {};
    if (userId) {
      try {
        const r = await database.query(
          `SELECT preferences->'network_jobchange' AS b
             FROM user_preferences WHERE user_id = $1 AND org_id = $2`,
          [userId, orgId]
        );
        userBucket = r.rows[0]?.b || {};
      } catch (_) { /* best-effort; fall back to org */ }
    }
    const eff = { ...org, ...(userBucket || {}) };
    return {
      // default ON unless explicitly disabled (D2)
      autoPromoteOnMove: eff.auto_promote_on_move !== false,
      notifyScope:       eff.notify_scope || 'all',
      exportCadence:     eff.export_cadence || 'weekly',
      raw: eff,
    };
  }
}

module.exports = NetworkJobChangeConfig;
