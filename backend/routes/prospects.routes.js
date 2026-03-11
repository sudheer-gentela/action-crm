const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ── Valid stage transitions ──────────────────────────────────────────────────
const VALID_STAGES = ['target', 'researched', 'contacted', 'engaged', 'qualified', 'converted', 'disqualified', 'nurture'];

const STAGE_TRANSITIONS = {
  target:       ['researched', 'contacted', 'disqualified', 'nurture'],
  researched:   ['contacted', 'disqualified', 'nurture'],
  contacted:    ['engaged', 'qualified', 'disqualified', 'nurture'],
  engaged:      ['qualified', 'disqualified', 'nurture'],
  qualified:    ['converted', 'disqualified', 'nurture'],
  disqualified: ['target'],
  nurture:      ['target', 'contacted'],
};

// ── GET / — list prospects ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { scope = 'mine', stage, accountId, companyDomain, search } = req.query;

    let query = `
      SELECT p.*,
             acc.name AS account_name,
             acc.domain AS account_domain,
             u.first_name AS owner_first_name,
             u.last_name  AS owner_last_name
      FROM prospects p
      LEFT JOIN accounts acc ON p.account_id = acc.id
      LEFT JOIN users u ON p.owner_id = u.id
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
    `;
    const params = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      query += ` AND p.owner_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      // No owner filter
    } else {
      query += ` AND p.owner_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    if (stage) {
      query += ` AND p.stage = $${params.length + 1}`;
      params.push(stage);
    }

    if (accountId) {
      query += ` AND p.account_id = $${params.length + 1}`;
      params.push(parseInt(accountId));
    }

    if (companyDomain) {
      query += ` AND LOWER(p.company_domain) = LOWER($${params.length + 1})`;
      params.push(companyDomain);
    }

    if (search) {
      query += ` AND (
        LOWER(p.first_name || ' ' || p.last_name) LIKE $${params.length + 1}
        OR LOWER(p.email) LIKE $${params.length + 1}
        OR LOWER(p.company_name) LIKE $${params.length + 1}
      )`;
      params.push(`%${search.toLowerCase()}%`);
    }

    query += ' ORDER BY p.updated_at DESC';

    const result = await db.query(query, params);

    res.json({
      prospects: result.rows.map(row => ({
        ...row,
        account: row.account_id ? {
          id:     row.account_id,
          name:   row.account_name,
          domain: row.account_domain,
        } : null,
        owner: {
          first_name: row.owner_first_name,
          last_name:  row.owner_last_name,
        },
      })),
    });
  } catch (error) {
    console.error('Get prospects error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch prospects' } });
  }
});

// ── GET /pipeline/summary ────────────────────────────────────────────────────
router.get('/pipeline/summary', async (req, res) => {
  try {
    const { scope = 'mine' } = req.query;
    let ownerFilter = '';
    const params = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      ownerFilter = `AND owner_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      ownerFilter = '';
    } else {
      ownerFilter = `AND owner_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    const result = await db.query(
      `SELECT stage, COUNT(id) AS count
       FROM prospects
       WHERE org_id = $1 AND deleted_at IS NULL ${ownerFilter}
       GROUP BY stage
       ORDER BY CASE stage
         WHEN 'target' THEN 1 WHEN 'researched' THEN 2
         WHEN 'contacted' THEN 3 WHEN 'engaged' THEN 4
         WHEN 'qualified' THEN 5 WHEN 'converted' THEN 6
         WHEN 'disqualified' THEN 7 WHEN 'nurture' THEN 8
         ELSE 9 END`,
      params
    );

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    let actionOwnerFilter = '';
    const actionParams = [req.orgId];
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      actionOwnerFilter = `AND user_id = ANY($${actionParams.length + 1}::int[])`;
      actionParams.push(teamIds);
    } else if (scope === 'org') {
      actionOwnerFilter = '';
    } else {
      actionOwnerFilter = `AND user_id = $${actionParams.length + 1}`;
      actionParams.push(req.user.userId);
    }
    actionParams.push(weekStart);

    const outreachResult = await db.query(
      `SELECT
         COUNT(CASE WHEN status = 'completed' AND channel IS NOT NULL THEN 1 END) AS outreach_this_week,
         COUNT(CASE WHEN outcome IN ('replied','call_connected','meeting_booked') THEN 1 END) AS responses_this_week
       FROM prospecting_actions
       WHERE org_id = $1 ${actionOwnerFilter} AND created_at >= $${actionParams.length}`,
      actionParams
    );

    res.json({
      pipeline: result.rows.map(row => ({
        stage: row.stage,
        count: parseInt(row.count),
      })),
      metrics: {
        outreachThisWeek:  parseInt(outreachResult.rows[0]?.outreach_this_week || 0),
        responsesThisWeek: parseInt(outreachResult.rows[0]?.responses_this_week || 0),
      },
    });
  } catch (error) {
    console.error('Pipeline summary error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch pipeline summary' } });
  }
});

// ── POST /bulk — bulk import prospects from CSV ───────────────────────────────
// Body: { prospects: [{ firstName, lastName, email, title, companyName, ... }] }
// Returns: { imported, skipped, errors: [{ row, reason }] }
router.post('/bulk', async (req, res) => {
  try {
    const { prospects: rows, source = 'csv_import' } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: { message: 'prospects array is required and must not be empty' } });
    }

    if (rows.length > 500) {
      return res.status(400).json({ error: { message: 'Maximum 500 prospects per import' } });
    }

    let imported = 0;
    let skipped  = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;

      // Required fields
      if (!row.firstName || !row.lastName) {
        errors.push({ row: rowNum, reason: 'firstName and lastName are required' });
        skipped++;
        continue;
      }

      try {
        // Duplicate check by email
        if (row.email) {
          const dup = await db.query(
            `SELECT id FROM prospects
             WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL`,
            [req.orgId, row.email]
          );
          if (dup.rows.length > 0) {
            errors.push({ row: rowNum, reason: `Duplicate email: ${row.email}` });
            skipped++;
            continue;
          }
        }

        // Auto-match account by domain
        let resolvedAccountId = null;
        if (row.companyDomain) {
          const accMatch = await db.query(
            `SELECT id FROM accounts WHERE org_id = $1 AND LOWER(domain) = LOWER($2) LIMIT 1`,
            [req.orgId, row.companyDomain]
          );
          if (accMatch.rows.length > 0) {
            resolvedAccountId = accMatch.rows[0].id;
          }
        }

        await db.query(
          `INSERT INTO prospects (
             org_id, owner_id, first_name, last_name, email, phone, linkedin_url,
             title, location, company_name, company_domain, company_size,
             company_industry, account_id, source, tags, stage, stage_changed_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12,
             $13, $14, $15, $16,
             'target', CURRENT_TIMESTAMP
           )`,
          [
            req.orgId,
            req.user.userId,
            row.firstName,
            row.lastName,
            row.email            || null,
            row.phone            || null,
            row.linkedinUrl      || null,
            row.title            || null,
            row.location         || null,
            row.companyName      || null,
            row.companyDomain    || null,
            row.companySize      || null,
            row.companyIndustry  || null,
            resolvedAccountId,
            source,
            JSON.stringify(row.tags || []),
          ]
        );

        imported++;
      } catch (rowErr) {
        console.error(`Bulk import row ${rowNum} error:`, rowErr.message);
        errors.push({ row: rowNum, reason: rowErr.message });
        skipped++;
      }
    }

    // Log a single import activity
    if (imported > 0) {
      await db.query(
        `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
         SELECT id, $1, 'created', $2, $3
         FROM prospects
         WHERE org_id = $4 AND owner_id = $1 AND source = $5
           AND created_at >= NOW() - INTERVAL '10 seconds'
         LIMIT 1`,
        [
          req.user.userId,
          `Imported via ${source}`,
          JSON.stringify({ imported, skipped, source }),
          req.orgId,
          source,
        ]
      );
    }

    console.log(`📥 Bulk import: ${imported} imported, ${skipped} skipped (org ${req.orgId})`);

    res.status(201).json({
      imported,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      message: `Imported ${imported} prospect${imported !== 1 ? 's' : ''}${skipped > 0 ? `, skipped ${skipped}` : ''}.`,
    });
  } catch (error) {
    console.error('Bulk import error:', error);
    res.status(500).json({ error: { message: 'Bulk import failed: ' + error.message } });
  }
});

// ── GET /:id — prospect detail ───────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*,
              acc.name AS account_name, acc.domain AS account_domain,
              u.first_name AS owner_first_name, u.last_name AS owner_last_name,
              c.first_name AS linked_contact_first_name, c.last_name AS linked_contact_last_name
       FROM prospects p
       LEFT JOIN accounts acc ON p.account_id = acc.id
       LEFT JOIN users u ON p.owner_id = u.id
       LEFT JOIN contacts c ON p.contact_id = c.id
       WHERE p.id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const row = result.rows[0];

    const activities = await db.query(
      `SELECT * FROM prospecting_activities
       WHERE prospect_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );

    const actions = await db.query(
      `SELECT * FROM prospecting_actions
       WHERE prospect_id = $1 AND org_id = $2
       ORDER BY
         CASE status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END,
         CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         due_date ASC NULLS LAST`,
      [req.params.id, req.orgId]
    );

    res.json({
      prospect: {
        ...row,
        account: row.account_id ? { id: row.account_id, name: row.account_name, domain: row.account_domain } : null,
        owner:   { first_name: row.owner_first_name, last_name: row.owner_last_name },
        linkedContact: row.contact_id ? { id: row.contact_id, first_name: row.linked_contact_first_name, last_name: row.linked_contact_last_name } : null,
      },
      activities: activities.rows,
      actions:    actions.rows,
    });
  } catch (error) {
    console.error('Get prospect detail error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch prospect' } });
  }
});

// ── GET /:id/emails — email history for a prospect ───────────────────────────
router.get('/:id/emails', async (req, res) => {
  try {
    // Verify prospect belongs to this org
    const check = await db.query(
      'SELECT id FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const result = await db.query(
      `SELECT
         e.id,
         e.direction,
         e.subject,
         e.body,
         e.to_address,
         e.from_address,
         e.sent_at,
         e.provider,
         u.first_name  AS sender_first_name,
         u.last_name   AS sender_last_name,
         psa.email     AS sender_account_email,
         psa.provider  AS sender_account_provider,
         psa.label     AS sender_account_label
       FROM emails e
       JOIN  users u   ON u.id   = e.user_id
       LEFT JOIN prospecting_sender_accounts psa ON psa.id = e.sender_account_id
       WHERE e.prospect_id = $1
         AND e.org_id      = $2
       ORDER BY e.sent_at DESC
       LIMIT 50`,
      [req.params.id, req.orgId]
    );

    res.json({
      emails: result.rows.map(row => ({
        id:          row.id,
        direction:   row.direction,
        subject:     row.subject,
        bodyPreview: (row.body || '').replace(/<[^>]+>/g, '').slice(0, 200),
        body:        row.body,
        toAddress:   row.to_address,
        fromAddress: row.from_address,
        sentAt:      row.sent_at,
        provider:    row.provider,
        sentBy: {
          firstName: row.sender_first_name,
          lastName:  row.sender_last_name,
        },
        senderAccount: row.sender_account_email ? {
          email:    row.sender_account_email,
          provider: row.sender_account_provider,
          label:    row.sender_account_label,
        } : null,
      })),
    });
  } catch (error) {
    console.error('Get prospect emails error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch prospect emails' } });
  }
});

// ── POST /:id/research — AI-powered prospect research ────────────────────────
// Calls Claude Haiku to generate research notes from available prospect data.
// Saves to research_notes and advances target → researched if applicable.
router.post('/:id/research', async (req, res) => {
  try {
    const prospectResult = await db.query(
      `SELECT p.*,
              acc.name AS account_name, acc.website AS account_website,
              acc.industry AS account_industry
       FROM prospects p
       LEFT JOIN accounts acc ON p.account_id = acc.id
       WHERE p.id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (prospectResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const p = prospectResult.rows[0];

    // Build research prompt from available data
    const contextLines = [
      `Name: ${p.first_name} ${p.last_name}`,
      p.title         ? `Title: ${p.title}`                         : null,
      p.email         ? `Email: ${p.email}`                         : null,
      p.linkedin_url  ? `LinkedIn: ${p.linkedin_url}`               : null,
      p.company_name  ? `Company: ${p.company_name}`                : null,
      p.company_domain ? `Company domain: ${p.company_domain}`      : null,
      p.company_industry ? `Industry: ${p.company_industry}`        : null,
      p.company_size  ? `Company size: ${p.company_size}`           : null,
      p.location      ? `Location: ${p.location}`                   : null,
      p.account_name  ? `Account: ${p.account_name}`                : null,
      p.account_industry ? `Account industry: ${p.account_industry}`: null,
      p.tags?.length  ? `Tags: ${JSON.parse(p.tags || '[]').join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const prompt = `You are a B2B sales research assistant. Based on the following prospect information, generate concise research notes (3-5 bullet points) that a sales rep can use to personalise their outreach. Focus on: likely pain points, potential value propositions, relevant company context, and suggested conversation angles.

Prospect information:
${contextLines}

Respond with bullet points only. Each bullet should be actionable and specific. Do not include generic advice.`;

    // Call Claude Haiku via the Anthropic API
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    });

    const researchNotes = message.content[0]?.text || '';

    if (!researchNotes) {
      return res.status(500).json({ error: { message: 'Research generation returned empty response' } });
    }

    // Save research notes
    await db.query(
      `UPDATE prospects
       SET research_notes = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3`,
      [researchNotes, req.params.id, req.orgId]
    );

    // Auto-advance target → researched
    let stageAdvanced = false;
    if (p.stage === 'target') {
      await db.query(
        `UPDATE prospects
         SET stage = 'researched', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.orgId]
      );
      stageAdvanced = true;

      await db.query(
        `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
         VALUES ($1, $2, 'stage_change', 'Auto-advanced to researched after AI research')`,
        [req.params.id, req.user.userId]
      );
    }

    // Log activity
    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'research_completed', 'AI research notes generated', $3)`,
      [
        req.params.id,
        req.user.userId,
        JSON.stringify({ stageAdvanced, model: 'claude-haiku-4-5-20251001' }),
      ]
    );

    res.json({
      researchNotes,
      stageAdvanced,
      newStage: stageAdvanced ? 'researched' : p.stage,
    });
  } catch (error) {
    console.error('Prospect research error:', error);
    // Specific error for missing API key
    if (error.message?.includes('API key')) {
      return res.status(500).json({ error: { message: 'AI research unavailable — ANTHROPIC_API_KEY not configured' } });
    }
    res.status(500).json({ error: { message: 'Research failed: ' + error.message } });
  }
});

// ── POST / — create prospect ─────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone, linkedinUrl, title, location,
      companyName, companyDomain, companySize, companyIndustry,
      accountId, source, playbookId, tags,
    } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({ error: { message: 'firstName and lastName are required' } });
    }

    // Duplicate check: same email in same org
    if (email) {
      const emailDup = await db.query(
        `SELECT id, first_name, last_name FROM prospects
         WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL`,
        [req.orgId, email]
      );
      if (emailDup.rows.length > 0) {
        const dup = emailDup.rows[0];
        return res.status(409).json({
          error: {
            message: `A prospect with email "${email}" already exists: ${dup.first_name} ${dup.last_name} (ID ${dup.id})`,
            code: 'DUPLICATE_EMAIL',
            existingProspectId: dup.id,
          },
        });
      }
    }

    // Auto-match account by domain
    let resolvedAccountId = accountId || null;
    if (!resolvedAccountId && companyDomain) {
      const accMatch = await db.query(
        `SELECT id FROM accounts WHERE org_id = $1 AND LOWER(domain) = LOWER($2) LIMIT 1`,
        [req.orgId, companyDomain]
      );
      if (accMatch.rows.length > 0) {
        resolvedAccountId = accMatch.rows[0].id;
      }
    }

    const result = await db.query(
      `INSERT INTO prospects (
         org_id, owner_id, first_name, last_name, email, phone, linkedin_url,
         title, location, company_name, company_domain, company_size,
         company_industry, account_id, source, playbook_id, tags,
         stage, stage_changed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         'target', CURRENT_TIMESTAMP
       ) RETURNING *`,
      [
        req.orgId, req.user.userId, firstName, lastName, email, phone, linkedinUrl,
        title, location, companyName, companyDomain, companySize,
        companyIndustry, resolvedAccountId, source || 'manual', playbookId || null,
        JSON.stringify(tags || []),
      ]
    );

    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
       VALUES ($1, $2, 'created', $3)`,
      [result.rows[0].id, req.user.userId, `Prospect created from ${source || 'manual'}`]
    );

    res.status(201).json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Create prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to create prospect' } });
  }
});

// ── PUT /:id — update prospect ───────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone, linkedinUrl, title, location,
      companyName, companyDomain, companySize, companyIndustry,
      accountId, playbookId, preferredChannel, researchNotes, tags, ownerId,
    } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    const maybeSet = (col, val) => {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    };

    maybeSet('first_name',        firstName);
    maybeSet('last_name',         lastName);
    maybeSet('email',             email);
    maybeSet('phone',             phone);
    maybeSet('linkedin_url',      linkedinUrl);
    maybeSet('title',             title);
    maybeSet('location',          location);
    maybeSet('company_name',      companyName);
    maybeSet('company_domain',    companyDomain);
    maybeSet('company_size',      companySize);
    maybeSet('company_industry',  companyIndustry);
    maybeSet('account_id',        accountId);
    maybeSet('playbook_id',       playbookId);
    maybeSet('preferred_channel', preferredChannel);
    maybeSet('research_notes',    researchNotes);
    maybeSet('owner_id',          ownerId);

    if (tags !== undefined) {
      fields.push(`tags = $${idx++}`);
      values.push(JSON.stringify(tags));
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id, req.orgId);

    const result = await db.query(
      `UPDATE prospects SET ${fields.join(', ')}
       WHERE id = $${idx++} AND org_id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Update prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to update prospect' } });
  }
});

// ── POST /:id/stage — change prospect stage ──────────────────────────────────
router.post('/:id/stage', async (req, res) => {
  try {
    const { stage, reason } = req.body;

    if (!VALID_STAGES.includes(stage)) {
      return res.status(400).json({ error: { message: `Invalid stage: ${stage}` } });
    }

    const current = await db.query(
      `SELECT id, stage FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const currentStage = current.rows[0].stage;
    const allowed = STAGE_TRANSITIONS[currentStage] || [];

    if (!allowed.includes(stage)) {
      return res.status(400).json({
        error: { message: `Cannot transition from "${currentStage}" to "${stage}". Allowed: ${allowed.join(', ')}` }
      });
    }

    const result = await db.query(
      `UPDATE prospects
       SET stage = $1, stage_changed_at = CURRENT_TIMESTAMP,
           disqualified_reason = COALESCE($2, disqualified_reason),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4
       RETURNING *`,
      [stage, stage === 'disqualified' ? reason : null, req.params.id, req.orgId]
    );

    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'stage_change', $3, $4)`,
      [
        req.params.id, req.user.userId,
        `Stage changed from ${currentStage} to ${stage}`,
        JSON.stringify({ from: currentStage, to: stage, reason: reason || null }),
      ]
    );

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Stage change error:', error);
    res.status(500).json({ error: { message: 'Failed to change stage' } });
  }
});

// ── POST /:id/disqualify ──────────────────────────────────────────────────────
router.post('/:id/disqualify', async (req, res) => {
  req.body.stage = 'disqualified';
  req.body.reason = req.body.reason || 'Not a fit';
  return router.handle(Object.assign(req, { url: `/${req.params.id}/stage`, method: 'POST' }), res);
});

// ── POST /:id/nurture ─────────────────────────────────────────────────────────
router.post('/:id/nurture', async (req, res) => {
  try {
    const { nurtureUntil, reason } = req.body;

    const current = await db.query(
      `SELECT id, stage FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const result = await db.query(
      `UPDATE prospects
       SET stage = 'nurture', stage_changed_at = CURRENT_TIMESTAMP,
           nurture_until = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3
       RETURNING *`,
      [nurtureUntil || null, req.params.id, req.orgId]
    );

    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'stage_change', $3, $4)`,
      [
        req.params.id, req.user.userId,
        `Moved to nurture from ${current.rows[0].stage}`,
        JSON.stringify({ from: current.rows[0].stage, to: 'nurture', nurtureUntil, reason }),
      ]
    );

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Nurture error:', error);
    res.status(500).json({ error: { message: 'Failed to move to nurture' } });
  }
});

// ── POST /:id/convert — convert prospect to contact + deal ───────────────────
router.post('/:id/convert', async (req, res) => {
  const client = await (db.pool ? db.pool.connect() : db.connect());
  try {
    const { dealName, dealValue, dealStage, createDeal = true } = req.body;

    const prospect = await client.query(
      `SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (prospect.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const p = prospect.rows[0];

    if (p.stage === 'converted') {
      return res.status(400).json({ error: { message: 'Prospect is already converted' } });
    }

    await client.query('BEGIN');

    // 1. Create or find account
    let accountId = p.account_id;
    if (!accountId && p.company_name) {
      if (p.company_domain) {
        const accMatch = await client.query(
          `SELECT id FROM accounts WHERE org_id = $1 AND LOWER(domain) = LOWER($2) LIMIT 1`,
          [req.orgId, p.company_domain]
        );
        if (accMatch.rows.length > 0) {
          accountId = accMatch.rows[0].id;
        }
      }
      if (!accountId) {
        const newAcc = await client.query(
          `INSERT INTO accounts (org_id, owner_id, name, domain, industry, size)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [req.orgId, req.user.userId, p.company_name, p.company_domain, p.company_industry, p.company_size]
        );
        accountId = newAcc.rows[0].id;
      }
    }

    // 2. Create or find contact
    let contactId = p.contact_id;
    if (!contactId) {
      if (p.email) {
        const cMatch = await client.query(
          `SELECT id FROM contacts WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL LIMIT 1`,
          [req.orgId, p.email]
        );
        if (cMatch.rows.length > 0) {
          contactId = cMatch.rows[0].id;
          await client.query(
            `UPDATE contacts SET
               converted_from_prospect_id = $1,
               account_id = COALESCE(account_id, $2),
               phone = COALESCE(phone, $3),
               title = COALESCE(title, $4),
               linkedin_url = COALESCE(linkedin_url, $5),
               location = COALESCE(location, $6),
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $7`,
            [p.id, accountId, p.phone, p.title, p.linkedin_url, p.location, contactId]
          );
        }
      }

      if (!contactId) {
        const newContact = await client.query(
          `INSERT INTO contacts (
             org_id, account_id, first_name, last_name, email, phone,
             title, location, linkedin_url, converted_from_prospect_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            req.orgId, accountId, p.first_name, p.last_name, p.email, p.phone,
            p.title, p.location, p.linkedin_url, p.id,
          ]
        );
        contactId = newContact.rows[0].id;
      }
    }

    // 3. Optionally create deal
    let dealId = null;
    if (createDeal) {
      let stageKey = dealStage;
      if (!stageKey) {
        const stageRes = await client.query(
          `SELECT key FROM pipeline_stages
           WHERE org_id = $1 AND pipeline = 'sales' AND is_active = TRUE AND is_terminal = FALSE
           ORDER BY sort_order ASC LIMIT 1`,
          [req.orgId]
        );
        stageKey = stageRes.rows[0]?.key || 'qualified';
      }

      const newDeal = await client.query(
        `INSERT INTO deals (org_id, owner_id, account_id, name, value, stage)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          req.orgId, req.user.userId, accountId,
          dealName || `${p.company_name || p.first_name + ' ' + p.last_name} — New Deal`,
          dealValue || 0, stageKey,
        ]
      );
      dealId = newDeal.rows[0].id;

      await client.query(
        `INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES ($1, $2, 'primary') ON CONFLICT DO NOTHING`,
        [dealId, contactId]
      );
    }

    // 4. Update prospect as converted
    await client.query(
      `UPDATE prospects
       SET stage = 'converted', stage_changed_at = CURRENT_TIMESTAMP,
           contact_id = $1, deal_id = $2, account_id = COALESCE(account_id, $3),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [contactId, dealId, accountId, p.id]
    );

    // 5. Log activity
    await client.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'converted', $3, $4)`,
      [
        p.id, req.user.userId,
        `Converted to contact${dealId ? ' + deal' : ''}`,
        JSON.stringify({ contactId, dealId, accountId }),
      ]
    );

    await client.query('COMMIT');

    console.log(`🎯 Prospect #${p.id} converted → contact #${contactId}${dealId ? ` + deal #${dealId}` : ''} (org ${req.orgId})`);

    res.json({ success: true, contactId, dealId, accountId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Convert prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to convert prospect' } });
  } finally {
    client.release();
  }
});

// ── POST /:id/link-account ────────────────────────────────────────────────────
router.post('/:id/link-account', async (req, res) => {
  try {
    const { accountId } = req.body;

    if (!accountId) {
      return res.status(400).json({ error: { message: 'accountId is required' } });
    }

    const acc = await db.query(
      'SELECT id, name FROM accounts WHERE id = $1 AND org_id = $2',
      [accountId, req.orgId]
    );
    if (acc.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Account not found' } });
    }

    const result = await db.query(
      `UPDATE prospects SET account_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [accountId, req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
       VALUES ($1, $2, 'account_linked', $3)`,
      [req.params.id, req.user.userId, `Linked to account: ${acc.rows[0].name}`]
    );

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Link account error:', error);
    res.status(500).json({ error: { message: 'Failed to link account' } });
  }
});

// ── POST /:id/link-contact ────────────────────────────────────────────────────
router.post('/:id/link-contact', async (req, res) => {
  try {
    const { contactId } = req.body;

    if (!contactId) {
      return res.status(400).json({ error: { message: 'contactId is required' } });
    }

    const contact = await db.query(
      'SELECT id, first_name, last_name FROM contacts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [contactId, req.orgId]
    );
    if (contact.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }

    const result = await db.query(
      `UPDATE prospects SET contact_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [contactId, req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const c = contact.rows[0];
    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
       VALUES ($1, $2, 'contact_linked', $3)`,
      [req.params.id, req.user.userId, `Linked to existing contact: ${c.first_name} ${c.last_name}`]
    );

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Link contact error:', error);
    res.status(500).json({ error: { message: 'Failed to link contact' } });
  }
});

// ── GET /:id/activities — activity timeline ──────────────────────────────────
router.get('/:id/activities', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pa.*, u.first_name AS user_first_name, u.last_name AS user_last_name
       FROM prospecting_activities pa
       LEFT JOIN users u ON pa.user_id = u.id
       WHERE pa.prospect_id = $1
       ORDER BY pa.created_at DESC`,
      [req.params.id]
    );
    res.json({ activities: result.rows });
  } catch (error) {
    console.error('Get activities error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch activities' } });
  }
});

// ── DELETE /:id — soft delete ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE prospects SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    res.json({ message: 'Prospect deleted' });
  } catch (error) {
    console.error('Delete prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to delete prospect' } });
  }
});

module.exports = router;
