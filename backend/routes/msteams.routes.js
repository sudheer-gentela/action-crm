// ─────────────────────────────────────────────────────────────────────────────
// routes/msteams.routes.js
//
// DROP-IN LOCATION: backend/routes/msteams.routes.js
//
// Microsoft Teams connect, callback, status and triage.
//
// MOUNT IN server.js, beside the other integration routes:
//     app.use('/api/msteams', require('./routes/msteams.routes'));
//
// NAMED msteams AND NOT teams because routes/teams.routes.js already exists and
// means SALES TEAM HIERARCHY — it is mounted at /api/org/admin. Two files called
// teams.routes.js meaning different things is a bug waiting for a tired evening.
//
// ROUTES
//   GET  /connect              → { authUrl }         (authenticated)
//   GET  /admin-consent-url    → { url }             (authenticated, admin)
//   GET  /callback             → redirect            (NO AUTH — Entra calls it)
//   GET  /status               → connection + counts (authenticated)
//   GET  /conversations        → triage list         (authenticated)
//   POST /conversations/watch  → watch / unwatch     (authenticated)
//   POST /conversations/ignore → dismiss / restore   (authenticated)
//   POST /discover             → run discovery now   (authenticated)
//   POST /capture              → pause / resume      (authenticated)
//   POST /disconnect           → drop tokens         (authenticated)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const msteams = require('../services/msteams.service');
const graph   = require('../services/msteamsGraph.service');
const { adminConsentUrl } = require('../config/teamsScopes');
const { saveUserToken }   = require('../services/oauthTokenService');

function frontendUrl() {
  return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://app.gowarmcrm.com')
    .replace(/\/+$/, '');
}

// The callback is registered BEFORE the auth middleware because Entra calls it
// directly with no Authorization header. Everything after router.use is
// authenticated.

/**
 * OAuth callback — serves TWO different flows arriving at the same URL.
 *
 *   1. REP SIGN-IN     ?code=...&state=...
 *   2. ADMIN CONSENT   ?admin_consent=True&tenant=<guid>&state=...   (no code)
 *
 * They share a redirect_uri because Entra requires the admin-consent return to
 * be a registered redirect on the app, and registering a second one means a
 * second thing to keep in sync between the portal and Railway. Branching on the
 * presence of `code` is unambiguous — the admin-consent response never carries
 * one.
 *
 * The admin branch matters because the person who clicks it is frequently NOT
 * the rep who asked for it, and may have no GoWarmCRM account at all. So it
 * must not require a session, and it must not try to save a token: there is no
 * token in that response, only an assertion that the tenant approved the app.
 */
router.get('/callback', async (req, res) => {
  const fe = frontendUrl();
  const { code, state, admin_consent: adminConsent, tenant,
          error: oauthError, error_description: errorDesc } = req.query;

  if (oauthError) {
    console.error('[msteams] callback error:', oauthError, errorDesc);
    return res.redirect(
      `${fe}/?msteams_error=${encodeURIComponent(oauthError)}` +
      `&message=${encodeURIComponent(errorDesc || 'Teams authorization failed')}`
    );
  }

  // ── Admin consent return ────────────────────────────────────────────────
  if (!code && adminConsent) {
    const granted = String(adminConsent).toLowerCase() === 'true';
    console.log(`[msteams] admin consent ${granted ? 'granted' : 'declined'} for tenant ${tenant || 'unknown'}`);
    return res.redirect(
      granted
        ? `${fe}/?msteams_admin_consent=granted&tenant=${encodeURIComponent(tenant || '')}`
        : `${fe}/?msteams_error=admin_consent_declined`
    );
  }

  if (!code)  return res.redirect(`${fe}/?msteams_error=no_code`);
  if (!state) return res.redirect(`${fe}/?msteams_error=no_state`);

  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64').toString());
  } catch {
    return res.redirect(`${fe}/?msteams_error=invalid_state`);
  }

  const { userId, orgId, timestamp } = stateData;
  if (!userId || !orgId) return res.redirect(`${fe}/?msteams_error=invalid_state`);

  // A code is valid for minutes; a state older than fifteen is a replay or a
  // tab somebody left open on Tuesday. Cheap to check, and it keeps a stale
  // state from silently rebinding a connection to the wrong org.
  if (!timestamp || Date.now() - timestamp > 15 * 60 * 1000) {
    return res.redirect(`${fe}/?msteams_error=state_expired`);
  }

  try {
    const tokens = await graph.exchangeCode(code);

    // Identity BEFORE persisting the connection: a token we cannot resolve to
    // an Entra object id is useless later, because that id is what matches
    // chatMessage.from.user.id. Better to fail here than to store a connection
    // that can never attribute a sender.
    const me = await graph.getMe(tokens.access_token);

    await saveUserToken(userId, msteams.PROVIDER, {
      accessToken:   tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiresOn:     new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
    });

    await msteams.upsertConnection(orgId, userId, {
      tenantId:    graph.tenantIdFromToken(tokens.access_token),
      objectId:    me.id,
      upn:         me.userPrincipalName || me.mail || null,
      displayName: me.displayName || null,
    });

    return res.redirect(`${fe}/?msteams_connected=true`);
  } catch (err) {
    const detail = err.response?.data?.error_description || err.message;
    console.error('[msteams] callback failed:', detail);
    return res.redirect(
      `${fe}/?msteams_error=connect_failed&message=${encodeURIComponent(detail)}`
    );
  }
});

// ── Everything below is authenticated and org-scoped ────────────────────────

router.use(authenticateToken, orgContext);

/**
 * Start the connect flow.
 *
 * orgId comes from orgContext and is baked into the state rather than read back
 * from the callback's session — there is no session on the callback, and
 * trusting a client-supplied org there would be a cross-tenant write.
 */
router.get('/connect', async (req, res) => {
  try {
    const state = Buffer.from(JSON.stringify({
      userId:    req.userId,
      orgId:     req.orgId,
      timestamp: Date.now(),
    })).toString('base64');

    res.json({ authUrl: graph.buildAuthUrl(state) });
  } catch (err) {
    console.error('[msteams] connect:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * The URL a TENANT ADMIN visits once to approve this app org-wide.
 *
 * Needed because ChannelMessage.Read.All cannot be user-consented. Admin-only
 * here not because the URL is secret — it is not — but because sending it to
 * the customer's IT department is an act with organisational consequences, and
 * it should be traceable to someone who is allowed to perform it.
 */
router.get('/admin-consent-url', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const state = Buffer.from(JSON.stringify({
      orgId: req.orgId, timestamp: Date.now(),
    })).toString('base64');

    res.json({ url: adminConsentUrl(state) });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.get('/status', async (req, res) => {
  try {
    const conn = await msteams.getConnection(req.orgId, req.userId);
    if (!conn) return res.json({ connected: false });

    res.json({
      connected:      conn.status === 'connected',
      status:         conn.status,
      statusDetail:   conn.status_detail,
      captureEnabled: conn.capture_enabled,
      displayName:    conn.display_name,
      upn:            conn.entra_upn,
      connectedAt:    conn.connected_at,
      lastDiscoveryAt:    conn.last_discovery_at,
      lastDiscoveryError: conn.last_discovery_error,
      chatCount:      conn.discovered_chat_count,
      channelCount:   conn.discovered_channel_count,
    });
  } catch (err) {
    console.error('[msteams] status:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const result = await msteams.listTriage(req.orgId, req.userId, {
      status:  req.query.status || 'all',
      watched: req.query.watched === undefined ? null : req.query.watched === 'true',
      q:       req.query.q || null,
      limit:   req.query.limit,
      // Comma-separated, e.g. ?kinds=group,oneOnOne. An explicit list overrides
      // the meeting-chat default in listTriage.
      kinds:   req.query.kinds ? String(req.query.kinds).split(',').map(s => s.trim()) : null,
      includeMeetings: req.query.includeMeetings === 'true',
    });
    if (!result.ok) return res.status(result.code === 'NOT_CONNECTED' ? 404 : 400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[msteams] conversations:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/conversations/watch', async (req, res) => {
  try {
    const { conversationIds, watched = true } = req.body || {};
    const result = await msteams.setWatch(req.orgId, req.userId, conversationIds || [], watched);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[msteams] watch:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/conversations/ignore', async (req, res) => {
  try {
    const { conversationIds, ignored = true } = req.body || {};
    const result = await msteams.setIgnored(req.orgId, req.userId, conversationIds || [], ignored);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[msteams] ignore:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * Bind a conversation to a project, a vendor, or a pool of projects.
 *
 * body: { mode, handoverId?, accountId?, candidateIds?, force? }
 *
 * A 409 with code NEEDS_FORCE is not an error — it is the server asking the
 * user to confirm a transition that loses something, and the client is expected
 * to show the message and retry with force: true.
 */
router.post('/conversations/:id/bind', async (req, res) => {
  try {
    const result = await msteams.bindConversation(
      req.orgId, req.userId, parseInt(req.params.id, 10), req.body || {});
    if (!result.ok) {
      const status = result.code === 'NEEDS_FORCE' ? 409
                   : result.code === 'NOT_FOUND'   ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[msteams] bind:', err.message);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.post('/conversations/:id/unbind', async (req, res) => {
  try {
    const result = await msteams.unbindConversation(
      req.orgId, req.userId, parseInt(req.params.id, 10));
    if (!result.ok) return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[msteams] unbind:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * Run discovery immediately.
 *
 * The scheduler covers the normal case; this exists because "I was added to the
 * channel two minutes ago and it is not in the list" is the single most likely
 * first complaint, and the honest answer to it is a button rather than "wait an
 * hour".
 */
router.post('/discover', async (req, res) => {
  try {
    const conn = await msteams.getConnection(req.orgId, req.userId);
    if (!conn) return res.status(404).json({ error: { message: 'Teams is not connected.' } });

    const result = await msteams.discoverForConnection(conn);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[msteams] discover:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/capture', async (req, res) => {
  try {
    const row = await msteams.setCaptureEnabled(req.orgId, req.userId, !!req.body?.enabled);
    if (!row) return res.status(404).json({ error: { message: 'Teams is not connected.' } });
    res.json({ ok: true, captureEnabled: row.capture_enabled });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    const result = await msteams.disconnect(req.orgId, req.userId);
    if (!result.ok) return res.status(404).json({ error: { message: 'Teams is not connected.' } });
    res.json(result);
  } catch (err) {
    console.error('[msteams] disconnect:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
