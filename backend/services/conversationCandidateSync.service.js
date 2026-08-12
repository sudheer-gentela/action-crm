/**
 * conversationCandidateSync.service.js  — Phase 2
 *
 * DROP-IN LOCATION: backend/services/conversationCandidateSync.service.js
 *
 * Keeps DERIVED candidate sets true as vendor–project reality moves underneath
 * them.
 *
 * THE PROBLEM PHASE 1 LEFT OPEN
 *   `bindGroup` derives an account binding's candidates once, at bind time.
 *   Everything that happens afterwards makes that snapshot wrong:
 *
 *     a vendor is added to a new project      → missing candidate
 *     a vendor comes off a project            → stale candidate
 *     a project completes                     → stale candidate
 *     the relationship is ended               → the whole set is stale
 *     a contact moves to a different account  → both sets are wrong
 *
 *   Phase 1 accepted that. Phase 2 is where it gets fixed, and the spec's own
 *   note — "if vendor–project churn turns out to be high, derived-at-read may
 *   be better" — is the thing this file is measured against.
 *
 * TWO MECHANISMS, AND THE SECOND IS THE GUARANTEE
 *
 *   HOOKS (`resyncForAccount`) fire on the events we can see: relationship
 *   approved or ended, vendor contact added to or removed from a project. They
 *   exist for LATENCY — a rep who adds Cloudsmith to a new project should not
 *   wait until tomorrow for the candidate to appear.
 *
 *   THE NIGHTLY RECONCILER (`reconcileAll`) recomputes every derived set from
 *   scratch. It exists for CORRECTNESS, and it is the actual guarantee. Hooks
 *   are best-effort by nature: they miss project status transitions (nothing
 *   calls a hook when a project quietly completes), contact account moves, bulk
 *   imports, direct SQL, and any code path added later by someone who does not
 *   know this file exists.
 *
 *   Stated plainly because it drives the design: IF THE HOOKS WERE PERFECT THE
 *   RECONCILER WOULD STILL BE NEEDED, and if the reconciler runs the hooks are
 *   only ever saving hours. So the hooks are written to fail soft — a hook error
 *   is logged and swallowed, never propagated into the user's action. Failing a
 *   vendor approval because a candidate refresh hiccuped would be a worse
 *   outcome than a set that is right tomorrow morning.
 *
 * WHAT IT NEVER TOUCHES
 *   `source = 'declared'` sets — pool bindings, named by a human. A human's
 *   list is not ours to recompute; the projects an internal group discusses are
 *   not derivable from any relationship. Every write here is scoped to
 *   `source = 'derived'`, and that scoping is the single most important line in
 *   the file.
 *
 *   It also never attributes anything. Candidates are a shortlist for Phase 3's
 *   filing UI. No message's `handover_id` is read or written here.
 */

'use strict';

const { pool } = require('../config/database');
const bindings = require('./conversationBindings.service');
const accountRels = require('./accountRelationships.service');

/**
 * Recompute the derived candidate set for every binding pointing at one
 * account, in one org.
 *
 * Returns a per-binding diff rather than a bare count, because "synced 4
 * bindings" tells an operator nothing about whether the sync was a no-op or
 * quietly removed a project somebody was about to file into.
 *
 * @param {object} [opts.client] join a caller's transaction
 * @param {string} [opts.reason] free text for the log line
 */
async function resyncForAccount(orgId, accountId, { client = null, reason = 'unspecified' } = {}) {
  const q = client || pool;
  const id = parseInt(accountId, 10);
  if (!orgId || !id) return { bindings: 0, changed: 0, details: [] };

  const { rows: bound } = await q.query(
    `SELECT id, channel, thread_ref FROM conversation_bindings
      WHERE org_id = $1 AND binding_mode = 'account' AND bound_account_id = $2`,
    [orgId, id]
  );
  if (!bound.length) return { bindings: 0, changed: 0, details: [] };

  // ONE derivation for all of them. Every binding on the same account in the
  // same org has the same candidate set by definition, so deriving per binding
  // would be the same query N times.
  //
  // An ENDED relationship derives an EMPTY set, not a skip. Leaving the old
  // candidates in place after "we stopped using Cloudsmith in August" is
  // exactly the stale-shortlist problem this file exists to prevent — and an
  // empty set is honest: there is nothing to suggest, so Phase 3 suggests
  // nothing. The binding itself survives, because the group's history is still
  // organised around that vendor.
  const { rows: [rel] } = await q.query(
    `SELECT 1 FROM account_relationships
      WHERE org_id = $1 AND account_id = $2
        AND relationship IN ('vendor', 'partner') AND status = 'active'
      LIMIT 1`,
    [orgId, id]
  );

  const derived = rel ? await accountRels.projectsForRelationship(orgId, id) : [];
  const want = derived.map(d => d.handoverId).sort((a, b) => a - b);

  let changed = 0;
  const details = [];

  for (const b of bound) {
    const { rows: existing } = await q.query(
      `SELECT handover_id FROM conversation_project_candidates
        WHERE org_id = $1 AND binding_id = $2 AND source = 'derived'
        ORDER BY handover_id`,
      [orgId, b.id]
    );
    const have = existing.map(r => r.handover_id);

    const added   = want.filter(h => !have.includes(h));
    const removed = have.filter(h => !want.includes(h));

    if (!added.length && !removed.length) {
      details.push({ bindingId: b.id, threadRef: b.thread_ref, added: [], removed: [], noop: true });
      continue;
    }

    // Targeted add/remove rather than setCandidates' delete-then-insert.
    // Rewriting the whole set every night would churn `declared_at` on rows
    // that never changed, and `declared_at` is the only evidence available when
    // someone asks in March why a message matched P2 in January.
    if (removed.length) {
      await q.query(
        `DELETE FROM conversation_project_candidates
          WHERE org_id = $1 AND binding_id = $2 AND source = 'derived'
            AND handover_id = ANY($3::int[])`,
        [orgId, b.id, removed]
      );
    }
    if (added.length) {
      await q.query(
        `INSERT INTO conversation_project_candidates
           (org_id, binding_id, handover_id, source, declared_by)
         SELECT $1, $2, h.id, 'derived', NULL
           FROM sales_handovers h
          WHERE h.org_id = $1 AND h.id = ANY($3::int[])
         ON CONFLICT (binding_id, handover_id) DO NOTHING`,
        [orgId, b.id, added]
      );
    }

    changed++;
    details.push({ bindingId: b.id, threadRef: b.thread_ref, added, removed, noop: false });
  }

  if (changed) {
    console.log(`[candidate-sync] org ${orgId} account ${id} (${reason}): ` +
                `${changed}/${bound.length} binding(s) changed`);
  }
  return { bindings: bound.length, changed, details, relationshipActive: !!rel };
}

/**
 * Fire-and-forget wrapper for the hook call sites.
 *
 * Deliberately swallows everything. A candidate refresh is a background
 * convenience; the nightly reconciler is what guarantees correctness. Failing a
 * vendor approval, or a stakeholder edit, because this hiccuped would trade a
 * real user action for a set that would have been right tomorrow anyway.
 *
 * Not `await`ed by callers — but errors inside the promise are caught here, so
 * this can never surface as an unhandled rejection.
 */
function resyncSoon(orgId, accountId, reason) {
  if (!orgId || !accountId) return;
  resyncForAccount(orgId, accountId, { reason })
    .catch(err => console.warn(
      `[candidate-sync] background resync failed (org ${orgId}, account ${accountId}, ${reason}): ${err.message}`));
}

/**
 * The account behind a project_contacts row, so a stakeholder change can find
 * the bindings it affects. Returns null when the contact has no account, which
 * is common and not an error.
 */
async function accountForContact(orgId, contactId) {
  if (!contactId) return null;
  const { rows: [c] } = await pool.query(
    `SELECT account_id FROM contacts WHERE id = $1 AND org_id = $2`,
    [contactId, orgId]
  );
  return c?.account_id ?? null;
}

/**
 * Nightly. Recompute every derived set in every org.
 *
 * THE GUARANTEE. Hooks cover the events we thought of; this covers the rest —
 * project status transitions (nothing calls a hook when a project quietly
 * completes), contacts moving between accounts, bulk imports, direct SQL, and
 * whatever path someone adds in 2027 without reading this file.
 *
 * Sequential, not parallel: this runs in the quiet hours against the same pool
 * the WhatsApp worker uses, and finishing in four minutes instead of one is
 * worth more than the contention. Errors are per-account — one bad account must
 * not abandon the rest of the fleet.
 */
async function reconcileAll() {
  const started = Date.now();
  const { rows: targets } = await pool.query(
    `SELECT DISTINCT org_id, bound_account_id AS account_id
       FROM conversation_bindings
      WHERE binding_mode = 'account' AND bound_account_id IS NOT NULL
      ORDER BY org_id, account_id`
  );

  let changed = 0, errors = 0, added = 0, removed = 0;
  for (const t of targets) {
    try {
      const r = await resyncForAccount(t.org_id, t.account_id, { reason: 'nightly' });
      changed += r.changed;
      for (const d of r.details) { added += d.added.length; removed += d.removed.length; }
    } catch (err) {
      errors++;
      console.error(`[candidate-sync] org ${t.org_id} account ${t.account_id}: ${err.message}`);
    }
  }

  const summary = {
    accounts: targets.length, changed, added, removed, errors,
    ms: Date.now() - started,
  };
  console.log(`[candidate-sync] nightly reconcile: ${JSON.stringify(summary)}`);
  return summary;
}

/**
 * Bindings whose candidate set no longer holds a single active project.
 *
 * Not acted on automatically, and that is the point. A vendor group that has
 * run out of live projects is either finished — archive it — or the vendor is
 * on new work nobody has recorded, which is a data-entry gap worth surfacing.
 * Both need a human. Phase 7's project-close nudge reads this; Phase 2 just
 * makes it available so the condition is observable before anything acts on it.
 */
async function listEmptyCandidateBindings(orgId) {
  const { rows } = await pool.query(
    `SELECT b.id AS binding_id, b.thread_ref, b.bound_account_id,
            a.name AS account_name, b.bound_at,
            t.id AS thread_id, t.group_subject
       FROM conversation_bindings b
       LEFT JOIN accounts a ON a.id = b.bound_account_id AND a.org_id = b.org_id
       LEFT JOIN whatsapp_threads t ON t.org_id = b.org_id
                                   AND t.wa_group_id = b.thread_ref
                                   AND t.kind = 'group'
      WHERE b.org_id = $1 AND b.binding_mode = 'account'
        AND NOT EXISTS (
          SELECT 1 FROM conversation_project_candidates c
           WHERE c.binding_id = b.id)
      ORDER BY b.bound_at`,
    [orgId]
  );
  return rows;
}

module.exports = {
  resyncForAccount,
  resyncSoon,
  accountForContact,
  reconcileAll,
  listEmptyCandidateBindings,
};
