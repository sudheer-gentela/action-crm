/**
 * whatsapp.routes.js
 *
 * DROP-IN LOCATION: backend/routes/whatsapp.routes.js
 *
 * Mount in server.js (next to the slack mount):
 *   app.use('/api/whatsapp', require('./routes/whatsapp.routes'));
 *
 * All routes: authenticateToken + orgContext. Connect/disconnect require admin.
 *
 *   GET    /account                          — connection status (no secrets)
 *   POST   /connect                          — store WABA credentials (admin)
 *   DELETE /account                          — revoke connection (admin)
 *   GET    /handovers/:handoverId/thread     — thread + messages for a handover
 *   POST   /handovers/:handoverId/messages   — send a message on the handover thread
 */

'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const whatsapp = require('../services/whatsapp.service');

router.use(authenticateToken);
router.use(orgContext);

// ── Connection ───────────────────────────────────────────────────────────────

router.get('/account', async (req, res) => {
  try {
    res.json(await whatsapp.getStatus(req.orgId));
  } catch (e) {
    res.status(e.status || 500).json({ error: { message: e.message } });
  }
});

router.post('/connect', requireRole('admin'), async (req, res) => {
  try {
    const status = await whatsapp.connect(req.orgId, req.user.userId, req.body || {});
    res.json(status);
  } catch (e) {
    res.status(e.status || 500).json({ error: { message: e.message } });
  }
});

router.delete('/account', requireRole('admin'), async (req, res) => {
  try {
    res.json(await whatsapp.disconnect(req.orgId));
  } catch (e) {
    res.status(e.status || 500).json({ error: { message: e.message } });
  }
});

// ── Handover thread ──────────────────────────────────────────────────────────

router.get('/handovers/:handoverId/thread', async (req, res) => {
  try {
    const out = await whatsapp.listMessages(parseInt(req.params.handoverId, 10), req.orgId);
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: { message: e.message } });
  }
});

// Selectable recipients (group + individuals) for the composer's "To" picker.
router.get('/handovers/:handoverId/targets', async (req, res) => {
  try {
    const out = await whatsapp.listSendTargets(parseInt(req.params.handoverId, 10), req.orgId);
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: { message: e.message } });
  }
});

// Approved WhatsApp templates for this org (live from Meta), for the composer.
// Attach a conversation to a project by hand — for a sender the inference
// could not identify, or one that matched more than one project.
router.post('/threads/:threadId/link', async (req, res) => {
  try {
    const { handoverId, force } = req.body || {};
    if (!handoverId) return res.status(400).json({ error: { message: 'handoverId is required' } });
    res.json(await whatsapp.linkThreadToProject(
      parseInt(req.params.threadId, 10), req.orgId, parseInt(handoverId, 10), { force: !!force }
    ));
  } catch (err) {
    res.status(err.status || 500).json({ error: { message: err.message, code: err.status === 409 ? 'ALREADY_LINKED' : undefined } });
  }
});

// ── Moving a message between projects ────────────────────────────────────────
//
// The counterpart to /threads/:threadId/link. That moves the CONVERSATION;
// these move a MESSAGE — the correction for when inference put a reply on the
// wrong project, which one person on two projects makes possible.

// Where could this message go? A short, checked list, not every project.
router.get('/messages/:messageId/move-targets', async (req, res) => {
  try {
    res.json(await whatsapp.listMoveTargets(
      parseInt(req.params.messageId, 10), req.orgId, req.user.userId
    ));
  } catch (err) {
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// Body: { handoverId, scope?: 'message' | 'thread' }
// scope 'thread' also moves every sibling message filed the same way AND the
// conversation's owner — "this whole exchange is on the wrong project".
router.post('/messages/:messageId/move', async (req, res) => {
  try {
    const { handoverId, scope } = req.body || {};
    if (!handoverId) return res.status(400).json({ error: { message: 'handoverId is required' } });
    res.json(await whatsapp.moveMessage(
      parseInt(req.params.messageId, 10), req.orgId, req.user.userId,
      { handoverId: parseInt(handoverId, 10), scope: scope || 'message' }
    ));
  } catch (err) {
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.get('/templates', async (req, res) => {
  try {
    const out = await whatsapp.listApprovedTemplates(req.orgId);
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: { message: e.message, code: e.code } });
  }
});

// ── Groups (Groups API) ──────────────────────────────────────────────────────

// Create an API-managed WhatsApp group and mirror it as a group thread.
// Body: { subject, handoverId? }. Returns { threadId, groupId, inviteLink,
// maxParticipants }. Distribute inviteLink to members — join is opt-in only,
// there is no silent add, and the group is capped at 8 participants.
router.post('/groups', async (req, res) => {
  try {
    const result = await whatsapp.createGroup(req.orgId, req.user.userId, req.body || {});
    if (!result.ok) {
      const code = result.code === 'NOT_CONNECTED' ? 409
                 : result.code === 'OBA_REQUIRED'  ? 409
                 : 502;
      return res.status(code).json({ error: { code: result.code, message: result.error } });
    }
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: { message: e.message } });
  }
});

router.post('/handovers/:handoverId/messages', async (req, res) => {
  try {
    const result = await whatsapp.sendToHandover(
      parseInt(req.params.handoverId, 10), req.orgId, req.user.userId, req.body || {}
    );
    if (!result.ok) {
      // Typed adapter/service errors map to 409 (a policy/state problem, not a bug).
      const code = result.code === 'NOT_CONNECTED' ? 409
                 : result.code === 'WINDOW_CLOSED' ? 409
                 : result.code === 'OPTED_OUT'     ? 409
                 : 502;
      return res.status(code).json({ error: { code: result.code, message: result.error } });
    }
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: { message: e.message } });
  }
});

module.exports = router;
