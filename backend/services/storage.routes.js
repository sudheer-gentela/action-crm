/**
 * storage.routes.js
 *
 * Auth: authenticateToken middleware — req.user.userId from JWT payload
 * { userId: user.id, email: user.email } as signed in auth.routes.js.
 *
 * Register in server.js:
 *   app.use('/api/storage', require('./routes/storage.routes'));
 */

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { getProvider, checkAllConnections } = require('../services/storage/StorageProviderFactory');
const { processStorageFile } = require('../services/storage/storageProcessor.service');
const {
  getFilesForDeal,
  getFilesForContact,
  checkDuplicate,
  deleteImportRecord,
} = require('../services/storage/storageFileService');

router.use(authenticateToken);

// ── Provider status ────────────────────────────────────────────────────────

router.get('/providers', async (req, res) => {
  try {
    const statuses = await checkAllConnections(req.user.userId);
    res.json({ providers: statuses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:provider/status', async (req, res) => {
  try {
    const provider = getProvider(req.params.provider);
    const status = await provider.checkConnection(req.user.userId);
    res.json(status);
  } catch (err) {
    res.status(err.message.includes('Unknown storage provider') ? 404 : 500)
       .json({ error: err.message });
  }
});

// ── File browsing ──────────────────────────────────────────────────────────

router.get('/:provider/files', async (req, res) => {
  try {
    const provider = getProvider(req.params.provider);
    const files = await provider.listFiles(req.user.userId, req.query.folderId || null);
    res.json({ files, count: files.length, provider: req.params.provider });
  } catch (err) {
    res.status(err.message.includes('Unknown storage provider') ? 404 : 500)
       .json({ error: err.message });
  }
});

router.get('/:provider/files/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) return res.status(400).json({ error: 'Search query "q" is required.' });
    const provider = getProvider(req.params.provider);
    const files = await provider.searchFiles(req.user.userId, q.trim());
    res.json({ files, count: files.length, query: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:provider/files/:id', async (req, res) => {
  try {
    const provider = getProvider(req.params.provider);
    const file = await provider.getFileMetadata(req.user.userId, req.params.id);
    res.json({ file });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Duplicate check ────────────────────────────────────────────────────────
// GET /api/storage/:provider/files/:id/duplicate-check?dealId=
// Call before showing the "Import" button to surface a warning if already imported.
// The frontend uses the response to offer "Re-import?" confirmation.

router.get('/:provider/files/:id/duplicate-check', async (req, res) => {
  try {
    const result = await checkDuplicate(
      req.user.userId,
      req.params.provider,
      req.params.id,
      req.query.dealId || null
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Process: single file ───────────────────────────────────────────────────
// POST /api/storage/:provider/files/:id/process
// Body:
//   dealId     {string}    - Required for dealHealth pipeline
//   contactId  {string}
//   pipelines  {string[]}  - Override defaults
//   dryRun     {boolean}   - Analyse only, nothing persisted
//   force      {boolean}   - Re-import even if already processed for this deal
//
// Duplicate behaviour (force = false, default):
//   Returns 409 with { error, existingRecord } — frontend shows "Re-import?" prompt.
// Re-import (force = true):
//   Clears stale insights and re-processes the latest file content.

router.post('/:provider/files/:id/process', async (req, res) => {
  try {
    const { dealId, contactId, pipelines, dryRun, force } = req.body;
    const result = await processStorageFile(
      req.user.userId,
      req.params.provider,
      req.params.id,
      { dealId, contactId, pipelines, dryRun: !!dryRun, force: !!force }
    );
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.code === 'DUPLICATE_IMPORT') {
      // 409 Conflict — frontend should offer "Re-import?" with force: true
      return res.status(409).json({
        error:          err.message,
        code:           'DUPLICATE_IMPORT',
        existingRecord: err.existingRecord,
      });
    }
    const status = err.message.includes('exceeds the') ? 413
                 : err.message.includes('Unknown storage provider') ? 404
                 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Process: batch ─────────────────────────────────────────────────────────
// POST /api/storage/:provider/files/batch-process
// Body:
//   files    {Array<{ fileId, dealId?, contactId?, pipelines?, force? }>}
//   dryRun   {boolean}
//
// Duplicate files in the batch return a 'duplicate' status rather than failing
// the entire batch. The response tells the caller which files need force: true.

router.post('/:provider/files/batch-process', async (req, res) => {
  try {
    const { files, dryRun } = req.body;
    const { provider: providerId } = req.params;

    if (!Array.isArray(files) || files.length === 0)
      return res.status(400).json({ error: '"files" must be a non-empty array.' });
    if (files.length > 20)
      return res.status(400).json({ error: 'Batch limit is 20 files per request.' });

    getProvider(providerId);

    const settled = await Promise.allSettled(
      files.map(({ fileId, dealId, contactId, pipelines, force }) =>
        processStorageFile(req.user.userId, providerId, fileId, {
          dealId, contactId, pipelines,
          dryRun: !!dryRun,
          force:  !!force,
        })
      )
    );

    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') {
        return { fileId: files[i].fileId, status: 'fulfilled', result: r.value };
      }
      // Surface duplicates distinctly from real errors
      if (r.reason && r.reason.code === 'DUPLICATE_IMPORT') {
        return {
          fileId:         files[i].fileId,
          status:         'duplicate',
          message:        r.reason.message,
          existingRecord: r.reason.existingRecord,
        };
      }
      return { fileId: files[i].fileId, status: 'failed', error: r.reason && r.reason.message };
    });

    res.json({
      provider:   providerId,
      processed:  results.filter((r) => r.status === 'fulfilled').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      failed:     results.filter((r) => r.status === 'failed').length,
      total:      files.length,
      results,
    });
  } catch (err) {
    res.status(err.message.includes('Unknown storage provider') ? 404 : 500)
       .json({ error: err.message });
  }
});

// ── Imported file queries ──────────────────────────────────────────────────

// GET /api/storage/imported/deal/:dealId
// Returns all files linked to a deal — including web_url for "Open in Drive" links
// and source_label for display. Used by the deal detail view.
router.get('/imported/deal/:dealId', async (req, res) => {
  try {
    const files = await getFilesForDeal(req.params.dealId, req.user.userId);
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/storage/imported/contact/:contactId
router.get('/imported/contact/:contactId', async (req, res) => {
  try {
    const files = await getFilesForContact(req.params.contactId, req.user.userId);
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/storage/imported/:recordId
// Removes the CRM reference only. The file in OneDrive/Google Drive is NOT deleted.
router.delete('/imported/:recordId', async (req, res) => {
  try {
    const deleted = await deleteImportRecord(req.params.recordId, req.user.userId);
    res.json({
      success: true,
      message: `Import record for "${deleted.file_name}" removed. The file in your cloud storage is unchanged.`,
    });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

module.exports = router;
