// ─────────────────────────────────────────────────────────────────────────────
// routes/projectFiles.routes.js
//
// Mounted at /api/project-files.
//
//  GET    /:handoverId                       documents on this project
//  GET    /:handoverId/folders               folder mappings
//  POST   /:handoverId/folders               map a folder (covers subfolders)
//  DELETE /:handoverId/folders/:mappingId    unmap
//  POST   /:handoverId/link-status           which browsed files are already filed
//  POST   /:handoverId/files                 tag a document to this project
//  DELETE /:handoverId/files/:recordId       untag (falls back to folder mapping)
//  POST   /:handoverId/files/:recordId/hide
//  POST   /:handoverId/files/:recordId/unhide
//  POST   /:handoverId/files/:recordId/open-url
//
// Browsing folders is NOT here. That is GET /api/storage/:provider/files, which
// already exists and already understands Drive vs OneDrive. Duplicating it would
// create the second provider-aware code path this rework exists to avoid.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const multer  = require('multer');
const router  = express.Router();

// Memory storage, matching the other upload routes here. 100 MB is Meta's own
// ceiling for WhatsApp video, so a file a human is putting BACK cannot be
// larger than the one that would have arrived automatically.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const projectFiles      = require('../services/projectFiles.service');

router.use(authenticateToken);
router.use(orgContext);

const idOf = (v) => parseInt(v, 10);
const fail = (res, err, tag) => {
  console.error(`[project-files:${tag}]`, err.message);
  res.status(err.status || 500).json({ error: { message: err.message } });
};

// ── Documents on the project ─────────────────────────────────────────────────

router.get('/:handoverId', async (req, res) => {
  try {
    const handoverId = idOf(req.params.handoverId);
    // Hidden documents are a project-configuration view, not a team view.
    const canManage = await projectFiles.canManageFiles(handoverId, req.orgId, req.user.userId);
    const includeHidden = canManage && String(req.query.includeHidden) === 'true';

    const out = await projectFiles.listForProject(handoverId, req.orgId, { includeHidden });
    res.json({
      ...out,
      canManage,
      canFile: await projectFiles.canFile(handoverId, req.orgId, req.user.userId),
    });
  } catch (err) { fail(res, err, 'list'); }
});

// ── Folder mappings ──────────────────────────────────────────────────────────

router.get('/:handoverId/folders', async (req, res) => {
  try {
    res.json(await projectFiles.listFolders(idOf(req.params.handoverId), req.orgId));
  } catch (err) { fail(res, err, 'listFolders'); }
});

router.post('/:handoverId/folders', async (req, res) => {
  try {
    const { provider, folderId, folderName } = req.body || {};
    res.status(201).json(await projectFiles.mapFolder(
      idOf(req.params.handoverId), req.orgId, req.user.userId,
      { provider, folderId, folderName }
    ));
  } catch (err) { fail(res, err, 'mapFolder'); }
});

// Which mapped folder receives inbound WhatsApp attachments. One per project.
router.post('/:handoverId/folders/:mappingId/upload-target', async (req, res) => {
  try {
    res.json(await projectFiles.setUploadTarget(
      idOf(req.params.handoverId), req.orgId, req.user.userId, idOf(req.params.mappingId)
    ));
  } catch (err) { fail(res, err, 'setUploadTarget'); }
});

router.delete('/:handoverId/folders/:mappingId', async (req, res) => {
  try {
    res.json(await projectFiles.unmapFolder(
      idOf(req.params.handoverId), req.orgId, req.user.userId, idOf(req.params.mappingId)
    ));
  } catch (err) { fail(res, err, 'unmapFolder'); }
});

// ── Browse support ───────────────────────────────────────────────────────────

router.post('/:handoverId/link-status', async (req, res) => {
  try {
    const { provider, providerFileIds } = req.body || {};
    if (!provider) return res.status(400).json({ error: { message: 'provider is required' } });
    res.json(await projectFiles.linkStatus(req.orgId, provider, providerFileIds || []));
  } catch (err) { fail(res, err, 'linkStatus'); }
});

// ── Manual upload ────────────────────────────────────────────────────────────
//
// The fallback for when automatic capture could not run — someone in the group
// still has the file on their phone. Goes to the same folder, with the same
// org storage credential, as an automatic capture.
//
// multipart: file, and optionally whatsappMessageId to close the gap on the
// message it recovers.
router.post('/:handoverId/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: { message: 'No file received' } });
    res.status(201).json(await projectFiles.uploadLocalFile(
      idOf(req.params.handoverId), req.orgId, req.user.userId,
      {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer:   req.file.buffer,
        whatsappMessageId: req.body?.whatsappMessageId
          ? idOf(req.body.whatsappMessageId) : null,
      }
    ));
  } catch (err) {
    // multer rejects an oversized file before the handler, so surface that as a
    // size problem rather than a generic 500.
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: { message: 'That file is over the 100 MB limit.' } });
    }
    fail(res, err, 'upload');
  }
});

// ── Tag / untag / hide / unhide ──────────────────────────────────────────────

router.post('/:handoverId/files', async (req, res) => {
  try {
    const { provider, providerFileId } = req.body || {};
    res.status(201).json(await projectFiles.tagFile(
      idOf(req.params.handoverId), req.orgId, req.user.userId, { provider, providerFileId }
    ));
  } catch (err) { fail(res, err, 'tag'); }
});

router.delete('/:handoverId/files/:recordId', async (req, res) => {
  try {
    res.json(await projectFiles.untagFile(
      idOf(req.params.handoverId), req.orgId, req.user.userId, idOf(req.params.recordId)
    ));
  } catch (err) { fail(res, err, 'untag'); }
});

router.post('/:handoverId/files/:recordId/hide', async (req, res) => {
  try {
    res.json(await projectFiles.hideFile(
      idOf(req.params.handoverId), req.orgId, req.user.userId, idOf(req.params.recordId)
    ));
  } catch (err) { fail(res, err, 'hide'); }
});

router.post('/:handoverId/files/:recordId/unhide', async (req, res) => {
  try {
    res.json(await projectFiles.unhideFile(
      idOf(req.params.handoverId), req.orgId, req.user.userId, idOf(req.params.recordId)
    ));
  } catch (err) { fail(res, err, 'unhide'); }
});

// ── Open a document ──────────────────────────────────────────────────────────
//
// Resolved with the REQUESTING user's own provider token, never the importer's.
// A project link says "this document belongs to this project"; it does not say
// the reader may open it. Drive and OneDrive already hold that answer, and
// borrowing the importer's credentials would replace their permission model
// with ours — so a reader without access gets an honest 403 they can act on
// rather than a link that silently works or silently fails.
//
// NOTE: POST /api/storage/imported/:recordId/open-url does exactly the opposite
// today — see the comment added there.
router.post('/:handoverId/files/:recordId/open-url', async (req, res) => {
  try {
    const handoverId = idOf(req.params.handoverId);
    const { pool } = require('../config/database');
    const { getProvider } = require('../services/StorageProviderFactory');

    if (!(await projectFiles.canFile(handoverId, req.orgId, req.user.userId))) {
      return res.status(403).json({ error: { message: 'You are not on this project' } });
    }

    const { rows } = await pool.query(
      `SELECT provider, provider_file_id, file_name, web_url
         FROM storage_files
        WHERE id = $1 AND org_id = $2 AND handover_id = $3`,
      [idOf(req.params.recordId), req.orgId, handoverId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'File is not on this project' } });

    const file = rows[0];
    const provider = getProvider(file.provider);

    try {
      // A metadata read the requester's own token has to satisfy. If they
      // cannot see the file in Drive/OneDrive, this is where we find out.
      await provider.getFileMetadata(req.user.userId, file.provider_file_id);
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 403 || status === 404 || /No tokens found/.test(err.message || '')) {
        return res.status(403).json({
          error: {
            code: 'PROVIDER_ACCESS_DENIED',
            provider: file.provider,
            message: `You do not have permission to open "${file.file_name}" in ` +
                     `${file.provider === 'onedrive' ? 'OneDrive' : 'Google Drive'}. ` +
                     `Ask the document owner for access — file permissions are managed there, not in GoWarm.`,
          },
        });
      }
      throw err;
    }

    if (file.web_url) return res.json({ url: file.web_url });
    return res.status(404).json({ error: { message: 'No URL available for this file' } });
  } catch (err) { fail(res, err, 'open-url'); }
});

module.exports = router;
