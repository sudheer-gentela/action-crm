// services/NetworkConnectionIngestService.js
//
// P0 ingest for network job-change detection (Design & Execution Tracker §G-P0).
//
// Takes the parsed rows of a rep's LinkedIn connection export (six fields,
// parsed CLIENT-SIDE and posted as JSON — mirrors the POST /prospects/bulk
// convention; we do NOT parse CSV on the server) and:
//
//   1. Writes a connection_snapshots header (with is_complete heuristic + the
//      prior snapshot it should later be diffed against).
//   2. Writes connection_snapshot_rows (raw six fields, retained for audit).
//   3. Resolves each row to a linkedin_connections roster row in the identity
//      order URN → slug → name+connected_on (§E / D8), upserting current state
//      and stamping last_seen_in_snapshot_at.
//
// What this service deliberately does NOT do (NEXT slice — the diff engine):
//   • generate connection_job_events (moves)
//   • mark absent connections as missing/disconnected
//   • any play generation or prospect promotion (that's P1+)
// Ingest only touches connections PRESENT in this snapshot. Absences are the
// diff engine's job.
//
// CALLING CONVENTION (mirror of LinkedInConnectionSyncService): every method
// takes an already-open `client` and is wrapped by the route in
// withOrgTransaction(orgId, …), which sets the app.current_org_id RLS GUC.
// Every write carries org_id explicitly (discipline mirror).

'use strict';

// is_complete heuristic: a snapshot whose row_count falls below this fraction of
// the running max (over prior COMPLETE snapshots for the same owner) is flagged
// incomplete — large-network exports sometimes come back short (§E). The diff
// engine suppresses disconnect firing on incomplete snapshots.
const COMPLETENESS_MIN_RATIO = 0.85;

const VALID_SOURCES = ['csv_export', 'extension_harvest', 'on_demand'];

// ── Pure helpers (exported for unit tests; no DB) ─────────────────────────────

// Collapse whitespace + lowercase for stable name comparison.
function normName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Mirror of the slug extraction used everywhere else (LinkedInConnectionSyncService,
// prospects.routes.js, 2026_20 index). Keep in lockstep.
function slugFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/in\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : null;
}

// LinkedIn "Connected On" arrives as "DD Mon YYYY" (e.g. "14 Mar 2023"). Accept
// that plus ISO and MM/DD/YYYY as defensive fallbacks. Returns 'YYYY-MM-DD' or
// null (blank/unparseable — LinkedIn does leave some rows blank).
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
function parseConnectedOn(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  // ISO already
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // "DD Mon YYYY"
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${String(m[1]).padStart(2, '0')}`;
  }

  // "MM/DD/YYYY"
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }

  return null;
}

// Identity key in resolution priority order (§E / D8). This is the single
// per-(org,owner) uniqueness anchor stored on linkedin_connections.identity_key.
//   urn:<urn>                              stable, preferred
//   slug:<lowerslug>                       mutable but good
//   nd:<lowername>|<connected_on or ''>    CSV bridge; immutable date anchors moves
// Returns null only when there is no name at all (row is unusable).
function computeIdentityKey({ memberUrn, linkedinUrl, fullName, connectedOn }) {
  if (memberUrn && String(memberUrn).trim()) {
    return `urn:${String(memberUrn).trim()}`;
  }
  const slug = slugFromUrl(linkedinUrl);
  if (slug) return `slug:${slug}`;

  const nn = normName(fullName);
  if (nn) return `nd:${nn}|${connectedOn || ''}`;

  return null;
}

// Normalize one raw export row into the shape the roster needs. Tolerant of
// header-casing variants from a client-side parser (firstName/first_name, etc.).
function normalizeRow(raw) {
  const get = (...keys) => {
    for (const k of keys) {
      if (raw[k] != null && String(raw[k]).trim() !== '') return String(raw[k]).trim();
    }
    return null;
  };

  const firstName = get('firstName', 'first_name', 'First Name');
  const lastName  = get('lastName', 'last_name', 'Last Name');
  const email     = get('email', 'Email Address', 'emailAddress');
  const company   = get('company', 'Company');
  const position  = get('position', 'title', 'Position');
  const connRaw   = get('connectedOn', 'connected_on', 'Connected On');
  const memberUrn = get('memberUrn', 'member_urn');
  const linkedinUrl = get('linkedinUrl', 'linkedin_url', 'URL', 'profileUrl');

  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
  const connectedOn = parseConnectedOn(connRaw);

  const warnings = [];
  if (connRaw && !connectedOn) warnings.push({ type: 'unparsed_connected_on', value: connRaw, name: fullName });

  const identityKey = computeIdentityKey({ memberUrn, linkedinUrl, fullName, connectedOn });
  if (!identityKey) warnings.push({ type: 'unkeyable_row', raw: { firstName, lastName } });

  return {
    firstName, lastName, fullName, email, company, position,
    connectedOn, connRaw, memberUrn, linkedinUrl, identityKey, warnings,
  };
}

// ── Snapshot ingest ───────────────────────────────────────────────────────────

/**
 * Ingest one connection snapshot for a single rep (owner).
 *
 * @param {pg.PoolClient} client  — open client inside withOrgTransaction
 * @param {object}  ctx
 * @param {number}  ctx.orgId
 * @param {number}  ctx.ownerId   — the rep whose network this is (req.user.userId)
 * @param {number?} ctx.seatId    — user_linkedin_seats.id, optional
 * @param {string}  ctx.source    — 'csv_export' | 'extension_harvest' | 'on_demand'
 * @param {object[]} ctx.rows     — raw export rows (client-parsed)
 * @returns {Promise<object>} summary { snapshotId, rows, inserted, updated, skipped, isComplete, priorSnapshotId, warnings }
 */
async function ingestSnapshot(client, { orgId, ownerId, seatId = null, source = 'csv_export', rows }) {
  if (!orgId || !ownerId) throw new Error('ingestSnapshot: orgId and ownerId are required');
  if (!Array.isArray(rows)) throw new Error('ingestSnapshot: rows must be an array');
  if (!VALID_SOURCES.includes(source)) throw new Error(`ingestSnapshot: invalid source "${source}"`);

  const rowCount = rows.length;
  const warnings = [];

  // 1. Prior snapshot (to diff against later) + running max for completeness.
  const priorRes = await client.query(
    `SELECT id FROM connection_snapshots
      WHERE org_id = $1 AND owner_id = $2
      ORDER BY imported_at DESC LIMIT 1`,
    [orgId, ownerId]
  );
  const priorSnapshotId = priorRes.rows[0] ? priorRes.rows[0].id : null;

  const maxRes = await client.query(
    `SELECT MAX(row_count) AS maxrc FROM connection_snapshots
      WHERE org_id = $1 AND owner_id = $2 AND is_complete = true`,
    [orgId, ownerId]
  );
  const priorMax = maxRes.rows[0] && maxRes.rows[0].maxrc ? Number(maxRes.rows[0].maxrc) : 0;
  const isComplete = priorMax === 0 ? true : rowCount >= Math.floor(priorMax * COMPLETENESS_MIN_RATIO);
  if (!isComplete) {
    warnings.push({ type: 'incomplete_snapshot', rowCount, priorMax });
  }

  // 2. Snapshot header.
  const snapRes = await client.query(
    `INSERT INTO connection_snapshots
        (org_id, owner_id, seat_id, source, row_count, parse_warnings, is_complete, prior_snapshot_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id, imported_at`,
    [orgId, ownerId, seatId, source, rowCount, JSON.stringify([]), isComplete, priorSnapshotId]
  );
  const snapshotId = snapRes.rows[0].id;
  const importedAt = snapRes.rows[0].imported_at;

  // 3 + 4. Resolve each row into the roster, then record the raw row.
  // Per-row upsert is fine at dogfood volume (cf. 2026_29 note); batch later if needed.
  let inserted = 0, updated = 0, skipped = 0;
  const seenKeys = new Set();

  for (const raw of rows) {
    const n = normalizeRow(raw);
    for (const w of n.warnings) warnings.push(w);

    if (!n.identityKey) {
      // Unusable row — still keep the raw row for audit, unresolved.
      await client.query(
        `INSERT INTO connection_snapshot_rows
            (org_id, snapshot_id, connection_id, raw_first_name, raw_last_name,
             raw_email, raw_company, raw_position, raw_connected_on, resolved)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, false)`,
        [orgId, snapshotId, n.firstName, n.lastName, n.email, n.company, n.position, n.connRaw]
      );
      skipped++;
      continue;
    }

    if (seenKeys.has(n.identityKey)) {
      // Two rows in the SAME export resolving to one key — same-name+same-day
      // collision (rare). Accepted for v1; flag for audit (§8 ambiguity).
      warnings.push({ type: 'duplicate_key_in_snapshot', key: n.identityKey, name: n.fullName });
    }
    seenKeys.add(n.identityKey);

    // Upsert roster. (xmax = 0) distinguishes insert from update for counts.
    const up = await client.query(
      `INSERT INTO linkedin_connections
          (org_id, owner_id, identity_key, member_urn, linkedin_url,
           full_name, first_name, last_name, company_name, title, connected_on,
           status, first_seen_at, last_seen_in_snapshot_at, missing_since, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               'active', now(), $12, NULL, now())
       ON CONFLICT (org_id, owner_id, identity_key) DO UPDATE SET
          company_name             = EXCLUDED.company_name,
          title                    = EXCLUDED.title,
          full_name                = EXCLUDED.full_name,
          first_name               = COALESCE(EXCLUDED.first_name, linkedin_connections.first_name),
          last_name                = COALESCE(EXCLUDED.last_name,  linkedin_connections.last_name),
          member_urn               = COALESCE(EXCLUDED.member_urn,  linkedin_connections.member_urn),
          linkedin_url             = COALESCE(EXCLUDED.linkedin_url, linkedin_connections.linkedin_url),
          connected_on             = COALESCE(linkedin_connections.connected_on, EXCLUDED.connected_on),
          last_seen_in_snapshot_at = EXCLUDED.last_seen_in_snapshot_at,
          missing_since            = NULL,
          status                   = 'active',
          updated_at               = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [orgId, ownerId, n.identityKey, n.memberUrn, n.linkedinUrl,
       n.fullName, n.firstName, n.lastName, n.company, n.position, n.connectedOn,
       importedAt]
    );
    const connectionId = up.rows[0].id;
    if (up.rows[0].inserted) inserted++; else updated++;

    await client.query(
      `INSERT INTO connection_snapshot_rows
          (org_id, snapshot_id, connection_id, raw_first_name, raw_last_name,
           raw_email, raw_company, raw_position, raw_connected_on, resolved)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
      [orgId, snapshotId, connectionId, n.firstName, n.lastName,
       n.email, n.company, n.position, n.connRaw]
    );
  }

  // Persist accumulated warnings onto the header.
  if (warnings.length) {
    await client.query(
      `UPDATE connection_snapshots SET parse_warnings = $2::jsonb WHERE id = $1 AND org_id = $3`,
      [snapshotId, JSON.stringify(warnings), orgId]
    );
  }

  console.log(
    `🔗 NetworkIngest org=${orgId} owner=${ownerId} snapshot=${snapshotId} ` +
    `rows=${rowCount} inserted=${inserted} updated=${updated} skipped=${skipped} ` +
    `complete=${isComplete} prior=${priorSnapshotId || '-'}`
  );

  return {
    snapshotId, rows: rowCount, inserted, updated, skipped,
    isComplete, priorSnapshotId, warnings,
  };
}

module.exports = {
  ingestSnapshot,
  // exported for unit tests:
  computeIdentityKey,
  normalizeRow,
  parseConnectedOn,
  slugFromUrl,
  normName,
  COMPLETENESS_MIN_RATIO,
};
