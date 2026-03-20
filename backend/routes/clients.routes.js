/**
 * clients.routes.js
 *
 * Agency / Client Management — internal routes for ABC Corp users
 *
 * Mount at: app.use('/api/clients', clientsRoutes)
 *
 * Endpoints
 * ─────────────────────────────────────────────────────────────────────────────
 * GET    /                          list all clients for org
 * POST   /                          create client (from existing account)
 * GET    /:id                       get client detail + team + stats
 * PUT    /:id                       update client
 * DELETE /:id                       archive client
 *
 * POST   /:id/team                  assign team member
 * DELETE /:id/team/:userId          remove team member
 *
 * POST   /:id/prospects/assign      bulk-assign prospects to client
 * POST   /:id/accounts/assign       bulk-assign accounts to client
 *
 * GET    /:id/portal-users          list portal users
 * POST   /:id/portal-users          invite a portal user (sends magic link email)
 * DELETE /:id/portal-users/:userId  revoke portal access
 * POST   /:id/portal-users/:userId/resend  resend invite
 *
 * POST   /:id/report-token          regenerate report token
 * GET    /:id/dashboard             full client dashboard data (internal)
 *
 * GET    /all/prospects             all prospects across all clients (optional ?client_id=)
 * GET    /all/sequences             all sequences with per-client stats (optional ?client_id=)
 * GET    /:id/available-members     org members not yet on this client's team
 *
 * ── Client sender accounts (Model B) ─────────────────────────────────────────
 * GET    /:id/senders               list sender accounts for a client
 * GET    /:id/senders/connect-url   generate OAuth URL (?provider=gmail|outlook&label=...)
 * PATCH  /:id/senders/:senderId     update label / limits / active / display_name / signature
 * DELETE /:id/senders/:senderId     remove a client sender account
 */

const express           = require('express');
const router            = express.Router();
const crypto            = require('crypto');
const { pool }          = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');

// Google + Outlook OAuth helpers (reuse existing services)
const { getAuthUrl: getGoogleAuthUrl }  = require('../services/googleService');
const { getAuthUrl: getOutlookAuthUrl } = require('../services/outlookService');

router.use(authenticateToken, orgContext);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Verify that a client exists, belongs to req.orgId, and is not archived.
 * Returns the client row or throws with a 404 response.
 */
async function requireClient(req, res, clientId) {
  const { rows } = await pool.query(
    `SELECT id FROM clients WHERE id=$1 AND org_id=$2 AND archived_at IS NULL`,
    [clientId, req.orgId]
  );
  if (!rows.length) {
    res.status(404).json({ error: { message: 'Client not found' } });
    return null;
  }
  return rows[0];
}

/** Map a prospecting_sender_accounts row for API responses. Tokens never returned. */
function mapSenderRow(row) {
  return {
    id:              row.id,
    orgId:           row.org_id,
    clientId:        row.client_id,
    provider:        row.provider,
    email:           row.email,
    label:           row.label,
    isActive:        row.is_active,
    dailyLimit:      row.daily_limit,
    minDelayMinutes: row.min_delay_minutes,
    emailsSentToday: row.emails_sent_today,
    lastResetAt:     row.last_reset_at,
    lastSentAt:      row.last_sent_at,
    displayName:     row.display_name,
    signature:       row.signature,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list all clients
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status = 'active' } = req.query;
    const { rows } = await pool.query(
      `SELECT
         c.*,
         a.name          AS account_name,
         a.domain        AS account_domain,
         a.industry      AS account_industry,
         COUNT(DISTINCT p.id)::int   AS prospect_count,
         COUNT(DISTINCT ctm.user_id)::int AS team_size,
         COUNT(DISTINCT cpu.id) FILTER (WHERE cpu.accepted_at IS NOT NULL)::int AS portal_user_count
       FROM clients c
       LEFT JOIN accounts             a   ON a.id   = c.account_id
       LEFT JOIN prospects            p   ON p.client_id = c.id AND p.deleted_at IS NULL
       LEFT JOIN client_team_members  ctm ON ctm.client_id = c.id
       LEFT JOIN client_portal_users  cpu ON cpu.client_id = c.id AND cpu.is_active = true
       WHERE c.org_id = $1
         AND c.archived_at IS NULL
         ${status !== 'all' ? `AND c.status = $2` : ''}
       GROUP BY c.id, a.name, a.domain, a.industry
       ORDER BY c.created_at DESC`,
      status !== 'all' ? [req.orgId, status] : [req.orgId]
    );
    res.json({ clients: rows });
  } catch (err) {
    console.error('GET /clients', err);
    res.status(500).json({ error: { message: 'Failed to load clients' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST / — create client
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { account_id, name, service_start_date, service_notes, logo_url } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: { message: 'name is required' } });

  try {
    const reportToken = generateToken();
    const { rows } = await pool.query(
      `INSERT INTO clients
         (org_id, account_id, name, service_start_date, service_notes,
          logo_url, report_token, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.orgId, account_id || null, name.trim(),
       service_start_date || null, service_notes || null,
       logo_url || null, reportToken, req.user.userId]
    );

    // If account_id given, stamp client_id back onto the account
    if (account_id) {
      await pool.query(
        `UPDATE accounts SET client_id = $1 WHERE id = $2 AND org_id = $3`,
        [rows[0].id, account_id, req.orgId]
      );
    }

    res.status(201).json({ client: rows[0] });
  } catch (err) {
    console.error('POST /clients', err);
    res.status(500).json({ error: { message: 'Failed to create client' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — client detail
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const clientRes = await pool.query(
      `SELECT c.*, a.name AS account_name, a.domain AS account_domain,
              a.industry AS account_industry
         FROM clients c
         LEFT JOIN accounts a ON a.id = c.account_id
        WHERE c.id = $1 AND c.org_id = $2 AND c.archived_at IS NULL`,
      [req.params.id, req.orgId]
    );
    if (!clientRes.rows.length) return res.status(404).json({ error: { message: 'Client not found' } });

    const teamRes = await pool.query(
      `SELECT ctm.*, u.first_name, u.last_name, u.email
         FROM client_team_members ctm
         JOIN users u ON u.id = ctm.user_id
        WHERE ctm.client_id = $1
        ORDER BY ctm.role DESC, u.first_name`,
      [req.params.id]
    );

    const portalRes = await pool.query(
      `SELECT id, email, first_name, last_name, role,
              invited_at, accepted_at, last_login_at, is_active
         FROM client_portal_users
        WHERE client_id = $1
        ORDER BY created_at DESC`,
      [req.params.id]
    );

    res.json({
      client:       clientRes.rows[0],
      team:         teamRes.rows,
      portalUsers:  portalRes.rows,
    });
  } catch (err) {
    console.error('GET /clients/:id', err);
    res.status(500).json({ error: { message: 'Failed to load client' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — update client
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { name, status, service_start_date, service_notes, logo_url, portal_enabled } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE clients
          SET name               = COALESCE($1, name),
              status             = COALESCE($2, status),
              service_start_date = COALESCE($3, service_start_date),
              service_notes      = COALESCE($4, service_notes),
              logo_url           = COALESCE($5, logo_url),
              portal_enabled     = COALESCE($6, portal_enabled),
              updated_at         = NOW()
        WHERE id = $7 AND org_id = $8 AND archived_at IS NULL
        RETURNING *`,
      [name || null, status || null, service_start_date || null,
       service_notes || null, logo_url || null,
       portal_enabled !== undefined ? portal_enabled : null,
       req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Client not found' } });
    res.json({ client: rows[0] });
  } catch (err) {
    console.error('PUT /clients/:id', err);
    res.status(500).json({ error: { message: 'Failed to update client' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — archive client
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(
      `UPDATE clients SET archived_at = NOW(), status = 'archived', updated_at = NOW()
        WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /clients/:id', err);
    res.status(500).json({ error: { message: 'Failed to archive client' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEAM
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/team', async (req, res) => {
  const { user_id, role = 'member' } = req.body;
  if (!user_id) return res.status(400).json({ error: { message: 'user_id is required' } });
  try {
    const { rows } = await pool.query(
      `INSERT INTO client_team_members (client_id, user_id, role, assigned_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_id, user_id) DO UPDATE SET role = $3
       RETURNING *`,
      [req.params.id, user_id, role, req.user.userId]
    );
    res.status(201).json({ member: rows[0] });
  } catch (err) {
    console.error('POST /clients/:id/team', err);
    res.status(500).json({ error: { message: 'Failed to assign team member' } });
  }
});

router.delete('/:id/team/:userId', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM client_team_members WHERE client_id=$1 AND user_id=$2`,
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to remove team member' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BULK ASSIGN PROSPECTS / ACCOUNTS
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/prospects/assign', async (req, res) => {
  const { prospect_ids } = req.body;
  if (!Array.isArray(prospect_ids) || !prospect_ids.length)
    return res.status(400).json({ error: { message: 'prospect_ids[] required' } });
  try {
    await pool.query(
      `UPDATE prospects SET client_id = $1, updated_at = NOW()
        WHERE id = ANY($2::int[]) AND org_id = $3`,
      [req.params.id, prospect_ids, req.orgId]
    );
    res.json({ ok: true, updated: prospect_ids.length });
  } catch (err) {
    console.error('POST /clients/:id/prospects/assign', err);
    res.status(500).json({ error: { message: 'Failed to assign prospects' } });
  }
});

router.post('/:id/accounts/assign', async (req, res) => {
  const { account_ids } = req.body;
  if (!Array.isArray(account_ids) || !account_ids.length)
    return res.status(400).json({ error: { message: 'account_ids[] required' } });
  try {
    await pool.query(
      `UPDATE accounts SET client_id = $1, updated_at = NOW()
        WHERE id = ANY($2::int[]) AND org_id = $3`,
      [req.params.id, account_ids, req.orgId]
    );
    res.json({ ok: true, updated: account_ids.length });
  } catch (err) {
    console.error('POST /clients/:id/accounts/assign', err);
    res.status(500).json({ error: { message: 'Failed to assign accounts' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PORTAL USERS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/portal-users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, first_name, last_name, role,
              invited_at, accepted_at, last_login_at, is_active
         FROM client_portal_users
        WHERE client_id = $1
        ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ portalUsers: rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load portal users' } });
  }
});

router.post('/:id/portal-users', async (req, res) => {
  const { email, first_name, last_name } = req.body;
  if (!email?.trim()) return res.status(400).json({ error: { message: 'email is required' } });

  try {
    // Verify client belongs to org
    const clientRes = await pool.query(
      `SELECT id, name, org_id FROM clients WHERE id=$1 AND org_id=$2 AND archived_at IS NULL`,
      [req.params.id, req.orgId]
    );
    if (!clientRes.rows.length) return res.status(404).json({ error: { message: 'Client not found' } });
    const client = clientRes.rows[0];

    const inviteToken = generateToken();
    const magicToken  = generateToken();
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const { rows } = await pool.query(
      `INSERT INTO client_portal_users
         (client_id, org_id, email, first_name, last_name,
          invite_token, magic_token, magic_token_expires_at, invited_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (client_id, email) DO UPDATE
         SET invite_token = $6, magic_token = $7,
             magic_token_expires_at = $8,
             invited_at = NOW(), is_active = true,
             first_name = COALESCE($4, client_portal_users.first_name),
             last_name  = COALESCE($5, client_portal_users.last_name)
       RETURNING *`,
      [req.params.id, req.orgId, email.trim().toLowerCase(),
       first_name || null, last_name || null,
       inviteToken, magicToken, expiresAt]
    );

    const portalUser = rows[0];
    const magicLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/portal/auth?token=${magicToken}`;
    console.log(`📧 Portal invite for ${email} (${client.name}): ${magicLink}`);

    res.status(201).json({
      portalUser: {
        id:          portalUser.id,
        email:       portalUser.email,
        first_name:  portalUser.first_name,
        last_name:   portalUser.last_name,
        invited_at:  portalUser.invited_at,
        accepted_at: portalUser.accepted_at,
        is_active:   portalUser.is_active,
      },
      magicLink,
    });
  } catch (err) {
    console.error('POST /clients/:id/portal-users', err);
    res.status(500).json({ error: { message: 'Failed to invite portal user' } });
  }
});

router.post('/:id/portal-users/:userId/resend', async (req, res) => {
  try {
    const magicToken = generateToken();
    const expiresAt  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(
      `UPDATE client_portal_users
          SET magic_token = $1, magic_token_expires_at = $2,
              invited_at = NOW(), updated_at = NOW()
        WHERE id = $3 AND client_id = $4
        RETURNING email, first_name`,
      [magicToken, expiresAt, req.params.userId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Portal user not found' } });

    const magicLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/portal/auth?token=${magicToken}`;
    console.log(`📧 Resend portal invite for ${rows[0].email}: ${magicLink}`);

    res.json({ ok: true, magicLink });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to resend invite' } });
  }
});

router.delete('/:id/portal-users/:userId', async (req, res) => {
  try {
    await pool.query(
      `UPDATE client_portal_users SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND client_id = $2`,
      [req.params.userId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to revoke access' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORT TOKEN — regenerate
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/report-token', async (req, res) => {
  try {
    const newToken = generateToken();
    const { rows } = await pool.query(
      `UPDATE clients SET report_token = $1, updated_at = NOW()
        WHERE id = $2 AND org_id = $3
        RETURNING report_token`,
      [newToken, req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Client not found' } });
    res.json({ reportToken: rows[0].report_token });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to regenerate token' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — full client stats (internal, for ABC Corp users)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/dashboard', async (req, res) => {
  try {
    const { weeks = 8 } = req.query;

    // Verify client
    const clientRes = await pool.query(
      `SELECT c.*, a.name AS account_name FROM clients c
         LEFT JOIN accounts a ON a.id = c.account_id
        WHERE c.id = $1 AND c.org_id = $2 AND c.archived_at IS NULL`,
      [req.params.id, req.orgId]
    );
    if (!clientRes.rows.length) return res.status(404).json({ error: { message: 'Client not found' } });
    const client = clientRes.rows[0];

    // Pipeline by stage
    const pipelineRes = await pool.query(
      `SELECT stage, COUNT(*)::int AS count
         FROM prospects
        WHERE client_id = $1 AND org_id = $2 AND deleted_at IS NULL
        GROUP BY stage
        ORDER BY stage`,
      [req.params.id, req.orgId]
    );

    // Outreach stats (all time + this week)
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const outreachRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE direction = 'sent')                               AS total_sent,
         COUNT(*) FILTER (WHERE direction IN ('received','inbound'))              AS total_replies,
         COUNT(*) FILTER (WHERE direction = 'sent'     AND sent_at >= $2)        AS sent_this_week,
         COUNT(*) FILTER (WHERE direction IN ('received','inbound') AND sent_at >= $2) AS replies_this_week
       FROM emails e
       JOIN prospects p ON p.id = e.prospect_id
       WHERE p.client_id = $1 AND e.org_id = $3`,
      [req.params.id, weekStart, req.orgId]
    );

    // Sequence performance
    const seqRes = await pool.query(
      `SELECT
         s.id, s.name,
         COUNT(DISTINCT se.id)::int                                              AS enrolled,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'replied')::int        AS replied,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'active')::int         AS active,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'completed')::int      AS completed,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'stopped')::int        AS stopped,
         COUNT(DISTINCT ssl.id) FILTER (WHERE ssl.status = 'sent')::int         AS steps_sent
       FROM sequences s
       JOIN sequence_enrollments se ON se.sequence_id = s.id
       JOIN prospects p             ON p.id = se.prospect_id
       LEFT JOIN sequence_step_logs ssl ON ssl.enrollment_id = se.id
       WHERE p.client_id = $1
         AND s.org_id    = $2
         AND p.org_id    = $2
         AND p.deleted_at IS NULL
       GROUP BY s.id, s.name
       ORDER BY enrolled DESC`,
      [req.params.id, req.orgId]
    );

    // Prospect list
    const prospectsRes = await pool.query(
      `SELECT p.id, p.first_name, p.last_name, p.title, p.email,
              p.stage, p.outreach_count, p.last_outreach_at,
              a.name AS account_name
         FROM prospects p
         LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.client_id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL
        ORDER BY p.stage, p.last_name`,
      [req.params.id, req.orgId]
    );

    // Week-over-week outreach trend (last N weeks)
    const trendRes = await pool.query(
      `SELECT
         DATE_TRUNC('week', e.sent_at)                          AS week_start,
         COUNT(*) FILTER (WHERE e.direction = 'sent')::int      AS sent,
         COUNT(*) FILTER (WHERE e.direction IN ('received','inbound'))::int AS replies
       FROM emails e
       JOIN prospects p ON p.id = e.prospect_id
       WHERE p.client_id = $1
         AND e.org_id = $2
         AND e.sent_at >= NOW() - ($3 || ' weeks')::interval
       GROUP BY DATE_TRUNC('week', e.sent_at)
       ORDER BY week_start ASC`,
      [req.params.id, req.orgId, parseInt(weeks)]
    );

    // Team
    const teamRes = await pool.query(
      `SELECT ctm.role, u.first_name, u.last_name, u.email,
              COUNT(DISTINCT e.id) FILTER (WHERE e.direction = 'sent')::int AS emails_sent
         FROM client_team_members ctm
         JOIN users u ON u.id = ctm.user_id
         LEFT JOIN emails e ON e.user_id = ctm.user_id
           AND e.org_id = $2
           AND e.prospect_id IN (
             SELECT id FROM prospects WHERE client_id = $1
           )
        WHERE ctm.client_id = $1
        GROUP BY ctm.role, u.first_name, u.last_name, u.email
        ORDER BY ctm.role DESC, emails_sent DESC`,
      [req.params.id, req.orgId]
    );

    // Recent activity
    const activityRes = await pool.query(
      `SELECT ca.activity_type, ca.description, ca.created_at,
              u.first_name, u.last_name
         FROM client_activities ca
         LEFT JOIN users u ON u.id = ca.user_id
        WHERE ca.client_id = $1
        ORDER BY ca.created_at DESC
        LIMIT 20`,
      [req.params.id]
    );

    // Portal users
    const portalUsersRes = await pool.query(
      `SELECT id, email, first_name, last_name, invited_at, accepted_at, last_login_at, is_active
         FROM client_portal_users
        WHERE client_id = $1
        ORDER BY invited_at DESC`,
      [req.params.id]
    );

    const outreach = outreachRes.rows[0];

    res.json({
      client,
      pipeline:       pipelineRes.rows,
      outreach: {
        totalSent:        parseInt(outreach.total_sent)        || 0,
        totalReplies:     parseInt(outreach.total_replies)     || 0,
        sentThisWeek:     parseInt(outreach.sent_this_week)    || 0,
        repliesThisWeek:  parseInt(outreach.replies_this_week) || 0,
        replyRate: outreach.total_sent > 0
          ? ((outreach.total_replies / outreach.total_sent) * 100).toFixed(1)
          : '0.0',
      },
      sequences:      seqRes.rows,
      prospects:      prospectsRes.rows,
      weeklyTrend:    trendRes.rows,
      team:           teamRes.rows,
      portalUsers:    portalUsersRes.rows,
      recentActivity: activityRes.rows,
    });
  } catch (err) {
    console.error('GET /clients/:id/dashboard', err);
    res.status(500).json({ error: { message: 'Failed to load client dashboard' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /all/prospects — all prospects across all clients, optional ?client_id= filter
// ─────────────────────────────────────────────────────────────────────────────
router.get('/all/prospects', async (req, res) => {
  try {
    const { client_id } = req.query;
    const params = [req.orgId];
    let clientFilter = '';
    if (client_id) {
      params.push(parseInt(client_id));
      clientFilter = `AND p.client_id = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT
         p.id, p.first_name, p.last_name, p.email, p.title,
         p.company_name, p.stage, p.outreach_count, p.last_outreach_at,
         p.source, p.created_at,
         c.id   AS client_id,
         c.name AS client_name,
         a.name AS account_name
       FROM prospects p
       LEFT JOIN clients  c ON c.id = p.client_id
       LEFT JOIN accounts a ON a.id = p.account_id
       WHERE p.org_id = $1
         AND p.deleted_at IS NULL
         AND p.client_id IS NOT NULL
         ${clientFilter}
       ORDER BY c.name, p.last_name, p.first_name`,
      params
    );

    res.json({ prospects: rows });
  } catch (err) {
    console.error('GET /clients/all/prospects', err);
    res.status(500).json({ error: { message: 'Failed to load prospects' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /all/sequences — all sequences with per-client enrollment stats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/all/sequences', async (req, res) => {
  try {
    const { client_id } = req.query;
    const params = [req.orgId];
    let clientFilter = '';
    if (client_id) {
      params.push(parseInt(client_id));
      clientFilter = `AND p.client_id = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT
         s.id   AS sequence_id,
         s.name AS sequence_name,
         s.status AS sequence_status,
         (SELECT COUNT(*) FROM sequence_steps ss WHERE ss.sequence_id = s.id)::int AS step_count,
         c.id   AS client_id,
         c.name AS client_name,
         COUNT(DISTINCT se.id)::int                                              AS enrolled,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'active')::int         AS active,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'replied')::int        AS replied,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'completed')::int      AS completed,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'stopped')::int        AS stopped
       FROM sequences s
       JOIN sequence_enrollments se ON se.sequence_id = s.id
       JOIN prospects p             ON p.id = se.prospect_id
       JOIN clients   c             ON c.id = p.client_id
       WHERE s.org_id   = $1
         AND p.org_id   = $1
         AND p.deleted_at IS NULL
         AND c.archived_at IS NULL
         ${clientFilter}
       GROUP BY s.id, s.name, s.status, c.id, c.name
       ORDER BY c.name, enrolled DESC`,
      params
    );

    res.json({ sequences: rows });
  } catch (err) {
    console.error('GET /clients/all/sequences', err);
    res.status(500).json({ error: { message: 'Failed to load sequences' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/available-members
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/available-members', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, ou.role AS org_role
         FROM org_users ou
         JOIN users u ON u.id = ou.user_id
        WHERE ou.org_id   = $1
          AND ou.is_active = true
          AND u.id NOT IN (
            SELECT user_id FROM client_team_members WHERE client_id = $2
          )
        ORDER BY u.first_name, u.last_name`,
      [req.orgId, req.params.id]
    );
    res.json({ members: rows });
  } catch (err) {
    console.error('GET /clients/:id/available-members', err);
    res.status(500).json({ error: { message: 'Failed to load available members' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT SENDER ACCOUNTS (Model B)
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /:id/senders — list sender accounts for this client ──────────────────
router.get('/:id/senders', async (req, res) => {
  try {
    if (!await requireClient(req, res, req.params.id)) return;

    const { rows } = await pool.query(
      `SELECT * FROM prospecting_sender_accounts
        WHERE org_id = $1 AND client_id = $2
        ORDER BY created_at ASC`,
      [req.orgId, req.params.id]
    );

    res.json({ senders: rows.map(mapSenderRow) });
  } catch (err) {
    console.error('GET /clients/:id/senders', err);
    res.status(500).json({ error: { message: 'Failed to fetch client sender accounts' } });
  }
});

// ── GET /:id/senders/connect-url — generate OAuth URL for client sender ───────
// ?provider=gmail|outlook   &label=optional label
//
// The OAuth callback (google.routes.js / outlook.routes.js) detects
// mode=prospecting_client in state and saves to prospecting_sender_accounts
// with client_id set and user_id = NULL.
router.get('/:id/senders/connect-url', async (req, res) => {
  try {
    if (!await requireClient(req, res, req.params.id)) return;

    const { provider, label } = req.query;

    if (!['gmail', 'outlook'].includes(provider)) {
      return res.status(400).json({ error: { message: 'provider must be gmail or outlook' } });
    }

    const state = Buffer.from(JSON.stringify({
      userId:    req.user.userId, // Rep who initiated the flow; needed by Google's getUserProfile path
      orgId:     req.orgId,
      clientId:  parseInt(req.params.id),
      mode:      'prospecting_client',
      label:     label || null,
      timestamp: Date.now(),
    })).toString('base64');

    let authUrl;
    if (provider === 'gmail') {
      authUrl = getGoogleAuthUrl(state);
    } else {
      authUrl = await getOutlookAuthUrl(state);
    }

    res.json({ authUrl });
  } catch (err) {
    console.error('GET /clients/:id/senders/connect-url', err);
    res.status(500).json({ error: { message: 'Failed to generate connect URL' } });
  }
});

// ── PATCH /:id/senders/:senderId — update sender settings ────────────────────
router.patch('/:id/senders/:senderId', async (req, res) => {
  try {
    if (!await requireClient(req, res, req.params.id)) return;

    const { label, isActive, dailyLimit, minDelayMinutes, displayName, signature } = req.body;

    // Enforce org-level ceilings
    const limitsResult = await pool.query(
      `SELECT config FROM org_integrations
        WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [req.orgId]
    );
    const orgConfig    = limitsResult.rows[0]?.config || {};
    const ceiling      = orgConfig.dailyLimitCeiling      || 100;
    const delayCeiling = orgConfig.minDelayMinutesCeiling || 2;

    let effectiveDailyLimit      = dailyLimit      !== undefined ? parseInt(dailyLimit)      : undefined;
    let effectiveMinDelayMinutes = minDelayMinutes !== undefined ? parseInt(minDelayMinutes) : undefined;

    if (effectiveDailyLimit !== undefined && effectiveDailyLimit > ceiling) {
      return res.status(400).json({
        error: { message: `Daily limit cannot exceed org ceiling of ${ceiling}` }
      });
    }
    if (effectiveMinDelayMinutes !== undefined && effectiveMinDelayMinutes < delayCeiling) {
      return res.status(400).json({
        error: { message: `Min delay cannot be less than org minimum of ${delayCeiling} minutes` }
      });
    }

    const fields = [];
    const values = [];
    let idx = 1;

    const maybeSet = (col, val) => {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    };

    maybeSet('label',             label);
    maybeSet('is_active',         isActive);
    maybeSet('daily_limit',       effectiveDailyLimit);
    maybeSet('min_delay_minutes', effectiveMinDelayMinutes);
    maybeSet('display_name',      displayName);
    maybeSet('signature',         signature);

    if (fields.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.senderId, req.orgId, req.params.id);

    const result = await pool.query(
      `UPDATE prospecting_sender_accounts
          SET ${fields.join(', ')}
        WHERE id = $${idx++} AND org_id = $${idx++} AND client_id = $${idx}
        RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Sender account not found' } });
    }

    res.json({ sender: mapSenderRow(result.rows[0]) });
  } catch (err) {
    console.error('PATCH /clients/:id/senders/:senderId', err);
    res.status(500).json({ error: { message: 'Failed to update sender account' } });
  }
});

// ── DELETE /:id/senders/:senderId — remove a client sender account ────────────
router.delete('/:id/senders/:senderId', async (req, res) => {
  try {
    if (!await requireClient(req, res, req.params.id)) return;

    const result = await pool.query(
      `DELETE FROM prospecting_sender_accounts
        WHERE id = $1 AND org_id = $2 AND client_id = $3
        RETURNING id, email`,
      [req.params.senderId, req.orgId, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Sender account not found' } });
    }

    console.log(`🗑️  Client sender removed: ${result.rows[0].email} (client ${req.params.id})`);
    res.json({ message: 'Sender account removed successfully' });
  } catch (err) {
    console.error('DELETE /clients/:id/senders/:senderId', err);
    res.status(500).json({ error: { message: 'Failed to remove sender account' } });
  }
});

module.exports = router;
