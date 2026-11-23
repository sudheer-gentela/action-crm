/**
 * services/ai/AiSpendGuard.js
 *
 * Phase 1, step 1.1a — the two controls that sit in front of every AI call:
 *
 *   1. ORG KILL SWITCH. An org admin can turn AI off for the whole org, with
 *      a reason. Stored in org_action_config.ai_settings (ai_enabled false +
 *      reason/by/at) and audited in ai_kill_switch_log. While off, every
 *      org-scoped resolve() throws and inbound email analysis is skipped.
 *
 *   2. PER-PERSON DAILY BUDGET. Each person may spend up to their limit in
 *      AI cost per day: an admin-set override (ai_user_budgets) or the org
 *      default (ai_settings.daily_budget_usd, $3 when unset). The "day" is
 *      the org's day — midnight in the prospecting send-window timezone,
 *      UTC when none is set. All AI spend counts as one figure regardless of
 *      feature; getUsage() breaks it down by area for the admin screen.
 *      Spend on the person's OWN key (key_source='user') does not count —
 *      the org isn't paying for it.
 *
 * Both checks are called from AIClientResolver.resolve(), which every model
 * call in the app goes through, so one guard covers agents, skills, routes
 * and background enhancers alike. Background callers already catch resolve()
 * errors and fall back to rule-based output; interactive routes map the
 * error codes to clean responses via utils/aiGateErrors.js.
 *
 * KNOWN OVERSHOOT. The budget is checked BEFORE a call but its cost is only
 * known AFTER, so a person can finish at most the in-flight call(s) above
 * their limit. TokenTrackingService.log() calls recordSpend() so this
 * process sees the new total immediately; other processes (web vs worker)
 * see it when their short cache expires (SPEND_TTL_MS).
 *
 * CALLS WITH NO PERSON. resolve(orgId, null, …) has nobody to charge, and
 * TokenTrackingService.log() doesn't record calls without a userId either,
 * so those are outside the budget. The kill switch still stops them.
 */

const db = require('../../config/database');
const { isValidTimeZone, formatStampInZone } = require('../../utils/repTimezone');

const DEFAULT_DAILY_BUDGET_USD = 3;
const MAX_DAILY_BUDGET_USD     = 1000;   // guards against a typo like 3000 for 3.000

// Kill switch / default limit / timezone change rarely and are read on every
// AI call, so they're cached briefly. The process that saves a change clears
// its own cache at once; other processes pick it up within this window.
const SETTINGS_TTL_MS = 30 * 1000;
// Spend is cached even more briefly and bumped locally after each call, so a
// person in the middle of a burst is stopped promptly without a SUM per call.
const SPEND_TTL_MS    = 15 * 1000;

const _settingsCache = new Map();   // orgId → { at, value }
const _spendCache    = new Map();   // `${orgId}:${userId}` → { at, spentUsd, overrideLimitUsd, dayKey, resetsAt, timezone }

// ── Areas ────────────────────────────────────────────────────────────────
// One budget, but the admin needs to see where it went. Mapped from
// call_type with prefixes so new call types land in a sensible bucket
// without code changes; anything unrecognised shows as "Other".
const AREA_LABELS = {
  research:      'Prospect research',
  email_writing: 'Email writing',
  prospecting:   'Prospecting (other)',
  deals:         'Deals & CRM',
  meetings:      'Meetings',
  straps:        'STRAPs',
  contracts:     'Contracts',
  workflow:      'Workflow',
  reports:       'Reports',
  other:         'Other',
};

function areaFor(callType) {
  const ct = String(callType || '');
  if (ct.startsWith('prospecting_research'))                  return 'research';
  if (ct === 'prospecting_draft' || ct === 'prospecting_sequence_generate') return 'email_writing';
  if (ct.startsWith('prospecting_'))                          return 'prospecting';
  if (ct.startsWith('strap_'))                                return 'straps';
  if (ct.startsWith('clm_'))                                  return 'contracts';
  if (ct === 'transcript_analysis' || ct === 'context_suggest') return 'meetings';
  if (ct === 'action_completion_detect')                      return 'workflow';
  if (ct === 'baseline_report')                               return 'reports';
  if ([
    'action_generation', 'ai_enhancement', 'email_analysis', 'deal_health_check',
    'agent_proposal', 'discovery_call_prep', 'playbook_action_generation',
  ].includes(ct))                                             return 'deals';
  return 'other';
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _round2(n) { return Math.round(Number(n) * 100) / 100; }

function _money(n) { return `$${Number(n || 0).toFixed(2)}`; }

/** Parse an admin-entered limit. Returns a number (2dp) or null if invalid. */
function parseLimit(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_DAILY_BUDGET_USD) return null;
  return _round2(n);
}

function _gateError(statusCode, code, message, extra = {}) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code       = code;
  Object.assign(e, extra);
  return e;
}

// ── Org settings (kill switch, default limit, timezone) ──────────────────

async function getOrgAiSettings(orgId, { fresh = false } = {}) {
  const hit = _settingsCache.get(orgId);
  if (!fresh && hit && (Date.now() - hit.at) < SETTINGS_TTL_MS) return hit.value;

  const r = await db.query(
    `SELECT
       (SELECT ai_settings FROM org_action_config WHERE org_id = $1) AS ai,
       (SELECT config->>'sendWindowTimezone'
          FROM org_integrations
         WHERE org_id = $1 AND integration_type = 'prospecting_email'
         LIMIT 1) AS tz`,
    [orgId]
  );
  const ai    = r.rows[0]?.ai || {};
  const tzRaw = r.rows[0]?.tz;
  const storedDefault = parseLimit(ai.daily_budget_usd);

  const value = {
    aiEnabled:       ai.ai_enabled !== false,               // default ON
    disabledReason:  ai.ai_disabled_reason || null,
    disabledBy:      ai.ai_disabled_by     || null,
    disabledAt:      ai.ai_disabled_at     || null,
    defaultLimitUsd: storedDefault === null ? DEFAULT_DAILY_BUDGET_USD : storedDefault,
    timezone:        isValidTimeZone(tzRaw) ? tzRaw : 'UTC',
  };
  _settingsCache.set(orgId, { at: Date.now(), value });
  return value;
}

async function isOrgAiEnabled(orgId) {
  if (orgId == null) return true;
  try {
    return (await getOrgAiSettings(orgId)).aiEnabled;
  } catch (err) {
    // Fail open on a lookup error: if the DB is unreachable the AI call that
    // follows fails anyway, and a transient blip shouldn't read as "an admin
    // turned AI off".
    console.warn(`[ai-spend-guard] settings lookup failed for org ${orgId}; allowing:`, err.message);
    return true;
  }
}

async function assertOrgAiEnabled(orgId) {
  if (orgId == null) return;
  if (!(await isOrgAiEnabled(orgId))) {
    throw _gateError(403, 'AI_DISABLED_BY_ORG',
      'AI is turned off for your organization by an admin.');
  }
}

// ── Daily spend ──────────────────────────────────────────────────────────

/**
 * Today's counted spend for one person plus everything needed to judge it.
 * Returns { spentUsd, limitUsd, hasOverride, dayKey, resetsAt (Date), timezone }.
 */
async function getSpendState(orgId, userId, { fresh = false } = {}) {
  const settings = await getOrgAiSettings(orgId);
  const key = `${orgId}:${userId}`;
  const hit = _spendCache.get(key);
  const now = Date.now();

  let entry = hit;
  const stale = !hit
    || fresh
    || (now - hit.at) >= SPEND_TTL_MS
    || now >= hit.resetsAt.getTime()          // crossed midnight
    || hit.timezone !== settings.timezone;    // admin changed the org timezone

  if (stale) {
    // created_at is a naive timestamp holding UTC wall time (DB convention),
    // so the org's local midnight is converted back to naive UTC to compare.
    const r = await db.query(
      `WITH w AS (SELECT date_trunc('day', now() AT TIME ZONE $3::text) AS lm)
       SELECT
         COALESCE((
           SELECT SUM(t.estimated_cost_usd)
             FROM ai_token_usage t
            WHERE t.org_id  = $1
              AND t.user_id = $2
              AND t.key_source IS DISTINCT FROM 'user'
              AND t.created_at >= ((w.lm AT TIME ZONE $3::text) AT TIME ZONE 'UTC')
         ), 0)::float8                                                  AS spent,
         (SELECT b.daily_limit_usd FROM ai_user_budgets b
           WHERE b.org_id = $1 AND b.user_id = $2)::float8              AS override_limit,
         w.lm::date::text                                               AS day_key,
         ((w.lm + interval '1 day') AT TIME ZONE $3::text)              AS resets_at
       FROM w`,
      [orgId, userId, settings.timezone]
    );
    const row = r.rows[0] || {};
    entry = {
      at:               now,
      spentUsd:         Number(row.spent) || 0,
      overrideLimitUsd: row.override_limit === null || row.override_limit === undefined
        ? null : Number(row.override_limit),
      dayKey:           row.day_key,
      resetsAt:         row.resets_at instanceof Date ? row.resets_at : new Date(row.resets_at),
      timezone:         settings.timezone,
    };
    _spendCache.set(key, entry);
  }

  const hasOverride = entry.overrideLimitUsd !== null;
  return {
    spentUsd:    entry.spentUsd,
    limitUsd:    hasOverride ? entry.overrideLimitUsd : settings.defaultLimitUsd,
    hasOverride,
    dayKey:      entry.dayKey,
    resetsAt:    entry.resetsAt,
    timezone:    entry.timezone,
  };
}

/**
 * Called by TokenTrackingService.log() after each recorded call so this
 * process sees the new total without waiting for the cache to expire.
 * Only bumps an existing, same-day entry — a missing entry is simply read
 * fresh (and therefore correctly) on the next check.
 */
function recordSpend({ orgId, userId, keySource, costUsd }) {
  if (orgId == null || userId == null || keySource === 'user') return;
  const n = Number(costUsd);
  if (!Number.isFinite(n) || n <= 0) return;
  const entry = _spendCache.get(`${orgId}:${userId}`);
  if (entry && Date.now() < entry.resetsAt.getTime()) entry.spentUsd += n;
}

/**
 * Throws AI_DAILY_BUDGET_REACHED (429) if this person has used up today's
 * budget. No-op for platform calls, calls with no person, and calls on the
 * person's own key.
 */
async function assertWithinBudget(orgId, userId, keySource) {
  if (orgId == null || userId == null || keySource === 'user') return;

  let state;
  try {
    state = await getSpendState(orgId, userId);
  } catch (err) {
    // Same fail-open reasoning as isOrgAiEnabled: a lookup failure is not
    // evidence of overspend.
    console.warn(`[ai-spend-guard] spend lookup failed for org ${orgId} user ${userId}; allowing:`, err.message);
    return;
  }

  if (state.spentUsd < state.limitUsd) return;

  const resetsLabel = formatStampInZone(state.resetsAt, state.timezone);
  const msg = state.limitUsd === 0
    ? `AI is paused for you: your daily AI limit is set to $0. An org admin can change it.`
    : `You've reached today's AI budget of ${_money(state.limitUsd)} ` +
      `(${_money(state.spentUsd)} used). AI features are paused for you until ` +
      `${resetsLabel}. An org admin can raise your limit.`;

  // Fire-and-forget: the notification must never delay or break the block.
  notifyBudgetReached(orgId, userId, state).catch(err =>
    console.warn('[ai-spend-guard] budget notification failed:', err.message));

  throw _gateError(429, 'AI_DAILY_BUDGET_REACHED', msg, {
    spentUsd: _round2(state.spentUsd),
    limitUsd: state.limitUsd,
    resetsAt: state.resetsAt.toISOString(),
  });
}

// ── Notifications (once per person per org-day) ──────────────────────────

async function notifyBudgetReached(orgId, userId, state) {
  // The INSERT is the once-a-day lock: only the call that creates the row
  // sends notifications, even if web and worker block at the same moment.
  const claim = await db.query(
    `INSERT INTO ai_budget_alerts (org_id, user_id, day, limit_usd, spent_usd)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (org_id, user_id, day) DO NOTHING
     RETURNING day`,
    [orgId, userId, state.dayKey, state.limitUsd, _round2(state.spentUsd)]
  );
  if (claim.rows.length === 0) return false;

  // Lazy require: notificationService pulls in the job queue, which the
  // resolver (loaded by nearly everything) shouldn't drag along at boot.
  const { createNotification } = require('../notificationService');

  const [userRes, adminRes] = await Promise.all([
    db.query(`SELECT first_name, last_name, email FROM users WHERE id = $1`, [userId]),
    db.query(
      `SELECT user_id FROM org_users
        WHERE org_id = $1 AND is_active = TRUE AND role IN ('owner','admin')`,
      [orgId]
    ),
  ]);
  const u    = userRes.rows[0] || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || `User ${userId}`;
  const resetsLabel = formatStampInZone(state.resetsAt, state.timezone);
  const meta = {
    subject_user_id: userId,
    day:             state.dayKey,
    limit_usd:       state.limitUsd,
    spent_usd:       _round2(state.spentUsd),
    resets_at:       state.resetsAt.toISOString(),
  };

  await createNotification(
    orgId, userId, 'ai_budget_reached',
    `You've reached today's AI budget (${_money(state.limitUsd)})`,
    `AI features, including agent work, are paused for you until ${resetsLabel}. ` +
    `Work using your own API key isn't affected. Ask an org admin if you need a higher limit.`,
    null, null, meta
  );

  for (const { user_id: adminId } of adminRes.rows) {
    if (adminId === userId) continue;   // they already got the personal one
    await createNotification(
      orgId, adminId, 'ai_budget_reached_admin',
      `${name} reached today's AI budget (${_money(state.limitUsd)})`,
      `AI is paused for ${name} until ${resetsLabel}. You can change their limit in ` +
      `Org Admin → AI Providers → Usage & limits.`,
      null, null, meta
    );
  }
  return true;
}

// ── Admin writes ─────────────────────────────────────────────────────────

function invalidateOrg(orgId) {
  _settingsCache.delete(orgId);
  for (const k of _spendCache.keys()) {
    if (k.startsWith(`${orgId}:`)) _spendCache.delete(k);
  }
}

async function _mergeAiSettings(client, orgId, patch, updatedBy) {
  await client.query(
    `INSERT INTO org_action_config (org_id, ai_settings, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (org_id) DO UPDATE
       SET ai_settings = org_action_config.ai_settings || $2::jsonb,
           updated_by  = $3,
           updated_at  = NOW()`,
    [orgId, JSON.stringify(patch), updatedBy]
  );
}

async function setDefaultLimit(orgId, usd, updatedBy) {
  const n = parseLimit(usd);
  if (n === null) {
    throw _gateError(400, 'INVALID_LIMIT',
      `Daily budget must be a number between 0 and ${MAX_DAILY_BUDGET_USD}.`);
  }
  await _mergeAiSettings(db, orgId, { daily_budget_usd: n }, updatedBy);
  invalidateOrg(orgId);
  return n;
}

/** usd = null clears the override (person goes back to the org default). */
async function setUserLimit(orgId, userId, usd, updatedBy) {
  const member = await db.query(
    `SELECT 1 FROM org_users WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId]
  );
  if (member.rows.length === 0) {
    throw _gateError(404, 'NOT_FOUND', 'That person is not in this organization.');
  }

  if (usd === null) {
    await db.query(`DELETE FROM ai_user_budgets WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    _spendCache.delete(`${orgId}:${userId}`);
    return null;
  }

  const n = parseLimit(usd);
  if (n === null) {
    throw _gateError(400, 'INVALID_LIMIT',
      `Daily limit must be a number between 0 and ${MAX_DAILY_BUDGET_USD}, or empty for the org default.`);
  }
  await db.query(
    `INSERT INTO ai_user_budgets (org_id, user_id, daily_limit_usd, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (org_id, user_id) DO UPDATE
       SET daily_limit_usd = EXCLUDED.daily_limit_usd,
           updated_by      = EXCLUDED.updated_by,
           updated_at      = now()`,
    [orgId, userId, n, updatedBy]
  );
  _spendCache.delete(`${orgId}:${userId}`);
  return n;
}

/**
 * Flip the org kill switch. A reason is required to turn AI off (it is shown
 * to admins and kept in the audit log); optional when turning it back on.
 * State change and audit row are one transaction so the log can't miss a flip.
 */
async function setKillSwitch(orgId, { enabled, reason }, changedBy) {
  if (typeof enabled !== 'boolean') {
    throw _gateError(400, 'INVALID_INPUT', 'enabled must be true or false.');
  }
  const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
  if (!enabled && !why) {
    throw _gateError(400, 'REASON_REQUIRED', 'Please give a reason for turning AI off.');
  }

  const patch = enabled
    ? { ai_enabled: true,  ai_disabled_reason: null, ai_disabled_by: null, ai_disabled_at: null }
    : { ai_enabled: false, ai_disabled_reason: why, ai_disabled_by: changedBy,
        ai_disabled_at: new Date().toISOString() };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await _mergeAiSettings(client, orgId, patch, changedBy);
    await client.query(
      `INSERT INTO ai_kill_switch_log (org_id, enabled, reason, changed_by)
       VALUES ($1, $2, $3, $4)`,
      [orgId, enabled, why || null, changedBy]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
  invalidateOrg(orgId);
  return { enabled, reason: why || null };
}

// ── Admin read: usage screen ─────────────────────────────────────────────

/**
 * Everything the "Usage & limits" screen shows, in the org's timezone:
 * per person today (counted vs own-key), limit and whether it's an
 * override, the last `days` days, and a by-area breakdown for both.
 */
async function getUsage(orgId, days = 7) {
  const nDays    = Math.min(Math.max(parseInt(days, 10) || 7, 1), 31);
  const settings = await getOrgAiSettings(orgId, { fresh: true });
  const tz       = settings.timezone;

  const winRes = await db.query(
    `WITH w AS (SELECT date_trunc('day', now() AT TIME ZONE $1::text) AS lm)
     SELECT
       w.lm::date::text                                                         AS day_key,
       ((w.lm + interval '1 day') AT TIME ZONE $1::text)                        AS resets_at,
       ((w.lm - ($2::int - 1) * interval '1 day') AT TIME ZONE $1::text)        AS range_start,
       ARRAY(SELECT to_char(d, 'YYYY-MM-DD')
               FROM generate_series(w.lm - ($2::int - 1) * interval '1 day', w.lm, interval '1 day') d) AS day_list
     FROM w`,
    [tz, nDays]
  );
  const win = winRes.rows[0];

  const [membersRes, overridesRes, usageRes, logRes] = await Promise.all([
    db.query(
      `SELECT ou.user_id, ou.role, u.first_name, u.last_name, u.email
         FROM org_users ou
         JOIN users u ON u.id = ou.user_id
        WHERE ou.org_id = $1 AND ou.is_active = TRUE
        ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST, u.email`,
      [orgId]
    ),
    db.query(
      `SELECT user_id, daily_limit_usd::float8 AS limit_usd
         FROM ai_user_budgets WHERE org_id = $1`,
      [orgId]
    ),
    db.query(
      `SELECT user_id, call_type,
              (((created_at AT TIME ZONE 'UTC') AT TIME ZONE $2::text)::date)::text AS day,
              COALESCE(SUM(estimated_cost_usd) FILTER (WHERE key_source IS DISTINCT FROM 'user'), 0)::float8 AS counted_usd,
              COALESCE(SUM(estimated_cost_usd) FILTER (WHERE key_source = 'user'), 0)::float8              AS byok_usd,
              COUNT(*)::int AS calls
         FROM ai_token_usage
        WHERE org_id = $1
          AND created_at >= ($3::timestamptz AT TIME ZONE 'UTC')
        GROUP BY 1, 2, 3`,
      [orgId, tz, win.range_start]
    ),
    db.query(
      `SELECT l.enabled, l.reason, l.changed_at, l.changed_by,
              NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS changed_by_name,
              u.email AS changed_by_email
         FROM ai_kill_switch_log l
         LEFT JOIN users u ON u.id = l.changed_by
        WHERE l.org_id = $1
        ORDER BY l.changed_at DESC
        LIMIT 10`,
      [orgId]
    ),
  ]);

  const overrides = new Map(overridesRes.rows.map(r => [r.user_id, Number(r.limit_usd)]));

  const people = new Map();
  const ensure = (userId, base = {}) => {
    if (!people.has(userId)) {
      const daily = {};
      for (const d of win.day_list) daily[d] = 0;
      people.set(userId, {
        user_id: userId,
        name: base.name || `User ${userId}`,
        email: base.email || null,
        role: base.role || null,
        active_member: !!base.active_member,
        today_usd: 0, today_byok_usd: 0, today_calls: 0,
        week_usd: 0,  week_byok_usd: 0,  week_calls: 0,
        daily,
        today_by_area: {}, week_by_area: {},
      });
    }
    return people.get(userId);
  };

  for (const m of membersRes.rows) {
    ensure(m.user_id, {
      name: [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email,
      email: m.email, role: m.role, active_member: true,
    });
  }

  const orgByArea = {};
  let orgToday = 0, orgWeek = 0, orgTodayByok = 0, orgWeekByok = 0;

  const bump = (bucket, area, usd, byok, calls) => {
    const a = bucket[area] || (bucket[area] = { area, label: AREA_LABELS[area], usd: 0, byok_usd: 0, calls: 0 });
    a.usd += usd; a.byok_usd += byok; a.calls += calls;
  };

  for (const r of usageRes.rows) {
    // Someone who has left the org but spent within the window still shows,
    // so the totals add up.
    const p     = ensure(r.user_id);
    const area  = areaFor(r.call_type);
    const usd   = Number(r.counted_usd) || 0;
    const byok  = Number(r.byok_usd)    || 0;
    const calls = Number(r.calls)       || 0;

    p.week_usd += usd; p.week_byok_usd += byok; p.week_calls += calls;
    if (p.daily[r.day] !== undefined) p.daily[r.day] += usd;
    bump(p.week_by_area, area, usd, byok, calls);
    bump(orgByArea, area, usd, byok, calls);
    orgWeek += usd; orgWeekByok += byok;

    if (r.day === win.day_key) {
      p.today_usd += usd; p.today_byok_usd += byok; p.today_calls += calls;
      bump(p.today_by_area, area, usd, byok, calls);
      orgToday += usd; orgTodayByok += byok;
    }
  }

  // Name anyone who spent in the window but is no longer an active member,
  // so the row reads as a person rather than "User 42".
  const unnamed = [...people.values()].filter(p => !p.active_member).map(p => p.user_id);
  if (unnamed.length) {
    const names = await db.query(
      `SELECT id, first_name, last_name, email FROM users WHERE id = ANY($1::int[])`,
      [unnamed]
    );
    for (const n of names.rows) {
      const p = people.get(n.id);
      p.name  = [n.first_name, n.last_name].filter(Boolean).join(' ') || n.email || p.name;
      p.email = n.email;
    }
  }

  const byAreaList = (obj) => Object.values(obj)
    .map(a => ({ ...a, usd: _round2(a.usd), byok_usd: _round2(a.byok_usd) }))
    .sort((x, y) => y.usd - x.usd || y.calls - x.calls);

  const users = [...people.values()].map(p => {
    const hasOverride = overrides.has(p.user_id);
    const limit = hasOverride ? overrides.get(p.user_id) : settings.defaultLimitUsd;
    return {
      user_id:        p.user_id,
      name:           p.name,
      email:          p.email,
      role:           p.role,
      active_member:  p.active_member,
      limit_usd:      limit,
      has_override:   hasOverride,
      today_usd:      _round2(p.today_usd),
      today_byok_usd: _round2(p.today_byok_usd),
      today_calls:    p.today_calls,
      blocked:        p.today_usd >= limit,
      week_usd:       _round2(p.week_usd),
      week_byok_usd:  _round2(p.week_byok_usd),
      week_calls:     p.week_calls,
      daily:          win.day_list.map(d => ({ day: d, usd: _round2(p.daily[d]) })),
      today_by_area:  byAreaList(p.today_by_area),
      week_by_area:   byAreaList(p.week_by_area),
    };
  });

  const disabledByName = settings.disabledBy
    ? (users.find(u => u.user_id === Number(settings.disabledBy))?.name || null)
    : null;

  return {
    timezone:          tz,
    day:               win.day_key,
    resets_at:         new Date(win.resets_at).toISOString(),
    resets_label:      formatStampInZone(win.resets_at, tz),
    days:              win.day_list,
    default_limit_usd: settings.defaultLimitUsd,
    ai_enabled:        settings.aiEnabled,
    ai_disabled_reason: settings.disabledReason,
    ai_disabled_by:    settings.disabledBy,
    ai_disabled_by_name: disabledByName,
    ai_disabled_at:    settings.disabledAt,
    org_today_usd:     _round2(orgToday),
    org_today_byok_usd: _round2(orgTodayByok),
    org_week_usd:      _round2(orgWeek),
    org_week_byok_usd: _round2(orgWeekByok),
    org_week_by_area:  byAreaList(orgByArea),
    users,
    kill_switch_log:   logRes.rows.map(l => ({
      enabled:    l.enabled,
      reason:     l.reason,
      changed_at: l.changed_at,
      changed_by: l.changed_by,
      changed_by_name: l.changed_by_name || l.changed_by_email || null,
    })),
  };
}

/** Tests only. */
function _resetCaches() {
  _settingsCache.clear();
  _spendCache.clear();
}

module.exports = {
  DEFAULT_DAILY_BUDGET_USD,
  MAX_DAILY_BUDGET_USD,
  AREA_LABELS,
  areaFor,
  parseLimit,
  getOrgAiSettings,
  isOrgAiEnabled,
  assertOrgAiEnabled,
  getSpendState,
  recordSpend,
  assertWithinBudget,
  notifyBudgetReached,
  setDefaultLimit,
  setUserLimit,
  setKillSwitch,
  getUsage,
  invalidateOrg,
  _resetCaches,
};
