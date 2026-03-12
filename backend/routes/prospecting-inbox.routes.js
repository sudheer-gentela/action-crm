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
// ── GET /sync/debug — diagnostic endpoint, returns full sync trace without saving ──
// Call GET /api/prospecting/inbox/sync/debug to see exactly what's happening
router.get('/sync/debug', async (req, res) => {
  const orgId = req.orgId;
  const days  = Math.min(parseInt(req.query.days || 30), 90);
  const report = { senderAccounts: [], prospectCount: 0, sentOutreachCount: 0, emailsFetched: [], matchResults: [] };

  try {
    // 1. Sender accounts
    const senderResult = await db.query(
      `SELECT id, user_id, provider, email, is_active, expires_at
       FROM prospecting_sender_accounts WHERE org_id = $1`,
      [orgId]
    );
    report.senderAccounts = senderResult.rows.map(r => ({
      id: r.id, email: r.email, provider: r.provider,
      isActive: r.is_active,
      tokenExpired: r.expires_at ? new Date(r.expires_at) < new Date() : 'unknown',
      expiresAt: r.expires_at,
    }));

    // 2. Prospect emails
    const prospectResult = await db.query(
      `SELECT id, email FROM prospects WHERE org_id = $1 AND deleted_at IS NULL AND email IS NOT NULL`,
      [orgId]
    );
    report.prospectCount = prospectResult.rows.length;
    report.prospectEmails = prospectResult.rows.map(r => r.email);

    // 3. Sent outreach emails
    const sentResult = await db.query(
      `SELECT to_address, prospect_id FROM emails
       WHERE org_id = $1 AND prospect_id IS NOT NULL AND direction = 'sent'`,
      [orgId]
    );
    report.sentOutreachCount = sentResult.rows.length;
    report.sentToAddresses = sentResult.rows.map(r => r.to_address);

    // 4. For each active sender, fetch raw emails and show match attempt
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    const prospectByEmail = {};
    for (const p of prospectResult.rows) {
      if (p.email) prospectByEmail[p.email.toLowerCase().trim()] = p.id;
    }
    const prospectBySentTo = {};
    for (const row of sentResult.rows) {
      if (row.to_address) prospectBySentTo[row.to_address.toLowerCase().trim()] = row.prospect_id;
    }

    for (const account of senderResult.rows.filter(a => a.is_active)) {
      const accountReport = { account: account.email, provider: account.provider, rawEmailCount: 0, emails: [] };

      try {
        if (account.provider === 'gmail') {
          const { google } = require('googleapis');
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
          );
          oauth2Client.setCredentials({
            access_token:  account.access_token,
            refresh_token: account.refresh_token,
            expiry_date:   account.expires_at ? new Date(account.expires_at).getTime() : undefined,
          });
          const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
          const sinceFormatted = `${sinceDate.getFullYear()}/${String(sinceDate.getMonth()+1).padStart(2,'0')}/${String(sinceDate.getDate()).padStart(2,'0')}`;

          const listRes = await gmail.users.messages.list({
            userId: 'me', maxResults: 20,
            q: `after:${sinceFormatted}`,
          });

          const messageIds = listRes.data.messages || [];
          accountReport.rawEmailCount = listRes.data.resultSizeEstimate || messageIds.length;
          accountReport.nextPageToken = listRes.data.nextPageToken || null;

          for (const m of messageIds.slice(0, 20)) {
            const d = await gmail.users.messages.get({
              userId: 'me', id: m.id, format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            });
            const headers = {};
            (d.data.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });

            const fromRaw   = headers['from'] || '';
            const fromMatch = fromRaw.match(/<(.+?)>/);
            const fromAddr  = (fromMatch ? fromMatch[1] : fromRaw).toLowerCase().trim();
            const toRaw     = headers['to'] || '';
            const toAddrs   = toRaw.split(',').map(a => { const m = a.trim().match(/<(.+?)>/); return (m?m[1]:a).toLowerCase().trim(); });

            const exactMatch  = !!prospectByEmail[fromAddr];
            const sentToMatch = toAddrs.some(a => !!prospectBySentTo[a]);
            const alreadySaved = (await db.query(
              `SELECT id FROM emails WHERE external_id = $1`, [m.id]
            )).rows.length > 0;

            accountReport.emails.push({
              id: m.id, from: headers['from'], to: headers['to'],
              subject: headers['subject'], date: headers['date'],
              fromAddrParsed: fromAddr,
              exactMatch, sentToMatch, alreadySaved,
              wouldSave: (exactMatch || sentToMatch) && !alreadySaved,
            });
          }
        }
      } catch (err) {
        accountReport.error = err.message;
      }
      report.emailsFetched.push(accountReport);
    }

    res.json({ success: true, debug: report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, partial: report });
  }
});

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
      `SELECT id, email, company_domain FROM prospects
       WHERE org_id = $1 AND deleted_at IS NULL AND email IS NOT NULL`,
      [orgId]
    );

    // Map 1: lowercased prospect email → prospect id  (exact match)
    const prospectByEmail = {};
    // Map 2: lowercased prospect email domain → prospect id  (domain match for auto-replies)
    const prospectByDomain = {};
    for (const p of prospectResult.rows) {
      if (p.email) {
        const addr = p.email.toLowerCase().trim();
        prospectByEmail[addr] = p.id;
        const domain = addr.split('@')[1];
        if (domain && !prospectByDomain[domain]) {
          // Only store first prospect per domain to avoid false matches at large companies
          // We will validate further using the to_address check below
          prospectByDomain[domain] = p.id;
        }
      }
    }

    // Map 3: to_address of already-sent outreach emails → prospect id
    // This lets us match replies even when from_address differs (e.g. auto-reply servers)
    const sentEmailsResult = await db.query(
      `SELECT DISTINCT to_address, prospect_id
       FROM emails
       WHERE org_id = $1
         AND prospect_id IS NOT NULL
         AND direction = 'sent'
         AND to_address IS NOT NULL`,
      [orgId]
    );
    const prospectBySentTo = {};
    for (const row of sentEmailsResult.rows) {
      if (row.to_address) {
        prospectBySentTo[row.to_address.toLowerCase().trim()] = row.prospect_id;
      }
    }

    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    const googleService = require('../services/googleService');
    const outlookService = require('../services/outlookService');

    // 3. For each sender account, fetch inbound emails
    console.log(`\n🔍 SYNC: Starting for org ${orgId}, looking back ${days} days`);
    console.log(`🔍 SYNC: ${senderResult.rows.length} sender account(s), ${prospectResult.rows.length} prospects`);
    console.log(`🔍 SYNC: prospectBySentTo has ${Object.keys(prospectBySentTo).length} sent-to addresses:`, Object.keys(prospectBySentTo));

    for (const account of senderResult.rows) {
      console.log(`\n📬 SYNC: Processing sender account: ${account.email} (${account.provider}), active=${account.is_active}`);
      try {
        let rawEmails = [];

        if (account.provider === 'gmail') {
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

          const tokenExpired = account.expires_at && new Date(account.expires_at) < new Date(Date.now() + 60_000);
          console.log(`🔍 SYNC: Token expires_at=${account.expires_at}, expired=${tokenExpired}`);

          // Handle token refresh if expired
          if (tokenExpired) {
            try {
              const { credentials } = await oauth2Client.refreshAccessToken();
              console.log(`🔄 SYNC: Token refreshed successfully for ${account.email}`);
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
          console.log(`🔍 SYNC: Gmail query = "after:${sinceFormatted}"`);

          const listRes = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 100,
            q: `after:${sinceFormatted}`,  // no folder filter — catches auto-replies in Updates/other tabs
          });

          const messageIds = listRes.data.messages || [];
          console.log(`📨 SYNC: Gmail returned ${messageIds.length} messages (estimate: ${listRes.data.resultSizeEstimate})`);

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

        // Filter out emails sent BY this account — they are outbound, not replies
        const inboundEmails = rawEmails.filter(e => {
          const fromRaw   = e.fromAddress || '';
          const fromMatch = fromRaw.match(/<(.+?)>/);
          const fromAddr  = (fromMatch ? fromMatch[1] : fromRaw).toLowerCase().trim();
          return fromAddr !== account.email.toLowerCase();
        });

        console.log(`\n🔍 SYNC: ${rawEmails.length} total emails, ${inboundEmails.length} inbound (excluded ${rawEmails.length - inboundEmails.length} sent by self)`);

        // 4. Match each inbound email to a prospect using 3 strategies
        for (const email of inboundEmails) {
          const fromRaw    = email.fromAddress || '';
          const fromMatch  = fromRaw.match(/<(.+?)>/);
          const fromAddr   = (fromMatch ? fromMatch[1] : fromRaw).toLowerCase().trim();
          const fromDomain = fromAddr.split('@')[1] || '';

          // Parse to_addresses
          const toAddrs = (email.toAddress || '').split(',').map(a => {
            const m = a.trim().match(/<(.+?)>/);
            return (m ? m[1] : a).toLowerCase().trim();
          }).filter(Boolean);

          console.log(`  📧 from="${fromAddr}" to=${JSON.stringify(toAddrs)} subject="${(email.subject||'').slice(0,50)}"`);

          // Strategy 1: exact from_address match (normal replies)
          let prospectId = prospectByEmail[fromAddr];
          if (prospectId) console.log(`    ✅ Strategy 1 match (exact from_address): prospectId=${prospectId}`);

          // Strategy 2: to_address matches a prospect we previously sent to
          if (!prospectId) {
            for (const toAddr of toAddrs) {
              if (prospectBySentTo[toAddr]) {
                prospectId = prospectBySentTo[toAddr];
                console.log(`    ✅ Strategy 2 match (sent-to reverse): toAddr="${toAddr}" prospectId=${prospectId}`);
                break;
              }
            }
          }

          // Strategy 3: domain match — only when email arrived at our sender account
          if (!prospectId && fromDomain) {
            const domainProspectId = prospectByDomain[fromDomain];
            if (domainProspectId) {
              const arrivedAtSender = toAddrs.some(a => a === account.email.toLowerCase());
              console.log(`    🔍 Strategy 3 domain check: domain="${fromDomain}" arrivedAtSender=${arrivedAtSender}`);
              if (arrivedAtSender) {
                prospectId = domainProspectId;
                console.log(`    ✅ Strategy 3 match (domain): prospectId=${prospectId}`);
              }
            }
          }

          if (!prospectId) {
            console.log(`    ⏭️  No match — skipping`);
            skipped++; continue;
          }

          // 5. Save to emails table — explicit dedup, no ON CONFLICT constraint needed
          try {
            // Dedup check 1: by external_id
            if (email.externalId) {
              const existing = await db.query(
                `SELECT id FROM emails WHERE external_id = $1`, [email.externalId]
              );
              if (existing.rows.length > 0) {
                console.log(`    ⏭️  Already saved (external_id match) — skipping`);
                skipped++; continue;
              }
            }

            // Dedup check 2: same prospect + direction + subject within last 7 days
            const dupCheck = await db.query(
              `SELECT id FROM emails
               WHERE prospect_id = $1
                 AND direction   = 'received'
                 AND subject     = $2
                 AND sent_at     > NOW() - INTERVAL '7 days'`,
              [prospectId, email.subject]
            );
            if (dupCheck.rows.length > 0) {
              console.log(`    ⏭️  Already saved (prospect+subject match) — skipping`);
              skipped++; continue;
            }

            const insertResult = await db.query(
              `INSERT INTO emails
                 (org_id, user_id, prospect_id, sender_account_id, provider,
                  direction, subject, body, from_address, to_address,
                  sent_at, external_id)
               VALUES ($1, $2, $3, $4, $5, 'received', $6, $7, $8, $9, $10, $11)
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
                email.externalId || null,
              ]
            );

            if (insertResult.rows.length > 0) {
              console.log(`    💾 SAVED: email ${email.externalId} for prospectId=${prospectId}`);
              saved++;
              // Log a prospecting activity (non-blocking)
              db.query(
                `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
                 VALUES ($1, $2, 'email_received', $3, $4)`,
                [
                  prospectId,
                  account.user_id,
                  `Reply received: ${email.subject}`,
                  JSON.stringify({ emailExternalId: email.externalId, fromAddress: email.fromAddress }),
                ]
              ).catch(() => {});
            }
          } catch (insertErr) {
            console.error(`    ❌ Insert error:`, insertErr.message, '| code:', insertErr.code);
            if (insertErr.code === '23505') { skipped++; }
            else errors.push({ account: account.email, externalId: email.externalId, error: insertErr.message });
          }
        }

      } catch (accountErr) {
        console.error(`❌ Sync failed for sender ${account.email}:`, accountErr.message);
        errors.push({ account: account.email, error: accountErr.message });
      }
    }

    console.log(`\n✅ SYNC COMPLETE — saved: ${saved}, skipped: ${skipped}, errors: ${errors.length}`);
    if (errors.length) console.log('❌ Errors:', JSON.stringify(errors, null, 2));

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
