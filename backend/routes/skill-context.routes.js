// routes/skill-context.routes.js
//
// Backend-to-backend route for the Skills Runner PoC.
// Auth: x-skill-runner-token header (shared secret, NOT user JWT).
// Returns canonical, CRM-agnostic deal payload for skill consumption.
//
// IMPORTANT — Row-level security:
// The DB has RLS policies like `org_id = current_setting('app.current_org_id')`
// on most tables. Since this route has no user/session context, we explicitly
// SET the session variable after fetching the deal's org_id from an unscoped lookup.

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const { buildProspectSkillContext } = require('../services/SkillContextService');

// ─────────────────────────────────────────────────────────────
// Auth middleware — shared secret
// ─────────────────────────────────────────────────────────────
function requireSkillRunnerToken(req, res, next) {
  const provided = req.headers['x-skill-runner-token'];
  const expected = process.env.SKILL_RUNNER_TOKEN;

  if (!expected) {
    console.error('SKILL_RUNNER_TOKEN env var is not set on the backend');
    return res.status(500).json({ error: { message: 'Server misconfigured' } });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: { message: 'Invalid skill runner token' } });
  }
  next();
}

router.use(requireSkillRunnerToken);

// ─────────────────────────────────────────────────────────────
// Small helper: safely query a table that may not exist in every environment.
// Returns [] instead of throwing when the table/column is missing.
// ─────────────────────────────────────────────────────────────
async function safeQuery(client, sql, params) {
  try {
    const r = await client.query(sql, params);
    return r.rows;
  } catch (err) {
    if (err.code === '42P01' /* undefined_table */ ||
        err.code === '42703' /* undefined_column */) {
      console.warn('[skill-context] Optional query skipped:', err.message);
      return [];
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// GET /api/skill-context/deals/:dealId
// ─────────────────────────────────────────────────────────────
router.get('/deals/:dealId', async (req, res) => {
  const { dealId } = req.params;

  if (!/^\d+$/.test(dealId)) {
    return res.status(400).json({ error: { message: 'dealId must be numeric' } });
  }

  let client;
  try {
    client = await pool.connect();

    // ── Step 1: lookup the deal's org_id (pre-RLS) ──
    const dealCoreRes = await client.query(
      `SELECT id, org_id FROM deals WHERE id = $1`,
      [dealId]
    );

    if (dealCoreRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }
    const orgId = dealCoreRes.rows[0].org_id;

    // ── Step 2: set RLS session variable for this connection ──
    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    // ── Deal (full details) ────────────────────────────────
    const dealRes = await client.query(
      `SELECT id, name, stage, stage_type, playbook_id, created_at,
              value, account_id, economic_buyer_contact_id,
              stage_changed_at, expected_close_date, health, health_score,
              external_crm_type, competitive_competitors,
              buyer_event_description, legal_engaged_user, security_review_user,
              EXTRACT(DAY FROM (NOW() - COALESCE(stage_changed_at, created_at)))::int AS days_in_stage
         FROM deals WHERE id = $1`,
      [dealId]
    );
    const deal = dealRes.rows[0];

    // ── Primary contact: prefer deal_contacts; fall back to economic buyer ──
    let prospectContact = null;
    const dealContacts = await safeQuery(client,
      `SELECT c.id, c.first_name, c.last_name, c.title, c.email,
              c.linkedin_url, c.role_type, c.engagement_level
         FROM deal_contacts dc
         JOIN contacts c ON c.id = dc.contact_id
        WHERE dc.deal_id = $1
        ORDER BY CASE
                   WHEN c.role_type = 'economic_buyer' THEN 1
                   WHEN c.role_type = 'champion'       THEN 2
                   WHEN c.role_type = 'decision_maker' THEN 3
                   ELSE 4
                 END
        LIMIT 1`,
      [dealId]);

    if (dealContacts.length > 0) {
      prospectContact = dealContacts[0];
    } else if (deal.economic_buyer_contact_id) {
      const ebRows = await safeQuery(client,
        `SELECT id, first_name, last_name, title, email, linkedin_url
           FROM contacts WHERE id = $1`,
        [deal.economic_buyer_contact_id]);
      prospectContact = ebRows[0] || null;
    }

    // ── Account ────────────────────────────────────────────
    const accountRows = await safeQuery(client,
      `SELECT id, name, industry, size, location, description, domain
         FROM accounts WHERE id = $1`,
      [deal.account_id]);
    const account = accountRows[0] || {};

    // ── Economic buyer name ───────────────────────────────
    let economicBuyerName = null;
    if (deal.economic_buyer_contact_id) {
      const ebRows = await safeQuery(client,
        `SELECT first_name, last_name, title FROM contacts WHERE id = $1`,
        [deal.economic_buyer_contact_id]);
      if (ebRows[0]) {
        const eb = ebRows[0];
        economicBuyerName = `${eb.first_name} ${eb.last_name}${eb.title ? ' (' + eb.title + ')' : ''}`;
      }
    }

    // ── Champion name ─────────────────────────────────────
    let championName = null;
    const champRows = await safeQuery(client,
      `SELECT c.first_name, c.last_name, c.title
         FROM deal_contacts dc
         JOIN contacts c ON c.id = dc.contact_id
        WHERE dc.deal_id = $1 AND c.role_type = 'champion'
        LIMIT 1`,
      [dealId]);
    if (champRows[0]) {
      const ch = champRows[0];
      championName = `${ch.first_name} ${ch.last_name}${ch.title ? ' (' + ch.title + ')' : ''}`;
    }

    // ── Interaction history — 3 queries (safer than one UNION) ──
    // Emails
    const emails = await safeQuery(client,
      `SELECT 'email' AS type,
              COALESCE(created_at) AS ts,
              COALESCE(subject, '(no subject)') AS summary,
              NULL::text AS direction
         FROM emails
        WHERE deal_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT 10`,
      [dealId]);

    // Meetings
    const meetings = await safeQuery(client,
      `SELECT 'meeting' AS type,
              COALESCE(created_at) AS ts,
              COALESCE(title, '(meeting)') AS summary,
              NULL::text AS direction
         FROM meetings
        WHERE deal_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT 10`,
      [dealId]);

    // Actions
    const actions = await safeQuery(client,
      `SELECT COALESCE(type, 'note') AS type,
              COALESCE(created_at) AS ts,
              COALESCE(description, title, '(action)') AS summary,
              NULL::text AS direction
         FROM actions
        WHERE deal_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT 10`,
      [dealId]);

    const allInteractions = [...emails, ...meetings, ...actions]
      .filter(r => r.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 10);

    // ── MEDDPICC composed from deals + deal_contacts ──────
    const meddpicc = {
      metrics: null,
      economic_buyer: economicBuyerName,
      decision_criteria: null,
      decision_process: (deal.legal_engaged_user || deal.security_review_user)
        ? `Legal engaged: ${deal.legal_engaged_user ? 'yes' : 'no'}; Security review: ${deal.security_review_user ? 'yes' : 'no'}`
        : null,
      paper_process: null,
      identified_pain: deal.buyer_event_description || null,
      champion: championName,
      competition: deal.competitive_competitors
        ? JSON.stringify(deal.competitive_competitors)
        : null,
    };

    // ── Compose final canonical payload ────────────────────
    const payload = {
      prospect: prospectContact ? {
        name: [prospectContact.first_name, prospectContact.last_name].filter(Boolean).join(' '),
        title: prospectContact.title || '',
        company: account.name || '',
        linkedin_url: prospectContact.linkedin_url || undefined,
        email: prospectContact.email || undefined,
      } : {
        name: 'Unknown',
        title: '',
        company: account.name || '',
      },
      account: {
        industry: account.industry || '',
        size: account.size || '',
        revenue_band: undefined,
        recent_signals: [],
      },
      deal: {
        stage: deal.stage,
        source: deal.external_crm_type ? `external_${deal.external_crm_type}` : 'unknown',
        playbook_id: deal.playbook_id,
        created_at: deal.created_at,
        amount: deal.value ? Number(deal.value) : undefined,
        days_in_stage: deal.days_in_stage || 0,
      },
      interaction_history: allInteractions.map(r => ({
        type: r.type,
        timestamp: r.ts,
        summary: r.summary,
        direction: r.direction || undefined,
      })),
      meddpicc,
    };

    res.json(payload);
  } catch (err) {
    console.error('skill-context fetch failed:', err);
    res.status(500).json({ error: { message: err.message } });
  } finally {
    if (client) client.release();
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/skill-context/prospects/:prospectId
//
// Optional query params:
//   ?as_user=:userId  - merge user-level prospecting_config overrides on top
//                        of org-default config. When omitted, returns
//                        org-default org_context only (with prospect owner
//                        used for rep info as a courtesy fallback).
//
// Returns the canonical gowarm-prospect.json-shaped payload.
// ─────────────────────────────────────────────────────────────
router.get('/prospects/:prospectId', async (req, res) => {
  const { prospectId } = req.params;
  const asUserIdRaw = req.query.as_user;

  if (!/^\d+$/.test(prospectId)) {
    return res.status(400).json({ error: { message: 'prospectId must be numeric' } });
  }
  if (asUserIdRaw && !/^\d+$/.test(asUserIdRaw)) {
    return res.status(400).json({ error: { message: 'as_user must be numeric' } });
  }

  let client;
  try {
    client = await pool.connect();

    // Step 1: lookup prospect's org_id (pre-RLS) — same pattern as deal route
    const orgLookup = await client.query(
      `SELECT id, org_id FROM prospects
        WHERE id = $1 AND deleted_at IS NULL`,
      [prospectId]
    );
    if (orgLookup.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }
    const orgId = orgLookup.rows[0].org_id;

    // We release this client; the service grabs its own connection
    client.release();
    client = null;

    const payload = await buildProspectSkillContext({
      prospectId: parseInt(prospectId, 10),
      orgId,
      asUserId: asUserIdRaw ? parseInt(asUserIdRaw, 10) : null,
    });

    res.json(payload);
  } catch (err) {
    if (client) { client.release(); client = null; }
    if (err.statusCode === 404) {
      return res.status(404).json({ error: { message: err.message } });
    }
    console.error('skill-context prospect fetch failed:', err);
    res.status(500).json({ error: { message: err.message } });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
