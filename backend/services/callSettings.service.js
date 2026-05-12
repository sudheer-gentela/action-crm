/**
 * CallSettingsService
 *
 * Manages per-org call-related settings stored in
 * org_action_config.call_settings (JSONB).
 *
 * Settings include:
 *   - outcomes:           array of { key, label, group, order } — the
 *                         outcome values that show in the "Log call" form
 *                         dropdown. Orgs can rename labels and reorder;
 *                         they CANNOT remove a key if any calls
 *                         row uses it (referential integrity at app layer).
 *   - edit_window_hours:  how long after logging a rep can edit their own
 *                         call entry. Defaults to 24.
 *
 * Stored values merge over SYSTEM_DEFAULTS so partial configs still resolve
 * to a complete object. New keys added to SYSTEM_DEFAULTS automatically
 * apply to every org without requiring a config update.
 */

const db = require('../config/database');

// ── System-level defaults — apply when an org has no per-org override ────────
// Outcomes are in the order they'll appear in the dropdown. The `group` field
// drives a visual separator in the UI (connected → no_contact → blocker).
const SYSTEM_DEFAULTS = {
  outcomes: [
    { key: 'connected_meaningful', label: 'Connected — meaningful conversation', group: 'connected',  order: 1 },
    { key: 'connected_brief',      label: 'Connected — brief exchange',          group: 'connected',  order: 2 },
    { key: 'callback_requested',   label: 'Callback requested',                  group: 'connected',  order: 3 },
    { key: 'voicemail_left',       label: 'Voicemail — left message',            group: 'no_contact', order: 4 },
    { key: 'voicemail_no_message', label: 'Voicemail — no message left',         group: 'no_contact', order: 5 },
    { key: 'no_answer',            label: 'No answer',                           group: 'no_contact', order: 6 },
    { key: 'gatekeeper',           label: 'Gatekeeper / wrong contact',          group: 'no_contact', order: 7 },
    { key: 'wrong_number',         label: 'Wrong number',                        group: 'blocker',    order: 8 },
    { key: 'do_not_call',          label: 'Do not call — explicit request',      group: 'blocker',    order: 9 },
  ],
  edit_window_hours: 24,
};

// Valid group keys. The UI renders a separator between groups, so the
// allowed set is fixed.
const VALID_GROUPS = new Set(['connected', 'no_contact', 'blocker']);

// Outcomes where a duration_seconds value is meaningful. Outcomes where the
// call never connected (no_answer, wrong_number, gatekeeper-where-prospect-not-reached)
// hide the duration field in the UI and reject duration_seconds at write time.
// Lives here because it's a property of outcome semantics, not org config —
// orgs should not customize whether "no answer" has a duration.
const OUTCOMES_WITHOUT_DURATION = new Set([
  'no_answer',
  'wrong_number',
  'gatekeeper',
]);

class CallSettingsService {

  // ── Public: get the org's effective settings ─────────────────────────────
  // Merges stored per-org settings over SYSTEM_DEFAULTS. Always returns a
  // complete object — no missing keys. Safe to call even if the org has no
  // org_action_config row yet (returns SYSTEM_DEFAULTS).
  static async getForOrg(orgId) {
    try {
      const result = await db.query(
        'SELECT call_settings FROM org_action_config WHERE org_id = $1',
        [orgId]
      );
      const stored = result.rows[0]?.call_settings || {};
      return this._merge(stored);
    } catch (err) {
      console.warn('⚠️  CallSettingsService.getForOrg failed:', err.message);
      return { ...SYSTEM_DEFAULTS };
    }
  }

  // ── Public: update the org's settings ────────────────────────────────────
  // Validates the patch before writing. Allowed fields:
  //   - outcomes: full array replacement. Each entry validated (see below).
  //               Cannot remove a key in use by any calls row.
  //   - edit_window_hours: integer between 0 and 720 (one month).
  // Throws on validation failure with a descriptive message.
  //
  // Note on outcomes: this is a full replacement, not a merge. Callers pass
  // the entire desired outcomes array. To add or remove outcomes, callers
  // load the current state via getForOrg(), modify the array, and submit.
  // This is consistent with how most CMS-style "config edit" UIs work.
  static async setForOrg(orgId, patch, updatedBy) {
    const validated = await this._validatePatch(orgId, patch);

    const result = await db.query(
      `INSERT INTO org_action_config (org_id, call_settings, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET call_settings = org_action_config.call_settings || $2::jsonb,
             updated_at    = CURRENT_TIMESTAMP,
             updated_by    = $3
       RETURNING call_settings`,
      [orgId, JSON.stringify(validated), updatedBy]
    );

    return this._merge(result.rows[0].call_settings || {});
  }

  // ── Public: validate an outcome key against the org's settings ───────────
  // Returns the matched outcome object on success, throws on failure.
  // Used by the calls route to validate POST/PATCH payloads.
  static async resolveOutcome(orgId, outcomeKey) {
    if (!outcomeKey) {
      const err = new Error('outcome is required');
      err.code = 'INVALID_OUTCOME';
      throw err;
    }
    const settings = await this.getForOrg(orgId);
    const found = settings.outcomes.find(o => o.key === outcomeKey);
    if (!found) {
      const valid = settings.outcomes.map(o => o.key).join(', ');
      const err = new Error(`Unknown outcome '${outcomeKey}'. Valid keys for this org: ${valid}`);
      err.code = 'INVALID_OUTCOME';
      throw err;
    }
    return found;
  }

  // ── Public: check whether duration_seconds is meaningful for an outcome ─
  // Used by the calls route to validate "no duration for no_answer" etc.
  static outcomeAllowsDuration(outcomeKey) {
    return !OUTCOMES_WITHOUT_DURATION.has(outcomeKey);
  }

  // ── Public: edit-window check ────────────────────────────────────────────
  // Returns true if a call logged at `loggedAt` is still within the org's
  // edit window. Used by PATCH /prospect-calls/:id to allow/deny edits.
  static async isWithinEditWindow(orgId, loggedAt) {
    if (!loggedAt) return false;
    const settings = await this.getForOrg(orgId);
    const windowMs = (settings.edit_window_hours || 0) * 3600 * 1000;
    if (windowMs <= 0) return false;
    return (Date.now() - new Date(loggedAt).getTime()) < windowMs;
  }

  // ── Internal: merge a stored partial over the system defaults ────────────
  // Outcomes are NOT deep-merged — if the stored config sets outcomes, it
  // replaces the defaults entirely. Other fields use simple overlay.
  static _merge(stored) {
    const out = { ...SYSTEM_DEFAULTS, ...stored };
    if (!Array.isArray(out.outcomes) || out.outcomes.length === 0) {
      out.outcomes = SYSTEM_DEFAULTS.outcomes;
    }
    // Sort by `order` so the UI doesn't have to.
    out.outcomes = [...out.outcomes].sort((a, b) => (a.order || 0) - (b.order || 0));
    return out;
  }

  // ── Internal: validate a patch before writing ────────────────────────────
  // Throws on any validation error. Returns the cleaned patch object that
  // should actually be persisted.
  static async _validatePatch(orgId, patch) {
    if (!patch || typeof patch !== 'object') {
      throw new Error('Patch must be an object');
    }
    const cleaned = {};

    // edit_window_hours: integer 0..720 (one month).
    if (patch.edit_window_hours !== undefined) {
      const n = Number(patch.edit_window_hours);
      if (!Number.isInteger(n) || n < 0 || n > 720) {
        throw new Error('edit_window_hours must be an integer between 0 and 720');
      }
      cleaned.edit_window_hours = n;
    }

    // outcomes: full array replacement.
    if (patch.outcomes !== undefined) {
      if (!Array.isArray(patch.outcomes) || patch.outcomes.length === 0) {
        throw new Error('outcomes must be a non-empty array');
      }
      const seenKeys = new Set();
      const validated = patch.outcomes.map((o, i) => {
        if (!o || typeof o !== 'object') {
          throw new Error(`outcomes[${i}] must be an object`);
        }
        if (typeof o.key !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(o.key)) {
          throw new Error(`outcomes[${i}].key must be a lowercase identifier (max 32 chars)`);
        }
        if (seenKeys.has(o.key)) {
          throw new Error(`outcomes[${i}].key '${o.key}' is duplicated`);
        }
        seenKeys.add(o.key);
        if (typeof o.label !== 'string' || o.label.trim().length === 0) {
          throw new Error(`outcomes[${i}].label is required`);
        }
        if (o.label.length > 100) {
          throw new Error(`outcomes[${i}].label exceeds 100 chars`);
        }
        if (typeof o.group !== 'string' || !VALID_GROUPS.has(o.group)) {
          throw new Error(`outcomes[${i}].group must be one of: ${[...VALID_GROUPS].join(', ')}`);
        }
        const order = Number(o.order);
        if (!Number.isInteger(order) || order < 0) {
          throw new Error(`outcomes[${i}].order must be a non-negative integer`);
        }
        return { key: o.key, label: o.label.trim(), group: o.group, order };
      });

      // Referential integrity: cannot remove a key that's in use.
      const newKeys = new Set(validated.map(o => o.key));
      const current = await this.getForOrg(orgId);
      const oldKeys = current.outcomes.map(o => o.key);
      const removed = oldKeys.filter(k => !newKeys.has(k));
      if (removed.length > 0) {
        const usage = await db.query(
          `SELECT DISTINCT outcome FROM calls
           WHERE org_id = $1 AND outcome = ANY($2)`,
          [orgId, removed]
        );
        const inUse = usage.rows.map(r => r.outcome);
        if (inUse.length > 0) {
          throw new Error(
            `Cannot remove outcome(s) in use by existing call logs: ${inUse.join(', ')}. ` +
            `Rename them instead, or first migrate existing rows to another outcome.`
          );
        }
      }

      cleaned.outcomes = validated;
    }

    if (Object.keys(cleaned).length === 0) {
      throw new Error('No valid fields in patch');
    }
    return cleaned;
  }
}

module.exports = CallSettingsService;
module.exports.SYSTEM_DEFAULTS = SYSTEM_DEFAULTS;
module.exports.OUTCOMES_WITHOUT_DURATION = OUTCOMES_WITHOUT_DURATION;
