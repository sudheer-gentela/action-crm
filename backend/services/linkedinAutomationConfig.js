/**
 * LinkedInAutomationConfig
 *
 * Resolves whether optional auto-sending of LinkedIn connection requests is
 * active for a given (org, user), and the defensive guardrails that apply.
 *
 * Two-tier model, deliberately split across the two precedents already in the
 * codebase:
 *
 *   1. ORG layer  — stored in org_action_config.linkedin_automation (JSONB),
 *      managed the same way as call_settings (services/callSettings.service.js):
 *      getForOrg merges a stored partial over SYSTEM_DEFAULTS; setForOrg
 *      validates a patch and persists via the same INSERT … ON CONFLICT …
 *      ('||' JSONB merge) shape. This holds the ORG-ADMIN master toggle plus
 *      the hard guardrails (daily cap, jitter band, human-hours window) that an
 *      admin — not an individual rep — controls.
 *
 *   2. USER opt-in — resolved with the org→user→system cascade used by
 *      services/personalizeConfig.js. The rep's own opt-in lives in
 *      user_preferences.preferences->'linkedin_auto_connect' (a bare boolean).
 *      "Unset" inherits the system default (OFF). A rep is NEVER auto-enrolled:
 *      the effective switch is (org master toggle) AND (explicit user opt-in).
 *
 * Why the split: the org toggle is an org-wide capability gate; the per-user
 * opt-in is informed consent to a LinkedIn-ToS-violating action that carries a
 * real account-ban risk. Both must be true, and the user one must be an
 * explicit, affirmative choice — never a default-on.
 *
 * Division of enforcement (IMPORTANT — read before changing defaults):
 *   • The BACKEND (firer + claim endpoint) enforces: master toggle, user opt-in,
 *     and the authoritative per-seat daily cap (counted from confirmed sends, so
 *     it survives an extension reinstall). It decides which steps are ELIGIBLE.
 *   • The EXTENSION enforces the client-time / client-state guardrails it alone
 *     can see: the human-hours window (evaluated in the rep's LOCAL clock),
 *     randomized jitter between actions, "only act when a LinkedIn tab is
 *     already open", and abort-on-challenge/captcha. The window/jitter NUMBERS
 *     live here so the admin controls them centrally; the extension reads them
 *     via the eligibility response and applies them locally.
 *
 * Nothing in here sends anything. It only answers "is this allowed, and within
 * what limits". The action itself is performed client-side by the extension.
 */

const db = require('../config/database');

// ── System-level defaults — apply when an org has no per-org override ────────
//
// Conservative on purpose. LinkedIn's own invite ceiling is roughly weekly and
// in the low hundreds; 20/seat/day keeps a single rep well under it even before
// the human-hours window and jitter further throttle throughput. These are the
// numbers an org STARTS with; an admin can tighten (never silently loosen past
// the validated ceilings below).
const SYSTEM_DEFAULTS = {
  // ORG-ADMIN master capability gate. OFF until an admin explicitly enables it
  // (and acknowledges the in-product ToS/ban disclaimer at the UI layer).
  auto_connect_enabled: false,

  // Authoritative per-seat daily ceiling on auto-sent connection requests.
  // Counted server-side from confirmed-sent rows for the calling seat "today"
  // (org-local day). Hard cap — the claim endpoint refuses past it.
  daily_cap: 20,

  // Randomized delay the EXTENSION waits between two auto-sends, in seconds.
  // A uniform pick in [min,max] per action. Never zero — bursts are the single
  // biggest flag signal.
  jitter_seconds: { min: 45, max: 180 },

  // Human-hours window the EXTENSION enforces in the rep's LOCAL time. Outside
  // it, the extension does nothing (no catch-up burst — skipped, not queued).
  //   days: ISO weekday numbers 1=Mon … 7=Sun
  human_hours: { start_hour: 9, end_hour: 17, days: [1, 2, 3, 4, 5] },

  // How long a claimed (leased) step may stay in-flight before the backend
  // reclaims it as 'scheduled'. Covers the rep closing the browser between
  // claim and confirm. Minutes.
  lease_minutes: 20,
};

// Validation ceilings. An admin can make automation SAFER (lower cap, narrower
// window, longer jitter) but cannot push past these — they exist so a fat
// finger or a bad import can't turn this into a banhammer magnet.
const LIMITS = {
  daily_cap_max:        40,   // absolute server-side ceiling per seat/day
  jitter_min_floor:     20,   // no action gap shorter than this, ever
  jitter_max_ceiling: 1800,   // 30 min — upper bound on a single gap
  lease_minutes_min:     5,
  lease_minutes_max:   120,
};

class LinkedInAutomationConfig {

  // ── ORG layer: effective org settings ───────────────────────────────────
  // Merges the stored partial over SYSTEM_DEFAULTS. Always returns a complete
  // object. Safe when the org has no org_action_config row yet.
  //
  // `database` defaults to the module pool, but callers inside a transaction
  // (the firer, the claim endpoint) pass their own client so the org config
  // and the per-user opt-in are read on the SAME connection/snapshot.
  static async getForOrg(orgId, database = db) {
    try {
      const result = await database.query(
        'SELECT linkedin_automation FROM org_action_config WHERE org_id = $1',
        [orgId]
      );
      const stored = result.rows[0]?.linkedin_automation || {};
      return this._merge(stored);
    } catch (err) {
      console.warn('⚠️  LinkedInAutomationConfig.getForOrg failed:', err.message);
      return this._merge({});
    }
  }

  // ── ORG layer: update ────────────────────────────────────────────────────
  // Validates the patch, then persists with the same INSERT … ON CONFLICT …
  // JSONB-merge shape as CallSettingsService.setForOrg. Throws on bad input.
  static async setForOrg(orgId, patch, updatedBy) {
    const validated = await this._validatePatch(orgId, patch);
    const result = await db.query(
      `INSERT INTO org_action_config (org_id, linkedin_automation, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET linkedin_automation = org_action_config.linkedin_automation || $2::jsonb,
             updated_at          = CURRENT_TIMESTAMP,
             updated_by          = $3
       RETURNING linkedin_automation`,
      [orgId, JSON.stringify(validated), updatedBy]
    );
    return this._merge(result.rows[0].linkedin_automation || {});
  }

  // ── USER opt-in: org→user→system cascade ─────────────────────────────────
  // Mirrors personalizeConfig.resolvePersonalizeConfig. Returns the rep's
  // explicit choice, or null when unset (→ inherit system default OFF).
  static async getUserOptIn(database, { userId, orgId }) {
    if (!userId || !orgId) return null;
    try {
      const r = await database.query(
        `SELECT preferences->'linkedin_auto_connect' AS optin
           FROM user_preferences
          WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId]
      );
      const v = r.rows[0]?.optin;
      // jsonb true/false comes back as a JS boolean; anything else = unset.
      return typeof v === 'boolean' ? v : null;
    } catch (err) {
      console.warn('LinkedInAutomationConfig.getUserOptIn lookup failed:', err.message);
      return null;
    }
  }

  static async setUserOptIn(database, { userId, orgId }, optedIn) {
    const val = !!optedIn;
    await database.query(
      `INSERT INTO user_preferences (user_id, org_id, preferences)
       VALUES ($1, $2, jsonb_build_object('linkedin_auto_connect', $3::boolean))
       ON CONFLICT (user_id, org_id) DO UPDATE
         SET preferences = user_preferences.preferences
                           || jsonb_build_object('linkedin_auto_connect', $3::boolean),
             updated_at  = CURRENT_TIMESTAMP`,
      [userId, orgId, val]
    );
    return val;
  }

  // ── The gate the firer + claim endpoint actually call ────────────────────
  //
  // Returns:
  //   {
  //     enabled,      // boolean — org toggle AND explicit user opt-in
  //     source,       // 'user' (opted in) | 'user_off' (opted out) |
  //                   // 'system' (never chose) | 'org_off' (admin gate off)
  //     org,          // the merged org config (cap / jitter / window / lease)
  //   }
  //
  // `enabled` is the ONLY thing the firer should branch on. `org` rides along
  // so the claim endpoint can apply the cap and hand the window/jitter to the
  // extension without a second round-trip.
  static async resolveForUser(database, { orgId, userId }) {
    const org = await this.getForOrg(orgId, database);

    if (!org.auto_connect_enabled) {
      return { enabled: false, source: 'org_off', org };
    }
    const optIn = await this.getUserOptIn(database, { userId, orgId });
    if (optIn === true)  return { enabled: true,  source: 'user',     org };
    if (optIn === false) return { enabled: false, source: 'user_off', org };
    return { enabled: false, source: 'system', org };   // never chose → OFF
  }

  // ── Internal: merge a stored partial over the system defaults ────────────
  // Nested objects (jitter_seconds, human_hours) are replaced wholesale when
  // present, then backfilled key-by-key so a partial nested patch still
  // resolves to a complete object — same spirit as CallSettingsService._merge.
  static _merge(stored) {
    const s = (stored && typeof stored === 'object') ? stored : {};
    const out = { ...SYSTEM_DEFAULTS, ...s };
    out.jitter_seconds = {
      ...SYSTEM_DEFAULTS.jitter_seconds,
      ...(s.jitter_seconds && typeof s.jitter_seconds === 'object' ? s.jitter_seconds : {}),
    };
    out.human_hours = {
      ...SYSTEM_DEFAULTS.human_hours,
      ...(s.human_hours && typeof s.human_hours === 'object' ? s.human_hours : {}),
    };
    if (!Array.isArray(out.human_hours.days) || out.human_hours.days.length === 0) {
      out.human_hours.days = [...SYSTEM_DEFAULTS.human_hours.days];
    }
    return out;
  }

  // ── Internal: validate a patch before writing ────────────────────────────
  // Throws on any error; returns only the cleaned, allowed fields.
  static async _validatePatch(orgId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Patch must be an object');
    }
    const cleaned = {};

    if (patch.auto_connect_enabled !== undefined) {
      if (typeof patch.auto_connect_enabled !== 'boolean') {
        throw new Error('auto_connect_enabled must be a boolean');
      }
      cleaned.auto_connect_enabled = patch.auto_connect_enabled;
    }

    if (patch.daily_cap !== undefined) {
      const n = Number(patch.daily_cap);
      if (!Number.isInteger(n) || n < 1 || n > LIMITS.daily_cap_max) {
        throw new Error(`daily_cap must be an integer between 1 and ${LIMITS.daily_cap_max}`);
      }
      cleaned.daily_cap = n;
    }

    if (patch.lease_minutes !== undefined) {
      const n = Number(patch.lease_minutes);
      if (!Number.isInteger(n) || n < LIMITS.lease_minutes_min || n > LIMITS.lease_minutes_max) {
        throw new Error(`lease_minutes must be an integer between ${LIMITS.lease_minutes_min} and ${LIMITS.lease_minutes_max}`);
      }
      cleaned.lease_minutes = n;
    }

    if (patch.jitter_seconds !== undefined) {
      const j = patch.jitter_seconds;
      if (!j || typeof j !== 'object' || Array.isArray(j)) {
        throw new Error('jitter_seconds must be an object { min, max }');
      }
      // Merge over current so a partial patch keeps the other bound.
      const cur = (await this.getForOrg(orgId)).jitter_seconds;
      const min = Number(j.min !== undefined ? j.min : cur.min);
      const max = Number(j.max !== undefined ? j.max : cur.max);
      if (!Number.isInteger(min) || !Number.isInteger(max)) {
        throw new Error('jitter_seconds.min and .max must be integers');
      }
      if (min < LIMITS.jitter_min_floor) {
        throw new Error(`jitter_seconds.min must be at least ${LIMITS.jitter_min_floor}`);
      }
      if (max > LIMITS.jitter_max_ceiling) {
        throw new Error(`jitter_seconds.max must be at most ${LIMITS.jitter_max_ceiling}`);
      }
      if (max < min) {
        throw new Error('jitter_seconds.max must be >= jitter_seconds.min');
      }
      cleaned.jitter_seconds = { min, max };
    }

    if (patch.human_hours !== undefined) {
      const h = patch.human_hours;
      if (!h || typeof h !== 'object' || Array.isArray(h)) {
        throw new Error('human_hours must be an object { start_hour, end_hour, days }');
      }
      const cur = (await this.getForOrg(orgId)).human_hours;
      const start = Number(h.start_hour !== undefined ? h.start_hour : cur.start_hour);
      const end   = Number(h.end_hour   !== undefined ? h.end_hour   : cur.end_hour);
      if (!Number.isInteger(start) || start < 0 || start > 23) {
        throw new Error('human_hours.start_hour must be an integer 0..23');
      }
      if (!Number.isInteger(end) || end < 1 || end > 24) {
        throw new Error('human_hours.end_hour must be an integer 1..24');
      }
      if (end <= start) {
        throw new Error('human_hours.end_hour must be greater than start_hour');
      }
      let days = h.days !== undefined ? h.days : cur.days;
      if (!Array.isArray(days) || days.length === 0) {
        throw new Error('human_hours.days must be a non-empty array of weekday numbers 1..7');
      }
      const seen = new Set();
      for (const d of days) {
        const n = Number(d);
        if (!Number.isInteger(n) || n < 1 || n > 7) {
          throw new Error('human_hours.days entries must be integers 1..7 (1=Mon … 7=Sun)');
        }
        seen.add(n);
      }
      cleaned.human_hours = { start_hour: start, end_hour: end, days: [...seen].sort((a, b) => a - b) };
    }

    if (Object.keys(cleaned).length === 0) {
      throw new Error('No valid fields in patch');
    }
    return cleaned;
  }
}

module.exports = LinkedInAutomationConfig;
module.exports.SYSTEM_DEFAULTS = SYSTEM_DEFAULTS;
module.exports.LIMITS = LIMITS;
