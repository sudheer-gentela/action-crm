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
function buildDeepLink(notification) {
  const base = publicBaseUrl();
  const { entity_type: et, entity_id: id } = notification;
  if (!et || !id) return base;
  const path =
      et === 'prospecting_action' ? `prospecting/actions/${id}`
    : et === 'action'             ? `actions/${id}`
    : et === 'prospect'           ? `prospects/${id}`
    : et === 'account'            ? `accounts/${id}`
    : '';
  return path ? `${base}/${path}` : base;
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
