// services/channels/slackChannel.js
//
// Dumb Slack send adapter. Posts ONE message to ONE target. Knows nothing about
// prefs, recipients, or routing — it takes a resolved target and a notification
// and posts it. Because chat.postMessage accepts a user ID or a channel ID in the
// same `channel` field, the only kind-specific behaviour is the @mention prefix
// we add for channel posts (a DM is already addressed to the person).

function publicBaseUrl() {
  return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://app.gowarmcrm.com')
    .replace(/\/+$/, '');
}

// Map a notification's entity to its in-app deep link.
//
// The app is an SPA with URL-HASH navigation (see frontend hashNav.js) — it
// never reads location.pathname. Links must therefore be hash URLs
// (…/#/prospecting/123); the previous path-style links (…/prospects/123)
// landed users on their default tab. Grammar owned by the frontend:
//
//   #/prospecting/<prospectId>                    prospect drawer
//   #/prospecting/inbox/activity/e~<emailId>      inbox, email item pinned
//   #/prospecting/inbox/activity/a~<activityId>   inbox, activity item pinned
//   #/prospecting/work | calls | network          prospecting sub-views
//
// Metadata may arrive as a JSONB object or a serialized string depending on
// the driver path — parse defensively.
function notifMetadata(notification) {
  const m = notification.metadata;
  if (!m) return {};
  if (typeof m === 'string') { try { return JSON.parse(m); } catch { return {}; } }
  return m;
}

function buildDeepLink(notification) {
  const base = publicBaseUrl();
  const { entity_type: et, entity_id: id } = notification;
  const md = notifMetadata(notification);

  // Inbox item (e.g. a "new reply" notification): entity carries the feed
  // ref in metadata — pins the exact item in the Prospecting Inbox.
  if (et === 'inbox_item' && md.ref_table && md.ref_id) {
    const token = `${md.ref_table === 'emails' ? 'e' : 'a'}~${md.ref_id}`;
    return `${base}/#/prospecting/inbox/activity/${token}`;
  }

  // Immediate prospecting alerts carry the prospect in metadata — the
  // prospect drawer is the actionable destination. Digests (no entity_id,
  // no single prospect) land on the Work Queue.
  if (et === 'prospecting_action') {
    return md.prospect_id
      ? `${base}/#/prospecting/${md.prospect_id}`
      : `${base}/#/prospecting/work`;
  }

  if (et === 'prospect' && id)  return `${base}/#/prospecting/${id}`;
  if (et === 'call_inbox')      return `${base}/#/prospecting/calls`;
  if (et === 'network')         return `${base}/#/prospecting/network`;
  if (et === 'prospecting_sender') return `${base}/#/settings/preferences`;
  if (et === 'action')          return `${base}/#/actions`;
  if (et === 'account' && id)   return `${base}/#/accounts`;

  return base;
}

/**
 * @param {Object}  args
 * @param {WebClient} args.client        org-scoped Slack client (token already set)
 * @param {Object}  args.target          { kind:'dm'|'channel', id, mention? }
 * @param {Object}  args.notification    the notifications row
 * @returns {Promise<{ok:boolean, ts?:string, channel?:string, error?:string}>}
 */
async function postToTarget({ client, target, notification }) {
  const link = buildDeepLink(notification);

  // Channel posts get an @mention so the right person is pinged; DMs don't need it.
  const mentionPrefix =
    target.kind === 'channel' && target.mention ? `<@${target.mention}> ` : '';

  const headline = `${mentionPrefix}*${notification.title}*`;
  const bodyText = notification.body ? `\n${notification.body}` : '';
  const fallback = `${notification.title}${notification.body ? ` — ${notification.body}` : ''}`;

  try {
    const res = await client.chat.postMessage({
      channel: target.id,            // user ID (DM) or channel ID — Slack accepts both
      text: fallback,                // notification preview / accessibility fallback
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${headline}${bodyText}` } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Open in GoWarmCRM' },
              url: link,
            },
          ],
        },
      ],
    });
    return { ok: !!res.ok, ts: res.ts, channel: res.channel };
  } catch (err) {
    return { ok: false, error: err?.data?.error || err.message };
  }
}

module.exports = { postToTarget, buildDeepLink };
