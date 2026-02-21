/**
 * emailActionsService.js
 * Creates actions from email AI analysis (Outlook email processor path).
 *
 * MULTI-ORG changes:
 *   - createActionsFromEmail(userId, orgId, emailData, analysis)
 *   - INSERT INTO actions now includes org_id as the first data column
 *   - linkEmailContacts now queries contacts WHERE email = $1 AND org_id = $2
 *     (contacts table has no user_id column — it's org-scoped, not user-scoped)
 */

const { pool } = require('../config/database');

async function createActionsFromEmail(userId, orgId, emailData, analysis) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const createdActions = [];

    if (analysis.action_items && analysis.action_items.length > 0) {
      for (const item of analysis.action_items) {
        const result = await client.query(
          `INSERT INTO actions (
            org_id, user_id, title, description, priority,
            due_date, source, source_id, metadata, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          RETURNING *`,
          [
            orgId,
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
          ]
        );
        createdActions.push(result.rows[0]);
      }
    }

    // Link contacts where they exist in this org
    for (const action of createdActions) {
      await linkEmailContacts(client, action.id, analysis.key_contacts || [], orgId);
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

async function linkEmailContacts(client, actionId, contactEmails, orgId) {
  for (const email of contactEmails) {
    // Handle "Name <email@example.com>" format
    let emailAddress = email;
    const emailMatch = email.match(/<(.+?)>/);
    if (emailMatch) emailAddress = emailMatch[1];

    if (!emailAddress.includes('@')) continue;

    // contacts are org-scoped, not user-scoped
    const contactResult = await client.query(
      'SELECT id FROM contacts WHERE email = $1 AND org_id = $2',
      [emailAddress, orgId]
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
