// routes/linkedin-profiles.routes.js
//
// Canonical home for the LinkedIn profile data captured by the GoWarmCRM
// Chrome extension (about, work experience, education, activity).
//
// Single-table model — one row per (org_id, linkedin_slug) in the
// linkedin_profiles table. Profiles are joined back to prospects/contacts
// at read time on slug equality (extracted from prospects.linkedin_url and
// contacts.linkedin_url) — there is no explicit join table.
//
// Endpoints:
//
//   POST   /api/linkedin-profiles/upsert
//          Upsert captured profile data. Optionally accepts a link_to
//          { entity_type, entity_id } so the caller can flag which
//          prospect/contact triggered the capture — used for org-scoped
//          validation and dual-writing back to prospects.linkedin_* until
//          SkillContextService is migrated to read from this table.
//
//   GET    /api/linkedin-profiles/by-url?url=<linkedin url>
//          Fetch a profile by URL (slug-based lookup, same matching logic
//          as /api/prospects/by-linkedin-url).
//
//   GET    /api/linkedin-profiles/:id
//          Fetch a profile by id.
//
//   DELETE /api/linkedin-profiles/:id
//          Soft-delete a profile (deleted_at = NOW()).
//
// All routes are org-scoped (req.orgId) and require authentication.

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Same shape as the regex in prospects.routes.js by-linkedin-url. Keeping
// matching behaviour in lockstep means the same URL resolves to the same
// slug everywhere.
function extractSlug(url) {
  if (!url) return null;
  const m = String(url).match(/\/in\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : null;
}

// Truncate large free-text fields so a runaway scrape can't fill the table
// with megabytes of HTML. Limits chosen generously — the only goal is a
// floor against pathological input.
function clampStr(s, max) {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) : str;
}

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}

// Sanitize the captured experience array to a known shape.
function sanitizeExperience(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(x => x && typeof x === 'object')
    .slice(0, 30)
    .map(x => ({
      title:           clampStr(x.title, 255),
      company:         clampStr(x.company, 255),
      location:        clampStr(x.location, 255),
      start_date:      clampStr(x.start_date, 32),
      end_date:        clampStr(x.end_date, 32),
      duration_months: Number.isInteger(x.duration_months) ? x.duration_months : null,
      description:     clampStr(x.description, 4000),
    }));
}

function sanitizeEducation(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(x => x && typeof x === 'object')
    .slice(0, 15)
    .map(x => ({
      school:         clampStr(x.school, 255),
      degree:         clampStr(x.degree, 255),
      field_of_study: clampStr(x.field_of_study, 255),
      start_year:     asInt(x.start_year),
      end_year:       asInt(x.end_year),
    }));
}

function sanitizeActivity(arr) {
  if (!Array.isArray(arr)) return [];
  // Extension currently emits 'post' | 'comment' | 'reaction'. Keep the
  // allow-list narrow so junk doesn't slip through.
  const validKinds = new Set(['post', 'comment', 'reaction']);
  return arr
    .filter(x => x && typeof x === 'object' && validKinds.has(x.kind))
    .slice(0, 100)
    .map(x => ({
      id:                  clampStr(x.id, 64),
      kind:                x.kind,
      occurred_at:         x.occurred_at || null,
      relative_time:       clampStr(x.relative_time, 32),
      text:                clampStr(x.text, 8000),
      action:              clampStr(x.action, 64),
      source_url:          clampStr(x.source_url, 500),
      parent_post_summary: clampStr(x.parent_post_summary, 1000),
      parent_author:       clampStr(x.parent_author, 255),
    }));
}

// Merge incoming activity items with the existing array, deduping by id.
// Existing items win on conflict (so we don't overwrite a richer earlier
// capture with a thinner re-capture). Newly-seen items are appended.
// Cap at 200 to prevent unbounded growth.
function mergeActivity(existing, incoming) {
  const out  = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map(x => x?.id).filter(Boolean));
  for (const item of incoming) {
    if (!item.id || !seen.has(item.id)) {
      out.push(item);
      if (item.id) seen.add(item.id);
    }
  }
  return out.slice(-200);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/linkedin-profiles/upsert
// ─────────────────────────────────────────────────────────────────────────────
//
// Body shape (matches what the extension sends):
//   {
//     linkedin_url: 'https://www.linkedin.com/in/jdoe',
//     fields: {
//       full_name:  'Jane Doe',
//       headline:   'VP Sales @ Acme',
//       location:   'San Francisco, CA',
//       about:      '...',
//       experience: [...],
//       education:  [...],
//       activity:   [...],
//     },
//     source:  'extension',
//     link_to: { entity_type: 'prospects', entity_id: 123 }   // optional
//   }
//
// Behavior:
//   • Upsert by (org_id, slug). New rows get all fields; existing rows merge
//     section-by-section — sections present and NON-EMPTY in `fields` are
//     overwritten, sections missing/null/empty are left untouched. Protects
//     against partial captures (rep didn't scroll to Activity yet).
//
//     NOTE: this means a section can never be "zeroed out" by a capture —
//     once data exists, only a non-empty array overwrites it. Acceptable
//     for now since LinkedIn profiles don't shrink in practice. If we ever
//     need explicit-clear semantics, add an explicit `clear_sections: [...]`
//     field to the payload.
//
//   • Activity is *merged* by item id rather than overwritten, so each
//     capture accumulates more activity rather than replacing it.
//
//   • If link_to identifies a prospect in this org, the prospects.linkedin_*
//     legacy columns are dual-written so SkillContextService keeps working
//     until it reads from linkedin_profiles directly.
router.post('/upsert', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const {
      linkedin_url: rawUrl,
      fields = {},
      source = 'extension',
      link_to,
    } = req.body || {};

    if (!rawUrl) {
      return res.status(400).json({ error: { message: 'linkedin_url is required' } });
    }

    const slug = extractSlug(rawUrl);
    if (!slug) {
      return res.status(400).json({
        error: { message: 'Could not extract LinkedIn slug from linkedin_url' },
      });
    }

    // Validate link_to up front, before any writes.
    let linkProspectId = null;
    let linkContactId  = null;
    if (link_to && typeof link_to === 'object') {
      const t  = String(link_to.entity_type || '').toLowerCase();
      const id = asInt(link_to.entity_id);
      if (id == null || id <= 0) {
        return res.status(400).json({
          error: { message: 'link_to.entity_id must be a positive integer' },
        });
      }
      if (t === 'prospects' || t === 'prospect')      linkProspectId = id;
      else if (t === 'contacts' || t === 'contact')   linkContactId  = id;
      else {
        return res.status(400).json({
          error: { message: "link_to.entity_type must be 'prospects' or 'contacts'" },
        });
      }
    }

    // Extract + sanitize incoming sections. `undefined` distinguishes
    // "not sent" from "sent as []", but we treat both the same below
    // (only non-empty arrays overwrite — see partial-capture note above).
    const inFullName = clampStr(fields.full_name, 255);
    const inHeadline = clampStr(fields.headline, 4000);
    const inLocation = clampStr(fields.location, 255);
    const inAbout    = clampStr(fields.about, 16000);
    const inExp      = fields.experience !== undefined ? sanitizeExperience(fields.experience) : null;
    const inEdu      = fields.education  !== undefined ? sanitizeEducation(fields.education)   : null;
    const inActivity = fields.activity   !== undefined ? sanitizeActivity(fields.activity)     : null;

    await client.query('BEGIN');

    // Verify the link target belongs to this org. Don't trust client IDs.
    if (linkProspectId) {
      const r = await client.query(
        'SELECT id FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
        [linkProspectId, req.orgId]
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: { message: 'Prospect not found in this org' } });
      }
    }
    if (linkContactId) {
      const r = await client.query(
        'SELECT id FROM contacts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
        [linkContactId, req.orgId]
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: { message: 'Contact not found in this org' } });
      }
    }

    // Fetch existing row (if any) to support per-section merging.
    const existingRes = await client.query(
      `SELECT * FROM linkedin_profiles
       WHERE org_id = $1 AND linkedin_slug = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [req.orgId, slug]
    );
    const existing = existingRes.rows[0] || null;

    // Compute merged values.
    const merged = {
      full_name:  inFullName ?? existing?.full_name ?? null,
      headline:   inHeadline ?? existing?.headline  ?? null,
      location:   inLocation ?? existing?.location  ?? null,
      about:      inAbout    ?? existing?.about     ?? null,
      experience: inExp && inExp.length ? inExp : (existing?.experience || []),
      education:  inEdu && inEdu.length ? inEdu : (existing?.education  || []),
      activity:   inActivity ? mergeActivity(existing?.activity || [], inActivity)
                             : (existing?.activity || []),
    };

    const now = new Date();
    const basicsTouched   = (inFullName || inHeadline || inLocation) ? now : null;
    const aboutTouched    = inAbout != null               ? now : null;
    const expTouched      = inExp      && inExp.length    ? now : null;
    const eduTouched      = inEdu      && inEdu.length    ? now : null;
    const activityTouched = inActivity && inActivity.length ? now : null;

    let profile;
    if (!existing) {
      const insRes = await client.query(
        `INSERT INTO linkedin_profiles (
           org_id, linkedin_slug, linkedin_url,
           full_name, headline, location, about,
           experience, education, activity,
           source, last_captured_at,
           last_basics_captured_at, last_about_captured_at,
           last_exp_captured_at,    last_edu_captured_at,
           last_activity_captured_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,
                 $11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          req.orgId, slug, rawUrl,
          merged.full_name, merged.headline, merged.location, merged.about,
          JSON.stringify(merged.experience),
          JSON.stringify(merged.education),
          JSON.stringify(merged.activity),
          source, now,
          basicsTouched, aboutTouched, expTouched, eduTouched, activityTouched,
        ]
      );
      profile = insRes.rows[0];
    } else {
      const updRes = await client.query(
        `UPDATE linkedin_profiles SET
           linkedin_url   = $3,
           full_name      = $4,
           headline       = $5,
           location       = $6,
           about          = $7,
           experience     = $8::jsonb,
           education      = $9::jsonb,
           activity       = $10::jsonb,
           source         = $11,
           last_captured_at          = $12,
           last_basics_captured_at   = COALESCE($13, last_basics_captured_at),
           last_about_captured_at    = COALESCE($14, last_about_captured_at),
           last_exp_captured_at      = COALESCE($15, last_exp_captured_at),
           last_edu_captured_at      = COALESCE($16, last_edu_captured_at),
           last_activity_captured_at = COALESCE($17, last_activity_captured_at)
         WHERE id = $1 AND org_id = $2
         RETURNING *`,
        [
          existing.id, req.orgId, rawUrl,
          merged.full_name, merged.headline, merged.location, merged.about,
          JSON.stringify(merged.experience),
          JSON.stringify(merged.education),
          JSON.stringify(merged.activity),
          source, now,
          basicsTouched, aboutTouched, expTouched, eduTouched, activityTouched,
        ]
      );
      profile = updRes.rows[0];
    }

    // ── Dual-write to prospects.linkedin_* ─────────────────────────────────
    // Keeps SkillContextService working unchanged. TODO: drop this block
    // once SkillContextService.js reads from linkedin_profiles directly,
    // then write a 003_*.sql to drop those legacy columns.
    let linked = null;
    if (linkProspectId) {
      await client.query(
        `UPDATE prospects SET
           linkedin_url      = COALESCE($1, linkedin_url),
           linkedin_headline = COALESCE($2, linkedin_headline),
           linkedin_about    = COALESCE($3, linkedin_about),
           linkedin_activity = $4::jsonb,
           location          = COALESCE($5, location),
           updated_at        = CURRENT_TIMESTAMP
         WHERE id = $6 AND org_id = $7`,
        [
          rawUrl,
          merged.headline,
          merged.about,
          JSON.stringify(merged.activity),
          merged.location,
          linkProspectId,
          req.orgId,
        ]
      );
      linked = { entity_type: 'prospect', entity_id: linkProspectId };
    } else if (linkContactId) {
      // Contacts table only has linkedin_url; nothing else to dual-write.
      await client.query(
        `UPDATE contacts SET
           linkedin_url = COALESCE($1, linkedin_url),
           updated_at   = CURRENT_TIMESTAMP
         WHERE id = $2 AND org_id = $3`,
        [rawUrl, linkContactId, req.orgId]
      );
      linked = { entity_type: 'contact', entity_id: linkContactId };
    }

    await client.query('COMMIT');

    return res.json({
      profile_id: profile.id,
      profile,
      linked,
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    console.error('linkedin-profiles/upsert error:', err);
    return res.status(500).json({ error: { message: 'Failed to upsert LinkedIn profile' } });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/linkedin-profiles/by-url?url=...
// ─────────────────────────────────────────────────────────────────────────────
router.get('/by-url', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: { message: 'url query param is required' } });
    }
    const slug = extractSlug(url);
    if (!slug) {
      return res.status(400).json({ error: { message: 'Could not extract LinkedIn slug from url' } });
    }

    const r = await db.query(
      `SELECT * FROM linkedin_profiles
       WHERE org_id = $1 AND linkedin_slug = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [req.orgId, slug]
    );
    if (r.rows.length === 0) return res.json({ profile: null });

    return res.json({ profile: r.rows[0] });
  } catch (err) {
    console.error('linkedin-profiles/by-url error:', err);
    return res.status(500).json({ error: { message: 'Lookup failed' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/linkedin-profiles/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const id = asInt(req.params.id);
    if (id == null || id <= 0) {
      return res.status(400).json({ error: { message: 'Invalid id' } });
    }

    const r = await db.query(
      `SELECT * FROM linkedin_profiles
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [id, req.orgId]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Profile not found' } });
    }

    return res.json({ profile: r.rows[0] });
  } catch (err) {
    console.error('linkedin-profiles/:id error:', err);
    return res.status(500).json({ error: { message: 'Lookup failed' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/linkedin-profiles/:id  (soft-delete)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const id = asInt(req.params.id);
    if (id == null || id <= 0) {
      return res.status(400).json({ error: { message: 'Invalid id' } });
    }
    const r = await db.query(
      `UPDATE linkedin_profiles
       SET deleted_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [id, req.orgId]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Profile not found' } });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('linkedin-profiles delete error:', err);
    return res.status(500).json({ error: { message: 'Delete failed' } });
  }
});

module.exports = router;
