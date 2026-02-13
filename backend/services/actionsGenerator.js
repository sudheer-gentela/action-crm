/**
 * Actions Generator Service - FIXED VERSION
 * Triggers the ActionsEngine to generate smart actions based on data changes
 */

const db = require('../config/database');
const ActionsEngine = require('./ActionsEngine');

class ActionsGenerator {
  /**
   * Generate actions for all deals, contacts, emails, meetings
   * Called by cron job or manual trigger
   */
  static async generateAll() {
    try {
      console.log('🤖 Starting ActionsEngine - Generating all actions...');

      // Fetch all relevant data
      const dealsResult = await db.query('SELECT * FROM deals WHERE deleted_at IS NULL');
      const contactsResult = await db.query('SELECT * FROM contacts WHERE deleted_at IS NULL');
      const emailsResult = await db.query('SELECT * FROM emails WHERE deleted_at IS NULL');
      const meetingsResult = await db.query('SELECT * FROM meetings WHERE deleted_at IS NULL');
      const accountsResult = await db.query('SELECT * FROM accounts WHERE deleted_at IS NULL');

      const deals = dealsResult.rows;
      const contacts = contactsResult.rows;
      const emails = emailsResult.rows;
      const meetings = meetingsResult.rows;
      const accounts = accountsResult.rows;

      console.log(`📊 Data loaded: ${deals.length} deals, ${contacts.length} contacts, ${emails.length} emails, ${meetings.length} meetings`);

      // Generate actions using ActionsEngine
      const generatedActions = ActionsEngine.generateActions({
        deals,
        contacts,
        emails,
        meetings,
        accounts
      });

      console.log(`✅ ActionsEngine generated ${generatedActions.length} actions`);

      // Delete old auto-generated actions to avoid duplicates
      await db.query(
        'DELETE FROM actions WHERE source = $1',
        ['auto_generated']
      );

      // Insert new actions
      let insertedCount = 0;
      for (const action of generatedActions) {
        try {
          // ✅ FIX: Get user_id from the deal, contact, or account
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

          // ✅ FIX: Added user_id to INSERT
          await db.query(
            `INSERT INTO actions (
              user_id, title, description, action_type, priority, 
              due_date, deal_id, contact_id, account_id,
              suggested_action, source, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
            [
              userId,                           // ✅ ADDED user_id
              action.title,
              action.description,
              action.action_type,
              action.priority,
              action.due_date,
              action.deal_id || null,
              action.contact_id || null,
              action.account_id || null,
              action.suggested_action || null,
              'auto_generated'
            ]
          );
          insertedCount++;
          console.log(`✅ Inserted action: ${action.title} (user_id: ${userId})`);
        } catch (error) {
          console.error('❌ Error inserting action:', error.message);
          console.error('   Action was:', action.title);
        }
      }

      console.log(`✅ Inserted ${insertedCount} actions into database`);

      return {
        success: true,
        generated: generatedActions.length,
        inserted: insertedCount
      };

    } catch (error) {
      console.error('❌ Error generating actions:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate actions for a specific deal
   * Triggered when deal is created or updated
   */
  static async generateForDeal(dealId) {
    try {
      console.log(`🤖 Generating actions for deal ${dealId}...`);

      // Fetch deal and related data
      const dealResult = await db.query('SELECT * FROM deals WHERE id = $1', [dealId]);
      if (dealResult.rows.length === 0) return;

      const deal = dealResult.rows[0];
      const userId = deal.owner_id; // ✅ Get user_id from deal

      // Fetch related data
      const contactsResult = await db.query(
        'SELECT * FROM contacts WHERE account_id = $1',
        [deal.account_id]
      );
      const emailsResult = await db.query(
        'SELECT * FROM emails WHERE deal_id = $1',
        [dealId]
      );
      const meetingsResult = await db.query(
        'SELECT * FROM meetings WHERE deal_id = $1',
        [dealId]
      );

      // Generate actions for this deal
      const generatedActions = ActionsEngine.generateActions({
        deals: [deal],
        contacts: contactsResult.rows,
        emails: emailsResult.rows,
        meetings: meetingsResult.rows,
        accounts: []
      });

      // Filter to only deal-related actions
      const dealActions = generatedActions.filter(a => a.deal_id === dealId);

      // Delete old auto-generated actions for this deal
      await db.query(
        'DELETE FROM actions WHERE deal_id = $1 AND source = $2',
        [dealId, 'auto_generated']
      );

      // Insert new actions
      for (const action of dealActions) {
        await db.query(
          `INSERT INTO actions (
            user_id, title, description, action_type, priority, 
            due_date, deal_id, contact_id, account_id,
            suggested_action, source, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
          [
            userId,                           // ✅ ADDED user_id
            action.title,
            action.description,
            action.action_type,
            action.priority,
            action.due_date,
            action.deal_id || null,
            action.contact_id || null,
            action.account_id || null,
            action.suggested_action || null,
            'auto_generated'
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

  /**
   * Generate actions when email is sent/received
   */
  static async generateForEmail(emailId) {
    try {
      console.log(`🤖 Generating actions for email ${emailId}...`);

      const emailResult = await db.query('SELECT * FROM emails WHERE id = $1', [emailId]);
      if (emailResult.rows.length === 0) return;

      const email = emailResult.rows[0];

      // If email has a deal, regenerate actions for that deal
      if (email.deal_id) {
        await this.generateForDeal(email.deal_id);
      }

      return true;

    } catch (error) {
      console.error('Error generating actions for email:', error);
      return false;
    }
  }

  /**
   * Generate actions when meeting is scheduled/completed
   */
  static async generateForMeeting(meetingId) {
    try {
      console.log(`🤖 Generating actions for meeting ${meetingId}...`);

      const meetingResult = await db.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
      if (meetingResult.rows.length === 0) return;

      const meeting = meetingResult.rows[0];

      // If meeting has a deal, regenerate actions for that deal
      if (meeting.deal_id) {
        await this.generateForDeal(meeting.deal_id);
      }

      return true;

    } catch (error) {
      console.error('Error generating actions for meeting:', error);
      return false;
    }
  }
}

module.exports = ActionsGenerator;
