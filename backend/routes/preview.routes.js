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

// ═══════════════════════════════════════════════════════════════
// ADDITIONS to preview.routes.js — add these two handlers INSIDE the
// router (before `module.exports = router;`). They power:
//   • the History tab on the prospect detail page (by-prospect timeline)
//   • inline email-body expansion (single email fetch)
//
// Matching a Postgres prospect -> Mongo contact timeline (short-term):
//   1. by email   (prospect.email -> stg.contact_emails)
//   2. by linkedin vanity slug (prospect.linkedin_url -> contact linkedin_url)
//   Returns { found:false } when neither matches -> UI shows "no history".
// ═══════════════════════════════════════════════════════════════

// helper: extract linkedin vanity slug from a URL
function liVanity(url) {
  if (!url) return null;
  const m = String(url).match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// ── GET /api/preview/by-prospect/:prospectId/timeline ──────────
// Resolves a Postgres prospect to the migrated contact timeline.
router.get('/by-prospect/:prospectId/timeline', async (req, res) => {
  try {
    const prospectId = parseInt(req.params.prospectId, 10);
    if (!prospectId) return res.status(400).json({ error: { message: 'Bad prospect id' } });

    // load the prospect's identifiers, scoped to the caller's org
    const pr = await pool.query(
      `SELECT id, email, linkedin_url, first_name, last_name
         FROM prospects WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [prospectId, req.orgId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: { message: 'Prospect not found' } });
    const p = pr.rows[0];

    // resolve to a mongo contact_id: try email first, then linkedin vanity
    let contactId = null;
    if (p.email) {
      const r = await pool.query(
        `SELECT mongo_contact_id FROM stg.contact_emails WHERE email = lower($1) LIMIT 1`,
        [p.email]
      );
      if (r.rows.length) contactId = r.rows[0].mongo_contact_id;
    }
    if (!contactId && p.linkedin_url) {
      const vanity = liVanity(p.linkedin_url);
      if (vanity) {
        const r = await pool.query(
          `SELECT contact_id
             FROM pavan_preview.contacts
            WHERE lower(regexp_replace(regexp_replace(coalesce(linkedin_url,''),'^.*/in/',''),'/.*$','')) = $1
            LIMIT 1`,
          [vanity]
        );
        if (r.rows.length) contactId = r.rows[0].contact_id;
      }
    }

    if (!contactId) return res.json({ found: false });

    // pull email + linkedin timelines, merge chronologically
    const [emails, linkedin, tags, status, contact] = await Promise.all([
      pool.query(
        `SELECT message_id, channel, ts, detail, sender, direction
           FROM pavan_preview.email_timeline WHERE contact_id = $1 ORDER BY ts`, [contactId]),
      pool.query(
        `SELECT channel, ts, detail, sender, direction
           FROM pavan_preview.linkedin_timeline WHERE contact_id = $1 ORDER BY ts`, [contactId]),
      pool.query(
        `SELECT DISTINCT tag FROM pavan_preview.contact_tags WHERE contact_id = $1`, [contactId]),
      pool.query(
        `SELECT status FROM pavan_preview.linkedin_status WHERE contact_id = $1 LIMIT 1`, [contactId]),
      pool.query(
        `SELECT * FROM pavan_preview.contacts WHERE contact_id = $1 LIMIT 1`, [contactId]),
    ]);

    const timeline = [...emails.rows, ...linkedin.rows]
      .filter(r => r.ts)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

    res.json({
      found: true,
      contact: contact.rows[0] || null,
      linkedin_status: status.rows.length ? status.rows[0].status : 'unknown',
      tags: tags.rows.map(r => r.tag),
      timeline,
    });
  } catch (error) {
    console.error('Preview by-prospect timeline error:', error);
    res.status(500).json({ error: { message: 'Failed to load prospect history' } });
  }
});

// ── GET /api/preview/emails/:messageId ─────────────────────────
// Full body of one email, for inline expansion. Returns text + a flag
// telling the client whether the body is HTML.
router.get('/emails/:messageId', async (req, res) => {
  try {
    const messageId = req.params.messageId;
    const r = await pool.query(
      `SELECT
         doc->>'subject'                                   AS subject,
         doc->>'sender'                                    AS sender,
         coalesce(doc->>'body', doc->>'email_body')        AS body,
         (doc->'message_time'->>'$date')                   AS ts
       FROM stg.emails
       WHERE doc->>'message_id' = $1
       LIMIT 1`,
      [messageId]
    );
    if (!r.rows.length) return res.json({ found: false });
    const row = r.rows[0];
    const body = row.body || '';
    const isHtml = /<\s*(html|body|div|p|br|table|span|a)\b/i.test(body);
    res.json({ found: true, subject: row.subject, sender: row.sender, ts: row.ts, body, isHtml });
  } catch (error) {
    console.error('Preview email body error:', error);
    res.status(500).json({ error: { message: 'Failed to load email' } });
  }
});

module.exports = router;
