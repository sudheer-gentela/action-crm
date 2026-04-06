/**
 * orgSeed.service.js
 * GoWarmCRM — Playbook Seeding Service
 *
 * Exports:
 *   seedOrg(orgId)               — called on new org creation (seeds Sales playbook)
 *   seedModulePlaybook(orgId, module) — called by OrgAdmin per-module seed button
 *   getSeedStatus(orgId)         — returns which modules have been seeded
 *
 * Module keys: 'prospecting' | 'sales' | 'clm' | 'service' | 'handovers'
 */

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// STAGE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const STAGES = {
  prospecting: [
    { key: 'target',               name: 'Target',               stage_type: 'active',   sort_order: 1,  is_terminal: false, is_system: false, color: '#94A3B8' },
    { key: 'research',             name: 'Research',             stage_type: 'active',   sort_order: 2,  is_terminal: false, is_system: false, color: '#60A5FA' },
    { key: 'outreach',             name: 'Outreach',             stage_type: 'active',   sort_order: 3,  is_terminal: false, is_system: false, color: '#34D399' },
    { key: 'engaged',              name: 'Engaged',              stage_type: 'active',   sort_order: 4,  is_terminal: false, is_system: false, color: '#FBBF24' },
    { key: 'ral',                  name: 'RAL',                  stage_type: 'active',   sort_order: 5,  is_terminal: false, is_system: false, color: '#F97316' },
    { key: 'sales_discovery_call', name: 'Sales Discovery Call', stage_type: 'active',   sort_order: 6,  is_terminal: false, is_system: false, color: '#A78BFA' },
    { key: 'sal',                  name: 'SAL',                  stage_type: 'active',   sort_order: 7,  is_terminal: false, is_system: false, color: '#2DD4BF' },
    { key: 'disqualified',         name: 'Disqualified',         stage_type: 'lost',     sort_order: 8,  is_terminal: true,  is_system: false, color: '#EF4444' },
    { key: 'nurture',              name: 'Nurture',              stage_type: 'nurture',  sort_order: 9,  is_terminal: false, is_system: false, color: '#6B7280' },
  ],

  sales: [
    { key: 'sal',                    name: 'SAL',                        stage_type: 'active', sort_order: 1, is_terminal: false, is_system: false, color: '#2DD4BF' },
    { key: 'sales_qualified',        name: 'Sales Qualified',            stage_type: 'active', sort_order: 2, is_terminal: false, is_system: false, color: '#60A5FA' },
    { key: 'demo',                   name: 'Demo',                       stage_type: 'active', sort_order: 3, is_terminal: false, is_system: false, color: '#FBBF24' },
    { key: 'commercial_negotiation', name: 'Commercial & Negotiation',   stage_type: 'active', sort_order: 4, is_terminal: false, is_system: false, color: '#F97316' },
    { key: 'contracts',              name: 'Contracts',                  stage_type: 'active', sort_order: 5, is_terminal: false, is_system: false, color: '#A78BFA' },
    { key: 'closed_won',             name: 'Closed Won',                 stage_type: 'won',    sort_order: 6, is_terminal: true,  is_system: false, color: '#34D399' },
    { key: 'closed_lost',            name: 'Closed Lost',                stage_type: 'lost',   sort_order: 7, is_terminal: true,  is_system: false, color: '#EF4444' },
  ],

  clm: [
    { key: 'draft',                name: 'Draft',                   stage_type: 'active',   sort_order: 1,  is_terminal: false, is_system: false, color: '#94A3B8' },
    { key: 'in_review_legal',      name: 'In Review — Legal',       stage_type: 'active',   sort_order: 2,  is_terminal: false, is_system: false, color: '#60A5FA' },
    { key: 'in_review_sales',      name: 'In Review — Sales',       stage_type: 'active',   sort_order: 3,  is_terminal: false, is_system: false, color: '#34D399' },
    { key: 'in_review_customer',   name: 'In Review — Customer',    stage_type: 'active',   sort_order: 4,  is_terminal: false, is_system: false, color: '#FBBF24' },
    { key: 'in_signatures',        name: 'In Signatures',           stage_type: 'active',   sort_order: 5,  is_terminal: false, is_system: false, color: '#F97316' },
    { key: 'active',               name: 'Active',                  stage_type: 'active',   sort_order: 6,  is_terminal: false, is_system: false, color: '#10B981' },
    { key: 'voided_cancelled',     name: 'Voided / Cancelled',      stage_type: 'lost',     sort_order: 7,  is_terminal: true,  is_system: false, color: '#EF4444' },
    { key: 'terminated',           name: 'Terminated',              stage_type: 'lost',     sort_order: 8,  is_terminal: true,  is_system: false, color: '#DC2626' },
    { key: 'expired_no_renewal',   name: 'Expired — No Renewal',    stage_type: 'lost',     sort_order: 9,  is_terminal: true,  is_system: false, color: '#9CA3AF' },
  ],

  service: [
    { key: 'open',             name: 'Open',             stage_type: 'active', sort_order: 1, is_terminal: false, is_system: false, color: '#60A5FA' },
    { key: 'in_progress',      name: 'In Progress',      stage_type: 'active', sort_order: 2, is_terminal: false, is_system: false, color: '#FBBF24' },
    { key: 'pending_customer', name: 'Pending Customer', stage_type: 'active', sort_order: 3, is_terminal: false, is_system: false, color: '#F97316' },
    { key: 'resolved',         name: 'Resolved',         stage_type: 'won',    sort_order: 4, is_terminal: true,  is_system: false, color: '#34D399' },
    { key: 'closed',           name: 'Closed',           stage_type: 'won',    sort_order: 5, is_terminal: true,  is_system: false, color: '#10B981' },
  ],

  handovers: [
    { key: 'assign_service_owner',        name: 'Assign Service Owner',           stage_type: 'active', sort_order: 1, is_terminal: false, is_system: false, color: '#60A5FA' },
    { key: 'document_stakeholders',       name: 'Document Stakeholders',          stage_type: 'active', sort_order: 2, is_terminal: false, is_system: false, color: '#FBBF24' },
    { key: 'record_commitments_risks',    name: 'Record Commitments & Risks',     stage_type: 'active', sort_order: 3, is_terminal: false, is_system: false, color: '#F97316' },
    { key: 'confirm_golive_commercial',   name: 'Confirm Go-Live & Commercial',   stage_type: 'active', sort_order: 4, is_terminal: false, is_system: false, color: '#A78BFA' },
    { key: 'attach_docs_signoff',         name: 'Attach Docs & Sign-off',         stage_type: 'won',    sort_order: 5, is_terminal: true,  is_system: false, color: '#34D399' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// PLAY DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const PLAYS = {

  // ── PROSPECTING (42 plays) ────────────────────────────────────────────────

  prospecting: [

    // Target (4)
    {
      stage_key: 'target', sort_order: 1, is_gate: false,
      title: 'Score ICP fit',
      description: 'Assess the prospect against your ICP criteria before committing research time. Use your ICP scorecard covering company size, industry, geography, tech stack, and persona seniority.',
      suggested_action: 'Open the ICP scorecard. Score the prospect. Record the total icp_score on the prospect record. If the score is below your threshold, route to Disqualified immediately.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'target', sort_order: 2, is_gate: false,
      title: 'Verify contact data',
      description: 'Confirm that the email address, phone, LinkedIn URL, and title are accurate and current before outreach. Bad data wastes cycles.',
      suggested_action: 'Cross-reference the prospect record against LinkedIn, the company website, and any enrichment tool you use. Update email, phone, linkedin_url, and title fields directly on the prospect record.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'target', sort_order: 3, is_gate: false,
      title: 'Check existing relationship',
      description: 'Before treating this as a cold prospect, verify whether your organisation has an existing relationship — past deal, current customer contact, or prior outreach.',
      suggested_action: 'Search CRM for matching company domain and contact email. If an existing relationship is found, note it in research_notes and adjust your outreach framing accordingly.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'target', sort_order: 4, is_gate: true,
      title: 'Approve for research',
      description: 'Gate: confirm this prospect passes ICP threshold and data quality checks before moving to Research. Do not progress low-quality leads into the research stage.',
      suggested_action: 'Review icp_score, verified contact data, and any existing relationship notes. If approved, advance to Research. If not, move to Disqualified and record the reason.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Research (4)
    {
      stage_key: 'research', sort_order: 1, is_gate: false,
      title: 'Research company',
      description: 'Build a clear picture of the company — recent news, funding, headcount changes, tech stack, product announcements, and strategic priorities. This context shapes every message.',
      suggested_action: 'Search company name + recent news. Check their LinkedIn company page, website About/News sections, and Crunchbase. Note key findings in research_notes. Update company_industry and company_size if missing.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'research', sort_order: 2, is_gate: false,
      title: 'Research contact on LinkedIn',
      description: 'Understand the individual — their role tenure, recent activity, posts, career history, and any shared connections. Personal context makes outreach feel human, not automated.',
      suggested_action: 'Visit linkedin_url on the prospect record. Note their current tenure, any recent posts or articles, career progression, and mutual connections. Add observations to research_notes.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'research', sort_order: 3, is_gate: false,
      title: 'Identify trigger event',
      description: 'Look for a specific, timely reason to reach out — a hiring surge, new product launch, funding round, exec change, or regulation affecting their industry. A good trigger dramatically improves reply rates.',
      suggested_action: 'Cross-reference your company research with LinkedIn activity and any news alerts. Identify one specific trigger event. Record it in research_notes as the basis for your outreach hook.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'research', sort_order: 4, is_gate: true,
      title: 'Draft outreach hook',
      description: 'Gate: write the specific, personalised opening hook for your first outreach message before moving to Outreach. The hook must reference the trigger event or a concrete insight — not a generic opener.',
      suggested_action: 'Write a 1–2 sentence outreach hook based on your research. Record it in research_notes. Only advance to Outreach once the hook is written and reflects a real, specific observation about this prospect.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Outreach (5)
    {
      stage_key: 'outreach', sort_order: 1, is_gate: false,
      title: 'Send first email',
      description: 'Send a short, personalised cold email using the hook drafted in Research. Lead with the trigger event or insight, state a clear hypothesis about their problem, and make one low-friction ask.',
      suggested_action: 'Use your outreach hook from research_notes. Keep the email to 4–5 sentences maximum. Subject line: reference the trigger, not your product. Log the send in the activity feed and update last_outreach_at.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'outreach', sort_order: 2, is_gate: false,
      title: 'LinkedIn connection request',
      description: 'Send a personalised LinkedIn connection request within 24 hours of the first email. Multi-channel outreach significantly increases reply rates.',
      suggested_action: 'Visit linkedin_url and send a connection request with a short personal note — reference something specific from their profile or your research. Do not pitch in the connection message.',
      channel: 'linkedin', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'outreach', sort_order: 3, is_gate: false,
      title: 'Follow-up email touch 2',
      description: 'Send a second email if there is no response to touch 1. Add new value — a relevant resource, a case study, or a different angle on the problem. Do not just re-send the first email.',
      suggested_action: 'Write a brief follow-up that opens with a new insight or resource relevant to their industry. Reference the first email naturally. Keep it to 3 sentences. Update outreach_count.',
      channel: 'email', due_offset_days: 4, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'outreach', sort_order: 4, is_gate: false,
      title: 'Phone call attempt',
      description: 'Make a direct phone call if email and LinkedIn have not generated a response. Voicemail is fine — a brief, confident message referencing the emails you sent.',
      suggested_action: 'Call the number in the phone field. If voicemail, leave a 20-second message: your name, the company, reference the emails, and one clear reason to call back. Log the call attempt and update last_outreach_at.',
      channel: 'phone', due_offset_days: 7, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'outreach', sort_order: 5, is_gate: false,
      title: 'Final touch — breakup or pivot',
      description: 'Send a final message acknowledging you have not heard back. Give the prospect a graceful out or offer an alternative approach. A breakup email often triggers replies from prospects who were just busy.',
      suggested_action: 'Send a short, non-pressuring breakup email: "I will stop reaching out — if the timing changes, I am easy to find." If they have a LinkedIn connection, send a brief DM version too. If no response, move to Nurture. Update outreach_count.',
      channel: 'email', due_offset_days: 10, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Engaged (4)
    {
      stage_key: 'engaged', sort_order: 1, is_gate: false,
      title: 'Respond to engagement',
      description: 'The prospect has responded or engaged — reply promptly and warmly. Speed of response signals respect and professionalism.',
      suggested_action: 'Reply within 2 hours during business hours. Match their tone and energy. If they asked a question, answer it clearly. If they expressed interest, propose a next step immediately. Update last_response_at.',
      channel: 'email', due_offset_days: 0, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'engaged', sort_order: 2, is_gate: false,
      title: 'Send relevant resource',
      description: 'Share one highly relevant piece of content — a case study, ROI calculator, or product overview — that matches the specific interest or problem the prospect expressed.',
      suggested_action: 'Select one resource that directly addresses the prospect\'s expressed interest. Do not send a generic brochure. Share it with a brief contextual note explaining why it is relevant to them specifically.',
      channel: 'email', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'engaged', sort_order: 3, is_gate: false,
      title: 'Propose initial meeting',
      description: 'Ask for a short exploratory call or meeting. Keep the ask low-commitment — 20 minutes to understand their situation and share how others in their position have solved the same problem.',
      suggested_action: 'Send a meeting proposal with two or three specific time slots. Use a scheduling link if available. Keep the ask focused: "20 minutes to see if this is worth exploring" — not a full discovery call pitch.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'engaged', sort_order: 4, is_gate: false,
      title: 'Follow up on meeting proposal',
      description: 'If the prospect has not responded to the meeting proposal within 3 days, send a single brief follow-up. Do not send more than one follow-up to a meeting ask.',
      suggested_action: 'Send a one-line follow-up: "Just making sure this did not get buried — happy to work around your schedule." If still no response after this, move back to Outreach final touch or route to Nurture.',
      channel: 'email', due_offset_days: 3, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // RAL (5)
    {
      stage_key: 'ral', sort_order: 1, is_gate: false,
      title: 'Conduct rep discovery meeting',
      description: 'Run the initial discovery meeting with the prospect. The goal is to qualify against RAL criteria: confirmed pain, identified stakeholders, budget awareness, and a credible timeline.',
      suggested_action: 'Follow your RAL discovery framework. Cover: current situation, key pain points, who else is involved in any decision, rough budget awareness, and timeline. Record detailed notes in research_notes immediately after.',
      channel: 'meeting', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'ral', sort_order: 2, is_gate: false,
      title: 'Document discovery findings',
      description: 'Record the full discovery output in a structured format immediately after the meeting. Do not rely on memory — notes degrade quickly.',
      suggested_action: 'Update research_notes with: confirmed pain, stakeholder map, budget signal, timeline, and any objections raised. Flag anything unusual or high-risk. This document will be handed to the AE if the lead advances.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'ral', sort_order: 3, is_gate: false,
      title: 'Score and confirm RAL criteria met',
      description: 'Score the lead against your formal RAL criteria. All criteria must be met before the lead advances — partial qualification is not a pass.',
      suggested_action: 'Complete your RAL scorecard. Criteria typically include: confirmed pain, economic buyer identified, budget range confirmed, timeline within 6 months, and fit with ICP. Record the RAL score in icp_signals JSONB field under key "ral_score".',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'ral', sort_order: 4, is_gate: false,
      title: 'Flag if Direct Sales Discovery (AE present)',
      description: 'If an AE was present in the discovery meeting and this is therefore a Direct Sales Discovery rather than an SDR-qualified lead, flag this explicitly on the prospect record for clean handoff tracking.',
      suggested_action: 'If an AE participated in this discovery meeting, update research_meta: set is_direct_sales_discovery to "true", direct_sales_discovery_ae to the AE\'s full name, and direct_sales_discovery_date to today\'s date in ISO format (YYYY-MM-DD). Leave these fields unset if this was a standard SDR discovery.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'ral', sort_order: 5, is_gate: true,
      title: 'Rep sign-off — formally accept lead',
      description: 'Gate: the SDR formally accepts that this lead meets RAL criteria and is ready for AE handoff. Do not advance leads that do not fully meet criteria.',
      suggested_action: 'Review all RAL criteria scores, discovery notes, and any Direct Sales Discovery flag. If all criteria are met, advance to Sales Discovery Call. If not, route to Nurture or Disqualified with a clear reason recorded.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Sales Discovery Call (6)
    {
      stage_key: 'sales_discovery_call', sort_order: 1, is_gate: false,
      title: 'Share RAL notes with AE',
      description: 'Brief the AE fully before any prospect-facing interaction. The AE should never walk into a sales discovery call without context from the SDR\'s research and discovery.',
      suggested_action: 'Send the AE the full research_notes content, RAL scorecard results, and any Direct Sales Discovery flag. Include: confirmed pain, stakeholder map, budget signal, timeline, and the prospect\'s specific language about their problem.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_discovery_call', sort_order: 2, is_gate: false,
      title: 'Confirm AE is briefed and available',
      description: 'Before inviting the prospect to a Sales Discovery Call, confirm the assigned AE has read the brief and has capacity to take this meeting.',
      suggested_action: 'Get explicit confirmation from the AE that they have reviewed the RAL brief and are available for the scheduled discovery call window. Do not book the prospect meeting until this is confirmed.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_discovery_call', sort_order: 3, is_gate: false,
      title: 'Send agenda to prospect',
      description: 'Share a brief meeting agenda with the prospect ahead of the Sales Discovery Call. An agenda sets expectations, increases show rates, and signals professionalism.',
      suggested_action: 'Send the prospect a short email: confirm the meeting time, introduce the AE by name and role, and share a 3-point agenda (quick intro, understanding their situation, exploring fit). Send at least 24 hours before the call.',
      channel: 'email', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_discovery_call', sort_order: 4, is_gate: false,
      title: 'Conduct Sales Discovery Call',
      description: 'Run the AE-led Sales Discovery Call. The goal is full MEDDIC qualification — not a demo, not a pitch. Understand the economic buyer, decision criteria, decision process, identified pain, and timeline.',
      suggested_action: 'AE leads the call using the MEDDIC framework. Cover: Metrics (what outcome do they need), Economic Buyer (who signs), Decision Criteria, Decision Process, Identify Pain, and Champion. Take verbatim notes on the prospect\'s own language describing their problem.',
      channel: 'meeting', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_discovery_call', sort_order: 5, is_gate: false,
      title: 'AE completes MEDDIC scorecard',
      description: 'Immediately after the Sales Discovery Call, the AE completes a full MEDDIC scorecard. This is the qualification record for this deal going forward.',
      suggested_action: 'Complete your MEDDIC scorecard within 2 hours of the call. Record results in icp_signals JSONB under key "meddic". Identify which elements are confirmed, which are incomplete, and what needs to be addressed before advancing.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_discovery_call', sort_order: 6, is_gate: true,
      title: 'AE decides — advance to SAL or route to Disqualified/Nurture',
      description: 'Gate: the AE makes a formal decision on the lead based on the MEDDIC scorecard. This is the most important gate in the prospecting pipeline — it determines whether a deal enters Sales.',
      suggested_action: 'Review the complete MEDDIC scorecard and discovery call notes. If all criteria are credibly met, advance to SAL. If the prospect is not ready but may be in future, route to Nurture. If fundamentally unqualified, route to Disqualified and select the appropriate disqualified_reason (kill / long_term / unable_to_decide).',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // SAL — Prospecting (4)
    {
      stage_key: 'sal', sort_order: 1, is_gate: false,
      title: 'Notify AE of new SAL',
      description: 'Alert the AE that this lead has passed the Sales Discovery Call gate and is now a Sales Accepted Lead ready to be converted to a deal in the Sales pipeline.',
      suggested_action: 'Send the AE a notification confirming SAL status, including the full discovery brief, MEDDIC scorecard results, and suggested deal value. Include the prospect record link.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sal', sort_order: 2, is_gate: false,
      title: 'Convert prospect to deal',
      description: 'Create the corresponding deal record in the Sales pipeline using the information gathered through prospecting. The deal should start at the SAL stage in Sales.',
      suggested_action: 'Use the Convert action on the prospect record to create a linked deal, contact, and account. Populate deal value, close date estimate, and AE owner. Link the deal_id back to this prospect record.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sal', sort_order: 3, is_gate: false,
      title: 'Complete SDR-to-AE handoff notes',
      description: 'Write a formal handoff note that captures everything the AE needs to run the deal from here. This is the SDR\'s exit document.',
      suggested_action: 'Write a structured handoff note covering: prospect background, trigger event, pain confirmed, stakeholders identified, MEDDIC status, any sensitivities or risks, and recommended next step. Attach to the deal record and the prospect record in research_notes.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sal', sort_order: 4, is_gate: true,
      title: 'AE formally accepts deal into pipeline',
      description: 'Gate: the AE formally accepts the deal into the Sales pipeline. The prospect\'s journey through the prospecting pipeline ends here.',
      suggested_action: 'AE confirms acceptance of the deal by advancing the linked deal record to the SAL stage in the Sales pipeline. The SDR\'s prospecting record can be marked complete. If the AE does not accept, document the reason and discuss with the SDR.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Disqualified (4)
    {
      stage_key: 'disqualified', sort_order: 1, is_gate: false,
      title: 'Record disqualification reason',
      description: 'Capture the specific reason for disqualification using the standard taxonomy. Accurate disqualification data improves ICP definition and targeting over time.',
      suggested_action: 'Set disqualified_reason on the prospect record: "kill" (fundamentally not a fit), "long_term" (good fit but no near-term need), or "unable_to_decide" (no decision-making authority or process). Add detail to research_notes.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'disqualified', sort_order: 2, is_gate: false,
      title: 'Set account disposition',
      description: 'Update the account record to reflect the outcome so that future prospectors from this company know the history before reaching out again.',
      suggested_action: 'Update the linked account record with disqualification context: reason, date, and any notes on timing or re-engagement criteria. This prevents duplicate outreach and preserves relationship context.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'disqualified', sort_order: 3, is_gate: false,
      title: 'Set revisit date',
      description: 'If the disqualification reason is "long_term" or "unable_to_decide", set a specific revisit date rather than leaving the record dormant.',
      suggested_action: 'If disqualified_reason is "long_term" or "unable_to_decide", set revisit_date on the prospect record to a specific future date (typically 3–6 months). If reason is "kill", leave revisit_date blank.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'disqualified', sort_order: 4, is_gate: false,
      title: 'Send graceful exit message',
      description: 'Send a brief, professional message acknowledging the outcome. Leave the relationship in a positive state — many disqualified prospects become customers later.',
      suggested_action: 'Send a short email thanking the prospect for their time. Do not express frustration or push back. If disqualified_reason is "long_term", acknowledge you will be in touch at the right time. Keep the tone warm and leave the door open.',
      channel: 'email', due_offset_days: 1, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Nurture (4)
    {
      stage_key: 'nurture', sort_order: 1, is_gate: false,
      title: 'Add to nurture email sequence',
      description: 'Enrol the prospect in a long-term nurture sequence that delivers value without pressure. The goal is to remain visible and relevant until the timing is right.',
      suggested_action: 'Add the prospect to your nurture email sequence. Set preferred_channel if they have shown a preference. Tag with relevant industry and persona tags in the tags JSONB field to ensure they receive relevant content.',
      channel: 'email', due_offset_days: 2, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'nurture', sort_order: 2, is_gate: false,
      title: 'Follow and engage on LinkedIn',
      description: 'Follow the prospect on LinkedIn and engage authentically with their content. Likes and thoughtful comments keep you visible without being intrusive.',
      suggested_action: 'Follow the prospect on LinkedIn via their linkedin_url. Set a reminder to engage with their posts monthly. Add a brief note in research_notes to track engagement activity.',
      channel: 'linkedin', due_offset_days: 3, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'nurture', sort_order: 3, is_gate: false,
      title: 'Send quarterly personal check-in',
      description: 'Send a brief, personal check-in every quarter — not a sales email, a genuine check-in. Reference something specific to their company or situation to show you have been paying attention.',
      suggested_action: 'Write a 2–3 sentence personal email referencing something that has changed in their world since you last spoke — a company announcement, an industry development, or their own LinkedIn activity. No pitch. Just visibility and goodwill.',
      channel: 'email', due_offset_days: 90, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'nurture', sort_order: 4, is_gate: true,
      title: 'Review for re-engagement',
      description: 'Gate: periodically review nurture prospects against current ICP and pipeline conditions to identify which are ready to re-enter the active prospecting flow.',
      suggested_action: 'Review the prospect record: has the disqualification reason changed? Is revisit_date approaching or passed? Have there been any company trigger events? If re-engagement criteria are met, move back to Target or Research. Otherwise, reset the review cycle.',
      channel: 'internal_task', due_offset_days: 90, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
  ],

  // ── SALES (36 plays) ──────────────────────────────────────────────────────

  sales: [

    // SAL — Sales (4)
    {
      stage_key: 'sal', sort_order: 1, is_gate: false,
      title: 'Review RAL and Sales Discovery notes',
      description: 'Before doing anything else, read the full SDR brief — research notes, MEDDIC scorecard, RAL criteria, and the discovery call summary. The AE must enter this stage fully informed.',
      suggested_action: 'Open the linked prospect record. Read research_notes in full, review icp_signals for the MEDDIC and RAL scores, and check whether is_direct_sales_discovery is set in research_meta. Note any gaps or risks before proceeding.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sal', sort_order: 2, is_gate: false,
      title: 'Validate deal meets AE entry criteria',
      description: 'Independently validate that the deal meets your AE-level entry standards. The SDR\'s qualification is a starting point — the AE must confirm it holds before investing deal time.',
      suggested_action: 'Review the MEDDIC scorecard critically. Identify any elements marked incomplete or uncertain. If the deal does not meet AE entry criteria, discuss with the SDR team rather than silently rejecting. Document your assessment.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sal', sort_order: 3, is_gate: false,
      title: 'Confirm and fill stakeholder map gaps',
      description: 'The SDR\'s stakeholder map is a starting point. The AE\'s job is to identify who is missing — particularly economic buyers and blockers who were not surfaced in discovery.',
      suggested_action: 'Review the stakeholder map from research_notes. Identify any missing roles: CFO, CTO, procurement, legal, or other department heads who may influence the decision. Document the full stakeholder map and assign a relationship owner to each name.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sal', sort_order: 4, is_gate: true,
      title: 'AE formally accepts deal into pipeline',
      description: 'Gate: the AE formally accepts this deal and commits to progressing it. This is the moment of AE ownership — not just acknowledgement.',
      suggested_action: 'Confirm: the MEDDIC scorecard has no critical gaps, the stakeholder map is complete enough to proceed, and you have a clear next step with the prospect. Advance to Sales Qualified. If you cannot confirm all three, document what is missing and address it before advancing.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Sales Qualified (5)
    {
      stage_key: 'sales_qualified', sort_order: 1, is_gate: false,
      title: 'Deep qualification call with economic buyer',
      description: 'Secure a direct conversation with the economic buyer — the person who will sign the contract or approve the budget. SDR discovery often surfaces the champion, not the buyer.',
      suggested_action: 'Request a meeting with the economic buyer through your champion. Frame it as a brief executive alignment call — 30 minutes to share relevant outcomes and understand their priorities. Prepare a 2-minute executive summary of why this is relevant to them specifically.',
      channel: 'meeting', due_offset_days: 5, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_qualified', sort_order: 2, is_gate: false,
      title: 'Complete full MEDDIC scorecard',
      description: 'Update and complete the MEDDIC scorecard based on the deep qualification call. Every element should now be confirmed or explicitly flagged as a risk.',
      suggested_action: 'Update icp_signals JSONB under key "meddic" with post-qualification findings. Metrics: quantified business outcome. Economic Buyer: confirmed name and role. Decision Criteria: documented. Decision Process: mapped with timeline. Identified Pain: customer\'s own words. Champion: named and assessed for strength.',
      channel: 'internal_task', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_qualified', sort_order: 3, is_gate: false,
      title: 'Engage and warm all key stakeholders',
      description: 'Multi-thread the deal by establishing direct relationships with every key stakeholder — not just the champion. Deals stall when the AE has a single thread.',
      suggested_action: 'Using the stakeholder map, initiate contact with each key stakeholder. Tailor the outreach to their specific role and concern. Log each interaction in the activity feed. Aim for at least one meaningful touchpoint with each named stakeholder before advancing.',
      channel: 'email', due_offset_days: 7, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_qualified', sort_order: 4, is_gate: false,
      title: 'Build business case and ROI model',
      description: 'Develop a quantified business case for this specific customer — not a generic ROI template. Use the Metrics element from MEDDIC as the foundation.',
      suggested_action: 'Build a business case using the customer\'s own metrics and language from the deep qualification call. Quantify current cost of the problem, expected outcomes, and estimated ROI. Have the champion review and validate the numbers before you present externally.',
      channel: 'document', due_offset_days: 7, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'sales_qualified', sort_order: 5, is_gate: true,
      title: 'Gate: qualification confirmed',
      description: 'Gate: confirm full MEDDIC qualification is complete and the business case is validated before investing demo and commercial resources.',
      suggested_action: 'Confirm: MEDDIC scorecard is complete with no critical unknowns, business case is validated with the champion, economic buyer has been engaged, and all key stakeholders are identified. Only advance if all four are true.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Demo (5)
    {
      stage_key: 'demo', sort_order: 1, is_gate: false,
      title: 'Prepare stakeholder-specific demo flows',
      description: 'Build a tailored demo that addresses each stakeholder\'s specific concerns — not a product walkthrough. The demo should show how your product solves the specific pain identified in MEDDIC.',
      suggested_action: 'Map demo sections to stakeholder roles: economic buyer sees ROI and outcomes, champion sees workflow and efficiency, technical buyer sees integration and security. Prepare data or examples that mirror the customer\'s own situation.',
      channel: 'internal_task', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'demo', sort_order: 2, is_gate: false,
      title: 'Send pre-demo briefing',
      description: 'Share a brief pre-read with all attendees before the demo. An informed audience asks better questions and reaches decisions faster.',
      suggested_action: 'Send a short email to all confirmed attendees: confirmed agenda, the 2–3 specific outcomes you will demonstrate, and any logistics. Include the business case summary if appropriate for the audience.',
      channel: 'email', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'demo', sort_order: 3, is_gate: false,
      title: 'Conduct demo and capture objections per stakeholder',
      description: 'Run the demo, pause to confirm understanding at each stakeholder-relevant section, and capture every objection raised — including unspoken hesitations the champion flags afterwards.',
      suggested_action: 'Run the tailored demo flow. After each section, ask a confirming question: "Does this address what you described earlier?" Capture all objections in real time. Debrief with the champion within 1 hour of the demo to capture unstated concerns.',
      channel: 'meeting', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'demo', sort_order: 4, is_gate: false,
      title: 'Send stakeholder-specific post-demo follow-ups',
      description: 'Send personalised follow-up notes to each attending stakeholder within 24 hours. Each note should address their specific questions and reinforce the points most relevant to their concerns.',
      suggested_action: 'Write individual follow-up emails for each stakeholder — do not send one email to all. Reference the specific questions or objections they raised. Attach the business case for the economic buyer. Propose a clear next step in each message.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'demo', sort_order: 5, is_gate: false,
      title: 'Address technical or security objections',
      description: 'If technical, security, or compliance objections were raised during or after the demo, address them thoroughly before attempting to advance to commercial discussions.',
      suggested_action: 'Identify all technical objections logged from the demo debrief. Engage your solutions engineer or security team as needed. Provide written responses and supporting documentation. Do not move to Commercial & Negotiation with unresolved technical objections.',
      channel: 'internal_task', due_offset_days: 5, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Commercial & Negotiation (6)
    {
      stage_key: 'commercial_negotiation', sort_order: 1, is_gate: false,
      title: 'Prepare proposal and ROI summary',
      description: 'Build the formal commercial proposal using the validated business case and MEDDIC output. The proposal should speak the economic buyer\'s language — outcomes and ROI, not features.',
      suggested_action: 'Prepare a proposal covering: scope of solution, commercial terms, implementation timeline, and projected ROI tied to the customer\'s own metrics from the business case. Get internal approval on pricing before sending.',
      channel: 'document', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'commercial_negotiation', sort_order: 2, is_gate: false,
      title: 'Walk through proposal with economic buyer',
      description: 'Present the proposal directly to the economic buyer — do not send it cold. A live walkthrough allows you to address questions in real time and gauge reaction.',
      suggested_action: 'Book a proposal review call with the economic buyer. Walk through each section. Pause after commercial terms to confirm understanding. Note any pushback on price, scope, or timeline. Do not negotiate on the first call — listen, note, and confirm you will revert.',
      channel: 'meeting', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'commercial_negotiation', sort_order: 3, is_gate: false,
      title: 'Stakeholder alignment check',
      description: 'After presenting the proposal, confirm internal alignment across all key stakeholders. Misalignment discovered late in negotiation is expensive.',
      suggested_action: 'Check in with your champion: are all stakeholders aligned? Are there internal concerns you are not aware of? Use this opportunity to surface and address any internal objections before they derail negotiation.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'commercial_negotiation', sort_order: 4, is_gate: false,
      title: 'Document all open commercial issues',
      description: 'Maintain a live issues list of every open commercial or contractual point. Negotiating without a documented issues list leads to misunderstandings and scope creep.',
      suggested_action: 'Create a simple issues list: item, customer position, your position, and resolution status. Update it after every interaction. Share it with the customer to confirm mutual understanding of what is open and what is closed.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'commercial_negotiation', sort_order: 5, is_gate: false,
      title: 'Negotiate and agree commercial terms',
      description: 'Work through all open commercial issues to reach agreed terms. Know your walk-away position before you start — and protect margin, not just headline price.',
      suggested_action: 'Work through the issues list item by item. For each concession, understand what you are trading it for. Close each issue explicitly and update the issues list to "agreed". When all items are agreed, summarise in writing for both parties.',
      channel: 'meeting', due_offset_days: 5, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'commercial_negotiation', sort_order: 6, is_gate: true,
      title: 'Stakeholder approval — explicit sign-off before contracts',
      description: 'Gate: obtain explicit written confirmation from the economic buyer that the agreed commercial terms are approved before sending to contracts. Verbal approval is not sufficient.',
      suggested_action: 'Send the agreed commercial terms summary by email and request written confirmation. Do not move to Contracts until you have received a clear "yes" in writing from the economic buyer. This protects against late-stage reversals in contracts.',
      channel: 'email', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Contracts (5)
    {
      stage_key: 'contracts', sort_order: 1, is_gate: false,
      title: 'Generate contract from agreed terms',
      description: 'Use the agreed commercial terms and the correct contract template to generate the draft contract. Every term agreed in negotiation must be accurately reflected.',
      suggested_action: 'Select the correct contract template for this deal type. Populate all fields from the agreed commercial terms summary. Have legal or contract operations review before sending. Do not generate contracts from memory — use the documented issues list as the source of truth.',
      channel: 'document', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'contracts', sort_order: 2, is_gate: false,
      title: 'Send contract to customer with cover note',
      description: 'Send the draft contract with a brief cover email summarising the key terms and confirming the agreed points. Never send a contract cold without context.',
      suggested_action: 'Email the contract with a cover note: "As agreed, I am sharing the draft contract reflecting the terms we confirmed on [date]. Key points: [3 bullet summary]. Let me know if you have any questions, otherwise I look forward to your review." Set a follow-up reminder for 3 days.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'contracts', sort_order: 3, is_gate: false,
      title: 'Contract redlines and review',
      description: 'When the customer returns redlines, review them against agreed terms and involve legal for any material changes. Do not accept redlines unilaterally.',
      suggested_action: 'Review all customer redlines. For each: categorise as acceptable, negotiable, or not acceptable. Involve legal for any changes to liability, IP, payment terms, or data clauses. Respond with a clear redline response within 3 business days.',
      channel: 'document', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'contracts', sort_order: 4, is_gate: false,
      title: 'Send for e-sign once terms agreed',
      description: 'When all redlines are resolved and terms are final, send via your e-signature platform immediately. Do not delay sending after terms are agreed — every day of delay risks the deal.',
      suggested_action: 'Upload the final agreed contract to your e-signature platform. Add all signatories in the correct signing order. Send immediately on agreement — same day if possible. Confirm receipt with the customer.',
      channel: 'document', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'contracts', sort_order: 5, is_gate: true,
      title: 'Gate: fully executed contract received',
      description: 'Gate: do not advance to Closed Won until the fully executed, counter-signed contract is received and filed. A verbal agreement is not a closed deal.',
      suggested_action: 'Confirm the fully executed contract has been received with all required signatures. Upload the signed PDF to the deal record. Only then advance the deal to Closed Won. Notify finance and CS of the close.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Closed Won (3)
    {
      stage_key: 'closed_won', sort_order: 1, is_gate: false,
      title: 'Log final contract and confirm deal value',
      description: 'Update the deal record with final contract value, start date, and any other commercial terms. The CRM record must exactly match the signed contract.',
      suggested_action: 'Update deal value, ARR, contract start date, and renewal date on the deal record. Attach the signed contract PDF. Notify finance with deal details for invoicing. Confirm all figures match the executed contract.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'closed_won', sort_order: 2, is_gate: false,
      title: 'Send win notification to team',
      description: 'Announce the win to the relevant internal teams. Celebrating wins matters for team culture — and ensuring all functions are aware of the new customer is operationally important.',
      suggested_action: 'Send a win announcement to your team channel covering: customer name, deal value, key stakeholders, why they bought, and special notes for implementation. Tag CS, implementation, and finance.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'closed_won', sort_order: 3, is_gate: false,
      title: 'Initiate handover to CS and implementation',
      description: 'Start the formal handover process to Customer Success and implementation. The customer\'s first impression of post-sale is set in the first 48 hours.',
      suggested_action: 'Open a Handover record in the Handovers pipeline. Brief CS on the customer\'s goals, key stakeholders, commercial commitments made, and any sensitivities. Introduce the CS owner to the customer by email within 48 hours of contract signature.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Closed Lost (3)
    {
      stage_key: 'closed_lost', sort_order: 1, is_gate: false,
      title: 'Conduct loss analysis',
      description: 'Understand exactly why you lost — not a guess, but a structured debrief. Loss analysis data is among the most valuable insight a sales team can gather.',
      suggested_action: 'Complete your loss analysis immediately while the deal is fresh. Cover: when did we lose (the actual moment vs. when we found out), why did we lose (price, competitor, no decision, timing), what could we have done differently, and what signals did we miss. Record in research_notes.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'closed_lost', sort_order: 2, is_gate: false,
      title: 'Send gracious loss acknowledgement',
      description: 'Send a professional, gracious message to the economic buyer acknowledging the outcome. Lost deals become future opportunities if the relationship is handled well.',
      suggested_action: 'Send a brief email: thank them for the process, acknowledge their decision, wish them well with their chosen solution, and leave the door open for the future. Do not ask for feedback unless they offer it — it can feel like pressure.',
      channel: 'email', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'closed_lost', sort_order: 3, is_gate: false,
      title: 'Schedule 6-month re-engagement reminder',
      description: 'Set a reminder to re-engage in 6 months. Competitors lose implementations. Circumstances change. Many lost deals are won in a later cycle.',
      suggested_action: 'Create a task 6 months from today to review this account. Note the loss reason and the competitors involved so the future outreach is informed. If the loss was timing-related, set the revisit_date on the linked prospect record.',
      channel: 'internal_task', due_offset_days: 1, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
  ],

  // ── CLM (40 plays) ────────────────────────────────────────────────────────

  clm: [

    // Draft (3)
    {
      stage_key: 'draft', sort_order: 1, is_gate: false,
      title: 'Select correct contract template',
      description: 'Identify and use the correct contract template for this contract type — MSA, NDA, SOW, amendment, or renewal. Using the wrong template creates legal and compliance risk.',
      suggested_action: 'Select the appropriate template from your contract library. If this is an amendment, start from the current executed contract, not a blank template. Confirm with legal if the contract type is non-standard.',
      channel: 'document', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'draft', sort_order: 2, is_gate: false,
      title: 'Populate all required fields',
      description: 'Complete every required field in the contract — parties, dates, scope, commercial terms, SLAs, and any special conditions. Incomplete drafts sent for review waste everyone\'s time.',
      suggested_action: 'Work through the contract template systematically. Do not leave any fields blank unless they are intentionally optional. Cross-reference the agreed commercial terms summary from the Sales stage to ensure every agreed point is captured.',
      channel: 'document', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'draft', sort_order: 3, is_gate: true,
      title: 'Internal review before submission',
      description: 'Gate: the contract draft must pass a basic internal quality review before being submitted to legal or the customer. Submitting an incomplete or inconsistent draft reflects poorly on the business.',
      suggested_action: 'Review the draft for: correct parties, accurate commercial terms, no blank required fields, consistent dates, and correct template version. If all checks pass, advance to In Review — Legal. If not, correct and re-check.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // In Review — Legal (3)
    {
      stage_key: 'in_review_legal', sort_order: 1, is_gate: false,
      title: 'Assign to legal reviewer',
      description: 'Formally assign the contract to the relevant legal reviewer and set a clear review deadline. Unassigned legal reviews get deprioritised.',
      suggested_action: 'Assign the contract to the designated legal reviewer in your contract management system. Set a deadline of 3–5 business days depending on complexity. Include context: deal size, customer name, and any non-standard clauses to flag.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_review_legal', sort_order: 2, is_gate: false,
      title: 'Provide business context to legal',
      description: 'Brief legal on the commercial context behind the contract — the deal size, customer relationship, timeline sensitivity, and any commercial commitments made. Legal context-free reviews are slower and less accurate.',
      suggested_action: 'Send the legal reviewer a brief context note: customer name, deal value, summary of what was agreed commercially, any non-standard terms the customer requested, and the target signature date. Reference the contract record.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_review_legal', sort_order: 3, is_gate: false,
      title: 'Chase legal review if overdue',
      description: 'If the legal review has not been completed by the agreed deadline, escalate proactively. Contract delays directly impact deal close dates and customer experience.',
      suggested_action: 'If the legal review deadline has passed without output, send a direct follow-up to the legal reviewer and cc their manager if appropriate. Reference the deadline, the deal value, and the customer\'s expected timeline. Do not let legal reviews sit without a chase.',
      channel: 'internal_task', due_offset_days: 5, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // In Review — Sales (3)
    {
      stage_key: 'in_review_sales', sort_order: 1, is_gate: false,
      title: 'Review legal redlines',
      description: 'The AE reviews all legal redlines to understand what has changed and whether any changes affect the commercial deal as agreed with the customer.',
      suggested_action: 'Open the redlined contract. For each change, assess: is this a standard legal position (acceptable), a negotiable point, or a material change to the deal? Flag any changes that deviate from what was commercially agreed with the customer.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_review_sales', sort_order: 2, is_gate: false,
      title: 'Confirm internal approval for material changes',
      description: 'If the legal review resulted in material changes to commercial terms, obtain internal approval before sharing with the customer.',
      suggested_action: 'For any material changes identified, get sign-off from the relevant internal approver (sales director, CFO, or deal desk) before proceeding. Document the approval in the contract record.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_review_sales', sort_order: 3, is_gate: false,
      title: 'Return contract to customer or send back to legal',
      description: 'Once the Sales review is complete and any required approvals are obtained, move the contract to the next stage — either to the customer for review or back to legal if further changes are needed.',
      suggested_action: 'If the contract is ready for the customer, advance to In Review — Customer. If additional legal work is required, return to In Review — Legal with specific instructions on what to address. Update the contract record with the outcome of the Sales review.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // In Review — Customer (3)
    {
      stage_key: 'in_review_customer', sort_order: 1, is_gate: false,
      title: 'Send contract to customer with cover note',
      description: 'Send the draft contract to the customer\'s designated reviewer with a brief cover note setting context and confirming the review process.',
      suggested_action: 'Email the contract to the customer\'s legal or procurement contact. Cover note: what the document is, key terms to note, your expected review timeline, and who to contact with questions. Set a follow-up reminder for 3 business days.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_review_customer', sort_order: 2, is_gate: false,
      title: 'Chase customer if no response within 3 days',
      description: 'If the customer has not acknowledged receipt or provided any feedback within 3 business days, send a polite chase. Contracts left without a chase often slip by weeks.',
      suggested_action: 'Send a brief follow-up email: confirm they received the contract, ask if they have any initial questions, and confirm your target completion date. Copy your champion if the legal or procurement contact has been unresponsive.',
      channel: 'email', due_offset_days: 3, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_review_customer', sort_order: 3, is_gate: false,
      title: 'Log all customer redlines on receipt',
      description: 'When the customer returns redlines, log all changes systematically before beginning internal review. A complete redline log prevents items being missed.',
      suggested_action: 'On receiving the customer\'s redlined contract, immediately compile a complete redline list: clause reference, original text summary, customer proposed change, and initial assessment (acceptable/negotiable/unacceptable). Share with legal within 24 hours of receipt.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // In Signatures (8)
    {
      stage_key: 'in_signatures', sort_order: 1, is_gate: false,
      title: 'Confirm all signatories and send for e-sign',
      description: 'Confirm the full list of required signatories on both sides before sending via e-signature. Sending to the wrong signatory or missing a required party delays execution.',
      suggested_action: 'Confirm signatory names and email addresses with both your legal team and the customer\'s legal or procurement contact. Upload the final agreed contract to your e-signature platform. Add signatories in the correct order. Send immediately.',
      channel: 'document', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_signatures', sort_order: 2, is_gate: false,
      title: 'Notify signatories directly',
      description: 'Do not rely on the e-signature platform\'s automated email to alert signatories. Send a direct message to each signatory confirming the request and its urgency.',
      suggested_action: 'Send a direct email to each signatory: "I have just sent you a DocuSign / e-signature request for [contract name]. This is time-sensitive — your signature is needed by [date]. Please let me know if you have any questions."',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_signatures', sort_order: 3, is_gate: false,
      title: 'Chase unsigned signatories at day 3',
      description: 'If any signatory has not signed within 3 days, send a direct chase. Signature delays are the most common cause of quarter-end deal slippage.',
      suggested_action: 'Check the e-signature platform for unsigned parties. Send a direct, brief message to any unsigned signatory: "Just following up on the signature request sent on [date] — are you able to sign today?" Copy your champion for the customer side.',
      channel: 'email', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_signatures', sort_order: 4, is_gate: false,
      title: 'Confirm booking with finance',
      description: 'Alert finance that a contract is in signatures so they can prepare for booking on execution. Finance surprises at quarter-end create recognition and cash flow problems.',
      suggested_action: 'Send finance a heads-up: customer name, deal value, ARR, expected signature date, and billing start date. Confirm any special billing terms (annual upfront, quarterly, custom) so finance can prepare the invoice immediately on signing.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_signatures', sort_order: 5, is_gate: false,
      title: 'Update deal record to Closed Won on execution',
      description: 'As soon as the contract is fully executed, update the deal stage to Closed Won immediately. Do not wait until end-of-day or end-of-week.',
      suggested_action: 'On receipt of the fully executed contract from e-signature, immediately advance the linked deal record to Closed Won. Attach the signed PDF. Update deal value and close date to match the executed contract.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_signatures', sort_order: 6, is_gate: false,
      title: 'Trigger implementation handover',
      description: 'Notify the implementation and Customer Success team that the contract is executed and their engagement should begin.',
      suggested_action: 'Send a handover notification to CS and implementation: customer name, contract start date, key commercial terms, and a link to the deal record. Open a Handover record if one does not already exist.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_signatures', sort_order: 7, is_gate: false,
      title: 'Confirm amendment supersedes correctly (if applicable)',
      description: 'If this contract is an amendment, confirm it correctly supersedes the relevant clauses of the original agreement and that both documents are filed together.',
      suggested_action: 'If this is an amendment, verify the supersession language is correct and references the original contract by date and title. File both documents linked in the contract record. Notify finance and legal of the supersession.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_signatures', sort_order: 8, is_gate: true,
      title: 'Gate: fully executed contract received',
      description: 'Gate: confirm the fully counter-signed contract has been received, filed, and linked to the deal record before advancing to Active.',
      suggested_action: 'Verify all signatures are present in the executed document. Upload the final signed PDF to the contract record. Link to the deal record. Confirm finance has been notified. Only then advance to Active.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Active (13) — all trigger_mode: 'stage_change', grouped by sort_order band
    {
      stage_key: 'active', sort_order: 1, is_gate: false,
      title: 'Confirm contract is filed and accessible',
      description: 'Ensure the fully executed contract is stored in the document management system and accessible to relevant stakeholders — finance, legal, CS, and AE.',
      suggested_action: 'Upload the final signed PDF to the contract record. Tag with the correct account, deal, and contact. Confirm finance and legal have access.',
      channel: 'document', due_offset_days: 2, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 2, is_gate: false,
      title: 'Update deal and contract records (post-amendment)',
      description: 'If this activation follows an amendment, update the deal value, contract terms, and any other fields affected by the amendment.',
      suggested_action: 'Attach the signed amendment to the contract record. Update ARR in the deal record. Notify finance if the change affects billing or payment schedule.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 3, is_gate: false,
      title: 'Notify all stakeholders of amendment (if applicable)',
      description: 'Ensure legal, finance, CSM, and AE all have a copy of any signed amendment and understand what has changed.',
      suggested_action: 'Send a brief internal summary: what changed, the effective date, and any operational impact such as new SLAs, expanded scope, or revised payment terms.',
      channel: 'internal_task', due_offset_days: 2, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 4, is_gate: false,
      title: 'Schedule 90-day check-in with customer',
      description: 'Book a 90-day business review with the customer to confirm they are on track to realise the value they bought. The 90-day check-in is the earliest signal of renewal risk or expansion potential.',
      suggested_action: 'Send the calendar invite from day 1 of activation. Frame as a business review: "We want to make sure you are getting full value from [product] — let us check in at 90 days."',
      channel: 'meeting', due_offset_days: 14, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 5, is_gate: false,
      title: 'Set renewal reminder at 180 days before expiry',
      description: 'Create an internal task to begin renewal conversations at the 180-day-before-expiry mark. Do not wait until the contract appears in the expiring soon flag.',
      suggested_action: 'Create a task timed to 180 days before the contract expiry date. Note: start at 6 months out for enterprise accounts, 90 days out for SMB. The renewal conversation should begin long before the expiring_soon flag fires.',
      channel: 'internal_task', due_offset_days: 7, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 6, is_gate: false,
      title: '[EXPIRING SOON] Review account health before renewal outreach',
      description: 'Fires when expiring_soon flag is set. Check support tickets, product usage, NPS, and CSM notes to understand the customer\'s sentiment before starting the renewal conversation. Do not kick off renewal outreach blind — a churning customer needs a different conversation than a healthy, expanding one.',
      suggested_action: 'Pull the customer\'s support ticket history, product usage data, and CSM health score. Review NPS if available. Align with the CSM before sending any renewal outreach. Document your health assessment in the contract record.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 7, is_gate: false,
      title: '[EXPIRING SOON] Send renewal outreach to economic buyer',
      description: 'Fires when expiring_soon flag is set. Initiate the renewal conversation with the economic buyer — lead with value delivered, not the contract renewal date.',
      suggested_action: 'Frame the outreach around outcomes achieved: "We are coming up on the renewal of your contract in [X months] — I wanted to connect to understand how things are going and discuss what the next phase looks like." Do not open with contract language.',
      channel: 'email', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 8, is_gate: false,
      title: '[EXPIRING SOON] Schedule renewal review meeting',
      description: 'Fires when expiring_soon flag is set. Book a formal renewal review meeting to present usage data, ROI achieved, and the renewal or expansion proposal.',
      suggested_action: 'Bring data to the renewal review: product adoption metrics, key outcomes achieved, and support resolution rates. Come with a renewal proposal and at least one expansion option.',
      channel: 'meeting', due_offset_days: 5, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 9, is_gate: false,
      title: '[EXPIRING SOON] Prepare renewal or expansion proposal',
      description: 'Fires when expiring_soon flag is set. Build the renewal proposal covering current scope, recommended expansion, updated commercial terms, and revised ROI projection.',
      suggested_action: 'Always propose an expansion alongside the base renewal. Even if the customer only renews flat, having the expansion option opens a conversation about their future roadmap. Validate the proposal with the champion before presenting to the economic buyer.',
      channel: 'document', due_offset_days: 7, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 10, is_gate: false,
      title: '[URGENT: <30 DAYS] Escalate to AE if contract expiry under 30 days',
      description: 'Fires when contract expiry is under 30 days. Flag the urgency to the AE or account manager — this needs immediate personal attention.',
      suggested_action: 'Urgent expiries require direct AE ownership. Assign the renewal to the AE in the system and notify them immediately. Do not manage a sub-30-day expiry through CSM alone.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 11, is_gate: false,
      title: '[URGENT: <30 DAYS] Call economic buyer directly',
      description: 'Fires when contract expiry is under 30 days. Phone the economic buyer to understand renewal status and any blockers. Do not rely on email at this stage.',
      suggested_action: 'A direct call signals urgency and respect. Be direct: "I want to make sure we can keep your service uninterrupted — what do we need to do to close the renewal this week?" Document the call outcome in the contract record immediately.',
      channel: 'meeting', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 12, is_gate: false,
      title: '[URGENT: <30 DAYS] Offer short-term extension if needed',
      description: 'Fires when contract expiry is under 30 days. If the renewal cannot be completed before expiry, propose a short-term extension of 30–60 days to avoid service disruption.',
      suggested_action: 'A short-term extension is preferable to a lapsed contract. Get legal and finance approval before offering. Send the extension agreement for immediate signature.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'active', sort_order: 13, is_gate: false,
      title: '[AT RISK] Involve exec sponsor if renewal is at risk',
      description: 'Fires when ARR impact flag is set on the contract record. If there is any signal the renewal may not proceed, involve an executive sponsor from your side immediately.',
      suggested_action: 'Exec-to-exec conversations often unblock renewals stalled at the working level. Brief your exec before any call: context, risk level, and what you need from them. Do not involve the exec without a clear briefing.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Voided / Cancelled (4)
    {
      stage_key: 'voided_cancelled', sort_order: 1, is_gate: false,
      title: 'Document reason for voiding or cancellation',
      description: 'Record the specific reason — voided due to error (incorrect parties, duplicate, legal invalidity) or cancelled by authorised request. A clear audit trail is essential.',
      suggested_action: 'Log the reason in the contract record. Distinguish between void (contract was never valid) and cancelled (contract was valid but terminated early by agreement). Include the date and the name of the person who authorised the action.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'voided_cancelled', sort_order: 2, is_gate: false,
      title: 'Confirm cancellation is valid and authorised',
      description: 'Verify any cancellation request is legitimate, from an authorised signatory, and properly documented in writing.',
      suggested_action: 'Confirm: who requested the cancellation, whether they have authority to cancel, and that the request is in writing. Do not process a cancellation until all three are confirmed.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'voided_cancelled', sort_order: 3, is_gate: false,
      title: 'Notify finance and close records',
      description: 'Notify finance of the void or cancellation and update all relevant records including deal stage, ARR, and contract status.',
      suggested_action: 'Update deal stage, ARR, and contract status. Ensure any invoices or pending payments are handled correctly before closing records. Send a notification to finance with full details.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'voided_cancelled', sort_order: 4, is_gate: false,
      title: 'Issue corrected contract if voided in error',
      description: 'If the contract was voided due to a drafting error, prepare and issue a corrected version promptly.',
      suggested_action: 'Review the original contract carefully before correcting to ensure all errors are addressed. Once corrected, restart the contract process from Draft with the corrected document. Log the void reason and correction in the contract record.',
      channel: 'document', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Terminated (3)
    {
      stage_key: 'terminated', sort_order: 1, is_gate: false,
      title: 'Review termination clause and notice period',
      description: 'Confirm the contractual basis for termination, the required notice period, and any obligations that survive termination.',
      suggested_action: 'Read the termination clause carefully. Confirm: notice period required, effective date of termination, any wind-down obligations, data return or destruction requirements, and any survival clauses. Document your findings.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'terminated', sort_order: 2, is_gate: false,
      title: 'Notify legal and finance',
      description: 'Alert legal and finance immediately on contract termination. Both teams have obligations to meet under a termination that cannot wait.',
      suggested_action: 'Notify legal: termination details, effective date, and any survival obligations. Notify finance: stop billing, handle any refund or credit obligations, update ARR and booking records. Document all notifications.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'terminated', sort_order: 3, is_gate: false,
      title: 'Document root cause of termination',
      description: 'Conduct a post-mortem to understand why the contract was terminated. This data informs product, CS, and commercial strategy.',
      suggested_action: 'Write a termination post-mortem: when did the risk first appear, what were the root causes, what could have been done differently, and what is the re-engagement potential. Record in the contract and deal records. Share with CS and product leadership.',
      channel: 'internal_task', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Expired — No Renewal (3)
    {
      stage_key: 'expired_no_renewal', sort_order: 1, is_gate: false,
      title: 'Document reason for non-renewal',
      description: 'Capture why this contract was not renewed — whether price, product, competitor, or business change. This data is essential for retention analysis.',
      suggested_action: 'Record the specific non-renewal reason in the contract record. Where possible, obtain the reason directly from the customer rather than inferring it. Classify against your standard taxonomy and share with the CS and product teams.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'expired_no_renewal', sort_order: 2, is_gate: false,
      title: 'Send closure communication to customer',
      description: 'Send a professional closure message to the customer acknowledging the end of the contract, confirming any wind-down actions, and leaving the relationship in good standing.',
      suggested_action: 'Send a brief, warm email: confirm the contract end date, outline any wind-down steps (data export, access removal), thank them for the partnership, and leave the door open for future engagement. Do not be transactional.',
      channel: 'email', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'expired_no_renewal', sort_order: 3, is_gate: false,
      title: 'Schedule 6-month re-engagement task',
      description: 'Set a task to re-engage this account in 6 months. Expired contracts often represent timing mismatches, not permanent losses.',
      suggested_action: 'Create a task 6 months from the expiry date to review the account and consider re-engagement. Note the non-renewal reason so future outreach is informed. Route to the AE or CS owner who held the relationship.',
      channel: 'internal_task', due_offset_days: 1, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
  ],

  // ── SERVICE (16 plays) ────────────────────────────────────────────────────

  service: [

    // Open (4)
    {
      stage_key: 'open', sort_order: 1, is_gate: false,
      title: 'Send acknowledgement to customer',
      description: 'Acknowledge receipt of the case to the customer immediately. Fast acknowledgement reduces anxiety and signals a professional support operation.',
      suggested_action: 'Send an automated or manual acknowledgement email: case number, receipt confirmation, expected response time based on priority, and contact details for the support owner. Aim for acknowledgement within 30 minutes for critical, 2 hours for high, 4 hours for standard.',
      channel: 'email', due_offset_days: 0, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'open', sort_order: 2, is_gate: false,
      title: 'Categorise and set priority',
      description: 'Classify the case by type (bug, feature request, how-to, configuration) and set the correct priority. Miscategorised cases get routed incorrectly and resolved slowly.',
      suggested_action: 'Review the case description carefully. Set category and priority based on your support triage criteria: Critical (product down, data loss), High (major functionality impaired), Medium (feature not working as expected), Low (minor issue or question). Update the case record.',
      channel: 'internal_task', due_offset_days: 0, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'open', sort_order: 3, is_gate: false,
      title: 'Assign to appropriate support engineer',
      description: 'Route the case to the support engineer with the right skill set and availability. Correct initial assignment reduces handling time significantly.',
      suggested_action: 'Assign the case based on category and complexity. For critical or high-priority cases, confirm the assignee is available and aware. Do not assign to a queue — assign to a named engineer who acknowledges ownership.',
      channel: 'internal_task', due_offset_days: 0, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'open', sort_order: 4, is_gate: false,
      title: 'Escalate critical or SLA-breached cases',
      description: 'If the case is Critical priority or an SLA breach is imminent, escalate immediately to the support manager and notify the CSM.',
      suggested_action: 'For Critical priority: notify support manager within 15 minutes of receipt. For SLA breach risk: flag immediately and assign a senior engineer. Notify the CSM so they can proactively communicate with the customer. Document the escalation in the case record.',
      channel: 'internal_task', due_offset_days: 0, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // In Progress (4)
    {
      stage_key: 'in_progress', sort_order: 1, is_gate: false,
      title: 'Investigate and reproduce the issue',
      description: 'Systematically investigate the reported issue and attempt to reproduce it in a controlled environment. You cannot fix what you cannot reproduce.',
      suggested_action: 'Follow the reproduction steps provided by the customer. If steps are unclear, contact the customer for clarification before investigation. Document your investigation findings — environment, steps taken, and outcome — in the case record.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_progress', sort_order: 2, is_gate: false,
      title: 'Send progress update to customer',
      description: 'Keep the customer informed at regular intervals. Silence is the number one driver of customer frustration during support resolution.',
      suggested_action: 'Send a brief progress update: what has been investigated, what has been found so far, and the expected next update or resolution timeline. For Critical cases: update every 2 hours. High: daily. Medium: every 2 days.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_progress', sort_order: 3, is_gate: false,
      title: 'Escalate to engineering if required',
      description: 'If the issue requires code-level investigation or a product fix, escalate to the engineering team with a full brief. Do not escalate without context.',
      suggested_action: 'Create an engineering escalation ticket with: reproduction steps, environment details, customer impact, SLA status, and your diagnosis to date. Agree an SLA with engineering for initial response. Keep the customer informed of the escalation.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'in_progress', sort_order: 4, is_gate: false,
      title: 'Chase resolution if SLA at risk',
      description: 'If the case has been in progress for more than 70% of the SLA window without resolution, escalate internally and set a recovery plan.',
      suggested_action: 'Flag the SLA risk to the support manager immediately. Review the investigation status and identify blockers. Agree a recovery plan and communicate it to the customer proactively — do not wait for the SLA to breach.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Pending Customer (3)
    {
      stage_key: 'pending_customer', sort_order: 1, is_gate: false,
      title: 'Send specific information request to customer',
      description: 'Request the specific information needed to progress the case. Vague requests generate vague responses and delay resolution.',
      suggested_action: 'Send a clear, itemised request: list exactly what information is needed, why each item is needed, and how to provide it. Give the customer a specific response deadline. Pause the SLA clock if your system supports it.',
      channel: 'email', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'pending_customer', sort_order: 2, is_gate: false,
      title: 'Follow up if no response within 2 days',
      description: 'If the customer has not responded to the information request within 2 business days, send a polite follow-up.',
      suggested_action: 'Send a brief follow-up referencing your original request and the case number. Offer to schedule a quick call if it would be easier than written responses. Copy the CSM if the customer is an enterprise account.',
      channel: 'email', due_offset_days: 2, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'pending_customer', sort_order: 3, is_gate: false,
      title: 'Close case if no response after 7 days',
      description: 'If the customer has not responded within 7 days of the information request, close the case with a note explaining it can be reopened when information is provided.',
      suggested_action: 'Send a closure notification: "We have not received the information needed to progress this case. We are closing it for now — please reopen or reply to this email if you would like to continue. All previous case history will be retained."',
      channel: 'email', due_offset_days: 7, priority: 'low', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Resolved (3)
    {
      stage_key: 'resolved', sort_order: 1, is_gate: false,
      title: 'Send resolution confirmation to customer',
      description: 'Confirm the resolution with the customer and verify they are satisfied before closing the case. A confirmation prevents re-opened cases from an unsatisfied customer.',
      suggested_action: 'Send a resolution summary: what the issue was, what was done to fix it, and any steps needed from the customer. Ask them to confirm the fix is working and that they are satisfied. Set a 2-day wait for confirmation before closing.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'resolved', sort_order: 2, is_gate: false,
      title: 'Document root cause and resolution',
      description: 'Record the root cause, resolution steps, and any product or process implications in the case record. This documentation builds your support knowledge base over time.',
      suggested_action: 'Write a clear root cause analysis: what was the underlying cause, what steps resolved it, is this a known issue, and does it require a product change or documentation update? Add to your internal knowledge base if it is a new issue type.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'resolved', sort_order: 3, is_gate: false,
      title: 'Request CSAT feedback',
      description: 'Request a Customer Satisfaction rating from the customer after resolution. CSAT data is the primary feedback mechanism for support quality improvement.',
      suggested_action: 'Send a CSAT survey immediately after resolution confirmation. Keep it to 2 questions: overall satisfaction (1–5) and one open text field for comments. Record results in the case record. Flag low scores to the support manager and CSM.',
      channel: 'email', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Closed (2)
    {
      stage_key: 'closed', sort_order: 1, is_gate: false,
      title: 'Flag recurring issues for product team',
      description: 'If this case represents a pattern — the same issue appearing across multiple customers — flag it to the product team for systemic resolution.',
      suggested_action: 'Check whether this issue has been reported by more than one customer in the last 30 days. If so, create or update a product issue ticket with the aggregated case count, customer impact, and case references. Notify the product manager.',
      channel: 'internal_task', due_offset_days: 1, priority: 'medium', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'closed', sort_order: 2, is_gate: false,
      title: 'Escalate to CSM if customer expressed dissatisfaction',
      description: 'If the customer expressed frustration, gave a low CSAT score, or the case had an SLA breach, notify the CSM to follow up personally.',
      suggested_action: 'Send the CSM a brief note: case number, what happened, CSAT score if received, and any statements the customer made about their satisfaction. The CSM should make a proactive check-in call within 48 hours.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
  ],

  // ── HANDOVERS (15 plays) ──────────────────────────────────────────────────

  handovers: [

    // Assign Service Owner (4)
    {
      stage_key: 'assign_service_owner', sort_order: 1, is_gate: false,
      title: 'Assign CS or implementation owner',
      description: 'Identify and formally assign the Customer Success or implementation owner for this account. Every new customer must have a named owner within 24 hours of contract signature.',
      suggested_action: 'Assign the CS or implementation owner in the handover record based on customer size, complexity, and team capacity. Notify the assigned owner immediately with a summary of the customer and the expected handover timeline.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'assign_service_owner', sort_order: 2, is_gate: false,
      title: 'Assemble internal delivery team',
      description: 'Identify all internal team members needed for the customer\'s implementation or onboarding — not just the CS owner, but implementation engineers, trainers, or specialists.',
      suggested_action: 'Review the contract scope and customer requirements. Identify all required internal roles and confirm availability with each team lead. Document the full delivery team in the handover record with names, roles, and responsibilities.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'assign_service_owner', sort_order: 3, is_gate: true,
      title: 'Confirm service owner and team has accepted',
      description: 'Gate: the CS owner and delivery team must formally confirm acceptance of this customer before the AE makes any introductions.',
      suggested_action: 'Obtain explicit confirmation from the CS owner and each delivery team member that they have reviewed the handover brief, accepted the assignment, and are ready for customer introduction. Do not introduce the team to the customer before this is confirmed.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'assign_service_owner', sort_order: 4, is_gate: false,
      title: 'Notify customer of service owner and confirmed team',
      description: 'Introduce the CS owner and delivery team to the customer professionally. The first post-sale introduction sets the tone for the entire customer relationship.',
      suggested_action: 'AE sends an introduction email to the key customer contacts: introduce the CS owner and relevant team members by name and role, outline the next steps in the handover process, and confirm the kick-off call date.',
      channel: 'email', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Document Stakeholders (4)
    {
      stage_key: 'document_stakeholders', sort_order: 1, is_gate: false,
      title: 'Map all customer stakeholders',
      description: 'Build a complete map of all customer stakeholders relevant to the implementation and ongoing relationship — not just the economic buyer and champion from the sales process.',
      suggested_action: 'Work with the AE to document all customer stakeholders: name, role, email, involvement level (decision maker / influencer / user), and relationship health. Include day-to-day contacts who will be working with your implementation team.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'document_stakeholders', sort_order: 2, is_gate: false,
      title: 'Document customer goals and success criteria',
      description: 'Record the specific, measurable goals the customer expects to achieve. These become the success criteria for the implementation and the baseline for renewal conversations.',
      suggested_action: 'Work with the champion to define 3–5 specific success outcomes with measurable targets and timeframes. Examples: "Reduce time-to-hire by 30% within 90 days" or "Consolidate 4 tools into 1 within 6 months." Document in the handover record.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'document_stakeholders', sort_order: 3, is_gate: false,
      title: 'Note any known risks or sensitivities',
      description: 'Document any risks, sensitivities, or concerns identified during the sales process that the delivery team needs to be aware of.',
      suggested_action: 'Record any known risks: technical constraints, political sensitivities between stakeholders, previous bad experiences with vendors, tight timelines, or budget constraints. These should inform the CS strategy from day one.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'document_stakeholders', sort_order: 4, is_gate: true,
      title: 'Complete stakeholder map gate',
      description: 'Gate: confirm the stakeholder map, success criteria, and risk notes are complete and have been reviewed by the CS owner before advancing.',
      suggested_action: 'CS owner reviews and confirms: all key stakeholders documented, success criteria are measurable and agreed, and risk notes are complete. Only advance when the CS owner confirms they have everything needed to begin the engagement.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Record Commitments & Risks (4)
    {
      stage_key: 'record_commitments_risks', sort_order: 1, is_gate: false,
      title: 'Log all sales commitments made',
      description: 'Document every commitment made by the sales team during the deal — delivery timelines, custom features, special terms, pricing commitments, and any verbal promises. This prevents post-sale surprises.',
      suggested_action: 'Work with the AE to compile a complete list of all commitments made. Include: what was committed, when it was committed, to whom, and the source (email, call recording, contract clause). Do not rely on memory — go back to the deal record and communications.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'record_commitments_risks', sort_order: 2, is_gate: false,
      title: 'Assign owner and due date to each commitment',
      description: 'Every commitment must have a named owner and a specific due date. Unowned commitments are broken commitments.',
      suggested_action: 'For each commitment on the list, assign: the internal owner responsible for delivery, a specific due date, and the customer contact who is expecting it. Update the handover record with the full commitments register.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'record_commitments_risks', sort_order: 3, is_gate: false,
      title: 'Flag any non-standard commitments for review',
      description: 'Identify any commitments that are outside standard product capability, pricing policy, or delivery practice and flag them for immediate leadership review.',
      suggested_action: 'Review the commitments list for anything non-standard. Flag items to the relevant leader: product commitments to the CPO, pricing exceptions to the CFO, delivery commitments to the CS or delivery lead. Non-standard commitments need a delivery plan or a customer conversation.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'record_commitments_risks', sort_order: 4, is_gate: true,
      title: 'Confirm all commitments are logged and owned',
      description: 'Gate: confirm the complete commitments register has been reviewed by CS and delivery leadership before advancing.',
      suggested_action: 'CS lead and delivery manager review the commitments register. Confirm: all commitments have an owner, all have a due date, non-standard items have been escalated and have a resolution plan. Only advance when all commitments are owned.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Confirm Go-Live & Commercial (3)
    {
      stage_key: 'confirm_golive_commercial', sort_order: 1, is_gate: false,
      title: 'Confirm go-live date with customer',
      description: 'Establish and confirm a specific go-live date with the customer. A clear go-live date creates urgency, alignment, and a shared target for both teams.',
      suggested_action: 'Book a planning call with the customer to confirm the go-live date based on the implementation timeline. Share the internal delivery plan at high level. Confirm the customer understands what is required from their side (IT access, data provision, user availability).',
      channel: 'meeting', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'confirm_golive_commercial', sort_order: 2, is_gate: false,
      title: 'Confirm commercial terms are reflected in system',
      description: 'Verify that the deal record, billing system, and CRM all correctly reflect the commercial terms from the executed contract. Discrepancies discovered post-implementation are disruptive.',
      suggested_action: 'Cross-check: deal value in CRM, billing schedule in the finance system, and any special commercial terms (volume discounts, usage caps, custom SLAs) are all correctly entered and match the signed contract.',
      channel: 'internal_task', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'confirm_golive_commercial', sort_order: 3, is_gate: false,
      title: 'Schedule kick-off call with customer',
      description: 'Book the formal project kick-off call with all relevant stakeholders from both sides. The kick-off sets expectations, introduces the delivery team, and marks the official start of the implementation.',
      suggested_action: 'Invite all relevant customer stakeholders and the internal delivery team. Prepare a kick-off agenda: introductions, project goals and success criteria, delivery timeline, key milestones, communication cadence, and next steps. Send the agenda 24 hours in advance.',
      channel: 'meeting', due_offset_days: 3, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },

    // Attach Docs & Sign-off (4)
    {
      stage_key: 'attach_docs_signoff', sort_order: 1, is_gate: false,
      title: 'Attach all relevant documents',
      description: 'Compile and attach all documents relevant to the handover — signed contract, scope of work, stakeholder map, commitments register, success criteria, and any technical requirements.',
      suggested_action: 'Upload all documents to the handover record and the deal record. Ensure they are accessible to CS, implementation, finance, and legal. Create a document index so the full delivery team can find what they need.',
      channel: 'document', due_offset_days: 2, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'attach_docs_signoff', sort_order: 2, is_gate: false,
      title: 'AE and CS sign off on handover completeness',
      description: 'The AE and CS owner formally sign off that the handover is complete and that all required information has been transferred.',
      suggested_action: 'AE confirms: all sales context has been transferred and no undisclosed commitments remain. CS owner confirms: they have everything needed to begin the customer engagement and are ready to take ownership. Both must confirm before the handover is closed.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'attach_docs_signoff', sort_order: 3, is_gate: false,
      title: 'Send handover summary to service team',
      description: 'Share a concise handover summary with the full service delivery team so everyone is aligned on customer context, goals, commitments, and risks.',
      suggested_action: 'Write a 1-page handover summary: customer overview, why they bought, key stakeholders, success criteria, commitments made, known risks, and first 30-day priorities. Distribute to CS owner, implementation team, and support lead.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
    {
      stage_key: 'attach_docs_signoff', sort_order: 4, is_gate: true,
      title: 'Complete handover sign-off gate',
      description: 'Gate: the formal close of the Sales-to-CS handover. Once this gate is passed, the CS owner has full ownership and the AE\'s handover responsibilities are complete.',
      suggested_action: 'Final checklist: all documents attached, AE sign-off complete, CS sign-off complete, handover summary distributed, kick-off call scheduled, customer has been introduced to their CS owner. Only pass this gate when every item is confirmed.',
      channel: 'internal_task', due_offset_days: 1, priority: 'high', trigger_mode: 'stage_change', generation_mode: 'manual', execution_type: 'manual',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// PLAYBOOK METADATA
// ─────────────────────────────────────────────────────────────────────────────

const PLAYBOOK_META = {
  prospecting: {
    name: 'GoWarm Sample Playbook — Prospecting',
    type: 'prospecting',
    description: 'A complete 9-stage prospecting playbook covering Target through SAL, with parallel Disqualified and Nurture paths. 42 plays built around the RAL qualification framework.',
    is_default: true,
  },
  sales: {
    name: 'GoWarm Sample Playbook — Sales',
    type: 'sales',
    description: 'A 7-stage sales execution playbook from SAL through Closed Won/Lost, built on the MEDDIC qualification framework. 36 plays covering qualification, demo, commercial negotiation, and contracts.',
    is_default: true,
  },
  clm: {
    name: 'GoWarm Sample Playbook — CLM',
    type: 'clm',
    description: 'A 10-stage contract lifecycle management playbook from Draft through Active, with terminal stages for Voided, Terminated, and Expired contracts. 40 plays including a full renewal management sequence in the Active stage.',
    is_default: true,
  },
  service: {
    name: 'GoWarm Sample Playbook — Service',
    type: 'service',
    description: 'A 5-stage customer service playbook covering case intake, investigation, resolution, and closure. 16 plays designed for B2B SaaS support operations.',
    is_default: true,
  },
  handovers: {
    name: 'GoWarm Sample Playbook — Handovers',
    type: 'handovers',
    description: 'A 5-stage Sales-to-CS handover playbook covering team assignment, stakeholder documentation, commitments recording, go-live planning, and formal sign-off. 15 plays.',
    is_default: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function upsertStages(client, orgId, pipeline) {
  const stages = STAGES[pipeline];
  if (!stages) return;

  for (const s of stages) {
    await client.query(
      `INSERT INTO pipeline_stages
         (org_id, pipeline, key, name, stage_type, sort_order, is_active, is_terminal, is_system, color)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9)
       ON CONFLICT (org_id, pipeline, key)
       DO UPDATE SET
         name       = EXCLUDED.name,
         stage_type = EXCLUDED.stage_type,
         sort_order = EXCLUDED.sort_order,
         is_active  = true,
         is_terminal = EXCLUDED.is_terminal,
         color      = EXCLUDED.color`,
      [orgId, pipeline, s.key, s.name, s.stage_type, s.sort_order, s.is_terminal, s.is_system, s.color]
    );
  }
}

async function createPlaybook(client, orgId, module) {
  const meta = PLAYBOOK_META[module];
  const result = await client.query(
    `INSERT INTO playbooks
       (org_id, name, type, description, is_default, content, enable_ai_actions, track_instances)
     VALUES ($1, $2, $3, $4, $5, '', false, false)
     RETURNING id`,
    [orgId, meta.name, meta.type, meta.description, meta.is_default]
  );
  return result.rows[0].id;
}

async function insertPlays(client, orgId, playbookId, module) {
  const plays = PLAYS[module];
  if (!plays) return;

  for (const p of plays) {
    await client.query(
      `INSERT INTO playbook_plays
         (playbook_id, org_id, stage_key, title, description, suggested_action,
          channel, due_offset_days, priority, is_gate, sort_order,
          trigger_mode, generation_mode, execution_type, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true)`,
      [
        playbookId, orgId, p.stage_key, p.title, p.description, p.suggested_action,
        p.channel, p.due_offset_days, p.priority, p.is_gate, p.sort_order,
        p.trigger_mode, p.generation_mode, p.execution_type,
      ]
    );
  }
}

async function hasBeenSeeded(client, orgId, module) {
  const meta = PLAYBOOK_META[module];
  const result = await client.query(
    `SELECT id FROM playbooks WHERE org_id = $1 AND type = $2 LIMIT 1`,
    [orgId, meta.type]
  );
  return result.rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * seedOrg — called on new org creation.
 * Seeds the Sales pipeline stages + Sales playbook automatically.
 */
async function seedOrg(orgId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Seed Sales pipeline stages
    await upsertStages(client, orgId, 'sales');

    // Seed Sales playbook
    const alreadySeeded = await hasBeenSeeded(client, orgId, 'sales');
    if (!alreadySeeded) {
      const playbookId = await createPlaybook(client, orgId, 'sales');
      await insertPlays(client, orgId, playbookId, 'sales');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[orgSeed] seedOrg failed for org', orgId, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * seedModulePlaybook — called by OrgAdmin when they click "Seed GoWarm Sample Playbook"
 * for a specific module. One-time per module per org.
 *
 * @param {number} orgId
 * @param {string} module — one of: prospecting | sales | clm | service | handovers
 * @returns {{ seeded: boolean, message: string }}
 */
async function seedModulePlaybook(orgId, module) {
  if (!PLAYS[module]) {
    return { seeded: false, message: `Unknown module: ${module}` };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const alreadySeeded = await hasBeenSeeded(client, orgId, module);
    if (alreadySeeded) {
      await client.query('ROLLBACK');
      return { seeded: false, message: `${module} playbook has already been seeded for this organisation.` };
    }

    await upsertStages(client, orgId, module);
    const playbookId = await createPlaybook(client, orgId, module);
    await insertPlays(client, orgId, playbookId, module);

    await client.query('COMMIT');
    return { seeded: true, message: `${module} playbook seeded successfully.` };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[orgSeed] seedModulePlaybook failed for org', orgId, 'module', module, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * getSeedStatus — returns which modules have been seeded for an org.
 *
 * @param {number} orgId
 * @returns {Object} e.g. { prospecting: true, sales: true, clm: false, service: false, handovers: false }
 */
async function getSeedStatus(orgId) {
  const modules = Object.keys(PLAYBOOK_META);
  const result = await pool.query(
    `SELECT type FROM playbooks WHERE org_id = $1 AND type = ANY($2)`,
    [orgId, modules]
  );
  const seededTypes = new Set(result.rows.map(r => r.type));
  return modules.reduce((acc, m) => {
    acc[m] = seededTypes.has(PLAYBOOK_META[m].type);
    return acc;
  }, {});
}

module.exports = { seedOrg, seedModulePlaybook, getSeedStatus };
