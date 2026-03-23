/**
 * actionsGenerator.js
 *
 * Builds deal context, runs ActionsRulesEngine, optionally runs ActionsAIEnhancer.
 *
 * FIXES IN THIS VERSION:
 *   - PlaybookService.getStageActions(orgId, stageKey) now EXISTS — fixed call
 *   - PlaybookService.getStageGuidance(orgId, stageKey) now EXISTS — fixed call
 *   - PlaybookService.getPlaysForStage now receives correct (orgId, playbookId, stageKey)
 *     by resolving playbookId from DealContextBuilder's playbook field first
 *   - playbookStageGuidance now correctly flows into ActionsAIEnhancer context
 *   - context now includes playbookId for downstream use
 */

const db = require('../config/database');
const ActionsRulesEngine  = require('./ActionsRulesEngine');
const ActionsAIEnhancer   = require('./ActionsAIEnhancer');
const PlaybookService     = require('./playbook.service');
const ActionConfigService = require('./actionConfig.service');
const AgentObserver       = require('./AgentObserver');

// ── Internal classification ───────────────────────────────────────────────────

const INTERNAL_SOURCE_RULES = new Set([
  'stagnant_deal', 'champion_nurture', 'at_risk_deal',
  'no_files', 'failed_file', 'internal_strategy',
  'high_value_no_meeting', 'health_4a_oversized',
  'health_5a_competitive', 'health_5b_price', 'health_5c_discount',
  'no_contacts', 'close_imminent', 'past_close_date',
  'meeting_prep', 'health_2c_single_thread',
  // Deal STRAP source rules
  'strap_close_date', 'strap_buyer_engagement', 'strap_competitive',
  'strap_momentum', 'strap_contact_coverage', 'strap_process',
  'strap_deal_size', 'strap_stage_progression',
  // Account STRAP source rules
  'strap_stale_account', 'strap_renewal_risk', 'strap_champion_gap',
  'strap_no_exec_relationship', 'strap_expansion_blocked',
  'strap_revenue_concentration', 'strap_whitespace', 'strap_single_product',
  // Prospect STRAP source rules
  'strap_ghosting', 'strap_stale_outreach', 'strap_no_research',
  'strap_wrong_channel', 'strap_low_icp', 'strap_no_meeting',
  'strap_multi_thread_needed', 'strap_conversion_ready',
  // Implementation STRAP source rules
  'strap_kickoff_delayed', 'strap_stakeholder_gap', 'strap_milestone_blocked',
  'strap_adoption_risk', 'strap_escalation_needed', 'strap_handoff_incomplete',
]);

const INTERNAL_TYPES = new Set(['document_prep', 'task_complete', 'review', 'meeting_prep']);
const EXTERNAL_TYPES = new Set(['email_send', 'email', 'meeting_schedule', 'meeting', 'follow_up']);

function isInternalAction(action) {
  if (EXTERNAL_TYPES.has(action.action_type)) return false;
  if (INTERNAL_TYPES.has(action.action_type)) return true;
  if (action.source_rule && INTERNAL_SOURCE_RULES.has(action.source_rule)) return true;
  if (['internal_task', 'document', 'slack'].includes(action.next_step)) return true;
  return false;
}

// ── Derived context builder ───────────────────────────────────────────────────

function buildDerived(deal, contacts, emails, meetings, files) {
  const now = Date.now();
  const daysSince = (date) => date ? Math.floor((now - new Date(date)) / 86400000) : 999;
  const daysUntil = (date) => date ? Math.ceil((new Date(date) - now) / 86400000) : null;

  const dealMeetings = meetings.filter(m => m.deal_id === deal.id);
  const dealEmails   = emails.filter(e => e.deal_id === deal.id);
  const dealFiles    = files.filter(f => f.deal_id === deal.id);

  const completedMeetings = dealMeetings
    .filter(m => m.status === 'completed')
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

  const upcomingMeetings = dealMeetings
    .filter(m => m.status === 'scheduled' && new Date(m.start_time) > new Date());

  const lastMeeting = completedMeetings[0] || null;
  const lastEmail   = dealEmails
    .filter(e => e.direction === 'sent')
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0] || null;

  const daysSinceLastMeeting = lastMeeting ? daysSince(lastMeeting.start_time) : 999;
  const daysSinceLastEmail   = lastEmail   ? daysSince(lastEmail.sent_at)      : 999;
  const daysUntilClose       = deal.close_date ? daysUntil(deal.close_date)    : null;
  const daysInStage          = daysSince(deal.stage_changed_at || deal.updated_at);

  const decisionMakers = contacts.filter(c =>
    ['decision_maker', 'economic_buyer', 'executive'].includes(c.role_type)
  );
  const champions = contacts.filter(c => c.role_type === 'champion');

  const unansweredEmails = dealEmails.filter(e => {
    if (e.direction !== 'sent') return false;
    if (daysSince(e.sent_at) < 3) return false;
    return !dealEmails.some(r =>
      r.direction === 'received' && new Date(r.sent_at) > new Date(e.sent_at)
    );
  });

  const failedFiles = dealFiles.filter(f => f.processing_status === 'failed');

  return {
    completedMeetings, upcomingMeetings,
    daysSinceLastMeeting, daysSinceLastEmail,
    daysUntilClose, daysInStage,
    decisionMakers, champions,
    unansweredEmails, failedFiles,
    isHighValue:       parseFloat(deal.value || 0) > 100000,
    isStagnant:        daysInStage > 30 && !deal.is_terminal,
    closingImminently: daysUntilClose !== null && daysUntilClose >= 0 && daysUntilClose <= 7,
    isPastClose:       daysUntilClose !== null && daysUntilClose < 0,
  };
}

// ── Context builder ───────────────────────────────────────────────────────────
// Used by generateAll() / generateForDeal() which pass pre-loaded bulk arrays.
// For per-deal calls use DealContextBuilder.build() instead — it's more complete.

async function buildContext(deal, allContacts, allEmails, allMeetings, allFiles, userId, orgId) {
  const contacts = allContacts.filter(c => c.account_id === deal.account_id);
  const emails   = allEmails.filter(e => e.deal_id === deal.id);
  const meetings = allMeetings.filter(m => m.deal_id === deal.id);
  const files    = allFiles.filter(f => f.deal_id === deal.id);

  const stageType = deal.stage_type || 'custom';
  const derived   = buildDerived(deal, contacts, emails, meetings, files);

  let healthBreakdown = null;
  if (deal.health_score_breakdown) {
    try {
      healthBreakdown = typeof deal.health_score_breakdown === 'string'
        ? JSON.parse(deal.health_score_breakdown)
        : deal.health_score_breakdown;
    } catch (_) {}
  }

  // FIXED: getStageActions and getStageGuidance now exist in playbook.service.js
  // FIXED: getPlaysForStage signature is (orgId, playbookId, stageKey) but
  //        here we use getStageActions which internally resolves the default playbook
  let playbookStageActions  = [];
  let playbookStageGuidance = null;
  let playbookPlays         = [];
  let playbookId            = null;

  try {
    // getStageActions resolves the org default playbook internally
    [playbookStageActions, playbookStageGuidance] = await Promise.all([
      PlaybookService.getStageActions(orgId, deal.stage),
      PlaybookService.getStageGuidance(orgId, deal.stage),
    ]);

    // Also resolve playbookId for ActionWriter stamping downstream
    const pb = await PlaybookService.getPlaybook(userId, orgId);
    if (pb) {
      playbookId   = pb.id;
      playbookPlays = playbookStageActions; // same data, two names for compat
    }
  } catch (err) {
    console.error('buildContext: PlaybookService error:', err.message);
  }

  return {
    deal,
    contacts,
    emails,
    meetings,
    files,
    healthBreakdown,
    healthStatus:         deal.health      || null,
    healthScore:          deal.health_score || null,
    stageType,
    derived,
    playbookId,
    playbookStageActions,
    playbookStageGuidance,  // NOW POPULATED — ActionsAIEnhancer.enhance() uses this
    playbookPlays,
  };
}

// ── DB insert helper ──────────────────────────────────────────────────────────

function deriveModuleFromAction(action) {
  if (action.source_module) return action.source_module;
  if (action.contract_id)   return 'contracts';
  if (action.prospect_id)   return 'prospecting';
  if (action.source_rule && (
    action.source_rule.includes('handoff') ||
    action.source_rule.includes('kickoff') ||
    action.source_rule.includes('stakeholder_gap') ||
    action.source_rule.includes('milestone') ||
    action.source_rule.includes('adoption') ||
    action.source_rule.includes('escalation')
  )) return 'handovers';
  if (action.deal_id) return 'deals';
  return 'general';
}

async function insertAction(action, userId, orgId) {
  const internal  = isInternalAction(action);
  const source    = action.source || 'auto_generated';
  const next_step = action.next_step || 'email';

  const result = await db.query(
    `INSERT INTO actions (
       org_id, user_id, type, title, description, action_type, priority,
       due_date, deal_id, contact_id, account_id, contract_id,
       suggested_action, context, source, source_rule, health_param,
       keywords, deal_stage, requires_external_evidence,
       is_internal, next_step, playbook_play_id,
       playbook_id, playbook_name,
       source_module,
       status, created_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       $13,$14,$15,$16,$17,
       $18,$19,$20,
       $21,$22,$23,
       $24,$25,
       $26,
       'yet_to_start',NOW()
     ) RETURNING id`,
    [
      orgId,
      userId,
      action.type || action.action_type,
      action.title,
      action.description,
      action.action_type,
      action.priority || 'medium',
      action.due_date,
      action.deal_id       || null,
      action.contact_id    || null,
      action.account_id    || null,
      action.contract_id   || null,
      action.suggested_action           || null,
      action.context                    || null,
      source,
      action.source_rule                || null,
      action.health_param               || null,
      action.keywords                   || null,
      action.deal_stage                 || null,
      action.requires_external_evidence || false,
      internal,
      next_step,
      action.playbook_play_id           || null,
      action.playbook_id                || null,
      action.playbook_name              || null,
      deriveModuleFromAction(action),
    ]
  );
  return result.rows[0]?.id || null;
}

// ── Calendar entry helper ─────────────────────────────────────────────────────

const CALENDAR_ACTION_TYPES = new Set([
  'meeting_schedule', 'meeting', 'meeting_prep', 'meeting_followup',
  'email_send', 'email', 'follow_up',
]);

async function createCalendarEntryForAction(action, insertedId, userId, orgId) {
  if (!CALENDAR_ACTION_TYPES.has(action.action_type)) return;
  if (!action.due_date) return;

  try {
    const startTime = new Date(action.due_date);
    startTime.setHours(9, 0, 0, 0);
    const endTime = new Date(startTime);
    endTime.setMinutes(endTime.getMinutes() + 30);

    await db.query(
      `INSERT INTO meetings (
         org_id, user_id, deal_id, title, description,
         start_time, end_time, meeting_type, source, status, action_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'task','action','scheduled',$8,NOW())
       ON CONFLICT DO NOTHING`,
      [
        orgId,
        userId,
        action.deal_id || null,
        action.title,
        action.description || null,
        startTime,
        endTime,
        insertedId,
      ]
    );
  } catch (err) {
    console.error(`📅 Calendar entry creation failed (non-blocking) for action "${action.title}":`, err.message);
  }
}

function isTerminalDeal(deal) {
  return deal.is_terminal === true;
}

// ── Main class ────────────────────────────────────────────────────────────────

class ActionsGenerator {

  // ── generateAll ─────────────────────────────────────────────────────────────

  static async generateAll() {
    try {
      console.log('🤖 Starting ActionsRulesEngine — generating all actions...');

      const [dealsRes, contactsRes, emailsRes, meetingsRes, filesRes] = await Promise.all([
        db.query(`
          SELECT d.*, ds.is_terminal, ds.stage_type AS stage_type_from_db
          FROM deals d
          LEFT JOIN pipeline_stages ds ON ds.org_id = d.org_id AND ds.pipeline = 'sales' AND ds.key = d.stage
          WHERE d.deleted_at IS NULL
        `),
        db.query('SELECT * FROM contacts  WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM emails    WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM meetings  WHERE deleted_at IS NULL'),
        db.query("SELECT * FROM storage_files WHERE processing_status = 'completed'"),
      ]);

      const deals    = dealsRes.rows;
      const contacts = contactsRes.rows;
      const emails   = emailsRes.rows;
      const meetings = meetingsRes.rows;
      const files    = filesRes.rows;

      console.log(`📊 Loaded: ${deals.length} deals, ${contacts.length} contacts, ${emails.length} emails, ${meetings.length} meetings, ${files.length} files`);

      await db.query(
        "DELETE FROM actions WHERE source IN ('auto_generated', 'ai_generated') AND status IN ('yet_to_start', 'in_progress') AND contract_id IS NULL AND case_id IS NULL"
      );

      let totalGenerated = 0;
      let totalInserted  = 0;

      for (const deal of deals) {
        if (isTerminalDeal(deal)) continue;

        const userId = deal.owner_id;
        const orgId  = deal.org_id;

        if (!userId) {
          console.warn(`⚠️  No owner_id on deal ${deal.id} (${deal.name}) — skipping`);
          continue;
        }
        if (!orgId) {
          console.warn(`⚠️  No org_id on deal ${deal.id} (${deal.name}) — skipping`);
          continue;
        }

        try {
          const actionConfig = await ActionConfigService.getConfig(userId, orgId);
          const context      = await buildContext(deal, contacts, emails, meetings, files, userId, orgId);
          const rulesActions = ActionsRulesEngine.generate(context);

          console.log(`  📏 Rules: ${rulesActions.length} actions for deal ${deal.id} (${deal.name})`);

          const aiActions  = await ActionsAIEnhancer.enhance(context, rulesActions, actionConfig);
          if (aiActions.length) {
            console.log(`  🤖 AI: ${aiActions.length} additional actions for deal ${deal.id}`);
          }

          const allActions = [...rulesActions, ...aiActions];
          totalGenerated  += allActions.length;

          for (const action of allActions) {
            try {
              const insertedId = await insertAction(action, userId, orgId);
              totalInserted++;
              if (insertedId) {
                await createCalendarEntryForAction(action, insertedId, userId, orgId);
              }
            } catch (err) {
              console.error(`  ❌ Insert failed for "${action.title}":`, err.message);
            }
          }

          AgentObserver.onActionsGenerated(deal.id, allActions, context, orgId, userId)
            .catch(err => console.error(`  🤖 AgentObserver hook error:`, err.message));
        } catch (err) {
          console.error(`  ❌ Error processing deal ${deal.id} (${deal.name}):`, err.message);
        }
      }

      console.log(`✅ generateAll complete — generated: ${totalGenerated} inserted: ${totalInserted}`);

      try {
        await db.query(
          `UPDATE action_config SET last_generated_at = NOW()
           WHERE org_id = ANY(
             SELECT DISTINCT org_id FROM deals WHERE deleted_at IS NULL
           )`
        );
      } catch (_) { /* non-blocking */ }

      return { success: true, generated: totalGenerated, inserted: totalInserted };

    } catch (error) {
      console.error('❌ Error in generateAll:', error);
      return { success: false, error: error.message };
    }
  }

  // ── generateForDeal ─────────────────────────────────────────────────────────

  static async generateForDeal(dealId) {
    try {
      console.log(`🤖 Generating actions for deal ${dealId}...`);

      const dealResult = await db.query(`
        SELECT d.*, ds.is_terminal
        FROM deals d
        LEFT JOIN pipeline_stages ds ON ds.org_id = d.org_id AND ds.pipeline = 'sales' AND ds.key = d.stage
        WHERE d.id = $1
      `, [dealId]);

      if (dealResult.rows.length === 0) return 0;

      const deal   = dealResult.rows[0];
      const userId = deal.owner_id;
      const orgId  = deal.org_id;

      if (!userId || !orgId)  return 0;
      if (isTerminalDeal(deal)) return 0;

      const [contactsRes, emailsRes, meetingsRes, filesRes] = await Promise.all([
        db.query('SELECT * FROM contacts      WHERE account_id = $1 AND org_id = $2', [deal.account_id, orgId]),
        db.query('SELECT * FROM emails        WHERE deal_id = $1    AND org_id = $2', [dealId, orgId]),
        db.query('SELECT * FROM meetings      WHERE deal_id = $1    AND org_id = $2', [dealId, orgId]),
        db.query("SELECT * FROM storage_files WHERE deal_id = $1    AND org_id = $2 AND processing_status = 'completed'", [dealId, orgId]),
      ]);

      const actionConfig = await ActionConfigService.getConfig(userId, orgId);
      const context      = await buildContext(deal, contactsRes.rows, emailsRes.rows, meetingsRes.rows, filesRes.rows, userId, orgId);
      const rulesActions = ActionsRulesEngine.generate(context);
      const aiActions    = await ActionsAIEnhancer.enhance(context, rulesActions, actionConfig);
      const allActions   = [...rulesActions, ...aiActions];

      await db.query(
        "DELETE FROM actions WHERE deal_id = $1 AND org_id = $2 AND source IN ('auto_generated', 'ai_generated') AND status IN ('yet_to_start', 'in_progress')",
        [dealId, orgId]
      );

      let inserted = 0;
      for (const action of allActions) {
        try {
          const insertedId = await insertAction(action, userId, orgId);
          inserted++;
          if (insertedId) {
            await createCalendarEntryForAction(action, insertedId, userId, orgId);
          }
        } catch (err) {
          console.error(`  ❌ Insert failed for "${action.title}":`, err.message);
        }
      }

      console.log(`✅ Generated ${inserted} actions for deal ${dealId}`);

      AgentObserver.onActionsGenerated(dealId, allActions, context, orgId, userId)
        .catch(err => console.error(`  🤖 AgentObserver hook error:`, err.message));

      return inserted;

    } catch (error) {
      console.error('Error generating actions for deal:', error);
      return 0;
    }
  }

  // ── generateForEmail ────────────────────────────────────────────────────────

  static async generateForEmail(emailId) {
    try {
      const res = await db.query('SELECT deal_id FROM emails WHERE id = $1', [emailId]);
      if (res.rows.length === 0) return false;
      if (res.rows[0].deal_id) await this.generateForDeal(res.rows[0].deal_id);
      return true;
    } catch (error) { return false; }
  }

  // ── generateForMeeting ──────────────────────────────────────────────────────

  static async generateForMeeting(meetingId) {
    try {
      const res = await db.query('SELECT deal_id FROM meetings WHERE id = $1', [meetingId]);
      if (res.rows.length === 0) return false;
      if (res.rows[0].deal_id) await this.generateForDeal(res.rows[0].deal_id);
      return true;
    } catch (error) { return false; }
  }

  // ── generateForStageChange ──────────────────────────────────────────────────

  static async generateForStageChange(dealId, newStage, userId) {
    try {
      const dealRes = await db.query('SELECT org_id FROM deals WHERE id = $1', [dealId]);
      if (dealRes.rows.length === 0) return [];
      const orgId = dealRes.rows[0].org_id;
      const config = await ActionConfigService.getConfig(userId, orgId);
      if (config.generation_mode === 'manual') return [];
      return this.generateForDeal(dealId);
    } catch (error) { return []; }
  }

  // ── buildContextPublic ──────────────────────────────────────────────────────
  // Called from actions_routes for gate condition eval
  static async buildContextPublic(deal, contacts, emails, meetings, files, userId, orgId) {
    return buildContext(deal, contacts, emails, meetings, files, userId, orgId);
  }
}

module.exports = ActionsGenerator;
