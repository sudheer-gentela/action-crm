/**
 * conversationBindings.service.js
 *
 * DROP-IN LOCATION: backend/services/conversationBindings.service.js
 *
 * How a conversation is ORGANISED — around a project, around an account, or as
 * a pool of projects — independently of what any one message is about.
 *
 * CHANNEL-AGNOSTIC BY CONSTRUCTION. Nothing in this file knows what a WhatsApp
 * group is. It takes (orgId, channel, threadRef) where threadRef is the
 * channel's own external identifier as text, and that is the whole interface.
 * Slack and Teams arrive within two quarters; when they do they call these same
 * four functions with a different `channel` and nothing here changes.
 *
 * The WhatsApp-specific parts of binding — watch state, whatsapp_session_groups,
 * media requeue — deliberately stay in whatsappSession.service.js. They do not
 * generalise and pulling them in here would make this file the second place
 * that knows about Baileys.
 *
 * WHAT THIS FILE DOES NOT DO
 *   It does not attribute anything. Phase 1 writes candidate sets and reads
 *   them nowhere: no mention matching, no bursts, no AI, no suggestions. The
 *   only consumer in Phase 1 is `forThread`, called by the attribution chain to
 *   ask one question — is this thread entity-scoped? — and, when the answer is
 *   yes, to stop early rather than guess.
 *
 * THE RULE EVERYTHING HERE SERVES
 *   A misfiled message is worse than an unfiled one. An unfiled message can be
 *   resolved by a human; a misfiled one is invisible, because nobody audits the
 *   project they did not expect it in. So an entity-scoped thread attributes
 *   almost nothing, on purpose, and the volume that lands unassigned is the
 *   measurement Phase 4 is built against.
 *
 * A NOTE ON VISIBILITY
 *   Candidate sets are ORG-WIDE. `projectsForRelationship` deliberately does
 *   not apply the viewer scoping that accountRelationships.listProjectsForAccount
 *   applies, because a candidate set is a property of the conversation, not of
 *   whoever happened to bind it — scoping it to the binder would produce a set
 *   that silently differs depending on who clicked, which is unauditable.
 *   The consequence is that this table can name projects a given user may not
 *   see. Any UI that RENDERS candidates (Phase 3's picker, the project-close
 *   nudge) must scope its own read. This file returns rows; it does not decide
 *   who may look at them.
 */

'use strict';

const { pool } = require('../config/database');

const CHANNELS = ['whatsapp', 'slack', 'teams', 'gchat', 'email'];
const MODES    = ['project', 'account', 'pool'];

/** Entity-scoped = the thread is organised around who is in it, not a project. */
const ENTITY_MODES = ['account', 'pool'];

function isEntityMode(mode) {
  return ENTITY_MODES.includes(mode);
}

function assertChannel(channel) {
  if (!CHANNELS.includes(channel)) {
    throw Object.assign(new Error(`channel must be one of: ${CHANNELS.join(', ')}`), { status: 400 });
  }
}

function assertMode(mode) {
  if (!MODES.includes(mode)) {
    throw Object.assign(new Error(`mode must be one of: ${MODES.join(', ')}`), { status: 400 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The binding for one conversation, or null.
 *
 * NULL MEANS LEGACY, NOT POOL. A conversation with no row behaves exactly as it
 * did before Phase 1 — the channel's own thread project, if any, and the full
 * precedence chain. Every caller must treat absence that way or Phase 1 becomes
 * a behaviour change for every group already in the system.
 *
 * One row by unique index (org_id, channel, thread_ref). Called once per
 * inbound message; deliberately NOT cached. The ingest path handles one message
 * per call from the worker, so a cache would buy one indexed lookup and cost a
 * staleness window in which a just-bound group is still treated as legacy —
 * which is the direction that misfiles.
 *
 * @param {object} [opts.client] run on an existing transaction client
 */
async function forThread(orgId, channel, threadRef, { client = null } = {}) {
  if (!orgId || !threadRef) return null;
  assertChannel(channel);

  const q = client || pool;
  const { rows: [row] } = await q.query(
    `SELECT id, org_id, channel, thread_ref, binding_mode, handover_id,
            bound_account_id, bound_by, bound_at, updated_at
       FROM conversation_bindings
      WHERE org_id = $1 AND channel = $2 AND thread_ref = $3
      LIMIT 1`,
    [orgId, channel, String(threadRef)]
  );
  return row || null;
}

/**
 * Is this conversation entity-scoped?
 *
 * The single question the attribution chain and the thread-adoption guards ask.
 * Returns false for a legacy conversation and for project mode — both of which
 * keep today's behaviour exactly.
 */
async function isEntityBound(orgId, channel, threadRef, { client = null } = {}) {
  const binding = await forThread(orgId, channel, threadRef, { client });
  return !!binding && isEntityMode(binding.binding_mode);
}

/**
 * The projects a message in this conversation could plausibly be about.
 *
 * Materialised rather than derived at read time. That costs a sync when a
 * vendor relationship changes (Phase 2) and buys three things: the set is
 * auditable after the fact ("why did this match P2 in March?"), pool threads
 * need the table anyway since they have nothing to derive from, and the
 * project-close nudge becomes an index lookup instead of a scan.
 *
 * NOT scoped to a viewer — see the visibility note in the file header.
 */
async function candidatesFor(orgId, bindingId, { client = null } = {}) {
  const q = client || pool;
  const { rows } = await q.query(
    `SELECT c.handover_id, c.source, c.declared_at,
            COALESCE(h.name, d.name) AS project_name,
            h.status                 AS project_status
       FROM conversation_project_candidates c
       JOIN sales_handovers h ON h.id = c.handover_id AND h.org_id = c.org_id
       LEFT JOIN deals      d ON d.id = h.deal_id
      WHERE c.org_id = $1 AND c.binding_id = $2
      ORDER BY project_name`,
    [orgId, bindingId]
  );
  return rows;
}

/** How many candidates each of these bindings carries. Keyed by binding id. */
async function candidateCounts(orgId, bindingIds = [], { client = null } = {}) {
  const ids = (bindingIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (!ids.length) return {};

  const q = client || pool;
  const { rows } = await q.query(
    `SELECT binding_id, count(*)::int AS n
       FROM conversation_project_candidates
      WHERE org_id = $1 AND binding_id = ANY($2::int[])
      GROUP BY binding_id`,
    [orgId, ids]
  );
  return Object.fromEntries(rows.map(r => [r.binding_id, r.n]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create or update the binding for one conversation.
 *
 * Idempotent on (org_id, channel, thread_ref). Shape validation is the
 * database's job — conv_bindings_shape_chk rejects an account binding carrying
 * a handover_id and so on — so this does not duplicate it; it only refuses the
 * combinations that would produce a confusing constraint error.
 *
 * DOES NOT touch candidates. `setCandidates` is separate because the two have
 * different lifetimes: a binding is set once by a human, and its derived
 * candidate set is re-synced whenever the underlying relationship changes
 * (Phase 2) without the binding itself being touched.
 *
 * @param {object} [opts.client] MUST be passed when the caller is inside a
 *        transaction that also writes thread or group state — the binding and
 *        the cleared thread project have to commit together or a crash between
 *        them leaves a thread with a stale project and a binding that says it
 *        should have none.
 */
async function bind(orgId, userId, channel, threadRef, {
  mode,
  handoverId = null,
  accountId  = null,
  client     = null,
} = {}) {
  assertChannel(channel);
  assertMode(mode);

  if (mode === 'project' && !handoverId) {
    throw Object.assign(new Error('project mode needs a project'), { status: 400 });
  }
  if (mode === 'account' && !accountId) {
    throw Object.assign(new Error('account mode needs an account'), { status: 400 });
  }

  const q = client || pool;
  const { rows: [row] } = await q.query(
    `INSERT INTO conversation_bindings
       (org_id, channel, thread_ref, binding_mode, handover_id, bound_account_id, bound_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (org_id, channel, thread_ref) DO UPDATE SET
       binding_mode     = EXCLUDED.binding_mode,
       handover_id      = EXCLUDED.handover_id,
       bound_account_id = EXCLUDED.bound_account_id,
       bound_by         = COALESCE(EXCLUDED.bound_by, conversation_bindings.bound_by),
       updated_at       = now()
     RETURNING *`,
    [
      orgId, channel, String(threadRef), mode,
      mode === 'project' ? parseInt(handoverId, 10) : null,
      mode === 'account' ? parseInt(accountId, 10)  : null,
      userId || null,
    ]
  );
  return row;
}

/**
 * Replace the candidate set for a binding.
 *
 * Full replace rather than a merge: a derived set that has lost a project needs
 * that project GONE, and a merge would accumulate every project the vendor was
 * ever on. Phase 2's relationship-change sync re-runs this wholesale for the
 * same reason.
 *
 * Project mode carries no candidates — its project is fixed on the binding — so
 * passing candidates for a project binding clears them rather than storing a
 * set nothing will ever read.
 */
async function setCandidates(orgId, bindingId, handoverIds = [], {
  source     = 'declared',
  declaredBy = null,
  client     = null,
} = {}) {
  if (!['declared', 'derived'].includes(source)) {
    throw Object.assign(new Error("source must be 'declared' or 'derived'"), { status: 400 });
  }

  const ids = [...new Set(
    (handoverIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger)
  )];

  const q = client || pool;

  await q.query(
    `DELETE FROM conversation_project_candidates WHERE org_id = $1 AND binding_id = $2`,
    [orgId, bindingId]
  );

  if (!ids.length) return { set: 0 };

  // unnest rather than a built VALUES list: one parameterised statement, no
  // string concatenation, and the set is small enough that a single round trip
  // is the whole cost.
  const { rowCount } = await q.query(
    `INSERT INTO conversation_project_candidates
       (org_id, binding_id, handover_id, source, declared_by)
     SELECT $1, $2, h.id, $4, $5
       FROM sales_handovers h
      WHERE h.org_id = $1 AND h.id = ANY($3::int[])
     ON CONFLICT (binding_id, handover_id) DO NOTHING`,
    [orgId, bindingId, ids, source, declaredBy || null]
  );

  // The SELECT is filtered on org_id, so a project belonging to another org is
  // silently dropped rather than inserted. Report the discrepancy so a caller
  // that passed a foreign id finds out instead of believing it was stored.
  return { set: rowCount, requested: ids.length, dropped: ids.length - rowCount };
}

/** Remove a binding entirely — the conversation reverts to legacy behaviour. */
async function unbind(orgId, channel, threadRef, { client = null } = {}) {
  assertChannel(channel);
  const q = client || pool;
  const { rowCount } = await q.query(
    `DELETE FROM conversation_bindings
      WHERE org_id = $1 AND channel = $2 AND thread_ref = $3`,
    [orgId, channel, String(threadRef)]
  );
  return { removed: rowCount };
}

module.exports = {
  CHANNELS, MODES, ENTITY_MODES,
  isEntityMode,
  forThread, isEntityBound, candidatesFor, candidateCounts,
  bind, setCandidates, unbind,
};
