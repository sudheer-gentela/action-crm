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
      // ── Repost-detection fields (v2 extension) ─────────────────────────
      // Extension v2 distinguishes original posts, plain reposts, and
      // quoted reposts (the prospect's commentary on top of someone else's
      // post). For quoted reposts these three fields capture the structure:
      //   commentary    — the prospect's own words above the embedded card
      //   quoted_text   — the body of the embedded original post
      //   quoted_author — the original author's name from the card
      // For plain reposts and originals these are typically null.
      // For legacy captures (pre-v2 extension) they will be undefined,
      // which clampStr safely converts to null.
      commentary:    clampStr(x.commentary, 8000),
      quoted_text:   clampStr(x.quoted_text, 8000),
      quoted_author: clampStr(x.quoted_author, 255),
      // ── Amplification provenance (v1.15 extension) ─────────────────────────
      // For a reposted/engaged COMPANY post, did it come from the prospect's
      // own (current) employer? Tri-state: true (slug == current employer),
      // false (a different company page), or 'unknown' (person/feed reposts,
      // authored posts, or employer slug not known). source_company_slug is the
      // /company/<slug> the item came from, when present. Lets segmentation
      // discount own-employer amplification without re-deriving it.
      is_own_company:      (x.is_own_company === true || x.is_own_company === false)
                             ? x.is_own_company : 'unknown',
      source_company_slug: clampStr(x.source_company_slug, 100),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Convert a LinkedIn-style relative time string ("1w", "3d", "5h", "2mo",
// "1y", "30s") into an absolute UTC ISO timestamp, anchored to `now`.
//
// Returns null if the string is unparseable. We're deliberately lenient
// about whitespace and punctuation because the strings come straight off
// LinkedIn's UI and have included things like "• 1w" in past captures.
//
// The buckets LinkedIn actually uses, observed in production:
//   s/sec   = seconds
//   m/min   = minutes  ← careful: 'm' alone here means minutes, NOT months
//   h/hr    = hours
//   d       = days
//   w       = weeks
//   mo      = months
//   y       = years
//
// Months are approximated as 30 days, years as 365. This is fine for sort
// ordering — we never display this derived timestamp to the user, only
// use it as a sort key. The original `relative_time` string is preserved
// on the item for display.
function parseRelativeTimeToOccurredAt(relStr, nowMs) {
  if (!relStr || typeof relStr !== 'string') return null;
  // Strip leading bullets, dots, whitespace.
  const cleaned = relStr.replace(/^[•·\s<]+/, '').trim();
  // Match: digits, optional space, unit. Unit can be 1-3 chars, letters only.
  const m = cleaned.match(/^(\d+)\s*([a-z]{1,3})\b/i);
  if (!m) return null;
  const n    = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n < 0) return null;

  let ms;
  switch (unit) {
    case 's':
    case 'sec':  ms = n * 1000; break;
    case 'm':
    case 'min':  ms = n * 60 * 1000; break;
    case 'h':
    case 'hr':   ms = n * 60 * 60 * 1000; break;
    case 'd':    ms = n * 24 * 60 * 60 * 1000; break;
    case 'w':    ms = n * 7  * 24 * 60 * 60 * 1000; break;
    case 'mo':   ms = n * 30 * 24 * 60 * 60 * 1000; break;
    case 'y':    ms = n * 365 * 24 * 60 * 60 * 1000; break;
    default:     return null;
  }
  return new Date(nowMs - ms).toISOString();
}

// Pick the best timestamp for sort ordering. Preference order:
//   1. derived from relative_time (the most accurate signal — it reflects
//      when LinkedIn says the post happened, not when we scraped it)
//   2. existing item.occurred_at, IF it looks like a real post date
//      (older than ~10 minutes) rather than a scrape-time marker
//   3. null — caller decides where unsorted items go (we send them last)
function bestOccurredAt(item, nowMs) {
  const fromRel = parseRelativeTimeToOccurredAt(item?.relative_time, nowMs);
  if (fromRel) return fromRel;
  // Fall back to occurred_at only if it's plausibly a real post date.
  // The extension stamps occurred_at = scrape-time, so values within a
  // few minutes of "now" are almost certainly that, not the post date.
  if (item?.occurred_at) {
    const t = Date.parse(item.occurred_at);
    if (Number.isFinite(t) && (nowMs - t) > 10 * 60 * 1000) {
      return item.occurred_at;
    }
  }
  return null;
}

// Merge incoming activity items with the existing array, deduping by id.
// Existing items win on body content (so we don't overwrite a richer
// earlier capture with a thinner re-capture), but we *do* refresh the
// relative_time and recompute occurred_at on re-encounter — the post is
// the same, but our time signals get updated. New items are appended.
//
// After merging, the array is sorted latest-first by derived occurred_at
// so every consumer of linkedin_activity (the prospect drawer, the API
// /by-url response, the extension's diff view) sees newest at the top
// without having to re-sort. Items with no parseable date sink to the
// bottom, preserving their relative order.
//
// Cap at 200 to prevent unbounded growth — the cap is applied AFTER
// sorting so we keep the 200 most-recent rather than the 200 oldest.
function mergeActivity(existing, incoming) {
  const nowMs = Date.now();
  const out   = Array.isArray(existing) ? existing.map(x => ({ ...x })) : [];
  const byId  = new Map();
  out.forEach((it, idx) => { if (it?.id) byId.set(it.id, idx); });

  for (const item of incoming) {
    if (item?.id && byId.has(item.id)) {
      // Re-encounter: refresh time signals on the existing item but
      // keep its body/text (the existing version may be richer).
      const idx  = byId.get(item.id);
      const prev = out[idx];
      out[idx] = {
        ...prev,
        relative_time: item.relative_time || prev.relative_time,
        occurred_at:   bestOccurredAt(item, nowMs) || prev.occurred_at || null,
      };
    } else {
      // New item — derive a real occurred_at if we can.
      out.push({
        ...item,
        occurred_at: bestOccurredAt(item, nowMs) || item.occurred_at || null,
      });
      if (item?.id) byId.set(item.id, out.length - 1);
    }
  }

  // Backfill: any pre-existing item whose occurred_at still smells like a
  // scrape-time marker (within 10min of now means it was set by an old
  // capture during this very request — but more relevantly, items written
  // before this version of the code shipped have scrape-time stamps from
  // their original capture date, which IS roughly when the post showed
  // a given relative_time, so they're actually OK as a sort key). We
  // only rewrite occurred_at if relative_time gives us a better answer.
  for (let i = 0; i < out.length; i++) {
    const it = out[i];
    if (!it) continue;
    const better = parseRelativeTimeToOccurredAt(it.relative_time, nowMs);
    if (better && (!it.occurred_at || Date.parse(it.occurred_at) > Date.parse(better) + 5 * 60 * 1000)) {
      // Trust derived only if it's meaningfully OLDER than what's stored
      // (stored value of "now" loses to derived value of "1w ago"). The
      // 5-min slack avoids churn on items whose values are already close.
      out[i] = { ...it, occurred_at: better };
    }
  }

  // Sort latest-first. Items with no occurred_at sink to the bottom while
  // preserving their relative order via a stable secondary key (original
  // index). Node's Array.prototype.sort is stable since v12.
  out.sort((a, b) => {
    const ta = a?.occurred_at ? Date.parse(a.occurred_at) : -Infinity;
    const tb = b?.occurred_at ? Date.parse(b.occurred_at) : -Infinity;
    return tb - ta;   // descending: latest first
  });

  // Cap at 200 most-recent.
  return out.slice(0, 200);
}

// ── Keyed section merge: experience / education (v1.22) ───────────────────────
//
// Replaces the old whole-array overwrite with a union keyed by a STABLE,
// flat composite identity. Deliberately not fuzzy: if a key field changes
// (a date added later, an edited title), the item gets a NEW key and is
// surfaced as a new role for the rep to adjudicate — the server never guesses
// two captures are the same role. See migration 2026_30 for the rationale.
const _norm = (s) => (s == null ? '' : String(s)).trim().toLowerCase().replace(/\s+/g, ' ');
function expItemKey(it) {
  return [_norm(it.company), _norm(it.title), _norm(it.start_date), _norm(it.end_date)].join('|');
}
function eduItemKey(it) {
  return [_norm(it.school), _norm(it.degree), _norm(it.start_year)].join('|');
}

// Per-field "richer wins" for the NON-key fields that can legitimately differ
// between two captures of the same item (key fields are identical by definition
// of a match, so only these vary). Longer non-empty string wins; a present
// number wins over null; an empty incoming value never blanks a stored value.
function richerValue(field, existingVal, incomingVal) {
  const isNum = field === 'duration_months' || field === 'end_year' || field === 'start_year';
  if (isNum) {
    if (incomingVal == null) return existingVal ?? null;
    return incomingVal;                               // present incoming wins (incl. over null)
  }
  const e = existingVal == null ? '' : String(existingVal);
  const i = incomingVal == null ? '' : String(incomingVal);
  if (i.length === 0) return existingVal ?? null;     // never blank out with empty
  if (e.length === 0) return incomingVal;
  return i.length >= e.length ? incomingVal : existingVal;   // richer (longer) wins
}

// Generic union merge for a keyed section. Returns { items, meta }.
//
//   suppressed key            → excluded from output, never resurrected by a scrape
//   matched key               → per field: a LOCKED field keeps its STORED value
//                               unless this request re-locks it (rep edited now);
//                               an unlocked field uses richerValue()
//   incoming key not existing → added as NEW (rep adjudicates any apparent dup)
//   existing key not incoming → retained as-is (union); last_seen unchanged
//   orphan meta (key gone, not suppressed) → pruned
//
// `directives` are this-request rep actions, keys already computed by the caller
// with the same field order as keyFn:
//   { lock:[{key,fields}], unlock:[{key,fields}], suppress:[key], unsuppress:[key] }
function mergeKeyedSection({ existingItems, incomingItems, keyFn, lockableFields,
                             sectionMeta, directives, now, sortFn }) {
  const fields = lockableFields;
  const meta   = { items: { ...(sectionMeta && sectionMeta.items ? sectionMeta.items : {}) } };
  // clone nested item-meta so we don't mutate the caller's object
  for (const k of Object.keys(meta.items)) {
    meta.items[k] = {
      locked_fields: [...(meta.items[k].locked_fields || [])],
      suppressed:    !!meta.items[k].suppressed,
      first_seen:    meta.items[k].first_seen || null,
      last_seen:     meta.items[k].last_seen  || null,
    };
  }
  const getMeta = (k) => (meta.items[k] ||
    (meta.items[k] = { locked_fields: [], suppressed: false, first_seen: now, last_seen: null }));

  // Apply this-request directives to meta first.
  const relockedNow = {};   // key -> Set(fields) the rep is setting in THIS request
  (directives && directives.lock || []).forEach(d => {
    const m = getMeta(d.key);
    relockedNow[d.key] = relockedNow[d.key] || new Set();
    (d.fields || []).filter(f => fields.includes(f)).forEach(f => {
      if (!m.locked_fields.includes(f)) m.locked_fields.push(f);
      relockedNow[d.key].add(f);
    });
  });
  (directives && directives.unlock || []).forEach(d => {
    const m = getMeta(d.key);
    m.locked_fields = m.locked_fields.filter(f => !(d.fields || []).includes(f));
  });
  (directives && directives.suppress   || []).forEach(k => { getMeta(k).suppressed = true;  });
  (directives && directives.unsuppress || []).forEach(k => { getMeta(k).suppressed = false; });

  const existingByKey = new Map();
  (existingItems || []).forEach(it => existingByKey.set(keyFn(it), it));

  const out = [];
  const usedKeys = new Set();
  const seenIncoming = new Set();

  for (const inc of (incomingItems || [])) {
    const k = keyFn(inc);
    if (seenIncoming.has(k)) continue;        // dedupe identical items within one capture
    seenIncoming.add(k);
    const m = getMeta(k);
    m.last_seen = now;
    if (m.suppressed) { usedKeys.add(k); continue; }   // rep removed it — stays gone

    const prev = existingByKey.get(k);
    if (prev) {
      const merged = { ...prev };
      for (const f of fields) {
        if (m.locked_fields.includes(f)) {
          merged[f] = (relockedNow[k] && relockedNow[k].has(f)) ? inc[f] : prev[f];
        } else {
          merged[f] = richerValue(f, prev[f], inc[f]);
        }
      }
      out.push(merged);
    } else {
      m.first_seen = m.first_seen || now;
      out.push({ ...inc });
    }
    usedKeys.add(k);
  }

  // Retain existing items not present in this capture (union), unless suppressed.
  for (const it of (existingItems || [])) {
    const k = keyFn(it);
    if (usedKeys.has(k)) continue;
    if (meta.items[k] && meta.items[k].suppressed) continue;
    out.push(it);
    usedKeys.add(k);
  }

  // Prune orphan meta: keys no longer present AND not suppressed.
  for (const k of Object.keys(meta.items)) {
    if (!usedKeys.has(k) && !meta.items[k].suppressed) delete meta.items[k];
  }

  if (sortFn) out.sort(sortFn);
  return { items: out, meta };
}

// Sort experience current-first: open-ended roles (no end_date) first, then by
// start_date descending. Education: most-recent end/start year first.
function sortExperience(a, b) {
  const aOpen = !a.end_date, bOpen = !b.end_date;
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  const as = a.start_date ? Date.parse(a.start_date) : -Infinity;
  const bs = b.start_date ? Date.parse(b.start_date) : -Infinity;
  return bs - as;
}
function sortEducation(a, b) {
  const ay = a.end_year || a.start_year || -Infinity;
  const by = b.end_year || b.start_year || -Infinity;
  return by - ay;
}

// Build the directives object the merge expects from the client's `edits` block
// for one section. The client sends key FIELDS; we recompute the composite key
// here with the same keyFn so client and server never disagree on identity.
function buildDirectives(sectionEdits, keyFn) {
  if (!sectionEdits || typeof sectionEdits !== 'object') return {};
  const k = (kf) => keyFn(kf || {});
  return {
    lock:       (sectionEdits.lock       || []).map(d => ({ key: k(d.key), fields: d.fields || [] })),
    unlock:     (sectionEdits.unlock     || []).map(d => ({ key: k(d.key), fields: d.fields || [] })),
    suppress:   (sectionEdits.suppress   || []).map(kf => k(kf)),
    unsuppress: (sectionEdits.unsuppress || []).map(kf => k(kf)),
  };
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
      // v1.20: durable fsd_profile URN, COALESCE-persisted onto the linked
      // prospect's member_urn (never overwrites an existing good one).
      member_urn = null,
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

    const now = new Date();
    const nowIso = now.toISOString();

    // Rep edit directives for this request (locks / unlocks / suppress /
    // unsuppress), recomputed into composite keys server-side. `edits` is
    // optional; a plain scrape sends none.
    const edits = (req.body && typeof req.body.edits === 'object' && req.body.edits) || {};
    const existingMeta = (existing && existing.capture_meta) || {};

    // Run the keyed merge for a section when the client sent that section
    // (non-empty OR explicit []), or when there are directives to apply even
    // without a re-capture (e.g. a rep removing a role from the panel). When
    // neither, leave the stored section and its meta untouched.
    const hasDir = (sec) => sec && (
      (sec.lock && sec.lock.length) || (sec.unlock && sec.unlock.length) ||
      (sec.suppress && sec.suppress.length) || (sec.unsuppress && sec.unsuppress.length));

    let mergedExp  = existing?.experience || [];
    let mergedEdu  = existing?.education  || [];
    let expMeta    = existingMeta.experience || { items: {} };
    let eduMeta    = existingMeta.education  || { items: {} };

    if (inExp !== null || hasDir(edits.experience)) {
      const r = mergeKeyedSection({
        existingItems:  existing?.experience || [],
        incomingItems:  inExp || [],
        keyFn:          expItemKey,
        lockableFields: ['location', 'description', 'duration_months'],
        sectionMeta:    expMeta,
        directives:     buildDirectives(edits.experience, expItemKey),
        now:            nowIso,
        sortFn:         sortExperience,
      });
      mergedExp = r.items; expMeta = r.meta;
    }
    if (inEdu !== null || hasDir(edits.education)) {
      const r = mergeKeyedSection({
        existingItems:  existing?.education || [],
        incomingItems:  inEdu || [],
        keyFn:          eduItemKey,
        lockableFields: ['field_of_study', 'end_year'],
        sectionMeta:    eduMeta,
        directives:     buildDirectives(edits.education, eduItemKey),
        now:            nowIso,
        sortFn:         sortEducation,
      });
      mergedEdu = r.items; eduMeta = r.meta;
    }

    // Compute merged values.
    const merged = {
      full_name:  inFullName ?? existing?.full_name ?? null,
      headline:   inHeadline ?? existing?.headline  ?? null,
      location:   inLocation ?? existing?.location  ?? null,
      about:      inAbout    ?? existing?.about     ?? null,
      experience: mergedExp,
      education:  mergedEdu,
      activity:   inActivity ? mergeActivity(existing?.activity || [], inActivity)
                             : (existing?.activity || []),
    };

    // capture_meta carries per-item merge bookkeeping (locks/suppressions/
    // provenance) in a SEPARATE column so the section arrays stay clean for
    // consumers. Preserve any other keys already present.
    const mergedCaptureMeta = {
      ...(existing?.capture_meta || {}),
      experience: expMeta,
      education:  eduMeta,
    };

    const basicsTouched   = (inFullName || inHeadline || inLocation) ? now : null;
    const aboutTouched    = inAbout != null               ? now : null;
    // "touched" reflects an actual capture of that section (non-empty incoming),
    // independent of merge outcome, so the *_captured_at stamps stay meaningful.
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
           last_activity_captured_at,
           capture_meta
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,
                 $11,$12,$13,$14,$15,$16,$17,$18::jsonb)
         RETURNING *`,
        [
          req.orgId, slug, rawUrl,
          merged.full_name, merged.headline, merged.location, merged.about,
          JSON.stringify(merged.experience),
          JSON.stringify(merged.education),
          JSON.stringify(merged.activity),
          source, now,
          basicsTouched, aboutTouched, expTouched, eduTouched, activityTouched,
          JSON.stringify(mergedCaptureMeta),
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
           last_activity_captured_at = COALESCE($17, last_activity_captured_at),
           capture_meta              = $18::jsonb
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
          JSON.stringify(mergedCaptureMeta),
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
           member_urn        = COALESCE(member_urn, $8),
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
          member_urn || null,
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

    // For prospect links, also surface the prospect's account_id so the
    // extension can show it in debug mode. Cheap one-row lookup, kept
    // outside the transaction since the COMMIT is already done.
    let accountId = null;
    if (linkProspectId) {
      const accRes = await client.query(
        'SELECT account_id FROM prospects WHERE id = $1 AND org_id = $2',
        [linkProspectId, req.orgId]
      );
      accountId = accRes.rows[0]?.account_id || null;
    }

    return res.json({
      profile_id: profile.id,
      profile,
      linked,
      account_id: accountId,
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
