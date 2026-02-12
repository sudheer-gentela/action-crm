const { db } = require('../config/database');

/**
 * Create actions from email analysis
 * Integrates with your existing actions table
 */
async function createActionsFromEmail(userId, emailData, analysis) {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    const createdActions = [];
    
    if (analysis.action_items && analysis.action_items.length > 0) {
      for (const item of analysis.action_items) {
        // Use your existing actions table structure
        const query = `
          INSERT INTO actions (
            user_id, title, description, priority, status, 
            due_date, source, source_id, metadata, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          RETURNING *
        `;
        
        const values = [
          userId,
          item.description.substring(0, 255),
          `From: ${emailData.from?.emailAddress?.address}\nSubject: ${emailData.subject}\n\n${analysis.summary}`,
          item.priority || 'medium',
          'pending',
          item.deadline || null,
          'outlook_email',
          emailData.id,
          JSON.stringify({
            email_subject: emailData.subject,
            email_from: emailData.from?.emailAddress?.address,
            email_date: emailData.receivedDateTime,
            requires_response: analysis.requires_response,
            sentiment: analysis.sentiment,
            category: analysis.category,
            claude_analysis: analysis
          })
        ];
        
        const result = await client.query(query, values);
        createdActions.push(result.rows[0]);
      }
    }
    
    // Link contacts if they exist in your system
    for (const action of createdActions) {
      await linkEmailContacts(client, action.id, analysis.key_contacts, userId);
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
    // Extract email if in format "Name <email@example.com>"
    let emailAddress = email;
    const emailMatch = email.match(/<(.+?)>/);
    if (emailMatch) {
      emailAddress = emailMatch[1];
    }
    
    // Validate email format
    if (!emailAddress.includes('@')) {
      continue;
    }
    
    // Check if contact exists in your existing contacts table
    const contactResult = await client.query(
      'SELECT id FROM contacts WHERE email = $1 AND user_id = $2',
      [emailAddress, userId]
    );
    
    if (contactResult.rows.length > 0) {
      const contactId = contactResult.rows[0].id;
      
      // Try to link to existing contact (if junction table exists)
      try {
        await client.query(
          `INSERT INTO action_contacts (action_id, contact_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [actionId, contactId]
        );
      } catch (e) {
        // Table might not exist, skip contact linking
        console.log('Note: action_contacts table not found, skipping contact link');
      }
    }
  }
}

module.exports = {
  createActionsFromEmail
};
