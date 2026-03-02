// ─────────────────────────────────────────────────────────────────────────────
// orgSeed.service.js
//
// Seeds sensible defaults for a newly created organisation so it's ready to
// use without manual setup.  Call `seedOrg(orgId)` right after the INSERT
// INTO organizations.
//
// What gets seeded:
//   1. Prospect pipeline stages  (prospect_stages table)
//   2. Deal pipeline stages      (deal_stages table)
//   3. Starter prospecting playbook with stage guidance
//   4. Starter sales playbook with stage guidance
//
// Safe to call multiple times — every INSERT uses ON CONFLICT DO NOTHING
// so existing data is never overwritten.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');

// ── 1. Default Prospect Stages ──────────────────────────────────────────────

const DEFAULT_PROSPECT_STAGES = [
  { key: 'target',       name: 'Target',       stage_type: 'targeting',      sort_order: 10, is_terminal: false, color: '#6b7280' },
  { key: 'researched',   name: 'Researched',   stage_type: 'research',       sort_order: 20, is_terminal: false, color: '#8b5cf6' },
  { key: 'contacted',    name: 'Contacted',    stage_type: 'outreach',       sort_order: 30, is_terminal: false, color: '#3b82f6' },
  { key: 'engaged',      name: 'Engaged',      stage_type: 'engagement',     sort_order: 40, is_terminal: false, color: '#f59e0b' },
  { key: 'qualified',    name: 'Qualified',    stage_type: 'qualification',  sort_order: 50, is_terminal: false, color: '#10b981' },
  { key: 'converted',    name: 'Converted',    stage_type: 'converted',      sort_order: 60, is_terminal: true,  color: '#059669' },
  { key: 'disqualified', name: 'Disqualified', stage_type: 'disqualified',   sort_order: 70, is_terminal: true,  color: '#ef4444' },
  { key: 'nurture',      name: 'Nurture',      stage_type: 'nurture',        sort_order: 80, is_terminal: true,  color: '#a855f7' },
];

// ── 2. Default Deal Stages ──────────────────────────────────────────────────

const DEFAULT_DEAL_STAGES = [
  { key: 'discovery',     name: 'Discovery',     stage_type: 'open', sort_order: 10, is_terminal: false },
  { key: 'qualification', name: 'Qualification', stage_type: 'open', sort_order: 20, is_terminal: false },
  { key: 'proposal',      name: 'Proposal',      stage_type: 'open', sort_order: 30, is_terminal: false },
  { key: 'negotiation',   name: 'Negotiation',   stage_type: 'open', sort_order: 40, is_terminal: false },
  { key: 'closed_won',    name: 'Closed Won',    stage_type: 'won',  sort_order: 50, is_terminal: true  },
  { key: 'closed_lost',   name: 'Closed Lost',   stage_type: 'lost', sort_order: 60, is_terminal: true  },
];

// ── 3. Default Prospecting Playbook Stage Guidance ──────────────────────────

const PROSPECTING_GUIDANCE = {
  target: {
    goal: 'Verify ICP fit and gather basic company intel',
    key_actions: ['research_company', 'research_contact'],
    success_criteria: ['Company research completed', 'ICP score above threshold'],
    timeline: '1-2 days',
  },
  researched: {
    goal: 'Prepare personalised outreach based on research findings',
    key_actions: ['craft_outreach', 'identify_pain_points'],
    success_criteria: ['Personalised message drafted', 'Value prop mapped to pain points'],
    timeline: '1 day',
  },
  contacted: {
    goal: 'Execute multi-touch outreach sequence and get a response',
    key_actions: ['send_email', 'send_linkedin', 'follow_up', 'make_call'],
    success_criteria: ['Response received', 'Meeting booked', 'Or sequence exhausted'],
    timeline: '2-3 weeks',
    cadence: { touches: 8, span_days: 21 },
  },
  engaged: {
    goal: 'Deepen conversation and qualify the opportunity',
    key_actions: ['discovery_call', 'qualify', 'share_resources'],
    success_criteria: ['Budget confirmed', 'Decision timeline identified', 'Champion identified'],
    timeline: '1-2 weeks',
  },
  qualified: {
    goal: 'Convert to a deal with a clear next step',
    key_actions: ['schedule_demo', 'intro_to_ae', 'convert'],
    success_criteria: ['Deal created in pipeline', 'Meeting scheduled with decision maker'],
    timeline: '1 week',
  },
};

// ── 4. Default Sales Playbook Stage Guidance ────────────────────────────────

const SALES_GUIDANCE = {
  discovery: {
    goal: 'Understand the prospect's pain points, goals, and buying process',
    key_actions: ['discovery_call', 'identify_stakeholders', 'map_org_chart'],
    success_criteria: ['Pain points documented', 'Decision process mapped', 'Budget range confirmed'],
    timeline: '1-2 weeks',
  },
  qualification: {
    goal: 'Validate fit and confirm buying intent',
    key_actions: ['demo', 'technical_evaluation', 'build_business_case'],
    success_criteria: ['Champion identified', 'BANT confirmed', 'Technical fit validated'],
    timeline: '2-3 weeks',
  },
  proposal: {
    goal: 'Present tailored solution and pricing',
    key_actions: ['send_proposal', 'pricing_review', 'executive_alignment'],
    success_criteria: ['Proposal reviewed by decision maker', 'Pricing accepted in principle'],
    timeline: '1-2 weeks',
  },
  negotiation: {
    goal: 'Finalise terms and close the deal',
    key_actions: ['contract_review', 'legal_review', 'final_negotiation'],
    success_criteria: ['Terms agreed', 'Contract signed', 'PO received'],
    timeline: '1-2 weeks',
  },
};

// ── Seed function ───────────────────────────────────────────────────────────

async function seedOrg(orgId) {
  console.log(`[orgSeed] Seeding defaults for org ${orgId}`);

  try {
    // ── Prospect stages ──────────────────────────────────────────────
    for (const s of DEFAULT_PROSPECT_STAGES) {
      await db.query(
        `INSERT INTO prospect_stages (org_id, key, name, stage_type, sort_order, is_active, is_terminal, is_system, color)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, TRUE, $7)
         ON CONFLICT DO NOTHING`,
        [orgId, s.key, s.name, s.stage_type, s.sort_order, s.is_terminal, s.color]
      );
    }
    console.log(`[orgSeed] Prospect stages seeded for org ${orgId}`);

    // ── Deal stages ──────────────────────────────────────────────────
    for (const s of DEFAULT_DEAL_STAGES) {
      await db.query(
        `INSERT INTO deal_stages (org_id, key, name, stage_type, sort_order, is_active, is_terminal, is_system)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, TRUE)
         ON CONFLICT (org_id, key) DO NOTHING`,
        [orgId, s.key, s.name, s.stage_type, s.sort_order, s.is_terminal]
      );
    }
    console.log(`[orgSeed] Deal stages seeded for org ${orgId}`);

    // ── Starter prospecting playbook ─────────────────────────────────
    await db.query(
      `INSERT INTO playbooks (org_id, name, type, description, content, stage_guidance, is_default)
       SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb, TRUE
       WHERE NOT EXISTS (
         SELECT 1 FROM playbooks WHERE org_id = $1 AND type = 'prospecting'
       )`,
      [
        orgId,
        'Default Prospecting Playbook',
        'prospecting',
        'Standard outbound prospecting workflow — from target identification through qualification and conversion.',
        JSON.stringify({}),
        JSON.stringify(PROSPECTING_GUIDANCE),
      ]
    );
    console.log(`[orgSeed] Prospecting playbook seeded for org ${orgId}`);

    // ── Starter sales playbook ───────────────────────────────────────
    await db.query(
      `INSERT INTO playbooks (org_id, name, type, description, content, stage_guidance, is_default)
       SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb, TRUE
       WHERE NOT EXISTS (
         SELECT 1 FROM playbooks WHERE org_id = $1 AND type IN ('sales', 'custom', 'market', 'product')
       )`,
      [
        orgId,
        'Default Sales Playbook',
        'sales',
        'Standard sales process — from discovery through negotiation and close.',
        JSON.stringify({}),
        JSON.stringify(SALES_GUIDANCE),
      ]
    );
    console.log(`[orgSeed] Sales playbook seeded for org ${orgId}`);

    console.log(`[orgSeed] ✓ Org ${orgId} seeded successfully`);
  } catch (err) {
    // Non-fatal — log and continue. The org exists, seeding can be retried.
    console.error(`[orgSeed] Error seeding org ${orgId}:`, err.message);
  }
}

module.exports = { seedOrg };
