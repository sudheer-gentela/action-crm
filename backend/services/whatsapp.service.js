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
const waTemplates = require('./whatsappTemplates.service');

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
 * Load a specific thread by id, scoped to the org and (optionally) verified to
 * belong to the handover. Used when the caller explicitly picks a conversation
 * (e.g. a group thread).
 */
async function getThreadById(threadId, orgId, handoverId) {
  const { rows: [t] } = await pool.query(
    `SELECT * FROM whatsapp_threads WHERE id = $1 AND org_id = $2`,
    [threadId, orgId]
  );
  if (!t) return null;
  if (handoverId != null && t.handover_id != null && t.handover_id !== handoverId) return null;
  return t;
}

/**
 * Find or open a DIRECT (1:1) thread to a specific phone, linked to the
 * handover. This is how "send to a specific person" works — including a person
 * who currently only exists as a participant inside a group thread.
 */
async function resolveDirectThreadByPhone(handoverId, orgId, phone, userId) {
  const v = toWaPhone(phone);
  if (!v.ok) throw Object.assign(new Error(v.message), { status: 400, code: v.code });
  const waPhone = v.phone;

  const { rows: [existing] } = await pool.query(
    `SELECT * FROM whatsapp_threads WHERE org_id = $1 AND wa_phone = $2 AND kind = 'direct'`,
    [orgId, waPhone]
  );
  if (existing) {
    if (existing.handover_id == null) {
      await pool.query(`UPDATE whatsapp_threads SET handover_id = $1, updated_at = now() WHERE id = $2`,
        [handoverId, existing.id]);
      existing.handover_id = handoverId;
    }
    return existing;
  }

  const { rows: [ho] } = await pool.query(
    `SELECT deal_id, account_id FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]
  );
  const { rows: [ct] } = await pool.query(
    `SELECT c.id FROM sales_handover_stakeholders s JOIN contacts c ON c.id = s.contact_id
      WHERE s.handover_id = $1 AND s.org_id = $2
        AND regexp_replace(c.phone, '[^0-9]', '', 'g') = $3
      LIMIT 1`,
    [handoverId, orgId, waPhone]
  );

  const { rows: [thread] } = await pool.query(
    `INSERT INTO whatsapp_threads
       (org_id, kind, wa_phone, handover_id, deal_id, account_id, contact_id, status, created_by)
     VALUES ($1, 'direct', $2, $3, $4, $5, $6, 'active', $7)
     ON CONFLICT (org_id, wa_phone) WHERE kind = 'direct'
       DO UPDATE SET handover_id = EXCLUDED.handover_id, updated_at = now()
     RETURNING *`,
    [orgId, waPhone, handoverId, ho?.deal_id ?? null, ho?.account_id ?? null, ct?.id ?? null, userId]
  );
  return thread;
}

/**
 * Backward-compatible default recipient: prefer an existing DIRECT thread on the
 * handover, else open one from the primary stakeholder. Deliberately never
 * targets a group thread — a caller that wants the group must ask for it by id.
 */
async function preferredDirectThreadForHandover(handoverId, orgId, userId) {
  const { rows: [direct] } = await pool.query(
    `SELECT * FROM whatsapp_threads
      WHERE org_id = $1 AND handover_id = $2 AND kind = 'direct' AND status = 'active'
      ORDER BY id LIMIT 1`,
    [orgId, handoverId]
  );
  if (direct) return direct;

  const { rows: [cust] } = await pool.query(
    `SELECT c.phone FROM sales_handover_stakeholders s JOIN contacts c ON c.id = s.contact_id
      WHERE s.handover_id = $1 AND s.org_id = $2 AND c.phone IS NOT NULL
      ORDER BY s.is_primary_contact DESC, s.id LIMIT 1`,
    [handoverId, orgId]
  );
  if (!cust) throw Object.assign(new Error('No stakeholder with a phone number on this handover'), { status: 400 });
  return resolveDirectThreadByPhone(handoverId, orgId, cust.phone, userId);
}

/**
 * List selectable recipients for a handover so the UI can offer a "To" picker:
 *   • one entry per group thread (structural — Cloud API can't deliver to groups
 *     yet, flagged deliverable:false), and
 *   • one entry per reachable individual: customer participants of those groups
 *     plus handover stakeholders with a phone, de-duplicated by number.
 * Each entry carries its own 24-hour window state so the composer can gate
 * free-form text per recipient.
 */
async function listSendTargets(handoverId, orgId) {
  const { rows: threads } = await pool.query(
    `SELECT id, kind, wa_phone, wa_group_id, group_subject, opt_out_at, window_expires_at
       FROM whatsapp_threads
      WHERE org_id = $1 AND handover_id = $2 AND status = 'active'
      ORDER BY id`,
    [orgId, handoverId]
  );

  const groupThreads  = threads.filter(t => t.kind === 'group');
  const directThreads = threads.filter(t => t.kind === 'direct');
  const directByPhone = new Map(directThreads.map(t => [t.wa_phone, t]));

  const targets = [];

  for (const g of groupThreads) {
    targets.push({
      key: `thread:${g.id}`,
      type: 'group',
      threadId: g.id,
      name: g.group_subject || 'Group',
      phone: null,
      windowOpen: waChannel.isWindowOpen(g),
      windowExpiresAt: g.window_expires_at,
      deliverable: false,
      note: 'Group send is not supported by the WhatsApp Cloud API yet.',
    });
  }

  const seen = new Set();
  const addIndividual = (phone, name, contactId) => {
    const p = normalizePhone(phone);
    if (!p || seen.has(p)) return;
    seen.add(p);
    const dt = directByPhone.get(p);
    const v = toWaPhone(phone);
    targets.push({
      key: `phone:${p}`,
      type: 'individual',
      threadId: dt ? dt.id : null,
      name: name || p,
      phone: v.ok ? v.phone : p,
      contactId: contactId ?? null,
      windowOpen: dt ? waChannel.isWindowOpen(dt) : false,
      windowExpiresAt: dt ? dt.window_expires_at : null,
      deliverable: v.ok,
      phoneValid: v.ok,
      phoneIssue: v.ok ? null : v.message,
      optedOut: dt ? !!dt.opt_out_at : false,
    });
  };

  if (groupThreads.length) {
    const { rows: parts } = await pool.query(
      `SELECT wa_phone, display_name, contact_id
         FROM whatsapp_thread_participants
        WHERE org_id = $1 AND side = 'customer' AND left_at IS NULL
          AND thread_id = ANY($2::int[])
        ORDER BY id`,
      [orgId, groupThreads.map(g => g.id)]
    );
    for (const pt of parts) addIndividual(pt.wa_phone, pt.display_name, pt.contact_id);
  }

  const { rows: stake } = await pool.query(
    `SELECT c.phone, c.first_name || ' ' || c.last_name AS full_name, c.id AS contact_id
       FROM sales_handover_stakeholders s JOIN contacts c ON c.id = s.contact_id
      WHERE s.handover_id = $1 AND s.org_id = $2 AND c.phone IS NOT NULL
      ORDER BY s.is_primary_contact DESC, s.id`,
    [handoverId, orgId]
  );
  for (const st of stake) addIndividual(st.phone, st.full_name, st.contact_id);

  for (const dt of directThreads) addIndividual(dt.wa_phone, null, dt.contact_id);

  return { targets };
}

/**
 * Approved WhatsApp templates for this org, pulled live from Meta so the picker
 * can only ever offer templates that will actually send. Variable count is
 * derived from the distinct {{n}} placeholders in the BODY. (Stage 2 will layer
 * org-authored friendly labels from the whatsapp_templates table on top.)
 */
async function listApprovedTemplates(orgId) {
  const account = await waChannel.getAccount(orgId);
  if (!account) return { templates: [] };

  const raw = await waChannel.listTemplates(account);

  // Friendly variable labels the org authored in GoWarm, keyed by name+language.
  const { rows: authored } = await pool.query(
    `SELECT name, language, variable_map FROM whatsapp_templates WHERE org_id = $1`, [orgId]);
  const labelMap = new Map(authored.map(a => [`${a.name}|${a.language}`, a.variable_map || []]));

  const templates = (raw || [])
    .filter(t => t.status === 'APPROVED')
    .map(t => {
      const body = (t.components || []).find(c => c.type === 'BODY');
      const text = body?.text || '';
      const idxs = [...new Set((text.match(/\{\{\s*(\d+)\s*\}\}/g) || [])
        .map(m => m.replace(/[^\d]/g, '')))];
      const n = idxs.length;
      const authoredVars = labelMap.get(`${t.name}|${t.language}`);
      const variables = (authoredVars && authoredVars.length === n)
        ? authoredVars.map(v => ({ label: v.label || `Variable ${v.index}`, placeholder: v.example || '' }))
        : Array.from({ length: n }, (_, i) => ({ label: `Variable ${i + 1}`, placeholder: '' }));
      return { name: t.name, language: t.language, category: t.category, bodyText: text, variables };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { templates };
}

/**
 * Send a message on a handover, to a chosen recipient, and persist it.
 * @param body {
 *   text?, templateName?, templateVars?, templateLanguage?,   // what to send
 *   threadId?,        // send on this exact thread (e.g. the group)
 *   toPhone?          // send 1:1 to this number (a specific person)
 * }
 * With neither threadId nor toPhone, defaults to the handover's direct thread
 * (created from the primary stakeholder if needed) — never a group.
 */
async function sendToHandover(handoverId, orgId, userId, body) {
  const account = await waChannel.getAccount(orgId);
  if (!account) {
    return { ok: false, code: 'NOT_CONNECTED', error: 'WhatsApp is not connected for this org' };
  }

  let thread;
  if (body.threadId) {
    thread = await getThreadById(parseInt(body.threadId, 10), orgId, handoverId);
    if (!thread) {
      return { ok: false, code: 'THREAD_NOT_FOUND', error: 'That conversation was not found on this handover' };
    }
  } else if (body.toPhone) {
    thread = await resolveDirectThreadByPhone(handoverId, orgId, body.toPhone, userId);
  } else {
    thread = await preferredDirectThreadForHandover(handoverId, orgId, userId);
  }

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

      // Template approval/rejection updates (no phone_number_id; keyed by WABA).
      if (change.field === 'message_template_status_update') {
        const org = await orgForWaba(entry.id);
        if (org) {
          try {
            await waTemplates.applyMetaStatusUpdate(org, {
              metaTemplateId: value.message_template_id,
              name: value.message_template_name,
              language: value.message_template_language,
              event: value.event,
              reason: value.reason,
            });
          } catch (e) { console.error('[whatsapp] template status sync error:', e.message); }
        }
        continue;
      }

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
        // Capture cost from Meta's pricing object when present.
        if (s.pricing) {
          try { await recordMessageCost(org, s.id, s.pricing); }
          catch (e) { console.error('[whatsapp] cost capture error:', e.message); }
        }
      }
    }
  }
  return { inbound, statuses };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate and normalise a phone number for WhatsApp (E.164 digits, no '+').
 * Requires an EXPLICIT country code: a bare national number (e.g. a 10-digit
 * Indian mobile) is rejected with MISSING_COUNTRY_CODE so it gets fixed at the
 * contact rather than silently misrouted by Meta. Returns
 *   { ok:true, phone:'9172...' }  or  { ok:false, code, message }.
 */
function toWaPhone(raw) {
  const trimmed = String(raw || '').trim();
  const explicit = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/[^0-9]/g, '').replace(/^0+/, m => (explicit ? '' : m));
  const d = explicit ? digits.replace(/^0+/, '') : digits;
  if (!d)            return { ok: false, code: 'MISSING_PHONE',        message: 'This contact has no phone number.' };
  if (d.length < 8)  return { ok: false, code: 'INVALID_PHONE',        message: 'This phone number is too short to be a valid international number.' };
  if (d.length > 15) return { ok: false, code: 'INVALID_PHONE',        message: 'This phone number is too long to be a valid international number.' };
  // Explicit country code required. Accept if entered with + / 00, or if it is
  // already long enough to include one (>10 digits). Reject a bare ≤10-digit
  // national number.
  if (!explicit && d.length <= 10)
    return { ok: false, code: 'MISSING_COUNTRY_CODE', message: 'Add a country code (e.g. +91) to this contact — it looks like a local number.' };
  return { ok: true, phone: d };
}

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

async function orgForWaba(wabaId) {
  if (!wabaId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT org_id FROM org_whatsapp_accounts WHERE waba_id = $1 AND status = 'active'`,
    [String(wabaId)]
  );
  return row ? row.org_id : null;
}

// Rough recipient-country from an E.164 number. Extend as more markets are used.
function countryFromPhone(waPhone) {
  const p = String(waPhone || '');
  if (p.startsWith('91')) return 'IN';
  return 'DEFAULT';
}

/**
 * Record/settle the cost of an outbound message from a Meta status webhook's
 * `pricing` object. Idempotent per (org, wa_message_id) — later statuses
 * (sent → delivered) update the same row. Only called when pricing is present.
 */
async function recordMessageCost(orgId, waMessageId, pricing) {
  if (!pricing || !waMessageId) return;
  const category = String(pricing.category || '').toLowerCase() || 'utility';
  const billable = pricing.billable !== false; // default true unless Meta says false

  const { rows: [msg] } = await pool.query(
    `SELECT m.id, m.thread_id, t.wa_phone, t.kind
       FROM whatsapp_messages m LEFT JOIN whatsapp_threads t ON t.id = m.thread_id
      WHERE m.org_id = $1 AND m.wa_message_id = $2`,
    [orgId, waMessageId]);
  const country = countryFromPhone(msg?.wa_phone);

  const { rows: [rate] } = await pool.query(
    `SELECT amount, currency FROM whatsapp_rates
      WHERE category = $1 AND country IN ($2, 'DEFAULT')
      ORDER BY (country = $2) DESC, effective_from DESC LIMIT 1`,
    [category, country]);
  const metaCost = billable ? Number(rate?.amount ?? 0) : 0;
  const currency = rate?.currency ?? 'INR';

  const { rows: [cfg] } = await pool.query(
    `SELECT billing_mode, markup_pct, currency FROM whatsapp_billing_config WHERE org_id = $1`, [orgId]);
  const billed = (cfg?.billing_mode === 'provider_rebill')
    ? metaCost * (1 + Number(cfg.markup_pct || 0) / 100) : 0;

  await pool.query(
    `INSERT INTO whatsapp_message_costs
       (org_id, message_id, wa_message_id, thread_id, group_thread_id, category, audience,
        pricing_model, billable, recipient_country, meta_cost_amount, meta_cost_currency,
        billed_amount, billed_currency)
     VALUES ($1,$2,$3,$4,$5,$6,'any',$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (org_id, wa_message_id) DO UPDATE SET
       category = EXCLUDED.category, pricing_model = EXCLUDED.pricing_model,
       billable = EXCLUDED.billable, recipient_country = EXCLUDED.recipient_country,
       meta_cost_amount = EXCLUDED.meta_cost_amount, meta_cost_currency = EXCLUDED.meta_cost_currency,
       billed_amount = EXCLUDED.billed_amount, billed_currency = EXCLUDED.billed_currency`,
    [orgId, msg?.id ?? null, waMessageId, msg?.thread_id ?? null,
     msg?.kind === 'group' ? msg?.thread_id ?? null : null,
     category, pricing.pricing_model || null, billable, country,
     metaCost, currency, billed, cfg?.currency || currency]);
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
  listSendTargets,
  listApprovedTemplates,
  sendToHandover,
  listMessages,
  verifyChallenge,
  verifySignature,
  ingestWebhook,
};
