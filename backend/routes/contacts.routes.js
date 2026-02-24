const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── GET / — list contacts ─────────────────────────────────────
// OLD isolation: WHERE acc.owner_id = $1 (broken — contacts can
//   exist on accounts owned by other users in the same org)
// NEW isolation: WHERE c.org_id = $1 (correct org-level scope)
router.get('/', async (req, res) => {
  try {
    const { roleType, engagementLevel } = req.query;

    let query = `
      SELECT
        c.*,
        acc.name as account_name,
        acc.id   as account_id,
        json_agg(
          json_build_object('id', d.id, 'name', d.name, 'value', d.value, 'stage', d.stage)
        ) FILTER (WHERE d.id IS NOT NULL) as deals
      FROM contacts c
      LEFT JOIN accounts acc ON c.account_id = acc.id
      LEFT JOIN deal_contacts dc ON c.id = dc.contact_id
      LEFT JOIN deals d ON dc.deal_id = d.id AND d.org_id = $1
      WHERE c.org_id = $1
    `;

    const params = [req.orgId];

    if (roleType) {
      query += ` AND c.role_type = $${params.length + 1}`;
      params.push(roleType);
    }

    if (engagementLevel) {
      query += ` AND c.engagement_level = $${params.length + 1}`;
      params.push(engagementLevel);
    }

    query += ' GROUP BY c.id, acc.id ORDER BY c.last_contact_date DESC NULLS LAST';

    const result = await db.query(query, params);

    res.json({
      contacts: result.rows.map(row => ({
        ...row,
        account: { id: row.account_id, name: row.account_name },
        deals:   row.deals || []
      }))
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch contacts' } });
  }
});

// ── GET /duplicates — find duplicate contact groups in this org ────────────────
// NOTE: Must be registered BEFORE /:id so Express doesn't treat "duplicates" as an id
router.get('/duplicates', async (req, res) => {
  try {
    const emailDupes = await db.query(
      `SELECT LOWER(email) AS match_key, 'email' AS match_type,
              json_agg(
                json_build_object(
                  'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
                  'email', c.email, 'phone', c.phone, 'title', c.title,
                  'role_type', c.role_type, 'engagement_level', c.engagement_level,
                  'location', c.location, 'linkedin_url', c.linkedin_url,
                  'notes', c.notes, 'account_id', c.account_id,
                  'account_name', acc.name, 'last_contact_date', c.last_contact_date,
                  'created_at', c.created_at
                ) ORDER BY c.created_at ASC
              ) AS contacts
       FROM contacts c
       LEFT JOIN accounts acc ON acc.id = c.account_id
       WHERE c.org_id = $1
         AND c.email IS NOT NULL AND c.email != ''
       GROUP BY LOWER(c.email)
       HAVING COUNT(*) > 1`,
      [req.orgId]
    );

    const nameDupes = await db.query(
      `SELECT LOWER(c.first_name) || '|' || LOWER(c.last_name) || '|' || c.account_id AS match_key,
              'name_account' AS match_type,
              json_agg(
                json_build_object(
                  'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
                  'email', c.email, 'phone', c.phone, 'title', c.title,
                  'role_type', c.role_type, 'engagement_level', c.engagement_level,
                  'location', c.location, 'linkedin_url', c.linkedin_url,
                  'notes', c.notes, 'account_id', c.account_id,
                  'account_name', acc.name, 'last_contact_date', c.last_contact_date,
                  'created_at', c.created_at
                ) ORDER BY c.created_at ASC
              ) AS contacts
       FROM contacts c
       LEFT JOIN accounts acc ON acc.id = c.account_id
       WHERE c.org_id = $1
         AND c.account_id IS NOT NULL
       GROUP BY LOWER(c.first_name), LOWER(c.last_name), c.account_id
       HAVING COUNT(*) > 1`,
      [req.orgId]
    );

    const seenPairs = new Set();
    const groups = [];
    for (const row of [...emailDupes.rows, ...nameDupes.rows]) {
      const ids = row.contacts.map(c => c.id).sort().join(',');
      if (!seenPairs.has(ids)) {
        seenPairs.add(ids);
        groups.push({ matchType: row.match_type, matchKey: row.match_key, contacts: row.contacts });
      }
    }

    res.json({ duplicateGroups: groups, totalGroups: groups.length });
  } catch (error) {
    console.error('Get duplicates error:', error);
    res.status(500).json({ error: { message: 'Failed to find duplicates' } });
  }
});

// ── POST /merge — merge two contacts ──────────────────────────────────────────
// NOTE: Must be registered BEFORE /:id
router.post('/merge', async (req, res) => {
  const client = await (db.pool ? db.pool.connect() : db.connect());
  try {
    const { keepId, removeId, fieldOverrides = {} } = req.body;
    if (!keepId || !removeId) {
      return res.status(400).json({ error: { message: 'keepId and removeId are required' } });
    }
    if (keepId === removeId) {
      return res.status(400).json({ error: { message: 'Cannot merge a contact with itself' } });
    }

    const bothRes = await client.query(
      `SELECT id, first_name, last_name, email, phone, title, role_type,
              engagement_level, location, linkedin_url, notes, account_id
       FROM contacts WHERE id IN ($1, $2) AND org_id = $3`,
      [keepId, removeId, req.orgId]
    );
    if (bothRes.rows.length !== 2) {
      return res.status(404).json({ error: { message: 'One or both contacts not found in this org' } });
    }
    const keepContact   = bothRes.rows.find(r => r.id === keepId);
    const removeContact = bothRes.rows.find(r => r.id === removeId);

    await client.query('BEGIN');

    const overridableFields = [
      'first_name', 'last_name', 'email', 'phone', 'title', 'role_type',
      'engagement_level', 'location', 'linkedin_url', 'notes', 'account_id'
    ];
    const updates = [];
    const values  = [];
    let paramIdx  = 1;

    for (const field of overridableFields) {
      if (fieldOverrides[field] === 'from_remove' && removeContact[field]) {
        updates.push(`${field} = $${paramIdx}`);
        values.push(removeContact[field]);
        paramIdx++;
      }
    }

    if (updates.length > 0) {
      values.push(keepId, req.orgId);
      await client.query(
        `UPDATE contacts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $${paramIdx} AND org_id = $${paramIdx + 1}`,
        values
      );
    }

    await client.query(
      `INSERT INTO deal_contacts (deal_id, contact_id, role)
       SELECT dc.deal_id, $1, dc.role FROM deal_contacts dc
       WHERE dc.contact_id = $2
         AND dc.deal_id NOT IN (SELECT deal_id FROM deal_contacts WHERE contact_id = $1)
       ON CONFLICT (deal_id, contact_id) DO NOTHING`,
      [keepId, removeId]
    );

    await client.query(`UPDATE emails SET contact_id = $1 WHERE contact_id = $2`, [keepId, removeId]);

    // Meetings link contacts via meeting_attendees (join table), not a direct column.
    // Move attendee rows from removed contact to kept contact, skip if already attending.
    await client.query(
      `UPDATE meeting_attendees SET contact_id = $1
       WHERE contact_id = $2
         AND meeting_id NOT IN (SELECT meeting_id FROM meeting_attendees WHERE contact_id = $1)`,
      [keepId, removeId]
    );
    await client.query(`DELETE FROM meeting_attendees WHERE contact_id = $1`, [removeId]);

    await client.query(`UPDATE contact_activities SET contact_id = $1 WHERE contact_id = $2`, [keepId, removeId]);
    await client.query(`UPDATE conversation_starters SET contact_id = $1 WHERE contact_id = $2`, [keepId, removeId]);

    await client.query(`DELETE FROM deal_contacts WHERE contact_id = $1`, [removeId]);
    await client.query(`DELETE FROM contacts WHERE id = $1 AND org_id = $2`, [removeId, req.orgId]);

    await client.query('COMMIT');

    const updatedRes = await db.query(
      `SELECT c.*, acc.name as account_name FROM contacts c
       LEFT JOIN accounts acc ON acc.id = c.account_id WHERE c.id = $1`,
      [keepId]
    );

    res.json({ success: true, mergedContact: updatedRes.rows[0], removedId: removeId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Merge contacts error:', error);
    res.status(500).json({ error: { message: 'Failed to merge contacts' } });
  } finally {
    client.release();
  }
});

// ── GET /:id ──────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const contactQuery = await db.query(
      `SELECT c.*, acc.name as account_name, acc.id as account_id
       FROM contacts c
       LEFT JOIN accounts acc ON c.account_id = acc.id
       WHERE c.id = $1 AND c.org_id = $2`,
      [req.params.id, req.orgId]
    );

    if (contactQuery.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }

    const contact = contactQuery.rows[0];

    const [activitiesQuery, startersQuery] = await Promise.all([
      db.query(
        `SELECT * FROM contact_activities
         WHERE contact_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [req.params.id]
      ),
      db.query(
        `SELECT * FROM conversation_starters
         WHERE contact_id = $1 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY relevance_score DESC LIMIT 5`,
        [req.params.id]
      ),
    ]);

    res.json({
      contact: {
        ...contact,
        account:              { id: contact.account_id, name: contact.account_name },
        activities:           activitiesQuery.rows,
        conversationStarters: startersQuery.rows
      }
    });
  } catch (error) {
    console.error('Get contact error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch contact' } });
  }
});

// ── POST / — create contact ───────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { accountId, firstName, lastName, email, phone, title, roleType, location, linkedinUrl, notes } = req.body;

    // ── Duplicate prevention ────────────────────────────────────
    // Check 1: same email in this org
    if (email) {
      const emailDup = await db.query(
        `SELECT id, first_name, last_name, email FROM contacts
         WHERE org_id = $1 AND LOWER(email) = LOWER($2)`,
        [req.orgId, email]
      );
      if (emailDup.rows.length > 0) {
        const dup = emailDup.rows[0];
        return res.status(409).json({
          error: {
            message: `A contact with email "${email}" already exists: ${dup.first_name} ${dup.last_name} (ID ${dup.id})`,
            code: 'DUPLICATE_EMAIL',
            existingContactId: dup.id,
          }
        });
      }
    }
    // Check 2: same first+last name on the same account
    if (firstName && lastName && accountId) {
      const nameDup = await db.query(
        `SELECT id, first_name, last_name, email FROM contacts
         WHERE org_id = $1
           AND LOWER(first_name) = LOWER($2)
           AND LOWER(last_name)  = LOWER($3)
           AND account_id = $4`,
        [req.orgId, firstName, lastName, accountId]
      );
      if (nameDup.rows.length > 0) {
        const dup = nameDup.rows[0];
        return res.status(409).json({
          error: {
            message: `A contact named "${firstName} ${lastName}" already exists on this account: ${dup.email || 'no email'} (ID ${dup.id})`,
            code: 'DUPLICATE_NAME_ACCOUNT',
            existingContactId: dup.id,
          }
        });
      }
    }

    const result = await db.query(
      `INSERT INTO contacts
         (org_id, account_id, first_name, last_name, email, phone, title, role_type, location, linkedin_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.orgId, accountId, firstName, lastName, email, phone, title, roleType, location, linkedinUrl, notes]
    );

    res.status(201).json({ contact: result.rows[0] });
  } catch (error) {
    console.error('Create contact error:', error);
    res.status(500).json({ error: { message: 'Failed to create contact' } });
  }
});

// ── PUT /:id — update contact ─────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, title, roleType, engagementLevel, location, linkedinUrl, notes } = req.body;

    const result = await db.query(
      `UPDATE contacts
       SET first_name       = COALESCE($1,  first_name),
           last_name        = COALESCE($2,  last_name),
           email            = COALESCE($3,  email),
           phone            = COALESCE($4,  phone),
           title            = COALESCE($5,  title),
           role_type        = COALESCE($6,  role_type),
           engagement_level = COALESCE($7,  engagement_level),
           location         = COALESCE($8,  location),
           linkedin_url     = COALESCE($9,  linkedin_url),
           notes            = COALESCE($10, notes),
           updated_at       = CURRENT_TIMESTAMP
       WHERE id = $11 AND org_id = $12
       RETURNING *`,
      [firstName, lastName, email, phone, title, roleType, engagementLevel, location, linkedinUrl, notes, req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }

    res.json({ contact: result.rows[0] });
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: { message: 'Failed to update contact' } });
  }
});

// ── POST /:id/activities — log activity ───────────────────────
router.post('/:id/activities', async (req, res) => {
  try {
    const { activityType, description, metadata } = req.body;

    // Verify contact belongs to this org before logging
    const check = await db.query(
      'SELECT id FROM contacts WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }

    await db.query(
      `INSERT INTO contact_activities (contact_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, req.user.userId, activityType, description, metadata]
    );

    await db.query(
      'UPDATE contacts SET last_contact_date = CURRENT_TIMESTAMP WHERE id = $1',
      [req.params.id]
    );

    res.status(201).json({ message: 'Activity logged' });
  } catch (error) {
    console.error('Log activity error:', error);
    res.status(500).json({ error: { message: 'Failed to log activity' } });
  }
});

// ── POST /:id/snooze-email — snooze email tagging for this contact ────────────
// Emails from this contact won't appear in the untagged email tagging prompts.
router.post('/:id/snooze-email', async (req, res) => {
  try {
    const { reason } = req.body;

    const result = await db.query(
      `UPDATE contacts
       SET email_snoozed       = true,
           email_snoozed_at    = CURRENT_TIMESTAMP,
           email_snoozed_by    = $1,
           email_snooze_reason = $2,
           updated_at          = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4
       RETURNING id, first_name, last_name, email_snoozed, email_snooze_reason`,
      [req.user.userId, reason || null, req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }

    res.json({ contact: result.rows[0] });
  } catch (err) {
    console.error('Snooze contact email error:', err);
    res.status(500).json({ error: { message: 'Failed to snooze contact' } });
  }
});

// ── POST /:id/unsnooze-email — remove email snooze from contact ───────────────
router.post('/:id/unsnooze-email', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE contacts
       SET email_snoozed       = false,
           email_snoozed_at    = NULL,
           email_snoozed_by    = NULL,
           email_snooze_reason = NULL,
           updated_at          = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2
       RETURNING id, first_name, last_name, email_snoozed`,
      [req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }

    res.json({ contact: result.rows[0] });
  } catch (err) {
    console.error('Unsnooze contact email error:', err);
    res.status(500).json({ error: { message: 'Failed to unsnooze contact' } });
  }
});

// ── DELETE /:id — delete contact ─────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    // Clean up deal_contacts first
    await db.query('DELETE FROM deal_contacts WHERE contact_id = $1', [req.params.id]);

    const result = await db.query(
      'DELETE FROM contacts WHERE id = $1 AND org_id = $2 RETURNING id',
      [req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }

    res.json({ message: 'Contact deleted' });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: { message: 'Failed to delete contact' } });
  }
});

module.exports = router;
