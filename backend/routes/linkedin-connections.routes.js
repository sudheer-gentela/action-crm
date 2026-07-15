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
        // Sync-order fix: acceptance just landed — messages harvested BEFORE
        // it were ledgered uncounted; count the newly-qualifying ones now.
        if (event === 'connection_accepted') {
          await Sync.retroCountUncounted(client, { orgId, userId, prospect, viewerSlug });
        }
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

// ─────────────────────────────────────────────────────────────────────────────
// P3 — inbox message reconciliation (design doc §5–6).
//
// POST /api/linkedin-connections/reconcile-messages
//
//   Body:
//     {
//       viewer:  { publicIdentifier, name?, memberUrn? },       // REQUIRED
//       threads: [ {
//         threadUrn,                 // urn:li:messagingThread:<id> (backendConversationUrn)
//         participantUrn,            // non-SELF hostIdentityUrn (fsd_profile) — 1:1 threads only
//         participantDistance?,      // 'DISTANCE_1' etc — D9 verification signal
//         messages: [ { urn,         // urn:li:messagingMessage:<id> (backendUrn — ledger key)
//                       senderUrn, senderDistance, deliveredAt /* epoch ms */ } ]
//       } ]   (≤100 threads, ≤1000 messages total)
//     }
//
//   The extension parses LinkedIn payloads locally and sends ONLY identity/
//   timing fields — message text never reaches the server (D6 by construction).
//
//   Semantics:
//     • Seat-bound like /reconcile (409 SEAT_CONFLICT).
//     • Match: URN-only vs prospects.member_urn (D2). Others' prospects counted,
//       never written. Group threads: extension must not send them; a thread
//       whose participantUrn is missing is skipped.
//     • Attribution gate at INGEST (D5): prospects without request_sent_at →
//       nothing persisted (dropped_unattributed).
//     • Ledger: INSERT … ON CONFLICT DO NOTHING on (org_id, message_urn).
//       Counters/status bump ONLY when the row inserted AND
//       passesPostAcceptanceGate (F14 — invite notes are ledgered, not counted).
//     • Direction: deriveDirection (SELF/URN cross-check); conflicts skipped
//       entirely (D8) and reported.
//     • Verification (D9): participantDistance DISTANCE_1 stamps
//       channel_data.linkedin.connection_verified_at (forward-only). A
//       non-DISTANCE_1 on a CRM-connected prospect records a
//       verification_mismatch activity — NEVER downgrades.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_THREADS = 100;
const MAX_MESSAGES_TOTAL = 1000;
const MSG_URN_RE = /^urn:li:messagingMessage:[A-Za-z0-9=_-]+$/;

router.post('/reconcile-messages', async (req, res) => {
  const { viewer, threads } = req.body || {};

  if (!Array.isArray(threads) || threads.length === 0) {
    return res.status(400).json({ error: { message: 'threads must be a non-empty array' } });
  }
  if (threads.length > MAX_THREADS) {
    return res.status(400).json({ error: { message: `threads exceeds max of ${MAX_THREADS}` } });
  }
  const totalMessages = threads.reduce((n, t) => n + (Array.isArray(t && t.messages) ? t.messages.length : 0), 0);
  if (totalMessages === 0) {
    return res.status(400).json({ error: { message: 'no messages in payload' } });
  }
  if (totalMessages > MAX_MESSAGES_TOTAL) {
    return res.status(400).json({ error: { message: `messages exceed max of ${MAX_MESSAGES_TOTAL}` } });
  }
  if (!viewer || !viewer.publicIdentifier || !String(viewer.publicIdentifier).trim()) {
    return res.status(422).json({
      error: { message: 'Could not identify the logged-in LinkedIn account (viewer.publicIdentifier missing)', code: 'SEAT_UNKNOWN' },
    });
  }

  const orgId  = req.orgId;
  const userId = req.user.userId;
  const nowIso = new Date().toISOString();

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

    // ── Match participants by URN (D2: URN-only) ───────────────────────────
    const participantUrns = [...new Set(
      threads.map(t => t && t.participantUrn).filter(u => Sync.normalizeUrnId(u))
    )];
    const matches = participantUrns.length
      ? await Sync.matchProspectsByUrns(client, { orgId, urns: participantUrns })
      : [];
    const byUrn = new Map(matches.map(m => [m.member_urn, m]));

    const s = {
      received_threads: threads.length, received_messages: totalMessages,
      matched_mine: 0, matched_other_owner: 0, no_urn_match: 0,
      dropped_unattributed: 0, inserted: 0, already_recorded: 0,
      counted: 0, ledgered_uncounted: 0, direction_conflicts_skipped: 0,
      invalid_messages: 0, verified: 0, verification_mismatches: 0,
    };
    const updated = [];

    for (const t of threads) {
      const pUrn = t && t.participantUrn;
      if (!Sync.normalizeUrnId(pUrn)) { s.no_urn_match++; continue; }
      const prospect = byUrn.get(pUrn);
      if (!prospect) { s.no_urn_match++; continue; }
      if (prospect.owner_id !== userId) { s.matched_other_owner++; continue; }
      s.matched_mine++;

      const channelData = prospect.channel_data || {};
      const li = channelData.linkedin || {};

      // Attribution gate at ingest (D5) — nothing persisted for unattributed.
      if (!li.request_sent_at) { s.dropped_unattributed++; continue; }

      // ── D9 verification signal ────────────────────────────────────────────
      let channelDataDirty = false;
      if (t.participantDistance === 'DISTANCE_1') {
        if (!li.connection_verified_at || Date.parse(nowIso) > Date.parse(li.connection_verified_at)) {
          li.connection_verified_at = nowIso;
          channelData.linkedin = li;
          prospect.channel_data = channelData;
          channelDataDirty = true;
          s.verified++;
        }
      } else if (t.participantDistance && li.connected_at) {
        s.verification_mismatches++;
        await client.query(
          `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata, created_at)
           VALUES ($1, $2, $3, 'linkedin_event', 'LinkedIn verification mismatch: CRM shows connected but messaging distance disagrees', $4, now())`,
          [orgId, prospect.id, userId, JSON.stringify({
            event: 'verification_mismatch', channel: 'linkedin',
            source: 'extension_message_sync',
            crm_status: li.connection_status || null,
            observed_distance: String(t.participantDistance).slice(0, 40),
            thread_urn: String(t.threadUrn || '').slice(0, 200) || null,
            linkedin_seat: viewerSlug,
          })]
        );
      }

      // ── Messages ──────────────────────────────────────────────────────────
      let appliedForProspect = 0;
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      for (const m of msgs) {
        const urn = m && String(m.urn || '').trim();
        const deliveredMs = m && Number(m.deliveredAt);
        if (!MSG_URN_RE.test(urn) || !Number.isFinite(deliveredMs) || deliveredMs <= 0) {
          s.invalid_messages++; continue;
        }
        const occurredAtIso = new Date(deliveredMs).toISOString();

        const direction = Sync.deriveDirection({
          senderDistance: m.senderDistance, senderUrn: m.senderUrn, participantUrn: pUrn,
        });
        if (!direction) { s.direction_conflicts_skipped++; continue; }  // D8

        const counted = Sync.passesPostAcceptanceGate(li, occurredAtIso);

        const ins = await client.query(
          `INSERT INTO linkedin_message_events
                  (org_id, prospect_id, user_id, seat, message_urn, thread_urn, direction, counted, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (org_id, message_urn) DO NOTHING
           RETURNING id`,
          [orgId, prospect.id, userId, viewerSlug, urn,
           String(t.threadUrn || '').slice(0, 200) || null, direction, counted, occurredAtIso]
        );
        if (ins.rows.length === 0) { s.already_recorded++; continue; }
        s.inserted++;

        if (!counted) { s.ledgered_uncounted++; continue; }   // F14: ledgered, never counted
        s.counted++;

        await Sync.applyConnectionEvent(client, {
          orgId, userId, prospect,
          event: direction === 'inbound' ? 'reply_received' : 'message_sent',
          viewerSlug,
          message: { urn, threadUrn: t.threadUrn || null, direction, occurredAtIso },
        });
        appliedForProspect++;
        channelDataDirty = false;   // apply persisted channel_data (incl. verified stamp)
      }

      // Verified stamp with no counted messages → persist it explicitly.
      if (channelDataDirty && appliedForProspect === 0) {
        await client.query(
          `UPDATE prospects SET channel_data = $1::jsonb, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND org_id = $3`,
          [JSON.stringify(prospect.channel_data), prospect.id, orgId]
        );
      }

      if (appliedForProspect > 0) {
        updated.push({
          prospectId: prospect.id,
          name: `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim(),
          applied: appliedForProspect,
        });
      }
    }

    await client.query('COMMIT');

    console.log(
      `🔗 linkedin-connections/reconcile-messages org=${orgId} user=${userId} seat=${viewerSlug} ` +
      `threads=${s.received_threads} msgs=${s.received_messages} mine=${s.matched_mine} ` +
      `inserted=${s.inserted} counted=${s.counted} already=${s.already_recorded} ` +
      `unattributed=${s.dropped_unattributed} conflicts=${s.direction_conflicts_skipped} verified=${s.verified}`
    );

    res.json({
      ok: true,
      seat: { public_identifier: viewerSlug, newly_bound: !!seatRes.seat.newly_bound },
      summary: s,
      updated,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('linkedin-connections/reconcile-messages error:', err);
    res.status(500).json({ error: { message: 'Message sync failed: ' + err.message } });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Thread-Map Sweep (F17/D13). The ledger doubles as the prospect↔thread map:
// every reconciled message stored its thread_urn, including uncounted rows —
// so one thread open per prospect, ever, is the entire bootstrap cost, and
// new mappings arrive naturally (reps open replies to read them). The
// extension sweeps this map with per-thread replay of LinkedIn's own
// last-N-messages fetch — no thread opens in steady state.
//
// GET /api/linkedin-connections/thread-map
//   → { ok, map: [ { prospectId, threadUrn, memberUrn, name, lastSeenAt } ] }
//   Caller-owned, attributed prospects only; latest thread per prospect.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/thread-map', async (req, res) => {
  const orgId  = req.orgId;
  const userId = req.user.userId;
  try {
    const map = await db.query(
      `SELECT DISTINCT ON (lme.prospect_id)
              lme.prospect_id                       AS "prospectId",
              lme.thread_urn                        AS "threadUrn",
              p.member_urn                          AS "memberUrn",
              trim(p.first_name || ' ' || p.last_name) AS name,
              lme.occurred_at                       AS "lastSeenAt"
         FROM linkedin_message_events lme
         JOIN prospects p
           ON p.id = lme.prospect_id AND p.org_id = lme.org_id
        WHERE lme.org_id = $1
          AND p.owner_id = $2
          AND p.deleted_at IS NULL
          AND lme.thread_urn IS NOT NULL
          AND p.member_urn IS NOT NULL
          AND p.channel_data->'linkedin'->>'request_sent_at' IS NOT NULL
        ORDER BY lme.prospect_id, lme.occurred_at DESC`,
      [orgId, userId]
    );
    res.json({ ok: true, map: map.rows });
  } catch (err) {
    console.error('linkedin-connections/thread-map error:', err);
    res.status(500).json({ error: { message: 'Thread map fetch failed: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P5b — funnel drill-through + follow-up action generation.
//
// GET /api/linkedin-connections/funnel
//   Per-prospect lifecycle rows for the calling user's attributed prospects
//   (drill-through, not aggregates — the denominator is small enough to read).
//   "followed_up" uses the F18 definition (invite notes excluded via the
//   request_sent_at + 2h clause; F11's 48h acceptance tolerance retained).
//
// POST /api/linkedin-connections/generate-followup-actions
//   Manual/cron trigger for LinkedInFollowupActionService.runForOrg — creates
//   and auto-resolves 'reply waiting' and 'accepted, no follow-up' actions in
//   the standard prospecting_actions queue.
// ─────────────────────────────────────────────────────────────────────────────
const FollowupActions = require('../services/LinkedInFollowupActionService');

router.get('/funnel', async (req, res) => {
  const orgId  = req.orgId;
  const userId = req.user.userId;
  try {
    const rows = await db.query(
      `SELECT p.id AS "prospectId",
              trim(p.first_name || ' ' || p.last_name)          AS name,
              p.company_name                                    AS company,
              p.linkedin_url                                    AS "linkedinUrl",
              p.member_urn IS NOT NULL                          AS "identityResolved",
              p.channel_data->'linkedin'->>'request_sent_at'    AS "requestSentAt",
              p.channel_data->'linkedin'->>'connected_at'       AS "connectedAt",
              p.channel_data->'linkedin'->>'connection_verified_at' AS "verifiedAt",
              p.channel_data->'linkedin'->>'connection_status'  AS "liStatus",
              fo.first_followup                                 AS "firstFollowupAt",
              li.last_inbound                                   AS "lastReplyAt",
              li.inbound_count                                  AS "replyCount",
              li.thread_urn                                     AS "threadUrn",
              CASE WHEN li.thread_urn IS NOT NULL THEN
                'https://www.linkedin.com/messaging/thread/' ||
                replace(li.thread_urn, 'urn:li:messagingThread:', '') || '/'
              END                                               AS "threadUrl"
         FROM prospects p
         LEFT JOIN LATERAL (
           SELECT min(q.occurred_at) AS first_followup
             FROM linkedin_message_events q
            WHERE q.org_id = p.org_id AND q.prospect_id = p.id
              AND q.direction = 'outbound'
              AND q.occurred_at > GREATEST(
                    (p.channel_data->'linkedin'->>'request_sent_at')::timestamptz + interval '2 hours',
                    (p.channel_data->'linkedin'->>'connected_at')::timestamptz   - interval '48 hours')
         ) fo ON true
         LEFT JOIN LATERAL (
           SELECT max(occurred_at) FILTER (WHERE direction = 'inbound' AND counted) AS last_inbound,
                  count(*)         FILTER (WHERE direction = 'inbound' AND counted) AS inbound_count,
                  (array_agg(thread_urn ORDER BY occurred_at DESC)
                     FILTER (WHERE thread_urn IS NOT NULL))[1]                      AS thread_urn
             FROM linkedin_message_events
            WHERE org_id = p.org_id AND prospect_id = p.id
         ) li ON true
        WHERE p.org_id = $1 AND p.owner_id = $2 AND p.deleted_at IS NULL
          AND p.channel_data->'linkedin'->>'request_sent_at' IS NOT NULL
        ORDER BY (p.channel_data->'linkedin'->>'connected_at') DESC NULLS LAST,
                 (p.channel_data->'linkedin'->>'request_sent_at') DESC`,
      [orgId, userId]
    );

    const r = rows.rows;
    const stage = (x) => x.lastReplyAt ? 'replied'
                 : x.firstFollowupAt   ? 'followed_up'
                 : x.connectedAt       ? 'accepted'
                 :                       'requested';
    const summary = { requested: r.length, accepted: 0, followed_up: 0, replied: 0 };
    for (const x of r) {
      const s = stage(x);
      if (s !== 'requested') summary.accepted++;
      if (s === 'followed_up' || s === 'replied') summary.followed_up++;
      if (s === 'replied') summary.replied++;
      x.stage = s;
    }
    // Boundary honesty (design doc §11/N6): shown with the table in the UI.
    res.json({
      ok: true, summary, rows: r,
      caveats: [
        'Messages sent via Sales Navigator or the LinkedIn mobile app are not visible until the thread is opened once in Chrome.',
        'Freshness is bounded by the last message sync.',
      ],
    });
  } catch (err) {
    console.error('linkedin-connections/funnel error:', err);
    res.status(500).json({ error: { message: 'Funnel fetch failed: ' + err.message } });
  }
});

router.post('/generate-followup-actions', async (req, res) => {
  try {
    // Catch-all retro-count first (sync-order fix): count messages that were
    // harvested before their prospect's acceptance was synced, regardless of
    // which writer set connected_at — so actions generate from honest counters.
    const retro = await Sync.retroCountSweep(db, req.orgId);
    const result = await FollowupActions.runForOrg(db, req.orgId);
    console.log('🔗 linkedin-connections/generate-followup-actions',
      JSON.stringify({ retro, ...result }));
    res.json({ ok: true, retro, result });
  } catch (err) {
    console.error('linkedin-connections/generate-followup-actions error:', err);
    res.status(500).json({ error: { message: 'Action generation failed: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-campaign reply-stop setting (2026_50). Lives here rather than in
// prospecting-campaigns.routes.js deliberately: that route's UPDATE is a
// fixed-column partial update under active parallel development — a
// self-contained pair of endpoints is safer than widening it from a snapshot.
//
// GET /api/linkedin-connections/reply-stop-settings
//   → { ok, campaigns: [ { id, name, status, stopOnReply } ] }   (org-scoped)
// PUT /api/linkedin-connections/reply-stop-settings
//   Body: { campaignId, stopOnReply }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reply-stop-settings', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, name, status, stop_on_reply AS "stopOnReply"
         FROM prospecting_campaigns
        WHERE org_id = $1
        ORDER BY (status = 'active') DESC, name ASC`,
      [req.orgId]
    );
    res.json({ ok: true, campaigns: rows.rows });
  } catch (err) {
    console.error('linkedin-connections/reply-stop-settings GET error:', err);
    res.status(500).json({ error: { message: 'Settings fetch failed: ' + err.message } });
  }
});

router.put('/reply-stop-settings', async (req, res) => {
  const { campaignId, stopOnReply } = req.body || {};
  const id = parseInt(campaignId, 10);
  if (!Number.isFinite(id) || typeof stopOnReply !== 'boolean') {
    return res.status(400).json({ error: { message: 'campaignId (int) and stopOnReply (boolean) required' } });
  }
  try {
    const upd = await db.query(
      `UPDATE prospecting_campaigns
          SET stop_on_reply = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND org_id = $3
        RETURNING id, name, stop_on_reply AS "stopOnReply"`,
      [stopOnReply, id, req.orgId]
    );
    if (!upd.rows.length) return res.status(404).json({ error: { message: 'Campaign not found' } });
    console.log(`🔗 reply-stop-settings org=${req.orgId} user=${req.user.userId} campaign=${id} stopOnReply=${stopOnReply}`);
    res.json({ ok: true, campaign: upd.rows[0] });
  } catch (err) {
    console.error('linkedin-connections/reply-stop-settings PUT error:', err);
    res.status(500).json({ error: { message: 'Settings update failed: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/linkedin-connections/funnel/:prospectId — drill-down for one row.
// Returns the prospect's LinkedIn lifecycle fields, the message ledger
// (direction/counted/timestamps ONLY — message text never reaches the server,
// D12, so there is none to show), and the LinkedIn-channel activity trail.
// Owner-scoped like the funnel itself.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/funnel/:prospectId', async (req, res) => {
  const orgId  = req.orgId;
  const userId = req.user.userId;
  const pid    = parseInt(req.params.prospectId, 10);
  if (!Number.isFinite(pid)) return res.status(400).json({ error: { message: 'Bad prospect id' } });
  try {
    const pr = await db.query(
      `SELECT id, trim(first_name || ' ' || last_name) AS name,
              company_name AS company, linkedin_url AS "linkedinUrl",
              member_urn IS NOT NULL AS "identityResolved", stage,
              channel_data->'linkedin' AS li
         FROM prospects
        WHERE id = $1 AND org_id = $2 AND owner_id = $3 AND deleted_at IS NULL`,
      [pid, orgId, userId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: { message: 'Prospect not found' } });

    const events = await db.query(
      `SELECT direction, counted, occurred_at AS "occurredAt", thread_urn AS "threadUrn"
         FROM linkedin_message_events
        WHERE org_id = $1 AND prospect_id = $2
        ORDER BY occurred_at DESC
        LIMIT 100`,
      [orgId, pid]
    );
    const activities = await db.query(
      `SELECT description, activity_type AS "activityType",
              metadata->>'event' AS event, metadata->>'source' AS source,
              created_at AS "createdAt"
         FROM prospecting_activities
        WHERE org_id = $1 AND prospect_id = $2
        ORDER BY created_at DESC
        LIMIT 50`,
      [orgId, pid]
    );

    const p = pr.rows[0];
    const li = p.li || {};
    res.json({
      ok: true,
      prospect: {
        id: p.id, name: p.name, company: p.company,
        linkedinUrl: p.linkedinUrl, identityResolved: p.identityResolved, stage: p.stage,
        requestSentAt: li.request_sent_at || null,
        connectedAt: li.connected_at || null,
        verifiedAt: li.connection_verified_at || null,
        liStatus: li.connection_status || null,
        messageCount: li.message_count || 0,
        replyCount: li.reply_count || 0,
        lastMessageAt: li.last_message_at || null,
        lastReplyAt: li.last_reply_at || null,
      },
      messages: events.rows,
      activities: activities.rows,
    });
  } catch (err) {
    console.error('linkedin-connections/funnel/:id error:', err);
    res.status(500).json({ error: { message: 'Detail fetch failed: ' + err.message } });
  }
});

module.exports = router;
