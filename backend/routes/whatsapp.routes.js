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
