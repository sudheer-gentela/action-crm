// ─────────────────────────────────────────────────────────────────────────────
// whatsappMedia.service.js
//
// Fetch an inbound WhatsApp attachment and store it in the customer's own Drive
// or OneDrive, where it becomes an ordinary project file.
//
// TWO TRANSPORTS, ONE DESTINATION
//   cloud_api  Meta media id -> graph.facebook.com with the WABA token. Two
//              hops, both from this process. Everything below still does it.
//   session    A companion-device (Baileys) message. There is no media id and
//              no Graph endpoint: the bytes are AES-encrypted on WhatsApp's
//              CDN and the key travels inside the message. Only the worker
//              process can fetch and decrypt, so it does, and POSTs the result
//              to /internal/media/:messageId, which lands in storeBuffer().
//
//   Everything after "we have bytes" is identical for both, which is why
//   storeBuffer() is one function and the fetchers are two. Before this split,
//   captureMessage() returned 'skipped: no attachment' for every session
//   message — the wa_media_id guard at the top could not be satisfied by a
//   transport that has no media ids — and group attachments never stored.
//
// THE CLOCK IS THE WHOLE DESIGN
//   Meta's download URL lives minutes; the media itself about 30 days. The
//   number is on the Cloud API, so it cannot also be in the consumer or
//   Business app — there is no inbox anywhere, and the webhook is the only
//   delivery. An attachment GoWarm does not fetch is unreachable by anyone.
//   (A human in the group still has it on their phone, so a manual re-upload is
//   a backstop — one that depends on somebody noticing.)
//
//   Session media is on a shorter and less certain clock. WhatsApp does not
//   document CDN retention for companion devices, and the standard recovery
//   move — updateMediaMessage(), which asks the sender's device to re-upload —
//   is deliberately never called anywhere in this codebase. That request is a
//   transmission. It turns an observing device into a participating one, which
//   is the one thing the session capture design will not do. So: download
//   promptly, and if the CDN has dropped it, mark it expired and accept the
//   loss honestly rather than reaching for the bot-shaped fix.
//
//   So: capture automatically on arrival, and let the team curate afterwards.
//   Remove is a real undo because we created the file and can delete it.
//
// FAILURES ARE SORTED, NOT LUMPED
//   retryable  — network, 5xx, rate limit. Requeue; the media id stays valid
//                for the retention window.
//   skipped    — nothing to store into (no project, no upload target, no
//                storage account, capture off). NOT a failure and NOT retried,
//                but the fetch handle is kept so it becomes storable the moment
//                the gap is closed.
//   expired    — the source no longer has it. Permanent. Retrying cannot help
//                and pretending otherwise hides a real loss.
//   failed     — everything else, retried a bounded number of times.
//
//   Getting this wrong in either direction is bad: retrying an expired file
//   forever buries the queue, and marking a transient error permanent throws
//   away a file that was still recoverable.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const { pool } = require('../config/database');

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE    = 'https://graph.facebook.com';

// Meta caps inbound media at 100 MB (video). Anything beyond that is a payload
// we should not be holding in memory anyway.
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

// The session ceiling is much lower and lives per-session in the database
// (whatsapp_sessions.media_max_bytes, default 25 MB). This is only the value
// used when the session row cannot be read — see sessionMediaLimit().
const DEFAULT_SESSION_MAX_BYTES = 25 * 1024 * 1024;

class SkipReason extends Error {
  constructor(message) { super(message); this.skip = true; }
}

// ── Naming ───────────────────────────────────────────────────────────────────

/**
 * A filename a human can find later.
 *
 * Meta supplies one only for documents; images and video arrive nameless. And
 * every image would otherwise land as the same string, so the message id is
 * appended — colliding names in one folder is a silent overwrite on OneDrive
 * unless conflictBehavior says otherwise.
 */
function buildFileName(msg) {
  if (msg.media_filename) return msg.media_filename.replace(/[\\/\\\\:*?"<>|]/g, '_').slice(0, 180);

  const ext = ({
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/3gpp': '3gp',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  })[msg.media_mime_type] || 'bin';

  const stamp = new Date(msg.sent_at || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // Strip punctuation before slicing: 'wamid.XYZ99' would otherwise yield
  // 'id.XYZ99' and read as a second file extension.
  const short = String(msg.wa_message_id || msg.id).replace(/[^A-Za-z0-9]/g, '').slice(-8);
  return `whatsapp-${msg.message_type || 'media'}-${stamp}-${short}.${ext}`;
}

/**
 * What kind of thing this is, for the Files tab.
 *
 * resolveCategory only maps document / transcript / email mime types and falls
 * back to 'document' for everything else — so every photo and video would be
 * filed as a document and get the wrong icon. WhatsApp already tells us the
 * type, so trust that first and fall back to the mime map for documents.
 */
function categoryFor(msg, mimeType) {
  const { resolveCategory } = require('./contentExtractor');
  const byType = { image: 'image', video: 'video', audio: 'audio', sticker: 'image' };
  return byType[msg.message_type] || resolveCategory(mimeType || msg.media_mime_type);
}

// ── Meta ─────────────────────────────────────────────────────────────────────

/**
 * Media id → bytes, in two hops.
 *
 * The first call returns a URL valid for minutes, which is why the id — not the
 * URL — is what gets stored at ingest. A 404 here means Meta has dropped the
 * media: permanent, and reported as such.
 */
async function downloadFromMeta(accessToken, mediaId) {
  let meta;
  try {
    const res = await axios.get(`${GRAPH_BASE}/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 20000,
    });
    meta = res.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 400) {
      throw Object.assign(new Error('Meta no longer has this media'), { expired: true });
    }
    throw err;
  }

  if (meta.file_size && Number(meta.file_size) > MAX_MEDIA_BYTES) {
    throw new SkipReason(`attachment is ${Math.round(meta.file_size / 1048576)} MB — above the ${MAX_MEDIA_BYTES / 1048576} MB limit`);
  }

  // The download host also requires the bearer token.
  const bin = await axios.get(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: MAX_MEDIA_BYTES,
    maxBodyLength: MAX_MEDIA_BYTES,
  });

  return { buffer: Buffer.from(bin.data), mimeType: meta.mime_type, sha256: meta.sha256 };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

async function loadMessage(orgId, messageId) {
  const { rows } = await pool.query(
    // The attachment follows the project the MESSAGE is on, not the project
    // that owns the conversation — otherwise a document sent on project B is
    // filed into project A's storage folder.
    `SELECT m.*, COALESCE(m.handover_id, t.handover_id) AS handover_id
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
      WHERE m.id = $1 AND m.org_id = $2`,
    [messageId, orgId]
  );
  return rows[0] || null;
}

async function setStatus(messageId, status, { error = null, storageFileId = null } = {}) {
  await pool.query(
    `UPDATE whatsapp_messages
        SET media_status = $2,
            media_error = $3,
            storage_file_id = COALESCE($4, storage_file_id)
      WHERE id = $1`,
    [messageId, status, error ? String(error).slice(0, 500) : null, storageFileId]
  );
}

/** Does this message carry an attachment at all, on either transport? */
function hasAttachment(msg) {
  return !!(msg.wa_media_id || msg.session_media_ref);
}

/**
 * The states from which no fetch should be attempted, and what to report.
 * Shared so the Cloud API path and the session upload path cannot drift into
 * disagreeing about whether an already-stored message may be overwritten.
 */
function terminalState(msg) {
  if (msg.media_status === 'stored')  return { status: 'stored',  alreadyStored: true };
  if (msg.media_status === 'removed') return { status: 'removed', reason: 'deliberately removed' };
  if (msg.media_status === 'expired') return { status: 'expired', reason: 'already expired' };
  return null;
}

// ── Store ────────────────────────────────────────────────────────────────────

/**
 * Where this attachment goes, and what may write there.
 *
 * Pulled out of captureMessage so the session path can run the SAME check
 * before the worker spends bandwidth decrypting something we have nowhere to
 * put. Both callers then hand the result to storeBuffer rather than resolving
 * it twice.
 */
async function resolveDestination(orgId, msg) {
  const storage = require('./orgStorageAccounts.service');

  if (!msg.handover_id) {
    throw new SkipReason('this WhatsApp thread is not linked to a project');
  }
  const target = await storage.resolveUploadTarget(orgId, msg.handover_id);
  if (!target) {
    throw new SkipReason('no upload folder or storage account configured for this project');
  }

  const accessToken = await storage.getFreshAccessToken(orgId, target.provider);
  if (!accessToken) {
    // getFreshAccessToken has already deactivated and notified. Skipped, not
    // failed: retrying a revoked credential cannot succeed, and the fetch
    // handle survives so this becomes storable again once someone reconnects.
    throw new SkipReason('storage account needs reconnecting');
  }

  return { target, accessToken };
}

/**
 * Bytes → a file in the customer's storage → a storage_files row → 'stored'.
 *
 * TRANSPORT-AGNOSTIC BY CONSTRUCTION. Nothing below knows or cares whether the
 * buffer came from Graph or from a Baileys socket, which is the point: one
 * upload path, one attribution rule, one storage_files shape, one place to fix
 * a bug in any of them.
 *
 * @param {object} msg       row from loadMessage (carries id, org_id, handover_id)
 * @param {Buffer} buffer    the decrypted, complete file
 * @param {string} mimeType  best known type; falls back to msg.media_mime_type
 * @param {object} [opts.destination]  result of resolveDestination, if the
 *                                     caller already ran it. Resolved here when
 *                                     absent so this is safe to call alone.
 *
 * NOTE ON THE SIGNATURE: this takes the loaded row, not a bare messageId as
 * originally sketched. Both callers have already loaded and guard-checked the
 * row, and re-reading it here would mean the row could change between the
 * guards and the write — the exact window in which a concurrent 'removed'
 * would be silently overwritten by a late upload.
 */
async function storeBuffer(msg, buffer, mimeType, opts = {}) {
  const storage = require('./orgStorageAccounts.service');
  const { getProvider } = require('./StorageProviderFactory');

  const orgId = msg.org_id;
  const messageId = msg.id;

  const { target, accessToken } =
    opts.destination || await resolveDestination(orgId, msg);

  const fileName = buildFileName(msg);

  const provider = getProvider(target.provider);
  const uploaded = await provider.uploadFileWithToken(
    accessToken, target.folderId, fileName, mimeType || msg.media_mime_type, buffer
  );

  // storage_files.user_id is NOT NULL, and an INBOUND WhatsApp message has no
  // GoWarm sender — it came from the customer. So the row needs a deliberate
  // owner. Best available, in order: whoever sent it if it was outbound; the
  // person whose credential actually performed the upload; then the project's
  // service owner or creator. Falling back to "any admin" would attribute the
  // file to someone with no connection to it.
  const { rows: [owner] } = await pool.query(
    `SELECT COALESCE(
              $2::int,
              (SELECT connected_by FROM org_storage_accounts
                WHERE org_id = $1 AND provider = $3),
              (SELECT assigned_service_owner_id FROM sales_handovers WHERE id = $4),
              (SELECT created_by FROM sales_handovers WHERE id = $4)
            ) AS user_id`,
    [orgId, msg.sent_by_user_id || null, target.provider, msg.handover_id]
  );
  if (!owner?.user_id) {
    throw new SkipReason('no user to attribute the file to — reconnect storage or assign a project manager');
  }

  // ── Record it as an ordinary project file ──
  // Reusing storage_files rather than inventing a WhatsApp-specific store is
  // what gives this tagging, precedence, hiding and the project Files tab for
  // free. tag_source 'manual' because a person sent it deliberately into a
  // project thread — it is not folder inheritance.
  const { rows: [file] } = await pool.query(
    `INSERT INTO storage_files (
       org_id, user_id, provider, provider_file_id, web_url, file_name,
       file_size, mime_type, category, source_label, folder_id,
       handover_id, tag_source, tagged_by, tagged_at, processing_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$2,now(),'pending')
     RETURNING id`,
    [orgId, owner.user_id, target.provider, uploaded.id,
     uploaded.webViewLink || uploaded.webUrl || null, fileName,
     buffer.length, mimeType || msg.media_mime_type || null,
     categoryFor(msg, mimeType),
     `WhatsApp · from ${msg.from_name || msg.from_phone || 'unknown sender'}`,
     target.folderId, msg.handover_id]
  );

  // Setting 'stored' also fires trg_clear_session_media_ref, which drops the
  // mediaKey: the bytes are safe in the customer's storage and the key has no
  // remaining purpose. See migration 2026_107.
  await setStatus(messageId, 'stored', { storageFileId: file.id });
  await storage.markUsed(orgId, target.provider);

  return {
    status: 'stored', storageFileId: file.id, fileName,
    folderName: target.folderName, bytes: buffer.length,
    // 'ask' mode means the team still gets a Keep/Remove prompt; the file is
    // already safe either way.
    needsReview: target.captureMode === 'ask',
  };
}

/**
 * Turn a thrown error into the right terminal or retryable state, and record
 * it. Lifted out of captureMessage's catch so the session upload path sorts
 * failures by exactly the same rules — two copies of this logic would drift,
 * and the drift would show up as files that retry forever or files that stop
 * retrying too early.
 */
async function recordFailure(messageId, err) {
  if (err.skip) {
    // Keep the fetch handle. This is recoverable the moment the gap is closed,
    // and the message stays visible so the gap is noticeable.
    await setStatus(messageId, 'skipped', { error: err.message });
    return { status: 'skipped', reason: err.message };
  }
  if (err.expired) {
    await setStatus(messageId, 'expired', { error: err.message });
    return { status: 'expired', reason: err.message };
  }
  const detail = err.response?.data?.error?.message || err.message;

  // A scope or permission problem cannot be fixed by trying again — it needs
  // a reconnect with wider consent, or access granting on the folder. Marking
  // it retryable meant five identical failures filling the log while the real
  // cause scrolled away. 'skipped' keeps the fetch handle, so it stays fully
  // recoverable the moment the consent is fixed.
  const notRetryable =
    /insufficient authentication scopes|insufficientPermissions|insufficientFilePermissions/i.test(detail)
    || err.response?.status === 401
    || err.response?.status === 403;

  if (notRetryable) {
    await setStatus(messageId, 'skipped', { error: `${detail} — reconnect storage with write access, then retry.` });
    return { status: 'skipped', reason: detail, needsReconnect: true };
  }

  await setStatus(messageId, 'failed', { error: detail });
  return { status: 'failed', reason: detail, retryable: true };
}

// ── Capture: Cloud API ───────────────────────────────────────────────────────

/**
 * Fetch one attachment from Meta and store it. Idempotent: an already-stored
 * message is left alone, so a duplicate job never uploads twice.
 *
 * Returns { status, ... } rather than throwing for expected outcomes — the
 * caller needs to know whether to requeue, and an exception cannot say that.
 *
 * A SESSION-captured message reaching here is not an error and not a no-op:
 * this process cannot fetch it (the key is in the worker's copy of the message
 * and the CDN is not Graph), so the row is put back into 'pending' and the
 * worker collects it on its next heartbeat. That is what makes the Retry
 * button and the sweep work identically for both transports.
 */
async function captureMessage(orgId, messageId) {
  const whatsappChannel = require('./channels/whatsappChannel');

  const msg = await loadMessage(orgId, messageId);
  if (!msg) return { status: 'skipped', reason: 'message not found' };

  // Terminal states FIRST, before the has-an-attachment test. Order matters
  // here in a way it does not look like it should: reaching 'stored' fires
  // trg_clear_session_media_ref, which nulls session_media_ref — so a stored
  // session attachment has no fetch handle left and would answer the
  // hasAttachment() test with "no attachment", which is both wrong and
  // alarming. It is stored. Say that.
  const terminal = terminalState(msg);
  if (terminal) return terminal;

  if (!hasAttachment(msg)) return { status: 'skipped', reason: 'no attachment' };

  if (msg.media_source === 'session') {
    return queueForWorker(orgId, msg);
  }

  try {
    // ── Somewhere to put it, and something to write there with ──
    const destination = await resolveDestination(orgId, msg);

    // ── Something to fetch it with ──
    const account = await whatsappChannel.getAccount(orgId);
    if (!account || !account.accessToken) {
      throw new SkipReason('WhatsApp is not connected for this org');
    }

    // ── Fetch, then upload ──
    const { buffer, mimeType } = await downloadFromMeta(account.accessToken, msg.wa_media_id);
    return await storeBuffer(msg, buffer, mimeType, { destination });
  } catch (err) {
    return await recordFailure(messageId, err);
  }
}

// ── Capture: session (Baileys worker) ────────────────────────────────────────

/**
 * Put a session attachment back in front of the worker.
 *
 * There is no fetch to perform from this process. Flipping to 'pending' is the
 * whole mechanism: listPendingSessionMedia() is what the worker polls, and it
 * reads exactly this state.
 */
async function queueForWorker(orgId, msg) {
  if (!msg.session_media_ref) {
    // The descriptor is cleared on stored/expired/removed by trigger, and those
    // are already handled above. Reaching here means it was never captured —
    // an old row from before 2026_107, or an ingest that predates the media
    // path. Honest answer: we cannot get this one back.
    await setStatus(msg.id, 'expired', {
      error: 'no session media reference stored — this attachment predates media capture and cannot be fetched',
    });
    return { status: 'expired', reason: 'no session media reference stored' };
  }

  const { rows } = await pool.query(
    `UPDATE whatsapp_messages
        SET media_status = 'pending',
            media_error  = NULL
      WHERE id = $1 AND org_id = $2
        AND media_status IN ('skipped', 'failed', 'pending')
      RETURNING id`,
    [msg.id, orgId]
  );
  if (!rows.length) return { status: msg.media_status || 'pending', reason: 'not in a requeueable state' };

  return {
    status: 'pending',
    queuedForWorker: true,
    reason: 'the session worker fetches this one; it will be collected on the next heartbeat',
  };
}

/** The per-session size ceiling, in bytes. */
async function sessionMediaLimit(sessionId) {
  if (!sessionId) return DEFAULT_SESSION_MAX_BYTES;
  const { rows: [r] } = await pool.query(
    `SELECT media_max_bytes FROM whatsapp_sessions WHERE id = $1`, [sessionId]
  );
  return Number(r?.media_max_bytes) || DEFAULT_SESSION_MAX_BYTES;
}

/**
 * Session attachments the worker should fetch, most urgent first.
 *
 * Scoped to one session, because the worker asks per session and a second
 * session's media is not its to decrypt — its Signal keys are different.
 *
 * The upload-target EXISTS clause is the point: it stops the worker
 * downloading and decrypting a 20 MB file that storeBuffer would immediately
 * refuse for want of a folder. The row stays 'pending' and is picked up the
 * moment a folder is configured, which is the same recovery the Cloud API path
 * gets from listRecoverable().
 */
async function listPendingSessionMedia(sessionId, limit = 25) {
  const { rows } = await pool.query(
    `SELECT m.id                 AS message_id,
            m.org_id,
            m.session_media_ref  AS ref,
            m.media_mime_type,
            m.media_filename,
            m.media_file_size,
            m.media_expires_at
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
       JOIN whatsapp_session_groups g ON g.thread_id = t.id
      WHERE g.session_id = $1
        AND m.media_source = 'session'
        AND m.media_status IN ('pending', 'failed')
        AND m.session_media_ref IS NOT NULL
        AND (m.media_expires_at IS NULL OR m.media_expires_at > now())
        AND EXISTS (
              SELECT 1 FROM project_folders pf
               WHERE pf.org_id = m.org_id
                 AND pf.handover_id = COALESCE(m.handover_id, t.handover_id)
                 AND pf.is_upload_target
            )
      ORDER BY m.media_expires_at NULLS LAST, m.id
      LIMIT $2`,
    [sessionId, Math.min(parseInt(limit, 10) || 25, 100)]
  );
  return rows;
}

/**
 * The worker has decrypted an attachment and handed us the bytes.
 *
 * Same guards as captureMessage, because this is a second front door onto the
 * same row and an unguarded one would let a late upload overwrite a deliberate
 * 'removed'.
 *
 * @param {number} sessionId  which session claims this message — checked by the
 *                            route, passed here only for the size ceiling
 */
async function storeSessionMedia(orgId, messageId, buffer, mimeType, { sessionId = null } = {}) {
  const msg = await loadMessage(orgId, messageId);
  if (!msg) return { status: 'skipped', reason: 'message not found' };

  const terminal = terminalState(msg);
  if (terminal) return terminal;

  try {
    if (!buffer || !buffer.length) {
      throw new SkipReason('the worker sent an empty body — nothing to store');
    }

    // Belt and braces on the size gate. The worker checks fileLength before
    // downloading and aborts mid-stream if the declared size lied; this is the
    // last check, and the only one an attacker-supplied fileLength cannot talk
    // its way past.
    const limit = await sessionMediaLimit(sessionId);
    if (buffer.length > limit) {
      throw new SkipReason(
        `attachment is ${(buffer.length / 1048576).toFixed(1)} MB — above this session's ${Math.round(limit / 1048576)} MB limit. Raise the limit and retry if it is worth keeping.`
      );
    }

    return await storeBuffer(msg, buffer, mimeType || msg.media_mime_type);
  } catch (err) {
    return await recordFailure(messageId, err);
  }
}

/**
 * The worker could not fetch it. Reported separately from a store failure so
 * the reason is the CDN's, not ours.
 *
 * `expired` here means the CDN returned 404/410. That is the end of the road:
 * the recovery WhatsApp offers is updateMediaMessage(), a re-upload request to
 * the sender's device, and sending anything is what we will not do.
 */
async function recordSessionFetchFailure(orgId, messageId, { reason, expired = false, skipped = false } = {}) {
  const msg = await loadMessage(orgId, messageId);
  if (!msg) return { status: 'skipped', reason: 'message not found' };

  const terminal = terminalState(msg);
  if (terminal) return terminal;

  const err = new Error(String(reason || 'session media fetch failed').slice(0, 500));
  if (expired) err.expired = true;
  if (skipped) err.skip = true;
  return await recordFailure(messageId, err);
}

// ── Curation ─────────────────────────────────────────────────────────────────

/**
 * Delete a stored attachment from the customer's storage.
 *
 * The real undo behind "Remove", and what makes capture-first defensible: we
 * created the file, so we can take it back out. The storage_files row goes too,
 * so it leaves the project Files tab.
 *
 * WHAT THE AUDIT COLUMNS ARE FOR
 *   storage_file_id is nulled and the storage_files row deleted, both correct —
 *   a pointer to a file nobody can open is worse than no pointer. But that
 *   erases the only record of WHAT was removed. The snapshot below is taken
 *   BEFORE the delete: name, provider, provider file id, and whether the
 *   provider delete actually succeeded.
 *
 *   provider_file_id in particular is what lets someone find the item in their
 *   own Drive or OneDrive recycle bin, where it sits for about 30 days. A
 *   removal made in error is answerable for exactly that long, and only if we
 *   wrote the id down first.
 */
async function removeStoredMedia(orgId, messageId, userId, { reason = null } = {}) {
  const storage = require('./orgStorageAccounts.service');
  const { getProvider } = require('./StorageProviderFactory');

  const { rows: [row] } = await pool.query(
    `SELECT m.id, m.storage_file_id, f.provider, f.provider_file_id, f.file_name
       FROM whatsapp_messages m
       LEFT JOIN storage_files f ON f.id = m.storage_file_id
      WHERE m.id = $1 AND m.org_id = $2`,
    [messageId, orgId]
  );
  if (!row) throw Object.assign(new Error('Message not found'), { status: 404 });
  if (!row.storage_file_id) throw Object.assign(new Error('Nothing stored for this message'), { status: 400 });

  let deletedFromProvider = false;
  try {
    const accessToken = await storage.getFreshAccessToken(orgId, row.provider);
    if (accessToken) {
      await getProvider(row.provider).deleteFileWithToken(accessToken, row.provider_file_id);
      deletedFromProvider = true;
    }
  } catch (err) {
    // The customer may already have deleted it, or moved it out of our reach.
    // Either way the project link must still go — leaving a row pointing at a
    // file nobody can open is worse than a tidy failure to delete.
    console.warn(`[whatsappMedia] provider delete failed for message ${messageId}: ${err.message}`);
  }

  await pool.query(`DELETE FROM storage_files WHERE id = $1 AND org_id = $2`, [row.storage_file_id, orgId]);
  await pool.query(
    `UPDATE whatsapp_messages
        SET media_status = 'removed', storage_file_id = NULL,
            media_reviewed_by = $2, media_reviewed_at = now(),
            media_removed_by = $2, media_removed_at = now(),
            media_removed_reason = $3,
            media_removed_file_name = $4,
            media_removed_provider = $5,
            media_removed_file_ref = $6,
            media_removed_from_provider = $7
      WHERE id = $1`,
    [messageId, userId,
     reason ? String(reason).slice(0, 500) : null,
     row.file_name || null, row.provider || null, row.provider_file_id || null,
     deletedFromProvider]
  );
  return {
    removed: true,
    deletedFromProvider,
    // Say it out loud when the file is still in the customer's Drive. The team
    // asked for it to be removed and it was not; discovering that six months
    // later from a column is not the same as being told now.
    warning: deletedFromProvider
      ? null
      : 'The project link was removed, but the file could not be deleted from the storage account and may still exist there.',
  };
}

/** Answer the Keep prompt: the file stays, the question stops being asked. */
async function keepStoredMedia(orgId, messageId, userId) {
  const { rows } = await pool.query(
    `UPDATE whatsapp_messages
        SET media_reviewed_by = $3, media_reviewed_at = now()
      WHERE id = $1 AND org_id = $2 AND media_status = 'stored'
      RETURNING id`,
    [messageId, orgId, userId]
  );
  if (!rows.length) throw Object.assign(new Error('Nothing stored for this message'), { status: 400 });
  return { kept: true };
}

// ── Queue feed ───────────────────────────────────────────────────────────────

/**
 * Attachments still worth trying, most urgent first.
 *
 * Ordered by how close the source is to dropping them, so a sweep that only
 * gets partway through has done the most valuable work rather than the oldest.
 *
 * WHY 'skipped' IS IN HERE NOW, AND WHY IT IS SAFE
 *   'skipped' means "nothing to store into", and most skipped rows are still
 *   skipped — no project, capture off, storage disconnected. Sweeping all of
 *   them every fifteen minutes would be exactly the queue-burying churn the
 *   status was invented to prevent.
 *
 *   So the skipped branch carries its own precondition: the project now HAS an
 *   upload target. That is the specific gap that made these rows skipped and
 *   the specific event that closes it. A row only re-enters the queue when the
 *   reason it left has actually gone away, which is bounded — it can happen
 *   once per configuration change, not once per sweep.
 *
 *   Without this, configuring an attachment folder after the fact stranded
 *   every attachment that arrived before it, permanently and silently: the
 *   Bull job completes 'skipped' as a SUCCESS, and a successful job is never
 *   retried. Message 226 is the live instance.
 */
async function listRecoverable(limit = 100) {
  const { rows } = await pool.query(
    `SELECT m.id, m.org_id, m.media_status, m.media_expires_at, m.media_source
       FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
      WHERE (m.wa_media_id IS NOT NULL OR m.session_media_ref IS NOT NULL)
        AND (m.media_expires_at IS NULL OR m.media_expires_at > now())
        AND (
              m.media_status IN ('pending', 'failed')
           OR (
                m.media_status = 'skipped'
                AND EXISTS (
                      SELECT 1 FROM project_folders pf
                       WHERE pf.org_id = m.org_id
                         AND pf.handover_id = COALESCE(m.handover_id, t.handover_id)
                         AND pf.is_upload_target
                    )
              )
            )
      ORDER BY m.media_expires_at NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Put every stranded attachment on one project back in the queue.
 *
 * Called when the thing that stranded them is fixed — an attachment folder
 * chosen for the first time, or a group finally bound to a project. Deliberate
 * and immediate, rather than waiting up to fifteen minutes for a sweep to
 * notice: the person who just configured the folder is still looking at the
 * screen, and "nothing happened" is the wrong feedback.
 *
 * Only touches 'skipped'. 'failed' is already swept, and the terminal states
 * are terminal.
 */
async function requeueForProject(orgId, handoverId, reason = 'project storage configured') {
  const { rows } = await pool.query(
    `UPDATE whatsapp_messages m
        SET media_status = 'pending',
            media_error  = $3
       FROM whatsapp_threads t
      WHERE t.id = m.thread_id
        AND m.org_id = $1
        AND COALESCE(m.handover_id, t.handover_id) = $2
        AND m.media_status = 'skipped'
        AND (m.wa_media_id IS NOT NULL OR m.session_media_ref IS NOT NULL)
        AND (m.media_expires_at IS NULL OR m.media_expires_at > now())
      RETURNING m.id, m.org_id, m.media_source`,
    [orgId, handoverId, `requeued: ${reason}`]
  );
  return { requeued: rows.length, messages: rows };
}

/**
 * Mark anything past its retention window as expired, so it leaves the queue
 * and shows as a real loss rather than a job that keeps failing.
 *
 * Covers both transports. The 2026_97 version filtered on wa_media_id IS NOT
 * NULL, which no session row satisfies — session media would have sat in
 * 'pending' forever, being offered to the worker on every heartbeat long after
 * the CDN dropped it.
 */
async function reapExpired() {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_messages
        SET media_status = 'expired',
            media_error = COALESCE(media_error, 'media retention window elapsed')
      WHERE (wa_media_id IS NOT NULL OR session_media_ref IS NOT NULL)
        AND media_status IN ('pending', 'failed', 'skipped')
        AND media_expires_at IS NOT NULL
        AND media_expires_at <= now()`
  );
  return { expired: rowCount };
}

module.exports = {
  captureMessage, removeStoredMedia, keepStoredMedia,
  listRecoverable, reapExpired, buildFileName, downloadFromMeta,
  // session transport
  storeBuffer, storeSessionMedia, recordSessionFetchFailure,
  listPendingSessionMedia, sessionMediaLimit, queueForWorker,
  // recovery
  requeueForProject, resolveDestination,
  // exported for tests
  loadMessage, categoryFor,
};
