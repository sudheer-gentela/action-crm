// projectPlayAssignees.service.js
//
// Who is assigned to a project task (2026_141).
//
// A task has ONE owner — project_play_instances.owner_user_id, which keeps
// every meaning it already had: accountable, submits for review, frozen while
// a review is pending, the single recipient of dependency and review
// notifications. Assignees are everyone who WORKS on it and may log daily work
// against it. The owner is always one of them.
//
// ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────
//
// handover.service.js is already 6,852 lines and playReview.service.js has to
// ask this question too. Putting it in handover.service would either grow that
// file again or create the require cycle playReview's own header describes
// working around ("it will require THIS module ... so reaching back into it
// would create a cycle").
//
// This module requires NOTHING from either of them. It takes handoverId and
// orgId as parameters and asks projectMembers for authority, which both of
// them already do. Nothing here can close a cycle.
//
// ── THE ONE PREDICATE ────────────────────────────────────────────────
//
// assignedToSql() below is the only definition of "is this person on this
// task", and every read uses it. It does not test owner_user_id, and that is
// correct ONLY because trg_sync_play_owner_assignee guarantees the owner has a
// row. If that trigger is ever dropped, this predicate starts silently hiding
// owners from their own work — see the deploy notes in 2026_141.

const { pool } = require('../config/database');
const projectMembers = require('./projectMembers.service');

/* ───────────────────────── the shared predicate ────────────────────── */

/**
 * SQL fragment: is `userParam` assigned to the play aliased `playAlias`?
 *
 * Returned as text rather than as a whole query because the six callers differ
 * in their joins, their windows and their ordering, and only agree about this.
 * Same technique as projectMembers.manageableProjectSql and the
 * OPEN_PLAY_PREDICATES constant it sits beside.
 *
 * EXISTS rather than a JOIN, deliberately: a join to a one-to-many table
 * multiplies the outer rows, and every one of these six queries would then
 * need a DISTINCT that changes what its ORDER BY means. EXISTS stops at the
 * first hit and leaves row counts alone.
 *
 * idx_ppa_instance (2026_109) serves it.
 *
 * @param {string} playAlias  alias of project_play_instances in the caller
 * @param {string} userParam  the caller's bound parameter, e.g. '$1'
 */
function assignedToSql(playAlias, userParam) {
  return `EXISTS (SELECT 1 FROM project_play_assignees ppa
                   WHERE ppa.instance_id = ${playAlias}.id
                     AND ppa.user_id = ${userParam})`;
}

/* ───────────────────────── reads ───────────────────────────────────── */

/**
 * Everyone on one task, owner first.
 *
 * is_owner is computed from the instance rather than stored on the assignee
 * row. A stored copy is a second answer to a question the instance already
 * answers, and the whole reason this table can be trusted is that it has no
 * second answers in it.
 */
async function listForPlay(instanceId, orgId) {
  const { rows } = await pool.query(
    `SELECT a.user_id,
            (a.user_id = p.owner_user_id) AS is_owner,
            a.assigned_by, a.created_at,
            u.first_name, u.last_name, u.email
       FROM project_play_assignees a
       JOIN project_play_instances p
         ON p.id = a.instance_id AND p.org_id = $2
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.instance_id = $1
      ORDER BY (a.user_id = p.owner_user_id) DESC, a.created_at, a.user_id`,
    [instanceId, orgId]);

  return rows.map(r => ({
    userId:     r.user_id,
    isOwner:    r.is_owner === true,
    assignedBy: r.assigned_by,
    assignedAt: r.created_at,
    // Same name precedence as every other user picker in this codebase
    // (handover.service.js ~1395, HandoverView.js ~4960). Null-safe: a user
    // removed from the org leaves the row attributed to nobody rather than
    // taking the assignment with them.
    name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
          || r.email || null,
  }));
}

/**
 * Assignees for many tasks at once, as { [instanceId]: [...] }.
 *
 * The checklist draws every row on the page and would otherwise issue one
 * query per task. Handed the ids the caller already has rather than deriving
 * them from handover_id, so a filtered or paged checklist asks about exactly
 * what it is about to render.
 */
async function listForPlays(instanceIds, orgId) {
  const ids = (instanceIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (!ids.length) return {};

  const { rows } = await pool.query(
    `SELECT a.instance_id, a.user_id,
            (a.user_id = p.owner_user_id) AS is_owner,
            u.first_name, u.last_name, u.email
       FROM project_play_assignees a
       JOIN project_play_instances p
         ON p.id = a.instance_id AND p.org_id = $2
      WHERE a.instance_id = ANY($1::int[])
      ORDER BY a.instance_id, (a.user_id = p.owner_user_id) DESC, a.created_at`,
    [ids, orgId]);

  const out = {};
  for (const r of rows) {
    (out[r.instance_id] ||= []).push({
      userId:  r.user_id,
      isOwner: r.is_owner === true,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
            || r.email || null,
    });
  }
  return out;
}

/**
 * Who may be assigned to tasks on this project.
 *
 * ── THIS IS NARROWER THAN THE OWNER PICKER USED TO BE ────────────────
 *
 * HandoverView declared its `users` list as "org members for owner pickers"
 * and offered the WHOLE ORG. That was already inconsistent with the write
 * path: dailyWork's _canLogAgainstTask delegates to
 * handover.getNoteVisibility, whose canNote requires membership or a
 * management relationship — so a non-member who was made owner got the task on
 * their My day and was then refused at the composer.
 *
 * Restricting the picker closes that gap rather than opening a new one, but it
 * IS a visible tightening: the owner dropdown gets shorter on every project,
 * including on tasks nobody is touching. Expect the same first-day support
 * noise 2026_130 generated.
 *
 * approved AND not exited: project_members_status_chk allows pending,
 * rejected, declined and left, and project_members_exit_shape_chk ties
 * exited_at to the last two. Someone who has left the project is not staffable
 * onto its tasks, and someone whose request is still pending has not been let
 * in yet.
 */
async function listAssignableMembers(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT m.user_id, m.side, u.first_name, u.last_name, u.email
       FROM project_members m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.context_type = 'handover'
        AND m.context_id = $1
        AND m.org_id = $2
        AND m.status = 'approved'
        AND m.exited_at IS NULL
      ORDER BY u.first_name, u.last_name, m.user_id`,
    [handoverId, orgId]);

  return rows.map(r => ({
    userId: r.user_id,
    side:   r.side,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
          || r.email || null,
  }));
}

/* ───────────────────────── writes ──────────────────────────────────── */

/**
 * May this user staff this task?
 *
 * The project's managers, or the task's own owner.
 *
 * The owner is included on purpose. They are accountable for the task, and
 * "pull Arun in to help me" is the ordinary case this feature exists for —
 * routing it through a manager would make the common path the slow one. It is
 * also no wider than what they can already do: updatePlay lets an assignee
 * hand ownership to anyone, which is a bigger act than adding a second pair of
 * hands.
 *
 * A plain assignee may NOT. Being put on a task is not authority to decide who
 * else is on it.
 */
async function canAssign(handoverId, orgId, instanceId, userId) {
  if (!userId) return false;
  if (await projectMembers.canManageProject(handoverId, orgId, userId)) return true;

  const { rows: [play] } = await pool.query(
    `SELECT owner_user_id FROM project_play_instances
      WHERE id = $1 AND handover_id = $2 AND org_id = $3`,
    [instanceId, handoverId, orgId]);

  return !!play && play.owner_user_id != null && play.owner_user_id === userId;
}

/**
 * Set the full assignee list for one task.
 *
 * REPLACE, not add: the caller sends the list it wants to end up with, the
 * same shape as setPlayDependencies. A popover that can only add is a popover
 * that needs a second, different control to remove.
 *
 * ── ONE TRANSACTION ──────────────────────────────────────────────────
 *
 * Deletes and inserts together. Split across two, a rejected insert would
 * leave the removals applied — a task with fewer people on it than either the
 * old list or the new one, which is a state nobody asked for.
 *
 * ── THE OWNER CANNOT BE DROPPED ──────────────────────────────────────
 *
 * Refused here with a sentence, and refused again by
 * trg_protect_play_owner_assignee if anything ever reaches the table another
 * way. The check is first so the caller gets the explanation rather than a raw
 * restrict_violation surfacing in the Projects UI — the same pairing 2026_136
 * used for removePlay and its foreign key.
 *
 * @param {number[]} userIds  the complete intended list; the owner may be
 *                            omitted and is added back rather than refused,
 *                            since a UI that ticks the owner as a courtesy and
 *                            one that leaves them implicit should both work.
 * @returns {{assignees: object[], added: number[], removed: number[]}}
 */
async function setAssignees(handoverId, orgId, instanceId, userIds, actorId) {
  if (!(await canAssign(handoverId, orgId, instanceId, actorId))) {
    throw Object.assign(
      new Error('Only the project manager, or the person this task is assigned to, can change who is on it.'),
      { status: 403, code: 'NOT_PERMITTED' });
  }

  const { rows: [play] } = await pool.query(
    `SELECT id, owner_user_id, status FROM project_play_instances
      WHERE id = $1 AND handover_id = $2 AND org_id = $3`,
    [instanceId, handoverId, orgId]);
  if (!play) {
    throw Object.assign(new Error('Task does not belong to this project'), { status: 404 });
  }
  if (['completed', 'skipped', 'cancelled'].includes(play.status)) {
    // Its linked daily work items are already closed by
    // trg_close_daily_work_items_for_play, so a new assignee would get a task
    // they cannot log against and cannot close.
    throw Object.assign(
      new Error('That task is closed. Reopen it before changing who is on it.'),
      { status: 409, code: 'TASK_CLOSED' });
  }

  // Deduplicated, integers only, owner forced in.
  const wanted = new Set(
    (userIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger));
  if (play.owner_user_id != null) wanted.add(play.owner_user_id);

  // Membership, checked in ONE query rather than per user: the failure worth
  // reporting is "these three people are not on the project", and a loop that
  // throws on the first one makes the caller discover them one at a time.
  const ids = [...wanted];
  if (ids.length) {
    const { rows: ok } = await pool.query(
      `SELECT user_id FROM project_members
        WHERE context_type = 'handover' AND context_id = $1 AND org_id = $2
          AND user_id = ANY($3::int[])
          AND status = 'approved' AND exited_at IS NULL`,
      [handoverId, orgId, ids]);

    const allowed = new Set(ok.map(r => r.user_id));
    const refused = ids.filter(id => !allowed.has(id));
    if (refused.length) {
      throw Object.assign(
        new Error(refused.length === 1
          ? 'That person is not on this project. Add them to the project team first.'
          : `${refused.length} of those people are not on this project. Add them to the project team first.`),
        { status: 400, code: 'NOT_PROJECT_MEMBER', userIds: refused });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: before } = await client.query(
      `SELECT user_id FROM project_play_assignees WHERE instance_id = $1`,
      [instanceId]);
    const current = new Set(before.map(r => r.user_id));

    const toAdd    = ids.filter(id => !current.has(id));
    const toRemove = [...current].filter(id => !wanted.has(id));

    if (toRemove.includes(play.owner_user_id)) {
      throw Object.assign(
        new Error('The task owner stays assigned. Change the owner first if they are leaving this task.'),
        { status: 409, code: 'CANNOT_UNASSIGN_OWNER' });
    }

    if (toRemove.length) {
      await client.query(
        `DELETE FROM project_play_assignees
          WHERE instance_id = $1 AND user_id = ANY($2::int[])`,
        [instanceId, toRemove]);
    }

    if (toAdd.length) {
      // ON CONFLICT against project_play_assignees_instance_id_user_id_key
      // (2026_110) rather than a pre-check: two managers staffing the same
      // task at once is a real race, and the constraint is the only thing
      // that can settle it.
      await client.query(
        `INSERT INTO project_play_assignees (instance_id, user_id, assigned_by)
         SELECT $1, u, $3 FROM unnest($2::int[]) AS u
         ON CONFLICT (instance_id, user_id) DO NOTHING`,
        [instanceId, toAdd, actorId]);
    }

    await client.query('COMMIT');
    return {
      assignees: await listForPlay(instanceId, orgId),
      added:     toAdd,
      removed:   toRemove,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  assignedToSql,
  listForPlay,
  listForPlays,
  listAssignableMembers,
  canAssign,
  setAssignees,
};
