// routes/linkedin-automation.routes.js
//
// Mount at: /api  (full subpaths declared below)
//
// The SETTINGS surface for optional LinkedIn connection-request auto-send.
// Distinct from /api/linkedin-autosend (the extension actuator surface).
//
//   GET   /api/org/linkedin-automation          — any authed member; effective
//                                                  org config (toggle + caps).
//                                                  Reps need it to see whether
//                                                  the org has enabled it.
//   PATCH /api/org/admin/linkedin-automation     — org admin only; update the
//                                                  master toggle + guardrails.
//   GET   /api/me/linkedin-auto-connect          — caller's opt-in + resolved
//                                                  effective state.
//   PUT   /api/me/linkedin-auto-connect          — caller sets their own opt-in.
//
// The effective switch for a rep is (org master toggle) AND (explicit user
// opt-in). A rep can opt in even while the org toggle is off (their choice is
// stored and simply has no effect until an admin enables it) — but the GET
// response makes the "blocked by org" state explicit so the UI can explain it.

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

const AutoConfig = require('../services/linkedinAutomationConfig');

router.use(authenticateToken);
router.use(orgContext);

// ── GET /org/linkedin-automation ────────────────────────────────────────────
// Effective merged org config. Read-only for non-admins (the UI hides the
// controls; this endpoint just lets reps see the org posture + guardrails).
router.get('/org/linkedin-automation', async (req, res) => {
  try {
    const config = await AutoConfig.getForOrg(req.orgId);
    res.json({ ok: true, config, limits: AutoConfig.LIMITS });
  } catch (err) {
    console.error('GET /org/linkedin-automation:', err);
    res.status(500).json({ error: { message: 'Failed to load LinkedIn automation config' } });
  }
});

// ── PATCH /org/admin/linkedin-automation ─────────────────────────────────────
// Org admin only. Validates + persists a partial patch (auto_connect_enabled,
// daily_cap, jitter_seconds, human_hours, lease_minutes). Returns the merged
// effective config.
router.patch('/org/admin/linkedin-automation', requireRole('admin'), async (req, res) => {
  try {
    const updated = await AutoConfig.setForOrg(req.orgId, req.body || {}, req.user.userId);
    console.log(`⚙️  linkedin-automation updated org=${req.orgId} by user=${req.user.userId} enabled=${updated.auto_connect_enabled}`);
    res.json({ ok: true, config: updated });
  } catch (err) {
    // Validation errors are user-facing 400s; anything else is a 500.
    const isValidation = /must be|exceeds|required|No valid fields|greater than|at least|at most/i.test(err.message || '');
    res.status(isValidation ? 400 : 500).json({ error: { message: err.message } });
  }
});

// ── GET /me/linkedin-auto-connect ─────────────────────────────────────────────
// The caller's stored opt-in (true / false / null=never chose) PLUS the resolved
// effective state, so the UI can show e.g. "You opted in, but your admin hasn't
// enabled it org-wide yet."
router.get('/me/linkedin-auto-connect', async (req, res) => {
  try {
    const optIn = await AutoConfig.getUserOptIn(db, { userId: req.user.userId, orgId: req.orgId });
    const gate  = await AutoConfig.resolveForUser(db, { orgId: req.orgId, userId: req.user.userId });
    res.json({
      ok: true,
      opted_in: optIn,                      // true | false | null (unset)
      effective_enabled: gate.enabled,      // org toggle AND opt-in
      org_enabled: gate.org.auto_connect_enabled,
      source: gate.source,                  // user | user_off | system | org_off
    });
  } catch (err) {
    console.error('GET /me/linkedin-auto-connect:', err);
    res.status(500).json({ error: { message: 'Failed to load opt-in state' } });
  }
});

// ── PUT /me/linkedin-auto-connect ─────────────────────────────────────────────
// body: { opted_in: boolean }. Stores the rep's explicit, affirmative choice.
router.put('/me/linkedin-auto-connect', async (req, res) => {
  const optedIn = req.body?.opted_in;
  if (typeof optedIn !== 'boolean') {
    return res.status(400).json({ error: { message: 'opted_in must be a boolean' } });
  }
  try {
    const val  = await AutoConfig.setUserOptIn(db, { userId: req.user.userId, orgId: req.orgId }, optedIn);
    const gate = await AutoConfig.resolveForUser(db, { orgId: req.orgId, userId: req.user.userId });
    console.log(`⚙️  linkedin-auto-connect opt-in org=${req.orgId} user=${req.user.userId} → ${val}`);
    res.json({ ok: true, opted_in: val, effective_enabled: gate.enabled, source: gate.source });
  } catch (err) {
    console.error('PUT /me/linkedin-auto-connect:', err);
    res.status(500).json({ error: { message: 'Failed to save opt-in' } });
  }
});

module.exports = router;
