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
const EmailTrackingService            = require('./EmailTrackingService');   // Insights/WBR Phase 7
const { sendEmail: sendOutlookEmail } = require('./outlookService');
const { plainTextToHtml }             = require('./emailFormatter');
const ThreadedSequenceNotifier        = require('./ThreadedSequenceNotifier');   // 2026_71 threaded-reply pause/notify
const PersonalizationDispatcher       = require('./PersonalizationDispatcher');  // lazy JIT personalisation
const LinkedInAutomationConfig        = require('./linkedinAutomationConfig');   // org→user→system auto-connect gate
const SenderTokenHealth               = require('./SenderTokenHealth');          // dead-credential detect / deactivate / notify
const EnrollmentStepResolver          = require('./EnrollmentStepResolver');     // identity-cursor + snapshot step resolution
const BounceDetectionService          = require('./BounceDetectionService');     // NDR screen for the reply auto-stop (v3)

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

// Hour-aware (WS3). NOTE: currently unreferenced inside the firer — advances
// go through SendingSchedule.nextStepDue — kept aligned so any future caller
// can't reintroduce day-only math.
function calcDueDate(delayDays, delayHours = 0) {
  const ms = ((parseInt(delayDays) || 0) * 24 + (parseInt(delayHours) || 0)) * 3600000;
  return new Date(Date.now() + ms);
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

    // Client has no active sender. Phase 3 (2026_53): if the client requires
    // a client-owned sender, do NOT borrow the rep's personal mailbox — return
    // null. Draft creation treats a null sender as "no signature" (non-fatal
    // by design); the hard enforcement happens at send time (auto-send via
    // pickEmailSenderWithCapacity, manual via /drafts/:logId/send).
    const pol = await dbClient.query(
      `SELECT require_client_sender FROM clients WHERE id = $1 AND org_id = $2`,
      [clientId, orgId]
    );
    if (pol.rows[0]?.require_client_sender === true) {
      console.warn(
        `SequenceStepFirer: no active client sender for client_id=${clientId} ` +
        `(org ${orgId}) and require_client_sender is set — NOT falling back to rep sender`
      );
      return null;
    }

    // Legacy behaviour (flag off): fall back to rep sender with a warning
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
// Returns: { sender, status: 'ok' | 'all_maxed' | 'cooling_down' | 'no_accounts' | 'client_sender_required' }
// 'client_sender_required' (Phase 3, 2026_53): the prospect's client has no
// active client-owned sender AND clients.require_client_sender is set — the
// caller must FAIL the step visibly, never fall back to the rep's mailbox.
async function pickEmailSenderWithCapacity(dbClient, orgId, userId, clientId, settings, now = new Date(), allowedSenderIds = null, pinnedSenderId = null) {
  const defaultLimit    = settings?.defaultDailyLimit ?? 50;
  const ceiling         = settings?.dailyLimitCeiling ?? 100;
  const defaultMinDelay = settings?.defaultMinDelayMinutes ?? 5;
  const minDelayFloor   = settings?.minDelayMinutesFloor ?? 2;

  const cols = `id, email, provider, display_name, signature, linkedin_signature,
                access_token, refresh_token,
                daily_limit, emails_sent_today, last_reset_at,
                min_delay_minutes, last_sent_at`;
  // Per-campaign sender selection (Phase 2): restrict the rep's sender pool to
  // the chosen accounts. NULL/empty = all of the rep's senders (prior behaviour).
  // Only applies to rep-owned senders; client-scoped senders are not narrowed.
  const allowed = (Array.isArray(allowedSenderIds) && allowedSenderIds.length) ? allowedSenderIds : null;
  // Sender pin (2026_71 — threaded / pin_sender enrollments). Unlike `allowed`
  // (a rep-only campaign restriction), the pin narrows BOTH rep and CLIENT
  // pools to the single stamped mailbox, so a threaded reply always leaves from
  // the address that opened the thread. NULL = no pin (normal rotation).
  const pin = (Number.isInteger(pinnedSenderId) && pinnedSenderId > 0) ? pinnedSenderId : null;
  let rows = [];
  if (clientId) {
    const r = await dbClient.query(
      `SELECT ${cols} FROM prospecting_sender_accounts
        WHERE org_id=$1 AND client_id=$2 AND is_active=true
          AND ($3::int IS NULL OR id = $3)`,
      [orgId, clientId, pin]
    );
    rows = r.rows;
    // Client has no active sender. Phase 3 (2026_53): a client that requires
    // a client-owned sender never borrows the rep's pool — surface a distinct
    // status so the caller fails the step VISIBLY (failAndPause) rather than
    // deferring forever or sending from the wrong identity.
    if (!rows.length) {
      const pol = await dbClient.query(
        `SELECT require_client_sender FROM clients WHERE id = $1 AND org_id = $2`,
        [clientId, orgId]
      );
      if (pol.rows[0]?.require_client_sender === true) {
        return { sender: null, status: 'client_sender_required' };
      }
    }
    // Fall back to rep senders if the client has none (mirrors resolveSender).
    if (!rows.length) {
      const rr = await dbClient.query(
        `SELECT ${cols} FROM prospecting_sender_accounts
          WHERE org_id=$1 AND user_id=$2 AND client_id IS NULL AND is_active=true
            AND ($3::int[] IS NULL OR id = ANY($3))
            AND ($4::int IS NULL OR id = $4)`,
        [orgId, userId, allowed, pin]
      );
      rows = rr.rows;
    }
  } else {
    const r = await dbClient.query(
      `SELECT ${cols} FROM prospecting_sender_accounts
        WHERE org_id=$1 AND user_id=$2 AND client_id IS NULL AND is_active=true
          AND ($3::int[] IS NULL OR id = ANY($3))
          AND ($4::int IS NULL OR id = $4)`,
      [orgId, userId, allowed, pin]
    );
    rows = r.rows;
  }

  if (!rows.length) return { sender: null, status: 'no_accounts' };

  // ── Mailbox-identity limits ─────────────────────────────────────────────────
  // The daily limit and the min-delay cooldown are properties of the PHYSICAL
  // MAILBOX, not of a row. Nothing stops two reps from connecting the same
  // Gmail address: that produces two rows, each with its own daily_limit and
  // its own emails_sent_today counter. Reading a single row's counter lets one
  // address send 2x (or Nx) its stated limit, and lets rep B send while rep A's
  // row is still inside its min-delay cooldown. Google does not care which
  // user_id owned the row.
  //
  // So aggregate across every active row in the org sharing lower(email):
  //   sentToday  = Σ counters (stale counter → 0, matching the reset semantics)
  //   lastSentAt = MAX(last_sent_at)   — the cooldown clock for the address
  //   effLimit   = MIN(effective limit) — the tightest declared limit wins;
  //                a rep who set 20 must not be overridden by a rep who set 50
  //
  // NOTE this REDUCES effective capacity for any org currently double-connected
  // to one address. That is the correct behaviour and it will look like a
  // regression to them. See check (b) in 2026_48_capacity_model.sql.
  const mailboxes = [...new Set(rows.map(r => (r.email || '').toLowerCase()).filter(Boolean))];
  const mbAgg = new Map();
  if (mailboxes.length) {
    const agg = await dbClient.query(
      `SELECT lower(email) AS mailbox,
              SUM(CASE WHEN last_reset_at >= CURRENT_DATE
                       THEN COALESCE(emails_sent_today, 0) ELSE 0 END)::int AS sent_today,
              MAX(last_sent_at)                                             AS last_sent_at,
              MIN(LEAST(COALESCE(daily_limit, $3::int), $4::int))::int      AS eff_limit
         FROM prospecting_sender_accounts
        WHERE org_id = $1
          AND is_active = true
          AND lower(email) = ANY($2::text[])
        GROUP BY 1`,
      [orgId, mailboxes, defaultLimit, ceiling]
    );
    for (const a of agg.rows) mbAgg.set(a.mailbox, a);
  }

  let best = null, bestRemaining = 0;
  let anyCapacityButCooling = false;
  for (const row of rows) {
    const mb = mbAgg.get((row.email || '').toLowerCase());
    // Fall back to row-local values if the aggregate somehow missed (defensive).
    const effLimit = mb ? mb.eff_limit : Math.min(
      (row.daily_limit != null && row.daily_limit > 0) ? row.daily_limit : defaultLimit,
      ceiling
    );
    const sentToday   = mb ? mb.sent_today : (row.emails_sent_today || 0);
    const lastSentAt  = mb ? mb.last_sent_at : row.last_sent_at;
    const remaining   = effLimit - sentToday;
    if (remaining <= 0) continue; // mailbox at/over its daily limit

    // Cooldown: effective min-delay, never below the org floor. Keyed on the
    // mailbox's most recent send across ALL rows for that address.
    const effMinDelay = Math.max(
      (row.min_delay_minutes != null ? row.min_delay_minutes : defaultMinDelay),
      minDelayFloor
    );
    const cooledDown = effMinDelay <= 0 || !lastSentAt ||
      (now.getTime() - new Date(lastSentAt).getTime()) >= effMinDelay * 60000;
    if (!cooledDown) { anyCapacityButCooling = true; continue; }

    if (remaining > bestRemaining) { best = row; bestRemaining = remaining; }
  }
  if (best) return { sender: best, status: 'ok' };
  // No eligible account: distinguish "still cooling down" (capacity exists, just
  // too soon) from "all maxed" (no capacity left today). Both defer.
  if (anyCapacityButCooling) return { sender: null, status: 'cooling_down' };
  return { sender: null, status: 'all_maxed' };
}

// ── Fair-share load counters ─────────────────────────────────────────────────
// Because the firer sends AT MOST ONE email per mailbox per tick (min-delay
// cooldown), the order in which due enrollments are visited IS the allocation
// mechanism. Ordering purely by next_step_due means whichever campaign laid the
// earliest slots wins every tick, all day — and slots are laid at activation,
// so "activated first" literally means "takes the whole day".
//
// Load is counted per (campaign, sender), not per campaign. A campaign sitting
// on an uncontended mailbox must not be pushed to the back of the queue because
// it has sent a lot today — its sends cost no other campaign anything. Ordering
// it behind a campaign that is merely waiting on a busy mailbox's cooldown
// leaves its own mailbox idle.
//
// Counts 'sending' as well as 'sent': a claim in flight has already consumed
// the mailbox for this tick.
async function emailLoadByCampaignSender(dbClient, orgIds) {
  if (!orgIds.length) return new Map();
  const { rows } = await dbClient.query(
    `SELECT p.campaign_id, l.sender_account_id, COUNT(*)::int AS n
       FROM sequence_step_logs l
       JOIN prospects p ON p.id = l.prospect_id
      WHERE l.org_id = ANY($1::int[])
        AND l.channel = 'email'
        -- The firer's own send path leaves email rows at 'sent' (it does not
        -- call sequenceStepAdvance). 'completed' is included defensively for
        -- approval-path sends that route through /complete. Dropping it makes
        -- an approved send vanish from today's load the moment the rep clicks
        -- through, and the mailbox cap releases another one in its place.
        AND l.status IN ('sending','sent','completed')
        AND l.fired_at >= CURRENT_DATE
        AND l.sender_account_id IS NOT NULL
        AND p.campaign_id IS NOT NULL
      GROUP BY 1, 2`,
    [orgIds]
  );
  const m = new Map();
  for (const r of rows) m.set(`${r.campaign_id}:${r.sender_account_id}`, r.n);
  return m;
}

// LinkedIn has no sender account — the rep IS the account — so load groups by
// (campaign, rep) rather than (campaign, sender).
async function linkedinLoadByCampaignRep(dbClient, orgIds) {
  if (!orgIds.length) return new Map();
  const { rows } = await dbClient.query(
    `SELECT p.campaign_id, se.enrolled_by, COUNT(*)::int AS n
       FROM sequence_step_logs l
       JOIN sequence_enrollments se ON se.id = l.enrollment_id
       JOIN prospects p ON p.id = l.prospect_id
      WHERE l.org_id = ANY($1::int[])
        AND l.channel = 'linkedin'
        -- 'completed' included for the same reason as the cap counter above.
        AND l.status IN ('draft','scheduled','sending','sent','completed')
        AND COALESCE(l.fired_at, l.scheduled_send_at) >= CURRENT_DATE
        AND p.campaign_id IS NOT NULL
      GROUP BY 1, 2`,
    [orgIds]
  );
  const m = new Map();
  for (const r of rows) m.set(`${r.campaign_id}:${r.enrolled_by}`, r.n);
  return m;
}

// The rep's active mailboxes, used when a campaign pins no senders
// (sender_account_ids IS NULL ⇒ "all of the rep's senders").
async function activeSenderIdsForUser(dbClient, orgId, userId) {
  const { rows } = await dbClient.query(
    `SELECT id FROM prospecting_sender_accounts
      WHERE org_id=$1 AND user_id=$2 AND client_id IS NULL AND is_active=true`,
    [orgId, userId]
  );
  return rows.map(r => r.id);
}

// ── LinkedIn connection-request daily cap ────────────────────────────────────
// LinkedIn is a personal account: one per rep, no sender-account row, and no
// fire-time enforcement anywhere until now. `linkedinReleaseCap` existed only
// inside scheduleBatchSlots, which paces the ACTIVATION batch (step 1) — so a
// connection request arriving as a follow-up step in an email-led sequence blew
// straight through the cap.
//
// The cap governs CONNECTION REQUESTS ONLY. LinkedIn messages, tasks and calls
// are uncapped: they cost the rep nothing with LinkedIn's rate limiter.
//
// Counted statuses cover the whole released surface, not just confirmed sends:
//   draft                     — released to the rep as a task to action
//   scheduled / sending       — claimed by the browser extension for auto-send
//   sent                      — confirmed
// A request that was released and then abandoned still consumed the day's quota
// as far as LinkedIn is concerned.
//
// "Today" is CURRENT_DATE, matching the reset semantics of
// prospecting_sender_accounts.last_reset_at. Consistency with the email side
// beats per-timezone precision here.
async function linkedinConnectionRequestsToday(dbClient, orgId, userId) {
  const { rows } = await dbClient.query(
    `SELECT COUNT(*)::int AS n
       FROM sequence_step_logs l
       JOIN sequence_enrollments se ON se.id = l.enrollment_id
      WHERE l.org_id      = $1
        AND se.enrolled_by = $2
        AND l.channel     = 'linkedin'
        AND l.step_intent = 'connection_request'
        -- 'completed' is REQUIRED. When a rep actions a LinkedIn task, the
        -- /complete endpoint (sequenceStepAdvance.service.js:83) flips the row
        -- draft → completed. Omitting it meant a request dropped out of the
        -- counter the moment the rep sent it, so the cap released another one:
        -- the ceiling leaked one-for-one with how fast the rep worked.
        -- 'skipped' stays out — the rep declined, LinkedIn never saw it.
        AND l.status IN ('draft','scheduled','sending','sent','completed')
        -- fired_at is NULL on 'draft' and 'scheduled' rows (set only on send /
        -- extension confirm), so anchor on when the row was RELEASED.
        AND COALESCE(l.fired_at, l.scheduled_send_at) >= CURRENT_DATE`,
    [orgId, userId]
  );
  return rows[0]?.n || 0;
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

// ── Quoted-history helpers (2026_75) ─────────────────────────────────────────
//
// Threaded replies previously carried correct RFC headers but no visible quoted
// history: Gmail never adds any, and the Outlook path overwrote createReply's
// natively-quoted draft body. These build the quote block ourselves so BOTH
// providers produce identical output.
//
// Only the immediate parent is quoted. Its stored body_quotable already contains
// the quote block that went out with it, so the chain reproduces itself — one
// lookup per send rather than one per ancestor.

function _escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Gmail-style attribution, returned as RAW TEXT. The HTML branch escapes it; the
// plain branch must not, or recipients see &lt; and &amp; literally.
function _quoteAttributionText(sentAt, fromName, fromAddress) {
  const d = sentAt ? new Date(sentAt) : new Date();
  const stamp = d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const who = fromName ? `${fromName} <${fromAddress}>` : String(fromAddress || '');
  return `On ${stamp}, ${who} wrote:`;
}

// Fetch the parent message's quote material for this conversation.
// Returns null when there is nothing quotable — a pre-2026_75 thread, or a first
// send. Callers must treat null as "send without a quote block", never as an
// error: threading still works from the headers alone.
async function _loadQuotableParent(client, { conversationId, prospectId, orgId }) {
  if (!conversationId && !prospectId) return null;
  const { rows } = await client.query(
    `SELECT subject, body_quotable, body_format, sent_at, from_address
       FROM emails
      WHERE org_id = $1
        AND direction = 'sent'
        AND body_quotable IS NOT NULL
        AND ($2::text IS NULL OR conversation_id = $2)
        AND ($3::int  IS NULL OR prospect_id     = $3)
      ORDER BY sent_at DESC
      LIMIT 1`,
    [orgId, conversationId || null, conversationId ? null : (prospectId || null)]
  );
  return rows[0] || null;
}

// Append the quote block. Body first, quote second — see the ordering note at the
// signature call site; appendSignature() would otherwise see the parent's
// signature inside the quote and suppress the new one.
//
// 2026_76: format must match. The parent's body_quotable is embedded verbatim, so
// quoting an HTML parent into a plain reply would dump raw markup into the
// recipient's inbox, and a plain parent into an HTML reply would lose every line
// break. On mismatch we skip the quote entirely — threading still works from the
// RFC headers, so the cost is one message without visible history rather than one
// message that looks broken. Degrade, never corrupt.
function attachQuotedHistory(body, parent, senderDisplayName, format = 'html') {
  if (!parent || !parent.body_quotable) return body;

  // NULL body_format means pre-2026_76, which was always HTML.
  const parentFormat = parent.body_format || 'html';
  if (parentFormat !== format) return body;

  const attributionRaw = _quoteAttributionText(
    parent.sent_at, senderDisplayName || null, parent.from_address || ''
  );

  if (format === 'plain') {
    // RFC-conventional quoting: prefix every line of the parent with '> '.
    // Nested quotes deepen naturally because the parent already carries its own.
    const quoted = String(parent.body_quotable)
      .split(/\r?\n/)
      .map(line => (line.length ? `> ${line}` : '>'))
      .join('\n');
    return `${body}\n\n${attributionRaw}\n${quoted}`;
  }

  return (
    `${body}` +
    `<br><br><div class="gmail_quote">` +
    `<div dir="ltr" class="gmail_attr">${_escapeHtml(attributionRaw)}</div>` +
    `<blockquote class="gmail_quote" ` +
    `style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">` +
    `${parent.body_quotable}` +
    `</blockquote></div>`
  );
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

// ── Lazy (JIT) personalisation ───────────────────────────────────────────────
// Default mode: enrollments are created WITHOUT personalised content. The skill
// runs here, on demand, only when a step's artifact is actually being produced —
// a draft is being written, or (for auto-send) a sender slot has already been
// secured. So we never spend an LLM call on a step that can't proceed (deferred
// for capacity, or a prospect removed first), and we use the freshest
// engagement history available at that moment.
//
// Returns the personalised step { subject, body, personalize_sources } or null
// (caller then falls back to the sequence template). Persists the result onto
// the enrollment so it's reused — and frozen — on subsequent ticks.
async function ensureStepPersonalized(client, enrollment, channel) {
  if (enrollment.seq_ai_enabled === false) return null;            // templated sequence
  if (channel !== 'email' && channel !== 'linkedin') return null;  // call/task → templates

  // Resolve the current step by identity (snapshot- and reorder-safe). The
  // personalised-content cache is keyed by the step's stable ID — NOT the
  // step_order ordinal — so a reorder can never serve step A's draft as step B.
  // The dispatcher still filters by step_order (its public contract), so we
  // resolve the current step once and use its id for the cache key and its
  // step_order for the dispatcher call.
  const curStep = await EnrollmentStepResolver.currentStep(client, enrollment);
  if (!curStep) return null;
  const cacheKey = String(curStep.id);
  const orderKey = curStep.step_order;

  const existing = enrollment.personalised_steps?.[cacheKey];
  if (existing) return existing;                                   // eager / prior tick

  let result;
  try {
    result = await PersonalizationDispatcher.personaliseEnrollment({
      orgId:         enrollment.org_id,
      userId:        enrollment.enrolled_by,
      sequenceId:    enrollment.seq_id,
      prospectId:    enrollment.prospect_id,
      onlyStepOrder: orderKey,
    });
  } catch (err) {
    console.warn(`SequenceStepFirer: JIT personalise failed for enrollment ${enrollment.id} step ${orderKey} (id ${curStep.id}): ${err.message}`);
    return null;                                                   // fall back to template
  }

  const ps = result.personalisedSteps?.[orderKey] ?? result.personalisedSteps?.[String(orderKey)] ?? null;
  if (!ps) return null;

  const merged = { ...(enrollment.personalised_steps || {}), [cacheKey]: ps };
  await client.query(
    `UPDATE sequence_enrollments SET personalised_steps = $1::jsonb WHERE id = $2`,
    [JSON.stringify(merged), enrollment.id]
  );
  enrollment.personalised_steps = merged;
  return ps;
}

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
    // Channel comes from the denormalized se.current_step_channel (kept in sync
    // by enroll + advance), so this no longer depends on step_order === current_step,
    // which breaks after a reorder and misses frozen (snapshot) enrollments.
    `SELECT se.id, se.org_id, se.next_step_due
       FROM sequence_enrollments se
      WHERE se.status = 'active'
        AND se.next_step_due IS NOT NULL
        AND se.current_step_channel IN ('linkedin','task','call')`
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
    // Identity-cursor join (ss.id = se.current_step_id) instead of the ordinal
    // step_order = current_step. Reorder preserves step IDs, so this stays
    // correct across reorders. steps_snapshot is selected so frozen enrollments
    // can override content from their pinned plan (below).
    // A/B (2026_47): the arm join matches the UNIQUE triple
    // (experiment_id, sequence_step_id, variant_key) — uq_ssv_exp_step_key — so
    // it can add at most one row and never duplicates a candidate. Scoping by
    // experiment_id is what stops a second test rewriting the copy of
    // enrollments still in flight from the first. When se.variant_key IS NULL
    // (equivalently experiment_id IS NULL, per chk_se_arm_has_experiment) the
    // join misses and every column below reads exactly as it did pre-A/B.
    // Status is deliberately NOT filtered: a paused or concluded arm must still
    // resolve for the enrollments already stamped with it.
    `SELECT se.id              AS enrollment_id,
            se.org_id,
            se.prospect_id,
            se.current_step,
            se.current_step_id,
            se.steps_snapshot,
            se.variant_key,
            se.experiment_id,
            se.next_step_due,
            se.personalised_steps,
            ss.id              AS step_id,
            ss.subject_template,
            ss.body_template,
            sv.subject_template AS variant_subject_template,
            sv.body_template    AS variant_body_template,
            ss.step_intent,
            p.first_name, p.last_name, p.title,
            p.company_name, p.company_industry, p.company_domain,
            a.name AS account_name, a.industry AS account_industry,
            a.domain AS account_domain
       FROM sequence_enrollments se
       JOIN sequences s       ON s.id  = se.sequence_id
       JOIN sequence_steps ss ON ss.id = se.current_step_id
       JOIN prospects p       ON p.id  = se.prospect_id
  LEFT JOIN accounts a        ON a.id  = p.account_id
  LEFT JOIN prospecting_campaigns pc ON pc.id = p.campaign_id
  LEFT JOIN sequence_step_variants sv
         ON sv.experiment_id     = se.experiment_id
        AND sv.sequence_step_id  = ss.id
        AND sv.variant_key       = se.variant_key
      WHERE se.status = 'active'
        AND se.next_step_due IS NOT NULL
        -- Campaign-level "pause all sending" brake (2026_51). Without this the
        -- top-up would re-create a fresh 'scheduled' row every tick for paused
        -- campaigns, defeating the due-query guard. LEFT JOIN means a NULL
        -- campaign is never paused (NULL IS NOT TRUE evaluates TRUE).
        AND pc.sending_paused IS NOT TRUE
        AND ${AUTO_SEND_PREDICATE}
        AND s.ai_enabled = false
        -- Has this (enrollment, step) EVER produced a log row?
        --
        -- This list used to read ('scheduled','sending','sent'). It omitted
        -- 'completed', and sequenceStepAdvance.service.js transitions
        -- sent → completed on every successful advance. So the moment a step
        -- completed, this guard went blind to it: if se.current_step_id ever
        -- pointed back at that step — which a sequence reorder does — the
        -- top-up re-inserted a 'scheduled' row and the step fired a SECOND
        -- time. Prospects received duplicate emails and duplicate LinkedIn
        -- touches. Confirmed in production: distinct email_id values on both
        -- step_log rows.
        --
        -- 'draft', 'replied' and 'superseded_duplicate' were missing for the
        -- same reason. We now match on any prior log for the pair EXCEPT the
        -- two that legitimately warrant another attempt:
        --   'failed'  — handleSendFailure() pauses the enrollment anyway, and
        --               this query only considers se.status = 'active', so this
        --               exclusion is belt-and-braces.
        --   'skipped' — a step skipped by a rep (or by the accept-gate) may be
        --               re-attempted after a resume. Excluding it preserves the
        --               pre-existing behaviour exactly.
        --
        -- Predicate is kept in lockstep with the uq_seq_step_logs_fired index
        -- (migration 2026_48). The guard stops the firer trying; the index
        -- guarantees it cannot succeed. Change one, change the other.
        AND NOT EXISTS (
          SELECT 1 FROM sequence_step_logs l
           WHERE l.enrollment_id    = se.id
             AND l.sequence_step_id = ss.id
             AND l.status NOT IN ('failed', 'skipped')
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
    // Personalised drafts are cached by stable step ID (reorder-safe).
    const personalised = ps[String(row.current_step_id)] || null;

    // Template precedence: personalised_steps → steps_snapshot → variant → base.
    let subjectTemplate = row.subject_template;
    let bodyTemplate    = row.body_template;

    // A/B (2026_47): the arm's copy sits above the base step. A blank/NULL field
    // on the arm row falls through, so an arm may vary the subject alone and
    // inherit the body. No-op when se.variant_key IS NULL (the join missed).
    if (row.variant_subject_template) subjectTemplate = row.variant_subject_template;
    if (row.variant_body_template)    bodyTemplate    = row.variant_body_template;

    // Frozen enrollments (steps_snapshot present) send the templates pinned at
    // freeze time, not whatever the live step has since been edited to.
    // Snapshots written on or after 2026_46 are ALREADY arm-resolved (freeze
    // stamps variant_key + experiment_id onto every row), so they outrank the join above and
    // must not be overlaid twice. Legacy snapshots have no variant_key key and
    // still win over the base step, exactly as before — but they lose to the
    // arm, because they were pinned before the test existed.
    if (Array.isArray(row.steps_snapshot) && row.steps_snapshot.length) {
      const snap = row.steps_snapshot.find(s => s.id === row.current_step_id);
      const snapIsArmResolved = snap && Object.prototype.hasOwnProperty.call(snap, 'variant_key');
      if (snap && (snapIsArmResolved ? snap.variant_key === row.variant_key : !row.variant_key)) {
        subjectTemplate = snap.subject_template;
        bodyTemplate    = snap.body_template;
      }
    }

    const subject = personalised?.subject ?? renderTemplate(subjectTemplate, prospect, account);
    const body    = personalised?.body    ?? renderTemplate(bodyTemplate,    prospect, account);
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

// ── Threaded-reply helpers (2026_71) ─────────────────────────────────────────

/**
 * Resolve the wire subject for a threaded REPLY. 'keep' returns the root
 * subject verbatim (Gmail nests on subject match); 're' prefixes "Re: " unless
 * one is already present. Never double-prefixes.
 */
function applyThreadSubject(subject, mode) {
  const s = (subject || '').trim();
  if (mode === 're') {
    return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
  }
  return s; // 'keep' (default)
}

/**
 * Pause an enrollment whose PINNED sender can't send (threaded / pin_sender in
 * 'defer' failover mode). Unlike failAndPause this fires an IMMEDIATE owner
 * notification carrying the three resolution options, and marks the row with a
 * distinct stop_reason ('thread_sender_blocked') the daily digest scans for.
 *
 * The pause UPDATE is guarded by status='active' + RETURNING so the notify only
 * fires on the transition INTO the blocked state — a later tick that finds it
 * already paused updates 0 rows and stays silent (no duplicate alerts). The
 * daily digest (threadedSequenceDigest.js) handles the recurring reminder.
 */
async function pauseThreadBlocked(client, info) {
  const {
    orgId, enrollmentId, stepId, prospectId, enrolledBy,
    seqName, seqId, stepOrder, senderId, reason,
  } = info;
  const msg = String(reason || 'Pinned sending mailbox unavailable.').slice(0, 1000);

  // Fail the in-flight row (if any).
  await client.query(
    `UPDATE sequence_step_logs
        SET status='failed', error_message=$3, fired_at=NOW()
      WHERE enrollment_id=$1 AND sequence_step_id=$2
        AND status IN ('scheduled','sending')`,
    [enrollmentId, stepId, msg]
  );

  // Pause with the digest sentinel — only if currently active (dedup guard).
  const paused = await client.query(
    `UPDATE sequence_enrollments
        SET status='paused', stop_reason='thread_sender_blocked'
      WHERE id=$1 AND status='active'
      RETURNING id`,
    [enrollmentId]
  );
  if (paused.rowCount === 0) return; // already parked — stay silent

  try {
    await ThreadedSequenceNotifier.notifyBlocked(client, {
      orgId, userId: enrolledBy, enrollmentId, seqId, seqName, stepOrder, senderId, reason: msg,
    });
  } catch (e) {
    console.warn(`pauseThreadBlocked: notify failed for enrollment ${enrollmentId}:`, e.message);
  }

  try {
    await client.query(
      `INSERT INTO prospecting_activities
                   (org_id, prospect_id, user_id, activity_type, description, metadata)
            VALUES ($1, $2, $3, 'sequence_thread_blocked', $4, $5)`,
      [orgId, prospectId, enrolledBy,
       `Threaded sequence paused — ${seqName || 'sequence'} step ${stepOrder ?? '?'}: ${msg}`,
       JSON.stringify({ enrollmentId, stepId, stepOrder: stepOrder ?? null, senderId, reason: msg })]
    );
  } catch (e) {
    console.warn(`pauseThreadBlocked: activity log failed for enrollment ${enrollmentId}:`, e.message);
  }
}

/**
 * Reclaim rows stuck in 'sending' (worker crashed between claim and finalize).
 * Per the no-auto-retry policy a possibly-half-sent email is treated as a
 * failure needing human verification — NOT silently retried.
 *
 * @returns {Promise<number>} rows reaped
 */
// ── Effective LinkedIn intent (auto-send gate + signature) ────────────────────
// Explicit sequence_steps.step_intent always wins. When it is NULL — the "Auto"
// default in the builder, or any templated sequence that previously couldn't set
// it — fall back to the SAME inference the personalization dispatcher uses, so a
// first-position LinkedIn step is recognised as a connection_request by the
// auto-send gate and the signature rule too, not only by personalisation.
// Only LinkedIn is inferred here; other channels return their explicit value.
// Best-effort: any lookup failure returns null, which keeps the safe
// human-actioned draft path — never an accidental auto-send.
async function resolveEffectiveLinkedinIntent(step, enrollment) {
  if (step.channel !== 'linkedin') return step.step_intent || null;
  if (step.step_intent) return step.step_intent;          // explicit override wins
  try {
    const [allSteps, engagementHistory] = await Promise.all([
      PersonalizationDispatcher.loadSequenceSteps(enrollment.seq_id, enrollment.org_id),
      PersonalizationDispatcher.loadEngagementHistory(enrollment.prospect_id, enrollment.org_id),
    ]);
    return PersonalizationDispatcher.inferIntent({
      channel: 'linkedin', step, allSteps, engagementHistory,
    }) || null;
  } catch (err) {
    console.warn(
      `SequenceStepFirer: LinkedIn intent inference failed for enrollment ${enrollment.id} ` +
      `step ${step.id}: ${err.message}`
    );
    return null;   // safe fallback → human-actioned draft, not auto-send
  }
}

async function reapStaleSending(client, staleMinutes = 30) {
  const stale = await client.query(
    `SELECT l.id, l.org_id, l.enrollment_id, l.sequence_step_id, l.prospect_id,
            se.enrolled_by, se.current_step, s.name AS seq_name
       FROM sequence_step_logs l
       JOIN sequence_enrollments se ON se.id = l.enrollment_id
       JOIN sequences s             ON s.id  = se.sequence_id
      WHERE l.status = 'sending'
        -- LinkedIn auto-send rows ALSO sit in 'sending' while leased to the
        -- browser extension. They are NOT email worker crashes — they have their
        -- own lease_expires_at and are reclaimed back to 'scheduled' by the
        -- LinkedIn reclaim sweep (LinkedInAutoSendService.reclaimExpiredLeases),
        -- never fail+paused here. Excluding them keeps this reaper email-only.
        AND l.channel = 'email'
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

// Re-entrancy guard for fireDueSteps. node-cron fires every minute regardless
// of whether the previous tick finished; a tick doing AI personalization plus
// real sends over a 100-enrollment batch can exceed 60s. The send path itself
// is overlap-safe (atomic scheduled→sending claim + uq_seq_step_logs_pending),
// but the draft branch is check-then-insert (duplicate drafts under overlap)
// and a second concurrent tick doubles LLM spend for nothing. Single-process
// guard is sufficient for the single-instance Railway deployment; if this ever
// runs multi-instance, replace with a pg advisory lock.
let _fireDueStepsRunning = false;

const SequenceStepFirer = {
  /**
   * Fire all due sequence steps across all orgs.
   * Safe to call on a schedule — processes up to 100 enrollments per run.
   * Overlapping invocations are skipped (see _fireDueStepsRunning above).
   * @returns {{ fired: number, stopped: number, errors: number, drafted: number }}
   */
  async fireDueSteps() {
    if (_fireDueStepsRunning) {
      console.warn('📨 fireDueSteps: previous tick still running — skipping this tick');
      return { fired: 0, stopped: 0, errors: 0, drafted: 0, skippedOverlap: true };
    }
    _fireDueStepsRunning = true;
    try {
      return await this._fireDueStepsInner();
    } finally {
      _fireDueStepsRunning = false;
    }
  },

  async _fireDueStepsInner() {
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
        // current_step_channel is read from the denormalized enrollment column
        // (kept in sync on enroll + advance), so this hot query no longer joins
        // sequence_steps on step_order = current_step — a join that breaks after
        // a reorder and can't see frozen (snapshot) enrollments at all. The exact
        // step (live or snapshot) is resolved per-enrollment in the loop body via
        // EnrollmentStepResolver.
        //
        // PER-CHANNEL LIMIT. A flat `LIMIT 100 ORDER BY next_step_due` couples
        // the channels: LinkedIn rows deferred by the connection cap do NOT get
        // a draft row, so the "parked" NOT EXISTS guard below never sees them —
        // they stay due, stay oldest, and re-occupy the batch every single tick
        // for the rest of the day. With a large enough LinkedIn backlog they
        // crowd email out of the window entirely and the mailbox idles while
        // work is waiting. Partitioning by channel decouples them: each channel
        // gets its own 100 oldest rows, and a saturated channel cannot starve a
        // channel with capacity to spare.
        `WITH due AS (
         SELECT se.*, s.id AS seq_id, s.name AS seq_name,
                s.require_approval AS seq_require_approval,
                s.ai_enabled AS seq_ai_enabled,
                s.stop_on_connection_accept AS seq_stop_on_accept,
                s.body_format          AS seq_body_format,
                s.thread_replies       AS seq_thread_replies,
                s.pin_sender           AS seq_pin_sender,
                s.thread_subject_mode  AS seq_thread_subject_mode,
                s.thread_failover_mode AS seq_thread_failover_mode,
                p.campaign_id AS prospect_campaign_id,
                pc.stop_on_reply AS camp_stop_on_reply,
                p.channel_data->'linkedin'->>'connection_status' AS li_connection_status,
                p.channel_data->'linkedin'->>'connected_at'      AS li_connected_at
                -- NOTE: current_step_channel is intentionally NOT re-selected here.
                -- It is a real column on sequence_enrollments, so se.* above already
                -- provides it. Selecting it a second time made the due CTE expose
                -- two identically-named columns, and the later PARTITION BY
                -- due.current_step_channel then failed with "column reference
                -- current_step_channel is ambiguous", throwing the entire
                -- fireDueSteps query on every tick.
           FROM sequence_enrollments se
           JOIN sequences  s ON s.id = se.sequence_id
           JOIN prospects  p ON p.id = se.prospect_id
      LEFT JOIN prospecting_campaigns pc ON pc.id = p.campaign_id
          WHERE se.status = 'active'
            AND se.next_step_due <= NOW()
            -- Campaign-level "pause all sending" brake (2026_51). When a
            -- campaign is paused, none of its enrollments are claimed here —
            -- across ALL channels, since this is the shared claim query. pc is
            -- LEFT JOINed, so campaign_id IS NULL yields pc.sending_paused NULL
            -- and NULL IS NOT TRUE evaluates TRUE: unattributed prospects go on.
            -- Enrollment status is untouched, so clearing the flag resumes on
            -- the next in-window tick with no re-stamp.
            AND pc.sending_paused IS NOT TRUE
            -- Park enrollments whose current step already has a draft awaiting
            -- the rep (manual channels, or approval-required email). Creating a
            -- draft does NOT advance the enrollment, so without this they stay
            -- perpetually 'due' and — sorted oldest-first — monopolize the
            -- LIMIT batch, starving email auto-sends. They re-enter the queue
            -- the moment the rep actions the draft (status leaves 'draft').
            --
            -- Same reasoning for LinkedIn auto-send: a connection_request step
            -- that's been materialized as a 'scheduled'/'sending' linkedin row
            -- is actuated by the browser EXTENSION, not the firer. The firer
            -- must not keep re-selecting it (it would no-op on the idempotency
            -- guard, but still burn a LIMIT slot every tick). It re-enters the
            -- queue when the extension confirms the send (row → 'sent') and the
            -- enrollment advances, OR if the row is failed/skipped. NOTE: email
            -- 'scheduled' rows are deliberately NOT parked — the firer's SEND
            -- branch must claim those itself.
            AND NOT EXISTS (
              SELECT 1 FROM sequence_step_logs l
               WHERE l.enrollment_id    = se.id
                 AND l.sequence_step_id = se.current_step_id
                 AND ( l.status = 'draft'
                    OR (se.current_step_channel = 'linkedin' AND l.status IN ('scheduled','sending')) )
            )
        )
        SELECT * FROM (
          SELECT due.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY due.current_step_channel
                   ORDER BY due.next_step_due ASC, due.id ASC
                 ) AS _chan_rn
            FROM due
        ) ranked
        WHERE ranked._chan_rn <= 100
        ORDER BY next_step_due ASC, id ASC`
      );

      // Resolve send-window settings per (orgId, campaignId) once and cache —
      // many enrollments share the same campaign, so we don't want to hit
      // the DB for resolveSettings on every iteration.
      const SendingSchedule = require('./SendingScheduleResolver');
      const settingsCache = new Map();
      // Keyed on userId as well: resolveSettings now folds in the rep's personal
      // LinkedIn connection cap (user_preferences.outreach.linkedinConnectionCap),
      // so two reps on the same campaign can resolve different linkedinReleaseCap.
      const getSettings = async (orgId, campaignId, userId) => {
        const key = `${orgId}:${campaignId || 'null'}:${userId || 'null'}`;
        if (!settingsCache.has(key)) {
          settingsCache.set(key,
            await SendingSchedule.resolveSettings({ orgId, campaignId, userId }));
        }
        return settingsCache.get(key);
      };

      // Per-campaign sender selection (Phase 2): which sender accounts this
      // campaign is restricted to. NULL/empty = all of the rep's senders. Cached
      // per campaign so a batch of enrollments for one campaign hits the DB once.
      const senderSelCache = new Map();
      const getCampaignSenderIds = async (orgId, campaignId) => {
        if (!campaignId) return null;
        const key = `${orgId}:${campaignId}`;
        if (!senderSelCache.has(key)) {
          let ids = null;
          try {
            const r = await pool.query(
              `SELECT sender_account_ids FROM prospecting_campaigns WHERE id=$1 AND org_id=$2`,
              [campaignId, orgId]
            );
            const raw = r.rows[0]?.sender_account_ids;
            ids = (Array.isArray(raw) && raw.length) ? raw : null;
          } catch { ids = null; } // missing column / lookup failure → all senders
          senderSelCache.set(key, ids);
        }
        return senderSelCache.get(key);
      };

      // ── Fair-share ordering ───────────────────────────────────────────────
      // The SQL above still orders by next_step_due (it needs SOME order to
      // apply its LIMIT). Re-order the fetched batch here, where the load
      // counters are available.
      //
      // Key, in order:
      //   1. loadKey  — sends today on the LEAST-LOADED mailbox this campaign
      //                 can reach. A campaign on an idle mailbox sorts first,
      //                 regardless of how much it has already sent, because its
      //                 sends cost nobody else anything.
      //   2. inFlight — TIEBREAK ONLY. At equal load, an enrollment mid-sequence
      //                 (current_step > 1) beats a fresh one. A prospect who
      //                 misses step 1 by a day is fine; one who misses step 3
      //                 gets a visibly broken cadence.
      //   3. next_step_due, then id — the original deterministic order.
      //
      // KNOWN LIMIT: the SQL LIMIT still selects its 100 rows by next_step_due,
      // so a backlog larger than 100 can crowd out a campaign before this sort
      // ever sees it. Raising the LIMIT costs a per-enrollment reply-check query
      // each tick, so it is deliberately left alone until a backlog that size is
      // real. At one email per mailbox per tick, 100 is deep headroom.
      const orgIds = [...new Set(dueRes.rows.map(r => r.org_id))];
      let emailLoad = new Map(), liLoad = new Map();
      try {
        [emailLoad, liLoad] = await Promise.all([
          emailLoadByCampaignSender(client, orgIds),
          linkedinLoadByCampaignRep(client, orgIds),
        ]);
      } catch (loadErr) {
        // Non-fatal: fall back to pure next_step_due order (previous behaviour).
        console.warn('📨 fair-share load counters failed, falling back to FIFO:', loadErr.message);
      }

      // Resolve each campaign's reachable mailboxes once.
      const reachCache = new Map();
      const reachableSenders = async (orgId, campaignId, userId) => {
        const key = `${orgId}:${campaignId || 'null'}:${userId}`;
        if (!reachCache.has(key)) {
          let ids = await getCampaignSenderIds(orgId, campaignId);
          if (!ids || !ids.length) {
            try { ids = await activeSenderIdsForUser(client, orgId, userId); }
            catch { ids = []; }
          }
          reachCache.set(key, ids);
        }
        return reachCache.get(key);
      };

      const ordered = [];
      for (const r of dueRes.rows) {
        const ch = r.current_step_channel || 'email';
        let loadKey = 0;
        if (ch === 'email') {
          const senders = await reachableSenders(r.org_id, r.prospect_campaign_id, r.enrolled_by);
          // min over reachable mailboxes; no mailbox → 0 (it will fail-and-pause
          // in the loop anyway, and must not be starved out of getting there).
          loadKey = senders.length
            ? Math.min(...senders.map(sid => emailLoad.get(`${r.prospect_campaign_id}:${sid}`) || 0))
            : 0;
        } else if (ch === 'linkedin') {
          loadKey = liLoad.get(`${r.prospect_campaign_id}:${r.enrolled_by}`) || 0;
        }
        // call/task are uncapped — loadKey stays 0, so they keep FIFO order
        // among themselves and never queue behind a busy mailbox.
        ordered.push({ r, loadKey, inFlight: (r.current_step || 1) > 1 ? 0 : 1 });
      }
      ordered.sort((a, b) =>
        (a.loadKey - b.loadKey) ||
        (a.inFlight - b.inFlight) ||
        (new Date(a.r.next_step_due) - new Date(b.r.next_step_due)) ||
        (a.r.id - b.r.id)
      );

      for (const { r: enrollment } of ordered) {
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
          // NOTE (P5a v2): the sending-window check has been MOVED to after the
          // auto-stop blocks below. Stopping an enrollment is not sending — a
          // reply or acceptance must stop the enrollment even when the channel's
          // window never opens (or the channel is wedged). Enrollment 142 sat
          // overdue for a month with a post-enrollment reply because the window
          // `continue` ran before the reply check ever did.

          // ── Auto-stop: inbound reply received since enrollment ────────────
          // Two sources, either stops the enrollment (P5a / design-doc F4 fix):
          //   1. emails       — inbound email replies. NDR-SAFE (v3): rows the
          //      NdrCleanupService has soft-deleted are excluded, and fresh
          //      not-yet-cleaned rows are screened with the same
          //      BounceDetectionService.isLikelyNdr heuristic — a mailer-daemon
          //      bounce must never count as "the prospect replied".
          //   2. linkedin_message_events — inbound LinkedIn messages harvested
          //      by the extension (2026_49 ledger). occurred_at is LinkedIn's
          //      own deliveredAt; no NDR concept exists for LinkedIn messages.
          // Per-campaign opt-out (2026_50): prospecting_campaigns.stop_on_reply
          // DEFAULT true; NULL / no campaign → stop (safe default). Governs
          // both sources uniformly.
          let repliedVia = null;
          if (enrollment.camp_stop_on_reply !== false) {
            const replyCheck = await client.query(
              `SELECT from_address, subject FROM emails
                WHERE prospect_id = $1
                  AND direction IN ('inbound', 'received')
                  AND sent_at > $2
                  AND deleted_at IS NULL
                ORDER BY sent_at ASC
                LIMIT 5`,
              [enrollment.prospect_id, enrollment.enrolled_at]
            );
            const genuineEmail = replyCheck.rows.find(
              r => !BounceDetectionService.isLikelyNdr(r.from_address, r.subject)
            );
            if (genuineEmail) repliedVia = 'email';
            if (!repliedVia) {
              const liReply = await client.query(
                `SELECT 1 FROM linkedin_message_events
                  WHERE org_id = $1
                    AND prospect_id = $2
                    AND direction = 'inbound'
                    AND occurred_at > $3
                  LIMIT 1`,
                [enrollment.org_id, enrollment.prospect_id, enrollment.enrolled_at]
              );
              if (liReply.rows.length > 0) repliedVia = 'linkedin';
            }
          }

          if (repliedVia) {
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

          // ── Auto-stop: LinkedIn connection accepted since enrollment (WS2) ─
          // Opt-in per sequence (sequences.stop_on_connection_accept). Mirrors
          // the reply auto-stop above with a distinct terminal status so the
          // funnel can tell "exited because connected" apart from "stopped".
          //
          // Post-enrollment guard: connected_at must be AFTER enrolled_at, so
          // enrolling an already-connected prospect into a stop-on-accept
          // sequence (re-engagement) does NOT insta-stop. connected_at is set
          // by every acceptance writer (extension sync, manual linkedin-event,
          // auto-send confirm — all via applyConnectionEvent semantics) and is
          // never overwritten, so it's the reliable anchor. Status alone
          // (connection_accepted or later) without a parseable post-enrollment
          // connected_at intentionally does NOT stop — keep-running is the
          // safe default.
          //
          // Detection remains pull-based (extension "Check & update accepted"),
          // so an acceptance synced after a step already fired stops the
          // enrollment at the NEXT tick, not retroactively.
          if (enrollment.seq_stop_on_accept === true) {
            const LI_ORDER = [
              'connection_request_sent', 'connection_accepted',
              'message_sent', 'reply_received', 'meeting_booked',
            ];
            const statusIdx   = LI_ORDER.indexOf(enrollment.li_connection_status || '');
            const acceptedIdx = LI_ORDER.indexOf('connection_accepted');
            const connectedAt = enrollment.li_connected_at
              ? new Date(enrollment.li_connected_at) : null;
            const acceptedAfterEnroll =
              statusIdx >= acceptedIdx &&
              connectedAt instanceof Date && !isNaN(connectedAt.getTime()) &&
              connectedAt.getTime() > new Date(enrollment.enrolled_at).getTime();

            if (acceptedAfterEnroll) {
              await client.query(
                `UPDATE sequence_enrollments
                    SET status='connected', stopped_at=NOW(),
                        stop_reason='connection_accepted'
                  WHERE id=$1`,
                [enrollment.id]
              );
              // Cancel pending rows (scheduled email + leased LinkedIn alike).
              // A leased LinkedIn row flipped to 'skipped' degrades cleanly:
              // confirmSent() requires status='sending' and returns
              // NOT_CLAIMABLE, same race the reply-stop already tolerates.
              await client.query(
                `UPDATE sequence_step_logs SET status='skipped'
                  WHERE enrollment_id=$1 AND status IN ('scheduled','sending')`,
                [enrollment.id]
              );
              // Visible trail on the prospect timeline — this stop is the
              // feature's whole point, unlike the silent reply-stop.
              try {
                await client.query(
                  `INSERT INTO prospecting_activities
                               (org_id, prospect_id, user_id, activity_type, description, metadata)
                        VALUES ($1, $2, $3, 'sequence_stopped', $4, $5)`,
                  [
                    enrollment.org_id, enrollment.prospect_id, enrollment.enrolled_by,
                    `Sequence stopped — LinkedIn connection accepted (${enrollment.seq_name})`,
                    JSON.stringify({
                      enrollmentId: enrollment.id, sequenceId: enrollment.seq_id,
                      stopReason: 'connection_accepted',
                      connectedAt: connectedAt.toISOString(),
                    }),
                  ]
                );
              } catch (actErr) {
                console.warn(`SequenceStepFirer: connection-accepted stop activity log failed for enrollment ${enrollment.id}:`, actErr.message);
              }
              stopped++;
              continue;
            }
          }

          // ── Sending window (moved here — P5a v2) ───────────────────────────
          // Only actual SENDING waits for the window; the stop checks above run
          // every tick regardless, so a replied/accepted prospect can never be
          // held hostage by a closed or misconfigured channel window.
          const settings = await getSettings(enrollment.org_id, enrollment.prospect_campaign_id, enrollment.enrolled_by);
          const channel  = enrollment.current_step_channel || 'email';
          if (!SendingSchedule.isWithinWindow(new Date(), settings, channel)) {
            // Not an error; we'll try again next tick. No counter bump.
            continue;
          }

          // ── Get the current step ──────────────────────────────────────────
          // Resolved by identity (current_step_id), from the enrollment's frozen
          // snapshot if it has one, else live sequence_steps — with re-anchoring
          // if the current step was deleted. Replaces the ordinal
          // step_order = current_step lookup that a reorder would misalign.
          const step = await EnrollmentStepResolver.currentStep(client, enrollment);

          if (!step) {
            await client.query(
              `UPDATE sequence_enrollments
                  SET status='completed', completed_at=NOW()
                WHERE id=$1`,
              [enrollment.id]
            );
            fired++;
            continue;
          }

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
          // Cached by stable step ID (reorder-safe), matching ensureStepPersonalized.
          const personalisedStep =
            enrollment.personalised_steps?.[String(step.id)];

          let subject = personalisedStep?.subject ?? renderTemplate(step.subject_template, prospect || {}, account);
          let body    = personalisedStep?.body    ?? renderTemplate(step.body_template,    prospect || {}, account);

          // Phase 3: provenance — if the AI generated this draft with LinkedIn
          // data, the enrollment.personalised_steps blob carries a
          // personalize_sources object. Copy it onto the log row so the
          // rep-facing footer + immutable audit trail both stay consistent.
          let personalizeSourcesJson = personalisedStep?.personalize_sources
            ? JSON.stringify(personalisedStep.personalize_sources)
            : null;

          // Fold a JIT-personalisation result into subject/body/sources. Used by
          // both branches; in the SEND branch it runs only AFTER a sender slot is
          // secured so the LLM is never spent on a capacity-deferred step.
          const applyPersonalised = (ps) => {
            if (!ps) return;
            if (ps.subject != null) subject = ps.subject;
            if (ps.body    != null) body    = ps.body;
            if (ps.personalize_sources) personalizeSourcesJson = JSON.stringify(ps.personalize_sources);
          };

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

            // Effective intent drives BOTH the auto-send gate and the signature
            // rule below. Explicit step.step_intent wins; a NULL LinkedIn step is
            // inferred (so "Auto" and templated sequences still auto-send their
            // first-touch connection request).
            const effectiveIntent = await resolveEffectiveLinkedinIntent(step, enrollment);

            // ── LinkedIn connection-request DAILY CAP ────────────────────────
            // Fire-time enforcement, symmetric with the email mailbox limit.
            // Applies to BOTH paths below (extension auto-send and human draft)
            // because both RELEASE a connection request into the rep's day.
            // Over cap → defer to the next tick; the enrollment is untouched and
            // next_step_due stays put, so it re-enters the queue tomorrow.
            if (step.channel === 'linkedin' && effectiveIntent === 'connection_request') {
              const liCap = settings.linkedinReleaseCap;
              if (Number.isFinite(liCap) && liCap > 0) {
                const usedToday = await linkedinConnectionRequestsToday(
                  client, enrollment.org_id, enrollment.enrolled_by
                );
                if (usedToday >= liCap) {
                  console.log(
                    `SequenceStepFirer: deferring enrollment ${enrollment.id} — ` +
                    `rep ${enrollment.enrolled_by} at LinkedIn connection cap (${usedToday}/${liCap})`
                  );
                  continue;
                }
              }
            }

            // ── LinkedIn connection-request AUTO-SEND gate (opt-in) ──────────
            // Optional, defensive, off by default. When BOTH the org-admin
            // master toggle is on AND this rep has explicitly opted in, a
            // LinkedIn connection_request step is MATERIALIZED as a 'scheduled'
            // row for the browser extension to actuate in the rep's own
            // authenticated session — instead of the human-actioned draft this
            // branch would otherwise create. The firer never sends it; the
            // extension claims (scheduled→sending), performs the click, then
            // confirms (sending→sent) which advances the enrollment. All the
            // defensive limits (daily cap, jitter, human-hours window, abort on
            // challenge) live at claim time / in the extension — see
            // LinkedInAutoSendService + background.js. This is a knowing,
            // disclosed LinkedIn-ToS tradeoff the org+rep both accept.
            // ── LinkedIn connection-request AUTO-SEND gate (opt-in) ──────────
            // Only auto-send when the step is NOT set to require approval.
            // effectiveRequireApproval = COALESCE(step, sequence).require_approval,
            // so a step-level "Draft" (require_approval=true) forces the human-
            // actioned draft path even when the org auto-send toggle is ON. A
            // step-level "Send" / "Inherit" that resolves to false auto-sends when
            // the gate is enabled; if the gate is off it falls through to a draft.
            if (step.channel === 'linkedin' && effectiveIntent === 'connection_request' && !effectiveRequireApproval) {
              let gate = { enabled: false };
              try {
                gate = await LinkedInAutomationConfig.resolveForUser(client, {
                  orgId: enrollment.org_id, userId: enrollment.enrolled_by,
                });
              } catch (gErr) {
                // Never let a config lookup failure block the normal draft path.
                console.warn(`SequenceStepFirer: auto-connect gate lookup failed for enrollment ${enrollment.id}: ${gErr.message}`);
              }

              if (gate.enabled) {
                // Idempotency: at most one live row per step. uq_seq_step_logs_pending
                // already blocks a duplicate scheduled/sending row, but checking
                // 'sent' too means a confirmed send is never re-queued either.
                const existingLive = await client.query(
                  `SELECT 1 FROM sequence_step_logs
                    WHERE enrollment_id=$1 AND sequence_step_id=$2
                      AND status IN ('scheduled','sending','sent')
                    LIMIT 1`,
                  [enrollment.id, step.id]
                );
                if (existingLive.rows.length === 0) {
                  // Personalise the note now (freshest history), then hard-cap to
                  // 280 chars — LinkedIn's connection-note ceiling, same limit
                  // OutreachValidator enforces. No signature on a connection note.
                  applyPersonalised(await ensureStepPersonalized(client, enrollment, step.channel));
                  const note = (body || '').slice(0, 280);
                  try {
                    await client.query(
                      `INSERT INTO sequence_step_logs
                                   (org_id, enrollment_id, sequence_step_id, prospect_id,
                                    channel, status, subject, body, scheduled_send_at, fired_at,
                                    personalize_sources, step_intent)
                            VALUES ($1, $2, $3, $4, 'linkedin', 'scheduled', NULL, $5, NOW(), NULL, $6::jsonb, $7)`,
                      [
                        enrollment.org_id, enrollment.id, step.id, enrollment.prospect_id,
                        note, personalizeSourcesJson, effectiveIntent,
                      ]
                    );
                    try {
                      await client.query(
                        `INSERT INTO prospecting_activities
                                     (org_id, prospect_id, user_id, activity_type, description, metadata)
                              VALUES ($1, $2, $3, 'sequence_autosend_queued', $4, $5)`,
                        [
                          enrollment.org_id, enrollment.prospect_id, enrollment.enrolled_by,
                          `LinkedIn connection request queued for auto-send — ${enrollment.seq_name} step ${enrollment.current_step}`,
                          JSON.stringify({
                            enrollmentId: enrollment.id, sequenceId: enrollment.seq_id,
                            stepOrder: enrollment.current_step, stepId: step.id,
                            channel: 'linkedin', step_intent: 'connection_request',
                            gate_source: gate.source,
                          }),
                        ]
                      );
                    } catch (actErr) {
                      console.warn(`SequenceStepFirer: autosend-queued activity log failed for enrollment ${enrollment.id}:`, actErr.message);
                    }
                    drafted++; // counts as "queued" rather than "sent"
                  } catch (insErr) {
                    // 23505 = a pending row already exists (raced another tick) — fine.
                    if (insErr.code !== '23505') throw insErr;
                  }
                }
                // Do NOT advance — the extension's confirm advances the enrollment.
                continue;
              }
              // gate disabled → fall through to the normal draft behaviour below.
            }

            // Idempotency: keep exactly one live row for this (enrollment, step)
            // — never two (double-send), never zero (missed contact).
            //
            // The old guard only looked for status='draft', so when the cursor
            // got re-pointed at an already-fired step (step delete + re-anchor in
            // pickCurrent, a reorder, or a re-enroll) it inserted ANOTHER 'draft'.
            // 'draft' is outside uq_seq_step_logs_fired, so the INSERT succeeded
            // silently — but the rep's later "Mark as Done" (UPDATE draft ->
            // 'completed') then collided with the pre-existing fired row and
            // raised 23505 ("duplicate key ... uq_seq_step_logs_fired").
            //
            // For a MANUAL connection request a 'draft' or 'scheduled' row is a
            // TO-DO, not proof the request went out. Only 'completed'/'sent'/
            // 'replied' proves the contact was actually reached. So we branch on
            // that, and NEVER skip an un-contacted enrollment:
            //   • a 'draft' already exists            -> rep will action it; skip.
            //   • proof-of-contact sibling exists      -> already reached; advance
            //                                             PAST the step.
            //   • only 'scheduled'/'sending' exists    -> queued elsewhere (auto-
            //                                             connect gate) and NOT yet
            //                                             confirmed -> do not add a
            //                                             second row and do NOT
            //                                             advance; leave that one
            //                                             live row to resolve.
            //
            // Kept in lockstep with the top-up guard (~line 623) and migration
            // 2026_48's index. Change one, change all three.
            const priorLog = await client.query(
              `SELECT
                 BOOL_OR(status='draft')                              AS has_draft,
                 BOOL_OR(status IN ('completed','sent','replied'))    AS contact_reached,
                 BOOL_OR(status IN ('scheduled','sending'))           AS has_queued
                 FROM sequence_step_logs
                WHERE enrollment_id=$1 AND sequence_step_id=$2
                  AND status NOT IN ('failed','skipped','superseded_duplicate')`,
              [enrollment.id, step.id]
            );
            const pl = priorLog.rows[0] || {};

            if (pl.has_draft) {
              // Draft already exists and is awaiting rep action — skip.
              continue;
            }
            if (pl.contact_reached) {
              // Step already went out for this enrollment. Do NOT re-draft;
              // advance past it so the enrollment stops re-evaluating an
              // already-completed step on every tick.
              console.warn(
                `SequenceStepFirer: step ${step.id} already contacted for enrollment ` +
                `${enrollment.id}; advancing instead of creating a duplicate draft.`
              );
              await EnrollmentStepResolver.applyAdvance(client, enrollment, {
                computeDue: (s) => SendingSchedule.nextStepDue(s, settings),
              });
              continue;
            }
            if (pl.has_queued) {
              // A queued (auto-connect gate) row already owns this step and has
              // NOT confirmed a send. Adding a draft would create a second live
              // row (double-send risk); advancing would drop the contact. Do
              // neither — leave the queued row to resolve on its own path.
              continue;
            }

            // JIT personalisation: this draft is being created right now, so
            // personalise it now (with the freshest engagement history) unless
            // it was already personalised eagerly at activation.
            applyPersonalised(await ensureStepPersonalized(client, enrollment, step.channel));

            // ── Fetch sender for signature + display_name ─────────────────
            // Client sender if the prospect belongs to a client, else rep's sender.
            // Non-fatal: draft is still created without a signature if nothing connected.
            // NOTE: body stored in DB stays as plain text so the editor renders it
            // correctly. plainTextToHtml() is applied at send time only.
            const sender = await resolveSender(client, enrollment.org_id, enrollment.enrolled_by, clientId);

            // Channel-aware signature:
            //   email    → sender.signature
            //   linkedin → sender.linkedin_signature if set, else sender.signature,
            //              EXCEPT connection requests (short notes, 280-char cap)
            //              which never carry a signature
            //   call/task → no signature
            if (sender) {
              // 2026_74: per-step opt-out. Read as !== false so jsonb step
              // snapshots taken before the column existed keep their signature.
              const wantsSignature = step.include_signature !== false;
              if (step.channel === 'email' && sender.signature && wantsSignature) {
                body = appendSignature(body, sender.signature);
              } else if (step.channel === 'linkedin' && effectiveIntent !== 'connection_request') {
                const liSig = sender.linkedin_signature || sender.signature;
                if (liSig) body = appendSignature(body, liSig);
              }
            }

            // Write draft — fired_at=NULL until rep sends
            await client.query(
              `INSERT INTO sequence_step_logs
                           (org_id, enrollment_id, sequence_step_id, prospect_id,
                            channel, status, subject, body, scheduled_send_at, fired_at,
                            personalize_sources, step_intent)
                    VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, NOW(), NULL, $8::jsonb, $9)`,
              [
                enrollment.org_id,
                enrollment.id,
                step.id,
                enrollment.prospect_id,
                step.channel,
                subject,
                body,
                personalizeSourcesJson,
                step.channel === 'linkedin' ? effectiveIntent : (step.step_intent || null),
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
          const allowedSenderIds = await getCampaignSenderIds(
            enrollment.org_id, enrollment.prospect_campaign_id
          );

          // ── Threaded-reply / sender-pin resolution (2026_71) ──────────────
          // A threaded enrollment (or one on a pin_sender sequence) is locked to
          // ONE mailbox for its whole life so replies come from the same address
          // that opened the thread. Once the first email stamps
          // pinned_sender_account_id, restrict the pool to it — the picker's
          // capacity/cooldown logic then yields the normal DEFER when that one
          // mailbox is at cap (it simply waits, exactly like today). A revoked /
          // inactive pinned sender is handled explicitly below per failover mode.
          const threadingOn   = enrollment.seq_thread_replies === true;
          const pinOn         = threadingOn || enrollment.seq_pin_sender === true;
          const failoverBreak = pinOn && enrollment.seq_thread_failover_mode === 'break';
          const pinnedSenderId = pinOn ? (enrollment.pinned_sender_account_id || null) : null;

          // Pass the campaign restriction (rep-only) and the pin (rep + client)
          // as SEPARATE args — the pin must narrow client mailboxes too, which
          // the campaign restriction deliberately never does.
          const pick = await pickEmailSenderWithCapacity(
            client, enrollment.org_id, enrollment.enrolled_by, clientId, settings, new Date(), allowedSenderIds, pinnedSenderId
          );
          if (pick.status === 'all_maxed' || pick.status === 'cooling_down') {
            console.log(
              `SequenceStepFirer: deferring enrollment ${enrollment.id} — ` +
              `senders ${pick.status === 'cooling_down' ? 'within min-delay cooldown' : 'at daily limit'}`
            );
            continue;
          }
          if (pick.status === 'no_accounts' || pick.status === 'client_sender_required' || !pick.sender) {
            // Pinned enrollment whose one mailbox is now gone/inactive (2026_71).
            if (pinOn && pinnedSenderId && pick.status === 'no_accounts') {
              if (failoverBreak) {
                // break mode: drop the pin + thread anchor; next tick re-picks
                // from the full pool and starts a fresh thread root.
                await client.query(
                  `UPDATE sequence_enrollments
                      SET pinned_sender_account_id = NULL,
                          thread_conversation_id   = NULL,
                          thread_last_message_id   = NULL,
                          thread_references        = NULL
                    WHERE id = $1`,
                  [enrollment.id]
                );
                errors++;
                continue;
              }
              // defer mode: pause + notify immediately (daily digest follows).
              await pauseThreadBlocked(client, {
                orgId: enrollment.org_id, enrollmentId: enrollment.id, stepId: step.id,
                prospectId: enrollment.prospect_id, enrolledBy: enrollment.enrolled_by,
                seqName: enrollment.seq_name, seqId: enrollment.seq_id,
                stepOrder: enrollment.current_step, senderId: pinnedSenderId,
                reason: 'The pinned sending mailbox is disconnected or inactive.',
              });
              errors++;
              continue;
            }
            await failAndPause(client, {
              orgId: enrollment.org_id, enrollmentId: enrollment.id, stepId: step.id,
              prospectId: enrollment.prospect_id, enrolledBy: enrollment.enrolled_by,
              seqName: enrollment.seq_name, stepOrder: enrollment.current_step,
              channel: 'email',
              message: pick.status === 'client_sender_required'
                ? 'This client requires its own sender mailbox and none is connected — connect Gmail or Outlook for the client in Agency → client → Senders (or disable "Require client mailbox").'
                : 'No active email sender connected — connect Gmail or Outlook in Settings → Outreach.',
            });
            errors++;
            continue;
          }
          const sender = pick.sender;

          // Capacity is now confirmed (a sender slot is secured), so personalise
          // JIT — this is the point where "the step has capacity to send." For an
          // AI sequence the scheduled row was intentionally NOT pre-materialised
          // by the top-up, so the INSERT below is the real creation and carries
          // the freshly personalised content.
          applyPersonalised(await ensureStepPersonalized(client, enrollment, step.channel));

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
            // sender_account_id is stamped HERE, at claim time — not after the
            // provider call succeeds. The fair-share counter must see in-flight
            // claims, otherwise a sender that is mid-send looks idle and the
            // next tick over-allocates to the same (campaign, sender) pair.
            `UPDATE sequence_step_logs
                SET status='sending', fired_at=NOW(), sender_account_id=$3
              WHERE enrollment_id=$1 AND sequence_step_id=$2 AND status='scheduled'
                AND scheduled_send_at <= NOW()
              RETURNING id, subject, body`,
            [enrollment.id, step.id, sender.id]
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
          //
          // 2026_74: per-step opt-out, read as !== false so pre-column jsonb step
          // snapshots continue to include the signature.
          //
          // ORDER MATTERS, and it matters more once quoted history exists
          // (2026_75). appendSignature() bails out when the signature text — or
          // even just its first line — already appears anywhere in the body. A
          // quote block carries the PREVIOUS email's signature, so if the quote
          // were attached before this call, that guard would match and silently
          // suppress the new signature on every reply. Signature first, quote
          // afterwards. Do not reorder these.
          const sendBodyPlain = (step.include_signature !== false)
            ? appendSignature(sendBodyRaw, sender.signature)
            : sendBodyRaw;
          // 2026_76: plain sequences go out as text/plain. sendBody is then the
          // raw text, not HTML — plainTextToHtml would escape it and wrap it in
          // markup the recipient would see literally.
          const bodyFormat = enrollment.seq_body_format === 'plain' ? 'plain' : 'html';
          let sendBodyHtml = bodyFormat === 'plain'
            ? sendBodyPlain
            : plainTextToHtml(sendBodyPlain);

          // Insights/WBR Phase 7 — open/click tracking decoration.
          // Triple-gated inside the service: org has an ACTIVE tracking
          // domain (no shared fallback, D40) AND campaign toggles on
          // (default OFF, D39). Never throws; on any failure the email goes
          // out untracked with the original HTML.
          //
          // 2026_76: skipped entirely for plain sequences. The pixel is a 1x1 <img>
          // and HREF_RE only matches <a href> — in text/plain the pixel would be
          // visible markup and no link would be rewritten. Opens and clicks are
          // therefore structurally unavailable on plain sequences, which the UI
          // states next to the format control.
          if (bodyFormat !== 'plain') {
            sendBodyHtml = await EmailTrackingService.decorateHtml(client, {
              orgId: enrollment.org_id,
              prospectId: enrollment.prospect_id,
              stepLogId: logId,
              html: sendBodyHtml,
            });
          }

          // 2026_75: quote material for future replies.
          //
          // Derived from sendBodyPlain, NOT from sendBodyHtml — sendBodyHtml has
          // just been reassigned by decorateHtml and now carries this step's
          // open-tracking pixel and rewritten click links. Quoting that into later
          // replies would re-embed both, so every open of a later email would fire
          // a false OPEN against this step and any click on a quoted link a false
          // CLICK. plainTextToHtml(sendBodyPlain) is the same body with the
          // signature and without any tracking.
          //
          // Grown below if a quote block is attached, so the chain accumulates.
          // Matches the wire format, so a later reply quoting this row embeds
          // like-for-like (see attachQuotedHistory's mismatch guard).
          let bodyQuotable = bodyFormat === 'plain'
            ? sendBodyPlain
            : plainTextToHtml(sendBodyPlain);

          // ── Threaded-reply assembly (2026_71) ─────────────────────────────
          // REPLY          = server-thread anchor present → nest into it.
          // CARRY-OVER ROOT = the pinned mailbox was SWITCHED (switch-sender):
          //   no server thread on the new mailbox yet, but the prior thread's
          //   subject + message-ids survive on the enrollment. Send as a root
          //   that REUSES the subject and (Gmail) carries In-Reply-To/References
          //   so the recipient still sees one continuous thread; the new mailbox
          //   then owns the server thread going forward.
          // FRESH ROOT     = no thread history at all → brand-new email.
          const isThreadReply   = threadingOn && !!enrollment.thread_conversation_id;
          const isCarryOverRoot = threadingOn && !enrollment.thread_conversation_id
                                    && !!enrollment.thread_last_message_id;
          const reuseSubject = isThreadReply || isCarryOverRoot;
          const outSubject = reuseSubject
            ? applyThreadSubject(enrollment.thread_root_subject || sendSubject, enrollment.seq_thread_subject_mode)
            : sendSubject;

          // 2026_75 — quoted history, identical on both providers.
          // Only for genuine replies and carry-over roots: a fresh root has no
          // parent to quote. A null parent (pre-2026_75 thread, or nothing stored)
          // degrades silently to no quote block; the RFC headers still thread it.
          if (threadingOn && (isThreadReply || isCarryOverRoot)) {
            try {
              const parent = await _loadQuotableParent(client, {
                conversationId: enrollment.thread_conversation_id || null,
                prospectId:     enrollment.prospect_id,
                orgId:          enrollment.org_id,
              });
              if (parent) {
                const who = sender.display_name || null;
                sendBodyHtml = attachQuotedHistory(sendBodyHtml, parent, who, bodyFormat);
                // Grow the stored copy too, so the NEXT reply quoting this message
                // inherits the whole chain rather than restarting it.
                bodyQuotable = attachQuotedHistory(bodyQuotable, parent, who, bodyFormat);
              }
            } catch (err) {
              // Quoting is cosmetic; never fail a send over it.
              console.error('[SequenceStepFirer] quoted-history assembly failed:', err.message);
            }
          }

          let gmailThread = null, outlookThread = null;
          if (threadingOn) {
            if (sender.provider === 'gmail') {
              if (isThreadReply) {
                gmailThread = { threadId:  enrollment.thread_conversation_id,
                                inReplyTo:  enrollment.thread_last_message_id || null,
                                references: enrollment.thread_references || enrollment.thread_last_message_id || null };
              } else if (isCarryOverRoot) {
                // New mailbox → no threadId, but carry headers for recipient-side threading.
                gmailThread = { inReplyTo:  enrollment.thread_last_message_id || null,
                                references: enrollment.thread_references || enrollment.thread_last_message_id || null };
              } else {
                gmailThread = {}; // fresh root: mint a Message-ID, no nesting
              }
            } else if (sender.provider === 'outlook') {
              // Outlook can only createReply within the same mailbox, so a
              // carry-over root falls back to a fresh draft-send (subject
              // continuity only — Graph owns the reply headers).
              outlookThread = isThreadReply
                ? { replyToMessageId: enrollment.thread_last_message_id }
                : {};
            }
          }
          let sendResult = null;

          // Dispatch. On throw → fail + pause (no retry), then defer to owner.
          try {
            if (sender.provider === 'gmail') {
              sendResult = await sendGmailEmail(enrollment.enrolled_by, {
                to: prospect.email, subject: outSubject, body: sendBodyHtml,
                isHtml: bodyFormat !== 'plain',
                senderEmail: sender.email, accessToken: sender.access_token, refreshToken: sender.refresh_token,
                thread: gmailThread,
              });
            } else if (sender.provider === 'outlook') {
              sendResult = await sendOutlookEmail(enrollment.enrolled_by, {
                to: prospect.email, subject: outSubject, body: sendBodyHtml,
                isHtml: bodyFormat !== 'plain',
                senderEmail: sender.email, accessToken: sender.access_token, refreshToken: sender.refresh_token,
                thread: outlookThread,
              });
            } else {
              throw new Error(`Unsupported sender provider: ${sender.provider}`);
            }
          } catch (sendErr) {
            // A dead sender credential (invalid_grant) is a SENDER problem, not a
            // per-enrollment one — pausing every enrollment that happens to land
            // on it (and re-hitting the provider for each) is wrong. Instead:
            // deactivate the sender + notify the rep ONCE, then decide based on
            // whether a healthy sender remains:
            //   • another sender available → release this claim back to
            //     'scheduled' so the next tick fails over to it automatically.
            //   • none left → fall through to the original fail+pause so the
            //     enrollment still parks with an owner action (no infinite retry).
            // All NON-revocation errors keep the original fail+pause behaviour.
            if (SenderTokenHealth.isRevokedError(sendErr)) {
              await SenderTokenHealth.handleRevokedAtSend(client, {
                sender,
                orgId:  enrollment.org_id,
                userId: enrollment.enrolled_by,
                reason: sendErr.message,
              });
              // Pinned/threaded enrollment (2026_71): do NOT fail over to a
              // different mailbox — that changes the From address and breaks the
              // thread. In DEFER mode, pause + notify immediately (daily digest
              // nags until the owner resolves). In BREAK mode, drop the anchor so
              // the next sender starts a fresh root, then fall through to failover.
              if (pinOn && pinnedSenderId && !failoverBreak) {
                await pauseThreadBlocked(client, {
                  orgId: enrollment.org_id, enrollmentId: enrollment.id, stepId: step.id,
                  prospectId: enrollment.prospect_id, enrolledBy: enrollment.enrolled_by,
                  seqName: enrollment.seq_name, seqId: enrollment.seq_id,
                  stepOrder: enrollment.current_step, senderId: pinnedSenderId,
                  reason: 'The pinned sending mailbox needs to be reconnected.',
                });
                errors++;
                continue;
              }
              if (pinOn && pinnedSenderId && failoverBreak) {
                await client.query(
                  `UPDATE sequence_enrollments
                      SET pinned_sender_account_id = NULL,
                          thread_conversation_id   = NULL,
                          thread_last_message_id   = NULL,
                          thread_references        = NULL
                    WHERE id = $1`,
                  [enrollment.id]
                );
              }
              // Is there still a sender that can carry this (now or after its
              // cooldown/daily window)? The picker already excludes the
              // just-deactivated one (is_active=false on the same connection).
              const failover = await pickEmailSenderWithCapacity(
                client, enrollment.org_id, enrollment.enrolled_by, clientId, settings, new Date(), allowedSenderIds
              );
              const hasOtherSender =
                !!failover.sender || failover.status === 'cooling_down' || failover.status === 'all_maxed';
              if (hasOtherSender) {
                // Release the claim → retried next tick by a healthy sender.
                await client.query(
                  `UPDATE sequence_step_logs
                      SET status='scheduled', fired_at=NULL
                    WHERE id=$1 AND status='sending'`,
                  [logId]
                );
                errors++;
                continue;
              }
              // No healthy sender left → park with a clear, actionable message.
              await failAndPause(client, {
                orgId: enrollment.org_id, enrollmentId: enrollment.id, stepId: step.id,
                prospectId: enrollment.prospect_id, enrolledBy: enrollment.enrolled_by,
                seqName: enrollment.seq_name, stepOrder: enrollment.current_step,
                channel: 'email',
                message: failover.status === 'client_sender_required'
                  ? 'This client requires its own sender mailbox and none is connected — connect Gmail or Outlook for the client in Agency → client → Senders, then resume.'
                  : 'Email sender disconnected — reconnect in Settings → Outreach, then resume.',
              });
              errors++;
              continue;
            }

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
          // Provider threading ids (2026_71): reuse conversation_id + external_id
          // + external_data (the "separate change, flagged not smuggled" noted in
          // routes/sequences.routes.js). Gmail: external_id = the RFC822 Message-ID
          // we minted (chained as In-Reply-To next step); Outlook: external_id = the
          // immutable Graph id (the createReply target). Outlook internetMessageId
          // is stashed in external_data. All null when threading is off.
          const provThreadId = sender.provider === 'gmail'
            ? (sendResult?.threadId || null)
            : (sendResult?.conversationId || null);
          const provMsgId = sender.provider === 'gmail'
            ? (sendResult?.rfcMessageId || null)
            : (sendResult?.messageId || null);
          const provExtData = sender.provider === 'outlook'
            ? { internetMessageId: sendResult?.internetMessageId || null }
            : {};

          const emailRes = await client.query(
            `INSERT INTO emails
                         (org_id, user_id, direction, subject, body,
                          to_address, from_address, sent_at,
                          prospect_id, sender_account_id, provider,
                          conversation_id, external_id, external_data,
                          body_quotable, body_format)
                  VALUES ($1, $2, 'sent', $3, $4, $5, $6, NOW(), $7, $8, $9, $10, $11, $12::jsonb,
                          $13, $14)
               RETURNING id`,
            [enrollment.org_id, enrollment.enrolled_by, outSubject, sendBodyHtml,
             prospect.email, sender.email, enrollment.prospect_id, sender.id, sender.provider,
             provThreadId, provMsgId, JSON.stringify(provExtData),
             bodyQuotable, bodyFormat]
          );
          const emailId = emailRes.rows[0].id;

          // Stamp / advance the cached thread anchor on the enrollment (2026_71).
          // Read came free with se.*, so this single UPDATE is the whole per-send
          // cost — no fan-out reads regardless of firer volume. thread_references
          // is consumed only on the Gmail path; harmless for Outlook.
          if (threadingOn && provMsgId) {
            if (isThreadReply) {
              await client.query(
                `UPDATE sequence_enrollments
                    SET thread_last_message_id = $2,
                        thread_references = COALESCE(thread_references || ' ' || $2, $2)
                  WHERE id = $1`,
                [enrollment.id, provMsgId]
              );
            } else if (isCarryOverRoot) {
              // Switched mailbox just opened its own server thread — adopt it,
              // keep the original subject, and extend the References chain. The
              // pin was already reassigned by the switch-sender endpoint.
              await client.query(
                `UPDATE sequence_enrollments
                    SET thread_conversation_id = $2,
                        thread_last_message_id = $3,
                        thread_references = COALESCE(thread_references || ' ' || $3, $3)
                  WHERE id = $1`,
                [enrollment.id, provThreadId, provMsgId]
              );
            } else {
              // Fresh root — lock the anchor and pin the sender for the rest of life.
              await client.query(
                `UPDATE sequence_enrollments
                    SET thread_conversation_id   = $2,
                        thread_root_subject      = $3,
                        thread_last_message_id   = $4,
                        thread_references        = $4,
                        pinned_sender_account_id = COALESCE(pinned_sender_account_id, $5)
                  WHERE id = $1`,
                [enrollment.id, provThreadId, outSubject, provMsgId, sender.id]
              );
            }
          } else if (pinOn && !enrollment.pinned_sender_account_id) {
            // pin_sender ON without threading: still lock the sender post-first-send.
            await client.query(
              `UPDATE sequence_enrollments
                  SET pinned_sender_account_id = COALESCE(pinned_sender_account_id, $2)
                WHERE id = $1`,
              [enrollment.id, sender.id]
            );
          }

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
          // Next step is resolved by ordering within the enrollment's plan
          // (snapshot or live) and the cursor is moved by identity — so a reorder
          // reshapes only the *forward* path, never re-points the current step.
          // Also keeps current_step_id / current_step_channel in sync.
          await EnrollmentStepResolver.applyAdvance(client, enrollment, {
            computeDue: (s) => SendingSchedule.nextStepDue(s, settings),
          });

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
            const failStepResolved = await EnrollmentStepResolver.currentStep(client, enrollment);
            const failStepId  = failStepResolved?.id || null;
            const failChannel = enrollment.current_step_channel || failStepResolved?.channel || 'email';
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
