/**
 * emailActionsService.js
 * Creates actions from email AI analysis (Outlook email processor path).
 * 
 * FIXES applied:
 *   - Changed `const { db }` to `const { pool }` — db was undefined, crashed on every call
 *   - Removed `status` column from INSERT — column does not exist in actions table
 *   - source_id and metadata columns confirmed present (used by aiProcessor.js too)
 */

const { pool } = require('../config/database');

async function createActionsFromEmail(userId, emailData, analysis) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const createdActions = [];

    if (analysis.action_items && analysis.action_items.length > 0) {
      for (const item of analysis.action_items) {
        const query = `
          INSERT INTO actions (
            user_id, title, description, priority,
            due_date, source, source_id, metadata, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          RETURNING *
        `;

        const values = [
          userId,
          item.description.substring(0, 255),
          `From: ${emailData.from?.emailAddress?.address}\nSubject: ${emailData.subject}\n\n${analysis.summary}`,
          item.priority || 'medium',
          item.deadline || null,
          'outlook_email',
          emailData.id,
          JSON.stringify({
            email_subject:     emailData.subject,
            email_from:        emailData.from?.emailAddress?.address,
            email_date:        emailData.receivedDateTime,
            requires_response: analysis.requires_response,
            sentiment:         analysis.sentiment,
            category:          analysis.category,
            claude_analysis:   analysis
          })
        ];

        const result = await client.query(query, values);
        createdActions.push(result.rows[0]);
      }
    }

    // Link contacts where they exist in the system
    for (const action of createdActions) {
      await linkEmailContacts(client, action.id, analysis.key_contacts || [], userId);
    }

    await client.query('COMMIT');
    return createdActions;

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating actions from email:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function linkEmailContacts(client, actionId, contactEmails, userId) {
  for (const email of contactEmails) {
    // Handle "Name <email@example.com>" format
    let emailAddress = email;
    const emailMatch = email.match(/<(.+?)>/);
    if (emailMatch) emailAddress = emailMatch[1];

    if (!emailAddress.includes('@')) continue;

    const contactResult = await client.query(
      'SELECT id FROM contacts WHERE email = $1 AND user_id = $2',
      [emailAddress, userId]
    );

    if (contactResult.rows.length > 0) {
      try {
        await client.query(
          `INSERT INTO action_contacts (action_id, contact_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [actionId, contactResult.rows[0].id]
        );
      } catch {
        // action_contacts table may not exist — safe to skip
      }
    }
  }
}

module.exports = { createActionsFromEmail };
