// services/channels/whatsappChannel.js
//
// Dumb WhatsApp send adapter, deliberately shaped like slackChannel.js: it
// sends ONE message to ONE thread and knows nothing about preferences,
// recipient resolution, or routing. Those live a layer up in
// notificationDelivery.service.js / whatsapp.service.js.
//
// The one thing this adapter DOES own is the rule that makes WhatsApp different
// from every other channel we ship: you may not send arbitrary text whenever
// you like. Outside an open 24-hour customer service window, only a Meta-
// approved template may be delivered. sendToThread() enforces that here rather
// than trusting each caller to remember it — getting it wrong is not a silent
// failure, it is a policy violation that degrades the org's quality rating and
// eventually costs them the number.
//
// Requires migration db/2026_65_whatsapp_channel.sql.

'use strict';

const { pool } = require('../../config/database');
const enc      = require('../credentials/encryption');

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE    = 'https://graph.facebook.com';

// ── Credentials ──────────────────────────────────────────────────────────────

/**
 * Load + decrypt an org's WhatsApp Business Account. Returns null if the org
 * has not connected WhatsApp (which is the normal case — this is opt-in).
 */
async function getAccount(orgId) {
  const { rows: [row] } = await pool.query(
    `SELECT * FROM org_whatsapp_accounts WHERE org_id = $1 AND status = 'active'`,
    [orgId]
  );
  if (!row) return null;

  try {
    const accessToken = enc.decrypt(
      row.access_token_ciphertext, row.access_token_iv, row.access_token_tag
    );
    const appSecret = row.app_secret_ciphertext
      ? enc.decrypt(row.app_secret_ciphertext, row.app_secret_iv, row.app_secret_tag)
      : null;
    return { ...row, accessToken, appSecret };
  } catch (e) {
    console.warn(`[whatsapp] token decrypt failed for org ${orgId}: ${e.message}`);
    return null;
  }
}

// ── Service window ───────────────────────────────────────────────────────────

/**
 * Is the 24-hour customer service window open on this thread?
 *
 * Open  → free-form text is permitted.
 * Closed→ only an approved template may be sent.
 *
 * NOTE ON COST: an open window has historically also meant "free". Meta has
 * announced service-message pricing changes effective 1 October 2026. The
 * PERMISSION granted by an open window and the PRICE of using it are separate
 * concerns; do not let callers conflate them.
 */
function isWindowOpen(thread) {
  if (!thread?.window_expires_at) return false;
  return new Date(thread.window_expires_at) > new Date();
}

// ── Send ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} args
 * @param {Object} args.account   from getAccount()
 * @param {Object} args.thread    whatsapp_threads row
 * @param {Object} [args.text]    { body } — free-form; requires an open window
 * @param {Object} [args.template]{ name, language, variables[] } — always allowed
 * @returns {Promise<{ok:boolean, wamid?:string, error?:string, code?:string}>}
 */
async function sendToThread({ account, thread, text, template }) {
  if (!account) return { ok: false, error: 'whatsapp_not_connected', code: 'NOT_CONNECTED' };
  if (thread.opt_out_at) return { ok: false, error: 'recipient_opted_out', code: 'OPTED_OUT' };

  // Enforce the window rule centrally.
  if (text && !template && !isWindowOpen(thread)) {
    return {
      ok: false,
      code: 'WINDOW_CLOSED',
      error: 'Service window is closed; a pre-approved template is required to re-open the conversation',
    };
  }

  // Group threads accept text, media and templates — but not interactive
  // messages (buttons/lists). Callers that build interactive payloads must
  // fall back to a 1:1 thread; fail loudly rather than sending a degraded
  // message the recipient can't act on.
  if (thread.kind === 'group' && template?.interactive) {
    return {
      ok: false,
      code: 'GROUP_UNSUPPORTED',
      error: 'Interactive templates are not supported in group threads',
    };
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: thread.kind === 'group' ? 'group' : 'individual',
    to: thread.kind === 'group' ? thread.wa_group_id : thread.wa_phone,
  };

  if (template) {
    payload.type = 'template';
    payload.template = {
      name: template.name,
      language: { code: template.language || 'en' },
      components: template.variables?.length
        ? [{
            type: 'body',
            parameters: template.variables.map(v => ({ type: 'text', text: String(v ?? '') })),
          }]
        : undefined,
    };
  } else {
    payload.type = 'text';
    payload.text = { preview_url: false, body: text.body };
  }

  try {
    const res = await fetch(
      `${GRAPH_BASE}/${GRAPH_VERSION}/${account.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${account.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await res.json();

    if (!res.ok) {
      const err = data?.error || {};
      return {
        ok: false,
        code: String(err.code ?? res.status),
        error: err.message || `WhatsApp send failed (HTTP ${res.status})`,
        // 131047 = re-engagement required (window closed), 131026 = undeliverable,
        // 132000/132001 = template mismatch or not approved.
        isRetryable: [500, 502, 503, 504].includes(res.status),
      };
    }

    return { ok: true, wamid: data?.messages?.[0]?.id ?? null };
  } catch (e) {
    return { ok: false, code: 'NETWORK', error: e.message, isRetryable: true };
  }
}

// ── Groups ───────────────────────────────────────────────────────────────────

const MAX_GROUP_PARTICIPANTS = 8;   // Meta's cap, not ours.

/**
 * Create an API-managed group and return its id + invite link.
 *
 * Two constraints worth stating plainly, because they shape the whole feature:
 *   1. Groups are capped at 8 participants.
 *   2. Only one Cloud API business may be present in a group, and the group
 *      must be created through the API. An existing customer group created in
 *      the consumer app can never be adopted — migration means asking everyone
 *      to join a new room.
 *
 * Requires the org to hold an Official Business Account.
 */
async function createGroup({ account, subject }) {
  if (!account) return { ok: false, error: 'whatsapp_not_connected' };
  if (!account.is_official_business_account) {
    return {
      ok: false,
      code: 'OBA_REQUIRED',
      error: 'The Groups API requires an Official Business Account on this WABA',
    };
  }

  try {
    const res = await fetch(
      `${GRAPH_BASE}/${GRAPH_VERSION}/${account.phone_number_id}/groups`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${account.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', subject }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, code: String(data?.error?.code ?? res.status), error: data?.error?.message };
    }
    return { ok: true, groupId: data?.id ?? null, inviteLink: data?.invite_link ?? null };
  } catch (e) {
    return { ok: false, code: 'NETWORK', error: e.message };
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

/**
 * Fetch this WABA's message templates from Meta. Returns the raw `data` array
 * (each with name, status, category, language, components). Caller filters.
 */
async function listTemplates(account) {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${account.waba_id}/message_templates`
            + `?fields=name,status,category,language,components&limit=250`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${account.accessToken}` } });
  const data = await res.json();
  if (!res.ok) {
    const err = data?.error || {};
    throw Object.assign(new Error(err.message || 'Failed to fetch templates from Meta'),
      { status: res.status, code: err.code });
  }
  return data.data || [];
}

module.exports = {
  getAccount,
  isWindowOpen,
  sendToThread,
  listTemplates,
  createGroup,
  MAX_GROUP_PARTICIPANTS,
};
