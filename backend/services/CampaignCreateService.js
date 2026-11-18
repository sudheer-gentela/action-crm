// ─────────────────────────────────────────────────────────────────────────────
// CampaignCreateService.js
// ─────────────────────────────────────────────────────────────────────────────
// The one place a prospecting campaign gets created.
//
// Two callers share this:
//   • routes/prospecting-campaigns.routes.js  POST /        (the UI)
//   • mcp-server.mjs  create_prospecting_campaign            (agents)
//
// It exists so the agent path cannot drift from the UI path: every validation
// rule (playbook type, sequence/client/sender ownership, schedule bounds,
// target-profile seeding) lives here once. Callers own transport concerns
// only — auth, module gating, HTTP status mapping, MCP result shapes.
//
// The low-level helpers (loadCampaign, validateAndCoerceSchedule,
// coerceSenderIds, VALID_*) moved here from the route file verbatim. The route
// re-imports them under the same names because PUT /:id and friends still use
// them; moving rather than copying keeps a single definition.
//
// createCampaign() never throws for a caller mistake — it returns
// { ok:false, status, message } so each caller can render it in its own shape.
// It DOES throw on infrastructure failure (DB down); callers catch that.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');
const { sanitizeCampaignConfig, cleanTargeting } = require('../config/prospectingConfigSchema');
// Signal-Based Campaigns (P3): start-from-profile seed for new campaigns.
const TargetProfileService = require('./TargetProfileService');

const VALID_STATUS = ['active', 'paused', 'completed', 'archived'];
const VALID_ACTIVITY_TYPES = ['outreach', 'field_event', 'digital', 'discovery'];

// ─────────────────────────────────────────────────────────────────────────────
// Helper: load one campaign scoped to the org, or null.
// ─────────────────────────────────────────────────────────────────────────────
async function loadCampaign(orgId, id) {
  const { rows } = await pool.query(
    `SELECT c.*,
            pb.name AS playbook_name,
            sq.name AS default_sequence_name,
            sq.thread_replies AS default_sequence_thread_replies,
            u.first_name AS owner_first_name,
            u.last_name  AS owner_last_name,
            cl.name AS client_name
       FROM prospecting_campaigns c
       LEFT JOIN playbooks  pb ON pb.id = c.playbook_id
       LEFT JOIN sequences  sq ON sq.id = c.default_sequence_id
       LEFT JOIN users      u  ON u.id  = c.owner_id
       LEFT JOIN clients    cl ON cl.id = c.client_id
      WHERE c.id = $1 AND c.org_id = $2`,
    [id, orgId]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate sending-schedule override fields from req.body. Returns
// { values: {daily_activation_cap, send_window_start_hour, ...}, errors: [] }.
// Each output field is null if the caller didn't provide a value (meaning
// "inherit from org default"). Numeric fields are coerced to int; days to
// a sorted int array; timezone is IANA-validated.
// ─────────────────────────────────────────────────────────────────────────────
function validateAndCoerceSchedule(body) {
  const errors = [];
  const out = {
    daily_activation_cap:    null,
    send_window_start_hour:  null,
    send_window_start_minute: null,
    send_window_end_hour:    null,
    send_window_days:        null,
    send_window_timezone:    null,
    start_mode:              null,
    pacing_mode:             null,
    cadence_minutes:         null,
  };

  // Accept both camelCase (frontend) and snake_case (idiomatic API) names.
  const raw = {
    daily_activation_cap:    body.daily_activation_cap    ?? body.dailyActivationCap ?? body.linkedinReleaseCap,
    send_window_start_hour:  body.send_window_start_hour  ?? body.sendWindowStartHour,
    send_window_start_minute: body.send_window_start_minute ?? body.sendWindowStartMinute,
    send_window_end_hour:    body.send_window_end_hour    ?? body.sendWindowEndHour,
    send_window_days:        body.send_window_days        ?? body.sendWindowDays,
    send_window_timezone:    body.send_window_timezone    ?? body.sendWindowTimezone,
    start_mode:              body.start_mode              ?? body.startMode,
    pacing_mode:             body.pacing_mode             ?? body.pacingMode,
    cadence_minutes:         body.cadence_minutes         ?? body.cadenceMinutes,
  };

  if (raw.daily_activation_cap !== undefined && raw.daily_activation_cap !== null && raw.daily_activation_cap !== '') {
    const n = parseInt(raw.daily_activation_cap, 10);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      errors.push('daily_activation_cap must be an integer 1-500');
    } else out.daily_activation_cap = n;
  }
  if (raw.send_window_start_hour !== undefined && raw.send_window_start_hour !== null && raw.send_window_start_hour !== '') {
    const n = parseInt(raw.send_window_start_hour, 10);
    if (!Number.isFinite(n) || n < 0 || n > 23) {
      errors.push('send_window_start_hour must be 0-23');
    } else out.send_window_start_hour = n;
  }
  if (raw.send_window_start_minute !== undefined && raw.send_window_start_minute !== null && raw.send_window_start_minute !== '') {
    const n = parseInt(raw.send_window_start_minute, 10);
    if (!Number.isFinite(n) || n < 0 || n > 59) {
      errors.push('send_window_start_minute must be 0-59');
    } else out.send_window_start_minute = n;
  }
  if (raw.start_mode !== undefined && raw.start_mode !== null && raw.start_mode !== '') {
    if (!['on_activate', 'fixed', 'fixed_or_now'].includes(raw.start_mode)) {
      errors.push('start_mode must be on_activate, fixed, or fixed_or_now');
    } else out.start_mode = raw.start_mode;
  }
  if (raw.pacing_mode !== undefined && raw.pacing_mode !== null && raw.pacing_mode !== '') {
    if (!['cadence', 'spread'].includes(raw.pacing_mode)) {
      errors.push('pacing_mode must be cadence or spread');
    } else out.pacing_mode = raw.pacing_mode;
  }
  if (raw.cadence_minutes !== undefined && raw.cadence_minutes !== null && raw.cadence_minutes !== '') {
    const n = parseInt(raw.cadence_minutes, 10);
    if (!Number.isFinite(n) || n < 1 || n > 240) {
      errors.push('cadence_minutes must be 1-240');
    } else out.cadence_minutes = n;
  }
  if (raw.send_window_end_hour !== undefined && raw.send_window_end_hour !== null && raw.send_window_end_hour !== '') {
    const n = parseInt(raw.send_window_end_hour, 10);
    if (!Number.isFinite(n) || n < 1 || n > 24) {
      errors.push('send_window_end_hour must be 1-24');
    } else out.send_window_end_hour = n;
  }
  if (out.send_window_start_hour !== null && out.send_window_end_hour !== null
      && out.send_window_end_hour <= out.send_window_start_hour) {
    errors.push(
      `send_window_end_hour (${out.send_window_end_hour}:00) must be after ` +
      `send_window_start_hour (${out.send_window_start_hour}:00)`
    );
  }
  if (raw.send_window_days !== undefined && raw.send_window_days !== null) {
    if (!Array.isArray(raw.send_window_days)) {
      errors.push('send_window_days must be an array');
    } else if (raw.send_window_days.length === 0) {
      // Empty array → treat as "no override" rather than error
      out.send_window_days = null;
    } else {
      const dedup = [...new Set(raw.send_window_days.map(d => parseInt(d, 10)))];
      if (dedup.some(d => isNaN(d) || d < 0 || d > 6)) {
        errors.push('send_window_days entries must be 0..6 (0=Sun..6=Sat)');
      } else {
        out.send_window_days = dedup.sort();
      }
    }
  }
  if (raw.send_window_timezone !== undefined && raw.send_window_timezone !== null && raw.send_window_timezone !== '') {
    if (typeof raw.send_window_timezone !== 'string') {
      errors.push('send_window_timezone must be a string');
    } else {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: raw.send_window_timezone });
        out.send_window_timezone = raw.send_window_timezone.trim();
      } catch (_) {
        errors.push(`send_window_timezone "${raw.send_window_timezone}" is not a valid IANA timezone`);
      }
    }
  }

  // Cross-field guard for the end-after-start rule lives above (the `!== null`
  // check), which correctly skips when only one bound is provided in this
  // payload — the other is inherited and the resolver clamps that cross-layer
  // case. (A prior duplicate guard here used `!== undefined`, which let the
  // null-initialized fields through and mis-fired "end (null:00) must be after
  // start" on any payload that set only the start hour.)

  return { values: out, errors };
}

// Coerce + validate a campaign's selected sender accounts (Phase 2).
// Accepts body.sender_account_ids / senderAccountIds as an array of ids (or a
// comma-separated string). Returns { provided, ids, error }:
//   provided=false → the field wasn't in the body (leave existing untouched)
//   ids=null       → explicit "all senders" (empty/cleared)
//   ids=[...]      → validated subset (each must be one of ownerId's own active,
//                    non-client senders in this org — prevents borrowing another
//                    user's mailbox or a deactivated one).
async function coerceSenderIds(body, orgId, ownerId) {
  const has = Object.prototype.hasOwnProperty.call(body, 'sender_account_ids')
           || Object.prototype.hasOwnProperty.call(body, 'senderAccountIds');
  if (!has) return { provided: false, ids: null, error: null };

  let raw = body.sender_account_ids ?? body.senderAccountIds;
  if (typeof raw === 'string') raw = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
    return { provided: true, ids: null, error: null }; // explicit "all senders"
  }
  if (!Array.isArray(raw)) return { provided: true, ids: null, error: 'sender_account_ids must be an array of ids' };

  const ids = [...new Set(raw.map(n => parseInt(n, 10)))];
  if (ids.some(n => !Number.isInteger(n))) {
    return { provided: true, ids: null, error: 'sender_account_ids must be integers' };
  }
  // Every id must be one of this owner's own active senders.
  const { rows } = await pool.query(
    `SELECT id FROM prospecting_sender_accounts
      WHERE org_id = $1 AND user_id = $2 AND client_id IS NULL AND is_active = true
        AND id = ANY($3)`,
    [orgId, ownerId, ids]
  );
  const valid = new Set(rows.map(r => r.id));
  const bad = ids.filter(id => !valid.has(id));
  if (bad.length) {
    return { provided: true, ids: null, error: `Not your active sender account(s): ${bad.join(', ')}` };
  }
  return { provided: true, ids, error: null };
}

// Caller-mistake result. Status codes match what POST / has always returned,
// so the route can pass them straight through and the UI sees no change.
const reject = (status, message) => ({ ok: false, status, message });

/**
 * Create a prospecting campaign.
 *
 * @param {object}   args
 * @param {number}   args.orgId    - org the campaign belongs to (never from the body)
 * @param {number}   args.userId   - the creator; becomes created_by, and owner_id by default
 * @param {object}   args.input    - request-shaped fields (same names POST / accepts)
 * @param {Function} args.isAdmin  - async () => boolean. Called ONLY when input
 *                                   asks for a different owner, so callers that
 *                                   never pass owner_id never pay for the lookup.
 * @returns {Promise<{ok:true, campaign:object} | {ok:false, status:number, message:string}>}
 */
async function createCampaign({ orgId, userId, input, isAdmin }) {
  const body = input || {};
  const {
    name, description, solution,
    playbook_id, default_sequence_id,
    goal_qualified, start_date, end_date,
    status = 'active',
    activity_type = 'outreach',
    owner_id: bodyOwnerId,
    share_weight: bodyShareWeight,
    // Signal-Based Campaigns (P3): optional targeting seed. A campaign may
    // start from a Target Profile (target_profile_id) and/or supply an inline
    // targeting block; both are copied into prospecting_config_override.targeting
    // (template semantics — no live link to the profile).
    target_profile_id: bodyProfileId,
    targeting: bodyTargeting,
    // Agency Phase 1 (2026_52): a campaign may run for one agency client.
    // Accept both naming styles, same as the schedule fields.
    client_id: bodyClientIdSnake,
    clientId:  bodyClientIdCamel,
  } = body;

  if (!name || !String(name).trim()) {
    return reject(400, 'name is required');
  }
  if (!VALID_STATUS.includes(status)) {
    return reject(400, `status must be one of: ${VALID_STATUS.join(', ')}`);
  }
  if (!VALID_ACTIVITY_TYPES.includes(activity_type)) {
    return reject(400, `activity_type must be one of: ${VALID_ACTIVITY_TYPES.join(', ')}`);
  }

  // ── owner_id resolution ──────────────────────────────────────────────────
  // Default: the creator owns. Admins can pass an explicit owner_id to
  // create a campaign on behalf of another rep (e.g. onboarding a new hire,
  // pre-loading their pipeline). Non-admins may not.
  let resolvedOwnerId = userId;
  if (bodyOwnerId !== undefined && bodyOwnerId !== null && parseInt(bodyOwnerId, 10) !== userId) {
    const callerIsAdmin = typeof isAdmin === 'function' ? await isAdmin() : false;
    if (!callerIsAdmin) {
      return reject(403,
        "You don't have permission to create a campaign owned by another user. Only admins can set owner_id.");
    }
    // Validate the supplied owner is an active member of this org.
    const ownerCheck = await pool.query(
      `SELECT 1 FROM org_users WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE`,
      [parseInt(bodyOwnerId, 10), orgId]
    );
    if (!ownerCheck.rows.length) {
      return reject(400, `owner_id ${bodyOwnerId} is not an active member of this org.`);
    }
    resolvedOwnerId = parseInt(bodyOwnerId, 10);
  }

  // Sending-schedule overrides (all nullable — NULL means "inherit org default")
  const sched = validateAndCoerceSchedule(body);
  if (sched.errors.length) {
    return reject(400, sched.errors.join('; '));
  }

  // Validate playbook belongs to this org and is a prospecting playbook.
  if (playbook_id) {
    const pb = await pool.query(
      `SELECT id, type FROM playbooks WHERE id = $1 AND org_id = $2`,
      [playbook_id, orgId]
    );
    if (!pb.rows.length) {
      return reject(400, 'Playbook not found in this org');
    }
    if (pb.rows[0].type !== 'prospecting') {
      return reject(400, 'Campaign playbook must be a prospecting playbook');
    }
  }

  // Validate sequence belongs to this org.
  if (default_sequence_id) {
    const sq = await pool.query(
      `SELECT id FROM sequences WHERE id = $1 AND org_id = $2`,
      [default_sequence_id, orgId]
    );
    if (!sq.rows.length) {
      return reject(400, 'Sequence not found in this org');
    }
  }

  // Agency Phase 1 (2026_52): validate client belongs to this org and is
  // not archived. NULL/absent → ordinary (non-client) campaign, unchanged.
  let resolvedClientId = null;
  {
    const rawClientId = bodyClientIdSnake ?? bodyClientIdCamel;
    if (rawClientId !== undefined && rawClientId !== null && rawClientId !== '') {
      const cid = parseInt(rawClientId, 10);
      if (!Number.isFinite(cid)) {
        return reject(400, 'client_id must be a valid client id');
      }
      const cl = await pool.query(
        `SELECT id FROM clients WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [cid, orgId]
      );
      if (!cl.rows.length) {
        return reject(400, 'Client not found in this org (or archived)');
      }
      resolvedClientId = cid;
    }
  }

  // Validate share_weight (0..100) if provided.
  let shareWeightVal = null;
  if (bodyShareWeight !== undefined && bodyShareWeight !== null && bodyShareWeight !== '') {
    const w = parseInt(bodyShareWeight, 10);
    if (!Number.isFinite(w) || w < 0 || w > 100) {
      return reject(400, 'share_weight must be 0..100');
    }
    shareWeightVal = w;
  }

  // Per-campaign sender selection (Phase 2) — validate against the owner's
  // own active senders; NULL = all senders.
  const senderSel = await coerceSenderIds(body, orgId, resolvedOwnerId);
  if (senderSel.error) {
    return reject(400, senderSel.error);
  }

  // ── Targeting seed (P3, D4) ──────────────────────────────────────────────
  // Start from a Target Profile if given, merge any inline targeting on top,
  // then copy the result into prospecting_config_override.targeting. This is
  // a COPY — no live link to the profile (template semantics), so later
  // profile edits never mutate this campaign. Absent both ⇒ no override (the
  // campaign starts with empty targeting; every qualifier becomes a Work-time
  // confirmation, per the "blank source allowed" rule).
  let configOverride = null;
  if (bodyProfileId != null || bodyTargeting != null) {
    let targeting;
    if (bodyProfileId != null) {
      const profile = await TargetProfileService.getProfile({ orgId, id: parseInt(bodyProfileId, 10) });
      if (!profile) {
        return reject(400, `Target profile ${bodyProfileId} not found in this org`);
      }
      targeting = await TargetProfileService.applyToCampaign({
        orgId, profileId: profile.id, overrides: bodyTargeting || null,
      });
    } else {
      targeting = cleanTargeting(bodyTargeting);
    }
    // Persist as a config override that carries ONLY the targeting section;
    // the resolver treats absent sections as "inherit", so this doesn't
    // clobber any org-level personalization config.
    const base = sanitizeCampaignConfig(null);
    configOverride = { ...base, targeting };
  }

  const { rows } = await pool.query(
    `INSERT INTO prospecting_campaigns
           (org_id, name, description, solution, playbook_id, default_sequence_id,
            goal_qualified, start_date, end_date, status, activity_type, owner_id, created_by,
            daily_activation_cap, send_window_start_hour, send_window_end_hour,
            send_window_days, send_window_timezone,
            send_window_start_minute, start_mode, pacing_mode, cadence_minutes,
            share_weight, sender_account_ids, prospecting_config_override, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING *`,
    [
      orgId, String(name).trim(), description || null, solution || null,
      playbook_id || null, default_sequence_id || null,
      goal_qualified || null, start_date || null, end_date || null,
      status,
      activity_type,      // D16 — metadata; drives which Execution fields show
      resolvedOwnerId,    // owner_id — may differ from creator when admin assigns
      userId,             // created_by — always the actual creator (audit)
      sched.values.daily_activation_cap,
      sched.values.send_window_start_hour,
      sched.values.send_window_end_hour,
      sched.values.send_window_days,
      sched.values.send_window_timezone,
      sched.values.send_window_start_minute,
      sched.values.start_mode,
      sched.values.pacing_mode,
      sched.values.cadence_minutes,
      shareWeightVal,
      senderSel.ids,      // sender_account_ids — NULL = all senders
      configOverride ? JSON.stringify(configOverride) : null,
      resolvedClientId,   // client_id — Agency Phase 1; NULL = ordinary campaign
    ]
  );

  const campaign = await loadCampaign(orgId, rows[0].id);
  return { ok: true, campaign };
}

module.exports = {
  createCampaign,
  loadCampaign,
  validateAndCoerceSchedule,
  coerceSenderIds,
  VALID_STATUS,
  VALID_ACTIVITY_TYPES,
};
