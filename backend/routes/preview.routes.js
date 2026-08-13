// ─────────────────────────────────────────────────────────────
// preview.routes.js  —  READ-ONLY staging preview (Mongo migration)
//
// Surfaces the migrated Mongo data (staged in stg.* / pavan_preview.*)
// so a user can validate their contacts + interaction history BEFORE
// anything is written to production tables. Writes nothing.
//
// Mount in app.js:  app.use('/api/preview', require('./routes/preview.routes'));
//
// ── ACCESS MODEL ─────────────────────────────────────────────
// authenticateToken -> orgContext (req.orgId, req.userId).
//
// The logged-in Postgres user is resolved to their Mongo user id via
// pavan_preview.user_map (stg.map_user). The mapping row must ALSO
// match the caller's org_id. A user with no mapping row, or a mapping
// row whose org_id is NULL or belongs to another org, gets nothing.
// Fails closed by design.
//
// PREREQUISITE: 04b_map_user_org_scope.sql must have been applied.
// It re-keys stg.map_user on pg_user_id (so several Postgres users can
// share one Mongo user) and adds org_id + mongo_tenant_id. Until it
// runs, user_map has no org_id column and every endpoint here returns
// empty — deploy order matters.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const { pool } = require('../config/database');

router.use(authenticateToken);
router.use(orgContext);

// ─────────────────────────────────────────────────────────────
// Resolve the logged-in PG user -> their migration mapping, scoped to
// the caller's org. Returns { mongoUserId, mongoTenantId } or null.
//
// The org_id predicate is what stops a mapped user in org A reading
// staged data belonging to org B. `org_id = $2` also excludes NULL
// org_id rows (NULL = NULL is never true), which is the intended
// fail-closed behaviour for a half-configured mapping.
// ─────────────────────────────────────────────────────────────
async function resolveMapping(pgUserId, orgId) {
  const { rows } = await pool.query(
    `SELECT mongo_user_id, mongo_tenant_id
       FROM pavan_preview.user_map
      WHERE pg_user_id = $1
        AND org_id     = $2
      LIMIT 1`,
    [pgUserId, orgId]
  );
  if (!rows.length) return null;
  return {
    mongoUserId:   rows[0].mongo_user_id,
    mongoTenantId: rows[0].mongo_tenant_id || null,
  };
}

// ── GET /api/preview/me ──────────────────────────────────────
// Whether this user has migrated data to preview, and summary counts.
// The frontend uses hasPreview to decide whether to render the History
// tab at all, so this must stay cheap and must never 500 into a
// permanently hidden tab.
router.get('/me', async (req, res) => {
  try {
    const mapping = await resolveMapping(req.userId, req.orgId);
    if (!mapping) return res.json({ hasPreview: false });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS contacts_with_activity
         FROM pavan_preview.contacts_with_activity
        WHERE mongo_user_id = $1`,
      [mapping.mongoUserId]
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
    const mapping = await resolveMapping(req.userId, req.orgId);
    if (!mapping) return res.json({ contacts: [], total: 0 });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const q = (req.query.q || '').trim().toLowerCase();
    const workspace = req.query.workspace || null;

    const params = [mapping.mongoUserId];
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
    const mapping = await resolveMapping(req.userId, req.orgId);
    if (!mapping) return res.status(403).json({ error: { message: 'No preview data for this user' } });

    const contactId = req.params.id;

    // guard: the contact must belong to this user's set
    const owns = await pool.query(
      `SELECT 1 FROM pavan_preview.user_contacts
        WHERE mongo_user_id = $1 AND contact_id = $2 LIMIT 1`,
      [mapping.mongoUserId, contactId]
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
          WHERE contact_id = $1 AND mongo_user_id = $2`, [contactId, mapping.mongoUserId]),
      pool.query(
        `SELECT status FROM pavan_preview.linkedin_status
          WHERE contact_id = $1 AND mongo_user_id = $2 LIMIT 1`, [contactId, mapping.mongoUserId]),
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
// Prospect-facing endpoints. These power:
//   • the History tab on the prospect detail page (by-prospect timeline)
//   • inline email-body expansion (single email fetch)
//
// Matching a Postgres prospect -> Mongo contact timeline:
//   1. external_refs.mongo_contact_id  (exact — set by the ETL load)
//   2. by email   (prospect.email -> stg.contact_emails)
//   3. by linkedin vanity slug (prospect.linkedin_url -> contact linkedin_url)
//   Returns { found:false } when none match -> UI shows "no history".
//
// Step 1 exists because step 2 is ambiguous: 215 addresses in
// stg.contact_emails map to more than one contact, and the lookup takes
// the first row with no ORDER BY. For those, the History tab could show
// a DIFFERENT person's correspondence, and could even return a different
// contact between two calls after a vacuum or plan change. Rows loaded
// by the ETL carry their exact contact id, so they bypass the guesswork
// entirely. Steps 2 and 3 are unchanged for everything else.
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

    // Migration mapping is required. Previously this endpoint was scoped
    // by org alone, so ANY user in the org saw the migrated timeline.
    // Now only users with a mapping row in their own org do; everyone
    // else gets the same {found:false} the UI already renders as the
    // "no migrated interaction history" empty state.
    const mapping = await resolveMapping(req.userId, req.orgId);
    if (!mapping) return res.json({ found: false });

    // load the prospect's identifiers, scoped to the caller's org
    const pr = await pool.query(
      `SELECT id, email, linkedin_url, first_name, last_name, external_refs
         FROM prospects WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [prospectId, req.orgId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: { message: 'Prospect not found' } });
    const p = pr.rows[0];

    // resolve to a mongo contact_id
    let contactId = null;
    let matchedBy = null;

    // (1) exact id stamped by the migration load — unambiguous
    const refs = p.external_refs || {};
    if (refs && typeof refs === 'object' && refs.mongo_contact_id) {
      contactId = String(refs.mongo_contact_id);
      matchedBy = 'external_refs';
    }

    // (2) email
    if (!contactId && p.email) {
      const r = await pool.query(
        `SELECT mongo_contact_id FROM stg.contact_emails
          WHERE email = lower($1)
          ORDER BY mongo_contact_id
          LIMIT 1`,
        [p.email]
      );
      if (r.rows.length) { contactId = r.rows[0].mongo_contact_id; matchedBy = 'email'; }
    }

    // (3) linkedin vanity slug
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
        if (r.rows.length) { contactId = r.rows[0].contact_id; matchedBy = 'linkedin'; }
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
      matched_by: matchedBy,
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
//
// This endpoint previously had NO scoping of any kind beyond
// authentication: any logged-in user in any org could fetch any staged
// email body by message_id. It is now gated twice —
//   (a) the caller must have a migration mapping in their own org, and
//   (b) the email's Mongo tenant_id must equal the tenant on that
//       mapping row.
// Only Aquarient mail is staged today, but (b) means the endpoint stays
// correct if another tenant's mail is ever loaded into stg.emails.
router.get('/emails/:messageId', async (req, res) => {
  try {
    const mapping = await resolveMapping(req.userId, req.orgId);
    if (!mapping || !mapping.mongoTenantId) return res.json({ found: false });

    const messageId = req.params.messageId;
    const r = await pool.query(
      `SELECT
         doc->>'subject'                                   AS subject,
         doc->>'sender'                                    AS sender,
         coalesce(doc->>'body', doc->>'email_body')        AS body,
         (doc->'message_time'->>'$date')                   AS ts
       FROM stg.emails
       WHERE doc->>'message_id' = $1
         AND doc->'tenant_id'->>'$oid' = $2
       LIMIT 1`,
      [messageId, mapping.mongoTenantId]
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
