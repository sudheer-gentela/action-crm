/**
 * emailActionsService.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: backend/services/emailActionsService.js
 *
 * Key changes from original:
 *   - createActionsFromEmail accepts provider parameter (5th arg)
 *   - Source is provider-specific: 'outlook_email' or 'gmail_email'
 *   - Provider tracked in action metadata
 *   - Handles both Outlook and normalized address formats
 */

const { pool } = require('../config/database');

async function createActionsFromEmail(userId, orgId, emailData, analysis, provider) {
  // Default provider for backward compat with existing callers
  if (!provider) provider = 'outlook';
  const source = provider === 'gmail' ? 'gmail_email' : 'outlook_email';

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const createdActions = [];

    if (analysis.action_items && analysis.action_items.length > 0) {
      for (const item of analysis.action_items) {
        // Handle both Outlook-shape and normalized-shape from addresses
        const fromAddr = emailData.from?.emailAddress?.address || emailData.from?.address || '';

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
            'From: ' + fromAddr + '\nSubject: ' + emailData.subject + '\n\n' + (analysis.summary || ''),
            item.priority || 'medium',
            item.deadline || null,
            source,
            emailData.id,
            JSON.stringify({
              email_subject:     emailData.subject,
              email_from:        fromAddr,
              email_date:        emailData.receivedDateTime,
              email_provider:    provider,
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
    let emailAddress = email;
    const emailMatch = email.match(/<(.+?)>/);
    if (emailMatch) emailAddress = emailMatch[1];
    if (!emailAddress.includes('@')) continue;

    const contactResult = await client.query(
      'SELECT id FROM contacts WHERE email = $1 AND org_id = $2',
      [emailAddress, orgId]
    );

    if (contactResult.rows.length > 0) {
      try {
        await client.query(
          'INSERT INTO action_contacts (action_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [actionId, contactResult.rows[0].id]
        );
      } catch (e) {
        // action_contacts table may not exist -- safe to skip
      }
    }
  }
}

module.exports = { createActionsFromEmail };
