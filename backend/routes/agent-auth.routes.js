// routes/agent-auth.routes.js
// Standalone Connect bridge — completes the AuthKit OAuth flow for MCP/agent
// clients by binding AuthKit's external_auth_id to the signed-in GoWarmCRM user.
//
// Mount in server.js (with the other /api routes):
//   app.use('/api/agent-auth', require('./routes/agent-auth.routes'));
//
// Env var required:
//   WORKOS_API_KEY   (your WorkOS secret API key — server-side only)
//
// Flow: the frontend bridge page authenticates the user (your existing JWT),
// then POSTs { external_auth_id } here with the user's Bearer token. We look up
// the user, call AuthKit's completion API, and return the redirect_uri the
// frontend sends the browser to.

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

const WORKOS_API_KEY = process.env.WORKOS_API_KEY;
const WORKOS_COMPLETE_URL = 'https://api.workos.com/authkit/oauth2/complete';

router.post('/complete', authenticateToken, async (req, res) => {
  const { external_auth_id } = req.body || {};

  if (!external_auth_id) {
    return res.status(400).json({ error: { message: 'external_auth_id is required' } });
  }
  if (!WORKOS_API_KEY) {
    console.error('[agent-auth] WORKOS_API_KEY is not configured');
    return res.status(500).json({ error: { message: 'Agent auth is not configured' } });
  }

  try {
    // req.userId is set by authenticateToken (JWT 'userId' claim).
    const result = await db.query(
      'SELECT id, email, first_name, last_name FROM users WHERE id = $1',
      [req.userId]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const workosResp = await fetch(WORKOS_COMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WORKOS_API_KEY}`,
      },
      body: JSON.stringify({
        external_auth_id,
        user: {
          id: String(user.id),
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
        },
      }),
    });

    if (!workosResp.ok) {
      const detail = await workosResp.text();
      console.error('[agent-auth] WorkOS completion failed:', workosResp.status, detail);
      // Invalid/expired external_auth_id is the common case here.
      return res.status(502).json({ error: { message: 'Could not complete agent authorization. Please retry the connection from your agent.' } });
    }

    const { redirect_uri } = await workosResp.json();
    return res.json({ redirect_uri });
  } catch (err) {
    console.error('[agent-auth] complete error:', err.message);
    return res.status(500).json({ error: { message: 'Agent authorization error' } });
  }
});

module.exports = router;
