/**
 * storage.routes.js
 * Provider-agnostic router for all cloud storage integrations.
 * All requires point to services/ flat structure.
 *
 * Register in server.js:
 *   app.use('/api/storage', require('./routes/storage.routes'));
 */

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { getProvider, checkAllConnections } = require('../services/StorageProviderFactory');
const { processStorageFile }               = require('../services/storageProcessor.service');
const {
  getFilesForDeal, getFilesForContact,
  checkDuplicate, deleteImportRecord,
} = require('../services/storageFileService');

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
    res.status(err.message.includes('Unknown storage provider') ? 404 : 500).json({ error: err.message });
  }
});

// ── File browsing ──────────────────────────────────────────────────────────

router.get('/:provider/files', async (req, res) => {
  try {
    const provider = getProvider(req.params.provider);
    const files = await provider.listFiles(req.user.userId, req.query.folderId || null);
    res.json({ files, count: files.length, provider: req.params.provider });
  } catch (err) {
    res.status(err.message.includes('Unknown storage provider') ? 404 : 500).json({ error: err.message });
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

router.get('/:provider/files/:id/duplicate-check', async (req, res) => {
  try {
    const result = await checkDuplicate(
      req.user.userId, req.params.provider, req.params.id, req.query.dealId || null
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Process: single file ───────────────────────────────────────────────────

router.post('/:provider/files/:id/process', async (req, res) => {
  try {
    const { dealId, contactId, pipelines, dryRun, force } = req.body;
    const result = await processStorageFile(
      req.user.userId, req.params.provider, req.params.id,
      { dealId, contactId, pipelines, dryRun: !!dryRun, force: !!force }
    );
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.code === 'DUPLICATE_IMPORT') {
      return res.status(409).json({ error: err.message, code: 'DUPLICATE_IMPORT', existingRecord: err.existingRecord });
    }
    const status = err.message.includes('exceeds the') ? 413
                 : err.message.includes('Unknown storage provider') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Process: batch ─────────────────────────────────────────────────────────

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
          dealId, contactId, pipelines, dryRun: !!dryRun, force: !!force,
        })
      )
    );

    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return { fileId: files[i].fileId, status: 'fulfilled', result: r.value };
      if (r.reason && r.reason.code === 'DUPLICATE_IMPORT') {
        return { fileId: files[i].fileId, status: 'duplicate', message: r.reason.message, existingRecord: r.reason.existingRecord };
      }
      return { fileId: files[i].fileId, status: 'failed', error: r.reason && r.reason.message };
    });

    res.json({
      provider: providerId,
      processed:  results.filter((r) => r.status === 'fulfilled').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      failed:     results.filter((r) => r.status === 'failed').length,
      total: files.length, results,
    });
  } catch (err) {
    res.status(err.message.includes('Unknown storage provider') ? 404 : 500).json({ error: err.message });
  }
});

// ── Imported file queries ──────────────────────────────────────────────────

router.get('/imported/deal/:dealId', async (req, res) => {
  try {
    const files = await getFilesForDeal(req.params.dealId, req.user.userId);
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/imported/contact/:contactId', async (req, res) => {
  try {
    const files = await getFilesForContact(req.params.contactId, req.user.userId);
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/imported/:recordId', async (req, res) => {
  try {
    const deleted = await deleteImportRecord(req.params.recordId, req.user.userId);
    res.json({ success: true, message: `Import record for "${deleted.file_name}" removed. The file in your cloud storage is unchanged.` });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

module.exports = router;
