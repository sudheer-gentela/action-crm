// routes/linkedin-connections.routes.js
//
// Bulk sync of LinkedIn connection activity from the Chrome extension.
//
// POST /api/linkedin-connections/reconcile
//
//   Body:
//     {
//       kind:   'sent' | 'accepted',
//       viewer: { publicIdentifier, name?, memberUrn? },   // logged-in LinkedIn member (REQUIRED)
//       people: [ { publicIdentifier?, url?, name?, timeText? }, ... ]   // scraped rows (max 500)
//     }
//
//   Behaviour:
//     • Seat binding: viewer.publicIdentifier is bound to the calling GoWarm
//       user on first sync (user_linkedin_seats). If the seat already belongs
//       to a DIFFERENT user in the org → 409 SEAT_CONFLICT, nothing written.
//       This is what guarantees "only the rep who owns the LinkedIn login can
//       update their own prospects".
//     • Matching: slug-based, same expression as /api/prospects/by-linkedin-url
//       (case-insensitive, plus URL-decoded variant for unicode slugs).
//       NO fuzzy name matching — unmatched people are returned, not guessed.
//     • Scoping: only prospects with owner_id = the calling user are updated.
//       Slug matches owned by someone else are counted (matched_other_owner)
//       but never written.
//     • Writes (monotonic, idempotent — see LinkedInConnectionSyncService):
//         kind=accepted → connection_accepted (fills channel_data.linkedin.
//                         connected_at once; never overwrites; never
//                         downgrades a later status).
//         kind=sent     → connection_request_sent (counts outreach + stage
//                         auto-advance ONLY when the status wasn't already
//                         logged; otherwise at most backfills a missing
//                         request_sent_at).
//       occurred_at is parsed from the card's "… 6 days ago" text when
//       present, else now.
//
//   Response 200:
//     {
//       ok: true, kind,
//       seat: { public_identifier, newly_bound },
//       summary: {
//         received, matched_mine, matched_other_owner,
//         updated, timestamp_backfilled, already_recorded,
//         skipped_no_request, accepted_without_logged_request,
//         unmatched_count
//       },
//       updated:   [ { prospectId, name, slug, action, occurredAt } ],
//       unmatched: [ { slug, name } ]        // not in CRM (or no linkedin_url)
//     }
//
//   Errors: 400 bad payload · 409 SEAT_CONFLICT · 422 SEAT_UNKNOWN
//
// All routes org-scoped + authenticated, prospecting module required.

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

const Sync = require('../services/LinkedInConnectionSyncService');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

const MAX_PEOPLE = 500;

router.post('/reconcile', async (req, res) => {
  const { kind, viewer, people } = req.body || {};

  // ── Validate ──────────────────────────────────────────────────────────────
  if (kind !== 'sent' && kind !== 'accepted') {
    return res.status(400).json({ error: { message: "kind must be 'sent' or 'accepted'" } });
  }
  if (!Array.isArray(people) || people.length === 0) {
    return res.status(400).json({ error: { message: 'people must be a non-empty array' } });
  }
  if (people.length > MAX_PEOPLE) {
    return res.status(400).json({ error: { message: `people exceeds max of ${MAX_PEOPLE}` } });
  }
  if (!viewer || !viewer.publicIdentifier || !String(viewer.publicIdentifier).trim()) {
    // Without the LinkedIn seat identity we cannot attribute the sync —
    // refuse rather than guess. The extension surfaces this as "couldn't
    // identify the logged-in LinkedIn account".
    return res.status(422).json({
      error: { message: 'Could not identify the logged-in LinkedIn account (viewer.publicIdentifier missing)', code: 'SEAT_UNKNOWN' },
    });
  }

  const event = kind === 'accepted' ? 'connection_accepted' : 'connection_request_sent';
  const orgId  = req.orgId;
  const userId = req.user.userId;

  // ── Normalize scraped people → slugs ─────────────────────────────────────
  // Keep a slug → person map (first occurrence wins) so we can attach the
  // scraped name/timeText to the matched prospect's activity row.
  const personBySlug = new Map();   // lowercased primary slug → person
  const allVariants  = new Set();   // every match variant fed to SQL
  for (const p of people) {
    const raw = (p && (p.publicIdentifier || Sync.slugFromUrl(p.url))) || null;
    if (!raw) continue;
    const variants = Sync.slugVariants(raw);
    if (!variants.length) continue;
    const primary = variants[0];
    if (!personBySlug.has(primary)) {
      personBySlug.set(primary, {
        name:     (p.name || '').toString().slice(0, 200) || null,
        url:      (p.url  || '').toString().slice(0, 500) || null,
        timeText: (p.timeText || '').toString().slice(0, 120) || null,
        variants,
      });
    }
    variants.forEach(v => allVariants.add(v));
  }

  if (personBySlug.size === 0) {
    return res.status(400).json({ error: { message: 'No resolvable LinkedIn slugs in people[]' } });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // ── Seat binding (row-locked inside the txn) ────────────────────────────
    const seatRes = await Sync.bindSeat(client, { orgId, userId, viewer: {
      publicIdentifier: String(viewer.publicIdentifier).trim(),
      name:      viewer.name      ? String(viewer.name).slice(0, 200)      : null,
      memberUrn: viewer.memberUrn ? String(viewer.memberUrn).slice(0, 200) : null,
    }});
    if (!seatRes.ok) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: {
          code: 'SEAT_CONFLICT',
          message: `This LinkedIn account (${viewer.publicIdentifier}) is already linked to ${seatRes.boundTo}. ` +
                   `Sync from the LinkedIn account that belongs to you, or ask an admin to unlink it.`,
        },
      });
    }
    const viewerSlug = seatRes.seat.public_identifier;

    // ── Match prospects (all owners; updates restricted to mine) ───────────
    const matches = await Sync.matchProspectsBySlugs(client, {
      orgId, slugs: [...allVariants],
    });

    const mine   = matches.filter(m => m.owner_id === userId);
    const others = matches.filter(m => m.owner_id !== userId);

    // Resolve which scraped person a matched prospect corresponds to.
    const personForProspect = (row) => {
      // row.slug is the lowercased slug from the DB expression.
      if (personBySlug.has(row.slug)) return personBySlug.get(row.slug);
      for (const [, person] of personBySlug) {
        if (person.variants.includes(row.slug)) return person;
      }
      return { name: null, url: null, timeText: null, variants: [] };
    };

    // ── Apply events ────────────────────────────────────────────────────────
    const updated = [];
    let timestampBackfilled = 0;
    let alreadyRecorded     = 0;
    let skippedNoRequest    = 0;
    let acceptedNoRequest   = 0;

    for (const prospect of mine) {
      const person = personForProspect(prospect);
      const result = await Sync.applyConnectionEvent(client, {
        orgId, userId, prospect, event, person, viewerSlug,
      });

      if (result.action === 'updated') {
        updated.push({
          prospectId: prospect.id,
          name:  `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim() || person.name,
          slug:  prospect.slug,
          action: result.action,
          occurredAt: result.occurredAt,
        });
        if (event === 'connection_accepted' && result.requestNotLogged) acceptedNoRequest++;
      } else if (result.action === 'timestamp_backfill') {
        timestampBackfilled++;
        updated.push({
          prospectId: prospect.id,
          name:  `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim() || person.name,
          slug:  prospect.slug,
          action: result.action,
          occurredAt: result.occurredAt,
        });
      } else if (result.action === 'already_recorded') {
        alreadyRecorded++;
      } else if (result.action === 'skipped_no_request') {
        skippedNoRequest++;
      }
    }

    await client.query('COMMIT');

    // ── Unmatched report ────────────────────────────────────────────────────
    const matchedSlugSet = new Set();
    for (const m of matches) matchedSlugSet.add(m.slug);
    const unmatched = [];
    for (const [primary, person] of personBySlug) {
      const hit = person.variants.some(v => matchedSlugSet.has(v)) || matchedSlugSet.has(primary);
      if (!hit) unmatched.push({ slug: primary, name: person.name });
    }

    console.log(
      `🔗 linkedin-connections/reconcile kind=${kind} org=${orgId} user=${userId} seat=${viewerSlug} ` +
      `received=${personBySlug.size} mine=${mine.length} others=${others.length} ` +
      `updated=${updated.length} already=${alreadyRecorded} unmatched=${unmatched.length}`
    );

    res.json({
      ok: true,
      kind,
      seat: { public_identifier: viewerSlug, newly_bound: !!seatRes.seat.newly_bound },
      summary: {
        received:                        personBySlug.size,
        matched_mine:                    mine.length,
        matched_other_owner:             others.length,
        updated:                         updated.filter(u => u.action === 'updated').length,
        timestamp_backfilled:            timestampBackfilled,
        already_recorded:                alreadyRecorded,
        skipped_no_request:              skippedNoRequest,
        accepted_without_logged_request: acceptedNoRequest,
        unmatched_count:                 unmatched.length,
      },
      updated,
      unmatched,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('linkedin-connections/reconcile error:', err);
    res.status(500).json({ error: { message: 'Connection sync failed: ' + err.message } });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — member_urn backfill (design doc D3, final).
//
// Messaging payloads identify people ONLY by urn:li:fsd_profile:… (P1: no
// publicIdentifier anywhere), and prospects.member_urn coverage started at
// 0/38 (P0.2) because the URN is only captured on post-v1.20 profile views.
// These two endpoints power the extension's rep-triggered batch resolver:
// jittered 8–15s pacing, rep-clicked only, resumable (the backlog shrinks
// server-side as URNs land). Never called from a background alarm (R3).
//
// GET  /api/linkedin-connections/urn-backlog?limit=50
//   → { ok, backlog: [ { prospectId, slug, name, connected } ],
//       coverage: { with_urn, total } }   // among the caller's attributed prospects
//
// POST /api/linkedin-connections/urn-backfill
//   Body: { viewer, resolved: [ { slug, memberUrn } ] }  (max 100)
//   Seat-bound like /reconcile. member_urn is COALESCE-written — never
//   overwritten; a differing existing URN is reported as urn_mismatch and
//   left alone (slug reuse / profile change → human review, not clobber).
// ─────────────────────────────────────────────────────────────────────────────

const ATTRIBUTED_GATE = `
      channel_data->'linkedin'->>'request_sent_at' IS NOT NULL`;

router.get('/urn-backlog', async (req, res) => {
  const orgId  = req.orgId;
  const userId = req.user.userId;
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  try {
    const backlog = await db.query(
      `SELECT id AS "prospectId",
              lower(substring(linkedin_url from '/in/([^/?#]+)')) AS slug,
              trim(first_name || ' ' || last_name) AS name,
              (channel_data->'linkedin'->>'connected_at') IS NOT NULL AS connected
         FROM prospects
        WHERE org_id = $1 AND owner_id = $2 AND deleted_at IS NULL
          AND member_urn IS NULL
          AND linkedin_url IS NOT NULL
          AND lower(substring(linkedin_url from '/in/([^/?#]+)')) IS NOT NULL
          AND ${ATTRIBUTED_GATE}
        ORDER BY connected DESC, id ASC
        LIMIT $3`,
      [orgId, userId, limit]
    );
    const cov = await db.query(
      `SELECT count(*) FILTER (WHERE member_urn IS NOT NULL) AS with_urn,
              count(*) AS total
         FROM prospects
        WHERE org_id = $1 AND owner_id = $2 AND deleted_at IS NULL
          AND ${ATTRIBUTED_GATE}`,
      [orgId, userId]
    );
    res.json({
      ok: true,
      backlog: backlog.rows,
      coverage: {
        with_urn: parseInt(cov.rows[0].with_urn, 10),
        total:    parseInt(cov.rows[0].total, 10),
      },
    });
  } catch (err) {
    console.error('linkedin-connections/urn-backlog error:', err);
    res.status(500).json({ error: { message: 'Backlog fetch failed: ' + err.message } });
  }
});

const MAX_RESOLVED = 100;
// Mirrors the extension's own extraction regex (background.js /me + profile
// capture): fsd_profile preferred; fs_miniProfile tolerated and stored as-is
// (matching later normalizes on the trailing id — design doc §5.2).
const URN_RE = /^urn:li:fs[a-z]*_(?:miniProfile|profile):[A-Za-z0-9_-]+$/;

router.post('/urn-backfill', async (req, res) => {
  const { viewer, resolved } = req.body || {};
  if (!Array.isArray(resolved) || resolved.length === 0) {
    return res.status(400).json({ error: { message: 'resolved must be a non-empty array' } });
  }
  if (resolved.length > MAX_RESOLVED) {
    return res.status(400).json({ error: { message: `resolved exceeds max of ${MAX_RESOLVED}` } });
  }
  if (!viewer || !viewer.publicIdentifier || !String(viewer.publicIdentifier).trim()) {
    return res.status(422).json({
      error: { message: 'Could not identify the logged-in LinkedIn account (viewer.publicIdentifier missing)', code: 'SEAT_UNKNOWN' },
    });
  }

  const orgId  = req.orgId;
  const userId = req.user.userId;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const seatRes = await Sync.bindSeat(client, { orgId, userId, viewer: {
      publicIdentifier: String(viewer.publicIdentifier).trim(),
      name:      viewer.name      ? String(viewer.name).slice(0, 200)      : null,
      memberUrn: viewer.memberUrn ? String(viewer.memberUrn).slice(0, 200) : null,
    }});
    if (!seatRes.ok) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: {
          code: 'SEAT_CONFLICT',
          message: `This LinkedIn account (${viewer.publicIdentifier}) is already linked to ${seatRes.boundTo}.`,
        },
      });
    }
    const viewerSlug = seatRes.seat.public_identifier;

    let updated = 0, alreadyHad = 0, mismatch = 0, unmatched = 0, notOwned = 0, invalid = 0;
    const details = [];

    for (const r of resolved) {
      const rawSlug = r && (r.slug || Sync.slugFromUrl(r.url));
      const urn     = r && String(r.memberUrn || '').trim();
      const variants = Sync.slugVariants(rawSlug || '');
      if (!variants.length || !URN_RE.test(urn)) { invalid++; continue; }

      const found = await client.query(
        `SELECT id, owner_id, member_urn
           FROM prospects
          WHERE org_id = $1 AND deleted_at IS NULL AND linkedin_url IS NOT NULL
            AND lower(substring(linkedin_url from '/in/([^/?#]+)')) = ANY($2::text[])
          ORDER BY id ASC LIMIT 1
          FOR UPDATE`,
        [orgId, variants]
      );
      if (found.rows.length === 0) { unmatched++; continue; }
      const p = found.rows[0];
      if (p.owner_id !== userId)   { notOwned++;  continue; }
      if (p.member_urn) {
        if (p.member_urn === urn) alreadyHad++;
        else { mismatch++; details.push({ prospectId: p.id, slug: variants[0], reason: 'urn_mismatch' }); }
        continue;
      }

      await client.query(
        `UPDATE prospects
            SET member_urn = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND org_id = $3 AND member_urn IS NULL`,
        [urn, p.id, orgId]
      );
      await client.query(
        `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata, created_at)
         VALUES ($1, $2, $3, 'linkedin_event', 'LinkedIn identity resolved (URN backfill)', $4, now())`,
        [orgId, p.id, userId, JSON.stringify({
          event: 'member_urn_backfilled',
          channel: 'linkedin',
          source: 'extension_urn_backfill',
          member_urn: urn,
          linkedin_seat: viewerSlug,
        })]
      );
      updated++;
      details.push({ prospectId: p.id, slug: variants[0], reason: 'updated' });
    }

    await client.query('COMMIT');

    console.log(
      `🔗 linkedin-connections/urn-backfill org=${orgId} user=${userId} seat=${viewerSlug} ` +
      `received=${resolved.length} updated=${updated} already=${alreadyHad} mismatch=${mismatch} ` +
      `unmatched=${unmatched} not_owned=${notOwned} invalid=${invalid}`
    );

    res.json({
      ok: true,
      seat: { public_identifier: viewerSlug },
      summary: {
        received: resolved.length,
        updated, already_had_urn: alreadyHad, urn_mismatch: mismatch,
        unmatched, not_owned: notOwned, invalid,
      },
      details,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('linkedin-connections/urn-backfill error:', err);
    res.status(500).json({ error: { message: 'URN backfill failed: ' + err.message } });
  } finally {
    client.release();
  }
});

module.exports = router;
