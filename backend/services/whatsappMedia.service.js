// ─────────────────────────────────────────────────────────────────────────────
// whatsappMedia.service.js
//
// Fetch an inbound WhatsApp attachment from Meta and store it in the customer's
// own Drive or OneDrive, where it becomes an ordinary project file.
//
// THE CLOCK IS THE WHOLE DESIGN
//   Meta's download URL lives minutes; the media itself about 30 days. The
//   number is on the Cloud API, so it cannot also be in the consumer or
//   Business app — there is no inbox anywhere, and the webhook is the only
//   delivery. An attachment GoWarm does not fetch is unreachable by anyone.
//   (A human in the group still has it on their phone, so a manual re-upload is
//   a backstop — one that depends on somebody noticing.)
//
//   So: capture automatically on arrival, and let the team curate afterwards.
//   Remove is a real undo because we created the file and can delete it.
//
// FAILURES ARE SORTED, NOT LUMPED
//   retryable  — network, 5xx, rate limit. Requeue; the media id stays valid
//                for the retention window.
//   skipped    — nothing to store into (no project, no upload target, no
//                storage account, capture off). NOT a failure and NOT retried,
//                but wa_media_id is kept so it becomes storable the moment the
//                gap is closed.
//   expired    — Meta no longer has it. Permanent. Retrying cannot help and
//                pretending otherwise hides a real loss.
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

// ── Capture ──────────────────────────────────────────────────────────────────

async function loadMessage(orgId, messageId) {
  const { rows } = await pool.query(
    `SELECT m.*, t.handover_id
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

/**
 * Fetch one attachment and store it. Idempotent: an already-stored message is
 * left alone, so a duplicate job never uploads twice.
 *
 * Returns { status, ... } rather than throwing for expected outcomes — the
 * caller needs to know whether to requeue, and an exception cannot say that.
 */
async function captureMessage(orgId, messageId) {
  const storage = require('./orgStorageAccounts.service');
  const { getProvider } = require('./StorageProviderFactory');
  const { resolveCategory } = require('./contentExtractor');
  const whatsappChannel = require('./channels/whatsappChannel');

  const msg = await loadMessage(orgId, messageId);
  if (!msg)             return { status: 'skipped', reason: 'message not found' };
  if (!msg.wa_media_id) return { status: 'skipped', reason: 'no attachment' };
  if (msg.media_status === 'stored')  return { status: 'stored', alreadyStored: true };
  if (msg.media_status === 'removed') return { status: 'removed', reason: 'deliberately removed' };
  if (msg.media_status === 'expired') return { status: 'expired', reason: 'already expired' };

  try {
    // ── Somewhere to put it ──
    if (!msg.handover_id) {
      throw new SkipReason('this WhatsApp thread is not linked to a project');
    }
    const target = await storage.resolveUploadTarget(orgId, msg.handover_id);
    if (!target) {
      throw new SkipReason('no upload folder or storage account configured for this project');
    }

    // ── Something to fetch it with ──
    const account = await whatsappChannel.getAccount(orgId);
    if (!account || !account.accessToken) {
      throw new SkipReason('WhatsApp is not connected for this org');
    }

    const accessToken = await storage.getFreshAccessToken(orgId, target.provider);
    if (!accessToken) {
      // getFreshAccessToken has already deactivated and notified. Skipped, not
      // failed: retrying a revoked credential cannot succeed, and the media id
      // survives so this becomes storable again once someone reconnects.
      throw new SkipReason('storage account needs reconnecting');
    }

    // ── Fetch, then upload ──
    const { buffer, mimeType } = await downloadFromMeta(account.accessToken, msg.wa_media_id);
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

    await setStatus(messageId, 'stored', { storageFileId: file.id });
    await storage.markUsed(orgId, target.provider);

    return {
      status: 'stored', storageFileId: file.id, fileName,
      folderName: target.folderName, bytes: buffer.length,
      // 'ask' mode means the team still gets a Keep/Remove prompt; the file is
      // already safe either way.
      needsReview: target.captureMode === 'ask',
    };
  } catch (err) {
    if (err.skip) {
      // Keep wa_media_id. This is recoverable the moment the gap is closed, and
      // the message stays visible so the gap is noticeable.
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
    // cause scrolled away. 'skipped' keeps wa_media_id, so it stays fully
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
}

// ── Curation ─────────────────────────────────────────────────────────────────

/**
 * Delete a stored attachment from the customer's storage.
 *
 * The real undo behind "Remove", and what makes capture-first defensible: we
 * created the file, so we can take it back out. The storage_files row goes too,
 * so it leaves the project Files tab.
 */
async function removeStoredMedia(orgId, messageId, userId) {
  const storage = require('./orgStorageAccounts.service');
  const { getProvider } = require('./StorageProviderFactory');

  const { rows: [row] } = await pool.query(
    `SELECT m.id, m.storage_file_id, f.provider, f.provider_file_id
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
            media_reviewed_by = $2, media_reviewed_at = now()
      WHERE id = $1`,
    [messageId, userId]
  );
  return { removed: true, deletedFromProvider };
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
 * Ordered by how close Meta is to dropping them, so a sweep that only gets
 * partway through has done the most valuable work rather than the oldest.
 */
async function listRecoverable(limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, org_id, media_status, media_expires_at
       FROM whatsapp_messages
      WHERE wa_media_id IS NOT NULL
        AND media_status IN ('pending', 'failed')
        AND (media_expires_at IS NULL OR media_expires_at > now())
      ORDER BY media_expires_at NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Mark anything past Meta's retention as expired, so it leaves the queue and
 * shows as a real loss rather than a job that keeps failing.
 */
async function reapExpired() {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_messages
        SET media_status = 'expired',
            media_error = COALESCE(media_error, 'media retention window elapsed')
      WHERE wa_media_id IS NOT NULL
        AND media_status IN ('pending', 'failed')
        AND media_expires_at IS NOT NULL
        AND media_expires_at <= now()`
  );
  return { expired: rowCount };
}

module.exports = {
  captureMessage, removeStoredMedia, keepStoredMedia,
  listRecoverable, reapExpired, buildFileName, downloadFromMeta,
};
