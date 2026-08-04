/**
 * groupCache.js
 *
 * DROP-IN LOCATION: backend/services/whatsapp/groupCache.js
 *
 * The list of groups a connected number belongs to, held in PROCESS MEMORY with
 * a short TTL and never written to Postgres.
 *
 * WHY MEMORY AND NOT A TABLE
 *   Persisting the list made a 306-row catalogue of one person's alumni groups,
 *   residents' associations and birthday threads — retained indefinitely, in a
 *   multi-tenant database, about people who have never heard of this product.
 *   It was a bad trade for a UI convenience.
 *
 *   The list is only needed while someone has the triage screen open. Memory
 *   with a TTL matches that lifetime exactly: an API restart forgets it, and
 *   the next person to open the tab causes a fresh fetch. Nothing accumulates,
 *   nothing needs a retention policy, and there is nothing to leak.
 *
 * HOW IT IS POPULATED
 *   The worker cannot be called — it has no HTTP listener and polls us. So
 *   requestRefresh() raises a flag that the next heartbeat response carries;
 *   the worker sees it, calls groupFetchAllParticipating(), and POSTs the
 *   snapshot to /internal/group-snapshot. Round trip is one heartbeat interval,
 *   60s by default, which is why the UI shows the cached list immediately and
 *   refreshes underneath.
 *
 * MULTI-REPLICA
 *   Not shared between API instances. Two replicas means two caches and
 *   occasionally a redundant refresh — harmless, and far preferable to a shared
 *   store, which would be persistence wearing a different hat.
 */

'use strict';

const TTL_MS = parseInt(process.env.WA_GROUP_CACHE_TTL_MS || '300000', 10);   // 5 min

/** sessionId -> { groups, at, refreshRequested } */
const cache = new Map();

/**
 * Store a snapshot. Called from the worker channel only.
 *
 * Group NAMES and participant counts live here; nothing is written to the
 * database by this path. The one thing that IS persisted elsewhere is the
 * decision a human makes on the triage screen.
 */
function put(sessionId, groups = []) {
  cache.set(Number(sessionId), {
    groups: groups.map(g => ({
      jid:          g.jid,
      subject:      g.subject || null,
      participants: Array.isArray(g.participants) ? g.participants.length : (g.participantCount ?? null),
      // Only org-user membership is carried forward — see the participants
      // note in whatsappSession.service.syncOrgMembersForGroup. Non-user
      // participants are matched there and discarded.
      orgUserIds:   g.orgUserIds || [],
      createdAt:    g.creation || null,
    })),
    at: Date.now(),
    refreshRequested: false,
  });
  return cache.get(Number(sessionId));
}

/** @returns {{groups:Array, ageMs:number, stale:boolean}|null} */
function get(sessionId) {
  const e = cache.get(Number(sessionId));
  if (!e) return null;
  const ageMs = Date.now() - e.at;
  return { groups: e.groups, ageMs, stale: ageMs > TTL_MS };
}

/**
 * Ask the worker for a fresh snapshot on its next heartbeat.
 *
 * Idempotent: several people opening the triage screen at once raise the same
 * flag, and the worker sends one snapshot.
 */
function requestRefresh(sessionId) {
  const id = Number(sessionId);
  const e = cache.get(id) || { groups: [], at: 0, refreshRequested: false };
  e.refreshRequested = true;
  cache.set(id, e);
  return true;
}

/** Consumed by the heartbeat handler; clears the flag so it fires once. */
function takeRefreshRequest(sessionId) {
  const e = cache.get(Number(sessionId));
  if (!e?.refreshRequested) return false;
  e.refreshRequested = false;
  return true;
}

/** Called when a session is disabled or logs out — the list is meaningless then. */
function drop(sessionId) {
  return cache.delete(Number(sessionId));
}

/** Housekeeping so a long-lived process does not hold snapshots for dead sessions. */
function sweep() {
  const cutoff = Date.now() - (TTL_MS * 4);
  let dropped = 0;
  for (const [id, e] of cache) {
    if (e.at && e.at < cutoff && !e.refreshRequested) { cache.delete(id); dropped++; }
  }
  return dropped;
}

setInterval(sweep, TTL_MS).unref?.();

module.exports = { put, get, requestRefresh, takeRefreshRequest, drop, sweep, TTL_MS };
