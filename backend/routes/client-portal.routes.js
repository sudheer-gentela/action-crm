/**
 * client-portal.routes.js
 *
 * Public-facing portal routes — no JWT required.
 * Auth is via magic link token only.
 *
 * Mount at: app.use('/api/portal', clientPortalRoutes)
 *
 * Endpoints
 * ─────────────────────────────────────────────────────────────────────────────
 * POST   /auth/magic-link            exchange magic token → session token
 * GET    /me                         get current portal user info
 * GET    /dashboard                  full read-only dashboard for the client
 * POST   /cases                      raise a support case (optional)
 */

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { pool } = require('../config/database');

const JWT_SECRET  = process.env.JWT_SECRET || 'changeme';
const PORTAL_EXPIRY = '7d';

// ── Portal auth middleware ─────────────────────────────────────────────────────
// Verifies the portal JWT (different from the main app JWT — carries clientId)
function portalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: { message: 'Portal authentication required' } });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'portal') {
      return res.status(401).json({ error: { message: 'Invalid portal token' } });
    }
    req.portalUser = decoded; // { portalUserId, clientId, orgId, email, type: 'portal' }
    next();
  } catch {
    res.status(401).json({ error: { message: 'Portal session expired — please use your magic link again' } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/magic-link — exchange token → portal JWT session
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auth/magic-link', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: { message: 'token is required' } });

  try {
    const { rows } = await pool.query(
      `SELECT cpu.*, c.name AS client_name, c.org_id
         FROM client_portal_users cpu
         JOIN clients c ON c.id = cpu.client_id
        WHERE cpu.magic_token = $1
          AND cpu.is_active = true
          AND cpu.magic_token_expires_at > NOW()`,
      [token]
    );

    if (!rows.length) {
      return res.status(401).json({
        error: { message: 'This link has expired or is invalid. Please ask your account manager to resend.' }
      });
    }

    const user = rows[0];

    // Mark as accepted + record login + clear magic token (one-time use)
    await pool.query(
      `UPDATE client_portal_users
          SET accepted_at   = COALESCE(accepted_at, NOW()),
              last_login_at = NOW(),
              magic_token   = NULL,
              magic_token_expires_at = NULL,
              updated_at    = NOW()
        WHERE id = $1`,
      [user.id]
    );

    // Issue portal JWT
    const sessionToken = jwt.sign(
      {
        type:         'portal',
        portalUserId: user.id,
        clientId:     user.client_id,
        orgId:        user.org_id,
        email:        user.email,
        clientName:   user.client_name,
      },
      JWT_SECRET,
      { expiresIn: PORTAL_EXPIRY }
    );

    res.json({
      token:      sessionToken,
      portalUser: {
        id:         user.id,
        email:      user.email,
        firstName:  user.first_name,
        lastName:   user.last_name,
        clientId:   user.client_id,
        clientName: user.client_name,
      },
    });
  } catch (err) {
    console.error('POST /portal/auth/magic-link', err);
    res.status(500).json({ error: { message: 'Authentication failed' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /me — current portal user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', portalAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cpu.id, cpu.email, cpu.first_name, cpu.last_name,
              cpu.last_login_at, c.name AS client_name, c.logo_url
         FROM client_portal_users cpu
         JOIN clients c ON c.id = cpu.client_id
        WHERE cpu.id = $1 AND cpu.is_active = true`,
      [req.portalUser.portalUserId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'User not found' } });
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load user' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /dashboard — full client dashboard (read-only, portal-scoped)
// Identical data to the internal dashboard but no team details exposed
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', portalAuth, async (req, res) => {
  const { clientId, orgId } = req.portalUser;
  const { weeks = 8 } = req.query;

  try {
    // Client info
    const clientRes = await pool.query(
      `SELECT c.name, c.logo_url, c.service_start_date, c.status,
              a.name AS account_name, a.industry
         FROM clients c
         LEFT JOIN accounts a ON a.id = c.account_id
        WHERE c.id = $1 AND c.org_id = $2 AND c.portal_enabled = true`,
      [clientId, orgId]
    );
    if (!clientRes.rows.length) {
      return res.status(403).json({ error: { message: 'Portal access is not enabled for this client' } });
    }

    // Pipeline by stage
    const pipelineRes = await pool.query(
      `SELECT stage, COUNT(*)::int AS count
         FROM prospects
        WHERE client_id = $1 AND org_id = $2 AND deleted_at IS NULL
        GROUP BY stage ORDER BY stage`,
      [clientId, orgId]
    );

    // Outreach stats
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const outreachRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE e.direction = 'sent')::int                            AS total_sent,
         COUNT(*) FILTER (WHERE e.direction IN ('received','inbound'))::int           AS total_replies,
         COUNT(*) FILTER (WHERE e.direction = 'sent' AND e.sent_at >= $3)::int        AS sent_this_week,
         COUNT(*) FILTER (WHERE e.direction IN ('received','inbound') AND e.sent_at >= $3)::int AS replies_this_week
       FROM emails e
       JOIN prospects p ON p.id = e.prospect_id
       WHERE p.client_id = $1 AND e.org_id = $2`,
      [clientId, orgId, weekStart]
    );

    // Sequence performance — join via enrollments→prospects (org-wide sequences)
    const seqRes = await pool.query(
      `SELECT s.name,
         COUNT(DISTINCT se.id)::int                                         AS enrolled,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status='replied')::int     AS replied,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status='active')::int      AS active,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status='completed')::int   AS completed,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status='stopped')::int     AS stopped
       FROM sequences s
       JOIN sequence_enrollments se ON se.sequence_id = s.id
       JOIN prospects p             ON p.id = se.prospect_id
       WHERE p.client_id = $1
         AND s.org_id    = $2
         AND p.org_id    = $2
         AND p.deleted_at IS NULL
       GROUP BY s.id, s.name
       ORDER BY enrolled DESC`,
      [clientId, orgId]
    );

    // Prospects (read-only — no emails, no internal notes)
    const prospectsRes = await pool.query(
      `SELECT p.first_name, p.last_name, p.title, p.stage,
              p.outreach_count, p.last_outreach_at,
              a.name AS account_name
         FROM prospects p
         LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.client_id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL
        ORDER BY p.stage, p.last_name`,
      [clientId, orgId]
    );

    // Weekly trend
    const trendRes = await pool.query(
      `SELECT
         DATE_TRUNC('week', e.sent_at)                           AS week_start,
         COUNT(*) FILTER (WHERE e.direction = 'sent')::int       AS sent,
         COUNT(*) FILTER (WHERE e.direction IN ('received','inbound'))::int AS replies
       FROM emails e
       JOIN prospects p ON p.id = e.prospect_id
       WHERE p.client_id = $1 AND e.org_id = $2
         AND e.sent_at >= NOW() - ($3 || ' weeks')::interval
       GROUP BY DATE_TRUNC('week', e.sent_at)
       ORDER BY week_start ASC`,
      [clientId, orgId, parseInt(weeks)]
    );

    // Open cases (if any)
    const casesRes = await pool.query(
      `SELECT id, title, status, priority, created_at
         FROM cases
        WHERE client_id = $1 AND org_id = $2
          AND status != 'closed'
        ORDER BY created_at DESC
        LIMIT 10`,
      [clientId, orgId]
    );

    const outreach = outreachRes.rows[0];

    res.json({
      client:     clientRes.rows[0],
      pipeline:   pipelineRes.rows,
      outreach: {
        totalSent:       parseInt(outreach.total_sent)        || 0,
        totalReplies:    parseInt(outreach.total_replies)     || 0,
        sentThisWeek:    parseInt(outreach.sent_this_week)    || 0,
        repliesThisWeek: parseInt(outreach.replies_this_week) || 0,
        replyRate: outreach.total_sent > 0
          ? ((outreach.total_replies / outreach.total_sent) * 100).toFixed(1)
          : '0.0',
      },
      sequences:   seqRes.rows,
      prospects:   prospectsRes.rows,
      weeklyTrend: trendRes.rows,
      openCases:   casesRes.rows,
    });
  } catch (err) {
    console.error('GET /portal/dashboard', err);
    res.status(500).json({ error: { message: 'Failed to load dashboard' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /cases — raise a support case from the portal
// ─────────────────────────────────────────────────────────────────────────────
router.post('/cases', portalAuth, async (req, res) => {
  const { title, description, priority = 'medium' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: { message: 'title is required' } });

  try {
    const { rows } = await pool.query(
      `INSERT INTO cases
         (org_id, client_id, title, description, priority, status, source)
       VALUES ($1, $2, $3, $4, $5, 'open', 'client_portal')
       RETURNING id, title, status, priority, created_at`,
      [req.portalUser.orgId, req.portalUser.clientId,
       title.trim(), description || null, priority]
    );
    res.status(201).json({ case: rows[0] });
  } catch (err) {
    console.error('POST /portal/cases', err);
    res.status(500).json({ error: { message: 'Failed to create case' } });
  }
});

module.exports = router;
