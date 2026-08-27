// services/notificationDelivery.service.js
//
// The cross-channel delivery dispatcher. Today it does Slack; SMS slots in here
// later as a second branch without touching createNotification again.
//
// Called by the notificationQueue 'slack_delivery' job (one job per notification
// row, enqueued by createNotification). Best-effort: the in-app notification is
// the source of truth; a Slack failure here never affects it.

const { pool }              = require('../config/database');
const enc                   = require('./credentials/encryption');
const notificationService   = require('./notificationService');     // getUserNotificationPrefs
const slackTargets          = require('./notifications/slackTargets');
const slackChannel          = require('./channels/slackChannel');

// Lazy-load the SDK so a missing dep doesn't break module load before Slack ships.
let _WebClient = null;
function WebClient() {
  if (!_WebClient) _WebClient = require('@slack/web-api').WebClient;
  return _WebClient;
}

// notification.type  ->  prefs category
const TYPE_TO_CATEGORY = {
  notification_immediate:          'immediate',
  prospecting_immediate:           'immediate',
  // Agency Phase 6: the client-team-lead fast-path alert for a client-wide
  // sending block. Immediate-category so it rides the same Slack routing as
  // other prompt alerts (the `|| 'immediate'` fallback below would cover it
  // too; listed explicitly for clarity/filterability).
  prospecting_client_sender_blocked: 'immediate',
  notification_digest:             'digest',
  prospecting_digest:              'digest',
  prospecting_escalation_tier_1:   'escalation',
  prospecting_escalation_tier_2:   'escalation',
  prospecting_escalation_tier_3:   'escalation',
  revisit_prospect:                'revisit',
  revisit_account:                 'revisit',
  // Project task review loop. Mapped explicitly rather than left to the
  // `|| 'immediate'` fallback below, because two behaviours key off the
  // 'review' category and both break silently without these entries:
  // the per-category email preference, and the hourly digest deferral in
  // deliverEmail (which only defers category === 'review').
  //
  // Safe for Slack: slackTargets.resolveTargets ignores the category today
  // (channel routing is still commented out), and an absent key in
  // slack_categories reads as allowed, so review alerts keep flowing there.
  play_review_submitted:           'review',
  play_review_approved:            'review',
  play_review_rejected:            'review',
  play_review_closed:              'review',
};
const DEAD_TOKEN_ERRORS = new Set(['token_revoked', 'invalid_auth', 'account_inactive']);

// Load + decrypt the org's active Slack install. Returns null if not connected.
async function getActiveInstall(orgId) {
  const { rows: [row] } = await pool.query(
    `SELECT * FROM org_slack_installs WHERE org_id = $1 AND status = 'active'`,
    [orgId]
  );
  if (!row) return null;
  try {
    const botToken = enc.decrypt(row.bot_token_ciphertext, row.bot_token_iv, row.bot_token_tag);
    return { ...row, botToken };
  } catch (e) {
    console.warn(`[delivery] slack token decrypt failed for org ${orgId}: ${e.message}`);
    return null;
  }
}

/**
 * Deliver a single notification row to Slack.
 * @returns {Promise<{skipped?:boolean, reason?:string, delivered?:number, results?:Array}>}
 */
async function deliverSlack(orgId, notificationId) {
  const install = await getActiveInstall(orgId);
  if (!install) return { skipped: true, reason: 'not_connected' };

  const { rows: [n] } = await pool.query(
    `SELECT * FROM notifications WHERE id = $1 AND org_id = $2`,
    [notificationId, orgId]
  );
  if (!n) return { skipped: true, reason: 'notification_not_found' };

  // ── Preference gate: master switch, then per-category ───────────────────
  const category = TYPE_TO_CATEGORY[n.type] || 'immediate';
  const prefs    = await notificationService.getUserNotificationPrefs(n.user_id, orgId);
  const ch       = prefs.channels || {};
  if (!ch.slack_enabled) return { skipped: true, reason: 'slack_disabled' };
  if (ch.slack_categories && ch.slack_categories[category] === false) {
    return { skipped: true, reason: `category_off:${category}` };
  }

  const client = new (WebClient())(install.botToken);

  // ── Resolve abstract targets, dedup by (kind,id) ────────────────────────
  // Dedup is a no-op for unique DMs but is the thing that makes channel posts
  // collapse correctly once team channels ship.
  const targets = await slackTargets.resolveTargets({
    client, orgId, recipientUserId: n.user_id, category, install,
  });
  if (!targets.length) return { skipped: true, reason: 'no_targets' };

  const seen = new Set();
  const unique = targets.filter((t) => {
    const k = `${t.kind}:${t.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // ── Post ────────────────────────────────────────────────────────────────
  const results = [];
  let deadToken = false;
  for (const target of unique) {
    const r = await slackChannel.postToTarget({ client, target, notification: n });
    results.push({ target: `${target.kind}:${target.id}`, ...r });
    if (r.error && DEAD_TOKEN_ERRORS.has(r.error)) deadToken = true;
  }

  // Dead workspace/token → revoke the install so we stop trying and fall back to in-app.
  if (deadToken) {
    await pool.query(
      `UPDATE org_slack_installs SET status = 'revoked', updated_at = now() WHERE org_id = $1`,
      [orgId]
    ).catch(() => {});
  }

  // Record delivery outcome for observability.
  await pool.query(
    `UPDATE notifications SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [notificationId, JSON.stringify({ slack_delivery: results })]
  ).catch(() => {});

  return { notificationId, delivered: results.filter((r) => r.ok).length, results };
}

/**
 * Deliver one notification as an email.
 *
 * Called by the notificationQueue 'email_delivery' job. Best-effort, exactly
 * like deliverSlack above: the in-app notification row is the source of truth
 * and an SMTP failure never affects it.
 *
 * NOT wired into createNotification()'s fan-out. Only playReviewNotifier
 * enqueues this today, because switching email on centrally would light it up
 * for every notification type in the product at once — digests, escalations,
 * revisit nudges — and that is a product decision, not a side effect of
 * shipping the review loop. When email should become a general channel, add
 * the enqueue to createNotification alongside slack_delivery; nothing here
 * needs to change.
 *
 * The preference gate mirrors Slack's: master switch, then category. It
 * defaults ON, unlike slack_enabled — a review sitting unread because email
 * silently defaulted off is the failure this feature exists to prevent, and
 * the recipient can turn it off.
 */
/**
 * Record why an email was NOT sent, on the notification itself.
 *
 * Every skip path used to return silently, which made a DECLINED send
 * indistinguishable from one that was never attempted - both showed no
 * email_delivery key at all. That is the difference between 'the fan-out is
 * deployed and correctly declining' and 'the fan-out is not running', and it
 * is the first thing you want to know after a deploy.
 *
 * Best-effort: an observability write must never turn a correct skip into a
 * failed job.
 */
async function _stampSkip(notificationId, reason, extra = {}) {
  if (!notificationId) return { skipped: true, reason, ...extra };
  await pool.query(
    `UPDATE notifications SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE id = $1`,
    [notificationId, JSON.stringify({ email_delivery: { sent: false, reason } })]
  ).catch(() => {});
  return { skipped: true, reason, ...extra };
}

async function deliverEmail(orgId, payload = {}) {
  const { userId, notificationId } = payload;

  // ── Resolve the notification, exactly as deliverSlack does ──────────────
  // Callers enqueue { orgId, userId, notificationId } and nothing more. The
  // subject, body, category and recipient address are all derivable from the
  // notification row, and deriving them here rather than at each call site is
  // what makes email work for EVERY notification type instead of only the one
  // that happened to pass them in.
  //
  // playReviewNotifier still passes to/subject/html/text explicitly. Those win
  // when present — it builds a richer body with a deep link than the generic
  // path can — so both call shapes are supported.
  let n = null;
  if (notificationId) {
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE id = $1 AND org_id = $2`,
      [notificationId, orgId]);
    n = rows[0] || null;
    if (!n) return { skipped: true, reason: 'notification_not_found' };
  }

  const recipientId = userId || n?.user_id;
  if (!recipientId) return { skipped: true, reason: 'no_recipient' };

  // ── Preference gate: master switch, then per-category ───────────────────
  // Category comes from TYPE_TO_CATEGORY, the same map Slack routes on, so a
  // new notification type is routed for both channels by one edit. Unknown
  // types fall back to 'immediate', matching deliverSlack.
  const category = n ? (TYPE_TO_CATEGORY[n.type] || 'immediate') : 'review';
  const prefs    = await notificationService.getUserNotificationPrefs(recipientId, orgId);
  const ch       = prefs.channels || {};

  // Defaults OFF. Email is the only channel that reaches someone who is not in
  // the app, which is exactly why it must be opted into rather than out of:
  // silently mailing every user every notification is how a product teaches
  // people to filter it. `=== true` and not `!== false` — an org upgrading from
  // an older prefs row has no email key at all, and that must read as off.
  if (ch.email_enabled !== true) return _stampSkip(notificationId, 'email_disabled');
  if (ch.email_categories && ch.email_categories[category] === false) {
    return _stampSkip(notificationId, `category_off:${category}`);
  }

  // ── Digest deferral (review category only) ──────────────────────────────
  // On a large project every submission would otherwise be its own email. In
  // digest mode the send is skipped and the notification row is STAMPED
  // instead; sendReviewDigest() below sweeps the stamps and sends one mail.
  //
  // Scoped to 'review' because that is the only category with a sweep behind
  // it. The overdue path is already a daily digest by construction — deferring
  // it again would delay a once-a-day mail by up to another hour for nothing.
  //
  // The stamp lives in metadata rather than a new column deliberately: it is
  // per-notification bookkeeping with a lifetime of hours. Requires
  // notificationId — a deferral we cannot stamp is a mail we would silently
  // lose, so it falls through and sends immediately instead.
  if (category === 'review' && ch.review_email_mode === 'digest' && notificationId) {
    await pool.query(
      `UPDATE notifications SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [notificationId, JSON.stringify({
        email_deferred: true,
        email_delivery: { sent: false, reason: 'deferred_to_digest' },
      })]
    ).catch(() => {});
    return { skipped: true, reason: 'deferred_to_digest' };
  }

  // ── Address ─────────────────────────────────────────────────────────────
  let to = payload.to;
  if (!to) {
    const { rows: [u] } = await pool.query(
      `SELECT email FROM users WHERE id = $1`, [recipientId]);
    to = u?.email || null;
  }
  if (!to) return _stampSkip(notificationId, 'no_address');

  const subject = payload.subject || n?.title;
  if (!subject) return _stampSkip(notificationId, 'no_subject');

  const text = payload.text || `${n?.body || ''}${n?.metadata?.url ? `\n\n${n.metadata.url}` : ''}\n`;
  // metadata.url is the deep link back to the thing the alert is about.
  // Reading it here rather than having each notifier build its own HTML is
  // what let playReviewNotifier stop enqueueing its own email: any caller
  // that puts a url in metadata gets a linked email for free.
  const html = payload.html || _genericHtml(n?.title, n?.body, n?.metadata?.url);

  const { sendSystemEmail } = require('./systemMailer');
  const result = await sendSystemEmail({ to, subject, html, text });

  // Record the outcome on the notification row so a "did they get told?"
  // question is answerable without reading logs. Contained: an observability
  // write must not turn a delivered email into a failed job.
  if (notificationId) {
    await pool.query(
      `UPDATE notifications SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [notificationId, JSON.stringify({ email_delivery: result })]
    ).catch(() => {});
  }

  return { notificationId, category, ...result };
}

// Plain transactional shell for notifications that did not supply their own
// body. Deliberately minimal: this is an alert, not a campaign, and an HTML
// wrapper with a logo in it buys nothing and breaks in more clients.
function _genericHtml(title, body, url) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const link = url
    ? `<p style="margin:14px 0 0"><a href="${esc(url)}" style="color:#1d4ed8">Open it in GoWarmCRM</a></p>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111827;line-height:1.5">
  <p style="margin:0 0 12px"><strong>${esc(title)}</strong></p>
  <div style="margin:0;white-space:pre-wrap">${esc(body)}</div>
  ${link}
</div>`;
}

/**
 * Send one user their pending review digest, and clear the stamps.
 *
 * Collects every play_review_* notification stamped email_deferred that has
 * not yet been digested, groups it into one mail, and marks the rows so a
 * second sweep cannot send them twice.
 *
 * Ordering matters: the stamp is cleared only AFTER a successful send. A
 * failed send leaves the rows pending, so the next sweep retries them rather
 * than dropping a day of alerts on a transient SMTP error.
 */
async function sendReviewDigest(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT id, title, body, created_at, metadata
       FROM notifications
      WHERE org_id = $1 AND user_id = $2
        AND type LIKE 'play_review_%'
        AND metadata->>'email_deferred' = 'true'
        AND metadata->>'email_digested' IS NULL
      ORDER BY created_at ASC
      LIMIT 200`,
    [orgId, userId]);

  if (!rows.length) return { skipped: true, reason: 'nothing_pending' };

  const { rows: [u] } = await pool.query(
    `SELECT email, first_name FROM users WHERE id = $1`, [userId]);
  if (!u?.email) return { skipped: true, reason: 'no_recipient' };

  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const subject = rows.length === 1
    ? rows[0].title
    : `${rows.length} task reviews need you`;

  const text = rows.map(r => `• ${r.title}\n  ${r.body}`).join('\n\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111827;line-height:1.5">
  <p style="margin:0 0 14px">Since your last update:</p>
  ${rows.map(r => `<div style="margin:0 0 14px;padding-left:10px;border-left:3px solid #fde68a">
    <div style="font-weight:600">${esc(r.title)}</div>
    <div style="color:#4b5563">${esc(r.body)}</div>
  </div>`).join('')}
</div>`;

  const { sendSystemEmail } = require('./systemMailer');
  const result = await sendSystemEmail({ to: u.email, subject, html, text });

  if (result.sent) {
    await pool.query(
      `UPDATE notifications
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'email_digested', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSZ'))
        WHERE id = ANY($1)`,
      [rows.map(r => r.id)]).catch(() => {});
  }

  return { userId, items: rows.length, ...result };
}

module.exports = {
  deliverSlack, deliverEmail, sendReviewDigest, getActiveInstall, TYPE_TO_CATEGORY,
};
