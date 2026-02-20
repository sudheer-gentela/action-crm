/**
 * Actions Generator Service
 * Generates actions for all deals, contacts, emails, meetings.
 * Now sets: source_rule, health_param, is_internal on each inserted action.
 */

const db = require('../config/database');
const ActionsEngine = require('./ActionsEngine');
const PlaybookService = require('./playbook.service');
const ActionConfigService = require('./actionConfig.service');

// Rules that produce internal actions (no direct customer contact required)
const INTERNAL_RULES = new Set([
  'stagnant_deal',
  'champion_nurture',
  'at_risk_deal',
  'no_files',
  'no_proposal_doc',
  'internal_strategy',
  'high_value_no_meeting',
  'no_meeting_14d',
  'close_date_review',
]);

// Types that are always internal regardless of rule
const INTERNAL_TYPES = new Set(['review', 'document_prep', 'meeting_prep']);

// Types that are always external (customer-facing)
const EXTERNAL_TYPES = new Set(['email_send', 'email', 'meeting_schedule', 'meeting']);

function isInternalAction(action) {
  if (EXTERNAL_TYPES.has(action.action_type)) return false;
  if (INTERNAL_TYPES.has(action.action_type)) return true;
  if (action.source_rule && INTERNAL_RULES.has(action.source_rule)) return true;
  return false;
}

class ActionsGenerator {

  static async generateAll() {
    try {
      console.log('🤖 Starting ActionsEngine - Generating all actions...');

      const [dealsRes, contactsRes, emailsRes, meetingsRes, accountsRes] = await Promise.all([
        db.query('SELECT * FROM deals WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM contacts WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM emails WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM meetings WHERE deleted_at IS NULL'),
        db.query('SELECT * FROM accounts WHERE deleted_at IS NULL'),
      ]);

      const deals    = dealsRes.rows;
      const contacts = contactsRes.rows;
      const emails   = emailsRes.rows;
      const meetings = meetingsRes.rows;
      const accounts = accountsRes.rows;

      console.log(`📊 Data loaded: ${deals.length} deals, ${contacts.length} contacts, ${emails.length} emails, ${meetings.length} meetings`);

      const generatedActions = ActionsEngine.generateActions({ deals, contacts, emails, meetings, accounts });
      console.log(`✅ ActionsEngine generated ${generatedActions.length} actions`);

      // Delete old auto-generated actions (re-generated fresh each run)
      await db.query("DELETE FROM actions WHERE source = 'auto_generated'");

      let insertedCount = 0;
      for (const action of generatedActions) {
        try {
          let userId = null;
          if (action.deal_id) {
            const deal = deals.find(d => d.id === action.deal_id);
            userId = deal?.owner_id;
          } else if (action.contact_id) {
            const contact = contacts.find(c => c.id === action.contact_id);
            if (contact?.account_id) {
              const account = accounts.find(a => a.id === contact.account_id);
              userId = account?.owner_id;
            }
          } else if (action.account_id) {
            const account = accounts.find(a => a.id === action.account_id);
            userId = account?.owner_id;
          }

          if (!userId) {
            console.error('❌ SKIPPING: No userId found for action:', action.title);
            continue;
          }

          const internal = isInternalAction(action);

          await db.query(
            `INSERT INTO actions (
               user_id, type, title, description, action_type, priority,
               due_date, deal_id, contact_id, account_id,
               suggested_action, source, source_rule, health_param,
               is_internal, status, created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'yet_to_start',NOW())
             RETURNING id`,
            [
              userId,
              action.action_type,
              action.title,
              action.description,
              action.action_type,
              action.priority,
              action.due_date,
              action.deal_id    || null,
              action.contact_id || null,
              action.account_id || null,
              action.suggested_action || null,
              'auto_generated',
              action.source_rule  || null,
              action.health_param || null,
              internal,
            ]
          );
          insertedCount++;
        } catch (error) {
          console.error('❌ Error inserting action:', error.message, action.title);
        }
      }

      console.log(`✅ generateAll complete — generated: ${generatedActions.length} inserted: ${insertedCount} skipped: 0`);
      return { success: true, generated: generatedActions.length, inserted: insertedCount };

    } catch (error) {
      console.error('❌ Error generating actions:', error);
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

      const [contactsRes, emailsRes, meetingsRes] = await Promise.all([
        db.query('SELECT * FROM contacts WHERE account_id = $1', [deal.account_id]),
        db.query('SELECT * FROM emails WHERE deal_id = $1', [dealId]),
        db.query('SELECT * FROM meetings WHERE deal_id = $1', [dealId]),
      ]);

      const generatedActions = ActionsEngine.generateActions({
        deals:    [deal],
        contacts: contactsRes.rows,
        emails:   emailsRes.rows,
        meetings: meetingsRes.rows,
        accounts: [],
      });

      const dealActions = generatedActions.filter(a => a.deal_id === dealId);

      await db.query(
        "DELETE FROM actions WHERE deal_id = $1 AND source = 'auto_generated'",
        [dealId]
      );

      for (const action of dealActions) {
        const internal = isInternalAction(action);
        await db.query(
          `INSERT INTO actions (
             user_id, type, title, description, action_type, priority,
             due_date, deal_id, contact_id, account_id,
             suggested_action, source, source_rule, health_param,
             is_internal, status, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'yet_to_start',NOW())`,
          [
            userId, action.action_type, action.title, action.description,
            action.action_type, action.priority, action.due_date,
            action.deal_id||null, action.contact_id||null, action.account_id||null,
            action.suggested_action||null, 'auto_generated',
            action.source_rule||null, action.health_param||null, internal,
          ]
        );
      }

      console.log(`✅ Generated ${dealActions.length} actions for deal ${dealId}`);
      return dealActions.length;

    } catch (error) {
      console.error('Error generating actions for deal:', error);
      return 0;
    }
  }

  static async generateForEmail(emailId) {
    try {
      const emailResult = await db.query('SELECT * FROM emails WHERE id = $1', [emailId]);
      if (emailResult.rows.length === 0) return false;
      const email = emailResult.rows[0];
      if (email.deal_id) await this.generateForDeal(email.deal_id);
      return true;
    } catch (error) {
      console.error('Error generating actions for email:', error);
      return false;
    }
  }

  static async generateForMeeting(meetingId) {
    try {
      const meetingResult = await db.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
      if (meetingResult.rows.length === 0) return false;
      const meeting = meetingResult.rows[0];
      if (meeting.deal_id) await this.generateForDeal(meeting.deal_id);
      return true;
    } catch (error) {
      console.error('Error generating actions for meeting:', error);
      return false;
    }
  }

  static async generateForStageChange(dealId, newStage, userId) {
    try {
      const config = await ActionConfigService.getConfig(userId);
      if (config.generation_mode === 'manual') return [];
      if (config.generation_mode === 'playbook') return this.generateFromPlaybook(dealId, newStage, userId, config);
      if (config.generation_mode === 'rules') return this.generateForDeal(dealId);
      return [];
    } catch (error) {
      console.error('Error generating actions for stage change:', error);
      return [];
    }
  }

  static async generateFromPlaybook(dealId, newStage, userId, config) {
    try {
      const keyActions = await PlaybookService.getStageActions(userId, newStage);
      if (keyActions.length === 0) return [];

      const dealResult = await db.query('SELECT * FROM deals WHERE id = $1', [dealId]);
      const deal = dealResult.rows[0];
      if (!deal) return [];

      const actions = [];
      for (const actionText of keyActions) {
        const actionType     = PlaybookService.classifyActionType(actionText);
        const keywords       = PlaybookService.extractKeywords(actionText);
        const requiresExt    = PlaybookService.requiresExternalEvidence(actionType, actionText);
        const priority       = PlaybookService.suggestPriority(newStage, actionType);
        const dueDays        = PlaybookService.suggestDueDays(newStage, actionType);
        const dueDate        = new Date();
        dueDate.setDate(dueDate.getDate() + dueDays);
        const internal = isInternalAction({ action_type: actionType });

        const result = await db.query(
          `INSERT INTO actions (
             user_id, deal_id, type, title, description, priority,
             action_type, keywords, deal_stage, requires_external_evidence,
             source, due_date, is_internal, status, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'yet_to_start',NOW())
           RETURNING *`,
          [
            userId, dealId, actionType, actionText,
            `Generated from Sales Playbook for ${newStage} stage`,
            priority, actionType, keywords, newStage, requiresExt,
            'playbook', dueDate, internal,
          ]
        );
        actions.push(result.rows[0]);
      }
      return actions;
    } catch (error) {
      console.error('Error generating from playbook:', error);
      return [];
    }
  }
}

module.exports = ActionsGenerator;
