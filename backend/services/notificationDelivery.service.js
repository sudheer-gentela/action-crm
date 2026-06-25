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
  notification_digest:             'digest',
  prospecting_digest:              'digest',
  prospecting_escalation_tier_1:   'escalation',
  prospecting_escalation_tier_2:   'escalation',
  prospecting_escalation_tier_3:   'escalation',
  revisit_prospect:                'revisit',
  revisit_account:                 'revisit',
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

module.exports = { deliverSlack, getActiveInstall, TYPE_TO_CATEGORY };
