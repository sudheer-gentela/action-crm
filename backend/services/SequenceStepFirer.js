/**
 * SequenceStepFirer.js
 *
 * Service called directly by the node-cron job in server.js.
 * Follows the exact pattern of AgentProposalService / contractService:
 *   - No HTTP self-call
 *   - Called as: await SequenceStepFirer.fireDueSteps()
 *   - Returns { fired, stopped, errors, drafted }
 *
 * Draft-first flow (v2):
 *   - sequences.require_approval  = true  → all email steps go to drafts by default
 *   - sequence_steps.require_approval     → NULL = inherit, true/false = override
 *   - Effective: COALESCE(step.require_approval, sequence.require_approval)
 *   - Draft: write step_log status='draft', do NOT send, do NOT advance enrollment
 *   - Send:  existing path unchanged
 *
 * Signature feature (v3):
 *   - At draft creation the sender account is fetched (client sender if the prospect
 *     belongs to a client, otherwise rep's personal sender — least-used active account).
 *   - If sender.signature is set it is appended to the draft body: \n\n${sender.signature}
 *   - sender.display_name is stored in the draft's metadata so the AI
 *     personalisation prompt can reference it as a sign-off name.
 *   - The signature is appended ONLY when creating the draft — the
 *     PATCH /drafts/:logId endpoint operates on whatever the rep saves,
 *     so the signature is already in the body by then.
 *   - In the auto-send branch the signature is likewise appended before dispatch.
 *
 * Client sender accounts (v4 — Model B):
 *   - Prospects that belong to a client (prospect.client_id IS NOT NULL) use a
 *     sender account from prospecting_sender_accounts WHERE client_id = prospect.client_id.
 *   - If no active client sender is configured, the firer falls back to the rep's
 *     personal sender and logs a warning.
 *   - Prospects without a client_id use the original rep-sender path unchanged.
 *
 * syncOverdueDrafts():
 *   - Called by cron after fireDueSteps()
 *   - Inserts prospecting_actions for unactioned drafts → surface in ActionsView
 *   - Idempotent
 */

const { pool }                        = require('../config/database');
const { sendEmail: sendGmailEmail }   = require('./googleService');
const { sendEmail: sendOutlookEmail } = require('./outlookService');
const { plainTextToHtml }             = require('./emailFormatter');

// ── Template renderer ─────────────────────────────────────────────────────────
function renderTemplate(template, prospect, account) {
  if (!template) return '';
  const vars = {
    first_name: prospect.first_name   || '',
    last_name:  prospect.last_name    || '',
    full_name:  `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim(),
    title:      prospect.title        || '',
    company:    account?.name         || prospect.company_name     || '',
    industry:   account?.industry     || prospect.company_industry || '',
    domain:     account?.domain       || prospect.company_domain   || '',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function calcDueDate(delayDays) {
  const d = new Date();
  d.setDate(d.getDate() + (parseInt(delayDays) || 0));
  return d;
}

// ── Sender fetcher ────────────────────────────────────────────────────────────
/**
 * Resolves the best sender account for a given step.
 *
 * Resolution order:
 *   1. If clientId is provided, query for the least-used active client sender.
 *   2. If no client sender is found (or clientId is null), fall back to the
 *      rep's personal least-used active sender.
 *
 * Returns the sender row (with tokens) or null if nothing is connected.
 * Logs a warning when falling back from client → user sender.
 *
 * @param {object} dbClient  - pg pool client
 * @param {number} orgId
 * @param {number} userId    - the rep (enrolled_by)
 * @param {number|null} clientId - prospect.client_id, or null
 * @returns {Promise<object|null>}
 */
async function resolveSender(dbClient, orgId, userId, clientId) {
  // ── 1. Client sender (Model B) ──────────────────────────────────────────────
  if (clientId) {
    const r = await dbClient.query(
      `SELECT id, email, provider, display_name, signature, linkedin_signature,
              access_token, refresh_token,
              emails_sent_today, last_reset_at
         FROM prospecting_sender_accounts
        WHERE org_id    = $1
          AND client_id = $2
          AND is_active = true
        ORDER BY
          (CASE WHEN last_reset_at < CURRENT_DATE THEN 0 ELSE emails_sent_today END) ASC,
          last_sent_at ASC NULLS FIRST
        LIMIT 1`,
      [orgId, clientId]
    );

    if (r.rows[0]) return r.rows[0];

    // Client has no active sender — fall back to rep sender with a warning
    console.warn(
      `SequenceStepFirer: no active client sender for client_id=${clientId} ` +
      `(org ${orgId}) — falling back to rep sender for user ${userId}`
    );
  }

  // ── 2. Rep / personal sender (original path) ────────────────────────────────
  const r = await dbClient.query(
    `SELECT id, email, provider, display_name, signature, linkedin_signature,
            access_token, refresh_token,
            daily_limit, emails_sent_today, last_reset_at
       FROM prospecting_sender_accounts
      WHERE org_id    = $1
        AND user_id   = $2
        AND client_id IS NULL
        AND is_active = true
      ORDER BY
        (CASE WHEN last_reset_at < CURRENT_DATE THEN 0 ELSE emails_sent_today END) ASC,
        last_sent_at ASC NULLS FIRST
      LIMIT 1`,
    [orgId, userId]
  );
  return r.rows[0] || null;
}

// ── Capacity-aware sender pick (AUTO-SEND ONLY) ───────────────────────────────
// Used by the auto-send branch to honor two SOFT gates on autopilot:
//   1. Daily limit — effective per-account = min(daily_limit ?? default, ceiling).
//      A stale counter (last_reset_at < today) counts as 0 sent.
//   2. Min-delay cooldown — an account is eligible only if it hasn't sent within
//      its effective min-delay window. Effective min-delay =
//      max(account.min_delay_minutes ?? defaultMinDelayMinutes, floor).
// Picks the eligible account (has capacity AND cooled down) with the most
// headroom. If accounts have capacity but are all still cooling down, returns
// 'cooling_down'; if all are at their daily limit, 'all_maxed'. Both make the
// firer DEFER to the next tick. Manual sends (sequences.routes.js draft send)
// are NOT routed through here — a human sends whenever they choose.
//
// Returns: { sender, status: 'ok' | 'all_maxed' | 'cooling_down' | 'no_accounts' }
async function pickEmailSenderWithCapacity(dbClient, orgId, userId, clientId, settings, now = new Date()) {
  const defaultLimit    = settings?.defaultDailyLimit ?? 50;
  const ceiling         = settings?.dailyLimitCeiling ?? 100;
  const defaultMinDelay = settings?.defaultMinDelayMinutes ?? 5;
  const minDelayFloor   = settings?.minDelayMinutesFloor ?? 2;

  const cols = `id, email, provider, display_name, signature, linkedin_signature,
                access_token, refresh_token,
                daily_limit, emails_sent_today, last_reset_at,
                min_delay_minutes, last_sent_at`;
  let rows = [];
  if (clientId) {
    const r = await dbClient.query(
      `SELECT ${cols} FROM prospecting_sender_accounts
        WHERE org_id=$1 AND client_id=$2 AND is_active=true`,
      [orgId, clientId]
    );
    rows = r.rows;
    // Fall back to rep senders if the client has none (mirrors resolveSender).
    if (!rows.length) {
      const rr = await dbClient.query(
        `SELECT ${cols} FROM prospecting_sender_accounts
          WHERE org_id=$1 AND user_id=$2 AND client_id IS NULL AND is_active=true`,
        [orgId, userId]
      );
      rows = rr.rows;
    }
  } else {
    const r = await dbClient.query(
      `SELECT ${cols} FROM prospecting_sender_accounts
        WHERE org_id=$1 AND user_id=$2 AND client_id IS NULL AND is_active=true`,
      [orgId, userId]
    );
    rows = r.rows;
  }

  if (!rows.length) return { sender: null, status: 'no_accounts' };

  const todayStr = now.toDateString();
  let best = null, bestRemaining = 0;
  let anyCapacityButCooling = false;
  for (const row of rows) {
    const effLimit = Math.min(
      (row.daily_limit != null && row.daily_limit > 0) ? row.daily_limit : defaultLimit,
      ceiling
    );
    const resetToday = row.last_reset_at && new Date(row.last_reset_at).toDateString() === todayStr;
    const sentToday  = resetToday ? (row.emails_sent_today || 0) : 0;
    const remaining  = effLimit - sentToday;
    if (remaining <= 0) continue; // at/over daily limit

    // Cooldown: effective min-delay, never below the org floor.
    const effMinDelay = Math.max(
      (row.min_delay_minutes != null ? row.min_delay_minutes : defaultMinDelay),
      minDelayFloor
    );
    const cooledDown = effMinDelay <= 0 || !row.last_sent_at ||
      (now.getTime() - new Date(row.last_sent_at).getTime()) >= effMinDelay * 60000;
    if (!cooledDown) { anyCapacityButCooling = true; continue; }

    if (remaining > bestRemaining) { best = row; bestRemaining = remaining; }
  }
  if (best) return { sender: best, status: 'ok' };
  // No eligible account: distinguish "still cooling down" (capacity exists, just
  // too soon) from "all maxed" (no capacity left today). Both defer.
  if (anyCapacityButCooling) return { sender: null, status: 'cooling_down' };
  return { sender: null, status: 'all_maxed' };
}

// ── Append signature helper ───────────────────────────────────────────────────
// Appends signature to body, guarding against doubles in two ways:
//   1. Exact match — the current signature text is already in the body
//   2. First-line match — the body already ends with the first line of the
//      signature (catches cases where the signature changed since the template
//      was written, e.g. "www.gowarmcrm.com" → "gowarmcrm.com")
function appendSignature(body, signature) {
  if (!signature) return body;
  const trimmedSig = signature.trim();
  if (!trimmedSig) return body;
  if (!body) return trimmedSig;

  // Guard 1: exact match
  if (body.includes(trimmedSig)) return body;

  // Guard 2: first line of signature already appears near the end of the body.
  // This catches a changed/reformatted signature already baked into the template.
  const sigFirstLine = trimmedSig.split('\n')[0].trim();
  if (sigFirstLine && body.includes(sigFirstLine)) return body;

  return body + `\n\n${trimmedSig}`;
}

// ── Auto-send scheduling helpers (Level 2: pre-materialized scheduled rows) ────
//
// In auto-send mode (email step, effective require_approval = false) we create a
// sequence_step_logs row with status='scheduled' AHEAD of its send time so the
// rep can see — and edit — the queued email and its scheduled_send_at. The firer
// then atomically claims it (scheduled → sending), sends, and finalizes
// (sending → sent | failed). The partial unique index uq_seq_step_logs_pending
// guarantees at most one pending row per (enrollment, step).
//
// Signature/From are applied at SEND time (the stored body stays plain and
// signature-free so the editor and the GET /scheduled preview render cleanly).

// A step is auto-send when it is an email step AND
// COALESCE(step.require_approval, sequence.require_approval) is false.
const AUTO_SEND_PREDICATE = `
  ss.channel = 'email'
  AND COALESCE(ss.require_approval, s.require_approval) = false
`;

/**
 * Create 'scheduled' rows for active auto-send enrollments whose CURRENT step
 * has no pending (scheduled/sending) or sent row yet. Idempotent via
 * uq_seq_step_logs_pending. Pure top-up — never sends, never advances.
 *
 * @param {object} client                pg client
 * @param {number[]|null} enrollmentIds   scope to these enrollments, or null = all
 * @returns {Promise<number>}             rows inserted
 */
/**
 * Normalize manual-channel (linkedin/task/call) due times to the configured
 * release hour (manualReleaseHour, default 04:00 local). The advance paths
 * already do this on transition, but a couple of paths re-stamp next_step_due
 * without channel awareness — notably resume (/enrollments/:id/resume sets
 * NOW()) and first-step-LinkedIn bulk-activate (uses an email-window slot).
 * This pass snaps any active manual step that isn't already at the release
 * hour, so those paths self-correct and the backfill never has to be re-run by
 * hand. Idempotent: a step already at the release hour recomputes to itself.
 * Runs in the firer housekeeping each tick — cheap (no-op once everything is
 * normalized; only mismatches issue an UPDATE).
 */
async function normalizeManualDueTimes(client) {
  const SendingSchedule = require('./SendingScheduleResolver');
  const candRes = await client.query(
    `SELECT se.id, se.org_id, se.next_step_due
       FROM sequence_enrollments se
       JOIN sequence_steps ss
         ON ss.sequence_id = se.sequence_id
        AND ss.step_order  = se.current_step
      WHERE se.status = 'active'
        AND se.next_step_due IS NOT NULL
        AND ss.channel IN ('linkedin','task','call')`
  );
  if (!candRes.rows.length) return 0;

  const settingsByOrg = new Map();
  let fixed = 0;
  for (const row of candRes.rows) {
    let settings = settingsByOrg.get(row.org_id);
    if (!settings) {
      settings = await SendingSchedule.resolveSettings({ orgId: row.org_id });
      settingsByOrg.set(row.org_id, settings);
    }
    const cur    = new Date(row.next_step_due);
    // delayDays=0 → snap to the release hour on the SAME local day (rolled
    // forward to the next configured send day, matching nextStepDue()).
    const target = SendingSchedule.manualReleaseFor(cur, 0, settings);
    if (Math.abs(target.getTime() - cur.getTime()) >= 1000) {
      await client.query(
        `UPDATE sequence_enrollments SET next_step_due=$1 WHERE id=$2`,
        [target, row.id]
      );
      fixed++;
    }
  }
  if (fixed > 0) {
    console.log(`📨 normalizeManualDueTimes: snapped ${fixed} manual step(s) to release hour`);
  }
  return fixed;
}

async function materializeRows(client, enrollmentIds = null) {
  const scoped = Array.isArray(enrollmentIds) && enrollmentIds.length > 0;
  const params = [];
  let scopeSql = '';
  if (scoped) {
    params.push(enrollmentIds);
    scopeSql = `AND se.id = ANY($${params.length}::int[])`;
  }

  const candRes = await client.query(
    `SELECT se.id              AS enrollment_id,
            se.org_id,
            se.prospect_id,
            se.current_step,
            se.next_step_due,
            se.personalised_steps,
            ss.id              AS step_id,
            ss.subject_template,
            ss.body_template,
            p.first_name, p.last_name, p.title,
            p.company_name, p.company_industry, p.company_domain,
            a.name AS account_name, a.industry AS account_industry,
            a.domain AS account_domain
       FROM sequence_enrollments se
       JOIN sequences s       ON s.id  = se.sequence_id
       JOIN sequence_steps ss ON ss.sequence_id = se.sequence_id
                             AND ss.step_order   = se.current_step
       JOIN prospects p       ON p.id  = se.prospect_id
  LEFT JOIN accounts a        ON a.id  = p.account_id
      WHERE se.status = 'active'
        AND se.next_step_due IS NOT NULL
        AND ${AUTO_SEND_PREDICATE}
        AND NOT EXISTS (
          SELECT 1 FROM sequence_step_logs l
           WHERE l.enrollment_id    = se.id
             AND l.sequence_step_id = ss.id
             AND l.status IN ('scheduled','sending','sent')
        )
        ${scopeSql}`,
    params
  );

  let inserted = 0;
  for (const row of candRes.rows) {
    const prospect = {
      first_name: row.first_name, last_name: row.last_name, title: row.title,
      company_name: row.company_name, company_industry: row.company_industry,
      company_domain: row.company_domain,
    };
    const account = {
      name: row.account_name, industry: row.account_industry, domain: row.account_domain,
    };
    const ps           = row.personalised_steps || {};
    const personalised = ps[row.current_step] || ps[String(row.current_step)] || null;

    const subject = personalised?.subject ?? renderTemplate(row.subject_template, prospect, account);
    const body    = personalised?.body    ?? renderTemplate(row.body_template,    prospect, account);
    const personalizeSourcesJson = personalised?.personalize_sources
      ? JSON.stringify(personalised.personalize_sources)
      : null;

    try {
      await client.query(
        `INSERT INTO sequence_step_logs
                     (org_id, enrollment_id, sequence_step_id, prospect_id,
                      channel, status, subject, body, scheduled_send_at, fired_at,
                      personalize_sources)
              VALUES ($1, $2, $3, $4, 'email', 'scheduled', $5, $6, $7, NULL, $8::jsonb)`,
        [row.org_id, row.enrollment_id, row.step_id, row.prospect_id,
         subject, body, row.next_step_due, personalizeSourcesJson]
      );
      inserted++;
    } catch (e) {
      // 23505 = unique_violation on uq_seq_step_logs_pending: a pending row was
      // created concurrently (another tick / bulk-activate). Benign — skip.
      if (e.code !== '23505') {
        console.warn(`materializeRows: insert failed for enrollment ${row.enrollment_id}:`, e.message);
      }
    }
  }
  return inserted;
}

/**
 * Mark a step's pending row failed, PAUSE the enrollment, and surface an action
 * for the campaign owner. No auto-retry (per design): the person running the
 * campaign fixes the cause (reconnect sender, correct the address) and resumes;
 * resume re-stamps next_step_due and the top-up re-materializes a fresh row.
 *
 * Keyed on (enrollment_id, sequence_step_id) so it works whether or not a
 * pending row already exists (pre-claim precondition failures vs post-claim
 * send failures). If no pending row exists, one is inserted as 'failed'.
 */
async function failAndPause(client, info) {
  const {
    orgId, enrollmentId, stepId, prospectId, enrolledBy,
    seqName, stepOrder, channel = 'email', message,
  } = info;
  const errMsg = String(message || 'send failed').slice(0, 1000);

  // 1. Fail the pending row, or insert a failed row if none exists.
  const upd = await client.query(
    `UPDATE sequence_step_logs
        SET status='failed', error_message=$3, fired_at=NOW()
      WHERE enrollment_id=$1 AND sequence_step_id=$2
        AND status IN ('scheduled','sending')`,
    [enrollmentId, stepId, errMsg]
  );
  if (upd.rowCount === 0) {
    await client.query(
      `INSERT INTO sequence_step_logs
                   (org_id, enrollment_id, sequence_step_id, prospect_id,
                    channel, status, error_message, scheduled_send_at, fired_at)
            VALUES ($1, $2, $3, $4, $5, 'failed', $6, NOW(), NOW())`,
      [orgId, enrollmentId, stepId, prospectId, channel, errMsg]
    );
  }

  // 2. Pause (no advance, no retry).
  await client.query(
    `UPDATE sequence_enrollments
        SET status='paused', stop_reason='send_failed'
      WHERE id=$1 AND status='active'`,
    [enrollmentId]
  );

  // 3. Activity feed.
  try {
    await client.query(
      `INSERT INTO prospecting_activities
                   (org_id, prospect_id, user_id, activity_type, description, metadata)
            VALUES ($1, $2, $3, 'sequence_send_failed', $4, $5)`,
      [orgId, prospectId, enrolledBy,
       `Auto-send paused — ${seqName || 'sequence'} step ${stepOrder ?? '?'}: ${errMsg}`,
       JSON.stringify({ enrollmentId, stepId, stepOrder: stepOrder ?? null, reason: errMsg })]
    );
  } catch (e) {
    console.warn(`failAndPause: activity log failed for enrollment ${enrollmentId}:`, e.message);
  }

  // 4. Action for the campaign owner (idempotent — one open action per step).
  try {
    await client.query(
      `INSERT INTO prospecting_actions
                   (org_id, user_id, prospect_id, title, description,
                    action_type, channel, status, priority, due_date, source, metadata)
       SELECT $1, $2, $3,
              'Auto-send paused — fix & resume',
              $4, 'outreach', 'email', 'pending', 'high', NOW(),
              'sequence_send_failed',
              jsonb_build_object('enrollmentId', $5::int, 'stepId', $6::int,
                                 'stepOrder', $7::int, 'reason', $8::text)
        WHERE NOT EXISTS (
          SELECT 1 FROM prospecting_actions pa
           WHERE pa.source = 'sequence_send_failed'
             AND (pa.metadata->>'enrollmentId')::int = $5::int
             AND (pa.metadata->>'stepId')::int       = $6::int
             AND pa.status != 'completed'
        )`,
      [orgId, enrolledBy, prospectId,
       `Sequence "${seqName || ''}" step ${stepOrder ?? '?'} could not be sent: ${errMsg}. `
         + `Reconnect the sender or fix the prospect, then resume the enrollment.`,
       enrollmentId, stepId, stepOrder ?? 0, errMsg]
    );
  } catch (e) {
    console.warn(`failAndPause: action insert failed for enrollment ${enrollmentId}:`, e.message);
  }
}

/**
 * Reclaim rows stuck in 'sending' (worker crashed between claim and finalize).
 * Per the no-auto-retry policy a possibly-half-sent email is treated as a
 * failure needing human verification — NOT silently retried.
 *
 * @returns {Promise<number>} rows reaped
 */
async function reapStaleSending(client, staleMinutes = 30) {
  const stale = await client.query(
    `SELECT l.id, l.org_id, l.enrollment_id, l.sequence_step_id, l.prospect_id,
            se.enrolled_by, se.current_step, s.name AS seq_name
       FROM sequence_step_logs l
       JOIN sequence_enrollments se ON se.id = l.enrollment_id
       JOIN sequences s             ON s.id  = se.sequence_id
      WHERE l.status = 'sending'
        AND l.fired_at < NOW() - ($1 || ' minutes')::interval`,
    [String(staleMinutes)]
  );
  for (const r of stale.rows) {
    await failAndPause(client, {
      orgId: r.org_id, enrollmentId: r.enrollment_id, stepId: r.sequence_step_id,
      prospectId: r.prospect_id, enrolledBy: r.enrolled_by,
      seqName: r.seq_name, stepOrder: r.current_step, channel: 'email',
      message: 'Send interrupted (worker restarted mid-send). Verify in your mailbox before resuming.',
    });
  }
  return stale.rowCount || 0;
}

// ── Main export ───────────────────────────────────────────────────────────────

const SequenceStepFirer = {
  /**
   * Fire all due sequence steps across all orgs.
   * Safe to call on a schedule — processes up to 100 enrollments per run.
   * @returns {{ fired: number, stopped: number, errors: number, drafted: number }}
   */
  async fireDueSteps() {
    let fired = 0, stopped = 0, errors = 0, drafted = 0;

    const client = await pool.connect();
    try {
      // ── Level 2 housekeeping (before processing due steps) ────────────────
      // 1) Reclaim rows stuck in 'sending' (worker crash mid-send) → failed+pause.
      // 2) Top-up: create 'scheduled' rows for active auto-send enrollments that
      //    don't have one yet (covers manual-advance, resume, and backfill of
      //    pre-existing enrollments). Both are non-fatal.
      try { await reapStaleSending(client, 30); } catch (e) { console.warn('📨 reapStaleSending:', e.message); }
      try { await normalizeManualDueTimes(client); } catch (e) { console.warn('📨 normalizeManualDueTimes:', e.message); }
      try { await materializeRows(client, null); } catch (e) { console.warn('📨 materializeRows top-up:', e.message); }

      // Include sequence-level require_approval, name, prospect.campaign_id
      // (per-campaign send-window override resolution), and the CURRENT step's
      // channel (channel-aware window: email-only steps gate on the window,
      // manual steps like LinkedIn/task/call create tasks regardless of hour).
      const dueRes = await client.query(
        `SELECT se.*, s.id AS seq_id, s.name AS seq_name,
                s.require_approval AS seq_require_approval,
                p.campaign_id AS prospect_campaign_id,
                ss.channel AS current_step_channel
           FROM sequence_enrollments se
           JOIN sequences  s ON s.id = se.sequence_id
           JOIN prospects  p ON p.id = se.prospect_id
           LEFT JOIN sequence_steps ss
                  ON ss.sequence_id = se.sequence_id
                 AND ss.step_order  = se.current_step
          WHERE se.status = 'active'
            AND se.next_step_due <= NOW()
          ORDER BY se.next_step_due ASC, se.id ASC
          LIMIT 100`
      );

      // Resolve send-window settings per (orgId, campaignId) once and cache —
      // many enrollments share the same campaign, so we don't want to hit
      // the DB for resolveSettings on every iteration.
      const SendingSchedule = require('./SendingScheduleResolver');
      const settingsCache = new Map();
      const getSettings = async (orgId, campaignId) => {
        const key = `${orgId}:${campaignId || 'null'}`;
        if (!settingsCache.has(key)) {
          settingsCache.set(key,
            await SendingSchedule.resolveSettings({ orgId, campaignId }));
        }
        return settingsCache.get(key);
      };

      for (const enrollment of dueRes.rows) {
        try {
          // ── Send-window gate ───────────────────────────────────────────────
          // Pre-scheduler already placed next_step_due inside the window at
          // enrollment time, so the common case here is "always pass". But:
          //   - Manual single-enroll paths may not use the scheduler.
          //   - Settings may have changed since enrollment.
          //   - Cron tick may have drifted slightly outside the window.
          // For email steps we strictly enforce the window. For manual
          // channels (LinkedIn, task, call) we always pass — the firer
          // just creates a task row, no message leaves the system.
          const settings = await getSettings(enrollment.org_id, enrollment.prospect_campaign_id);
          const channel  = enrollment.current_step_channel || 'email';
          if (!SendingSchedule.isWithinWindow(new Date(), settings, channel)) {
            // Not an error; we'll try again next tick. No counter bump.
            continue;
          }

          // ── Auto-stop: inbound reply received since enrollment ────────────
          const replyCheck = await client.query(
            `SELECT id FROM emails
              WHERE prospect_id = $1
                AND direction IN ('inbound', 'received')
                AND sent_at > $2
              LIMIT 1`,
            [enrollment.prospect_id, enrollment.enrolled_at]
          );

          if (replyCheck.rows.length > 0) {
            await client.query(
              `UPDATE sequence_enrollments
                  SET status='replied', stopped_at=NOW(), stop_reason='replied'
                WHERE id=$1`,
              [enrollment.id]
            );
            // Cancel any pending auto-send rows so nothing fires after a reply.
            await client.query(
              `UPDATE sequence_step_logs SET status='skipped'
                WHERE enrollment_id=$1 AND status IN ('scheduled','sending')`,
              [enrollment.id]
            );
            stopped++;
            continue;
          }

          // ── Get the current step ──────────────────────────────────────────
          const stepRes = await client.query(
            `SELECT * FROM sequence_steps
              WHERE sequence_id=$1 AND step_order=$2`,
            [enrollment.seq_id, enrollment.current_step]
          );

          if (!stepRes.rows.length) {
            await client.query(
              `UPDATE sequence_enrollments
                  SET status='completed', completed_at=NOW()
                WHERE id=$1`,
              [enrollment.id]
            );
            fired++;
            continue;
          }

          const step = stepRes.rows[0];

          // ── Resolve effective approval setting ────────────────────────────
          // Step-level wins when explicitly set (not NULL).
          // seq_require_approval defaults to true if column not yet migrated.
          const seqApproval = enrollment.seq_require_approval !== false;
          const effectiveRequireApproval =
            step.require_approval !== null && step.require_approval !== undefined
              ? !!step.require_approval
              : seqApproval;

          // ── Load prospect + account for template rendering ────────────────
          // client_id is fetched here so the sender resolver can use it.
          const pRes = await client.query(
            `SELECT p.*, p.client_id,
                    a.name AS account_name, a.domain AS account_domain,
                    a.industry AS account_industry
               FROM prospects p
          LEFT JOIN accounts a ON a.id = p.account_id
              WHERE p.id=$1`,
            [enrollment.prospect_id]
          );
          const prospect  = pRes.rows[0];
          const clientId  = prospect?.client_id || null; // null for non-agency prospects
          const account   = prospect
            ? { name: prospect.account_name, domain: prospect.account_domain, industry: prospect.account_industry }
            : null;

          // ── Use personalised content if available, else render template ────
          const personalisedStep =
            enrollment.personalised_steps?.[enrollment.current_step] ||
            enrollment.personalised_steps?.[String(enrollment.current_step)];

          const subject = personalisedStep?.subject ?? renderTemplate(step.subject_template, prospect || {}, account);
          let   body    = personalisedStep?.body    ?? renderTemplate(step.body_template,    prospect || {}, account);

          // Phase 3: provenance — if the AI generated this draft with LinkedIn
          // data, the enrollment.personalised_steps blob carries a
          // personalize_sources object. Copy it onto the log row so the
          // rep-facing footer + immutable audit trail both stay consistent.
          const personalizeSourcesJson = personalisedStep?.personalize_sources
            ? JSON.stringify(personalisedStep.personalize_sources)
            : null;

          // Has the rep approved this email step for paced sending? An approved
          // draft is flipped to a pending 'scheduled' row by /drafts/approve.
          // If one exists, take the SEND branch (paced) regardless of
          // require_approval — the human already approved it. Email only.
          let hasApprovedSchedule = false;
          if (step.channel === 'email') {
            const appr = await client.query(
              `SELECT 1 FROM sequence_step_logs
                WHERE enrollment_id=$1 AND sequence_step_id=$2
                  AND status IN ('scheduled','sending') LIMIT 1`,
              [enrollment.id, step.id]
            );
            hasApprovedSchedule = appr.rows.length > 0;
          }

          // ── DRAFT BRANCH ──────────────────────────────────────────────────
          if (step.channel !== 'email' || (effectiveRequireApproval && !hasApprovedSchedule)) {
            // Idempotency: don't create a second draft for this step
            const existingDraft = await client.query(
              `SELECT id FROM sequence_step_logs
                WHERE enrollment_id=$1 AND sequence_step_id=$2 AND status='draft'
                LIMIT 1`,
              [enrollment.id, step.id]
            );

            if (existingDraft.rows.length > 0) {
              // Draft already exists and is awaiting rep action — skip
              continue;
            }

            // ── Fetch sender for signature + display_name ─────────────────
            // Client sender if the prospect belongs to a client, else rep's sender.
            // Non-fatal: draft is still created without a signature if nothing connected.
            // NOTE: body stored in DB stays as plain text so the editor renders it
            // correctly. plainTextToHtml() is applied at send time only.
            const sender = await resolveSender(client, enrollment.org_id, enrollment.enrolled_by, clientId);

            // Channel-aware signature:
            //   email    → sender.signature
            //   linkedin → sender.linkedin_signature if set, else sender.signature
            //   call/task → no signature
            if (sender) {
              if (step.channel === 'email' && sender.signature) {
                body = appendSignature(body, sender.signature);
              } else if (step.channel === 'linkedin') {
                const liSig = sender.linkedin_signature || sender.signature;
                if (liSig) body = appendSignature(body, liSig);
              }
            }

            // Write draft — fired_at=NULL until rep sends
            await client.query(
              `INSERT INTO sequence_step_logs
                           (org_id, enrollment_id, sequence_step_id, prospect_id,
                            channel, status, subject, body, scheduled_send_at, fired_at,
                            personalize_sources)
                    VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, NOW(), NULL, $8::jsonb)`,
              [
                enrollment.org_id,
                enrollment.id,
                step.id,
                enrollment.prospect_id,
                step.channel,
                subject,
                body,
                personalizeSourcesJson,
              ]
            );

            // Activity: draft created. Description is channel-aware so the
            // activity feed reads naturally — "Email draft ready" vs
            // "Call task pending" vs "LinkedIn task pending".
            const draftActivityDesc = (() => {
              if (step.channel === 'call') {
                return `Call task pending — ${enrollment.seq_name} step ${enrollment.current_step}`;
              }
              if (step.channel === 'linkedin') {
                return `LinkedIn task ready — ${enrollment.seq_name} step ${enrollment.current_step}`;
              }
              if (step.channel === 'task') {
                return `Task pending — ${enrollment.seq_name} step ${enrollment.current_step}`;
              }
              return `Draft ready for review — ${enrollment.seq_name} step ${enrollment.current_step}: ${subject || '(no subject)'}`;
            })();
            try {
              await client.query(
                `INSERT INTO prospecting_activities
                             (org_id, prospect_id, user_id, activity_type, description, metadata)
                      VALUES ($1, $2, $3, 'sequence_draft_created', $4, $5)`,
                [
                  enrollment.org_id,
                  enrollment.prospect_id,
                  enrollment.enrolled_by,
                  draftActivityDesc,
                  JSON.stringify({
                    enrollmentId:  enrollment.id,
                    sequenceId:    enrollment.seq_id,
                    sequenceName:  enrollment.seq_name,
                    stepOrder:     enrollment.current_step,
                    stepId:        step.id,
                    channel:       step.channel,
                    subject:       subject       || null,
                    senderId:      sender?.id          || null,
                    displayName:   sender?.display_name || null,
                    // Record which owner type was used for observability
                    senderOwner:   clientId ? 'client' : 'user',
                    clientId:      clientId || null,
                  }),
                ]
              );
            } catch (actErr) {
              console.warn(`SequenceStepFirer: draft activity log failed for enrollment ${enrollment.id}:`, actErr.message);
            }

            drafted++;
            continue; // Do NOT advance — enrollment stays on this step until rep sends
          }

          // ── SEND BRANCH (auto-send, no approval required) ─────────
          // Level 2: send by atomically CLAIMING the pre-materialized
          // 'scheduled' row (scheduled → sending → sent|failed). The claim
          // re-reads subject/body so any rep edits are honored. On ANY failure
          // we fail the row, PAUSE the enrollment (no auto-retry), and surface an
          // action for the campaign owner. Signature + HTML are applied here at
          // send time; the stored body stays plain/signature-free.

          // Precondition: a prospect email is required.
          if (!prospect?.email) {
            await failAndPause(client, {
              orgId: enrollment.org_id, enrollmentId: enrollment.id, stepId: step.id,
              prospectId: enrollment.prospect_id, enrolledBy: enrollment.enrolled_by,
              seqName: enrollment.seq_name, stepOrder: enrollment.current_step,
              channel: 'email', message: 'Prospect has no email address.',
            });
            errors++;
            continue;
          }

          // Capacity gate (soft): pick an eligible sender BEFORE claiming. If all
          // senders are maxed or cooling down, DEFER — leave the scheduled row
          // untouched and retry next tick. scheduled_send_at stays fixed so the
          // rep keeps seeing the original promised time.
          const pick = await pickEmailSenderWithCapacity(
            client, enrollment.org_id, enrollment.enrolled_by, clientId, settings, new Date()
          );
          if (pick.status === 'all_maxed' || pick.status === 'cooling_down') {
            console.log(
              `SequenceStepFirer: deferring enrollment ${enrollment.id} — ` +
              `senders ${pick.status === 'cooling_down' ? 'within min-delay cooldown' : 'at daily limit'}`
            );
            continue;
          }
          if (pick.status === 'no_accounts' || !pick.sender) {
            await failAndPause(client, {
              orgId: enrollment.org_id, enrollmentId: enrollment.id, stepId: step.id,
              prospectId: enrollment.prospect_id, enrolledBy: enrollment.enrolled_by,
              seqName: enrollment.seq_name, stepOrder: enrollment.current_step,
              channel: 'email',
              message: 'No active email sender connected — connect Gmail or Outlook in Settings → Outreach.',
            });
            errors++;
            continue;
          }
          const sender = pick.sender;

          // Ensure a pending scheduled row exists (the top-up normally created it
          // ahead of time; this INSERT is the race/backfill backstop). A unique
          // violation (23505) means one already exists — fine, we'll claim it.
          try {
            await client.query(
              `INSERT INTO sequence_step_logs
                           (org_id, enrollment_id, sequence_step_id, prospect_id,
                            channel, status, subject, body, scheduled_send_at, fired_at,
                            personalize_sources)
                    VALUES ($1, $2, $3, $4, 'email', 'scheduled', $5, $6, $7, NULL, $8::jsonb)`,
              [enrollment.org_id, enrollment.id, step.id, enrollment.prospect_id,
               subject, body, enrollment.next_step_due, personalizeSourcesJson]
            );
          } catch (insErr) {
            if (insErr.code !== '23505') throw insErr;
          }

          // Atomic claim: scheduled → sending. RETURNING the (possibly edited)
          // content. Zero rows ⇒ another tick claimed/cancelled it.
          const claim = await client.query(
            `UPDATE sequence_step_logs
                SET status='sending', fired_at=NOW()
              WHERE enrollment_id=$1 AND sequence_step_id=$2 AND status='scheduled'
                AND scheduled_send_at <= NOW()
              RETURNING id, subject, body`,
            [enrollment.id, step.id]
          );
          if (claim.rowCount === 0) {
            continue; // claimed or cancelled elsewhere
          }
          const logId       = claim.rows[0].id;
          const sendSubject = claim.rows[0].subject || '';
          const sendBodyRaw = claim.rows[0].body || '';

          // Reset the sender's daily counter on a new day.
          if (!sender.last_reset_at ||
              new Date(sender.last_reset_at).toDateString() !== new Date().toDateString()) {
            await client.query(
              `UPDATE prospecting_sender_accounts
                  SET emails_sent_today=0, last_reset_at=CURRENT_DATE, updated_at=CURRENT_TIMESTAMP
                WHERE id=$1`,
              [sender.id]
            );
            sender.emails_sent_today = 0;
          }

          // Signature + HTML applied at send time (stored body stays plain).
          const sendBodyPlain = appendSignature(sendBodyRaw, sender.signature);
          const sendBodyHtml  = plainTextToHtml(sendBodyPlain);

          // Dispatch. On throw → fail + pause (no retry), then defer to owner.
          try {
            if (sender.provider === 'gmail') {
              await sendGmailEmail(enrollment.enrolled_by, {
                to: prospect.email, subject: sendSubject, body: sendBodyHtml, isHtml: true,
                senderEmail: sender.email, accessToken: sender.access_token, refreshToken: sender.refresh_token,
              });
            } else if (sender.provider === 'outlook') {
              await sendOutlookEmail(enrollment.enrolled_by, {
                to: prospect.email, subject: sendSubject, body: sendBodyHtml, isHtml: true,
                senderEmail: sender.email, accessToken: sender.access_token, refreshToken: sender.refresh_token,
              });
            } else {
              throw new Error(`Unsupported sender provider: ${sender.provider}`);
            }
          } catch (sendErr) {
            await failAndPause(client, {
              orgId: enrollment.org_id, enrollmentId: enrollment.id, stepId: step.id,
              prospectId: enrollment.prospect_id, enrolledBy: enrollment.enrolled_by,
              seqName: enrollment.seq_name, stepOrder: enrollment.current_step,
              channel: 'email', message: sendErr.message,
            });
            errors++;
            continue;
          }

          // ── Success: persist the sent email ────────────────────────
          const emailRes = await client.query(
            `INSERT INTO emails
                         (org_id, user_id, direction, subject, body,
                          to_address, from_address, sent_at,
                          prospect_id, sender_account_id, provider)
                  VALUES ($1, $2, 'sent', $3, $4, $5, $6, NOW(), $7, $8, $9)
               RETURNING id`,
            [enrollment.org_id, enrollment.enrolled_by, sendSubject, sendBodyHtml,
             prospect.email, sender.email, enrollment.prospect_id, sender.id, sender.provider]
          );
          const emailId = emailRes.rows[0].id;

          await client.query(
            `UPDATE prospecting_sender_accounts
                SET emails_sent_today=emails_sent_today+1,
                    last_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
              WHERE id=$1`,
            [sender.id]
          );

          // Finalize the claimed row: sending → sent.
          await client.query(
            `UPDATE sequence_step_logs
                SET status='sent', fired_at=NOW(), email_id=$2
              WHERE id=$1`,
            [logId, emailId]
          );

          // Activity.
          try {
            await client.query(
              `INSERT INTO prospecting_activities
                           (org_id, prospect_id, user_id, activity_type, description, metadata)
                    VALUES ($1, $2, $3, 'sequence_step_sent', $4, $5)`,
              [enrollment.org_id, enrollment.prospect_id, enrollment.enrolled_by,
               `Sequence step ${enrollment.current_step} sent — ${sendSubject || '(no subject)'}`,
               JSON.stringify({
                 enrollmentId: enrollment.id, sequenceId: enrollment.seq_id,
                 stepOrder: enrollment.current_step, stepId: step.id,
                 channel: 'email', subject: sendSubject || null,
                 emailId, senderId: sender.id, clientId: clientId || null,
               })]
            );
          } catch (actErr) {
            console.warn(`SequenceStepFirer: activity log failed for enrollment ${enrollment.id}:`, actErr.message);
          }

          // ── Advance enrollment ──────────────────────────────────
          const nextStepRes = await client.query(
            `SELECT * FROM sequence_steps WHERE sequence_id=$1 AND step_order=$2`,
            [enrollment.seq_id, enrollment.current_step + 1]
          );
          if (nextStepRes.rows.length) {
            const nextStep = nextStepRes.rows[0];
            await client.query(
              `UPDATE sequence_enrollments
                  SET current_step=$1, next_step_due=$2
                WHERE id=$3`,
              [enrollment.current_step + 1, SendingSchedule.nextStepDue(nextStep, settings), enrollment.id]
            );
          } else {
            await client.query(
              `UPDATE sequence_enrollments
                  SET status='completed', completed_at=NOW()
                WHERE id=$1`,
              [enrollment.id]
            );
          }

          fired++;
        } catch (stepErr) {
          console.error(`📨 SequenceStepFirer: error on enrollment ${enrollment.id}:`, stepErr.message);
          errors++;
          // Write a failed log row so the sequence-health endpoint can
          // surface this. Without it, errors die in stdout only and we'd
          // never know which sequences are silently broken in production.
          //
          // We do NOT fail the surrounding loop if this insert itself
          // throws — that would just hide the original error behind a
          // schema problem. Swallow and log.
          try {
            // sequence_step_id and channel are NOT NULL. Resolve the current
            // step so the failed-log row actually persists (previously this
            // passed NULLs and silently violated the constraint, so firer-level
            // errors never reached the health view). If the step can't be
            // resolved (failure before the step was known), skip the insert
            // rather than throw a new violation.
            const stepLookup = await client.query(
              `SELECT id FROM sequence_steps WHERE sequence_id=$1 AND step_order=$2`,
              [enrollment.seq_id, enrollment.current_step]
            );
            const failStepId  = stepLookup.rows[0]?.id || null;
            const failChannel = enrollment.current_step_channel || 'email';
            if (failStepId) {
              await client.query(
                `INSERT INTO sequence_step_logs
                   (org_id, enrollment_id, sequence_step_id, prospect_id,
                    channel, status, error_message, scheduled_send_at, fired_at)
                 VALUES ($1, $2, $3, $4, $5, 'failed', $6, NOW(), NOW())`,
                [
                  enrollment.org_id,
                  enrollment.id,
                  failStepId,
                  enrollment.prospect_id,
                  failChannel,
                  String(stepErr.message || 'unknown error').slice(0, 1000),
                ]
              );
            } else {
              console.warn(`📨 SequenceStepFirer: could not resolve step for failed-log on enrollment ${enrollment.id} — skipping failed row`);
            }
          } catch (logErr) {
            console.warn('📨 SequenceStepFirer: failed-log write also failed:', logErr.message);
          }
        }
      }
    } finally {
      client.release();
    }

    console.log(`📨 SequenceStepFirer: fired=${fired} drafted=${drafted} stopped=${stopped} errors=${errors}`);
    return { fired, stopped, errors, drafted };
  },

  /**
   * Materialize pending auto-send 'scheduled' rows for the given enrollments
   * (or all active auto-send enrollments when no ids are passed). Called
   * synchronously at the end of bulk-activate so the queue is visible
   * immediately; also used by the cron top-up.
   * @param {number[]|null} enrollmentIds
   * @returns {{ inserted: number }}
   */
  async materializePendingAutoSends(enrollmentIds = null) {
    const client = await pool.connect();
    try {
      const inserted = await materializeRows(client, enrollmentIds);
      if (inserted > 0) {
        console.log(`📨 SequenceStepFirer.materializePendingAutoSends: ${inserted} scheduled row(s) created`);
      }
      return { inserted };
    } catch (err) {
      console.error('SequenceStepFirer.materializePendingAutoSends error:', err.message);
      return { inserted: 0 };
    } finally {
      client.release();
    }
  },

  /**
   * Sync overdue drafts → prospecting_actions.
   *
   * Called by cron after fireDueSteps(). For any draft step log that has been
   * sitting unactioned past its scheduled_send_at, insert a prospecting_action
   * so it surfaces as overdue in ActionsView. Idempotent.
   *
   * @returns {{ inserted: number }}
   */
  async syncOverdueDrafts() {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO prospecting_actions
           (org_id, user_id, prospect_id, title, description,
            action_type, channel, status, priority, due_date, source, metadata)
         SELECT
           ssl.org_id,
           se.enrolled_by,
           ssl.prospect_id,
           'Review & send sequence email — ' || s.name || ' (step ' || ss.step_order || ')',
           'Draft ready: ' || COALESCE(ssl.subject, '(no subject)'),
           'outreach',
           'email',
           'pending',
           'high',
           ssl.scheduled_send_at,
           'sequence_draft',
           jsonb_build_object(
             'draftLogId',   ssl.id,
             'enrollmentId', se.id,
             'sequenceId',   s.id,
             'sequenceName', s.name,
             'stepOrder',    ss.step_order,
             'subject',      ssl.subject
           )
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id  = ssl.enrollment_id
         JOIN sequences s             ON s.id   = se.sequence_id
         JOIN sequence_steps ss       ON ss.id  = ssl.sequence_step_id
         WHERE ssl.status = 'draft'
           AND ssl.scheduled_send_at < NOW()
           AND NOT EXISTS (
             SELECT 1 FROM prospecting_actions pa
              WHERE (pa.metadata->>'draftLogId')::int = ssl.id
                AND pa.status != 'completed'
           )
         RETURNING id`
      );

      const inserted = result.rowCount || 0;
      if (inserted > 0) {
        console.log(`📨 SequenceStepFirer.syncOverdueDrafts: inserted ${inserted} overdue action(s)`);
      }
      return { inserted };
    } catch (err) {
      console.error('SequenceStepFirer.syncOverdueDrafts error:', err.message);
      return { inserted: 0 };
    } finally {
      client.release();
    }
  },
};

module.exports = SequenceStepFirer;
