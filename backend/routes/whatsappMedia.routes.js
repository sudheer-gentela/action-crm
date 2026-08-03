// ─────────────────────────────────────────────────────────────────────────────
// routes/whatsappMedia.routes.js   → /api/whatsapp-media
//
//  GET  /projects/:handoverId          attachments and their state
//  POST /messages/:messageId/keep      answer the Keep prompt
//  POST /messages/:messageId/remove    delete it from the customer's storage
//  POST /messages/:messageId/retry     re-queue a skipped or failed capture
//
// Same authority as filing a document: any approved project member.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const media             = require('../services/whatsappMedia.service');
const projectFiles      = require('../services/projectFiles.service');
const { pool }          = require('../config/database');

router.use(authenticateToken);
router.use(orgContext);

const idOf = (v) => parseInt(v, 10);
const fail = (res, err, tag) => {
  console.error(`[whatsapp-media:${tag}]`, err.message);
  res.status(err.status || 500).json({ error: { message: err.message } });
};

/** The project a message belongs to, so authority can be checked against it. */
async function handoverForMessage(orgId, messageId) {
  const { rows } = await pool.query(
    `SELECT t.handover_id FROM whatsapp_messages m
       JOIN whatsapp_threads t ON t.id = m.thread_id
      WHERE m.id = $1 AND m.org_id = $2`,
    [messageId, orgId]
  );
  return rows[0]?.handover_id || null;
}

async function assertMember(req, messageId) {
  const handoverId = await handoverForMessage(req.orgId, messageId);
  if (!handoverId) throw Object.assign(new Error('Message not found on a project'), { status: 404 });
  if (!(await projectFiles.canFile(handoverId, req.orgId, req.user.userId))) {
    throw Object.assign(new Error('You are not on this project'), { status: 403 });
  }
  return handoverId;
}

router.get('/projects/:handoverId', async (req, res) => {
  try {
    const handoverId = idOf(req.params.handoverId);
    if (!(await projectFiles.canFile(handoverId, req.orgId, req.user.userId))) {
      return res.status(403).json({ error: { message: 'You are not on this project' } });
    }
    const { rows } = await pool.query(
      `SELECT m.id, m.message_type, m.body, m.sent_at, m.from_name, m.from_phone,
              m.media_filename, m.media_mime_type, m.media_status, m.media_error,
              m.media_expires_at, m.storage_file_id, m.media_reviewed_at,
              (ru.first_name || ' ' || ru.last_name) AS reviewed_by_name,
              f.file_name, f.web_url, f.file_size
         FROM whatsapp_messages m
         JOIN whatsapp_threads t ON t.id = m.thread_id
         LEFT JOIN storage_files f ON f.id = m.storage_file_id
         LEFT JOIN users ru ON ru.id = m.media_reviewed_by
        WHERE m.org_id = $1 AND t.handover_id = $2 AND m.wa_media_id IS NOT NULL
        ORDER BY m.sent_at DESC NULLS LAST`,
      [req.orgId, handoverId]
    );
    res.json({ attachments: rows });
  } catch (err) { fail(res, err, 'list'); }
});

router.post('/messages/:messageId/keep', async (req, res) => {
  try {
    const id = idOf(req.params.messageId);
    await assertMember(req, id);
    res.json(await media.keepStoredMedia(req.orgId, id, req.user.userId));
  } catch (err) { fail(res, err, 'keep'); }
});

router.post('/messages/:messageId/remove', async (req, res) => {
  try {
    const id = idOf(req.params.messageId);
    await assertMember(req, id);
    res.json(await media.removeStoredMedia(req.orgId, id, req.user.userId));
  } catch (err) { fail(res, err, 'remove'); }
});

// For an attachment that was skipped because storage was not configured yet, or
// that failed. Still bounded by Meta's retention — the service reports
// 'expired' rather than pretending a retry can help.
router.post('/messages/:messageId/retry', async (req, res) => {
  try {
    const id = idOf(req.params.messageId);
    await assertMember(req, id);
    res.json(await media.captureMessage(req.orgId, id));
  } catch (err) { fail(res, err, 'retry'); }
});

module.exports = router;
