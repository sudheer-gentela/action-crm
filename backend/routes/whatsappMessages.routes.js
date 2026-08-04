/**
 * whatsappMessages.routes.js
 *
 * DROP-IN LOCATION: backend/routes/whatsappMessages.routes.js
 *
 * Mount in server.js next to the other WhatsApp mounts:
 *   app.use('/api/whatsapp-messages', require('./routes/whatsappMessages.routes'));
 *
 * Backs the Communication → Messages screen.
 *
 * All routes: authenticateToken + orgContext. Authorisation is per-message and
 * lives in whatsappAccess.service — NOT in a role check here. A user reaches
 * these endpoints because they were in the WhatsApp group, which is an
 * entitlement they already hold on their phone.
 *
 *   GET  /search                     — participant-scoped search
 *   POST /diagnose                   — why a search found nothing
 *   POST /:id/file                   — file / move / un-file a message
 *   POST /:id/exclude                — mark as not CRM material
 *   GET  /audit                      — who moved what, when
 *
 *   GET  /capture-requests           — pending requests (admin)
 *   POST /capture-requests           — ask for a group to be captured
 *   POST /capture-requests/:id/decide — approve or decline (admin)
 *
 *   GET    /stewards                 — who can triage the unassigned queue
 *   POST   /stewards                 — grant (admin)
 *   DELETE /stewards/:userId         — revoke (admin)
 *   PUT    /identity/:userId         — set a user's WhatsApp number (admin)
 */

'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const search = require('../services/whatsappSearch.service');
const access = require('../services/whatsappAccess.service');

router.use(authenticateToken);
router.use(orgContext);

const fail = (res, e) => res.status(e.status || 500).json({ error: { message: e.message } });

// ── Search ───────────────────────────────────────────────────────────────────

router.get('/search', async (req, res) => {
  try {
    const result = await search.searchMessages(req.orgId, req.userId, {
      q:          req.query.q,
      from:       req.query.from,
      dateFrom:   req.query.dateFrom,
      dateTo:     req.query.dateTo,
      groupJid:   req.query.groupJid,
      handoverId: req.query.handoverId,
      scope:      req.query.scope || 'all',
      limit:      req.query.limit,
      offset:     req.query.offset,
    });
    if (!result.ok) return res.status(403).json(result);
    res.json(result);
  } catch (e) { fail(res, e); }
});

/**
 * Called when a search comes back empty. Separate from /search rather than
 * folded into it because the diagnosis costs several extra queries, and most
 * searches succeed — no reason to pay for it every time.
 */
router.post('/diagnose', async (req, res) => {
  try {
    res.json(await search.diagnose(req.orgId, req.userId, { q: req.body?.q }));
  } catch (e) { fail(res, e); }
});

// ── Filing ───────────────────────────────────────────────────────────────────

router.post('/:id/file', async (req, res) => {
  try {
    const { handoverId = null, scope = 'message' } = req.body || {};
    const result = await search.fileMessage(req.orgId, req.userId, parseInt(req.params.id, 10), {
      handoverId: handoverId == null ? null : parseInt(handoverId, 10),
      scope,
    });
    if (!result.ok) {
      const code = result.code === 'NOT_FOUND' ? 404
                 : String(result.code || '').includes('ACCESS') || result.code === 'CANNOT_UNASSIGN' ? 403
                 : 400;
      return res.status(code).json(result);
    }
    res.json(result);
  } catch (e) { fail(res, e); }
});

router.post('/:id/exclude', async (req, res) => {
  try {
    const result = await search.excludeMessage(
      req.orgId, req.userId, parseInt(req.params.id, 10), req.body?.reason || null
    );
    if (!result.ok) return res.status(result.code === 'NOT_FOUND' ? 404 : 403).json(result);
    res.json(result);
  } catch (e) { fail(res, e); }
});

// Disclosure trail. Not admin-gated: anyone who can see a project should be
// able to see how a message got there.
router.get('/audit', async (req, res) => {
  try {
    res.json({ moves: await search.recentMoves(req.orgId, { limit: req.query.limit }) });
  } catch (e) { fail(res, e); }
});

// ── Capture requests ─────────────────────────────────────────────────────────

router.post('/capture-requests', async (req, res) => {
  try {
    const { sessionGroupId, reason, suggestedHandoverId } = req.body || {};
    if (!sessionGroupId) return res.status(400).json({ error: { message: 'sessionGroupId required' } });
    const result = await search.requestCapture(req.orgId, req.userId, parseInt(sessionGroupId, 10), {
      reason, suggestedHandoverId: suggestedHandoverId ? parseInt(suggestedHandoverId, 10) : null,
    });
    if (!result.ok) return res.status(result.code === 'NOT_A_MEMBER' ? 403 : 400).json(result);
    res.status(201).json(result);
  } catch (e) { fail(res, e); }
});

router.get('/capture-requests', requireRole('admin'), async (req, res) => {
  try {
    res.json({ requests: await search.listCaptureRequests(req.orgId, { status: req.query.status }) });
  } catch (e) { fail(res, e); }
});

// Admin-gated because switching capture on is a data-retention decision about a
// room full of people, not a convenience toggle for the one who asked.
router.post('/capture-requests/:id/decide', requireRole('admin'), async (req, res) => {
  try {
    const { approve, note } = req.body || {};
    const result = await search.decideCaptureRequest(
      req.orgId, req.userId, parseInt(req.params.id, 10), { approve: !!approve, note }
    );
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) { fail(res, e); }
});

// ── Stewards & identity ──────────────────────────────────────────────────────

router.get('/stewards', async (req, res) => {
  try {
    const list = await access.listStewards(req.orgId);
    const me   = await access.isSteward(req.orgId, req.userId);
    res.json({ ...list, me });
  } catch (e) { fail(res, e); }
});

router.post('/stewards', requireRole('admin'), async (req, res) => {
  try {
    const { userId, note } = req.body || {};
    if (!userId) return res.status(400).json({ error: { message: 'userId required' } });
    const result = await access.grantSteward(req.orgId, req.userId, parseInt(userId, 10), note);
    if (!result.ok) return res.status(404).json(result);
    res.status(201).json(result);
  } catch (e) { fail(res, e); }
});

router.delete('/stewards/:userId', requireRole('admin'), async (req, res) => {
  try {
    const result = await access.revokeSteward(req.orgId, req.userId, parseInt(req.params.userId, 10));
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) { fail(res, e); }
});

/**
 * Admin-only, and it must stay that way. This column decides which WhatsApp
 * groups a user can read; if people could set their own, anyone could enter a
 * colleague's number and inherit their group access.
 */
// Org members plus their WhatsApp identity state. Admin-only: it exposes who
// holds which number, which is the map of who can read which groups.
router.get('/identity', requireRole('admin'), async (req, res) => {
  try {
    res.json({ users: await access.listIdentities(req.orgId) });
  } catch (e) { fail(res, e); }
});

router.put('/identity/:userId', requireRole('admin'), async (req, res) => {
  try {
    const result = await access.setUserWhatsAppPhone(
      req.orgId, req.userId, parseInt(req.params.userId, 10), req.body?.phone, { source: 'admin' }
    );
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) { fail(res, e); }
});

// Read-only view of your own linkage, so a user can see why search is empty
// without needing an admin to check for them.
router.get('/identity/me', async (req, res) => {
  try {
    const phone = await access.verifiedPhoneForUser(req.orgId, req.userId);
    const steward = await access.isSteward(req.orgId, req.userId);
    res.json({ verifiedPhone: phone, linked: !!phone, steward });
  } catch (e) { fail(res, e); }
});

module.exports = router;
