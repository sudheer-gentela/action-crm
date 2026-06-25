// routes/slack.routes.js
//
// Mount in server.js: app.use('/api/slack', require('./routes/slack.routes'));
//
// Endpoints (mirrors hubspot.routes.js):
//   GET  /api/slack/connect      → { success, authUrl }  (admin starts the install)
//   GET  /api/slack/callback     → OAuth redirect target  (PUBLIC — no auth)
//   GET  /api/slack/status       → { success, data: { connected, team_name, … } }
//   POST /api/slack/disconnect   → revoke + mark install revoked  (admin)
//   GET  /api/slack/debug-env    → env var presence check (remove after setup)

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const slackAuth = require('../services/slack.auth');

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://app.gowarmcrm.com';
const adminOnly = requireRole('owner', 'admin');

// ── Public: OAuth callback ────────────────────────────────────────────────────
// Slack redirects the admin's browser here after they approve the install. No
// auth token is present (it's a top-level browser navigation) — the signed
// `state` is what binds this back to the right org/user.
router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(`${FRONTEND_URL}/?error=slack_auth_failed&message=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/?error=slack_auth_failed&message=missing_params`);
  }

  try {
    await slackAuth.exchangeCode(code, state);
    return res.redirect(`${FRONTEND_URL}/?slack_connected=true`);
  } catch (err) {
    console.error('Slack OAuth callback error:', err.message);
    return res.redirect(`${FRONTEND_URL}/?error=slack_auth_failed&message=${encodeURIComponent(err.message)}`);
  }
});

// ── Authed routes ─────────────────────────────────────────────────────────────
router.use(authenticateToken);
router.use(orgContext);

// GET /connect — admin only. Returns the Slack authorize URL; the frontend does
// the redirect (same shape as hubspotAPI.getAuthUrl()).
router.get('/connect', adminOnly, async (req, res) => {
  try {
    const authUrl = slackAuth.getAuthUrl(req.user.userId, req.orgId);
    res.json({ success: true, authUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /status — any authed member can see whether Slack is connected (so the
// per-user notification toggles know whether to show).
router.get('/status', async (req, res) => {
  try {
    const data = await slackAuth.getInstallStatus(req.orgId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /disconnect — admin only.
router.post('/disconnect', adminOnly, async (req, res) => {
  try {
    await slackAuth.revokeInstall(req.orgId);
    res.json({ success: true, message: 'Slack disconnected' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /debug-env — TEMPORARY: remove after confirming env vars on Railway.
router.get('/debug-env', adminOnly, async (req, res) => {
  res.json({
    SLACK_CLIENT_ID:     process.env.SLACK_CLIENT_ID     ? '✅ set' : '❌ missing',
    SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET ? '✅ set' : '❌ missing',
    SLACK_REDIRECT_URI:  process.env.SLACK_REDIRECT_URI  ? '✅ set' : '❌ missing',
    SLACK_REDIRECT_URI_VALUE: process.env.SLACK_REDIRECT_URI || null,
  });
});

module.exports = router;
