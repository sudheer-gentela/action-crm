const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken    = require('../middleware/auth.middleware');
const { orgContext }       = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── Helper: verify deal belongs to this org ───────────────────────────────────
async function resolveDeal(req, res) {
  const result = await db.query(
    `SELECT id, user_id, org_id FROM deals WHERE id = $1 AND org_id = $2`,
    [req.params.dealId, req.orgId]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: { message: 'Deal not found' } });
    return null;
  }
  return result.rows[0];
}

// ── GET /:dealId/contacts — list contacts linked to this deal ─────────────────
router.get('/:dealId/contacts', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const result = await db.query(
      `SELECT
         dc.role          AS deal_role,
         dc.contact_id,
         c.first_name,
         c.last_name,
         c.email,
         c.title,
         c.role_type,
         c.engagement_level,
         acc.name         AS account_name,
         acc.id           AS account_id
       FROM deal_contacts dc
       JOIN contacts c    ON c.id  = dc.contact_id
       LEFT JOIN accounts acc ON acc.id = c.account_id
       WHERE dc.deal_id = $1
         AND c.org_id   = $2
       ORDER BY c.first_name, c.last_name`,
      [req.params.dealId, req.orgId]
    );

    res.json({
      contacts: result.rows.map(r => ({
        contactId:       r.contact_id,
        firstName:       r.first_name,
        lastName:        r.last_name,
        email:           r.email,
        title:           r.title,
        roleType:        r.role_type,
        engagementLevel: r.engagement_level,
        dealRole:        r.deal_role,
        accountName:     r.account_name,
        accountId:       r.account_id,
      }))
    });
  } catch (err) {
    console.error('Get deal contacts error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch deal contacts' } });
  }
});

// ── POST /:dealId/contacts — link a contact to this deal ──────────────────────
router.post('/:dealId/contacts', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const { contactId, role } = req.body;
    if (!contactId) {
      return res.status(400).json({ error: { message: 'contactId is required' } });
    }

    // Verify the contact belongs to this org
    const contactCheck = await db.query(
      `SELECT id, first_name, last_name, email, title, role_type, engagement_level, account_id
       FROM contacts
       WHERE id = $1 AND org_id = $2`,
      [contactId, req.orgId]
    );
    if (contactCheck.rows.length === 0) {
      return res.status(400).json({ error: { message: 'Contact not found in this organisation' } });
    }

    const contact = contactCheck.rows[0];

    // Upsert — if already linked, update role
    await db.query(
      `INSERT INTO deal_contacts (deal_id, contact_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (deal_id, contact_id) DO UPDATE
         SET role = EXCLUDED.role`,
      [req.params.dealId, contactId, role || null]
    );

    // Fetch account name for the response
    let accountName = null;
    if (contact.account_id) {
      const accRes = await db.query(
        `SELECT name FROM accounts WHERE id = $1`,
        [contact.account_id]
      );
      accountName = accRes.rows[0]?.name || null;
    }

    res.status(201).json({
      contact: {
        contactId:       contact.id,
        firstName:       contact.first_name,
        lastName:        contact.last_name,
        email:           contact.email,
        title:           contact.title,
        roleType:        contact.role_type,
        engagementLevel: contact.engagement_level,
        dealRole:        role || null,
        accountName,
        accountId:       contact.account_id,
      }
    });
  } catch (err) {
    console.error('Add deal contact error:', err);
    res.status(500).json({ error: { message: 'Failed to add deal contact' } });
  }
});

// ── PATCH /:dealId/contacts/:contactId — update the role on a linked contact ──
router.patch('/:dealId/contacts/:contactId', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const { role } = req.body;

    const result = await db.query(
      `UPDATE deal_contacts
       SET role = $1
       WHERE deal_id = $2 AND contact_id = $3
       RETURNING *`,
      [role || null, req.params.dealId, req.params.contactId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal contact not found' } });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update deal contact role error:', err);
    res.status(500).json({ error: { message: 'Failed to update contact role' } });
  }
});

// ── DELETE /:dealId/contacts/:contactId — unlink a contact from this deal ─────
router.delete('/:dealId/contacts/:contactId', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const result = await db.query(
      `DELETE FROM deal_contacts
       WHERE deal_id = $1 AND contact_id = $2
       RETURNING contact_id`,
      [req.params.dealId, req.params.contactId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal contact not found' } });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Remove deal contact error:', err);
    res.status(500).json({ error: { message: 'Failed to remove deal contact' } });
  }
});

// ── GET /:dealId/contacts/eligible — org contacts not yet linked ───────────────
// Returns all org contacts minus those already on this deal
router.get('/:dealId/contacts/eligible', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const result = await db.query(
      `SELECT
         c.id,
         c.first_name,
         c.last_name,
         c.email,
         c.title,
         c.role_type,
         acc.name AS account_name
       FROM contacts c
       LEFT JOIN accounts acc ON acc.id = c.account_id
       WHERE c.org_id = $1
         AND c.id NOT IN (
           SELECT contact_id FROM deal_contacts WHERE deal_id = $2
         )
       ORDER BY c.first_name, c.last_name`,
      [req.orgId, req.params.dealId]
    );

    res.json({
      contacts: result.rows.map(c => ({
        id:          c.id,
        firstName:   c.first_name,
        lastName:    c.last_name,
        email:       c.email,
        title:       c.title,
        roleType:    c.role_type,
        accountName: c.account_name,
      }))
    });
  } catch (err) {
    console.error('Get eligible contacts error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch eligible contacts' } });
  }
});

module.exports = router;
