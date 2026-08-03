// ─────────────────────────────────────────────────────────────────────────────
// routes/projectEmails.routes.js   → /api/project-emails
//
//  GET    /:handoverId/threads                     conversations on this project
//  POST   /:handoverId/threads                     file a conversation
//  DELETE /:handoverId/threads/:conversationId     unfile it
//  POST   /:handoverId/messages/:emailId/hide
//  POST   /:handoverId/messages/:emailId/unhide
//
// Mirrors /api/project-files. Reading the project's mail itself stays on
// GET /handovers/sales/:id/communications, which already merges email and
// WhatsApp into one timeline — a second reader would be a second place that
// decides what a project conversation is.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const svc               = require('../services/emailThreads.service');

router.use(authenticateToken);
router.use(orgContext);

const idOf = (v) => parseInt(v, 10);
const fail = (res, err, tag) => {
  console.error(`[project-emails:${tag}]`, err.message);
  res.status(err.status || 500).json({ error: { message: err.message } });
};

router.get('/:handoverId/threads', async (req, res) => {
  try {
    const handoverId = idOf(req.params.handoverId);
    res.json({
      ...(await svc.listThreads(handoverId, req.orgId)),
      canFile: await svc.canFile(handoverId, req.orgId, req.user.userId),
    });
  } catch (err) { fail(res, err, 'listThreads'); }
});

router.post('/:handoverId/threads', async (req, res) => {
  try {
    const { conversationId, emailId } = req.body || {};
    res.status(201).json(await svc.tagThread(
      idOf(req.params.handoverId), req.orgId, req.user.userId, { conversationId, emailId }
    ));
  } catch (err) { fail(res, err, 'tagThread'); }
});

router.delete('/:handoverId/threads/:conversationId', async (req, res) => {
  try {
    res.json(await svc.untagThread(
      idOf(req.params.handoverId), req.orgId, req.user.userId,
      decodeURIComponent(req.params.conversationId)
    ));
  } catch (err) { fail(res, err, 'untagThread'); }
});

router.post('/:handoverId/messages/:emailId/hide', async (req, res) => {
  try {
    res.json(await svc.hideMessage(
      idOf(req.params.handoverId), req.orgId, req.user.userId, idOf(req.params.emailId)));
  } catch (err) { fail(res, err, 'hide'); }
});

router.post('/:handoverId/messages/:emailId/unhide', async (req, res) => {
  try {
    res.json(await svc.unhideMessage(
      idOf(req.params.handoverId), req.orgId, req.user.userId, idOf(req.params.emailId)));
  } catch (err) { fail(res, err, 'unhide'); }
});

module.exports = router;
