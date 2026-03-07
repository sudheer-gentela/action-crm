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

// ── Resolve file open URL (POST — token in Authorization header, returns JSON) ──
// Frontend calls this with fetch() using Authorization header, then does window.open(url).
// Avoids passing token as query param (proxies mangle URLs with __ in JWT signatures).
router.post('/imported/:recordId/open-url', async (req, res) => {
  try {
    const jwt  = require('jsonwebtoken');
    const { pool } = require('../config/database');
    const axios = require('axios');

    // Token comes in Authorization header: "Bearer <token>"
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: { message: 'No token provided' } });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: { message: 'Invalid or expired token' } });
    }

    // Get orgId for this user
    const orgRes = await pool.query(
      `SELECT org_id FROM org_users WHERE user_id = $1 LIMIT 1`,
      [decoded.userId]
    );
    const orgId = orgRes.rows[0]?.org_id;
    if (!orgId) return res.status(403).json({ error: { message: 'No org found for user' } });

    // Load file record
    const result = await pool.query(
      `SELECT id, provider, provider_file_id, user_id, file_name, web_url
       FROM storage_files WHERE id = $1 AND org_id = $2`,
      [req.params.recordId, orgId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    const file = result.rows[0];
    const provider = getProvider(file.provider);
    const accessToken = await provider._getAccessToken(file.user_id);

    if (file.provider === 'googledrive') {
      const url = `https://drive.google.com/file/d/${file.provider_file_id}/view?access_token=${accessToken}`;
      return res.json({ url });
    }

    if (file.provider === 'onedrive') {
      try {
        const shareRes = await axios.post(
          `https://graph.microsoft.com/v1.0/me/drive/items/${file.provider_file_id}/createLink`,
          { type: 'view', scope: 'anonymous' },
          { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        const link = shareRes.data?.link?.webUrl;
        if (link) return res.json({ url: link });
      } catch (e) {
        console.warn('[storage/open-url] OneDrive createLink failed, falling back to web_url:', e.message);
      }
      if (file.web_url) return res.json({ url: file.web_url });
      return res.status(404).json({ error: { message: 'No URL available for this file' } });
    }

    if (file.web_url) return res.json({ url: file.web_url });
    res.status(404).json({ error: { message: 'No URL available for this file' } });

  } catch (err) {
    console.error('[storage/open-url]', err.message);
    res.status(500).json({ error: { message: 'Failed to resolve file URL' } });
  }
});

// ── Resolve folder URL (POST — returns the parent folder URL for the source badge) ──
// For Google Drive: fetches parent folder ID via Drive API, returns folder URL.
// For OneDrive: returns the drive root URL.
router.post('/imported/:recordId/folder-url', async (req, res) => {
  try {
    const jwt    = require('jsonwebtoken');
    const { pool } = require('../config/database');
    const axios  = require('axios');

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: { message: 'No token provided' } });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: { message: 'Invalid or expired token' } });
    }

    const orgRes = await pool.query(
      `SELECT org_id FROM org_users WHERE user_id = $1 LIMIT 1`,
      [decoded.userId]
    );
    const orgId = orgRes.rows[0]?.org_id;
    if (!orgId) return res.status(403).json({ error: { message: 'No org found for user' } });

    const result = await pool.query(
      `SELECT id, provider, provider_file_id, user_id, web_url
       FROM storage_files WHERE id = $1 AND org_id = $2`,
      [req.params.recordId, orgId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'File not found' } });
    }

    const file = result.rows[0];
    const provider = getProvider(file.provider);
    const accessToken = await provider._getAccessToken(file.user_id);

    if (file.provider === 'googledrive') {
      try {
        // Fetch file metadata to get parent folder ID
        const metaRes = await axios.get(
          `https://www.googleapis.com/drive/v3/files/${file.provider_file_id}?fields=parents`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const parentId = metaRes.data?.parents?.[0];
        if (parentId) {
          return res.json({ url: `https://drive.google.com/drive/folders/${parentId}` });
        }
      } catch (e) {
        console.warn('[storage/folder-url] Could not fetch parent folder:', e.message);
      }
      // Fallback: open Drive root
      return res.json({ url: 'https://drive.google.com' });
    }

    if (file.provider === 'onedrive') {
      // OneDrive: open the drive root
      return res.json({ url: 'https://onedrive.live.com' });
    }

    res.json({ url: 'https://drive.google.com' });

  } catch (err) {
    console.error('[storage/folder-url]', err.message);
    res.status(500).json({ error: { message: 'Failed to resolve folder URL' } });
  }
});

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
