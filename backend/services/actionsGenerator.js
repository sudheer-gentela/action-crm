/**
 * Actions Generator Service
 * Triggers the ActionsEngine to generate smart actions based on data changes
 */

const pool = require('../db');
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
      const dealsResult = await pool.query('SELECT * FROM deals WHERE deleted_at IS NULL');
      const contactsResult = await pool.query('SELECT * FROM contacts WHERE deleted_at IS NULL');
      const emailsResult = await pool.query('SELECT * FROM emails WHERE deleted_at IS NULL');
      const meetingsResult = await pool.query('SELECT * FROM meetings WHERE deleted_at IS NULL');
      const accountsResult = await pool.query('SELECT * FROM accounts WHERE deleted_at IS NULL');

      const deals = dealsResult.rows;
      const contacts = contactsResult.rows;
      const emails = emailsResult.rows;
      const meetings = meetingsResult.rows;
      const accounts = accountsResult.rows;

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
      await pool.query(
        'DELETE FROM actions WHERE source = $1',
        ['auto_generated']
      );

      // Insert new actions
      let insertedCount = 0;
      for (const action of generatedActions) {
        try {
          await pool.query(
            `INSERT INTO actions (
              title, description, action_type, priority, 
              due_date, deal_id, contact_id, account_id,
              suggested_action, source, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
            [
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
        } catch (error) {
          console.error('Error inserting action:', error.message);
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
      const dealResult = await pool.query('SELECT * FROM deals WHERE id = $1', [dealId]);
      if (dealResult.rows.length === 0) return;

      const deal = dealResult.rows[0];

      // Fetch related data
      const contactsResult = await pool.query(
        'SELECT * FROM contacts WHERE account_id = $1',
        [deal.account_id]
      );
      const emailsResult = await pool.query(
        'SELECT * FROM emails WHERE deal_id = $1',
        [dealId]
      );
      const meetingsResult = await pool.query(
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
      await pool.query(
        'DELETE FROM actions WHERE deal_id = $1 AND source = $2',
        [dealId, 'auto_generated']
      );

      // Insert new actions
      for (const action of dealActions) {
        await pool.query(
          `INSERT INTO actions (
            title, description, action_type, priority, 
            due_date, deal_id, contact_id, account_id,
            suggested_action, source, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
          [
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

      const emailResult = await pool.query('SELECT * FROM emails WHERE id = $1', [emailId]);
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

      const meetingResult = await pool.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
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
