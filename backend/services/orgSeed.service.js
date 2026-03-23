// ─────────────────────────────────────────────────────────────────────────────
// orgSeed.service.js
//
// Seeds sensible defaults for a newly created organisation so it's ready to
// use without manual setup.  Call `seedOrg(orgId)` right after the INSERT
// INTO organizations.
//
// What gets seeded:
//   1. Prospect pipeline stages  (pipeline_stages table, pipeline='prospecting')
//   2. Deal pipeline stages      (pipeline_stages table, pipeline='sales')
//   3. CLM pipeline stages       (pipeline_stages table, pipeline='clm')
//   4. Service pipeline stages   (pipeline_stages table, pipeline='service')
//   5. Handover pipeline stages  (pipeline_stages table, pipeline='handover_s2i')
//   6. Starter prospecting playbook with stage guidance
//   7. Starter sales playbook with stage guidance
//
// Safe to call multiple times — every INSERT uses ON CONFLICT DO NOTHING
// so existing data is never overwritten.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');

// ── 1. Default Prospect Stages ──────────────────────────────────────────────

const DEFAULT_PROSPECTING_STAGES = [
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

const DEFAULT_SALES_STAGES = [
  { key: 'discovery',     name: 'Discovery',     stage_type: 'open', sort_order: 10, is_terminal: false, color: '#3b82f6' },
  { key: 'qualification', name: 'Qualification', stage_type: 'open', sort_order: 20, is_terminal: false, color: '#8b5cf6' },
  { key: 'proposal',      name: 'Proposal',      stage_type: 'open', sort_order: 30, is_terminal: false, color: '#f59e0b' },
  { key: 'negotiation',   name: 'Negotiation',   stage_type: 'open', sort_order: 40, is_terminal: false, color: '#f97316' },
  { key: 'closed_won',    name: 'Closed Won',    stage_type: 'won',  sort_order: 50, is_terminal: true,  color: '#10b981' },
  { key: 'closed_lost',   name: 'Closed Lost',   stage_type: 'lost', sort_order: 60, is_terminal: true,  color: '#ef4444' },
];

// ── 3. Default CLM Stages ───────────────────────────────────────────────────

const DEFAULT_CLM_STAGES = [
  { key: 'draft',              name: 'Draft',              stage_type: 'open',     sort_order: 10,  is_terminal: false, color: '#6b7280' },
  { key: 'internal_review',    name: 'Internal Review',    stage_type: 'open',     sort_order: 20,  is_terminal: false, color: '#8b5cf6' },
  { key: 'legal_review',       name: 'Legal Review',       stage_type: 'open',     sort_order: 30,  is_terminal: false, color: '#3b82f6' },
  { key: 'client_review',      name: 'Client Review',      stage_type: 'open',     sort_order: 40,  is_terminal: false, color: '#f59e0b' },
  { key: 'negotiation',        name: 'Negotiation',        stage_type: 'open',     sort_order: 50,  is_terminal: false, color: '#f97316' },
  { key: 'pending_signature',  name: 'Pending Signature',  stage_type: 'open',     sort_order: 60,  is_terminal: false, color: '#eab308' },
  { key: 'signed',             name: 'Signed',             stage_type: 'won',      sort_order: 70,  is_terminal: true,  color: '#10b981' },
  { key: 'active',             name: 'Active',             stage_type: 'open',     sort_order: 80,  is_terminal: false, color: '#059669' },
  { key: 'renewal_due',        name: 'Renewal Due',        stage_type: 'open',     sort_order: 90,  is_terminal: false, color: '#f59e0b' },
  { key: 'renewed',            name: 'Renewed',            stage_type: 'won',      sort_order: 100, is_terminal: true,  color: '#10b981' },
  { key: 'expired',            name: 'Expired',            stage_type: 'lost',     sort_order: 110, is_terminal: true,  color: '#ef4444' },
  { key: 'terminated',         name: 'Terminated',         stage_type: 'lost',     sort_order: 120, is_terminal: true,  color: '#dc2626' },
];

// ── 4. Default Service Stages ────────────────────────────────────────────────

const DEFAULT_SERVICE_STAGES = [
  { key: 'open',             name: 'Open',             stage_type: 'open',     sort_order: 10, is_terminal: false, color: '#3b82f6' },
  { key: 'in_progress',      name: 'In Progress',      stage_type: 'open',     sort_order: 20, is_terminal: false, color: '#f59e0b' },
  { key: 'pending_customer', name: 'Pending Customer', stage_type: 'open',     sort_order: 30, is_terminal: false, color: '#8b5cf6' },
  { key: 'resolved',         name: 'Resolved',         stage_type: 'won',      sort_order: 40, is_terminal: true,  color: '#10b981' },
  { key: 'closed',           name: 'Closed',           stage_type: 'lost',     sort_order: 50, is_terminal: true,  color: '#6b7280' },
];

// ── 5. Default Handover Stages ───────────────────────────────────────────────

const DEFAULT_HANDOVER_STAGES = [
  { key: 'assign_service_owner',        name: 'Assign Service Owner',        stage_type: 'open', sort_order: 10, is_terminal: false, color: '#3b82f6' },
  { key: 'document_stakeholders',       name: 'Document Stakeholders',       stage_type: 'open', sort_order: 20, is_terminal: false, color: '#8b5cf6' },
  { key: 'record_commitments_risks',    name: 'Record Commitments & Risks',  stage_type: 'open', sort_order: 30, is_terminal: false, color: '#f59e0b' },
  { key: 'confirm_golive_commercial',   name: 'Confirm Go-Live & Commercial',stage_type: 'open', sort_order: 40, is_terminal: false, color: '#f97316' },
  { key: 'attach_docs_signoff',         name: 'Attach Docs & Sign-off',      stage_type: 'won',  sort_order: 50, is_terminal: true,  color: '#10b981' },
];

// ── 4. Default Prospecting Playbook Stage Guidance ───────────────────────────


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
    goal: 'Understand the prospect\'s pain points, goals, and buying process',
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

  // Helper — inserts a stage list into pipeline_stages for a given pipeline key
  async function seedPipelineStages(pipeline, stageList) {
    for (const s of stageList) {
      await db.query(
        `INSERT INTO pipeline_stages
           (org_id, pipeline, key, name, stage_type, sort_order, is_active, is_terminal, is_system, color)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, TRUE, $8)
         ON CONFLICT (org_id, pipeline, key) DO NOTHING`,
        [orgId, pipeline, s.key, s.name, s.stage_type, s.sort_order, s.is_terminal, s.color || '#6b7280']
      );
    }
    console.log(`[orgSeed] ${pipeline} stages seeded for org ${orgId}`);
  }

  try {
    // ── All pipeline stages → single table ───────────────────────────
    await seedPipelineStages('prospecting',  DEFAULT_PROSPECTING_STAGES);
    await seedPipelineStages('sales',        DEFAULT_SALES_STAGES);
    await seedPipelineStages('clm',          DEFAULT_CLM_STAGES);
    await seedPipelineStages('service',      DEFAULT_SERVICE_STAGES);
    await seedPipelineStages('handover_s2i', DEFAULT_HANDOVER_STAGES);

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

    // ── Seed platform-default email filter into org settings ─────────────────
    // Uses jsonb_set with create_missing=true so it never overwrites an existing
    // email_filter config (e.g. if seedOrg is called a second time on an org that
    // already has custom filter settings).
    await db.query(
      `UPDATE organizations
       SET settings = jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{email_filter}',
         COALESCE(
           settings->'email_filter',
           $1::jsonb
         ),
         true
       )
       WHERE id = $2
         AND (settings->'email_filter' IS NULL
              OR settings->>'email_filter' = 'null')`,
      [
        JSON.stringify({
          blocked_domains: [
            'accountprotection.microsoft.com',
            'communication.microsoft.com',
            'promomail.microsoft.com',
            'infoemails.microsoft.com',
            'engage.microsoft.com',
            'account.microsoft.com',
            'mail.onedrive.com',
            'microsoft.com',
            'googlemail.com',
          ],
          blocked_local_patterns: [
            'noreply', 'no-reply', 'donotreply', 'do-not-reply',
            'mailer-daemon', 'postmaster', 'bounce', 'notifications', 'unsubscribe',
          ],
        }),
        orgId,
      ]
    );
    console.log(`[orgSeed] Email filter defaults seeded for org ${orgId}`);


    console.log(`[orgSeed] ✓ Org ${orgId} seeded successfully`);
  } catch (err) {
    // Non-fatal — log and continue. The org exists, seeding can be retried.
    console.error(`[orgSeed] Error seeding org ${orgId}:`, err.message);
  }
}

module.exports = { seedOrg };
