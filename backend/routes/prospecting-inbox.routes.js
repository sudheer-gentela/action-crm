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
    if (direction === 'sent')     directionFilter = `AND e.direction = 'sent'`;
    if (direction === 'received') directionFilter = `AND e.direction = 'received'`;

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

// ── POST /sync — fetch replies from Gmail/Outlook and match to prospects ───────
//
// For each active prospecting sender account in the org, fetches recent inbound
// emails and checks whether the sender address matches a known prospect email.
// Matched replies are upserted into the emails table with prospect_id set so
// they appear in the prospecting inbox.
//
// Query params:
//   days  — how many days back to look (default: 30, max: 90)
//
router.post('/sync', async (req, res) => {
  const orgId  = req.orgId;
  const userId = req.user.userId;
  const days   = Math.min(parseInt(req.query.days || req.body?.days || 30), 90);

  let saved = 0, skipped = 0, errors = [];

  try {
    // 1. Load all active sender accounts for this org
    const senderResult = await db.query(
      `SELECT id, user_id, provider, email, access_token, refresh_token, expires_at
       FROM prospecting_sender_accounts
       WHERE org_id = $1 AND is_active = true`,
      [orgId]
    );

    if (senderResult.rows.length === 0) {
      return res.json({ success: true, message: 'No active sender accounts', saved: 0, skipped: 0 });
    }

    // 2. Load all prospect emails for this org (for fast lookup)
    const prospectResult = await db.query(
      `SELECT id, email FROM prospects
       WHERE org_id = $1 AND deleted_at IS NULL AND email IS NOT NULL`,
      [orgId]
    );

    // Build a map: lowercased prospect email → prospect id
    const prospectByEmail = {};
    for (const p of prospectResult.rows) {
      if (p.email) prospectByEmail[p.email.toLowerCase().trim()] = p.id;
    }

    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    const googleService = require('../services/googleService');
    const outlookService = require('../services/outlookService');

    // 3. For each sender account, fetch inbound emails
    for (const account of senderResult.rows) {
      try {
        let rawEmails = [];

        if (account.provider === 'gmail') {
          // Use the sender account's own tokens, not the user's oauth_tokens
          // We temporarily override by calling Gmail directly with this account's token
          const { google } = require('googleapis');
          const oauth2Client = new (require('googleapis').google.auth.OAuth2)(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
          );
          oauth2Client.setCredentials({
            access_token:  account.access_token,
            refresh_token: account.refresh_token,
            expiry_date:   account.expires_at ? new Date(account.expires_at).getTime() : undefined,
          });

          // Handle token refresh if expired
          if (account.expires_at && new Date(account.expires_at) < new Date(Date.now() + 60_000)) {
            try {
              const { credentials } = await oauth2Client.refreshAccessToken();
              // Save refreshed token back
              await db.query(
                `UPDATE prospecting_sender_accounts
                 SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [credentials.access_token, new Date(credentials.expiry_date), account.id]
              );
              oauth2Client.setCredentials(credentials);
            } catch (refreshErr) {
              console.warn(`⚠️  Token refresh failed for sender ${account.email}:`, refreshErr.message);
              errors.push({ account: account.email, error: 'Token refresh failed — reconnect this sender account' });
              continue;
            }
          }

          const gmail = require('googleapis').google.gmail({ version: 'v1', auth: oauth2Client });

          const sinceFormatted = `${sinceDate.getFullYear()}/${String(sinceDate.getMonth() + 1).padStart(2, '0')}/${String(sinceDate.getDate()).padStart(2, '0')}`;

          const listRes = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 100,
            q: `in:inbox after:${sinceFormatted}`,
          });

          const messageIds = listRes.data.messages || [];

          for (let i = 0; i < messageIds.length; i += 10) {
            const batch = messageIds.slice(i, i + 10);
            const details = await Promise.all(
              batch.map(m => gmail.users.messages.get({
                userId: 'me',
                id: m.id,
                format: 'full',
                metadataHeaders: ['From', 'To', 'Subject', 'Date'],
              }))
            );

            for (const d of details) {
              const msg = d.data;
              const headers = {};
              (msg.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });

              // Extract plain text body
              let body = msg.snippet || '';
              const extractBody = (parts) => {
                for (const part of (parts || [])) {
                  if (part.mimeType === 'text/plain' && part.body?.data) {
                    return Buffer.from(part.body.data, 'base64').toString('utf-8');
                  }
                  if (part.parts) {
                    const nested = extractBody(part.parts);
                    if (nested) return nested;
                  }
                }
                return null;
              };
              body = extractBody(msg.payload?.parts) || msg.snippet || '';

              rawEmails.push({
                externalId:  msg.id,
                fromAddress: headers['from'] || '',
                toAddress:   headers['to'] || '',
                subject:     headers['subject'] || '(no subject)',
                body,
                sentAt:      headers['date'] ? new Date(headers['date']) : new Date(),
              });
            }
          }

        } else if (account.provider === 'outlook') {
          // Use the account owner's outlook tokens
          try {
            const result = await outlookService.fetchEmails(account.user_id, {
              top: 100,
              since: sinceDate.toISOString(),
              filter: `receivedDateTime gt ${sinceDate.toISOString()}`,
            });

            rawEmails = (result.emails || []).map(e => ({
              externalId:  e.id,
              fromAddress: e.from?.emailAddress?.address || '',
              toAddress:   (e.toRecipients || []).map(r => r.emailAddress?.address).join(', '),
              subject:     e.subject || '(no subject)',
              body:        e.body?.content || e.bodyPreview || '',
              sentAt:      e.receivedDateTime ? new Date(e.receivedDateTime) : new Date(),
            }));
          } catch (outlookErr) {
            console.warn(`⚠️  Outlook fetch failed for sender ${account.email}:`, outlookErr.message);
            errors.push({ account: account.email, error: outlookErr.message });
            continue;
          }
        }

        // 4. Match each email's from address to a prospect
        for (const email of rawEmails) {
          // Parse "Name <email@domain.com>" format
          const fromRaw = email.fromAddress || '';
          const fromMatch = fromRaw.match(/<(.+?)>/) || [];
          const fromAddr = (fromMatch[1] || fromRaw).toLowerCase().trim();

          const prospectId = prospectByEmail[fromAddr];
          if (!prospectId) { skipped++; continue; } // not a known prospect

          // 5. Upsert into emails table — skip if external_id already exists
          try {
            const upsertResult = await db.query(
              `INSERT INTO emails
                 (org_id, user_id, prospect_id, sender_account_id, provider,
                  direction, subject, body, from_address, to_address,
                  sent_at, external_id)
               VALUES ($1, $2, $3, $4, $5, 'received', $6, $7, $8, $9, $10, $11)
               ON CONFLICT (external_id) DO NOTHING
               RETURNING id`,
              [
                orgId,
                account.user_id,
                prospectId,
                account.id,
                account.provider,
                email.subject,
                email.body,
                email.fromAddress,
                email.toAddress,
                email.sentAt,
                email.externalId,
              ]
            );

            if (upsertResult.rows.length > 0) {
              saved++;
              // Also log a prospecting activity
              await db.query(
                `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
                 VALUES ($1, $2, 'email_received', $3, $4)
                 ON CONFLICT DO NOTHING`,
                [
                  prospectId,
                  account.user_id,
                  `Reply received: ${email.subject}`,
                  JSON.stringify({ emailExternalId: email.externalId, fromAddress: email.fromAddress }),
                ]
              ).catch(() => {}); // non-blocking, ignore conflict errors
            } else {
              skipped++;
            }
          } catch (upsertErr) {
            // external_id unique constraint — already exists
            if (upsertErr.code === '23505') { skipped++; }
            else errors.push({ account: account.email, externalId: email.externalId, error: upsertErr.message });
          }
        }

      } catch (accountErr) {
        console.error(`❌ Sync failed for sender ${account.email}:`, accountErr.message);
        errors.push({ account: account.email, error: accountErr.message });
      }
    }

    console.log(`✅ Prospecting inbox sync complete — saved: ${saved}, skipped: ${skipped}, errors: ${errors.length}`);

    res.json({
      success: true,
      message: `Sync complete — ${saved} new repl${saved === 1 ? 'y' : 'ies'} saved`,
      saved,
      skipped,
      errors: errors.length ? errors : undefined,
    });

  } catch (error) {
    console.error('❌ Prospecting inbox sync error:', error);
    res.status(500).json({ error: { message: 'Sync failed: ' + error.message } });
  }
});

module.exports = router;
