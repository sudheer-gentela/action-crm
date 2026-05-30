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

          // ── DRAFT BRANCH ──────────────────────────────────────────────────
          if (step.channel !== 'email' || effectiveRequireApproval) {
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

          // ── SEND BRANCH (auto-send, no approval required) ─────────────────
          let emailId   = null;
          let sendError = null;

          if (step.channel === 'email' && prospect?.email) {
            // Resolve sender with capacity awareness. Auto-send respects the
            // per-account daily limit as a SOFT gate: if every active sender is
            // at/over its limit, DEFER (retry next tick) rather than overshoot.
            const pick = await pickEmailSenderWithCapacity(
              client, enrollment.org_id, enrollment.enrolled_by, clientId, settings, new Date()
            );
            if (pick.status === 'all_maxed' || pick.status === 'cooling_down') {
              // Defer (no advance, no counter bump); next tick retries.
              //  - all_maxed:    every sender hit its daily limit → wait for reset
              //  - cooling_down: capacity exists but every sender sent too
              //    recently (min-delay) → wait for the cooldown to clear
              console.log(
                `SequenceStepFirer: deferring enrollment ${enrollment.id} — ` +
                `senders for user ${enrollment.enrolled_by} ${pick.status === 'cooling_down' ? 'within min-delay cooldown' : 'at daily limit'}`
              );
              continue;
            }
            const sender = pick.sender; // null only when status === 'no_accounts'

            if (sender) {
              // Reset daily counter if it's a new day
              if (new Date(sender.last_reset_at).toDateString() !== new Date().toDateString()) {
                await client.query(
                  `UPDATE prospecting_sender_accounts
                      SET emails_sent_today=0, last_reset_at=CURRENT_DATE, updated_at=CURRENT_TIMESTAMP
                    WHERE id=$1`,
                  [sender.id]
                );
                sender.emails_sent_today = 0;
              }

              // Append signature, then convert plain text to HTML so paragraph
              // breaks and line breaks render correctly in Gmail and Outlook.
              const sendBodyPlain = appendSignature(body, sender.signature);
              const sendBody      = plainTextToHtml(sendBodyPlain);

              // Dispatch via Gmail or Outlook
              try {
                if (sender.provider === 'gmail') {
                  await sendGmailEmail(enrollment.enrolled_by, {
                    to:           prospect.email,
                    subject,
                    body:         sendBody,
                    isHtml:       true,
                    senderEmail:  sender.email,
                    accessToken:  sender.access_token,
                    refreshToken: sender.refresh_token,
                  });
                } else if (sender.provider === 'outlook') {
                  await sendOutlookEmail(enrollment.enrolled_by, {
                    to:           prospect.email,
                    subject,
                    body:         sendBody,
                    isHtml:       true,
                    senderEmail:  sender.email,
                    accessToken:  sender.access_token,
                    refreshToken: sender.refresh_token,
                  });
                }
              } catch (err) {
                sendError = err.message;
                console.warn(`SequenceStepFirer: send failed for enrollment ${enrollment.id}:`, err.message);
              }

              // Persist email record with full sender metadata
              const emailRes = await client.query(
                `INSERT INTO emails
                             (org_id, user_id, direction, subject, body,
                              to_address, from_address, sent_at,
                              prospect_id, sender_account_id, provider)
                      VALUES ($1, $2, 'sent', $3, $4, $5, $6, NOW(), $7, $8, $9)
                   RETURNING id`,
                [
                  enrollment.org_id, enrollment.enrolled_by,
                  subject, sendBody,
                  prospect.email, sender.email,
                  enrollment.prospect_id, sender.id, sender.provider,
                ]
              );
              emailId = emailRes.rows[0].id;

              // Update sender counters
              await client.query(
                `UPDATE prospecting_sender_accounts
                    SET emails_sent_today=emails_sent_today+1,
                        last_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
                  WHERE id=$1`,
                [sender.id]
              );
            } else {
              console.warn(
                `SequenceStepFirer: no active sender for enrollment ${enrollment.id} ` +
                `(user ${enrollment.enrolled_by}${clientId ? `, client ${clientId}` : ''}) — email not sent`
              );
            }
          }

          // ── Log sent step ─────────────────────────────────────────────────
          await client.query(
            `INSERT INTO sequence_step_logs
                         (org_id, enrollment_id, sequence_step_id, prospect_id,
                          channel, status, subject, body, email_id, fired_at,
                          personalize_sources)
                  VALUES ($1, $2, $3, $4, $5, 'sent', $6, $7, $8, NOW(), $9::jsonb)`,
            [
              enrollment.org_id,
              enrollment.id,
              step.id,
              enrollment.prospect_id,
              step.channel,
              subject,
              body,
              emailId,
              personalizeSourcesJson,
            ]
          );

          // ── Write activity ────────────────────────────────────────────────
          try {
            const channelLabel = step.channel.charAt(0).toUpperCase() + step.channel.slice(1);
            const description  = step.channel === 'email'
              ? `Sequence step ${enrollment.current_step} sent — ${subject || '(no subject)'}`
              : `Sequence step ${enrollment.current_step} fired (${channelLabel})${step.task_note ? ': ' + step.task_note : ''}`;

            await client.query(
              `INSERT INTO prospecting_activities
                           (org_id, prospect_id, user_id, activity_type, description, metadata)
                    VALUES ($1, $2, $3, 'sequence_step_sent', $4, $5)`,
              [
                enrollment.org_id,
                enrollment.prospect_id,
                enrollment.enrolled_by,
                description,
                JSON.stringify({
                  enrollmentId: enrollment.id,
                  sequenceId:   enrollment.seq_id,
                  stepOrder:    enrollment.current_step,
                  stepId:       step.id,
                  channel:      step.channel,
                  subject:      subject   || null,
                  emailId:      emailId   || null,
                  sendError:    sendError || null,
                  clientId:     clientId  || null,
                }),
              ]
            );
          } catch (actErr) {
            console.warn(`SequenceStepFirer: activity log failed for enrollment ${enrollment.id}:`, actErr.message);
          }

          // ── Advance enrollment ────────────────────────────────────────────
          const nextStepRes = await client.query(
            `SELECT * FROM sequence_steps
              WHERE sequence_id=$1 AND step_order=$2`,
            [enrollment.seq_id, enrollment.current_step + 1]
          );

          if (nextStepRes.rows.length) {
            const nextStep = nextStepRes.rows[0];
            await client.query(
              `UPDATE sequence_enrollments
                  SET current_step=$1, next_step_due=$2
                WHERE id=$3`,
              [enrollment.current_step + 1, calcDueDate(nextStep.delay_days), enrollment.id]
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
            await client.query(
              `INSERT INTO sequence_step_logs
                 (org_id, enrollment_id, sequence_step_id, prospect_id,
                  channel, status, error_message, scheduled_send_at, fired_at)
               VALUES ($1, $2, $3, $4, $5, 'failed', $6, NOW(), NOW())`,
              [
                enrollment.org_id,
                enrollment.id,
                // sequence_step_id may not be known if the failure happened
                // before we resolved the step; null it out gracefully.
                null,
                enrollment.prospect_id,
                null,  // channel unknown at catch level — failure could be pre-channel
                String(stepErr.message || 'unknown error').slice(0, 1000),
              ]
            );
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
