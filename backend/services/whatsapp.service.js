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
const bindings = require('./conversationBindings.service');

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
       FROM project_contacts s
       JOIN contacts c ON c.id = s.contact_id
      WHERE s.context_type = 'handover' AND s.context_id = $1 AND s.org_id = $2 AND c.phone IS NOT NULL
        -- Customer side only. Before 2026_93 every project contact WAS a
        -- customer contact, so no filter was needed. Now a vendor or partner on
        -- the project would be eligible to become the project's DEFAULT
        -- WhatsApp recipient — which is how a customer-facing update reaches a
        -- subcontractor. Explicit sends to a vendor still work; see
        -- resolveDirectThreadByPhone and listSendTargets.
        AND s.side = 'customer'
      ORDER BY s.is_primary DESC, s.id
      LIMIT 1`,
    [handoverId, orgId]
  );
  if (!cust) {
    throw Object.assign(new Error('No customer contact with a phone number on this project. Internal team members can be picked as recipients, but are never messaged automatically.'), { status: 400 });
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

  // A GROUP belongs to one project — refuse rather than steal it.
  //
  // A DIRECT thread does not: one person has exactly one 1:1 chat, and they may
  // be on several projects. Refusing here made a by-id send to a shared contact
  // fail with THREAD_NOT_FOUND from the second project. The thread's own
  // handover_id is left alone (it still records who owns the conversation); the
  // MESSAGE carries the project it was sent for — see sendToHandover.
  if (handoverId != null && t.kind === 'group' &&
      t.handover_id != null && t.handover_id !== handoverId) return null;

  // Belongs to NO project — adopt it, exactly as resolveDirectThreadByPhone
  // does. Without this, sending to an existing thread by id left it orphaned:
  // the message went out, but the conversation stayed invisible in the
  // project's Communications tab, which reads by handover_id.
  //
  // UNLESS the thread is entity-scoped, where null is a decision rather than an
  // orphan. Adopting a vendor group because somebody sent one message into it
  // would restore exactly the stale thread project the bind removed. The send
  // itself still goes out and the MESSAGE still carries its project.
  if (handoverId != null && t.handover_id == null && !(await threadIsEntityBound(orgId, t))) {
    await pool.query(
      `UPDATE whatsapp_threads SET handover_id = $1, updated_at = now() WHERE id = $2`,
      [handoverId, t.id]
    );
    t.handover_id = handoverId;
  }
  return t;
}

/**
 * Is this thread ENTITY-scoped — organised around who is in it rather than
 * around a project?
 *
 * WHY EVERY THREAD-PROJECT WRITE HAS TO ASK
 *   Phase 1 deliberately leaves whatsapp_threads.handover_id NULL on a vendor
 *   or pool thread, and there are four code paths that treat a null thread
 *   project as an orphan to be adopted: a send resolved by thread id, a manual
 *   link, and the two "move the whole conversation" paths. Without this check
 *   each of them silently reinstates the stale project the bind just removed,
 *   and the group reappears on that project's Communications tab with its
 *   attachments flowing into that project's folder.
 *
 *   Null on an entity thread is a DECISION, not a gap. This is the function
 *   that lets the rest of the code tell the difference.
 *
 * Takes the thread row (needs kind + wa_group_id/wa_phone). Fails closed to
 * `false` — a lookup error must not block a legitimate send.
 */
async function threadIsEntityBound(orgId, thread) {
  const threadRef = thread?.kind === 'group' ? thread?.wa_group_id : thread?.wa_phone;
  if (!threadRef) return false;
  try {
    return await bindings.isEntityBound(orgId, 'whatsapp', threadRef);
  } catch (err) {
    console.warn(`[whatsapp] binding lookup failed for thread ${thread?.id}: ${err.message}`);
    return false;
  }
}

/**
 * Which single active project does this phone number belong to?
 *
 * Used to link an INBOUND conversation on arrival. Matches BOTH sides of a
 * project: contacts (customers, vendors, partners) and members (the internal
 * team) — the members half matters because on an internal project there are no
 * contacts at all, which is how a colleague's message became an orphan.
 *
 * Returns null unless there is EXACTLY ONE match. A number on two projects is
 * ambiguous, and guessing would put a customer's messages on the wrong project
 * — worse than leaving it unlinked, because unlinked is visible and fixable
 * while wrong is neither.
 */
/**
 * Attach a conversation to a project by hand.
 *
 * The backstop for what inference deliberately will not guess: an unknown
 * number, or one that matches two projects. Refuses to move a thread that
 * already belongs elsewhere unless asked explicitly, so a mis-click cannot
 * silently relocate a customer's history.
 */
async function linkThreadToProject(threadId, orgId, handoverId, { force = false } = {}) {
  const { rows: [t] } = await pool.query(
    `SELECT id, kind, wa_group_id, wa_phone, handover_id
       FROM whatsapp_threads WHERE id = $1 AND org_id = $2`,
    [threadId, orgId]
  );
  if (!t) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  // An entity-scoped conversation has no project ON PURPOSE. Linking it to one
  // here would put every future message in it back on a single project via the
  // thread fallback — the misfile the binding exists to prevent. `force` does
  // not override this: the way to make a vendor group belong to one project is
  // to rebind it as a project group, which is a decision with its own guard and
  // its own audit trail.
  if (await threadIsEntityBound(orgId, t)) {
    throw Object.assign(
      new Error('This conversation is organised around a vendor or a set of projects, not one project. Change how the group is bound if that is what you want, or file individual messages.'),
      { status: 409, code: 'ENTITY_BOUND' });
  }

  if (t.handover_id != null && t.handover_id !== handoverId && !force) {
    throw Object.assign(
      new Error('That conversation is already on another project. Move it explicitly if that is what you want.'),
      { status: 409, currentHandoverId: t.handover_id });
  }
  const { rows: [updated] } = await pool.query(
    `UPDATE whatsapp_threads SET handover_id = $1, updated_at = now()
      WHERE id = $2 AND org_id = $3 RETURNING id, handover_id, wa_phone`,
    [handoverId, threadId, orgId]
  );
  return { thread: updated };
}

/**
 * Which projects could this message reasonably belong to?
 *
 * Deliberately NOT "every project in the org". The realistic mistakes are
 * between the handful of projects this conversation actually touches, and a
 * flat list of 200 projects is how a message ends up somewhere worse than
 * where it started. Candidates are:
 *   • the project the message is on now,
 *   • the project that owns the conversation,
 *   • every project any message on this thread has been filed under, and
 *   • every open project this phone number is a contact or member on.
 *
 * Filtered to projects the caller can actually file on, so the picker cannot
 * offer somewhere they are not allowed to put it.
 */
async function listMoveTargets(messageId, orgId, userId) {
  const projectFiles = require('./projectFiles.service');

  const { rows: [msg] } = await pool.query(
    `SELECT m.id, m.handover_id, m.handover_source, m.direction, m.thread_id,
            t.handover_id AS thread_handover_id, t.wa_phone
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
      WHERE m.id = $1 AND m.org_id = $2`,
    [messageId, orgId]
  );
  if (!msg) throw Object.assign(new Error('Message not found'), { status: 404 });

  const digits = normalizePhone(msg.wa_phone);
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT DISTINCT handover_id FROM whatsapp_messages
        WHERE org_id = $1 AND thread_id = $2 AND handover_id IS NOT NULL
       UNION
       SELECT $3::int WHERE $3::int IS NOT NULL
       UNION
       SELECT h.id
         FROM sales_handovers h
         LEFT JOIN project_contacts pc
                ON pc.context_type = 'handover' AND pc.context_id = h.id AND pc.org_id = h.org_id
         LEFT JOIN contacts c ON c.id = pc.contact_id
         LEFT JOIN project_members pm
                ON pm.context_type = 'handover' AND pm.context_id = h.id
               AND pm.org_id = h.org_id AND pm.status = 'approved'
         LEFT JOIN users u ON u.id = pm.user_id
        WHERE h.org_id = $1
          AND h.status NOT IN ('completed', 'cancelled')
          AND $4::text <> ''
          AND ( regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $4
             OR regexp_replace(COALESCE(u.whatsapp_phone, u.phone, ''), '[^0-9]', '', 'g') = $4 )
     )
     SELECT h.id AS handover_id, COALESCE(h.name, d.name) AS name,
            a.name AS account, h.status
       FROM candidates cd
       JOIN sales_handovers h ON h.id = cd.handover_id AND h.org_id = $1
       LEFT JOIN deals d ON d.id = h.deal_id
       LEFT JOIN accounts a ON a.id = h.account_id
      ORDER BY name NULLS LAST, h.id`,
    [orgId, msg.thread_id, msg.thread_handover_id ?? null, digits || '']
  );

  const targets = [];
  for (const r of rows) {
    if (!(await projectFiles.canFile(r.handover_id, orgId, userId))) continue;
    targets.push({
      handoverId: r.handover_id,
      name: r.name || `Project ${r.handover_id}`,
      account: r.account || null,
      status: r.status,
      isCurrent: r.handover_id === msg.handover_id,
      ownsConversation: r.handover_id === msg.thread_handover_id,
    });
  }

  return {
    message: {
      id: msg.id,
      direction: msg.direction,
      handoverId: msg.handover_id ?? null,
      handoverSource: msg.handover_source ?? null,
      threadId: msg.thread_id,
    },
    targets,
  };
}

/**
 * Move one WhatsApp message to another project by hand.
 *
 * The backstop for what inference gets wrong, and the counterpart to
 * linkThreadToProject — that moves the CONVERSATION, this moves a MESSAGE.
 *
 * scope:
 *   'message' (default) — this row only.
 *   'thread'            — this row plus every other message on the thread
 *                         currently filed under the same project, and the
 *                         conversation's owner. For "this whole exchange is on
 *                         the wrong project", which is the usual case once a
 *                         reply has already been misfiled.
 *
 * Authority: the caller must be able to file on the DESTINATION, and on the
 * message's CURRENT project when it has one. Requiring both is the point —
 * without the second check, anyone could pull a message out of a project they
 * are not on and cannot see.
 *
 * The move is stamped handover_source='manual' with handover_tagged_at, which
 * is what makes it outrank inference for the replies that follow. See
 * resolveInboundHandover.
 */
async function moveMessage(messageId, orgId, userId, { handoverId, scope = 'message' } = {}) {
  if (!handoverId) throw Object.assign(new Error('handoverId is required'), { status: 400 });
  if (!['message', 'thread'].includes(scope)) {
    throw Object.assign(new Error("scope must be 'message' or 'thread'"), { status: 400 });
  }
  const projectFiles = require('./projectFiles.service');

  const { rows: [msg] } = await pool.query(
    `SELECT m.id, m.handover_id, m.thread_id, t.handover_id AS thread_handover_id,
            t.kind, t.wa_group_id, t.wa_phone
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
      WHERE m.id = $1 AND m.org_id = $2`,
    [messageId, orgId]
  );
  if (!msg) throw Object.assign(new Error('Message not found'), { status: 404 });

  // On an entity-scoped thread the MESSAGES still move — filing by hand is the
  // whole fallback Phase 1 relies on — but the thread's own project is not
  // written. Setting it would reinstate the stale project the bind removed and
  // make every later message in the vendor group inherit it silently.
  const entityScoped = await threadIsEntityBound(orgId, msg);

  const { rows: [dest] } = await pool.query(
    `SELECT id FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
  if (!dest) throw Object.assign(new Error('Destination project not found'), { status: 404 });

  await projectFiles.assertCanFile(handoverId, orgId, userId);
  if (msg.handover_id != null && msg.handover_id !== handoverId) {
    await projectFiles.assertCanFile(msg.handover_id, orgId, userId);
  }

  if (msg.handover_id === handoverId && scope === 'message') {
    return { moved: 0, alreadyThere: true, handoverId, scope };
  }

  // Which rows move. For 'thread', every message currently filed the same way
  // as this one — including the ones with no project at all, which are the
  // orphans this is most often used to rescue.
  const { rows: moved } = await pool.query(
    scope === 'thread'
      ? `UPDATE whatsapp_messages
            SET handover_id = $3, handover_source = 'manual',
                handover_tagged_by = $4, handover_tagged_at = now()
          WHERE org_id = $1 AND thread_id = $2
            AND handover_id IS NOT DISTINCT FROM $5
          RETURNING id`
      : `UPDATE whatsapp_messages
            SET handover_id = $3, handover_source = 'manual',
                handover_tagged_by = $4, handover_tagged_at = now()
          WHERE org_id = $1 AND thread_id = $2 AND id = $5
          RETURNING id`,
    scope === 'thread'
      ? [orgId, msg.thread_id, handoverId, userId, msg.handover_id]
      : [orgId, msg.thread_id, handoverId, userId, messageId]
  );

  let conversationMoved = false;
  if (scope === 'thread' && !entityScoped) {
    const { rowCount } = await pool.query(
      `UPDATE whatsapp_threads SET handover_id = $1, updated_at = now()
        WHERE id = $2 AND org_id = $3`,
      [handoverId, msg.thread_id, orgId]
    );
    conversationMoved = rowCount > 0;
  }

  return {
    moved: moved.length,
    handoverId,
    fromHandoverId: msg.handover_id ?? null,
    scope,
    conversationMoved,
    // The messages moved; the conversation deliberately did not. Surfaced so
    // the UI can say "filed 14 messages — the group itself still covers several
    // projects" rather than implying the whole group was reassigned.
    entityScoped,
  };
}

async function projectForPhone(orgId, waPhone) {
  const digits = normalizePhone(waPhone);
  if (!digits) return null;

  const { rows } = await pool.query(
    `SELECT DISTINCT h.id
       FROM sales_handovers h
       LEFT JOIN project_contacts pc
              ON pc.context_type = 'handover' AND pc.context_id = h.id AND pc.org_id = h.org_id
       LEFT JOIN contacts c ON c.id = pc.contact_id
       LEFT JOIN project_members pm
              ON pm.context_type = 'handover' AND pm.context_id = h.id
             AND pm.org_id = h.org_id AND pm.status = 'approved'
       LEFT JOIN users u ON u.id = pm.user_id
      WHERE h.org_id = $1
        AND h.status NOT IN ('completed', 'cancelled')
        AND ( regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $2
           OR regexp_replace(COALESCE(u.whatsapp_phone, u.phone, ''), '[^0-9]', '', 'g') = $2 )
      LIMIT 2`,
    [orgId, digits]
  );
  return rows.length === 1 ? rows[0].id : null;
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
    // Null here is a DECISION when the thread is entity-bound — a 1:1 with a
    // vendor contact covers several projects and belongs to none. Adopting it
    // because somebody sent one message would reinstate exactly the project
    // link the bind removed, and every later reply would inherit it through the
    // thread fallback. The send still goes out; the MESSAGE still carries its
    // own project.
    if (existing.handover_id == null && !(await threadIsEntityBound(orgId, existing))) {
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
    `SELECT c.id FROM project_contacts s JOIN contacts c ON c.id = s.contact_id
      WHERE s.context_type = 'handover' AND s.context_id = $1 AND s.org_id = $2
        AND regexp_replace(c.phone, '[^0-9]', '', 'g') = $3
      LIMIT 1`,
    [handoverId, orgId, waPhone]
  );

  const { rows: [thread] } = await pool.query(
    `INSERT INTO whatsapp_threads
       (org_id, kind, wa_phone, handover_id, deal_id, account_id, contact_id, status, created_by)
     VALUES ($1, 'direct', $2, $3, $4, $5, $6, 'active', $7)
     -- COALESCE, not overwrite. This branch is only reached when the SELECT
     -- above found nothing, so a conflict here means a concurrent insert won
     -- the race — and unconditionally taking EXCLUDED.handover_id would clobber
     -- whatever that insert decided, including a deliberate NULL on an
     -- entity-bound thread. Preferring the existing value keeps the winner's
     -- decision and still fills in a genuinely empty link.
     ON CONFLICT (org_id, wa_phone) WHERE kind = 'direct'
       DO UPDATE SET handover_id = COALESCE(whatsapp_threads.handover_id, EXCLUDED.handover_id),
                     updated_at = now()
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
    `SELECT c.phone FROM project_contacts s JOIN contacts c ON c.id = s.contact_id
      WHERE s.context_type = 'handover' AND s.context_id = $1 AND s.org_id = $2 AND c.phone IS NOT NULL
        AND s.side = 'customer'   -- implicit default recipient; see getThreadForHandover
      ORDER BY s.is_primary DESC, s.id LIMIT 1`,
    [handoverId, orgId]
  );
  if (!cust) throw Object.assign(new Error('No customer contact with a phone number on this project'), { status: 400 });
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
    `SELECT id, kind, source, wa_phone, wa_group_id, group_subject, opt_out_at, window_expires_at
       FROM whatsapp_threads
      WHERE org_id = $1 AND handover_id = $2 AND status = 'active'
      ORDER BY id`,
    [orgId, handoverId]
  );

  // Session-captured groups are OBSERVED, not owned: wa_group_id holds a
  // WhatsApp JID, not a Meta Groups API id, and there is no Cloud API path to
  // send into them. Offering one here produces a confusing failure at send
  // time instead of an honest absence at pick time.
  const groupThreads  = threads.filter(t => t.kind === 'group' && t.source !== 'session');
  const directThreads = threads.filter(t => t.kind === 'direct');

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
      deliverable: true,
      note: 'Sends to the whole group. Free-form needs an open window; otherwise an approved template. Interactive templates are not supported in groups.',
    });
  }

  const seen = new Set();
  const addIndividual = (phone, name, contactId, side = null) => {
    const p = normalizePhone(phone);
    if (!p || seen.has(p)) return;
    seen.add(p);
    const v = toWaPhone(phone);
    targets.push({
      key: `phone:${p}`,
      type: 'individual',
      // Conversation state (threadId, window, opt-out) is filled in below from
      // the person's ONE direct thread, which may belong to another project.
      threadId: null,
      name: name || p,
      phone: v.ok ? v.phone : p,
      contactId: contactId ?? null,
      // Which side of the project this person is on, so the picker can say
      // "Vendor" instead of leaving the sender to guess. NOT filtered out —
      // messaging a vendor deliberately is fine; having one selected for you
      // is not.
      side: side ?? null,
      windowOpen: false,
      windowExpiresAt: null,
      deliverable: v.ok,
      phoneValid: v.ok,
      phoneIssue: v.ok ? null : v.message,
      optedOut: false,
      conversationHandoverId: null,
      windowFromOtherProject: false,
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
    for (const pt of parts) addIndividual(pt.wa_phone, pt.display_name, pt.contact_id, 'customer');
  }

  const { rows: stake } = await pool.query(
    `SELECT c.phone, c.first_name || ' ' || c.last_name AS full_name, c.id AS contact_id, s.side
       FROM project_contacts s JOIN contacts c ON c.id = s.contact_id
      WHERE s.context_type = 'handover' AND s.context_id = $1 AND s.org_id = $2 AND c.phone IS NOT NULL
      ORDER BY (s.side = 'customer') DESC, s.is_primary DESC, s.id`,
    [handoverId, orgId]
  );
  for (const st of stake) addIndividual(st.phone, st.full_name, st.contact_id, st.side || 'customer');

  // ── Internal team members ──
  //
  // project_members, NOT project_contacts. The picker only ever knew about
  // contacts, which predates internal projects entirely — so on a project whose
  // team is users, every phone number added to a user was invisible here and
  // the composer said "No reachable recipients yet" while the numbers sat
  // correctly in the database.
  //
  // PICKER ONLY. Added AFTER the customer contacts above, and the `seen` set
  // means a customer contact already listed wins. They are labelled 'internal'
  // so the sender can see who they are writing to, and they are deliberately
  // absent from getThreadForHandover / preferredDirectThreadForHandover — the
  // two paths that pick a recipient FOR you. Auto-selecting a colleague as a
  // project's default WhatsApp recipient is how a customer-facing update goes
  // to the wrong person.
  //
  // whatsapp_phone wins over phone when set; that is what the column is for.
  const { rows: members } = await pool.query(
    `SELECT COALESCE(NULLIF(u.whatsapp_phone, ''), u.phone) AS phone,
            (u.first_name || ' ' || u.last_name) AS full_name
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.context_type = 'handover' AND pm.context_id = $1 AND pm.org_id = $2
        AND pm.status = 'approved'
        AND COALESCE(NULLIF(u.whatsapp_phone, ''), u.phone) IS NOT NULL
      ORDER BY full_name`,
    [handoverId, orgId]
  );
  for (const mb of members) addIndividual(mb.phone, mb.full_name, null, 'internal');

  // On a project derived from a deal, the internal team is deal_team_members —
  // a different table from project_members, and previously invisible here. Same
  // 'internal' side: selectable, labelled, never an implicit default.
  const { rows: dealTeam } = await pool.query(
    `SELECT COALESCE(NULLIF(u.whatsapp_phone, ''), u.phone) AS phone,
            (u.first_name || ' ' || u.last_name) AS full_name
       FROM sales_handovers h
       JOIN deal_team_members dtm ON dtm.deal_id = h.deal_id AND dtm.org_id = h.org_id
       JOIN users u ON u.id = dtm.user_id
      WHERE h.id = $1 AND h.org_id = $2
        AND COALESCE(NULLIF(u.whatsapp_phone, ''), u.phone) IS NOT NULL
      ORDER BY full_name`,
    [handoverId, orgId]
  );
  for (const dt of dealTeam) addIndividual(dt.phone, dt.full_name, null, 'internal');

  for (const dt of directThreads) addIndividual(dt.wa_phone, null, dt.contact_id);

  // ── Conversation state belongs to the PERSON, not to the project ──
  //
  // uq_wa_threads_direct means one direct thread per number per org, exactly as
  // WhatsApp itself works: there is ONE chat with a given number. The 24-hour
  // service window, the opt-out flag and the message history are properties of
  // that chat.
  //
  // This used to be read from the threads WHERE handover_id = this project. A
  // person on two projects has their single thread owned by whichever project
  // touched it first, so from the SECOND project the lookup found nothing and
  // reported windowOpen:false — the composer then demanded a template even
  // though the window was wide open and a free-form send would have succeeded
  // (the adapter checks the real thread, not this). Same bug hid an opt-out:
  // someone who opted out via project A looked contactable from project B.
  //
  // So: resolve by phone, org-wide. `conversationHandoverId` lets the UI say
  // where the conversation currently lives without changing who can send.
  const phones = targets
    .filter(t => t.type === 'individual' && t.phone)
    .map(t => normalizePhone(t.phone))
    .filter(Boolean);

  if (phones.length) {
    const { rows: convos } = await pool.query(
      `SELECT id, wa_phone, opt_out_at, window_expires_at, handover_id
         FROM whatsapp_threads
        WHERE org_id = $1 AND kind = 'direct' AND wa_phone = ANY($2::text[])`,
      [orgId, phones]
    );
    const byPhone = new Map(convos.map(c => [c.wa_phone, c]));
    for (const t of targets) {
      if (t.type !== 'individual') continue;
      const c = byPhone.get(normalizePhone(t.phone));
      if (!c) continue;
      t.threadId               = c.id;
      t.windowOpen             = waChannel.isWindowOpen(c);
      t.windowExpiresAt        = c.window_expires_at;
      t.optedOut               = !!c.opt_out_at;
      t.conversationHandoverId = c.handover_id ?? null;
      t.windowFromOtherProject =
        t.windowOpen && c.handover_id != null && c.handover_id !== handoverId;
    }
  }

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
        template_id, sent_by_user_id, is_automated, status, sent_at, handover_id,
        handover_source)
     VALUES ($1, $2, $3, 'outbound', $4, $5, NULL, $6, false, 'sent', now(), $7, 'send')
     RETURNING id, status, created_at`,
    // handoverId, not thread.handover_id. One person has ONE direct thread, so
    // messaging them from a second project necessarily reuses the thread the
    // first project owns. Stamping the thread's project would file this message
    // under the wrong one — which is exactly the bug this fixes.
    [orgId, thread.id, result.wamid || null, template ? 'template' : 'text',
     template ? `[template:${template.name}]` : text.body, userId, handoverId ?? null]
  );

  return { ok: true, wamid: result.wamid || null, message: msg, threadId: thread.id };
}

async function listMessages(handoverId, orgId) {
  const thread = await getThreadForHandover(handoverId, orgId, { createIfMissing: false });

  // Message-level attribution WINS; the thread's project is only the fallback
  // for messages that never got one. Reading by thread alone showed a shared
  // contact's whole history under the project that happens to own the
  // conversation, and nothing at all under the other one.
  const { rows } = await pool.query(
    `SELECT m.id, m.direction, m.message_type, m.body, m.status, m.from_name,
            m.is_automated, m.sent_at, m.delivered_at, m.read_at, m.created_at,
            m.thread_id, m.handover_source
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
      WHERE m.org_id = $2
        AND ( m.handover_id = $1
           OR (m.handover_id IS NULL AND t.handover_id = $1) )
      ORDER BY m.created_at ASC`,
    [handoverId, orgId]
  );

  if (!thread) return { thread: null, windowOpen: false, messages: rows };
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
        // Meta stamps GROUP messages with `group_id`; 1:1 messages have none.
        // Route each to the correct thread so group chatter consolidates into
        // one auditable group thread instead of scattering into per-participant
        // direct threads — and so the AFTER-INSERT window trigger refreshes the
        // GROUP thread's window (this is what keeps a busy group's service
        // window open from member activity).
        const thread = m.group_id
          ? await threadForInboundGroup(org, m.group_id, m.from, value)
          : await threadForInbound(org, m.from, value);
        if (!thread) continue;
        // ── Attachment identity ──
        //
        // The webhook payload is the ONLY place a media id ever appears, and
        // this used to write `[document]` and drop the whole object with it.
        // The number is registered to the Cloud API, so it cannot also be used
        // in the consumer or Business app — there is no inbox anywhere. Once
        // the webhook is processed without keeping the id, nobody on the team
        // can obtain that file by any route.
        //
        // Meta's download URL expires in minutes but the ID stays valid for the
        // full ~30-day retention, so keeping it is what makes a fetch (and a
        // retry after a failed one) possible at all.
        const media = m.image || m.document || m.video || m.audio || m.sticker || null;

        // Prefer the caption a person actually wrote over a `[image]`
        // placeholder — it is usually the only description of the attachment.
        const bodyText =
          m.text?.body
          ?? media?.caption
          ?? (media?.filename ? `[${m.type}] ${media.filename}` : `[${m.type}]`);

        // Which project this reply is about — NOT simply the thread's project.
        const attribution = await resolveInboundHandover(org, thread, m);

        const res = await pool.query(
          `INSERT INTO whatsapp_messages
             (org_id, thread_id, wa_message_id, direction, message_type, body,
              from_phone, from_name, status, sent_at,
              wa_media_id, media_mime_type, media_sha256, media_filename, media_caption,
              media_status, media_expires_at, handover_id,
              handover_source, reply_to_wa_message_id)
           VALUES ($1,$2,$3,'inbound',$4,$5,$6,$7,'received', to_timestamp($8),
                   $9,$10,$11,$12,$13,
                   -- 'pending' only when there is something to fetch, so plain
                   -- text messages are not swept looking for attachments.
                   CASE WHEN $9::text IS NULL THEN NULL ELSE 'pending' END,
                   CASE WHEN $9::text IS NULL THEN NULL ELSE now() + interval '30 days' END,
                   -- Inbound has no project of its own: it belongs to whatever
                   -- prompted it. See resolveInboundHandover.
                   $14, $15, $16)
           ON CONFLICT (org_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [org, thread.id, m.id, m.type || 'text', bodyText, m.from,
           contactNameFromValue(value, m.from), Number(m.timestamp) || (Date.now() / 1000),
           media?.id || null, media?.mime_type || null, media?.sha256 || null,
           media?.filename || null, media?.caption || null,
           attribution.handoverId, attribution.source, attribution.replyToWamid]
        );
        if (res.rowCount > 0) {
          inbound++;   // window opens via the touch trigger

          // Queue the attachment immediately. Meta's download URL lives
          // minutes, so this cannot wait for the next sweep — the sweep exists
          // only to catch what the queue drops. Lazy require avoids a
          // load-time cycle, and enqueue never throws: a queueing failure must
          // not roll back the webhook and make Meta redeliver.
          if (media?.id) {
            const { enqueue } = require('../jobs/whatsappMediaJob');
            await enqueue(org, res.rows?.[0]?.id ?? null);
          }
        }
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

/**
 * Which PROJECT does this inbound message belong to?
 *
 * The thread says who owns the conversation; it does not say what a given reply
 * is about. One person has one direct thread, so if they are on projects A and
 * B, the thread is owned by whichever project spoke first — and inheriting the
 * thread's project filed every reply under A, including the reply to a template
 * that project B had just sent. That is the misfiling this resolves.
 *
 * Precedence, most authoritative first:
 *   1. `context.id` — the customer tapped Reply on a specific message. Meta
 *      tells us exactly which one, so there is nothing to infer. If a person
 *      MOVED that message, the reply follows it: the move is already baked into
 *      the message's handover_id.
 *   2. The freshest steering signal on this thread in the last 24 hours,
 *      whichever of these two happened later:
 *        • an outbound send  (a project spoke; the reply answers it), or
 *        • a manual move     (a person said this conversation is about X).
 *      Compared on when each ACTION happened — sent_at vs handover_tagged_at —
 *      because a correction made today must outrank the send that caused the
 *      mistake yesterday. Without that, a rep would fix the same misfiling
 *      after every single reply.
 *   3. The thread's own project — a cold message, months later, or a thread
 *      only ever used by one project. The old behaviour, now the fallback.
 *
 * Note what is deliberately NOT here: moving an INBOUND message on its own is
 * still a steering signal (rule 2), but moving an OUTBOUND one is stronger,
 * because it also changes what rule 1 resolves to.
 *
 * Returns { handoverId, source } where source is stored for provenance, so a
 * message that lands on the wrong project can be explained rather than guessed
 * at. Requires db/2026_99 and db/2026_100.
 */
async function resolveInboundHandover(orgId, thread, m) {
  const replyToWamid = m?.context?.id || null;

  // ── the fork (Phase 1) ──────────────────────────────────────────────────
  //
  // An ENTITY-scoped thread — a vendor group, an internal pool group — runs
  // rule 1 and then stops. Both of the remaining rules are actively wrong there:
  //
  //   Rule 2's outbound leg is ALREADY DEAD for a captured group: nobody sends
  //   from a project into a personal WhatsApp group. What survives is a bare
  //   decaying pointer with nothing able to contradict it, which is exactly
  //   what misfiles at every topic switch.
  //
  //   Rule 3's thread project is null by construction on an entity thread, or
  //   stale if the group was previously bound to one project.
  //
  // So an entity-scoped message lands UNASSIGNED unless it is a quoted reply.
  // That is the intended outcome, not a gap: a misfiled message is worse than
  // an unfiled one, because nobody audits the project they did not expect it
  // in. Phase 4 reduces the volume; Phase 1 makes it visible.
  //
  // No binding row means LEGACY — every group already in the system keeps
  // today's behaviour exactly.
  const threadRef = thread?.kind === 'group' ? thread?.wa_group_id : thread?.wa_phone;
  let entityScoped = false;
  if (threadRef) {
    try {
      entityScoped = await bindings.isEntityBound(orgId, 'whatsapp', threadRef);
    } catch (err) {
      // Fail OPEN to today's chain rather than dropping attribution entirely:
      // a lookup failure must not silently unassign a project group's traffic.
      console.warn(`[whatsapp] binding lookup failed for thread ${thread?.id}: ${err.message}`);
    }
  }

  if (replyToWamid) {
    const { rows: [ctx] } = await pool.query(
      `SELECT handover_id FROM whatsapp_messages
        WHERE org_id = $1 AND wa_message_id = $2 AND handover_id IS NOT NULL
        LIMIT 1`,
      [orgId, String(replyToWamid)]
    );
    if (ctx) return { handoverId: ctx.handover_id, source: 'reply_context', replyToWamid };
  }

  // Rule 1 did not fire and this thread is organised around who is in it, not
  // around a project. Stop rather than guess.
  if (entityScoped) return { handoverId: null, source: null, replyToWamid };

  const ts = Number(m?.timestamp) || (Date.now() / 1000);
  // One query, two candidate signals, ordered by when each ACT happened. A
  // manual move is dated by handover_tagged_at; an outbound by when it was
  // sent. Both are capped at the inbound's own timestamp so a redelivered
  // webhook cannot be attributed by something that happened afterwards.
  const { rows: [signal] } = await pool.query(
    `SELECT handover_id,
            CASE WHEN handover_source = 'manual' THEN 'manual_recent'
                 ELSE 'recent_outbound' END AS source
       FROM whatsapp_messages
      WHERE org_id = $1 AND thread_id = $2 AND handover_id IS NOT NULL
        AND ( direction = 'outbound' OR handover_source = 'manual' )
        AND COALESCE(
              CASE WHEN handover_source = 'manual' THEN handover_tagged_at END,
              sent_at, created_at
            ) BETWEEN to_timestamp($3) - interval '24 hours' AND to_timestamp($3)
      ORDER BY COALESCE(
                 CASE WHEN handover_source = 'manual' THEN handover_tagged_at END,
                 sent_at, created_at
               ) DESC, id DESC
      LIMIT 1`,
    [orgId, thread.id, ts]
  );
  if (signal) return { handoverId: signal.handover_id, source: signal.source, replyToWamid };

  return { handoverId: thread.handover_id ?? null, source: 'thread', replyToWamid };
}

/** Find (or open) the direct thread an inbound message belongs to. */
async function threadForInbound(orgId, fromPhone, value) {
  const waPhone = normalizePhone(fromPhone);
  // An inbound conversation used to be created with no project at all, so it
  // never appeared in any Communications tab — that reads by handover_id. Only
  // an OUTBOUND send from a project ever linked a thread, which meant anyone
  // who messaged in first was invisible.
  const inferredHandoverId = await projectForPhone(orgId, waPhone);
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM whatsapp_threads WHERE org_id = $1 AND kind = 'direct' AND wa_phone = $2 LIMIT 1`,
    [orgId, waPhone]
  );
  if (existing) {
    // Adopt an orphan we can now identify — e.g. the number was added to a
    // project after this conversation started. Never overwrite an existing
    // link: the thread already belongs somewhere.
    // THE GUARD THAT MATTERS MOST for direct threads. Without it, binding a
    // vendor 1:1 to an account is undone by the vendor's very next reply:
    // projectForPhone finds the contact on a project and re-links the thread,
    // silently restoring the misfile the bind existed to stop. Null on an
    // entity-bound thread is a decision, not an orphan.
    if (existing.handover_id == null && inferredHandoverId
        && !(await threadIsEntityBound(orgId, existing))) {
      await pool.query(
        `UPDATE whatsapp_threads SET handover_id = $1, updated_at = now() WHERE id = $2`,
        [inferredHandoverId, existing.id]
      );
      existing.handover_id = inferredHandoverId;
    }
    return existing;
  }

  // Genuinely unknown sender — open an UNLINKED thread rather than dropping the
  // message. It can be attached to a project from the UI later.
  const { rows: [thread] } = await pool.query(
    `INSERT INTO whatsapp_threads (org_id, kind, wa_phone, status, opt_in_source, handover_id)
     VALUES ($1, 'direct', $2, 'active', 'inbound', $3)
     ON CONFLICT (org_id, wa_phone) WHERE kind = 'direct'
       DO UPDATE SET updated_at = now(),
                     handover_id = COALESCE(whatsapp_threads.handover_id, EXCLUDED.handover_id)
     RETURNING *`,
    [orgId, waPhone, inferredHandoverId]
  );
  return thread;
}

/**
 * Find (or open) the GROUP thread an inbound group message belongs to, and
 * record the sender as a participant.
 *
 * Keyed on (org_id, wa_group_id) — the same partial-unique index the create
 * side writes to — so a group we created and a group message arriving here
 * converge on one row. A group first *seen* here (rather than created by us)
 * is still mirrored so nothing is dropped; group_subject/invite_link fill in
 * from our own create call or a later subject webhook.
 *
 * The message insert that follows fires the existing window trigger against
 * THIS thread id, which is why member activity keeps the group's 24h window
 * open — no trigger change was needed.
 */
async function threadForInboundGroup(orgId, groupId, fromPhone, value) {
  const { rows: [thread] } = await pool.query(
    `INSERT INTO whatsapp_threads (org_id, kind, wa_group_id, status, opt_in_source)
     VALUES ($1, 'group', $2, 'active', 'inbound')
     ON CONFLICT (org_id, wa_group_id) WHERE kind = 'group'
       DO UPDATE SET updated_at = now()
     RETURNING *`,
    [orgId, String(groupId)]
  );

  // Mirror the sender into the participant roster. Best-effort: a roster hiccup
  // must never cost us the message itself.
  try {
    await upsertGroupParticipant(
      orgId, thread.id, fromPhone, contactNameFromValue(value, fromPhone)
    );
  } catch (e) {
    console.warn(`[whatsapp] participant upsert failed for group ${groupId}: ${e.message}`);
  }
  return thread;
}

/**
 * Upsert a participant of a group thread. Idempotent on (thread_id, wa_phone).
 * Defaults side='customer'; we never downgrade a hand-set 'internal' side here.
 */
async function upsertGroupParticipant(orgId, threadId, fromPhone, displayName) {
  const waPhone = normalizePhone(fromPhone);
  if (!waPhone) return;
  await pool.query(
    `INSERT INTO whatsapp_thread_participants
       (thread_id, org_id, wa_phone, display_name, side, joined_at)
     VALUES ($1, $2, $3, $4, 'customer', now())
     ON CONFLICT (thread_id, wa_phone) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, whatsapp_thread_participants.display_name),
       joined_at    = COALESCE(whatsapp_thread_participants.joined_at, EXCLUDED.joined_at)`,
    [threadId, orgId, waPhone, displayName || null]
  );
}

/**
 * Create an API-managed WhatsApp group for an org and mirror it locally as a
 * kind='group' thread. Returns { ok, threadId, groupId, inviteLink,
 * maxParticipants } or a typed error ({ ok:false, code, error }).
 *
 * OBA is enforced one layer down in the channel (OBA_REQUIRED). Members join
 * ONLY by tapping the returned invite link — there is no silent add — so the
 * caller's next step is to distribute inviteLink to the ≤8 members.
 */
async function createGroup(orgId, userId, { subject, handoverId = null } = {}) {
  const account = await waChannel.getAccount(orgId);
  if (!account) return { ok: false, code: 'NOT_CONNECTED', error: 'WhatsApp is not connected' };

  const created = await waChannel.createGroup({ account, subject });
  if (!created.ok) return created;   // e.g. OBA_REQUIRED, NETWORK, Meta error code

  const { rows: [thread] } = await pool.query(
    `INSERT INTO whatsapp_threads
       (org_id, kind, wa_group_id, group_subject, group_invite_link,
        handover_id, status, opt_in_source, created_by)
     VALUES ($1, 'group', $2, $3, $4, $5, 'active', 'api_created', $6)
     ON CONFLICT (org_id, wa_group_id) WHERE kind = 'group'
       DO UPDATE SET group_subject     = EXCLUDED.group_subject,
                     group_invite_link = EXCLUDED.group_invite_link,
                     handover_id       = COALESCE(EXCLUDED.handover_id, whatsapp_threads.handover_id),
                     updated_at        = now()
     RETURNING *`,
    [orgId, String(created.groupId), subject || null, created.inviteLink || null,
     handoverId, userId || null]
  );

  return {
    ok: true,
    threadId: thread.id,
    groupId: created.groupId,
    inviteLink: created.inviteLink,
    maxParticipants: waChannel.MAX_GROUP_PARTICIPANTS,
  };
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  getThreadForHandover,
  listSendTargets,
  projectForPhone,
  linkThreadToProject,
  // Exported because the guards it powers are asserted from outside this file,
  // and because an unexported helper called cross-module is exactly how
  // projectFiles.assertCanFile stayed broken for months.
  threadIsEntityBound,
  listMoveTargets,
  moveMessage,
  // Exported for diagnostics and back-fill: it is the one place that decides
  // which project an inbound conversation belongs to.
  threadForInbound,
  // The one place that decides which project an inbound MESSAGE belongs to.
  resolveInboundHandover,
  listApprovedTemplates,
  sendToHandover,
  listMessages,
  verifyChallenge,
  verifySignature,
  ingestWebhook,
  createGroup,
};
