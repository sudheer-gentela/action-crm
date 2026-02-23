/**
 * actionsGenerator.js
 *
 * Builds deal context, runs ActionsRulesEngine, optionally runs ActionsAIEnhancer.
 *
 * Changes from previous version:
 *   - buildContext now fetches playbookStageGuidance (full guidance object)
 *     in addition to playbookStageActions, and passes both into context.
 *   - deal.stage_type is read from the deals table (backfilled by migration
 *     trigger) and passed through context so rules engine + AI enhancer
 *     can use semantic type instead of stage name.
 *   - generateAll / generateForDeal terminal-stage guard uses is_terminal
 *     from deal_stages instead of a hardcoded string list.
 *   - org_id is always derived from deal.org_id — never trusted from the caller.
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

async function buildContext(deal, allContacts, allEmails, allMeetings, allFiles, userId) {
  const contacts = allContacts.filter(c => c.account_id === deal.account_id);
  const emails   = allEmails.filter(e => e.deal_id === deal.id);
  const meetings = allMeetings.filter(m => m.deal_id === deal.id);
  const files    = allFiles.filter(f => f.deal_id === deal.id);

  // stage_type is stored on the deal row (backfilled by migration, kept in sync
  // by the trg_sync_deal_stage_type trigger). Fall back to 'custom' if missing.
  const stageType = deal.stage_type || 'custom';

  const derived = buildDerived(deal, contacts, emails, meetings, files);

  let healthBreakdown = null;
  if (deal.health_score_breakdown) {
    try {
      healthBreakdown = typeof deal.health_score_breakdown === 'string'
        ? JSON.parse(deal.health_score_breakdown)
        : deal.health_score_breakdown;
    } catch (_) {}
  }

  // Fetch both key_actions and full guidance using the stage KEY (deal.stage),
  // not stage_type. Each stage gets its own guidance even if multiple stages
  // share the same stage_type. stageType is still passed in context for the
  // AI Enhancer prompt label — it is not used for guidance lookup.
  let playbookStageActions  = [];
  let playbookStageGuidance = null;
  try {
    [playbookStageActions, playbookStageGuidance] = await Promise.all([
      PlaybookService.getStageActions(userId, deal.stage),
      PlaybookService.getStageGuidance(userId, deal.stage),
    ]);
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
    stageType,                                        // ← semantic type for AI Enhancer
    derived,
    playbookStageActions,
    playbookStageGuidance,                            // ← full guidance for _fileRules etc.
  };
}

// ── DB insert helper ──────────────────────────────────────────────────────────

async function insertAction(action, userId, orgId) {
  const internal  = isInternalAction(action);
  const source    = action.source || 'auto_generated';
  const next_step = action.next_step || 'email';

  await db.query(
    `INSERT INTO actions (
       org_id, user_id, type, title, description, action_type, priority,
       due_date, deal_id, contact_id, account_id,
       suggested_action, context, source, source_rule, health_param,
       keywords, deal_stage, requires_external_evidence,
       is_internal, next_step, status, created_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
       $12,$13,$14,$15,$16,
       $17,$18,$19,
       $20,$21,'yet_to_start',NOW()
     )`,
    [
      orgId,
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

// ── Terminal stage check ──────────────────────────────────────────────────────
// Reads from deal_stages so org-specific terminal stages are respected.
// Falls back to the is_terminal flag stored on the deal row (set by trigger).

function isTerminalDeal(deal) {
  // is_terminal is joined in by generateAll's query
  return deal.is_terminal === true;
}

// ── Main class ────────────────────────────────────────────────────────────────

class ActionsGenerator {

  // ── generateAll ─────────────────────────────────────────────────────────────

  static async generateAll() {
    try {
      console.log('🤖 Starting ActionsRulesEngine — generating all actions...');

      // Join deal_stages to get is_terminal flag — avoids hardcoded stage name list
      const [dealsRes, contactsRes, emailsRes, meetingsRes, filesRes] = await Promise.all([
        db.query(`
          SELECT d.*, ds.is_terminal, ds.stage_type AS stage_type_from_db
          FROM deals d
          LEFT JOIN deal_stages ds ON ds.org_id = d.org_id AND ds.key = d.stage
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
        "DELETE FROM actions WHERE source IN ('auto_generated', 'ai_generated') AND status IN ('yet_to_start', 'in_progress')"
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
          const context      = await buildContext(deal, contacts, emails, meetings, files, userId);
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
              await insertAction(action, userId, orgId);
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

  // ── generateForDeal ─────────────────────────────────────────────────────────

  static async generateForDeal(dealId) {
    try {
      console.log(`🤖 Generating actions for deal ${dealId}...`);

      const dealResult = await db.query(`
        SELECT d.*, ds.is_terminal
        FROM deals d
        LEFT JOIN deal_stages ds ON ds.org_id = d.org_id AND ds.key = d.stage
        WHERE d.id = $1
      `, [dealId]);

      if (dealResult.rows.length === 0) return 0;

      const deal   = dealResult.rows[0];
      const userId = deal.owner_id;
      const orgId  = deal.org_id;

      if (!userId || !orgId)  return 0;
      if (isTerminalDeal(deal)) return 0;

      const [contactsRes, emailsRes, meetingsRes, filesRes] = await Promise.all([
        db.query('SELECT * FROM contacts      WHERE account_id = $1 AND org_id = $2',                       [deal.account_id, orgId]),
        db.query('SELECT * FROM emails        WHERE deal_id = $1    AND org_id = $2',                       [dealId, orgId]),
        db.query('SELECT * FROM meetings      WHERE deal_id = $1    AND org_id = $2',                       [dealId, orgId]),
        db.query("SELECT * FROM storage_files WHERE deal_id = $1    AND org_id = $2 AND processing_status = 'completed'", [dealId, orgId]),
      ]);

      const actionConfig = await ActionConfigService.getConfig(userId, orgId);
      const context      = await buildContext(deal, contactsRes.rows, emailsRes.rows, meetingsRes.rows, filesRes.rows, userId);
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
          await insertAction(action, userId, orgId);
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
}

module.exports = ActionsGenerator;
