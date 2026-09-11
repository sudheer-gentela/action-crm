// dailyWorkMoveNotify.service.js
//
// Who is told what about a daily work move request (2026_142), and the daily
// reminder to approvers while a request waits.
//
// ── THE EVENTS ───────────────────────────────────────────────────────
//
//   dailywork_move_requested  to the approvers of every project on a batch —
//                             when a request is raised, and when entries added
//                             later form or join a batch
//   dailywork_move_approved   to the requester and the owner, when a batch moves
//   dailywork_move_rejected   to the requester and the owner, with the reason
//   dailywork_move_withdrawn  to the approvers who still had it waiting
//   dailywork_move_reminder   once a day per approver, while anything has waited
//                             on them since before today
//
// All five route through ONE category, 'move_request', in
// notificationDelivery.TYPE_TO_CATEGORY — so a person can turn this traffic off
// on a channel without touching task reviews, as agreed.
//
// The actor is never told about their own action.
//
// ── NEVER BREAKS THE ACTION ──────────────────────────────────────────
//
// dispatch() is called AFTER the transaction that did the work has committed,
// and it swallows its own failures. A request that was raised, approved or
// moved has happened; a notification that failed to send must not turn that
// into an error on the screen, or tempt someone to press the button again.
//
// ── NOT A CYCLE ──────────────────────────────────────────────────────
//
// dailyWorkMove.service requires this file for approverUserIds and dispatch.
// This file requires nothing from that one.

const { pool } = require('../config/database');
const dwDate = require('./dailyWorkDate');
const notificationService = require('./notificationService');

const TYPES = {
  requested: 'dailywork_move_requested',
  approved:  'dailywork_move_approved',
  rejected:  'dailywork_move_rejected',
  withdrawn: 'dailywork_move_withdrawn',
  reminder:  'dailywork_move_reminder',
};

const ENTITY_TYPE = 'dailywork_move_request';

// The approver reminder's local hour. Morning, unlike the 17:00 logging
// reminder: a decision someone is waiting on is better made at the start of the
// approver's day than at the end of it. Org-overridable, same place as the other
// daily work hours: settings->'dailywork'->>'move_reminder_hour'.
const DEFAULT_MOVE_REMINDER_HOUR = 10;

// My day is where every move screen lives — the review card, the person's own
// requests and the prompt — so every notification lands there.
function dailyWorkUrl() {
  return `${process.env.APP_BASE_URL || 'https://app.gowarmcrm.com'}/#/dailywork`;
}

/**
 * The people who may approve for a project, for granting access and for
 * notifying. Lives here so the grant and the notification cannot disagree
 * about who the approvers are.
 *
 * canManageProject is true for four groups. Org admins and owners are only the
 * FALLBACK here, used when a project has none of the other three: they already
 * hold every enabled module (grantAllEnabledToAdmins), and notifying every
 * admin about every request would be noise. 2026_133 records that initiatives
 * are often created with no owner, which is the case the fallback covers.
 *
 * @param db  anything with .query — a transaction client or the pool
 */
async function approverUserIds(db, orgId, handoverId) {
  const { rows } = await db.query(
    `SELECT DISTINCT x.user_id
       FROM (
         SELECT h.assigned_service_owner_id AS user_id FROM sales_handovers h
          WHERE h.id = $2 AND h.org_id = $1
         UNION ALL
         SELECT h.created_by FROM sales_handovers h
          WHERE h.id = $2 AND h.org_id = $1
         UNION ALL
         SELECT pm.user_id FROM project_members pm
          WHERE pm.org_id = $1 AND pm.context_type = 'handover' AND pm.context_id = $2
            AND pm.status = 'approved' AND pm.exited_at IS NULL AND pm.can_manage = TRUE
       ) x
       JOIN org_users ou ON ou.org_id = $1 AND ou.user_id = x.user_id AND ou.is_active = TRUE
      WHERE x.user_id IS NOT NULL`,
    [orgId, handoverId]);
  if (rows.length) return rows.map(r => r.user_id);

  const { rows: admins } = await db.query(
    `SELECT user_id FROM org_users
      WHERE org_id = $1 AND is_active = TRUE AND role IN ('admin', 'owner')`,
    [orgId]);
  return admins.map(r => r.user_id);
}

async function requestFacts(orgId, requestId) {
  const { rows: [r] } = await pool.query(
    `SELECT r.id, r.owner_user_id, r.requested_by, r.target_handover_id,
            i.title AS item_title,
            COALESCE(NULLIF(btrim(ou.first_name || ' ' || ou.last_name), ''), 'Someone') AS owner_name,
            COALESCE(NULLIF(btrim(ru.first_name || ' ' || ru.last_name), ''), 'Someone') AS requested_by_name,
            COALESCE(NULLIF(btrim(h.name), ''), 'a project') AS target_name,
            p.title AS task_title
       FROM daily_work_move_requests r
       JOIN daily_work_items i ON i.id = r.item_id
       JOIN sales_handovers h ON h.id = r.target_handover_id
       LEFT JOIN users ou ON ou.id = r.owner_user_id
       LEFT JOIN users ru ON ru.id = r.requested_by
       LEFT JOIN project_play_instances p ON p.id = r.play_instance_id
      WHERE r.id = $1 AND r.org_id = $2`,
    [requestId, orgId]);
  return r || null;
}

/** One notification per person, each failure contained to that person. */
async function sendTo(orgId, userIds, type, title, body, requestId, metadata = {}) {
  let sent = 0;
  for (const userId of [...new Set(userIds)].filter(Boolean)) {
    try {
      await notificationService.createNotification(
        orgId, userId, type, title, body, ENTITY_TYPE, requestId,
        { url: dailyWorkUrl(), requestId, ...metadata });
      sent++;
    } catch (err) {
      console.warn(`[dailywork-move] ${type} to user ${userId} failed:`, err.message);
    }
  }
  return sent;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Tell the right people about what just happened on a request.
 *
 * @param events [{ kind: 'requested', batchId }
 *               | { kind: 'moved', batchId }
 *               | { kind: 'rejected', batchId, handoverId, reason }
 *               | { kind: 'withdrawn', batchIds }]
 * @returns {Promise<number>} notifications written. Never throws.
 */
async function dispatch(orgId, actorId, requestId, events = []) {
  if (!events.length) return 0;
  let sent = 0;
  try {
    const f = await requestFacts(orgId, requestId);
    if (!f) return 0;
    const notMe = (ids) => ids.filter(id => id !== actorId);
    const people = notMe([f.requested_by, f.owner_user_id]);
    const forWhom = f.requested_by && f.requested_by !== f.owner_user_id ? ` for ${f.owner_name}` : '';

    for (const ev of events) {
      if (ev.kind === 'requested') {
        const { rows: [batch] } = await pool.query(
          `SELECT b.batch_no,
                  (SELECT count(*)::int FROM daily_work_move_entries m WHERE m.batch_id = b.id) AS entries
             FROM daily_work_move_batches b WHERE b.id = $1`, [ev.batchId]);
        const { rows: approvals } = await pool.query(
          `SELECT a.handover_id, a.role, COALESCE(NULLIF(btrim(h.name), ''), 'a project') AS project_name
             FROM daily_work_move_approvals a
             JOIN sales_handovers h ON h.id = a.handover_id
            WHERE a.batch_id = $1 AND a.decision = 'pending'
            ORDER BY (a.role = 'target') DESC`, [ev.batchId]);

        // One notification per person even if they approve for two projects on
        // this batch; the target wording wins because it asks more of them.
        const byUser = new Map();
        for (const a of approvals) {
          for (const u of notMe(await approverUserIds(pool, orgId, a.handover_id))) {
            if (!byUser.has(u)) byUser.set(u, a);
          }
        }
        const later = batch && batch.batch_no > 1;
        const count = batch ? plural(batch.entries, 'entry', 'entries') : 'some entries';
        for (const [u, a] of byUser) {
          const title = later
            ? `More work asking to join ${f.target_name}`
            : `Daily work asking to join ${f.target_name}`;
          const body = a.role === 'target'
            ? `${f.requested_by_name}${forWhom} would like “${f.item_title}” moved onto ${f.target_name}`
              + ` (${later ? `${count} added since` : count}). Open My day to choose the task and decide.`
            : `${f.requested_by_name}${forWhom} would like “${f.item_title}” moved onto ${f.target_name}.`
              + ` Some of it is tagged to ${a.project_name}, which you manage. Open My day to decide.`;
          sent += await sendTo(orgId, [u], TYPES.requested, title, body, requestId,
            { batchNo: batch ? batch.batch_no : null, handoverId: a.handover_id, role: a.role });
        }
      }

      else if (ev.kind === 'moved') {
        const { rows: counts } = await pool.query(
          `SELECT outcome, count(*)::int AS n FROM daily_work_move_entries
            WHERE batch_id = $1 GROUP BY outcome`, [ev.batchId]);
        const n = Object.fromEntries(counts.map(c => [c.outcome, c.n]));
        const parts = [];
        if (n.moved) parts.push(`${plural(n.moved, 'entry', 'entries')} moved`);
        if (n.merged) parts.push(`${plural(n.merged, 'entry', 'entries')} merged into work already on the task — tidy ${n.merged === 1 ? 'it' : 'them'} up and mark done`);
        if (n.left_out_too_long) parts.push(`${plural(n.left_out_too_long, 'entry', 'entries')} waiting to be shortened before ${n.left_out_too_long === 1 ? 'it moves' : 'they move'}`);
        if (n.excluded) parts.push(`${plural(n.excluded, 'entry', 'entries')} left where they were`);
        const body = `“${f.item_title}” is now on ${f.target_name}`
          + `${f.task_title ? `, on the task “${f.task_title}”` : ''}.`
          + `${parts.length ? ` ${parts.join('; ')}.` : ''} New work on it goes to the task.`;
        sent += await sendTo(orgId, people, TYPES.approved, `Moved onto ${f.target_name}`, body, requestId,
          { batchId: ev.batchId });
      }

      else if (ev.kind === 'rejected') {
        const { rows: [ctx] } = await pool.query(
          `SELECT b.batch_no, COALESCE(NULLIF(btrim(h.name), ''), 'a project') AS project_name
             FROM daily_work_move_batches b, sales_handovers h
            WHERE b.id = $1 AND h.id = $2`, [ev.batchId, ev.handoverId]);
        const later = ctx && ctx.batch_no > 1;
        const title = later ? `Added entries not moved to ${f.target_name}` : `Not moved to ${f.target_name}`;
        const body = (later
          ? `The entries added to “${f.item_title}” later were not moved.`
          : `“${f.item_title}” was not moved onto ${f.target_name}.`)
          + ` ${ctx ? ctx.project_name : 'The project'}’s manager said: “${ev.reason}”`;
        sent += await sendTo(orgId, people, TYPES.rejected, title, body, requestId,
          { batchId: ev.batchId, handoverId: ev.handoverId });
      }

      else if (ev.kind === 'withdrawn' && ev.batchIds && ev.batchIds.length) {
        const { rows: approvals } = await pool.query(
          `SELECT DISTINCT a.handover_id FROM daily_work_move_approvals a
            WHERE a.batch_id = ANY($1::int[]) AND a.decision = 'pending'`, [ev.batchIds]);
        const users = new Set();
        for (const a of approvals) {
          for (const u of notMe(await approverUserIds(pool, orgId, a.handover_id))) users.add(u);
        }
        sent += await sendTo(orgId, [...users], TYPES.withdrawn,
          `Request withdrawn: “${f.item_title}”`,
          `${f.requested_by_name} withdrew the request to move “${f.item_title}” onto ${f.target_name}. `
          + 'Nothing is needed from you.', requestId);
      }
    }
  } catch (err) {
    console.warn(`[dailywork-move] notifications for request ${requestId} failed:`, err.message);
  }
  return sent;
}

/* ───────────────────────── the daily reminder ──────────────────────── */

function hourOr(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

async function alreadyReminded(orgId, userId, localDate) {
  // Bounded like dailyWorkNotify.alreadySent, for the same reason: the metadata
  // key is not indexed, and an unbounded scan grows every week.
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
      WHERE org_id = $1 AND user_id = $2 AND type = $3
        AND created_at > now() - interval '3 days'
        AND metadata->>'local_date' = $4
      LIMIT 1`,
    [orgId, userId, TYPES.reminder, localDate]);
  return rows.length > 0;
}

/**
 * Remind each approver, once a day at their local hour, about everything
 * still waiting on them.
 *
 * ONLY WHAT HAS WAITED INTO A NEW DAY. A request raised this morning already
 * produced a notification this morning; reminding about it the same day is the
 * nagging dailyWorkNotify's header warns against. So a waiting approval counts
 * once its batch was created before the approver's local today.
 *
 * ONE NOTIFICATION, not one per request: "three things are waiting" is read,
 * three separate reminders are dismissed.
 *
 * Runs hourly and self-filters per approver, the same pattern as the logging
 * reminder and the rollup. Call it from the scheduler; `now` exists for tests.
 */
async function runMoveReminders({ now = new Date() } = {}) {
  const summary = { considered: 0, sent: 0, skipped: {} };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };

  let orgIds;
  try { orgIds = await notificationService.getActiveOrgIds(); }
  catch (err) { console.error('[dailywork-move] reminder org scan failed:', err.message); return summary; }

  for (const orgId of orgIds) {
    let waiting;
    try {
      ({ rows: waiting } = await pool.query(
        `SELECT a.handover_id, b.created_at AS waiting_since, r.id AS request_id,
                i.title AS item_title,
                COALESCE(NULLIF(btrim(ou.first_name || ' ' || ou.last_name), ''), 'Someone') AS owner_name,
                COALESCE(NULLIF(btrim(t.name), ''), 'a project') AS target_name,
                o.settings->'dailywork'->>'move_reminder_hour' AS reminder_hour
           FROM daily_work_move_approvals a
           JOIN daily_work_move_batches b  ON b.id = a.batch_id AND b.status = 'pending'
           JOIN daily_work_move_requests r ON r.id = a.request_id AND r.is_open
           JOIN daily_work_items i ON i.id = r.item_id
           JOIN sales_handovers t ON t.id = r.target_handover_id
           JOIN organizations o ON o.id = a.org_id
           LEFT JOIN users ou ON ou.id = r.owner_user_id
          WHERE a.org_id = $1 AND a.decision = 'pending'
          ORDER BY b.created_at`,
        [orgId]));
    } catch (err) {
      console.error(`[dailywork-move] org ${orgId} reminder scan failed:`, err.message);
      continue;
    }
    if (!waiting.length) continue;

    // Who approves what. A request waiting on two projects managed by the same
    // person is listed once for them.
    const byUser = new Map();
    const approversOf = new Map();
    for (const w of waiting) {
      if (!approversOf.has(w.handover_id)) {
        approversOf.set(w.handover_id, await approverUserIds(pool, orgId, w.handover_id));
      }
      for (const u of approversOf.get(w.handover_id)) {
        if (!byUser.has(u)) byUser.set(u, new Map());
        if (!byUser.get(u).has(w.request_id)) byUser.get(u).set(w.request_id, w);
      }
    }

    const hour = hourOr(waiting[0].reminder_hour, DEFAULT_MOVE_REMINDER_HOUR);

    for (const [userId, requests] of byUser) {
      summary.considered++;
      try {
        const tz = await dwDate.resolveTimezone((sql, params) => pool.query(sql, params), orgId, userId);
        if (dwDate.localHour(tz, now) !== hour) { skip('wrong_hour'); continue; }

        const today = dwDate.localDate(tz, now);
        const due = [...requests.values()].filter(w => dwDate.localDate(tz, new Date(w.waiting_since)) < today);
        if (!due.length) { skip('nothing_waited_overnight'); continue; }
        if (await alreadyReminded(orgId, userId, today)) { skip('already_reminded'); continue; }

        const lines = due.slice(0, 5).map(w => `• ${w.owner_name}: “${w.item_title}” → ${w.target_name}`);
        if (due.length > 5) lines.push(`…and ${due.length - 5} more`);
        await notificationService.createNotification(
          orgId, userId, TYPES.reminder,
          `${plural(due.length, 'move request is', 'move requests are')} waiting for your decision`,
          `${lines.join('\n')}\n\nOpen My day to decide.`,
          ENTITY_TYPE, due.length === 1 ? due[0].request_id : null,
          { url: dailyWorkUrl(), local_date: today, requestIds: due.map(w => w.request_id) });
        summary.sent++;
      } catch (err) {
        skip('error');
        console.warn(`[dailywork-move] reminder for user ${userId} failed:`, err.message);
      }
    }
  }
  return summary;
}

module.exports = {
  TYPES,
  ENTITY_TYPE,
  DEFAULT_MOVE_REMINDER_HOUR,
  approverUserIds,
  dispatch,
  runMoveReminders,
};
