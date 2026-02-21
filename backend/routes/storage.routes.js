/**
 * storage.routes.js
 * Provider-agnostic router for all cloud storage integrations.
 *
 * MULTI-ORG: orgId is passed to all service functions that touch storage_files.
 * The storage service functions (storageFileService, storageProcessor.service)
 * will need their own org updates to use it — see NOTE comments below.
 */

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const { getProvider, checkAllConnections } = require('../services/StorageProviderFactory');
const { processStorageFile }               = require('../services/storageProcessor.service');
const {
  getFilesForDeal, getFilesForContact, getAllFilesForUser,
  checkDuplicate, deleteImportRecord,
} = require('../services/storageFileService');

router.use(authenticateToken);
router.use(orgContext);

// ── Provider status ───────────────────────────────────────────

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
    const status   = await provider.checkConnection(req.user.userId);
    res.json(status);
  } catch (err) {
    res.status(err.message.includes('Unknown storage provider') ? 404 : 500).json({ error: err.message });
  }
});

// ── File browsing ─────────────────────────────────────────────

router.get('/:provider/files', async (req, res) => {
  try {
    const provider = getProvider(req.params.provider);
    const files    = await provider.listFiles(req.user.userId, req.query.folderId || null);
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
    const files    = await provider.searchFiles(req.user.userId, q.trim());
    res.json({ files, count: files.length, query: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:provider/files/:id', async (req, res) => {
  try {
    const provider = getProvider(req.params.provider);
    const file     = await provider.getFileMetadata(req.user.userId, req.params.id);
    res.json({ file });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Duplicate check ───────────────────────────────────────────
// NOTE: checkDuplicate needs orgId added to its signature when
// storageFileService.js is updated

router.get('/:provider/files/:id/duplicate-check', async (req, res) => {
  try {
    const result = await checkDuplicate(
      req.user.userId, req.params.provider, req.params.id,
      req.query.dealId || null, req.orgId
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Process: single file ──────────────────────────────────────
// NOTE: processStorageFile needs orgId added when storageProcessor.service.js is updated

router.post('/:provider/files/:id/process', async (req, res) => {
  try {
    const { dealId, contactId, pipelines, dryRun, force } = req.body;
    const result = await processStorageFile(
      req.user.userId, req.params.provider, req.params.id,
      { dealId, contactId, pipelines, dryRun: !!dryRun, force: !!force, orgId: req.orgId }
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

// ── Process: batch ────────────────────────────────────────────

router.post('/:provider/files/batch-process', async (req, res) => {
  try {
    const { files, dryRun }   = req.body;
    const { provider: provId } = req.params;

    if (!Array.isArray(files) || files.length === 0)
      return res.status(400).json({ error: '"files" must be a non-empty array.' });
    if (files.length > 20)
      return res.status(400).json({ error: 'Batch limit is 20 files per request.' });

    getProvider(provId);

    const settled = await Promise.allSettled(
      files.map(({ fileId, dealId, contactId, pipelines, force }) =>
        processStorageFile(req.user.userId, provId, fileId, {
          dealId, contactId, pipelines, dryRun: !!dryRun, force: !!force, orgId: req.orgId,
        })
      )
    );

    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return { fileId: files[i].fileId, status: 'fulfilled', result: r.value };
      if (r.reason?.code === 'DUPLICATE_IMPORT') {
        return { fileId: files[i].fileId, status: 'duplicate', message: r.reason.message, existingRecord: r.reason.existingRecord };
      }
      return { fileId: files[i].fileId, status: 'failed', error: r.reason?.message };
    });

    res.json({
      provider:   provId,
      processed:  results.filter(r => r.status === 'fulfilled').length,
      duplicates: results.filter(r => r.status === 'duplicate').length,
      failed:     results.filter(r => r.status === 'failed').length,
      total: files.length, results,
    });
  } catch (err) {
    res.status(err.message.includes('Unknown storage provider') ? 404 : 500).json({ error: err.message });
  }
});

// ── Imported file queries ─────────────────────────────────────
// NOTE: These service functions need orgId in their signatures
// when storageFileService.js is updated

router.get('/imported/all', async (req, res) => {
  try {
    const files = await getAllFilesForUser(req.user.userId, req.orgId);
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/imported/deal/:dealId', async (req, res) => {
  try {
    const files = await getFilesForDeal(req.params.dealId, req.user.userId, req.orgId);
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/imported/contact/:contactId', async (req, res) => {
  try {
    const files = await getFilesForContact(req.params.contactId, req.user.userId, req.orgId);
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/imported/:recordId', async (req, res) => {
  try {
    const deleted = await deleteImportRecord(req.params.recordId, req.user.userId, req.orgId);
    res.json({ success: true, message: `Import record for "${deleted.file_name}" removed. The file in your cloud storage is unchanged.` });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

module.exports = router;
