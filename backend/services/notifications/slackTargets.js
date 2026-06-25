// services/notifications/slackTargets.js
//
// Destination resolver — the team-channel seam.
//
// resolveTargets() returns an array of abstract delivery targets:
//   { kind: 'dm' | 'channel', id, mention? }
//
// v1 returns at most ONE dm target (the recipient's own Slack DM). The dispatcher
// loops over whatever this returns, so shipping team channels later is purely
// additive here: append { kind:'channel', id, mention:<recipientSlackId> } targets
// from install.default_channel_id or a future slack_channel_routes table — no
// change to the dispatcher or the adapter.

const { pool } = require('../../config/database');

const LOOKUP_RETRY_MS = 24 * 60 * 60 * 1000; // don't re-lookup a no-match user for 24h

/**
 * Resolve the recipient's Slack user ID, caching it on the users row.
 * Returns null (and records the attempt) if the rep's email has no Slack match.
 */
async function resolveSlackUserId({ client, orgId, userId }) {
  const { rows: [u] } = await pool.query(
    `SELECT email, slack_user_id, slack_lookup_at FROM users WHERE id = $1 AND org_id = $2`,
    [userId, orgId]
  );
  if (!u) return null;
  if (u.slack_user_id) return u.slack_user_id;

  // Skip if we recently tried and failed (email simply isn't in this workspace)
  if (u.slack_lookup_at && (Date.now() - new Date(u.slack_lookup_at).getTime()) < LOOKUP_RETRY_MS) {
    return null;
  }

  let slackId = null;
  try {
    const r = await client.users.lookupByEmail({ email: u.email });
    slackId = r?.user?.id || null;
  } catch (e) {
    // users_not_found / invalid_email etc. — silent skip per the agreed fallback
  }

  await pool.query(
    `UPDATE users SET slack_user_id = $2, slack_lookup_at = now() WHERE id = $1`,
    [userId, slackId]
  ).catch(() => {});

  return slackId;
}

/**
 * @returns {Promise<Array<{kind:'dm'|'channel', id:string, mention?:string}>>}
 */
async function resolveTargets({ client, orgId, recipientUserId, category, install }) {
  const targets = [];

  // ── v1: direct message to the recipient ─────────────────────────────────
  const slackUserId = await resolveSlackUserId({ client, orgId, userId: recipientUserId });
  if (slackUserId) targets.push({ kind: 'dm', id: slackUserId });

  // ── v2 (team channels) — additive, intentionally left as a seam ─────────
  // const channelId = await resolveChannelRoute({ orgId, category, recipientUserId, install });
  // if (channelId) targets.push({ kind: 'channel', id: channelId, mention: slackUserId });

  return targets;
}

module.exports = { resolveTargets, resolveSlackUserId };
