// services/whatsapp.service.js
//
// The layer above whatsappChannel.js (the dumb send adapter) and below the
// routes. It owns:
//   • connect/disconnect  — encrypt + store an org's WABA credentials
//   • thread resolution    — find/create the whatsapp_threads row for a handover
//   • send                 — persist an outbound message around adapter.sendToThread
//   • inbound ingest        — webhook messages[] → whatsapp_messages (window opens
//                             via the 2026_65 trigger) 
//   • status ingest         — webhook statuses[] → update delivery/read on outbound
//
// Signature verification and the hub-challenge handshake also live here so the
// webhook route stays a thin transport shell.
//
// Requires: db/2026_65_whatsapp_channel.sql, services/channels/whatsappChannel.js,
//           services/credentials/encryption.js

'use strict';

const crypto = require('crypto');
const { pool } = require('../config/database');
const enc      = require('./credentials/encryption');
const waChannel = require('./channels/whatsappChannel');

// ── Connect / status ─────────────────────────────────────────────────────────

/**
 * Store (or replace) an org's WhatsApp Business Account credentials.
 * The access token and app secret are encrypted at rest; plaintext never
 * leaves this call stack and is never returned by a route.
 */
async function connect(orgId, userId, p) {
  if (!p || !p.accessToken || !p.phoneNumberId || !p.wabaId) {
    throw Object.assign(new Error('accessToken, phoneNumberId and wabaId are required'), { status: 400 });
  }

  const tok = enc.encrypt(p.accessToken);
  const sec = p.appSecret ? enc.encrypt(p.appSecret) : null;
  const last4 = p.accessToken.slice(-4);

  const { rows: [row] } = await pool.query(
    `INSERT INTO org_whatsapp_accounts
       (org_id, waba_id, phone_number_id, display_phone_number, business_id, verified_name,
        access_token_ciphertext, access_token_iv, access_token_tag, access_token_last4,
        app_secret_ciphertext, app_secret_iv, app_secret_tag,
        webhook_verify_token, provider, is_official_business_account, groups_enabled,
        status, connected_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10, $11,$12,$13, $14,$15,$16,$17, 'active',$18, now())
     ON CONFLICT (org_id) DO UPDATE SET
        waba_id = EXCLUDED.waba_id,
        phone_number_id = EXCLUDED.phone_number_id,
        display_phone_number = EXCLUDED.display_phone_number,
        business_id = EXCLUDED.business_id,
        verified_name = EXCLUDED.verified_name,
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        access_token_iv = EXCLUDED.access_token_iv,
        access_token_tag = EXCLUDED.access_token_tag,
        access_token_last4 = EXCLUDED.access_token_last4,
        app_secret_ciphertext = EXCLUDED.app_secret_ciphertext,
        app_secret_iv = EXCLUDED.app_secret_iv,
        app_secret_tag = EXCLUDED.app_secret_tag,
        webhook_verify_token = EXCLUDED.webhook_verify_token,
        provider = EXCLUDED.provider,
        is_official_business_account = EXCLUDED.is_official_business_account,
        groups_enabled = EXCLUDED.groups_enabled,
        status = 'active',
        connected_by = EXCLUDED.connected_by,
        updated_at = now()
     RETURNING org_id`,
    [
      orgId, p.wabaId, p.phoneNumberId, p.displayPhoneNumber || null, p.businessId || null,
      p.verifiedName || null,
      tok.ciphertext, tok.iv, tok.tag, last4,
      sec ? sec.ciphertext : null, sec ? sec.iv : null, sec ? sec.tag : null,
      p.webhookVerifyToken || null, p.provider || 'meta_cloud',
      !!p.isOfficialBusinessAccount, !!p.groupsEnabled,
      userId,
    ]
  );
  return getStatus(orgId);
}

async function disconnect(orgId) {
  await pool.query(
    `UPDATE org_whatsapp_accounts SET status = 'revoked', updated_at = now() WHERE org_id = $1`,
    [orgId]
  );
  return { connected: false };
}

/** Non-secret connection summary for the UI. */
async function getStatus(orgId) {
  const { rows: [row] } = await pool.query(
    `SELECT phone_number_id, display_phone_number, verified_name, provider,
            is_official_business_account, groups_enabled, quality_rating,
            messaging_limit_tier, access_token_last4, status, updated_at
       FROM org_whatsapp_accounts WHERE org_id = $1`,
    [orgId]
  );
  if (!row || row.status !== 'active') return { connected: false };
  return {
    connected: true,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    provider: row.provider,
    isOfficialBusinessAccount: row.is_official_business_account,
    groupsEnabled: row.groups_enabled,
    qualityRating: row.quality_rating,
    messagingLimitTier: row.messaging_limit_tier,
    tokenLast4: row.access_token_last4,
    updatedAt: row.updated_at,
  };
}

// ── Thread resolution ────────────────────────────────────────────────────────

/**
 * Find the thread attached to a handover. If createIfMissing, open a 1:1 thread
 * to the handover's primary stakeholder (falling back to any stakeholder with a
 * phone). Returns null if no thread exists and none can be created.
 */
async function getThreadForHandover(handoverId, orgId, { createIfMissing = false, createdBy = null } = {}) {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM whatsapp_threads WHERE org_id = $1 AND handover_id = $2 ORDER BY id LIMIT 1`,
    [orgId, handoverId]
  );
  if (existing) return existing;
  if (!createIfMissing) return null;

  // Resolve a customer phone from the handover's stakeholders.
  const { rows: [cust] } = await pool.query(
    `SELECT c.id AS contact_id, c.phone,
            c.first_name || ' ' || c.last_name AS full_name
       FROM sales_handover_stakeholders s
       JOIN contacts c ON c.id = s.contact_id
      WHERE s.handover_id = $1 AND s.org_id = $2 AND c.phone IS NOT NULL
      ORDER BY s.is_primary_contact DESC, s.id
      LIMIT 1`,
    [handoverId, orgId]
  );
  if (!cust) {
    throw Object.assign(new Error('No stakeholder with a phone number on this handover'), { status: 400 });
  }

  const waPhone = normalizePhone(cust.phone);
  const { rows: [ho] } = await pool.query(
    `SELECT deal_id, account_id FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]
  );

  const { rows: [thread] } = await pool.query(
    `INSERT INTO whatsapp_threads
       (org_id, kind, wa_phone, handover_id, deal_id, account_id, contact_id, status, created_by)
     VALUES ($1, 'direct', $2, $3, $4, $5, $6, 'active', $7)
     ON CONFLICT (org_id, wa_phone) WHERE kind = 'direct'
       DO UPDATE SET handover_id = EXCLUDED.handover_id, updated_at = now()
     RETURNING *`,
    [orgId, waPhone, handoverId, ho?.deal_id ?? null, ho?.account_id ?? null, cust.contact_id, createdBy]
  );
  return thread;
}

// ── Send ─────────────────────────────────────────────────────────────────────

/**
 * Send a message on a handover's thread and persist it.
 * @param body { text?:string, templateName?:string, templateVars?:string[], templateLanguage?:string }
 */
async function sendToHandover(handoverId, orgId, userId, body) {
  const account = await waChannel.getAccount(orgId);
  if (!account) {
    return { ok: false, code: 'NOT_CONNECTED', error: 'WhatsApp is not connected for this org' };
  }

  const thread = await getThreadForHandover(handoverId, orgId, { createIfMissing: true, createdBy: userId });

  const template = body.templateName
    ? { name: body.templateName, language: body.templateLanguage || 'en', variables: body.templateVars || [] }
    : null;
  const text = (!template && body.text) ? { body: body.text } : null;

  if (!template && !text) {
    throw Object.assign(new Error('Provide either text or a templateName'), { status: 400 });
  }

  const result = await waChannel.sendToThread({ account, thread, text, template });
  if (!result.ok) {
    // Surface the adapter's typed error (WINDOW_CLOSED, OPTED_OUT, etc.) unchanged.
    return result;
  }

  const { rows: [msg] } = await pool.query(
    `INSERT INTO whatsapp_messages
       (org_id, thread_id, wa_message_id, direction, message_type, body,
        template_id, sent_by_user_id, is_automated, status, sent_at)
     VALUES ($1, $2, $3, 'outbound', $4, $5, NULL, $6, false, 'sent', now())
     RETURNING id, status, created_at`,
    [orgId, thread.id, result.wamid || null, template ? 'template' : 'text',
     template ? `[template:${template.name}]` : text.body, userId]
  );

  return { ok: true, wamid: result.wamid || null, message: msg, threadId: thread.id };
}

async function listMessages(handoverId, orgId) {
  const thread = await getThreadForHandover(handoverId, orgId, { createIfMissing: false });
  if (!thread) return { thread: null, windowOpen: false, messages: [] };

  const { rows } = await pool.query(
    `SELECT id, direction, message_type, body, status, from_name, is_automated,
            sent_at, delivered_at, read_at, created_at
       FROM whatsapp_messages
      WHERE thread_id = $1 AND org_id = $2
      ORDER BY created_at ASC`,
    [thread.id, orgId]
  );
  return {
    thread: {
      id: thread.id,
      kind: thread.kind,
      subject: thread.group_subject,
      windowExpiresAt: thread.window_expires_at,
    },
    windowOpen: waChannel.isWindowOpen(thread),
    messages: rows,
  };
}

// ── Webhook: verification + ingest ───────────────────────────────────────────

/**
 * GET handshake. Meta sends hub.mode/hub.verify_token/hub.challenge. The verify
 * token is app-level: check the env token first, then any active account's
 * stored token. Returns the challenge string on success, null on failure.
 */
async function verifyChallenge(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || !token) return null;

  if (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return challenge;
  }
  const { rows: [row] } = await pool.query(
    `SELECT 1 FROM org_whatsapp_accounts WHERE webhook_verify_token = $1 AND status = 'active' LIMIT 1`,
    [token]
  );
  return row ? challenge : null;
}

/**
 * Verify X-Hub-Signature-256 over the raw body. Prefers a shared app secret in
 * env (single Meta app serving all tenants); otherwise resolves the per-account
 * secret via the payload's phone_number_id. Returns true if valid.
 */
async function verifySignature(rawBody, signatureHeader, payload) {
  if (!signatureHeader || !rawBody) return false;
  const expected = (sig) =>
    'sha256=' + crypto.createHmac('sha256', sig).update(rawBody, 'utf8').digest('hex');

  const safeEqual = (a, b) => {
    const ba = Buffer.from(a); const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };

  if (process.env.WHATSAPP_APP_SECRET) {
    return safeEqual(signatureHeader, expected(process.env.WHATSAPP_APP_SECRET));
  }

  const phoneNumberId = extractPhoneNumberId(payload);
  if (!phoneNumberId) return false;
  const { rows: [row] } = await pool.query(
    `SELECT app_secret_ciphertext, app_secret_iv, app_secret_tag
       FROM org_whatsapp_accounts WHERE phone_number_id = $1 AND status = 'active'`,
    [phoneNumberId]
  );
  if (!row || !row.app_secret_ciphertext) return false;
  const secret = enc.decrypt(row.app_secret_ciphertext, row.app_secret_iv, row.app_secret_tag);
  return safeEqual(signatureHeader, expected(secret));
}

/**
 * Ingest a webhook payload: inbound messages + delivery statuses.
 * Idempotent on wa_message_id. Returns a small summary.
 */
async function ingestWebhook(payload) {
  let inbound = 0, statuses = 0;
  const entries = payload?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value?.metadata?.phone_number_id;
      const org = await orgForPhoneNumberId(phoneNumberId);
      if (!org) continue;

      for (const m of value.messages || []) {
        const thread = await threadForInbound(org, m.from, value);
        if (!thread) continue;
        const bodyText = m.text?.body ?? `[${m.type}]`;
        const res = await pool.query(
          `INSERT INTO whatsapp_messages
             (org_id, thread_id, wa_message_id, direction, message_type, body,
              from_phone, from_name, status, sent_at)
           VALUES ($1,$2,$3,'inbound',$4,$5,$6,$7,'received', to_timestamp($8))
           ON CONFLICT (org_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
          [org, thread.id, m.id, m.type || 'text', bodyText, m.from,
           contactNameFromValue(value, m.from), Number(m.timestamp) || (Date.now() / 1000)]
        );
        if (res.rowCount > 0) inbound++;   // window opens via the touch trigger
      }

      for (const s of value.statuses || []) {
        const col = { sent: 'sent_at', delivered: 'delivered_at', read: 'read_at', failed: 'failed_at' }[s.status];
        const res = await pool.query(
          `UPDATE whatsapp_messages
              SET status = $1${col ? `, ${col} = to_timestamp($4)` : ''}
            WHERE org_id = $2 AND wa_message_id = $3`,
          col ? [s.status, org, s.id, Number(s.timestamp) || (Date.now() / 1000)]
              : [s.status, org, s.id]
        );
        if (res.rowCount > 0) statuses++;
      }
    }
  }
  return { inbound, statuses };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

function extractPhoneNumberId(payload) {
  try {
    return payload.entry[0].changes[0].value.metadata.phone_number_id;
  } catch { return null; }
}

async function orgForPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT org_id FROM org_whatsapp_accounts WHERE phone_number_id = $1 AND status = 'active'`,
    [phoneNumberId]
  );
  return row ? row.org_id : null;
}

function contactNameFromValue(value, fromPhone) {
  const c = (value.contacts || []).find(x => x.wa_id === fromPhone);
  return c?.profile?.name || null;
}

/** Find (or open) the direct thread an inbound message belongs to. */
async function threadForInbound(orgId, fromPhone, value) {
  const waPhone = normalizePhone(fromPhone);
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM whatsapp_threads WHERE org_id = $1 AND kind = 'direct' AND wa_phone = $2 LIMIT 1`,
    [orgId, waPhone]
  );
  if (existing) return existing;

  // Unknown sender — open an unlinked thread so nothing is dropped; it can be
  // attached to a handover later from the UI.
  const { rows: [thread] } = await pool.query(
    `INSERT INTO whatsapp_threads (org_id, kind, wa_phone, status, opt_in_source)
     VALUES ($1, 'direct', $2, 'active', 'inbound')
     ON CONFLICT (org_id, wa_phone) WHERE kind = 'direct' DO UPDATE SET updated_at = now()
     RETURNING *`,
    [orgId, waPhone]
  );
  return thread;
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  getThreadForHandover,
  sendToHandover,
  listMessages,
  verifyChallenge,
  verifySignature,
  ingestWebhook,
};
