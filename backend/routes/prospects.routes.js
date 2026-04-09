const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');
const ProspectContextBuilder  = require('../services/ProspectContextBuilder');
const PlaybookActionGenerator = require('../services/PlaybookActionGenerator');
const ActionWriter            = require('../services/ActionWriter');


router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ── Valid stage transitions ──────────────────────────────────────────────────
// const VALID_STAGES = ['target', 'researched', 'contacted', 'engaged', 'qualified', 'converted', 'disqualified', 'nurture'];

const VALID_STAGES = ['target', 'research', 'outreach', 'engaged', 'discovery_call', 'qualified_sal', 'disqualified', 'nurture'];

//const STAGE_TRANSITIONS = {
//  target:       ['researched', 'contacted', 'disqualified', 'nurture'],
//  researched:   ['contacted', 'disqualified', 'nurture'],
//  contacted:    ['engaged', 'qualified', 'disqualified', 'ss'],
//  engaged:      ['qualified', 'disqualified', 'nurture'],
//  qualified:    ['converted', 'disqualified', 'nurture'],
//  disqualified: ['target'],
//  nurture:      ['target', 'contacted'],
//};

const STAGE_TRANSITIONS = {
  target:        ['research', 'disqualified', 'nurture'],
  research:      ['outreach', 'disqualified', 'nurture'],
  outreach:      ['engaged', 'disqualified', 'nurture'],
  engaged:       ['discovery_call', 'disqualified', 'nurture'],
  discovery_call:['qualified_sal', 'disqualified', 'nurture'],
  qualified_sal: [],                 // terminal — no transitions out
  disqualified:  ['outreach'],       // re-engagement via outreach only
  nurture:       ['outreach'],       // re-entry to outreach only
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

    // Outreach/WK — count sent emails directly (more reliable than action rows)
    // Responses/WK — count received emails (replies) this week
    let emailOwnerFilter = '';
    const emailParams = [req.orgId];
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      emailOwnerFilter = `AND e.user_id = ANY($${emailParams.length + 1}::int[])`;
      emailParams.push(teamIds);
    } else if (scope !== 'org') {
      emailOwnerFilter = `AND e.user_id = $${emailParams.length + 1}`;
      emailParams.push(req.user.userId);
    }
    emailParams.push(weekStart);

    const outreachResult = await db.query(
      `SELECT
         COUNT(CASE WHEN e.direction = 'sent' THEN 1 END)     AS outreach_this_week,
         COUNT(CASE WHEN e.direction IN ('received','inbound') THEN 1 END) AS responses_this_week
       FROM emails e
       WHERE e.org_id = $1
         AND e.prospect_id IS NOT NULL
         ${emailOwnerFilter}
         AND e.sent_at >= $${emailParams.length}`,
      emailParams
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
              acc.name AS account_name, acc.industry AS account_industry
       FROM prospects p
       LEFT JOIN accounts acc ON p.account_id = acc.id
       WHERE p.id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (prospectResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const p = prospectResult.rows[0];

    // ── Build prospect info block ────────────────────────────────────────────
    const prospectInfo = [
      `Name: ${p.first_name} ${p.last_name}`,
      p.title            ? `Title: ${p.title}`                          : null,
      p.email            ? `Email: ${p.email}`                          : null,
      p.linkedin_url     ? `LinkedIn: ${p.linkedin_url}`                : null,
      p.company_name     ? `Company: ${p.company_name}`                 : null,
      p.company_domain   ? `Company domain: ${p.company_domain}`        : null,
      p.company_industry ? `Industry: ${p.company_industry}`            : null,
      p.company_size     ? `Company size: ${p.company_size}`            : null,
      p.location         ? `Location: ${p.location}`                    : null,
      p.account_name     ? `Account: ${p.account_name}`                 : null,
      p.account_industry ? `Account industry: ${p.account_industry}`    : null,
      p.tags?.length     ? `Tags: ${JSON.parse(p.tags || '[]').join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const companyInfo = [
      p.company_name     ? `Company: ${p.company_name}`                 : null,
      p.company_domain   ? `Domain: ${p.company_domain}`                : null,
      p.company_industry ? `Industry: ${p.company_industry}`            : null,
      p.company_size     ? `Size: ${p.company_size}`                    : null,
      p.location         ? `HQ location: ${p.location}`                 : null,
      p.account_name     ? `Account name: ${p.account_name}`            : null,
    ].filter(Boolean).join('\n');

    // ── Load AI settings + prompt templates ──────────────────────────────────
    const [userPrefRes, orgIntRes, userStage1Res, orgStage1Res, userStage2Res, orgStage2Res] = await Promise.all([
      db.query(
        `SELECT preferences FROM user_preferences WHERE user_id = $1 AND org_id = $2`,
        [req.user.userId, req.orgId]
      ),
      db.query(
        `SELECT config FROM org_integrations WHERE org_id = $1 AND integration_type = 'prospecting'`,
        [req.orgId]
      ),
      db.query(
        `SELECT template_data FROM user_prompts
         WHERE user_id = $1 AND org_id = $2 AND template_type = 'prospecting_research_account'`,
        [req.user.userId, req.orgId]
      ),
      db.query(
        `SELECT id, template FROM prompts
         WHERE org_id = $1 AND user_id IS NULL AND key = 'prospecting_research_account'`,
        [req.orgId]
      ),
      db.query(
        `SELECT template_data FROM user_prompts
         WHERE user_id = $1 AND org_id = $2 AND template_type = 'prospecting_research'`,
        [req.user.userId, req.orgId]
      ),
      db.query(
        `SELECT id, template FROM prompts
         WHERE org_id = $1 AND user_id IS NULL AND key = 'prospecting_research'`,
        [req.orgId]
      ),
    ]);

    const userPrefs  = userPrefRes.rows[0]?.preferences || {};
    const orgConfig  = orgIntRes.rows[0]?.config || {};
    const prospPrefs = userPrefs.prospecting || {};

    // Fallback chain: user → org → system default
    const sanitiseModel = (m) => {
      if (!m) return m;
      return m
        .replace('claude-sonnet-4-5-20251022', 'claude-sonnet-4-6')
        .replace('claude-haiku-4-5-20251001', 'claude-haiku-4-5')
        .replace('claude-sonnet-4-20250514',  'claude-sonnet-4-6');
    };
    const aiModel    = sanitiseModel(prospPrefs.ai_model || orgConfig.ai_model) || 'claude-sonnet-4-6';
    const aiProvider = prospPrefs.ai_provider || orgConfig.ai_provider || 'anthropic';
    const productCtx = prospPrefs.product_context !== undefined
                         ? prospPrefs.product_context
                         : (orgConfig.product_context || '');

    const AI_PROMPTS = require('../config/aiPrompts');

    // ── Helper: call the configured AI provider ───────────────────────────────
    const TokenTrackingService = require('../services/TokenTrackingService');

    // callAI — returns { text, usage } so callers can log tokens
    async function callAI(prompt, maxTokens = 800, callType = 'prospecting_research') {
      if (aiProvider === 'openai') {
        const { OpenAI } = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const completion = await openai.chat.completions.create({
          model: aiModel || 'gpt-4o-mini', max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        });
        const usage = completion.usage
          ? { input_tokens: completion.usage.prompt_tokens, output_tokens: completion.usage.completion_tokens }
          : {};
        TokenTrackingService.log({ orgId: req.orgId, userId: req.user.userId, callType, provider: 'openai', model: aiModel, usage }).catch(() => {});
        return { text: completion.choices[0]?.message?.content || '', usage };
      } else if (aiProvider === 'gemini') {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
        const result = await genAI.getGenerativeModel({ model: aiModel || 'gemini-1.5-flash' })
                                  .generateContent(prompt);
        // Gemini doesn't return token counts in basic API — log with zeros
        TokenTrackingService.log({ orgId: req.orgId, userId: req.user.userId, callType, provider: 'gemini', model: aiModel, usage: {} }).catch(() => {});
        return { text: result.response.text() || '', usage: {} };
      } else {
        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const message = await anthropic.messages.create({
          model: aiModel, max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        });
        const usage = message.usage
          ? { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens }
          : {};
        TokenTrackingService.log({ orgId: req.orgId, userId: req.user.userId, callType, provider: 'anthropic', model: aiModel, usage }).catch(() => {});
        return { text: message.content[0]?.text || '', usage };
      }
    }

    // ── STAGE 1: Account research (cached, reused across prospects) ───────────
    // Check if account already has fresh research (< 30 days old)
    let accountResearchText = '';
    let accountResearchJson = null;
    const CACHE_DAYS = 30;

    if (p.account_id) {
      const accountRes = await db.query(
        `SELECT research_notes, research_updated_at FROM accounts
         WHERE id = $1 AND org_id = $2`,
        [p.account_id, req.orgId]
      );
      const acct = accountRes.rows[0];
      const isStale = !acct?.research_updated_at ||
        (Date.now() - new Date(acct.research_updated_at).getTime()) > CACHE_DAYS * 24 * 60 * 60 * 1000;

      if (acct?.research_notes && !isStale) {
        // Use cached account research
        accountResearchText = typeof acct.research_notes === 'string'
          ? acct.research_notes
          : JSON.stringify(acct.research_notes, null, 2);
        console.log(`📋 Using cached account research for account ${p.account_id}`);
      } else {
        // Run Stage 1 — fresh account research
        console.log(`🔍 Running Stage 1 account research for ${p.company_name}...`);
        const stage1Template = userStage1Res.rows[0]?.template_data
          || orgStage1Res.rows[0]?.template
          || AI_PROMPTS.prospecting_research_account
          || '';

        if (stage1Template) {
          const stage1Prompt = stage1Template
            .replace('{{companyInfo}}',   companyInfo)
            .replace('{{productContext}}', productCtx || 'Not specified');

          const { text: stage1Raw } = await callAI(stage1Prompt, 1000, 'research_account');

          // Parse JSON response from Stage 1
          try {
            const cleaned = stage1Raw.replace(/\`\`\`json\n?/gi, '').replace(/\`\`\`\n?/g, '').trim();
            const start = cleaned.indexOf('{');
            const end   = cleaned.lastIndexOf('}');
            accountResearchJson = JSON.parse(cleaned.substring(start, end + 1));
            accountResearchText = JSON.stringify(accountResearchJson, null, 2);
          } catch {
            accountResearchText = stage1Raw; // Use raw text if not valid JSON
          }

          // Determine which prompt was used for Stage 1
          const stage1PromptId     = orgStage1Res.rows[0]?.id     || null;
          const stage1PromptSource = userStage1Res.rows[0]
            ? 'user_override'
            : orgStage1Res.rows[0] ? 'org_default' : 'system_default';

          const accountMeta = {
            provider:            aiProvider,
            model:               aiModel,
            stage1_prompt_id:    stage1PromptId,
            stage1_prompt_key:   'prospecting_research_account',
            stage1_prompt_source: stage1PromptSource,
            generated_by_user_id: req.user.userId,
            generated_at:        new Date().toISOString(),
          };

          // Cache to accounts table
          db.query(
            `UPDATE accounts
             SET research_notes       = $1,
                 research_updated_at  = CURRENT_TIMESTAMP,
                 research_meta        = $2::jsonb,
                 updated_at           = CURRENT_TIMESTAMP
             WHERE id = $3 AND org_id = $4`,
            [accountResearchText, JSON.stringify(accountMeta), p.account_id, req.orgId]
          ).catch(err => console.warn('Account research cache save failed:', err.message));
        }
      }
    }

    // ── STAGE 2: Individual person research + pitch ───────────────────────────
    console.log(`🎯 Running Stage 2 person research for ${p.first_name} ${p.last_name}...`);
    const stage2Template = userStage2Res.rows[0]?.template_data
      || orgStage2Res.rows[0]?.template
      || AI_PROMPTS.prospecting_research
      || '';

    const stage2SystemDefault = `You are an expert B2B sales researcher. Based on the prospect and account info below, generate research bullets and a crisp pitch.

PERSON:
{{prospectInfo}}

ACCOUNT RESEARCH:
{{accountResearch}}

WHAT WE SELL:
{{productContext}}

Return ONLY valid JSON:
{
  "researchBullets": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"],
  "pitchAngle": "Single strongest angle for this person",
  "crispPitch": "3-5 sentence pitch written directly to them",
  "subjectLine": "Email subject line",
  "confidence": 0.8
}`;

    const stage2Prompt = (stage2Template || stage2SystemDefault)
      .replace('{{prospectInfo}}',   prospectInfo)
      .replace('{{accountResearch}}', accountResearchText || 'No account research available.')
      .replace('{{productContext}}',  productCtx || 'Not specified');

    const { text: stage2Raw } = await callAI(stage2Prompt, 900, 'research_person');

    // Parse Stage 2 JSON
    let parsed = null;
    let researchNotes = '';
    try {
      const cleaned = stage2Raw.replace(/\`\`\`json\n?/gi, '').replace(/\`\`\`\n?/g, '').trim();
      const start = cleaned.indexOf('{');
      const end   = cleaned.lastIndexOf('}');
      parsed = JSON.parse(cleaned.substring(start, end + 1));

      // Format research notes as bullet points for storage
      const bullets = parsed.researchBullets || [];
      researchNotes = bullets.map(b => `• ${b}`).join('\n');
      if (parsed.pitchAngle)  researchNotes += `\n\n💡 Pitch angle: ${parsed.pitchAngle}`;
      if (parsed.crispPitch)  researchNotes += `\n\n✉️ Crisp pitch:\n${parsed.crispPitch}`;
      if (parsed.subjectLine) researchNotes += `\n\n📧 Subject: ${parsed.subjectLine}`;
    } catch {
      // Fallback: store raw text
      researchNotes = stage2Raw;
    }

    if (!researchNotes) {
      return res.status(500).json({ error: { message: 'Research generation returned empty response' } });
    }

    // Determine which prompt was used for Stage 2
    const stage2PromptId     = orgStage2Res.rows[0]?.id || null;
    const stage2PromptSource = userStage2Res.rows[0]
      ? 'user_override'
      : orgStage2Res.rows[0] ? 'org_default' : 'system_default';

    const prospectMeta = {
      provider:            aiProvider,
      model:               aiModel,
      stage2_prompt_id:    stage2PromptId,
      stage2_prompt_key:   'prospecting_research',
      stage2_prompt_source: stage2PromptSource,
      account_research_used: !!accountResearchText,
      account_research_cached: !!(p.account_id && accountResearchText),
      generated_by_user_id: req.user.userId,
      generated_at:        new Date().toISOString(),
      confidence:          parsed?.confidence || null,
    };

    // Save research notes + meta to prospect
    await db.query(
      `UPDATE prospects
       SET research_notes = $1,
           research_meta  = $2::jsonb,
           updated_at     = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4`,
      [researchNotes, JSON.stringify(prospectMeta), req.params.id, req.orgId]
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
        JSON.stringify({ stageAdvanced, model: aiModel, provider: aiProvider }),
      ]
    );

    res.json({
      researchNotes,
      stageAdvanced,
      newStage:           stageAdvanced ? 'researched' : p.stage,
      // Structured fields from Stage 2 parse (null if parse failed)
      researchBullets:    parsed?.researchBullets    || null,
      pitchAngle:         parsed?.pitchAngle         || null,
      crispPitch:         parsed?.crispPitch         || null,
      suggestedSubject:   parsed?.subjectLine        || null,
      confidence:         parsed?.confidence         || null,
      // Account research cached flag
      accountResearchCached: !!accountResearchText,
      accountResearch:    accountResearchJson,
      // Meta: what generated this research
      meta: {
        provider:      aiProvider,
        model:         aiModel,
        promptSources: {
          account: userStage1Res.rows[0] ? 'user_override' : orgStage1Res.rows[0] ? 'org_default' : 'system_default',
          person:  userStage2Res.rows[0] ? 'user_override' : orgStage2Res.rows[0] ? 'org_default' : 'system_default',
        },
      },
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
//router.post('/:id/disqualify', async (req, res) => {
//  req.body.stage = 'disqualified';
//  req.body.reason = req.body.reason || 'Not a fit';
//  return router.handle(Object.assign(req, { url: `/${req.params.id}/stage`, method: 'POST' }), res);
//});

router.post('/:id/disqualify', async (req, res) => {
  const client = await require('../config/database').pool.connect();
  try {
    const {
      reason,                // 'kill' | 'long_term' | 'unable_to_decide'  (required)
      accountDisposition,    // 'kill_account' | 'long_term_account' | 'unable_to_decide_account'  (optional)
      revisitDate,           // ISO date string override — if omitted, defaults are applied
      accountRevisitDate,    // ISO date string for account — optional
    } = req.body;

    // ── Validate reason ──────────────────────────────────────────
    const VALID_REASONS = ['kill', 'long_term', 'unable_to_decide'];
    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({
        error: {
          message: `reason is required and must be one of: ${VALID_REASONS.join(', ')}`,
        },
      });
    }

    // ── Validate accountDisposition if provided ──────────────────
    const VALID_DISPOSITIONS = ['kill_account', 'long_term_account', 'unable_to_decide_account'];
    if (accountDisposition && !VALID_DISPOSITIONS.includes(accountDisposition)) {
      return res.status(400).json({
        error: {
          message: `accountDisposition must be one of: ${VALID_DISPOSITIONS.join(', ')}`,
        },
      });
    }

    // ── Load prospect ────────────────────────────────────────────
    const current = await client.query(
      `SELECT id, stage, account_id, owner_id
       FROM prospects
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const prospect     = current.rows[0];
    const currentStage = prospect.stage;

    // ── Check transition is permitted ────────────────────────────
    const allowed = STAGE_TRANSITIONS[currentStage] || [];
    if (currentStage !== 'disqualified' && !allowed.includes('disqualified')) {
      return res.status(400).json({
        error: {
          message: `Cannot disqualify a prospect in stage "${currentStage}"`,
        },
      });
    }

    // ── Compute revisit_date default if not provided ─────────────
    let computedRevisitDate = revisitDate || null;
    if (!computedRevisitDate) {
      const today = new Date();
      if (reason === 'long_term') {
        today.setDate(today.getDate() + 90);
        computedRevisitDate = today.toISOString().split('T')[0];
      } else if (reason === 'unable_to_decide') {
        today.setDate(today.getDate() + 45);
        computedRevisitDate = today.toISOString().split('T')[0];
      }
      // reason === 'kill' → computedRevisitDate stays null
    }

    await client.query('BEGIN');

    // ── 1. Update prospect ───────────────────────────────────────
    const prospectResult = await client.query(
      `UPDATE prospects
       SET stage               = 'disqualified',
           stage_changed_at    = CURRENT_TIMESTAMP,
           disqualified_reason = $1,
           revisit_date        = $2,
           updated_at          = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4
       RETURNING *`,
      [reason, computedRevisitDate, req.params.id, req.orgId]
    );

    // ── 2. Update account disposition if provided ────────────────
    let updatedAccount = null;
    if (accountDisposition && prospect.account_id) {
      const computedAccountRevisitDate = accountRevisitDate || (
        accountDisposition === 'long_term_account'
          ? (() => { const d = new Date(); d.setDate(d.getDate() + 90); return d.toISOString().split('T')[0]; })()
          : accountDisposition === 'unable_to_decide_account'
          ? (() => { const d = new Date(); d.setDate(d.getDate() + 45); return d.toISOString().split('T')[0]; })()
          : null
      );

      const accResult = await client.query(
        `UPDATE accounts
         SET account_disposition  = $1,
             account_revisit_date = $2,
             updated_at           = CURRENT_TIMESTAMP
         WHERE id = $3 AND org_id = $4
         RETURNING id, name, account_disposition, account_revisit_date`,
        [accountDisposition, computedAccountRevisitDate, prospect.account_id, req.orgId]
      );
      updatedAccount = accResult.rows[0] || null;
    }

    // ── 3. Log activity ──────────────────────────────────────────
    await client.query(
      `INSERT INTO prospecting_activities
         (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'stage_change', $3, $4)`,
      [
        req.params.id,
        req.user.userId,
        `Disqualified from ${currentStage} — reason: ${reason}`,
        JSON.stringify({
          from:               currentStage,
          to:                 'disqualified',
          reason,
          revisitDate:        computedRevisitDate,
          accountDisposition: accountDisposition || null,
          accountRevisitDate: accountRevisitDate || null,
        }),
      ]
    );

    await client.query('COMMIT');

    console.log(`🚫 Prospect #${req.params.id} disqualified (reason: ${reason}, revisit: ${computedRevisitDate || 'none'}) by user ${req.user.userId} (org ${req.orgId})`);

    res.json({
      prospect:        prospectResult.rows[0],
      account:         updatedAccount,
      revisitDate:     computedRevisitDate,
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Disqualify prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to disqualify prospect' } });
  } finally {
    client.release();
  }
});

// ── POST /:id/nurture ─────────────────────────────────────────────────────────
router.post('/:id/nurture', async (req, res) => {
  try {
    const { revisit_date, reason } = req.body;

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
           revisit_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3
       RETURNING *`,
      [revisit_date || null, req.params.id, req.orgId]
    );

    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'stage_change', $3, $4)`,
      [
        req.params.id, req.user.userId,
        `Moved to nurture from ${current.rows[0].stage}`,
        JSON.stringify({ from: current.rows[0].stage, to: 'nurture', revisit_date, reason }),
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

// ── GET /by-linkedin-url — look up prospect by LinkedIn profile URL ───────────
// Used by the Chrome extension. Must be defined BEFORE /:id routes.
// Query: ?url=https://www.linkedin.com/in/username
router.get('/by-linkedin-url', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: { message: 'url query param is required' } });
    }

    const normalised = url.replace(/\/$/, '').split('?')[0].toLowerCase();

    const result = await db.query(
      `SELECT p.*,
              acc.name  AS account_name,
              u.first_name AS owner_first_name,
              u.last_name  AS owner_last_name
       FROM prospects p
       LEFT JOIN accounts acc ON p.account_id = acc.id
       LEFT JOIN users    u   ON p.owner_id   = u.id
       WHERE p.org_id = $1
         AND LOWER(TRIM(TRAILING '/' FROM p.linkedin_url)) = $2
         AND p.deleted_at IS NULL
       LIMIT 1`,
      [req.orgId, normalised]
    );

    if (result.rows.length === 0) {
      return res.json({ prospect: null });
    }

    const row = result.rows[0];
    res.json({
      prospect: {
        ...row,
        account: row.account_id ? { id: row.account_id, name: row.account_name } : null,
        owner:   { first_name: row.owner_first_name, last_name: row.owner_last_name },
      },
    });
  } catch (error) {
    console.error('LinkedIn URL lookup error:', error);
    res.status(500).json({ error: { message: 'Lookup failed' } });
  }
});

// ── POST /:id/linkedin-event — log a LinkedIn interaction ─────────────────────
//
// Body:
//   event     {string}  required — see VALID_EVENTS
//   note      {string}  optional — message text or reply summary (max 500 chars)
//   sentiment {string}  optional — positive | neutral | negative | follow_up_later
//
// Events:
//   connection_request_sent  bumps outreach_count, sets request_sent_at
//   connection_accepted      sets connected_at (no counter — prospect action)
//   message_sent             bumps outreach_count, sets last_message_at, message_count++
//   inmail_sent              bumps outreach_count, sets last_message_at, inmail_count++
//   reply_received           bumps response_count, sets last_reply_at, stores sentiment
//   voice_note_sent          bumps outreach_count, sets last_voice_note_at
//   profile_viewed           sets last_profile_view_at (no counters)
//   meeting_booked           bumps response_count, sets meeting_booked_at
//
router.post('/:id/linkedin-event', async (req, res) => {
  try {
    const { event, note, sentiment } = req.body;

    const VALID_EVENTS = [
      'connection_request_sent',
      'connection_accepted',
      'message_sent',
      'inmail_sent',
      'reply_received',
      'voice_note_sent',
      'profile_viewed',
      'meeting_booked',
    ];

    const VALID_SENTIMENTS = ['positive', 'neutral', 'negative', 'follow_up_later'];

    if (!event || !VALID_EVENTS.includes(event)) {
      return res.status(400).json({ error: { message: `event must be one of: ${VALID_EVENTS.join(', ')}` } });
    }
    if (sentiment && !VALID_SENTIMENTS.includes(sentiment)) {
      return res.status(400).json({ error: { message: `sentiment must be one of: ${VALID_SENTIMENTS.join(', ')}` } });
    }

    const prospectRes = await db.query(
      `SELECT id, channel_data, outreach_count, response_count
       FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (prospectRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const p           = prospectRes.rows[0];
    const channelData = p.channel_data || {};
    const li          = channelData.linkedin || {};
    const now         = new Date().toISOString();

    // Advance connection_status — never go backwards
    const STATUS_ORDER = [
      'connection_request_sent', 'connection_accepted',
      'message_sent', 'reply_received', 'meeting_booked',
    ];
    const statusForEvent   = event === 'inmail_sent' ? 'message_sent' : event;
    const currentStatusIdx = STATUS_ORDER.indexOf(li.connection_status || '');
    const newStatusIdx     = STATUS_ORDER.indexOf(statusForEvent);
    if (newStatusIdx > currentStatusIdx) {
      li.connection_status = statusForEvent;
    }

    // Per-event timestamp + counter updates
    switch (event) {
      case 'connection_request_sent':
        li.request_sent_at = now;
        if (note) li.request_note = note.substring(0, 500);
        break;
      case 'connection_accepted':
        li.connected_at = now;
        break;
      case 'message_sent':
        li.last_message_at   = now;
        li.message_count     = (li.message_count || 0) + 1;
        if (note) li.last_message_text = note.substring(0, 500);
        break;
      case 'inmail_sent':
        li.last_message_at = now;
        li.inmail_count    = (li.inmail_count || 0) + 1;
        li.message_count   = (li.message_count || 0) + 1;
        if (note) li.last_message_text = note.substring(0, 500);
        break;
      case 'reply_received':
        li.last_reply_at  = now;
        li.reply_count    = (li.reply_count || 0) + 1;
        if (sentiment) li.last_reply_sentiment = sentiment;
        if (note)      li.last_reply_text      = note.substring(0, 500);
        break;
      case 'voice_note_sent':
        li.last_voice_note_at = now;
        li.voice_note_count   = (li.voice_note_count || 0) + 1;
        break;
      case 'profile_viewed':
        li.last_profile_view_at = now;
        break;
      case 'meeting_booked':
        li.meeting_booked_at = now;
        if (note) li.meeting_note = note.substring(0, 500);
        break;
    }

    channelData.linkedin = li;

    const isOutreach = ['connection_request_sent', 'message_sent', 'inmail_sent', 'voice_note_sent'].includes(event);
    const isResponse = ['reply_received', 'meeting_booked'].includes(event);

    await db.query(
      `UPDATE prospects SET
         channel_data     = $1::jsonb,
         last_outreach_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE last_outreach_at END,
         outreach_count   = CASE WHEN $2 THEN COALESCE(outreach_count, 0) + 1 ELSE outreach_count END,
         last_response_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE last_response_at END,
         response_count   = CASE WHEN $3 THEN COALESCE(response_count, 0) + 1 ELSE response_count END,
         updated_at       = CURRENT_TIMESTAMP
       WHERE id = $4 AND org_id = $5`,
      [JSON.stringify(channelData), isOutreach, isResponse, req.params.id, req.orgId]
    );

    const EVENT_LABELS = {
      connection_request_sent: 'LinkedIn connection request sent',
      connection_accepted:     'LinkedIn connection accepted',
      message_sent:            'LinkedIn message sent',
      inmail_sent:             'LinkedIn InMail sent',
      reply_received:          'LinkedIn reply received',
      voice_note_sent:         'LinkedIn voice note sent',
      profile_viewed:          'LinkedIn profile viewed',
      meeting_booked:          'Meeting booked via LinkedIn',
    };

    const descParts = [
      EVENT_LABELS[event],
      sentiment ? `(${sentiment})` : null,
      note       ? `: ${note.substring(0, 120)}` : null,
    ].filter(Boolean);

    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'linkedin_event', $3, $4)`,
      [
        req.params.id, req.user.userId,
        descParts.join(' '),
        JSON.stringify({ event, channel: 'linkedin', sentiment: sentiment || null }),
      ]
    );

    console.log(`🔗 LinkedIn "${event}" logged for prospect #${req.params.id} (org ${req.orgId})`);
    res.json({ success: true, event, channelData });

  } catch (error) {
    console.error('LinkedIn event error:', error);
    res.status(500).json({ error: { message: 'Failed to record LinkedIn event' } });
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


// ── POST /:id/generate-actions ───────────────────────────────────────────────
// Generate actions from the prospect's playbook for the current stage.
//
// Body: {
//   mode?:        'template' | 'ai',   — defaults to 'template'
//   deduplicate?: boolean,             — skip plays already actioned (default true)
// }
router.post('/:id/generate-actions', async (req, res) => {
  try {
    const prospectId = parseInt(req.params.id);
    const userId     = req.user.userId;
    const orgId      = req.orgId;
    const { mode = 'template', deduplicate = true } = req.body;

    // Validate prospect belongs to org
    const prospectRes = await db.query(
      'SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [prospectId, orgId]
    );
    if (prospectRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }
    const prospect = prospectRes.rows[0];
    const stageKey = prospect.stage;

    if (!stageKey) {
      return res.status(400).json({ error: { message: 'Prospect has no stage assigned' } });
    }

    // Build full context
    const context = await ProspectContextBuilder.build(prospectId, userId, orgId);

    // Generate action rows
    const { actions, playbookId, playbookName, mode: effectiveMode } =
      await PlaybookActionGenerator.generate({
        entityType: 'prospect',
        context,
        playbookId: prospect.playbook_id || context.playbook?.id || null,
        stageKey,
        mode,
        orgId,
        userId,
      });

    if (actions.length === 0) {
      return res.json({
        inserted: 0, skipped: 0,
        playbookName: playbookName || null,
        mode: effectiveMode,
        message: playbookName
          ? `No plays defined for stage "${stageKey}" in "${playbookName}"`
          : 'No playbook found for this prospect',
      });
    }

    // Write to prospecting_actions table
    const result = await ActionWriter.write({
      entityType:        'prospect',
      entityId:          prospectId,
      actions,
      playbookId,
      playbookName,
      orgId,
      userId,
      deduplicateSource: deduplicate ? 'playbook' : null,
    });

    // Log activity
    if (result.inserted > 0) {
      await db.query(
        `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
         VALUES ($1, $2, 'actions_generated', $3, $4)`,
        [
          prospectId, userId,
          `Generated ${result.inserted} action(s) from "${playbookName || 'playbook'}" via ${effectiveMode} mode`,
          JSON.stringify({ playbookId, stage: stageKey, mode: effectiveMode, inserted: result.inserted }),
        ]
      ).catch(() => {});
    }

    res.json({
      inserted:     result.inserted,
      skipped:      result.skipped,
      playbookName: playbookName || null,
      mode:         effectiveMode,
      message:      `Generated ${result.inserted} action(s) from "${playbookName || 'playbook'}"`,
    });

  } catch (err) {
    console.error('generate-actions (prospect) error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});


module.exports = router;
