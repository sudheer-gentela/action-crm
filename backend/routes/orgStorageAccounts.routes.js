// ─────────────────────────────────────────────────────────────────────────────
// routes/orgStorageAccounts.routes.js   → /api/org-storage
//
//  GET    /                       both providers' accounts (never tokens)
//  POST   /:provider              store the credential after OAuth
//  DELETE /:provider              disconnect
//  GET    /:handoverId/target     where a project's attachments would go
//
// Tokens are never returned by any route here. getCredential is internal to the
// service and is what the uploader uses.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const svc               = require('../services/orgStorageAccounts.service');

router.use(authenticateToken);
router.use(orgContext);

const fail = (res, err, tag) => {
  console.error(`[org-storage:${tag}]`, err.message);
  res.status(err.status || 500).json({ error: { message: err.message } });
};

router.get('/', async (req, res) => {
  try { res.json(await svc.list(req.orgId)); }
  catch (err) { fail(res, err, 'list'); }
});

router.post('/:provider', async (req, res) => {
  try {
    const { email, label, accessToken, refreshToken, expiresAt, accountData } = req.body || {};
    res.status(201).json(await svc.connect(
      req.orgId, req.user.userId, req.params.provider,
      { email, label, accessToken, refreshToken, expiresAt, accountData }
    ));
  } catch (err) { fail(res, err, 'connect'); }
});

router.delete('/:provider', async (req, res) => {
  try { res.json(await svc.disconnect(req.orgId, req.user.userId, req.params.provider)); }
  catch (err) { fail(res, err, 'disconnect'); }
});

// Lets the project UI say "attachments go to Delivery Docs" — or explain why
// they are not being saved, which is the state that must never be silent.
router.get('/projects/:handoverId/target', async (req, res) => {
  try {
    const t = await svc.resolveUploadTarget(req.orgId, parseInt(req.params.handoverId, 10));
    if (!t) return res.json({ target: null, reason: 'no_upload_target_or_storage' });
    res.json({
      target: {
        provider: t.provider, folderId: t.folderId,
        folderName: t.folderName, captureMode: t.captureMode,
      },
    });
  } catch (err) { fail(res, err, 'target'); }
});

module.exports = router;
