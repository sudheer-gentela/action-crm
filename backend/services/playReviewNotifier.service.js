/**
 * playReviewNotifier.service.js
 *
 * Who gets told when a task moves through review, and how (2026_130, 2026_138).
 *
 * ── RECIPIENTS ──────────────────────────────────────────────────────────────
 *
 * Every recipient carries a BASIS — the reason they are on the list — and the
 * basis decides which events reach them. Before 2026_138 the list was flat and
 * everyone on it got everything.
 *
 *   basis        who                                      receives
 *   ─────────────────────────────────────────────────────────────────────────
 *   owner        the Project Manager                      every event
 *   creator      whoever created the project              every event
 *   assignee     the task's owner_user_id                 every event
 *   watcher      project_play_watchers, incl. self-added  every event
 *   member       approved project_members (2026_138)      COMPLETIONS ONLY
 *
 *   never        the person who performed the action
 *
 * WHY MEMBERS ARE NOT SIMPLY ADDED TO THE FLAT LIST. A project team is the
 * whole point of project_members — on a 49-task plan with eight people, giving
 * every member every submission, approval and rejection is somewhere near four
 * hundred alerts for work most of them are not reviewing. A channel that
 * arrives at that volume gets filtered to a folder, and then the two events
 * that genuinely needed a human — a rejection, a stalled submission — arrive in
 * the folder too. Restraint here is what keeps the channel worth having.
 *
 * A completion is different in kind. It is the event that changes what other
 * people can do: it clears dependencies, it moves the stage, it is the thing a
 * colleague is waiting on. That is worth everyone's attention and nothing else
 * on this list is.
 *
 * A member who WANTS everything subscribes themselves, which promotes them to
 * basis 'watcher' through the existing mechanism. There is deliberately no
 * per-project preference table for this: the watcher list already means "tell
 * this person about review activity on this project", and inventing a second
 * concept that means the same thing is how two lists start disagreeing.
 *
 * The PM and creator are resolved from the project row rather than from the
 * watchers table on purpose: a membership table that can be emptied must not
 * be able to silence the two people accountable for the project.
 *
 * The actor is excluded because an alert telling you what you just did is
 * noise, and noise is how people learn to ignore a channel.
 *
 * ── CHANNELS ────────────────────────────────────────────────────────────────
 *
 * createNotification() writes the in-app row and already fans out to Slack,
 * web push and email. Nothing here enqueues email directly — see the note in
 * the dispatch loop.
 */

const { pool }            = require('../config/database');
const notificationService = require('./notificationService');

// Notification types. Prefixed so they can be filtered, routed and later given
// their own preference category without touching the payloads.
const TYPES = {
  submitted:     'play_review_submitted',
  approved:      'play_review_approved',
  rejected:      'play_review_rejected',
  closed_direct: 'play_review_closed',
};

const TARGET_VERB = {
  completed: 'completed',
  skipped:   'skipped',
  cancelled: 'cancelled',
};

/**
 * The events that represent a task REACHING a terminal state.
 *
 * 'approved' is a manager approving a submission; 'closed_direct' is a manager
 * closing a task without one. Both end with the task done. 'submitted' and
 * 'rejected' are mid-loop, and are the two this list exists to withhold.
 *
 * "Completion" here includes a skip and a cancellation, because targetStatus
 * can be any of the three and all three end the task. Someone waiting on a
 * prerequisite cares that it is finished with, not which of the three ways it
 * finished — which is the same rule _outstandingPrereqs already applies.
 */
const COMPLETION_EVENTS = ['approved', 'closed_direct'];

/** Bases that receive completions only. Everything else receives everything. */
const COMPLETION_ONLY_BASES = ['member'];

// ── Recipients ──────────────────────────────────────────────────────────────

/**
 * @returns {Promise<Array<{userId, name, email, basis}>>} deduped, actor removed
 *
 * ONE ROW PER PERSON, not one per reason. Someone can be the creator AND an
 * approved member AND a watcher; they must be notified once. The basis kept is
 * the most permissive one, resolved by the DISTINCT ON + ORDER BY rank below.
 *
 * That ordering is load-bearing, not tidiness. Without it a Project Manager who
 * also holds a project_members row could be resolved as 'member' and would stop
 * receiving submissions on their own project — the exact failure this function
 * exists to prevent, arriving silently through a rule meant to reduce noise.
 */
async function resolveRecipients(handoverId, orgId, { actorId, assigneeId } = {}) {
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT h.assigned_service_owner_id AS user_id, 'owner'::text AS basis, 1 AS rank
         FROM sales_handovers h WHERE h.id = $1 AND h.org_id = $2
       UNION ALL
       SELECT h.created_by, 'creator', 2
         FROM sales_handovers h WHERE h.id = $1 AND h.org_id = $2
       UNION ALL
       SELECT $3::int, 'assignee', 3
       UNION ALL
       SELECT w.user_id, 'watcher', 4
         FROM project_play_watchers w
        WHERE w.handover_id = $1 AND w.org_id = $2
       UNION ALL
       -- 2026_138. Approved, non-exited members of THIS project.
       --
       -- 'approved' only: a pending row is an unreviewed request to join, and
       -- notifying on one would leak a project's task titles to somebody who
       -- has merely asked for access. exited_at is written out for the reader;
       -- 2026_88's CHECK already makes it redundant against 'approved'.
       SELECT pm.user_id, 'member', 5
         FROM project_members pm
        WHERE pm.context_type = 'handover'
          AND pm.context_id   = $1
          AND pm.org_id       = $2
          AND pm.status       = 'approved'
          AND pm.exited_at IS NULL
     )
     SELECT DISTINCT ON (c.user_id)
            c.user_id, c.basis,
            u.first_name || ' ' || u.last_name AS name,
            u.email
       FROM candidates c
       JOIN users u ON u.id = c.user_id
      WHERE c.user_id IS NOT NULL
        AND c.user_id <> COALESCE($4::int, -1)
        -- An inactive user's alerts go nowhere useful and their email may be
        -- decommissioned. Scoped to this org: org_users is the membership.
        AND EXISTS (SELECT 1 FROM org_users ou
                     WHERE ou.org_id = $2 AND ou.user_id = c.user_id AND ou.is_active = TRUE)
      ORDER BY c.user_id, c.rank`,
    [handoverId, orgId, assigneeId ?? null, actorId ?? null]
  );
  return rows.map(r => ({ userId: r.user_id, name: r.name, email: r.email, basis: r.basis }));
}

/**
 * Should this recipient hear about this event?
 *
 * Exported so any future caller applies one rule rather than re-deriving "is
 * this a completion" for itself.
 */
function shouldNotify(event, basis) {
  if (!COMPLETION_ONLY_BASES.includes(basis)) return true;
  return COMPLETION_EVENTS.includes(event);
}

// ── Copy ────────────────────────────────────────────────────────────────────
//
// Written from the reader's side of the screen: what happened, to which task,
// on which project, and what they are expected to do about it. Nothing here
// says "notification" or names a status the UI does not show.

function buildMessage(event, { projectName, playTitle, actorName, targetStatus, reason }) {
  const verb = TARGET_VERB[targetStatus] || 'completed';

  switch (event) {
    case 'submitted':
      return {
        title: `Ready for review: ${playTitle}`,
        body:  `${actorName} submitted "${playTitle}" on ${projectName} to be marked ${verb}. `
             + 'Review the evidence and approve it, or send it back with a reason.',
      };
    case 'approved':
      return {
        title: `Approved: ${playTitle}`,
        body:  `${actorName} approved "${playTitle}" on ${projectName}. It is now ${verb}.`,
      };
    case 'rejected':
      return {
        title: `Sent back: ${playTitle}`,
        body:  `${actorName} sent "${playTitle}" on ${projectName} back for rework. `
             + `Reason: ${reason}`,
      };
    case 'closed_direct':
      return {
        title: `Marked ${verb}: ${playTitle}`,
        body:  `${actorName} marked "${playTitle}" on ${projectName} as ${verb}. `
             + 'Open it to review the evidence, or send it back if it is not right.',
      };
    default:
      return { title: playTitle, body: `"${playTitle}" changed on ${projectName}.` };
  }
}

function buildEmail({ title, body, projectName, playTitle, url }) {
  // Deliberately plain. This is a transactional alert, not a campaign — the
  // person needs the fact and the link, and an HTML shell with a logo in it
  // buys nothing and breaks in more clients.
  const text = `${body}\n\nProject: ${projectName}\nTask: ${playTitle}\n\n${url}\n`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111827;line-height:1.5">
  <p style="margin:0 0 12px"><strong>${escapeHtml(title)}</strong></p>
  <p style="margin:0 0 12px">${escapeHtml(body)}</p>
  <p style="margin:0 0 4px;color:#6b7280;font-size:12px">Project: ${escapeHtml(projectName)}</p>
  <p style="margin:0 0 16px;color:#6b7280;font-size:12px">Task: ${escapeHtml(playTitle)}</p>
  <p style="margin:0"><a href="${url}" style="color:#1d4ed8">Open the task</a></p>
</div>`;
  return { text, html };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Fan a review event out to everyone who should hear about it.
 *
 * Best-effort throughout: the status change is already committed and is the
 * source of truth. A notification failure must never surface as a failed
 * transition — the assignee would retry, and the second attempt would fail
 * with "this task changed while you were working on it".
 *
 * @param {'submitted'|'approved'|'rejected'|'closed_direct'} event
 * @returns {Promise<{recipients:number, suppressed:number, errors:number}>}
 */
async function notify(event, { orgId, handoverId, instance, actorId, targetStatus, reason }) {
  try {
    const { rows: [ctx] } = await pool.query(
      // h.name is the internal-project name (2026_87); deal/account names carry
      // customer projects. An internal project has deal_id NULL, so the
      // COALESCE order matters — h.name must win where it is set.
      `SELECT COALESCE(NULLIF(btrim(h.name), ''), d.name, a.name, 'this project') AS project_name,
              au.first_name || ' ' || au.last_name AS actor_name
         FROM sales_handovers h
         LEFT JOIN deals    d ON d.id = h.deal_id
         LEFT JOIN accounts a ON a.id = h.account_id
         LEFT JOIN users   au ON au.id = $3
        WHERE h.id = $1 AND h.org_id = $2`,
      [handoverId, orgId, actorId]);

    const projectName = ctx?.project_name || 'this project';
    const actorName   = ctx?.actor_name   || 'Someone';
    const playTitle   = instance?.title   || 'a task';

    const all = await resolveRecipients(handoverId, orgId, {
      actorId,
      assigneeId: instance?.owner_user_id ?? null,
    });

    // Filtered AFTER resolution rather than inside the query, so `suppressed`
    // is a real number the caller can log. A recipient set that silently shrank
    // from eleven to three is exactly what somebody needs to be able to see
    // when they ask why a member did not hear about something.
    const recipients = all.filter(r => shouldNotify(event, r.basis));
    const suppressed = all.length - recipients.length;

    if (!recipients.length) return { recipients: 0, suppressed, errors: 0 };

    const { title, body } = buildMessage(event, {
      projectName, playTitle, actorName,
      targetStatus: targetStatus || instance?.review_target_status,
      reason,
    });

    const url = `${process.env.APP_BASE_URL || 'https://app.gowarmcrm.com'}`
              + `/handovers/${handoverId}?play=${instance?.id ?? ''}`;

    let errors = 0;
    for (const r of recipients) {
      try {
        await notificationService.createNotification(
          orgId, r.userId, TYPES[event] || TYPES.submitted, title, body,
          'handover', handoverId,
          {
            playInstanceId: instance?.id ?? null,
            event,
            targetStatus: targetStatus ?? null,
            reason: reason ?? null,
            // Stored so that a later question — "why did this person get this?"
            // — is answerable from the row itself, rather than by re-running
            // the resolver against a project whose membership has since
            // changed and would now give a different answer.
            basis: r.basis,
            url,
          }
        );
        // Email is NOT enqueued here.
        //
        // createNotification() fans out to email itself, for every notification
        // type, using the same jobId (`email-del-<id>`). Enqueuing a second job
        // with that id would be silently dropped by Bull as a duplicate — and
        // since the generic one is added first, this richer payload would be
        // the one thrown away.
        //
        // The deep link survives: `url` goes into the notification's metadata
        // above, and deliverEmail reads metadata.url when building the body.
      } catch (err) {
        errors += 1;
        console.warn(`[playReview] notify failed for user ${r.userId}:`, err.message);
      }
    }
    return { recipients: recipients.length, suppressed, errors };
  } catch (err) {
    console.warn('[playReview] notify failed:', err.message);
    return { recipients: 0, suppressed: 0, errors: 1 };
  }
}

/**
 * Email dispatch used to live here (enqueueEmail). It moved into
 * createNotification()'s fan-out so that every notification type is reachable
 * by email, not just review events — see notificationDelivery.deliverEmail.
 * Nothing in this module enqueues email any more.
 */

module.exports = {
  notify,
  resolveRecipients,
  shouldNotify,
  buildEmail,
  TYPES,
  COMPLETION_EVENTS,
};
