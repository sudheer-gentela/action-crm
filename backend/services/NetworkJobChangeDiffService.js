// services/NetworkJobChangeDiffService.js
//
// P0 diff engine (Design & Execution Tracker §G-P0, "Diff engine").
//
// Compares a newly-ingested snapshot against its prior snapshot (per owner) and
// emits connection_job_events. Runs on the raw snapshot ROWS (not the roster's
// mutated current-state — ingest already overwrote that), joined on the
// connection_id that ingest resolved on both sides. Because the CSV identity key
// (name+connected_on) is stable across a company change, the same person keeps
// the same connection_id between snapshots, so a move shows up as one row whose
// company differs — not a delete+add.
//
// Event rules:
//   • company_change  — present both sides, normalized company differs (new non-blank)
//   • role_change     — present both sides, same company, title differs (new non-blank)
//   • new_connection  — present in new, absent in prior (suppressed on the baseline)
//   • disconnect_confirmed — absent in new for the SECOND consecutive complete
//                            snapshot (two-cycle gate, D9)
//
// Suppression: when the new snapshot is is_complete=false (large-network export
// gap, §E), ALL absence handling is skipped — no missing_since, no disconnects.
//
// Idempotent: every event carries a dedup_key and inserts ON CONFLICT DO NOTHING
// against uq_connection_job_events_dedup, so re-running the diff is a no-op.
//
// NOT here (P1+): account/ICP classification (is_into_target_account etc. stay
// NULL), play generation, prospect promotion.

'use strict';

function norm(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── Pure classifier (exported for unit tests; no DB) ──────────────────────────
//
// @param priorRows    [{ connectionId, company, title }]
// @param newRows       [{ connectionId, company, title }]
// @param isComplete    boolean — new snapshot completeness
// @param statusByConnId Map<connectionId, 'active'|'pending_disconnect'|'disconnected'>
//                       current roster status, consulted only for absences
// @returns {
//   events: [{ connectionId, eventType, fromCompany, fromTitle, toCompany, toTitle, dedupKey }],
//   toPendingDisconnect: [connectionId],   // first miss → set missing_since + pending
//   toDisconnected:      [connectionId],   // second miss → set disconnected
// }
function classifyDiff({ priorRows, newRows, isComplete, statusByConnId = new Map() }) {
  const priorMap = new Map();
  for (const r of priorRows) if (r.connectionId != null) priorMap.set(r.connectionId, r);
  const newMap = new Map();
  for (const r of newRows) if (r.connectionId != null) newMap.set(r.connectionId, r);

  const events = [];
  const toPendingDisconnect = [];
  const toDisconnected = [];

  // Present in new: detect moves / role changes / brand-new.
  for (const [connId, n] of newMap) {
    const p = priorMap.get(connId);
    if (p) {
      const companyMoved = norm(n.company) && norm(n.company) !== norm(p.company);
      const titleMoved   = norm(n.title)   && norm(n.title)   !== norm(p.title);
      if (companyMoved) {
        events.push({
          connectionId: connId, eventType: 'company_change',
          fromCompany: p.company, fromTitle: p.title,
          toCompany: n.company, toTitle: n.title,
          dedupKey: `${connId}|chg|${norm(n.company)}|${norm(n.title)}`,
        });
      } else if (titleMoved) {
        events.push({
          connectionId: connId, eventType: 'role_change',
          fromCompany: p.company, fromTitle: p.title,
          toCompany: n.company, toTitle: n.title,
          dedupKey: `${connId}|chg|${norm(n.company)}|${norm(n.title)}`,
        });
      }
    } else {
      events.push({
        connectionId: connId, eventType: 'new_connection',
        fromCompany: null, fromTitle: null,
        toCompany: n.company, toTitle: n.title,
        dedupKey: `${connId}|new`,
      });
    }
  }

  // Absent from new: two-cycle disconnect gate — only on a complete snapshot.
  if (isComplete) {
    for (const [connId, p] of priorMap) {
      if (newMap.has(connId)) continue;
      const status = statusByConnId.get(connId) || 'active';
      if (status === 'active') {
        toPendingDisconnect.push(connId);                 // first miss, no event yet
      } else if (status === 'pending_disconnect') {
        toDisconnected.push(connId);
        events.push({
          connectionId: connId, eventType: 'disconnect_confirmed',
          fromCompany: p.company, fromTitle: p.title,
          toCompany: null, toTitle: null,
          dedupKey: `${connId}|disc`,
        });
      }
      // already 'disconnected' → nothing
    }
  }

  return { events, toPendingDisconnect, toDisconnected };
}

// ── DB wrapper ────────────────────────────────────────────────────────────────
//
// Diff a freshly-ingested snapshot against its prior. Call inside the same
// withOrgTransaction as the ingest.
async function runDiffForSnapshot(client, { orgId, ownerId, newSnapshotId }) {
  // New snapshot meta.
  const metaRes = await client.query(
    `SELECT prior_snapshot_id, is_complete
       FROM connection_snapshots
      WHERE id = $1 AND org_id = $2`,
    [newSnapshotId, orgId]
  );
  if (!metaRes.rows[0]) throw new Error(`runDiffForSnapshot: snapshot ${newSnapshotId} not found`);
  const { prior_snapshot_id: priorSnapshotId, is_complete: isComplete } = metaRes.rows[0];

  // Baseline (no prior): nothing to diff. Everyone is "known" from here on.
  if (!priorSnapshotId) {
    console.log(`🔁 NetworkDiff org=${orgId} owner=${ownerId} snapshot=${newSnapshotId} baseline=true (no events)`);
    return { baseline: true, events: 0, byType: {}, pendingDisconnect: 0, disconnected: 0 };
  }

  const loadRows = async (snapId) => {
    const r = await client.query(
      `SELECT connection_id AS "connectionId", raw_company AS company, raw_position AS title
         FROM connection_snapshot_rows
        WHERE snapshot_id = $1 AND org_id = $2 AND resolved = true AND connection_id IS NOT NULL`,
      [snapId, orgId]
    );
    return r.rows;
  };
  const priorRows = await loadRows(priorSnapshotId);
  const newRows   = await loadRows(newSnapshotId);

  // Current roster status for the prior side's people (needed for the gate).
  const priorIds = priorRows.map((r) => r.connectionId);
  const statusByConnId = new Map();
  if (priorIds.length) {
    const sres = await client.query(
      `SELECT id, status FROM linkedin_connections WHERE org_id = $1 AND id = ANY($2::bigint[])`,
      [orgId, priorIds]
    );
    for (const row of sres.rows) statusByConnId.set(row.id, row.status);
  }

  const { events, toPendingDisconnect, toDisconnected } =
    classifyDiff({ priorRows, newRows, isComplete, statusByConnId });

  // Insert events (idempotent via dedup unique index).
  const byType = {};
  for (const e of events) {
    const ins = await client.query(
      `INSERT INTO connection_job_events
          (org_id, owner_id, connection_id, event_type,
           from_company, from_title, to_company, to_title,
           detection_source, dedup_key, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'csv_diff', $9, 'medium')
       ON CONFLICT (org_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [orgId, ownerId, e.connectionId, e.eventType,
       e.fromCompany, e.fromTitle, e.toCompany, e.toTitle, e.dedupKey]
    );
    if (ins.rows[0]) byType[e.eventType] = (byType[e.eventType] || 0) + 1;
  }

  // Roster lifecycle updates for absences.
  if (toPendingDisconnect.length) {
    await client.query(
      `UPDATE linkedin_connections
          SET status = 'pending_disconnect', missing_since = now(), updated_at = now()
        WHERE org_id = $1 AND id = ANY($2::bigint[]) AND status = 'active'`,
      [orgId, toPendingDisconnect]
    );
  }
  if (toDisconnected.length) {
    await client.query(
      `UPDATE linkedin_connections
          SET status = 'disconnected', updated_at = now()
        WHERE org_id = $1 AND id = ANY($2::bigint[])`,
      [orgId, toDisconnected]
    );
  }

  const inserted = Object.values(byType).reduce((a, b) => a + b, 0);
  console.log(
    `🔁 NetworkDiff org=${orgId} owner=${ownerId} snapshot=${newSnapshotId} ` +
    `events=${inserted} ${JSON.stringify(byType)} ` +
    `pending=${toPendingDisconnect.length} disconnected=${toDisconnected.length} complete=${isComplete}`
  );

  return {
    baseline: false,
    events: inserted,
    byType,
    pendingDisconnect: toPendingDisconnect.length,
    disconnected: toDisconnected.length,
    isComplete,
  };
}

module.exports = {
  runDiffForSnapshot,
  classifyDiff, // exported for unit tests
  norm,
};
