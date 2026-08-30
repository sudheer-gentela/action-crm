/**
 * ProspectingEscalationService
 *
 * Manages per-org prospecting-escalation policy, stored in
 * org_action_config.prospecting_escalation (JSONB).
 *
 * Policy controls:
 *   - enabled:                  master kill-switch for the whole subsystem
 *   - digest_hour_utc:          UTC hour (0..23) at which the daily digest fires
 *                               for this org. Default 3 = 8:30 AM IST.
 *                               This is ORG-level and remains so. users.timezone
 *                               does exist (added by 2026_15) and per-user
 *                               time-of-day IS possible — the daily work
 *                               reminder does exactly that, following the
 *                               pattern below with each row self-filtering on
 *                               its own local hour. This digest was not
 *                               converted because changing when an existing
 *                               digest fires would move it for every org that
 *                               already relies on the current time.
 *   - immediate_alert_enabled:  fire an immediate alert when an action goes
 *                               overdue past immediate_hours.
 *   - immediate_hours:          how many hours past due_date before the
 *                               immediate alert fires. Default 24.
 *   - daily_digest_enabled:     send the daily digest at digest_hour_utc.
 *   - tier1_hours / tier2_hours / tier3_hours:
 *                               escalation thresholds. At tier1_hours past due
 *                               the rep is nudged. At tier2_hours the manager
 *                               is looped in. At tier3_hours the skip-level
 *                               manager is added (or all org admins if no
 *                               skip-level exists).
 *   - channels:                 ['email'] | ['in_app'] | ['email','in_app']
 *                               which delivery channels to use. Notifications
 *                               table writes happen for in_app; email path
 *                               handled by notificationService.
 *
 * Stored values merge over SYSTEM_DEFAULTS so partial configs still resolve
 * to a complete object. New keys added to SYSTEM_DEFAULTS automatically
 * apply to every org without requiring a config update.
 *
 * Also exposes resolveEscalationRecipients() — the tier-aware recipient
 * resolver used by the notification scheduler. This lives here rather than
 * in notificationService because tier semantics belong to the policy domain.
 */

const db = require('../config/database');

// ── System-level defaults — apply when an org has no per-org override ────────
const SYSTEM_DEFAULTS = {
  enabled:                 true,
  digest_hour_utc:         3,      // 8:30 AM IST — India-friendly default
  immediate_alert_enabled: true,
  immediate_hours:         24,
  daily_digest_enabled:    true,
  tier1_hours:             24,
  tier2_hours:             48,
  tier3_hours:             72,
  channels:                ['email', 'in_app'],
};

const VALID_CHANNELS = new Set(['email', 'in_app']);

// ── Per-client override scope (Agency Phase 5, 2026_54) ──────────────────────
// A client may override ONLY the escalation-tier thresholds. Master enable,
// immediate-alert timing, digest hour and channels stay org-level on purpose —
// a client is a place to tighten/loosen tier timing for its own overdue
// actions, not to reconfigure the whole subsystem. Kept as its own set (not
// the full SYSTEM_DEFAULTS keys) so the client PUT can't smuggle in org-scope
// fields.
const CLIENT_OVERRIDE_KEYS = new Set(['tier1_hours', 'tier2_hours', 'tier3_hours']);

class ProspectingEscalationService {

  // ── Public: get the org's effective policy ───────────────────────────────
  // Merges stored per-org settings over SYSTEM_DEFAULTS. Always returns a
  // complete object — no missing keys. Safe to call even if the org has no
  // org_action_config row yet (returns SYSTEM_DEFAULTS).
  static async getForOrg(orgId) {
    try {
      const result = await db.query(
        'SELECT prospecting_escalation FROM org_action_config WHERE org_id = $1',
        [orgId]
      );
      const stored = result.rows[0]?.prospecting_escalation || {};
      return this._merge(stored);
    } catch (err) {
      // org_action_config has prospecting_escalation JSONB column added
      // lazily — if the column doesn't exist on a particular env yet, fall
      // back to defaults rather than 500ing. The scheduler should keep ticking.
      console.warn('⚠️  ProspectingEscalationService.getForOrg failed:', err.message);
      return { ...SYSTEM_DEFAULTS };
    }
  }

  // ── Public: update the org's policy ──────────────────────────────────────
  // Validates the patch before writing. Allowed fields are the keys of
  // SYSTEM_DEFAULTS. Unknown keys are silently dropped (defense against
  // a UI mistake polluting the JSONB blob).
  static async setForOrg(orgId, patch, updatedBy) {
    const validated = this._validatePatch(patch);

    const result = await db.query(
      `INSERT INTO org_action_config (org_id, prospecting_escalation, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET prospecting_escalation = org_action_config.prospecting_escalation || $2::jsonb,
             updated_at             = CURRENT_TIMESTAMP,
             updated_by             = $3
       RETURNING prospecting_escalation`,
      [orgId, JSON.stringify(validated), updatedBy]
    );

    return this._merge(result.rows[0]?.prospecting_escalation || {});
  }

  // ── Public: effective policy for a single agency client (Phase 5) ─────────
  // Merges the client's escalation_overrides (partial, tier hours only) over
  // the org policy, which is itself merged over SYSTEM_DEFAULTS. Always returns
  // a complete policy object. A client with no override (NULL / {}) resolves to
  // the org policy verbatim.
  static async getEffectiveForClient(orgId, clientId) {
    const orgPolicy = await this.getForOrg(orgId);
    let overrides = {};
    try {
      const res = await db.query(
        'SELECT escalation_overrides FROM clients WHERE id = $1 AND org_id = $2',
        [clientId, orgId]
      );
      overrides = res.rows[0]?.escalation_overrides || {};
    } catch (err) {
      // escalation_overrides column added in 2026_54 — if it's missing on a
      // particular env, degrade to the org policy rather than 500ing.
      console.warn('⚠️  ProspectingEscalationService.getEffectiveForClient failed:', err.message);
      overrides = {};
    }
    return this._mergeClientOverrides(orgPolicy, overrides);
  }

  // ── Public: read a client's raw override object (or null) ─────────────────
  static async getClientOverrides(orgId, clientId) {
    const res = await db.query(
      'SELECT escalation_overrides FROM clients WHERE id = $1 AND org_id = $2',
      [clientId, orgId]
    );
    if (!res.rows.length) {
      const e = new Error('Client not found');
      e.status = 404;
      throw e;
    }
    return res.rows[0].escalation_overrides || null;
  }

  // ── Public: set (or clear) a client's escalation overrides ────────────────
  // Pass null / {} to clear (client reverts to the org policy). Otherwise the
  // patch is validated against CLIENT_OVERRIDE_KEYS and the MERGED (effective)
  // tiers are checked for strict monotonicity, exactly like the org policy.
  // Returns { overrides, effective } after the write.
  static async setClientOverrides(orgId, clientId, patch) {
    const orgPolicy = await this.getForOrg(orgId);
    const cleaned = this._validateClientOverrides(patch, orgPolicy);

    // Empty object → store SQL NULL so "no override" has one canonical shape.
    const toStore = cleaned && Object.keys(cleaned).length > 0
      ? JSON.stringify(cleaned)
      : null;

    const res = await db.query(
      `UPDATE clients
          SET escalation_overrides = $3::jsonb,
              updated_at           = NOW()
        WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
        RETURNING escalation_overrides`,
      [clientId, orgId, toStore]
    );
    if (!res.rows.length) {
      const e = new Error('Client not found');
      e.status = 404;
      throw e;
    }

    const overrides = res.rows[0].escalation_overrides || null;
    return {
      overrides,
      effective: this._mergeClientOverrides(orgPolicy, overrides || {}),
    };
  }

  // ── Internal: merge client overrides over an already-merged org policy ────
  static _mergeClientOverrides(orgPolicy, overrides) {
    const merged = { ...orgPolicy };
    if (overrides && typeof overrides === 'object') {
      for (const key of CLIENT_OVERRIDE_KEYS) {
        if (Number.isInteger(overrides[key])) merged[key] = overrides[key];
      }
    }
    return merged;
  }

  // ── Internal: validate a client override patch ────────────────────────────
  // Only CLIENT_OVERRIDE_KEYS are allowed (unknown keys dropped). Each is an
  // integer 1..720. The EFFECTIVE tiers (patch merged over the org policy) must
  // be strictly increasing — so a client may set just one tier and still be
  // rejected if that makes the merged ladder non-monotonic.
  static _validateClientOverrides(patch, orgPolicy) {
    if (patch === null || patch === undefined) return {};   // clear
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      throw _err('escalation overrides must be an object (or null to clear)');
    }

    const out = {};
    for (const [key, val] of Object.entries(patch)) {
      if (!CLIENT_OVERRIDE_KEYS.has(key)) continue;          // drop org-scope keys
      if (val === null) continue;                            // per-key clear → fall back to org
      if (!Number.isInteger(val) || val < 1 || val > 720) {
        throw _err(`${key} must be an integer in 1..720 (one month)`);
      }
      out[key] = val;
    }

    // Effective-tier monotonicity: merge over the org policy, then check.
    const eff = { ...orgPolicy, ...out };
    if (!(eff.tier1_hours < eff.tier2_hours && eff.tier2_hours < eff.tier3_hours)) {
      throw _err(
        `effective tier hours must be strictly increasing after overrides: ` +
        `tier1 (${eff.tier1_hours}) < tier2 (${eff.tier2_hours}) < tier3 (${eff.tier3_hours})`
      );
    }

    return out;
  }

  // ── Public: resolve a client's active team lead(s) ───────────────────────
  // Returns the user_ids of client_team_members with role='lead' for this
  // client, limited to ACTIVE org members (org-checked via the join to
  // clients + org_users.is_active). Best-effort: on any error returns [] so a
  // lookup failure never blocks the surrounding notification path.
  //
  // Introduced in Agency Phase 6 to give the immediate "client sender missing"
  // fast-path a lead set independent of the escalation tier. resolveEscalation-
  // Recipients() reuses this for its tier-2 additive client-lead loop-in, so
  // there is exactly ONE client-lead query in the service.
  static async resolveClientLeads(orgId, clientId) {
    if (!clientId) return [];
    try {
      const res = await db.query(
        `SELECT ctm.user_id
           FROM client_team_members ctm
           JOIN clients   c  ON c.id = ctm.client_id
           JOIN org_users ou ON ou.user_id = ctm.user_id
                             AND ou.org_id = c.org_id
                             AND ou.is_active = TRUE
          WHERE ctm.client_id = $1
            AND c.org_id      = $2
            AND ctm.role      = 'lead'`,
        [clientId, orgId]
      );
      return res.rows.map(r => r.user_id);
    } catch (err) {
      console.warn('⚠️  resolveClientLeads: lookup failed:', err.message);
      return [];
    }
  }

  // ── Public: tier-aware recipient resolution ──────────────────────────────
  // Resolves the user IDs to notify for a given action owner at a given
  // tier (1, 2, or 3).
  //
  //   tier 1 → [ownerId]                                         (rep nudge)
  //   tier 2 → [ownerId, managerId, ...clientLeads]              (loop in manager)
  //   tier 3 → [ownerId, managerId, skipLevelId, ...clientLeads] (escalate further)
  //
  // If tier 3 has no skip-level manager (org_hierarchy.reports_to of the
  // manager is NULL), fall back to including all org admins instead — this
  // is the safety net for orgs that haven't filled in their full reporting
  // hierarchy. If neither skip-level NOR any admins resolve, return tier 2
  // recipients (don't fail open with empty list).
  //
  // Agency Phase 5: when clientId is provided (the action's prospect belongs
  // to an agency client), the client's team lead(s)
  // (client_team_members.role = 'lead') are added ADDITIVELY from tier 2 — the
  // client lead is the client-side analog of the reporting manager and owns
  // that client's outcomes. This is independent of the hierarchy ladder, so a
  // client prospect owned by a rep with no manager still reaches the lead once
  // it hits tier 2. failAndPause writes its send-failure into prospecting_actions
  // (source='sequence_send_failed', due NOW), which is exactly what this scan
  // sweeps — so client-sender failures escalate to the lead + (tier 3) org
  // admins on the same ladder, with no separate sweep needed. clientId is
  // optional; omitting it (or null) reproduces the pre-Phase-5 behaviour.
  //
  // Returns: Set<number> of user_ids.
  static async resolveEscalationRecipients(orgId, ownerId, tier, clientId = null) {
    const recipients = new Set();
    recipients.add(ownerId);

    if (tier < 2) return recipients;

    // Tier 2: rep's reporting manager
    const managerRes = await db.query(
      `SELECT reports_to AS manager_id
         FROM org_hierarchy
        WHERE org_id = $1
          AND user_id = $2
          AND relationship_type = 'solid'
          AND reports_to IS NOT NULL
        LIMIT 1`,
      [orgId, ownerId]
    );
    const managerId = managerRes.rows[0]?.manager_id;
    if (managerId) recipients.add(managerId);

    // Tier 2 (additive): the client's team lead(s). Org-checked + active-member
    // checked inside resolveClientLeads() (Phase 6 extraction — one shared
    // query). Best-effort — a resolution failure there returns [] and never
    // stops the rest of the ladder from being notified.
    if (clientId) {
      const leads = await this.resolveClientLeads(orgId, clientId);
      leads.forEach(id => recipients.add(id));
    }

    if (tier < 3) return recipients;

    // Tier 3: skip-level manager (manager's manager). Only attempt if we
    // actually resolved a tier-2 manager.
    let skipLevelId = null;
    if (managerId) {
      const skipRes = await db.query(
        `SELECT reports_to AS skip_level_id
           FROM org_hierarchy
          WHERE org_id = $1
            AND user_id = $2
            AND relationship_type = 'solid'
            AND reports_to IS NOT NULL
          LIMIT 1`,
        [orgId, managerId]
      );
      skipLevelId = skipRes.rows[0]?.skip_level_id || null;
    }

    if (skipLevelId) {
      recipients.add(skipLevelId);
    } else {
      // Fallback: all org admins (owner + admin role on org_users).
      // We add them in addition to whatever we already have so the loop is
      // not narrower than tier 2 even when the fallback fires.
      const adminRes = await db.query(
        `SELECT user_id
           FROM org_users
          WHERE org_id = $1
            AND role IN ('owner', 'admin')
            AND is_active = TRUE`,
        [orgId]
      );
      adminRes.rows.forEach(r => recipients.add(r.user_id));
    }

    return recipients;
  }

  // ── Internal: merge stored over defaults ─────────────────────────────────
  static _merge(stored) {
    const merged = { ...SYSTEM_DEFAULTS, ...stored };
    // channels needs special handling — array, not scalar. If the stored
    // value is malformed (not an array, or empty), restore defaults.
    if (!Array.isArray(merged.channels) || merged.channels.length === 0) {
      merged.channels = [...SYSTEM_DEFAULTS.channels];
    }
    return merged;
  }

  // ── Internal: validate a patch ───────────────────────────────────────────
  // Throws on bad input with descriptive messages. Drops unknown keys
  // silently. Returns the cleaned object.
  static _validatePatch(patch) {
    if (!patch || typeof patch !== 'object') {
      const err = new Error('patch must be an object');
      err.code = 'INVALID_POLICY';
      throw err;
    }

    const out = {};
    const ALLOWED_KEYS = new Set(Object.keys(SYSTEM_DEFAULTS));

    for (const [key, val] of Object.entries(patch)) {
      if (!ALLOWED_KEYS.has(key)) continue;  // drop unknown

      switch (key) {
        case 'enabled':
        case 'immediate_alert_enabled':
        case 'daily_digest_enabled':
          if (typeof val !== 'boolean') {
            throw _err(`${key} must be a boolean`);
          }
          out[key] = val;
          break;

        case 'digest_hour_utc':
          if (!Number.isInteger(val) || val < 0 || val > 23) {
            throw _err('digest_hour_utc must be an integer in 0..23');
          }
          out[key] = val;
          break;

        case 'immediate_hours':
        case 'tier1_hours':
        case 'tier2_hours':
        case 'tier3_hours':
          if (!Number.isInteger(val) || val < 1 || val > 720) {
            throw _err(`${key} must be an integer in 1..720 (one month)`);
          }
          out[key] = val;
          break;

        case 'channels':
          if (!Array.isArray(val) || val.length === 0) {
            throw _err('channels must be a non-empty array');
          }
          for (const c of val) {
            if (!VALID_CHANNELS.has(c)) {
              throw _err(`channel '${c}' is not valid; allowed: ${[...VALID_CHANNELS].join(', ')}`);
            }
          }
          out[key] = [...new Set(val)];  // dedup
          break;
      }
    }

    // Tier monotonicity check — only when all three are present in the
    // patch (or merged with current state would still be monotonic).
    // If a partial patch breaks monotonicity, we reject it; the caller
    // should send all three together when reordering thresholds.
    if (
      out.tier1_hours !== undefined &&
      out.tier2_hours !== undefined &&
      out.tier3_hours !== undefined
    ) {
      if (!(out.tier1_hours < out.tier2_hours && out.tier2_hours < out.tier3_hours)) {
        throw _err('tier hours must be strictly increasing: tier1 < tier2 < tier3');
      }
    }

    return out;
  }
}

function _err(message) {
  const e = new Error(message);
  e.code = 'INVALID_POLICY';
  e.status = 400;
  return e;
}

module.exports = ProspectingEscalationService;
module.exports.SYSTEM_DEFAULTS = SYSTEM_DEFAULTS;
module.exports.CLIENT_OVERRIDE_KEYS = CLIENT_OVERRIDE_KEYS;
