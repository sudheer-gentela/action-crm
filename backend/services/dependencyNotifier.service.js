/**
 * dependencyNotifier.service.js
 *
 * DROP-IN LOCATION: backend/services/dependencyNotifier.service.js  (NEW FILE)
 *
 * "You are unblocked" — told to the owner of a task whose last outstanding
 * prerequisite has just been satisfied (2026_138).
 *
 * ── WHY THIS IS A SEPARATE MODULE ───────────────────────────────────────────
 *
 * It is not a review event. Review notifications are about a task's approval
 * loop and are addressed to people acting on THAT task; this is about a
 * DIFFERENT task completing, and is addressed to someone who may have had
 * nothing to do with it. The message is not "look at this", it is "you can
 * start now" — the only alert in the product that changes what its reader does
 * next.
 *
 * Keeping it out of playReviewNotifier also keeps it out of the review digest.
 * enqueueReviewDigests sweeps on `type LIKE 'play_review_%'`, so the
 * 'play_unblocked' prefix means an unblock notice is never deferred into an
 * hourly batch. That is deliberate: batching an unblock notice delays the one
 * message whose entire value is that it arrives before the reader picks
 * something else up.
 *
 * ── THE TWO DEPENDENCY GRAPHS, AND WHY THIS READS THE SECOND ────────────────
 *
 * This is the thing to understand before changing anything here. The product
 * has TWO dependency mechanisms and they do not overlap:
 *
 *   1. playbook_plays.depends_on — PLAY-TEMPLATE ids. Read at instantiation to
 *      decide whether a new instance starts 'not_started' or 'blocked', and
 *      cleared afterwards by PlaybookPlayService._resolveDependenciesForProject,
 *      which finds instances whose status is literally 'blocked'.
 *
 *   2. project_play_instances.depends_on — SIBLING INSTANCE ids. Written by
 *      handover.service.setPlayDependencies, enforced live by
 *      _outstandingPrereqs at start and at submit.
 *
 * Nothing ever sets a status from (2). A task with unmet instance-level
 * prerequisites sits in 'not_started' and is simply refused when someone tries
 * to move it. So _resolveDependenciesForProject — the existing "unblocking"
 * code — can never fire for a hand-wired dependency, and hanging this
 * notification off it would have produced a feature that was silent on every
 * dependency a user actually drew. This module queries graph (2) directly.
 *
 * ── WHAT SATISFIES A PREREQUISITE ───────────────────────────────────────────
 *
 * completed, skipped and cancelled — the same three _outstandingPrereqs treats
 * as satisfying. A cancelled prerequisite that still blocked its dependents
 * would strand them permanently, which is why 2026_130 admitted it in the
 * first place. The rule is duplicated nowhere: this module calls the same
 * predicate shape and a change to one is a change to both.
 */

const { pool } = require('../config/database');

const TYPE = 'play_unblocked';

// Statuses a dependent must be in to be worth telling about. A task already in
// progress does not need to hear that it may start, and a terminal one is past
// caring. 'blocked' is included because graph (1) can have parked it there.
const NOTIFIABLE_DEPENDENT_STATUSES = ['not_started', 'blocked', 'snoozed'];

/**
 * Tasks that became startable BECAUSE this one reached a terminal status.
 *
 * Two conditions, and the second is what makes the message true:
 *   • the completed task is one of the dependent's prerequisites, AND
 *   • the dependent now has NO outstanding prerequisites at all.
 *
 * Without the second, finishing one of three prerequisites would announce
 * "you are unblocked" to someone who is still blocked by two others — a
 * notification that is actively worse than none, because acting on it means
 * walking into a refusal from _outstandingPrereqs.
 *
 * Resolved in ONE query rather than by fetching dependents and asking about
 * each: on a 49-task plan the loop version is a query per edge, and it races —
 * two prerequisites completing at once would each see the other as outstanding
 * and neither would notify.
 *
 * @returns {Promise<Array<{id, title, ownerUserId, handoverId}>>}
 */
async function newlyUnblocked(completedInstanceId, orgId) {
  const { rows } = await pool.query(
    `SELECT dep.id,
            dep.title,
            dep.owner_user_id AS owner_user_id,
            dep.handover_id
       FROM project_play_instances dep
      WHERE dep.org_id = $2
        AND $1 = ANY(dep.depends_on)
        AND dep.status = ANY($3::text[])
        -- No prerequisite of this dependent is still outstanding.
        --
        -- NOT EXISTS over the dependent's own depends_on array, rather than a
        -- count compared against array_length: a depends_on entry pointing at
        -- a deleted instance would make the two disagree, and the count
        -- version would then block the notice forever with no way to see why.
        AND NOT EXISTS (
              SELECT 1
                FROM project_play_instances pre
               WHERE pre.id = ANY(dep.depends_on)
                 AND pre.org_id = dep.org_id
                 AND pre.status NOT IN ('completed', 'skipped', 'cancelled')
            )`,
    [completedInstanceId, orgId, NOTIFIABLE_DEPENDENT_STATUSES]
  );
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    ownerUserId: r.owner_user_id,
    handoverId: r.handover_id,
  }));
}

/**
 * Who to tell that `dependent` is startable.
 *
 * The task's owner, and the Project Manager when there is no owner.
 *
 * THE FALLBACK IS THE POINT. An unblocked task with nobody assigned is not a
 * quiet edge case — it is a scheduling gap, and it is the state most likely to
 * sit untouched, because the only person who could notice it is the one who has
 * not been told. Falling back to the PM turns a dropped message into "this is
 * ready and nobody owns it", which is a thing they can act on.
 *
 * The PM is NOT added alongside an owner. On a dense graph that would make them
 * the recipient of most of this traffic, and a manager copied on everything
 * stops reading any of it.
 *
 * The actor is excluded throughout: completing a prerequisite for your own next
 * task should not mail you about it.
 */
async function resolveUnblockRecipients(dependent, orgId, actorId) {
  const out = [];

  if (dependent.ownerUserId) {
    if (dependent.ownerUserId !== actorId) {
      const { rows } = await pool.query(
        `SELECT u.id, u.first_name || ' ' || u.last_name AS name
           FROM users u
           JOIN org_users ou ON ou.user_id = u.id AND ou.org_id = $2 AND ou.is_active = TRUE
          WHERE u.id = $1`,
        [dependent.ownerUserId, orgId]);
      out.push(...rows.map(r => ({ userId: r.id, name: r.name, basis: 'assignee' })));
    }
  } else {
    const { rows } = await pool.query(
      `SELECT u.id, u.first_name || ' ' || u.last_name AS name
         FROM sales_handovers h
         JOIN users u ON u.id = h.assigned_service_owner_id
         JOIN org_users ou ON ou.user_id = u.id AND ou.org_id = $2 AND ou.is_active = TRUE
        WHERE h.id = $1 AND h.org_id = $2
          AND u.id <> COALESCE($3::int, -1)`,
      [dependent.handoverId, orgId, actorId ?? null]);
    out.push(...rows.map(r => ({ userId: r.id, name: r.name, basis: 'owner_fallback' })));
  }

  // 2026_140. Anyone following THIS task.
  //
  // A person who followed one task on a 49-task plan almost certainly did so
  // because they are waiting on it, and "it is ready to start" is the highest-
  // signal thing that can happen to a task. Withholding it here would mean the
  // follow button delivers review chatter and misses the one event a follower
  // actually wants.
  //
  // PROJECT-level watchers are NOT included. They did not single this task out,
  // and on a dense graph they would receive an unblock notice for most of the
  // plan — which is how a channel stops being read.
  const { rows: pw } = await pool.query(
    `SELECT u.id, u.first_name || ' ' || u.last_name AS name
       FROM project_play_watchers w
       JOIN users u ON u.id = w.user_id
       JOIN org_users ou ON ou.user_id = u.id AND ou.org_id = $2 AND ou.is_active = TRUE
      WHERE w.handover_id = $3 AND w.org_id = $2
        AND w.play_instance_id = $1
        AND u.id <> COALESCE($4::int, -1)`,
    [dependent.id, orgId, dependent.handoverId, actorId ?? null]);

  // Deduped against the owner: someone can follow a task they own, and two
  // rows here would be two identical emails.
  const seen = new Set(out.map(r => r.userId));
  for (const r of pw) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ userId: r.id, name: r.name, basis: 'play_watcher' });
  }

  return out;
}

/**
 * Fire unblock notices for everything this completion released.
 *
 * BEST-EFFORT AND NEVER THROWS. Called from inside the completion path, which
 * has already committed. A notification failure that propagated would surface
 * to the user as a failed completion, they would retry, and the retry would
 * fail with "this task changed while you were working on it" — turning a silent
 * missed email into a task nobody can close.
 *
 * @param {number}  completedInstanceId  the task that just reached a terminal status
 * @param {number}  orgId
 * @param {number}  actorId              who closed it; never notified
 * @returns {Promise<{unblocked:number, notified:number, errors:number}>}
 */
async function notifyUnblocked(completedInstanceId, orgId, actorId) {
  const out = { unblocked: 0, notified: 0, errors: 0 };
  try {
    const dependents = await newlyUnblocked(completedInstanceId, orgId);
    if (!dependents.length) return out;
    out.unblocked = dependents.length;

    // Lazily required, matching the idiom createNotification already uses for
    // notificationJob: this module is reached from PlaybookPlayService, which
    // is itself reached from playReview, and a load-time require here would
    // add an edge to that graph for no benefit.
    const notificationService = require('./notificationService');

    const { rows: [ctx] } = await pool.query(
      `SELECT COALESCE(NULLIF(btrim(h.name), ''), d.name, a.name, 'this project') AS project_name,
              COALESCE(p.title, 'a task') AS completed_title
         FROM project_play_instances p
         JOIN sales_handovers h ON h.id = p.handover_id AND h.org_id = p.org_id
         LEFT JOIN deals    d ON d.id = h.deal_id
         LEFT JOIN accounts a ON a.id = h.account_id
        WHERE p.id = $1 AND p.org_id = $2`,
      [completedInstanceId, orgId]);

    const projectName    = ctx?.project_name    || 'this project';
    const completedTitle = ctx?.completed_title || 'a task';

    for (const dep of dependents) {
      let recipients = [];
      try {
        recipients = await resolveUnblockRecipients(dep, orgId, actorId);
      } catch (err) {
        out.errors += 1;
        console.warn(`[unblock] recipient lookup failed for instance ${dep.id}:`, err.message);
        continue;
      }

      for (const r of recipients) {
        const url = `${process.env.APP_BASE_URL || 'https://app.gowarmcrm.com'}`
                  + `/handovers/${dep.handoverId}?play=${dep.id}`;

        // Two bodies, because the two recipients are being told different
        // things. The owner is being told to start; the PM, on an unowned
        // task, is being told that something is ready and nobody has it. A
        // shared body would have to be vague enough to suit both, and would
        // then prompt neither to do anything.
        // Three bodies, because three different people are being told three
        // different things. The owner is told to start; the PM, on an unowned
        // task, that something is ready and nobody has it; a follower, that the
        // task they asked about has moved — and a follower must NOT be told to
        // begin, because it is not their task.
        //
        // Before 2026_140 this was a two-way ternary, so a play watcher would
        // have received the owner's copy and been told to start someone else's
        // work.
        const title = r.basis === 'owner_fallback'
          ? `Ready to start, unassigned: ${dep.title}`
          : r.basis === 'play_watcher'
            ? `Unblocked: ${dep.title}`
            : `You can start: ${dep.title}`;
        const body = r.basis === 'owner_fallback'
          ? `"${completedTitle}" is finished on ${projectName}, so "${dep.title}" is no longer `
            + 'blocked. Nobody is assigned to it.'
          : r.basis === 'play_watcher'
            ? `"${completedTitle}" is finished on ${projectName}, so "${dep.title}" — which you `
              + 'follow — is no longer blocked.'
            : `"${completedTitle}" is finished on ${projectName}, so "${dep.title}" is no longer `
              + 'blocked and you can begin.';

        try {
          await notificationService.createNotification(
            orgId, r.userId, TYPE, title, body,
            'handover', dep.handoverId,
            {
              playInstanceId: dep.id,
              unblockedBy: completedInstanceId,
              basis: r.basis,
              url,
            }
          );
          out.notified += 1;
        } catch (err) {
          out.errors += 1;
          console.warn(`[unblock] notify failed for user ${r.userId}:`, err.message);
        }
      }
    }
    return out;
  } catch (err) {
    console.warn('[unblock] notifyUnblocked failed:', err.message);
    out.errors += 1;
    return out;
  }
}

module.exports = {
  notifyUnblocked,
  newlyUnblocked,
  resolveUnblockRecipients,
  TYPE,
  NOTIFIABLE_DEPENDENT_STATUSES,
};
