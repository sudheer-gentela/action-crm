// ─────────────────────────────────────────────────────────────
// preview.routes.js  —  READ-ONLY staging preview (Mongo migration)
//
// Surfaces the migrated Mongo data (staged in stg.* / pavan_preview.*)
// so a user can validate their contacts + interaction history BEFORE
// anything is written to production tables. Writes nothing.
//
// Mount in app.js:  app.use('/api/preview', require('./routes/preview.routes'));
//
// Access model: authenticateToken -> orgContext (req.orgId, req.userId).
// The logged-in Postgres user is resolved to their Mongo user id via
// pavan_preview.user_map (stg.map_user). If they have no mapping, the
// preview is empty — so this can only ever show a user their own data.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const { pool } = require('../config/database');

router.use(authenticateToken);
router.use(orgContext);

// resolve logged-in PG user -> Mongo user id (or null)
async function resolveMongoUser(pgUserId) {
  const { rows } = await pool.query(
    'SELECT mongo_user_id FROM pavan_preview.user_map WHERE pg_user_id = $1 LIMIT 1',
    [pgUserId]
  );
  return rows.length ? rows[0].mongo_user_id : null;
}

// ── GET /api/preview/me ──────────────────────────────────────
// Whether this user has migrated data to preview, and summary counts.
router.get('/me', async (req, res) => {
  try {
    const mongoUser = await resolveMongoUser(req.userId);
    if (!mongoUser) return res.json({ hasPreview: false });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS contacts_with_activity
         FROM pavan_preview.contacts_with_activity
        WHERE mongo_user_id = $1`,
      [mongoUser]
    );
    res.json({ hasPreview: true, ...rows[0] });
  } catch (error) {
    console.error('Preview /me error:', error);
    res.status(500).json({ error: { message: 'Failed to load preview summary' } });
  }
});

// ── GET /api/preview/contacts ────────────────────────────────
// Contacts WITH activity for the logged-in user. Paginated + search.
//   ?q=  search first/last/company   ?limit= ?offset=  ?workspace=
router.get('/contacts', async (req, res) => {
  try {
    const mongoUser = await resolveMongoUser(req.userId);
    if (!mongoUser) return res.json({ contacts: [], total: 0 });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const q = (req.query.q || '').trim().toLowerCase();
    const workspace = req.query.workspace || null;

    const params = [mongoUser];
    let where = 'mongo_user_id = $1';
    if (workspace) { params.push(workspace); where += ` AND workspace_id = $${params.length}`; }
    if (q) {
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      where += ` AND (lower(first_name) LIKE ${p} OR lower(last_name) LIKE ${p} OR lower(current_company) LIKE ${p})`;
    }

    const totalQ = await pool.query(
      `SELECT count(*)::int AS total FROM pavan_preview.contacts_with_activity WHERE ${where}`,
      params
    );
    params.push(limit); params.push(offset);
    const { rows } = await pool.query(
      `SELECT contact_id, first_name, last_name, email, linkedin_url,
              current_title, current_company, email_count
         FROM pavan_preview.contacts_with_activity
        WHERE ${where}
        ORDER BY email_count DESC, last_name NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ contacts: rows, total: totalQ.rows[0].total, limit, offset });
  } catch (error) {
    console.error('Preview /contacts error:', error);
    res.status(500).json({ error: { message: 'Failed to load contacts' } });
  }
});

// ── GET /api/preview/contacts/:id/timeline ───────────────────
// Full merged timeline for one contact: email + linkedin + tags + status.
router.get('/contacts/:id/timeline', async (req, res) => {
  try {
    const mongoUser = await resolveMongoUser(req.userId);
    if (!mongoUser) return res.status(403).json({ error: { message: 'No preview data for this user' } });

    const contactId = req.params.id;

    // guard: the contact must belong to this user's set
    const owns = await pool.query(
      `SELECT 1 FROM pavan_preview.user_contacts
        WHERE mongo_user_id = $1 AND contact_id = $2 LIMIT 1`,
      [mongoUser, contactId]
    );
    if (!owns.rows.length) return res.status(404).json({ error: { message: 'Contact not found' } });

    const [contact, email, linkedin, tags, status] = await Promise.all([
      pool.query(`SELECT * FROM pavan_preview.contacts WHERE contact_id = $1`, [contactId]),
      pool.query(
        `SELECT channel, ts, detail, sender, direction
           FROM pavan_preview.email_timeline WHERE contact_id = $1
           ORDER BY ts`, [contactId]),
      pool.query(
        `SELECT channel, ts, detail, sender, direction
           FROM pavan_preview.linkedin_timeline WHERE contact_id = $1
           ORDER BY ts`, [contactId]),
      pool.query(
        `SELECT tag FROM pavan_preview.contact_tags
          WHERE contact_id = $1 AND mongo_user_id = $2`, [contactId, mongoUser]),
      pool.query(
        `SELECT status FROM pavan_preview.linkedin_status
          WHERE contact_id = $1 AND mongo_user_id = $2 LIMIT 1`, [contactId, mongoUser]),
    ]);

    // merge channels into one chronological feed
    const timeline = [...email.rows, ...linkedin.rows]
      .filter(r => r.ts)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

    res.json({
      contact: contact.rows[0] || null,
      linkedin_status: status.rows.length ? status.rows[0].status : 'unknown',
      tags: tags.rows.map(r => r.tag),
      timeline,
    });
  } catch (error) {
    console.error('Preview /timeline error:', error);
    res.status(500).json({ error: { message: 'Failed to load contact timeline' } });
  }
});

module.exports = router;
