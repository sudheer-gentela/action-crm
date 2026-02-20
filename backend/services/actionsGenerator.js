/**
 * Actions Generator Service
 * Builds deal context, runs ActionsRulesEngine, optionally runs ActionsAIEnhancer.
 * Inserts next_step as a first-class column on every action.
 */

const db = require('../config/database');
const ActionsRulesEngine  = require('./ActionsRulesEngine');
const ActionsAIEnhancer   = require('./ActionsAIEnhancer');
const PlaybookService     = require('./playbook.service');
const ActionConfigService = require('./actionConfig.service');

// ── Internal classification ───────────────────────────────────────────────────

const INTERNAL_SOURCE_RULES = new Set([
  'stagnant_deal', 'champion_nurture', 'at_risk_deal',
  'no_files', 'failed_file', 'internal_strategy',
  'high_value_no_meeting', 'health_4a_oversized',
  'health_5a_competitive', 'health_5b_price', 'health_5c_discount',
  'no_contacts', 'close_imminent', 'past_close_date',
  'meeting_prep', 'health_2c_single_thread',
]);

const INTERNAL_TYPES = new Set(['document_prep', 'task_complete', 'review', 'meeting_prep']);
const EXTERNAL_TYPES = new Set(['email_send', 'email', 'meeting_schedule', 'meeting', 'follow_up']);

function isInternalAction(action) {
  if (EXTERNAL_TYPES.has(action.action_type)) return false;
  if (INTERNAL_TYPES.has(action.action_type)) return true;
  if (action.source_rule && INTERNAL_SOURCE_RULES.has(action.source_rule)) return true;
  // internal_task and document next_steps are always internal
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
    isStagnant:        daysInStage > 30 && !['closed_won', 'closed_lost'].includes(deal.stage),
    closingImminently: daysUntilClose !== null && daysUntilClose >= 0 && daysUntilClose <= 7,
    isPastClose:       daysUntilClose !== null && daysUntilClose < 0,
  };
}

async function buildContext(deal, allContacts, allEmails, allMeetings, allFiles, userId) {
  const contacts = allContacts.filter(c => c.account_id === deal.account_id);
  const emails   = allEmails.filter(e => e.deal_id === deal.id);
  const meetings = allMeetings.filter(m => m.deal_id === deal.id);
  const files    = allFiles.filter(f => f.deal_id === deal.id);
  const derived  = buildDerived(deal, contacts, emails, meetings, files);

  let healthBreakdown = null;
  if (deal.health_score_breakdown) {
    try {
      healthBreakdown = typeof deal.health_score_breakdown === 'string'
        ? JSON.parse(deal.health_score_breakdown)
        : deal.health_score_breakdown;
    } catch (_) {}
  }

  let playbookStageActions = [];
  try {
    playbookStageActions = await PlaybookService.getStageActions(userId, deal.stage);
  } catch (_) {}

  return {
    deal, contacts, emails, meetings, files,
    healthBreakdown,
    healthStatus:        deal.health || null,
    derived,
    playbookStageActions,
  };
}

// ── DB insert helper ──────────────────────────────────────────────────────────

async function insertAction(action, userId) {
  const internal  = isInternalAction(action);
  const source    = action.source || 'auto_generated';
  const next_step = action.next_step || 'email';

  await db.query(
    `INSERT INTO actions (
       user_id, type, title, description, action_type, priority,
       due_date, deal_id, contact_id, account_id,
       suggested_action, context, source, source_rule, health_param,
       keywords, deal_stage, requires_external_evidence,
       is_internal, next_step, status, created_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,
       $16,$17,$18,
       $19,$20,'yet_to_start',NOW()
     )`,
    [
      userId,
      action.type || action.action_type,
      action.title,
      action.description,
      action.action_type,
      action.priority || 'medium',
      action.due_date,
      action.deal_id    || null,
      action.contact_id || null,
      action.account_id || null,
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
    ]
  );
}

// ── Main class ────────────────────────────────────────────────────────────────

class ActionsGenerator {

  static async generateAll() {
    try {
      console.log('🤖 Starting ActionsRulesEngine — generating all actions...');

      const [dealsRes, contactsRes, emailsRes, meetingsRes, filesRes] = await Promise.all([
        db.query('SELECT * FROM deals         WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM contacts      WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM emails        WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM meetings      WHERE deleted_at IS NULL'),
        db.query("SELECT * FROM storage_files WHERE processing_status = 'completed'"),
      ]);

      const deals    = dealsRes.rows;
      const contacts = contactsRes.rows;
      const emails   = emailsRes.rows;
      const meetings = meetingsRes.rows;
      const files    = filesRes.rows;

      console.log(`📊 Loaded: ${deals.length} deals, ${contacts.length} contacts, ${emails.length} emails, ${meetings.length} meetings, ${files.length} files`);

      await db.query(
        "DELETE FROM actions WHERE source IN ('auto_generated', 'ai_generated') AND status IN ('yet_to_start', 'in_progress')"
      );

      let totalGenerated = 0;
      let totalInserted  = 0;

      for (const deal of deals) {
        if (['closed_won', 'closed_lost'].includes(deal.stage)) continue;

        const userId = deal.owner_id;
        if (!userId) {
          console.warn(`⚠️  No owner_id on deal ${deal.id} (${deal.name}) — skipping`);
          continue;
        }

        try {
          // Resolve action config for this deal's owner (for AI gate)
          const actionConfig = await ActionConfigService.getConfig(userId);

          const context      = await buildContext(deal, contacts, emails, meetings, files, userId);
          const rulesActions = ActionsRulesEngine.generate(context);

          console.log(`  📏 Rules: ${rulesActions.length} actions for deal ${deal.id} (${deal.name})`);

          // Run AI enhancer if enabled
          const aiActions = await ActionsAIEnhancer.enhance(context, rulesActions, actionConfig);
          if (aiActions.length) {
            console.log(`  🤖 AI: ${aiActions.length} additional actions for deal ${deal.id}`);
          }

          const allActions = [...rulesActions, ...aiActions];
          totalGenerated += allActions.length;

          for (const action of allActions) {
            try {
              await insertAction(action, userId);
              totalInserted++;
            } catch (err) {
              console.error(`  ❌ Insert failed for "${action.title}":`, err.message);
            }
          }
        } catch (err) {
          console.error(`  ❌ Error processing deal ${deal.id} (${deal.name}):`, err.message);
        }
      }

      console.log(`✅ generateAll complete — generated: ${totalGenerated} inserted: ${totalInserted}`);
      return { success: true, generated: totalGenerated, inserted: totalInserted };

    } catch (error) {
      console.error('❌ Error in generateAll:', error);
      return { success: false, error: error.message };
    }
  }

  static async generateForDeal(dealId) {
    try {
      console.log(`🤖 Generating actions for deal ${dealId}...`);

      const dealResult = await db.query('SELECT * FROM deals WHERE id = $1', [dealId]);
      if (dealResult.rows.length === 0) return 0;

      const deal   = dealResult.rows[0];
      const userId = deal.owner_id;
      if (!userId) return 0;

      const [contactsRes, emailsRes, meetingsRes, filesRes] = await Promise.all([
        db.query('SELECT * FROM contacts      WHERE account_id = $1',                         [deal.account_id]),
        db.query('SELECT * FROM emails        WHERE deal_id = $1',                            [dealId]),
        db.query('SELECT * FROM meetings      WHERE deal_id = $1',                            [dealId]),
        db.query("SELECT * FROM storage_files WHERE deal_id = $1 AND processing_status = 'completed'", [dealId]),
      ]);

      const actionConfig = await ActionConfigService.getConfig(userId);
      const context      = await buildContext(deal, contactsRes.rows, emailsRes.rows, meetingsRes.rows, filesRes.rows, userId);
      const rulesActions = ActionsRulesEngine.generate(context);
      const aiActions    = await ActionsAIEnhancer.enhance(context, rulesActions, actionConfig);
      const allActions   = [...rulesActions, ...aiActions];

      await db.query(
        "DELETE FROM actions WHERE deal_id = $1 AND source IN ('auto_generated', 'ai_generated') AND status IN ('yet_to_start', 'in_progress')",
        [dealId]
      );

      let inserted = 0;
      for (const action of allActions) {
        try {
          await insertAction(action, userId);
          inserted++;
        } catch (err) {
          console.error(`  ❌ Insert failed for "${action.title}":`, err.message);
        }
      }

      console.log(`✅ Generated ${inserted} actions for deal ${dealId}`);
      return inserted;

    } catch (error) {
      console.error('Error generating actions for deal:', error);
      return 0;
    }
  }

  static async generateForEmail(emailId) {
    try {
      const res = await db.query('SELECT * FROM emails WHERE id = $1', [emailId]);
      if (res.rows.length === 0) return false;
      if (res.rows[0].deal_id) await this.generateForDeal(res.rows[0].deal_id);
      return true;
    } catch (error) { return false; }
  }

  static async generateForMeeting(meetingId) {
    try {
      const res = await db.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
      if (res.rows.length === 0) return false;
      if (res.rows[0].deal_id) await this.generateForDeal(res.rows[0].deal_id);
      return true;
    } catch (error) { return false; }
  }

  static async generateForStageChange(dealId, newStage, userId) {
    try {
      const config = await ActionConfigService.getConfig(userId);
      if (config.generation_mode === 'manual') return [];
      return this.generateForDeal(dealId);
    } catch (error) { return []; }
  }
}

module.exports = ActionsGenerator;
