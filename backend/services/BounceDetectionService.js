/**
 * BounceDetectionService.js
 *
 * Phase 2 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
 *
 * Detects and parses NDR ("bounce") messages during inbox sync, turning them
 * into `email_delivery_events` rows + `bounce_received` prospect-timeline
 * activities, and (config-gated) auto-stopping active enrollments on hard
 * bounces.
 *
 * WHY HERE: sequence sends go out via real Gmail/Outlook mailboxes, so there
 * are no ESP webhooks. Bounces come back as mailer-daemon/postmaster messages
 * to the sender's own inbox — which the sync already reads. Gate 1 of
 * storeEmailToDatabase (jobs/syncScheduler.js) currently DROPS those senders
 * as "automated". The hook added in Phase 2 calls processPotentialNdr()
 * inside that branch — parse the signal, then still drop the NDR from the
 * CRM inbox (reason 'ndr_processed' in email_filter_log for audit).
 *
 * Contract with the caller (Gate 1 in syncScheduler.js):
 *   - Caller passes its pg `client` — all writes join the sync's connection.
 *   - This service must NEVER throw out of processPotentialNdr in a way that
 *     crashes the sync; all failures are caught and logged, returning
 *     { processed: false }.
 *   - Idempotent across re-syncs: unique (org, ndr_external_id,
 *     failed_recipient) index, ON CONFLICT DO NOTHING.
 *
 * Classification (decision in 2026_23 header comments):
 *   hard_bounce — permanent: enhanced codes 5.1.x / 5.2.1 "user unknown" /
 *                 "address not found" / "does not exist" → list-quality cause
 *   block       — policy/reputation: 5.7.x / "blocked" / "spam" /
 *                 "blacklist" / "poor reputation" → sender-health cause
 *   soft_bounce — transient: 4.x.x / "mailbox full" / "quota" / "try again
 *                 later" / anything unclassifiable (conservative default —
 *                 never auto-stop on an unknown)
 *
 * Auto-stop (decision D26): hard bounce → stop the prospect's ACTIVE
 * enrollments (status='stopped', stop_reason='hard_bounce') unless the org
 * sets organizations.settings.bounce_handling.auto_stop_on_hard_bounce=false.
 * Rationale: continuing to email a dead address only damages sender
 * reputation. Soft bounces and blocks never auto-stop.
 *
 * Every INSERT carries org_id. Keep it that way.
 */

// ── NDR detection patterns ───────────────────────────────────────────────────

// Sender local-parts that indicate an NDR (subset of the Gate 1 blocklist —
// 'notifications'/'unsubscribe'/'noreply' are automated but NOT bounces).
const NDR_LOCAL_PATTERNS = ['mailer-daemon', 'postmaster'];

// Subject lines used by Gmail / Exchange / common MTAs.
const NDR_SUBJECT_REGEX = new RegExp(
  [
    'undeliverable',
    'delivery (status notification|has failed|incomplete)',
    "(message|mail).{0,30}(wasn'?t|was not|could ?n[o']?t be) delivered",
    'failure notice',
    'returned mail',
    'delivery failure',
    'undelivered mail returned to sender',
  ].join('|'),
  'i'
);

// Failed-recipient extraction, tried in order. Group 1 = address.
const EMAIL_RE_SRC = '([A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,})';
const RECIPIENT_PATTERNS = [
  // RFC 3464 machine-readable part
  new RegExp(`Final-Recipient:\\s*rfc822;\\s*${EMAIL_RE_SRC}`, 'i'),
  new RegExp(`Original-Recipient:\\s*rfc822;\\s*${EMAIL_RE_SRC}`, 'i'),
  // Gmail human-readable: "Your message wasn't delivered to xyz@acme.com"
  new RegExp(`delivered to\\s+<?${EMAIL_RE_SRC}>?`, 'i'),
  // Exchange: "Delivery has failed to these recipients or groups: xyz@acme.com"
  new RegExp(`recipients or groups:[\\s\\S]{0,200}?${EMAIL_RE_SRC}`, 'i'),
  new RegExp(`following recipient[s]?[\\s\\S]{0,120}?${EMAIL_RE_SRC}`, 'i'),
  // qmail and friends: "unable to deliver your message to the following address. <xyz@acme.com>:"
  new RegExp(`following address(?:es)?[\\s\\S]{0,120}?${EMAIL_RE_SRC}`, 'i'),
  new RegExp(`(?:unable to deliver|delivery to)[\\s\\S]{0,160}?<${EMAIL_RE_SRC}>`, 'i'),
  // Generic: first <addr> after a failure keyword
  new RegExp(`(?:failed|rejected|unknown|not found)[\\s\\S]{0,160}?<${EMAIL_RE_SRC}>`, 'i'),
  // Last resort for messages that already passed isLikelyNdr: first
  // angle-bracketed address anywhere (typically the failed recipient — NDRs
  // quote the original's To: line if nothing else).
  new RegExp(`<${EMAIL_RE_SRC}>`),
];

// SMTP / enhanced status code extraction.
const ENHANCED_CODE_RE = /\b([45])\.(\d{1,3})\.(\d{1,3})\b/;
const BASIC_CODE_RE = /\b(4\d{2}|5\d{2})[\s\-]/;

// Text-level classification hints (checked when codes are absent/ambiguous).
const HARD_TEXT_RE = /address not found|does(?:n'?t| not) exist|user unknown|no such (?:user|recipient|mailbox)|recipient.{0,30}rejected|invalid recipient|unknown recipient|account.{0,20}(disabled|deactivated)/i;
const BLOCK_TEXT_RE = /\bspam\b|blocked|black.?list|denylist|poor (?:domain |ip )?reputation|policy (?:violation|reasons)|banned sending|unsolicited/i;
const SOFT_TEXT_RE = /mailbox (?:is )?full|over quota|quota exceeded|try again later|temporarily|greylist|service (?:currently )?unavailable/i;

// ── module ───────────────────────────────────────────────────────────────────

const MATCH_WINDOW_DAYS = 14; // how far back to look for the originating send

/**
 * Cheap pre-check used by Gate 1: does this inbound message look like an NDR?
 * (Sender local-part OR subject pattern — body parsing happens later.)
 */
function isLikelyNdr(fromAddress, subject) {
  const local = String(fromAddress || '').toLowerCase().split('@')[0];
  if (NDR_LOCAL_PATTERNS.some((p) => local.includes(p))) return true;
  return NDR_SUBJECT_REGEX.test(String(subject || ''));
}

// Local-parts that are never a human prospect. Used to stop the prospecting
// inbox's domain-match strategy from attaching machine mail (bounces, auto
// -responders, calendar bots) to an arbitrary prospect who merely shares the
// sending domain. Superset of NDR_LOCAL_PATTERNS.
const ROLE_LOCAL_PATTERNS = [
  'mailer-daemon', 'postmaster', 'noreply', 'no-reply', 'donotreply',
  'do-not-reply', 'bounce', 'bounces', 'autoreply', 'auto-reply',
  'notification', 'notifications', 'mailer', 'daemon',
];

/**
 * True when the local-part marks this as an automated/role mailbox rather
 * than a person. Deliberately conservative — matches on substring so
 * 'bounces-1234@' and 'no-reply+tag@' are caught.
 */
function isRoleSender(fromAddress) {
  const local = String(fromAddress || '').toLowerCase().split('@')[0];
  if (!local) return false;
  return ROLE_LOCAL_PATTERNS.some((p) => local.includes(p));
}

/** Extract the failed recipient address from the NDR body/subject.
 *  Patterns run over BOTH the raw text and a tag-stripped copy: HTML NDRs
 *  (Gmail wraps the address in tags) need stripping, while plaintext NDRs
 *  use literal <addr@x.com> angle brackets that stripping would destroy. */
function extractFailedRecipient(body, subject, senderMailbox) {
  const raw = String(body || '');
  const stripped = raw.replace(/<[^>]+>/g, ' ');
  const haystacks = [raw, stripped, String(subject || '')];
  const self = String(senderMailbox || '').toLowerCase();
  for (const text of haystacks) {
    for (const re of RECIPIENT_PATTERNS) {
      const m = re.exec(text);
      if (m && m[1] && m[1].toLowerCase() !== self) return m[1].toLowerCase();
    }
  }
  return null;
}

/** Extract the most specific status code available. */
function extractSmtpCode(text) {
  const t = text || '';
  const basic = BASIC_CODE_RE.exec(t);
  const enhanced = ENHANCED_CODE_RE.exec(t);
  if (basic && enhanced) return `${basic[1]} ${enhanced[0]}`;
  if (enhanced) return enhanced[0];
  if (basic) return basic[1];
  return null;
}

/** Classify into hard_bounce | soft_bounce | block. */
function classify(smtpCode, text) {
  const t = text || '';
  const enhanced = ENHANCED_CODE_RE.exec(smtpCode || '') || ENHANCED_CODE_RE.exec(t);

  if (enhanced) {
    const [, cls, sub, detail] = enhanced;
    if (cls === '4') return 'soft_bounce';
    if (sub === '7') return 'block';            // 5.7.x — policy/reputation
    if (sub === '1') return 'hard_bounce';      // 5.1.x — addressing (no such user)
    if (sub === '2') {
      // 5.2.2 = mailbox full (transient despite the 5xx class) → soft.
      // 5.2.1 = mailbox disabled/deactivated → hard.
      return detail === '2' ? 'soft_bounce' : 'hard_bounce';
    }
    if (sub === '4') return 'soft_bounce';      // 5.4.x — network/routing (often the sender side; never auto-stop)
    // Other 5.x.x (routing, protocol, content) — fall through to text hints.
  }

  if (BLOCK_TEXT_RE.test(t)) return 'block';
  if (HARD_TEXT_RE.test(t)) return 'hard_bounce';
  if (SOFT_TEXT_RE.test(t)) return 'soft_bounce';

  const basic = BASIC_CODE_RE.exec(smtpCode || '') || BASIC_CODE_RE.exec(t);
  if (basic) return basic[1].startsWith('4') ? 'soft_bounce' : 'hard_bounce';

  return 'soft_bounce'; // conservative default — never auto-stop on unknown
}

/** Short diagnostic snippet around the failure for forensics. */
function diagnosticExcerpt(body) {
  const t = String(body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const m = ENHANCED_CODE_RE.exec(t) || BASIC_CODE_RE.exec(t);
  if (m) {
    const i = Math.max(0, t.indexOf(m[0]) - 60);
    return t.slice(i, i + 300);
  }
  return t.slice(0, 300);
}

/** Org bounce config with defaults (organizations.settings.bounce_handling). */
async function getBounceConfig(client, orgId) {
  const r = await client.query(
    `SELECT settings -> 'bounce_handling' AS bh FROM organizations WHERE id = $1`,
    [orgId]
  );
  const bh = r.rows[0]?.bh || {};
  return {
    autoStopOnHardBounce: bh.auto_stop_on_hard_bounce !== false, // default true (D26)
  };
}

/**
 * Match the failed recipient back to the originating send.
 * Most recent email-channel step log for a prospect with that email, fired in
 * the MATCH_WINDOW_DAYS BEFORE the NDR arrived. Returns linkage or nulls.
 *
 * ── 2026-07 FIX: the window was anchored on now(), not on the NDR ──────────
 *
 * `ssl.fired_at >= now() - 14 days` is correct for a live NDR, which lands
 * hours after the send. It is silently wrong for an NDR replayed by
 * NdrCleanupService: the originating send happened weeks ago, nothing matched,
 * and every reprocessed bounce was written with step_log_id = NULL.
 *
 * That is not a cosmetic loss. reporting.routes.js builds `Bounced` from
 * services/BounceEventsQuery.js, which INNER JOINs sequence_step_logs on
 * step_log_id to guarantee bounced ⊆ sent (so `delivered` can never go
 * negative). Unlinked events are therefore discarded from every delivery
 * metric. Run the cleanup, watch email_delivery_events fill up, and still see
 * Bounced = 0 and Deliv % = 100% on every campaign.
 *
 * `ndrAt` fixes both halves:
 *   lower bound — search the 14 days before the NDR, not before today
 *   upper bound — a send that fired AFTER the bounce cannot have caused it,
 *                 and `ORDER BY fired_at DESC LIMIT 1` would happily pick one
 *
 * Live callers pass nothing and get now(), i.e. exactly the old behaviour plus
 * the (harmless, correct) upper bound.
 *
 * @param {Date|string|null} ndrAt  when the NDR arrived. Defaults to now().
 */
async function matchToStepLog(client, orgId, failedRecipient, ndrAt = null) {
  const r = await client.query(
    `SELECT ssl.id AS step_log_id, ssl.prospect_id, p.campaign_id, p.owner_id,
            e.sender_account_id
       FROM sequence_step_logs ssl
       JOIN prospects p ON p.id = ssl.prospect_id AND p.org_id = ssl.org_id
       LEFT JOIN emails e ON e.id = ssl.email_id AND e.org_id = ssl.org_id
      WHERE ssl.org_id = $1
        AND ssl.channel = 'email'
        AND ssl.status IN ('sent','completed','replied')
        AND LOWER(p.email) = $2
        AND ssl.fired_at >= COALESCE($4::timestamptz, now()) - ($3 || ' days')::interval
        AND ssl.fired_at <= COALESCE($4::timestamptz, now())
      ORDER BY ssl.fired_at DESC
      LIMIT 1`,
    [orgId, failedRecipient, MATCH_WINDOW_DAYS, ndrAt]
  );
  if (r.rows.length > 0) return r.rows[0];

  // No recent send matched — still try to link the prospect for the timeline.
  const p = await client.query(
    `SELECT id AS prospect_id, campaign_id, owner_id
       FROM prospects
      WHERE org_id = $1 AND LOWER(email) = $2 AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [orgId, failedRecipient]
  );
  if (p.rows.length > 0) {
    return { step_log_id: null, sender_account_id: null, ...p.rows[0] };
  }
  return { step_log_id: null, prospect_id: null, campaign_id: null, owner_id: null, sender_account_id: null };
}

/**
 * Main entry point — called from Gate 1 in storeEmailToDatabase
 * (jobs/syncScheduler.js) and from the prospecting inbox sync
 * (routes/prospecting-inbox.routes.js) when isLikelyNdr() fired.
 * Parses, matches, persists. Never throws.
 *
 * @param {object} client  pg client (the sync's connection) or the db module
 * @param {object} args    { orgId, userId, email, provider, senderMailbox? }
 *
 *   `email` accepts EITHER normalized shape:
 *     syncScheduler:  { id, from: { address }, subject, body: { content },
 *                       bodyPreview }
 *     inbox sync:     { externalId, fromAddress, subject, body }
 *   The two ingest paths normalize their providers differently; rather than
 *   force one to adapt at the call site (and silently pass undefined into the
 *   parser), we accept both here. Adding a third caller means adding its keys
 *   to the three coalesces below — nothing else.
 *
 *   `senderMailbox` is the address that RECEIVED the NDR, used so the parser
 *   never extracts our own address as the "failed recipient". When omitted we
 *   fall back to users.email for `userId`. The inbox sync passes the
 *   prospecting_sender_accounts address explicitly, because a rep can send
 *   from a mailbox that is not their users.email — in that case the fallback
 *   would compare against the wrong address and could mis-extract.
 *
 * @returns {{ processed: boolean, eventType?: string, prospectId?: number|null,
 *             stepLogId?: number|null, enrollmentStopped?: boolean }}
 */
async function processPotentialNdr(client, { orgId, userId, email, provider, senderMailbox }) {
  try {
    const externalId  = email?.id ?? email?.externalId ?? null;
    const fromAddress = email?.from?.address || email?.fromAddress || '';
    const subject     = email?.subject || '';
    // When the NDR arrived. Live callers don't set it (the message is minutes
    // old); NdrCleanupService replays historic NDRs and must pass the original
    // sent_at, or matchToStepLog searches the wrong fortnight. Shape-tolerant,
    // like everything else read off `email` here.
    const ndrAt       = email?.sentAt ?? email?.receivedAt ?? email?.receivedDateTime ?? null;
    const body        = email?.body?.content || email?.bodyPreview ||
                        (typeof email?.body === 'string' ? email.body : '') || '';

    // The mailbox that received this NDR (= the original sender). Used to
    // avoid extracting the user's own address as the "failed recipient".
    let mailbox = senderMailbox || '';
    if (!mailbox && userId) {
      const senderMailboxRes = await client.query(
        `SELECT email FROM users WHERE id = $1`, [userId]
      );
      mailbox = senderMailboxRes.rows[0]?.email || '';
    }

    const failedRecipient = extractFailedRecipient(body, subject, mailbox);
    if (!failedRecipient) {
      // NDR-shaped but unparseable — record nothing, let Gate 1 drop it.
      console.warn(`[BounceDetection] org=${orgId} NDR without extractable recipient (subject="${String(subject).slice(0, 80)}")`);
      return { processed: false };
    }

    const text = `${subject}\n${body}`;
    const smtpCode = extractSmtpCode(text);
    const eventType = classify(smtpCode, text);
    const link = await matchToStepLog(client, orgId, failedRecipient, ndrAt);

    const ins = await client.query(
      `INSERT INTO email_delivery_events
         (org_id, provider, ndr_external_id, ndr_from, failed_recipient,
          event_type, smtp_code, diagnostic_excerpt,
          prospect_id, step_log_id, sender_account_id, campaign_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org_id, ndr_external_id, failed_recipient)
         WHERE ndr_external_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        orgId, provider || null, externalId, fromAddress || null,
        failedRecipient, eventType, smtpCode, diagnosticExcerpt(body || subject),
        link.prospect_id, link.step_log_id, link.sender_account_id, link.campaign_id,
      ]
    );

    // Duplicate (re-sync) — already fully processed previously.
    if (ins.rows.length === 0) {
      return { processed: true, eventType, failedRecipient, prospectId: link.prospect_id, stepLogId: link.step_log_id, enrollmentStopped: false, duplicate: true };
    }
    const eventId = ins.rows[0].id;

    let enrollmentStopped = false;

    if (link.prospect_id) {
      // Auto-stop active enrollments on hard bounce (D26, config-gated).
      if (eventType === 'hard_bounce') {
        const cfg = await getBounceConfig(client, orgId);
        if (cfg.autoStopOnHardBounce) {
          const stop = await client.query(
            `UPDATE sequence_enrollments
                SET status = 'stopped', stop_reason = 'hard_bounce', updated_at = now()
              WHERE org_id = $1 AND prospect_id = $2 AND status = 'active'
              RETURNING id`,
            [orgId, link.prospect_id]
          );
          enrollmentStopped = stop.rows.length > 0;
          if (enrollmentStopped) {
            await client.query(
              `UPDATE email_delivery_events SET enrollment_stopped = true WHERE id = $1`,
              [eventId]
            );
          }
        }
      }

      // Prospect-timeline activity (org_id always present).
      const labels = {
        hard_bounce: 'Email hard-bounced',
        soft_bounce: 'Email soft-bounced',
        block: 'Email blocked by recipient server',
      };
      const desc =
        `${labels[eventType]}${smtpCode ? ` (${smtpCode})` : ''}` +
        (enrollmentStopped ? ' — sequence enrollment stopped' : '');
      await client.query(
        `INSERT INTO prospecting_activities
           (org_id, prospect_id, user_id, activity_type, description, metadata)
         VALUES ($1, $2, $3, 'bounce_received', $4, $5)`,
        [
          orgId, link.prospect_id, userId, desc,
          JSON.stringify({
            event_type: eventType,
            smtp_code: smtpCode,
            channel: 'email',
            delivery_event_id: eventId,
            step_log_id: link.step_log_id,
            enrollment_stopped: enrollmentStopped,
            source: 'ndr_parser',
          }),
        ]
      );
    }

    console.log(
      `[BounceDetection] org=${orgId} ${eventType} recipient=${failedRecipient}` +
      ` code=${smtpCode || 'n/a'} prospect=${link.prospect_id || 'unmatched'}` +
      ` step_log=${link.step_log_id || 'n/a'} stopped=${enrollmentStopped}`
    );

    // failedRecipient is returned so callers (NdrCleanupService, and the Bounce
    // Cleanup admin panel) can show WHO actually bounced. It is frequently a
    // different prospect from the one the NDR was wrongly attached to, because
    // the old inbox sync matched on sending domain and picked an arbitrary
    // colleague of the address that really failed.
    return { processed: true, eventType, failedRecipient, prospectId: link.prospect_id, stepLogId: link.step_log_id, enrollmentStopped };
  } catch (err) {
    // Must never crash the sync.
    console.error(`[BounceDetection] org=${orgId} error:`, err.message);
    return { processed: false };
  }
}

module.exports = {
  isLikelyNdr,
  isRoleSender,
  processPotentialNdr,
  // exported for tests
  extractFailedRecipient,
  extractSmtpCode,
  classify,
  getBounceConfig,
};
