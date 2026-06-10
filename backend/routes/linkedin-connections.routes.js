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

module.exports = router;
