/**
 * playReviewNotifier.service.js
 *
 * DROP-IN LOCATION: backend/services/playReviewNotifier.service.js  (NEW FILE)
 *
 * Who gets told when a task moves through review, and how (2026_130).
 *
 * ── RECIPIENTS ──────────────────────────────────────────────────────────────
 *
 *   always   the Project Manager (sales_handovers.assigned_service_owner_id)
 *   always   the project creator (created_by)
 *   always   the task's assignee (project_play_instances.owner_user_id)
 *   plus     project_play_watchers — the designated people on this project
 *   never    the person who performed the action
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
 * createNotification() writes the in-app row and already fans out to Slack and
 * web push. Email is added HERE rather than inside createNotification, because
 * doing it there would switch email on for every notification type in the
 * product at once — digests, escalations, revisit nudges — which is a much
 * larger decision than this feature. When email should become a general
 * channel, move the enqueue into createNotification and delete the call below;
 * deliverEmail() is written to work either way.
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

// ── Recipients ──────────────────────────────────────────────────────────────

/**
 * @returns {Promise<Array<{userId, name, email}>>} deduped, actor removed
 */
async function resolveRecipients(handoverId, orgId, { actorId, assigneeId } = {}) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id AS user_id,
            u.first_name || ' ' || u.last_name AS name,
            u.email
       FROM users u
      WHERE u.id IN (
              SELECT h.assigned_service_owner_id FROM sales_handovers h
               WHERE h.id = $1 AND h.org_id = $2
              UNION
              SELECT h.created_by FROM sales_handovers h
               WHERE h.id = $1 AND h.org_id = $2
              UNION
              SELECT w.user_id FROM project_play_watchers w
               WHERE w.handover_id = $1 AND w.org_id = $2
              UNION
              SELECT $3::int
            )
        AND u.id IS NOT NULL
        AND u.id <> COALESCE($4::int, -1)
        -- An inactive user's alerts go nowhere useful and their email may be
        -- decommissioned. Scoped to this org: org_users is the membership.
        AND EXISTS (SELECT 1 FROM org_users ou
                     WHERE ou.org_id = $2 AND ou.user_id = u.id AND ou.is_active = TRUE)`,
    [handoverId, orgId, assigneeId ?? null, actorId ?? null]
  );
  return rows.map(r => ({ userId: r.user_id, name: r.name, email: r.email }));
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
 * @returns {Promise<{recipients:number, errors:number}>}
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

    const recipients = await resolveRecipients(handoverId, orgId, {
      actorId,
      assigneeId: instance?.owner_user_id ?? null,
    });
    if (!recipients.length) return { recipients: 0, errors: 0 };

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
        const notif = await notificationService.createNotification(
          orgId, r.userId, TYPES[event] || TYPES.submitted, title, body,
          'handover', handoverId,
          {
            playInstanceId: instance?.id ?? null,
            event,
            targetStatus: targetStatus ?? null,
            reason: reason ?? null,
            url,
          }
        );
        // Email is NOT enqueued here any more.
        //
        // createNotification() now fans out to email itself, for every
        // notification type, using the same jobId (`email-del-<id>`). Enqueuing
        // a second job with that id would be silently dropped by Bull as a
        // duplicate — and since the generic one is added first, this richer
        // payload would be the one thrown away. Worse, if the ids ever diverged
        // the user would get two copies of the same alert.
        //
        // The deep link survives: `url` goes into the notification's metadata
        // below, and deliverEmail reads metadata.url when building the body.
      } catch (err) {
        errors += 1;
        console.warn(`[playReview] notify failed for user ${r.userId}:`, err.message);
      }
    }
    return { recipients: recipients.length, errors };
  } catch (err) {
    console.warn('[playReview] notify failed:', err.message);
    return { recipients: 0, errors: 1 };
  }
}

/**
 * Email dispatch used to live here (enqueueEmail). It moved into
 * createNotification()'s fan-out so that every notification type is reachable
 * by email, not just review events — see notificationDelivery.deliverEmail.
 * Nothing in this module enqueues email any more.
 */

module.exports = { notify, resolveRecipients, TYPES };
