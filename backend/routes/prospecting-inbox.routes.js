// ─────────────────────────────────────────────────────────────────────────────
// routes/prospecting-inbox.routes.js
//
// Unified prospecting inbox — returns emails linked to prospects,
// enriched with prospect info and sender account details.
//
// Mount in server.js:
//   const prospectingInboxRoutes = require('./routes/prospecting-inbox.routes');
//   app.use('/api/prospecting/inbox', prospectingInboxRoutes);
// ─────────────────────────────────────────────────────────────────────────────

const express           = require('express');
const router            = express.Router();
const db                = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ── GET / — fetch inbox ───────────────────────────────────────────────────────
// Query params:
//   scope     = mine | team | org          (default: mine)
//   direction = all | sent | received      (default: all)
//   from      = ISO date string            (optional)
//   to        = ISO date string            (optional)
//   limit     = integer                    (default: 100, max: 200)
//   offset    = integer                    (default: 0)
router.get('/', async (req, res) => {
  try {
    const {
      scope     = 'mine',
      direction = 'all',
      from,
      to,
      limit     = 100,
      offset    = 0,
    } = req.query;

    const params  = [req.orgId];
    let userFilter = '';

    // ── Scope filter ──────────────────────────────────────────────────────────
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      userFilter = `AND e.user_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      // Org scope — admin only
      if (req.user.role !== 'admin' && req.user.role !== 'org_admin') {
        return res.status(403).json({ error: { message: 'Org scope requires admin access' } });
      }
      // No user filter
    } else {
      // Default: mine
      userFilter = `AND e.user_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    // ── Direction filter ──────────────────────────────────────────────────────
    let directionFilter = '';
    // Accept both sent/received (DB values) and outbound/inbound (frontend values)
    if (direction === 'sent'     || direction === 'outbound') directionFilter = `AND e.direction = 'sent'`;
    if (direction === 'received' || direction === 'inbound')  directionFilter = `AND e.direction = 'received'`;

    // ── Date range filter ─────────────────────────────────────────────────────
    let dateFilter = '';
    if (from) {
      const fromDate = new Date(from);
      if (isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: { message: 'Invalid "from" date' } });
      }
      dateFilter += ` AND e.sent_at >= $${params.length + 1}`;
      params.push(fromDate);
    }
    if (to) {
      const toDate = new Date(to);
      if (isNaN(toDate.getTime())) {
        return res.status(400).json({ error: { message: 'Invalid "to" date' } });
      }
      // Inclusive of end date — push to end of day
      toDate.setHours(23, 59, 59, 999);
      dateFilter += ` AND e.sent_at <= $${params.length + 1}`;
      params.push(toDate);
    }

    // ── Pagination ────────────────────────────────────────────────────────────
    const effectiveLimit  = Math.min(parseInt(limit)  || 100, 200);
    const effectiveOffset = parseInt(offset) || 0;
    params.push(effectiveLimit, effectiveOffset);
    const limitClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;

    // ── Main query ────────────────────────────────────────────────────────────
    const query = `
      SELECT
        e.id,
        e.direction,
        e.subject,
        e.body,
        e.to_address,
        e.from_address,
        e.sent_at,
        e.prospect_id,
        e.user_id,
        e.sender_account_id,
        e.provider,

        -- Prospect fields
        p.first_name        AS prospect_first_name,
        p.last_name         AS prospect_last_name,
        p.company_name      AS prospect_company_name,
        p.stage             AS prospect_stage,
        p.email             AS prospect_email,

        -- CRM user who owns the email
        u.first_name        AS user_first_name,
        u.last_name         AS user_last_name,

        -- Sender account (the actual from-address used)
        psa.email           AS sender_account_email,
        psa.provider        AS sender_account_provider,
        psa.label           AS sender_account_label

      FROM emails e
      JOIN  prospects p   ON p.id  = e.prospect_id
      JOIN  users     u   ON u.id  = e.user_id
      LEFT JOIN prospecting_sender_accounts psa ON psa.id = e.sender_account_id

      WHERE e.org_id       = $1
        AND e.prospect_id  IS NOT NULL
        ${userFilter}
        ${directionFilter}
        ${dateFilter}

      ORDER BY e.sent_at DESC
      ${limitClause}
    `;

    // ── Count query (same filters, no pagination) ─────────────────────────────
    const countParams = params.slice(0, params.length - 2); // remove limit + offset
    const countQuery  = `
      SELECT COUNT(*) AS total
      FROM emails e
      JOIN  prospects p   ON p.id  = e.prospect_id
      JOIN  users     u   ON u.id  = e.user_id
      LEFT JOIN prospecting_sender_accounts psa ON psa.id = e.sender_account_id
      WHERE e.org_id       = $1
        AND e.prospect_id  IS NOT NULL
        ${userFilter}
        ${directionFilter}
        ${dateFilter}
    `;

    const [emailResult, countResult] = await Promise.all([
      db.query(query, params),
      db.query(countQuery, countParams),
    ]);

    const emails = emailResult.rows.map(row => ({
      id:          row.id,
      direction:   row.direction,
      subject:     row.subject,
      bodyPreview: (row.body || '').replace(/<[^>]+>/g, '').slice(0, 200),
      body:        row.body,
      toAddress:   row.to_address,
      fromAddress: row.from_address,
      sentAt:      row.sent_at,
      provider:    row.provider,

      prospect: {
        id:          row.prospect_id,
        firstName:   row.prospect_first_name,
        lastName:    row.prospect_last_name,
        companyName: row.prospect_company_name,
        stage:       row.prospect_stage,
        email:       row.prospect_email,
      },

      sentBy: {
        userId:    row.user_id,
        firstName: row.user_first_name,
        lastName:  row.user_last_name,
      },

      // The actual account used to send (null for received emails)
      senderAccount: row.sender_account_email ? {
        id:       row.sender_account_id,
        email:    row.sender_account_email,
        provider: row.sender_account_provider,
        label:    row.sender_account_label,
      } : null,
    }));

    res.json({
      emails,
      total:  parseInt(countResult.rows[0].total),
      limit:  effectiveLimit,
      offset: effectiveOffset,
    });
  } catch (error) {
    console.error('Prospecting inbox error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch inbox' } });
  }
});

// ── GET /stats — aggregate stats for the inbox (scoped + date filtered) ───────
// Same filters as GET / but returns counts only — used by the stats bar
router.get('/stats', async (req, res) => {
  try {
    const { scope = 'mine', from, to } = req.query;

    const params = [req.orgId];
    let userFilter = '';

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      userFilter = `AND e.user_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      if (req.user.role !== 'admin' && req.user.role !== 'org_admin') {
        return res.status(403).json({ error: { message: 'Org scope requires admin access' } });
      }
    } else {
      userFilter = `AND e.user_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    let dateFilter = '';
    if (from) {
      const fromDate = new Date(from);
      if (!isNaN(fromDate.getTime())) {
        dateFilter += ` AND e.sent_at >= $${params.length + 1}`;
        params.push(fromDate);
      }
    }
    if (to) {
      const toDate = new Date(to);
      if (!isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        dateFilter += ` AND e.sent_at <= $${params.length + 1}`;
        params.push(toDate);
      }
    }

    const statsQuery = `
      SELECT
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE e.direction = 'sent')     AS sent,
        COUNT(*) FILTER (WHERE e.direction = 'received') AS received,

        -- Per sender account breakdown
        psa.email           AS sender_email,
        psa.provider        AS sender_provider,
        psa.label           AS sender_label,
        COUNT(*) FILTER (WHERE e.direction = 'sent' AND e.sender_account_id = psa.id) AS sent_from_account

      FROM emails e
      JOIN prospects p ON p.id = e.prospect_id
      LEFT JOIN prospecting_sender_accounts psa ON psa.id = e.sender_account_id
      WHERE e.org_id      = $1
        AND e.prospect_id IS NOT NULL
        ${userFilter}
        ${dateFilter}
      GROUP BY GROUPING SETS (
        (),
        (psa.id, psa.email, psa.provider, psa.label)
      )
    `;

    const result = await db.query(statsQuery, params);

    // Separate the overall row from per-account rows
    const overallRow    = result.rows.find(r => r.sender_email === null) || {};
    const accountRows   = result.rows.filter(r => r.sender_email !== null);

    const sent     = parseInt(overallRow.sent     || 0);
    const received = parseInt(overallRow.received || 0);
    const replyRate = sent > 0 ? Math.round((received / sent) * 100) : 0;

    res.json({
      total:     parseInt(overallRow.total || 0),
      sent,
      received,
      replyRate,
      senderBreakdown: accountRows.map(r => ({
        email:    r.sender_email,
        provider: r.sender_provider,
        label:    r.sender_label,
        sent:     parseInt(r.sent_from_account || 0),
      })).filter(r => r.sent > 0),
    });
  } catch (error) {
    console.error('Inbox stats error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch inbox stats' } });
  }
});

module.exports = router;
