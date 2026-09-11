// dailyWorkMove.service.js
//
// Moving daily work onto a project plan, with approval. Schema: 2026_142.
//
// Someone logs work against an item that is on no project task. It does not
// appear anywhere on the plan, because a project only shows work linked to its
// own tasks (2026_136). This service lets the person — or their line manager —
// ask for that work to join a task, lets the project's manager decide, and
// moves it.
//
// ── THE FLOW ─────────────────────────────────────────────────────────
//
//   createRequest   the requester picks the item, the target project and the
//                   entries. Batch 1 is created, with an approval row for the
//                   target and for every other open TIMEBOXED project the item
//                   or a selected entry is tagged to. Approvers who lack Daily
//                   Work access are granted it.
//   addEntries      the requester adds entries logged since. Into the waiting
//                   batch if nobody has decided on it yet, otherwise a new
//                   batch with its own approvals. Refused once batch 1 moved.
//   decide          an approver approves or rejects their project's row, and
//                   may untick entries (the target: any; a source: only
//                   entries tagged to that source). The target chooses the
//                   task on batch 1. When every row of a batch is approved the
//                   batch moves, in the same transaction.
//   withdraw        the requester withdraws what is still waiting.
//
// ── WHAT A MOVE DOES ─────────────────────────────────────────────────
//
//   1. puts the owner on the project and on the task, if they are not already
//   2. finds or creates the owner's linked item for the task — the same item
//      postTaskUpdate would create (dailyWork.findOrCreateLinkedItem)
//   3. for each selected entry, in date order:
//        no entry on the task that day  re-point it and re-tag it to the target
//        an entry on the task that day  merge the text into it and flag it
//                                       "needs edit"; copy evidence and notes
//                                       across; delete the source entry
//        merged text over the limit     leave it where it is, pending, and
//                                       merge automatically once it fits
//   4. batch 1 only: an assigned item becomes 'moved'; a recurring item's owner
//      is asked on My day whether to retire it or keep it
//
// ── PLACEMENT ────────────────────────────────────────────────────────
//
// The target approver chooses, on batch 1:
//
//   existing task  the work joins a task already on the plan
//   new task       a task is created for it — title, stage, due date, gate,
//                  prerequisites, and existing tasks that should wait on it.
//                  getConflicts shows what that would do to the plan first;
//                  the approver decides, and what they were shown is stored on
//                  their approval row. There is no rescheduler: nothing moves
//                  any other task's dates.
//
// A new task is created when batch 1 MOVES, not when the target approves. Other
// approvals may still be outstanding, and a rejection must not leave a task
// behind on someone's plan. On a plan whose baseline is already frozen it is
// marked as added scope (project_play_instances.scope_added_at).
//
// ── NOTIFICATIONS ────────────────────────────────────────────────────
//
// Each write collects what happened — raised, moved, rejected, withdrawn — and
// hands it to dailyWorkMoveNotify.dispatch AFTER its transaction commits. The
// notifications are a consequence of the action, never part of it: a failure to
// notify is logged and the action stands.
//
// ── TRANSACTIONS AND LOCKS ───────────────────────────────────────────
//
// Every write locks the request row first (SELECT … FOR UPDATE). Two approvers
// completing the last two approvals at the same moment would otherwise both
// see "all approved" and both execute the batch. With the lock, the second
// waits, then sees the batch already approved.
//
// Nothing here creates its own transaction inside another one. The functions
// taking a `client` run inside the caller's transaction, and tryPendingMerges
// in particular runs inside dailyWork._saveDayIn so a save and the merge it
// enables commit together.

const { pool, withOrgTransaction } = require('../config/database');
const dw = require('./dailyWork.service');
const dailyQuery = require('./dailyWorkQuery.service');
const dwDate = require('./dailyWorkDate');
const projectMembers = require('./projectMembers.service');
const moduleAccess = require('./moduleAccess.service');
// The one definition of a stage key, shared with addPlay and planImport.
const { stageKeyFrom } = require('./stageKey');
// Notifications (who is told what) and the one definition of who approves.
const moveNotify = require('./dailyWorkMoveNotify.service');
const { approverUserIds } = moveNotify;

const { DailyWorkError, ITEM_COLUMNS, ENTRY_COLUMNS, MAX_DESCRIPTION, MAX_NEXT_STEPS } = dw;

const OPEN_ASSIGNED_STATUSES = ['yet_to_start', 'in_progress', 'in_review'];
const CLOSED_TASK_STATUSES = ['completed', 'skipped', 'cancelled'];
const CLOSED_PROJECT_STATUSES = ['completed', 'cancelled'];
const MAX_NOTE = 2000;

/* ───────────────────────── small helpers ───────────────────────────── */

function asIds(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0))];
}

function isItemOpen(item) {
  return item.kind === 'assigned'
    ? OPEN_ASSIGNED_STATUSES.includes(item.status)
    : item.status === 'active';
}

function isProjectOpen(p) {
  return !!p && !CLOSED_PROJECT_STATUSES.includes(p.status) && p.retired_at == null;
}

async function localToday(client, orgId, userId) {
  const tz = await dwDate.resolveTimezone((sql, params) => client.query(sql, params), orgId, userId);
  return dwDate.localDate(tz);
}

/**
 * Who may raise or add to a request for this owner: the owner, or someone whose
 * chain contains them. The same boundary every /people read uses, so "whose
 * work may I move" and "whose work may I see" cannot come apart.
 */
async function canActFor(orgId, actorId, ownerId) {
  if (actorId === ownerId) return true;
  const visible = await dailyQuery.getVisibleUserIds(orgId, actorId);
  return visible.includes(ownerId);
}

async function lockRequest(client, orgId, requestId) {
  const { rows } = await client.query(
    `SELECT * FROM daily_work_move_requests WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [requestId, orgId]);
  if (!rows[0]) throw new DailyWorkError('No such move request', 'NO_SUCH_REQUEST', { requestId });
  return rows[0];
}

async function lockItem(client, orgId, itemId) {
  const { rows } = await client.query(
    `SELECT ${ITEM_COLUMNS} FROM daily_work_items WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [itemId, orgId]);
  return rows[0] || null;
}

async function loadProject(client, orgId, handoverId) {
  const { rows } = await client.query(
    `SELECT h.id, COALESCE(NULLIF(btrim(h.name), ''), d.name, 'Untitled project') AS name,
            h.status, h.retired_at, COALESCE(h.tracking_mode, 'timeboxed') AS tracking_mode,
            h.baseline_frozen_at, h.go_live_date::text AS go_live_date
       FROM sales_handovers h
       LEFT JOIN deals d ON d.id = h.deal_id AND d.org_id = h.org_id
      WHERE h.id = $1 AND h.org_id = $2`,
    [handoverId, orgId]);
  return rows[0] || null;
}

/**
 * Refuse an item this feature does not move, with the reason.
 *
 * Three rules, all agreed in the design:
 *   - open items only (a completed, dropped or retired item's work is done)
 *   - not already on a task — that work already shows on the plan, and its link
 *     is never repointed (2026_136)
 *   - not tagged to a DIFFERENT standing initiative. Work that belongs to
 *     another initiative stays there for now; moving it into the initiative it
 *     is already tagged to is allowed.
 */
async function assertItemMovable(client, orgId, item, targetHandoverId) {
  if (item.play_instance_id) {
    throw new DailyWorkError(
      'This item is already logged against a project task, so it is on the plan already.',
      'ITEM_ALREADY_ON_TASK', { itemId: item.id });
  }
  if (!isItemOpen(item)) {
    throw new DailyWorkError(
      'Only open items can be moved. This one is closed.',
      'ITEM_CLOSED', { itemId: item.id, status: item.status });
  }
  if (item.anchor_kind === 'handover' && item.anchor_id !== targetHandoverId) {
    const tagged = await loadProject(client, orgId, item.anchor_id);
    if (tagged && tagged.tracking_mode === 'standing') {
      throw new DailyWorkError(
        `This item belongs to the ${tagged.name} initiative, so it cannot be moved to another project.`,
        'ITEM_ON_OTHER_INITIATIVE', { itemId: item.id, handoverId: tagged.id });
    }
  }
}

/**
 * The entries a requester picked, locked, checked and in date order.
 *
 * Refuses rather than silently dropping. An entry quietly left out would
 * reach the approver as a smaller request than the one that was raised.
 */
async function loadSelectableEntries(client, orgId, item, entryIds, targetHandoverId) {
  const ids = asIds(entryIds);
  if (!ids.length) return [];

  const { rows } = await client.query(
    `SELECT ${ENTRY_COLUMNS} FROM daily_work_entries
      WHERE org_id = $1 AND item_id = $2 AND id = ANY($3::int[])
      ORDER BY entry_date, id
      FOR UPDATE`,
    [orgId, item.id, ids]);
  if (rows.length !== ids.length) {
    const found = new Set(rows.map(r => r.id));
    throw new DailyWorkError(
      'Some of the chosen entries are not on this item.',
      'ENTRY_NOT_ON_ITEM', { entryIds: ids.filter(id => !found.has(id)) });
  }

  const handoverIds = [...new Set(rows
    .filter(r => r.anchor_kind === 'handover' && r.anchor_id !== targetHandoverId)
    .map(r => r.anchor_id))];
  if (handoverIds.length) {
    const { rows: standing } = await client.query(
      `SELECT id, name FROM sales_handovers
        WHERE org_id = $1 AND id = ANY($2::int[])
          AND COALESCE(tracking_mode, 'timeboxed') = 'standing'`,
      [orgId, handoverIds]);
    if (standing.length) {
      const bad = rows.filter(r => standing.some(s => s.id === r.anchor_id)).map(r => r.id);
      throw new DailyWorkError(
        `Entries tagged to the ${standing.map(s => s.name).join(', ')} initiative cannot be moved to another project.`,
        'ENTRY_ON_OTHER_INITIATIVE', { entryIds: bad });
    }
  }

  // uq_dwme_entry_outstanding refuses this too. Checked first for the sentence.
  const { rows: outstanding } = await client.query(
    `SELECT entry_id FROM daily_work_move_entries
      WHERE org_id = $1 AND entry_id = ANY($2::int[])
        AND outcome IN ('pending', 'left_out_too_long')`,
    [orgId, ids]);
  if (outstanding.length) {
    throw new DailyWorkError(
      'Some of the chosen entries are already part of another move request.',
      'ENTRY_ALREADY_IN_REQUEST', { entryIds: outstanding.map(r => r.entry_id) });
  }
  return rows;
}

/**
 * The other projects that must approve: every OPEN, TIMEBOXED project the item
 * or a selected entry is tagged to, other than the target.
 *
 * Open only. A completed, cancelled or retired project has no live plan for
 * this move to disturb, and often nobody left to ask. Standing initiatives
 * never appear: work tagged to another one has already been refused.
 */
async function sourceProjectIds(client, orgId, targetHandoverId, item, entries) {
  const tagged = new Set();
  if (item.anchor_kind === 'handover') tagged.add(item.anchor_id);
  for (const e of entries) if (e.anchor_kind === 'handover') tagged.add(e.anchor_id);
  tagged.delete(targetHandoverId);
  if (!tagged.size) return [];

  const { rows } = await client.query(
    `SELECT id FROM sales_handovers
      WHERE org_id = $1 AND id = ANY($2::int[])
        AND COALESCE(tracking_mode, 'timeboxed') = 'timeboxed'
        AND status NOT IN ('completed', 'cancelled')
        AND retired_at IS NULL
      ORDER BY id`,
    [orgId, [...tagged]]);
  return rows.map(r => r.id);
}

async function ensureApprovalRows(client, orgId, requestId, batchId, targetHandoverId, sourceIds) {
  await client.query(
    `INSERT INTO daily_work_move_approvals (org_id, request_id, batch_id, handover_id, role)
     VALUES ($1, $2, $3, $4, 'target')
     ON CONFLICT (batch_id, handover_id) DO NOTHING`,
    [orgId, requestId, batchId, targetHandoverId]);
  for (const id of sourceIds) {
    await client.query(
      `INSERT INTO daily_work_move_approvals (org_id, request_id, batch_id, handover_id, role)
       VALUES ($1, $2, $3, $4, 'source')
       ON CONFLICT (batch_id, handover_id) DO NOTHING`,
      [orgId, requestId, batchId, id]);
  }
}

/** The snapshot is taken here and never updated — see 2026_142 section 4. */
async function insertMoveEntries(client, orgId, requestId, batchId, entries) {
  for (const e of entries) {
    await client.query(
      `INSERT INTO daily_work_move_entries
         (org_id, request_id, batch_id, entry_id,
          snap_item_id, snap_entry_date, snap_description, snap_next_steps, snap_day_stage,
          snap_activity_type_key, snap_anchor_kind, snap_anchor_id, snap_account_id)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13)`,
      [orgId, requestId, batchId, e.id,
       e.item_id, e.entry_date, e.description, e.next_steps, e.day_stage,
       e.activity_type_key, e.anchor_kind, e.anchor_id, e.account_id]);
  }
}

/**
 * Give Daily Work to every approver of these projects who lacks it.
 *
 * Recorded with source = 'move_request_approver' so Org Admin can say why the
 * person has the module. ON CONFLICT DO NOTHING leaves an existing grant — and
 * its existing source, usually none — exactly as it was.
 *
 * Skipped entirely if the org does not have Daily Work enabled, which cannot
 * happen for a request raised through the module but is cheap to be sure of.
 *
 * @returns {Promise<number[]>} the users newly granted, for cache invalidation
 */
async function grantApprovers(client, orgId, requestId, handoverIds) {
  const enabled = await moduleAccess.orgEnabledModules(orgId);
  if (!enabled.includes('dailywork')) return [];

  const users = new Set();
  for (const hid of handoverIds) {
    for (const u of await approverUserIds(client, orgId, hid)) users.add(u);
  }
  const granted = [];
  for (const userId of users) {
    const { rows } = await client.query(
      `INSERT INTO user_module_access
         (org_id, user_id, module_key, source, source_move_request_id)
       VALUES ($1, $2, 'dailywork', 'move_request_approver', $3)
       ON CONFLICT (org_id, user_id, module_key) DO NOTHING
       RETURNING user_id`,
      [orgId, userId, requestId]);
    if (rows[0]) granted.push(rows[0].user_id);
  }
  return granted;
}

function invalidateGrants(orgId, userIds) {
  for (const u of userIds || []) moduleAccess.invalidate(orgId, u);
}

/* ───────────────────────── raising a request ───────────────────────── */

/**
 * @param input { itemId, targetHandoverId, entryIds = [], note = null }
 * @returns {Promise<{ request: object, grantedUserIds: number[] }>}
 */
async function createRequest(orgId, actorId, input = {}) {
  const itemId = Number(input.itemId);
  const targetHandoverId = Number(input.targetHandoverId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new DailyWorkError('Which item?', 'MISSING_ITEM');
  }
  if (!Number.isInteger(targetHandoverId) || targetHandoverId <= 0) {
    throw new DailyWorkError('Which project should this move to?', 'MISSING_PROJECT');
  }
  const note = input.note == null ? null : String(input.note).trim() || null;
  if (note && note.length > MAX_NOTE) {
    throw new DailyWorkError(`The note is ${note.length - MAX_NOTE} characters too long.`, 'NOTE_TOO_LONG');
  }

  const out = await withOrgTransaction(orgId, async (client) => {
    const item = await lockItem(client, orgId, itemId);
    if (!item) throw new DailyWorkError('No such work item', 'NO_SUCH_ITEM', { itemId });

    if (!(await canActFor(orgId, actorId, item.owner_user_id))) {
      throw new DailyWorkError(
        'You can only ask to move your own work or the work of people in your team.',
        'NOT_YOUR_ITEM', { itemId });
    }
    await dw.assertActiveMember(client, orgId, item.owner_user_id);

    const target = await loadProject(client, orgId, targetHandoverId);
    if (!target) throw new DailyWorkError('No such project', 'NO_SUCH_PROJECT', { targetHandoverId });
    if (!isProjectOpen(target)) {
      throw new DailyWorkError(
        `${target.name} is closed, so there is no plan to move this work onto.`,
        'PROJECT_CLOSED', { targetHandoverId });
    }

    await assertItemMovable(client, orgId, item, targetHandoverId);

    // uq_dwmr_one_open_per_item refuses this too. Checked first for the sentence.
    const { rows: open } = await client.query(
      `SELECT id FROM daily_work_move_requests WHERE org_id = $1 AND item_id = $2 AND is_open`,
      [orgId, itemId]);
    if (open[0]) {
      throw new DailyWorkError(
        'There is already an open move request for this item.',
        'REQUEST_ALREADY_OPEN', { requestId: open[0].id });
    }

    const entries = await loadSelectableEntries(client, orgId, item, input.entryIds, targetHandoverId);

    const { rows: [req] } = await client.query(
      `INSERT INTO daily_work_move_requests
         (org_id, item_id, owner_user_id, requested_by, target_handover_id, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, itemId, item.owner_user_id, actorId, targetHandoverId, note]);
    const { rows: [batch] } = await client.query(
      `INSERT INTO daily_work_move_batches (org_id, request_id, batch_no, added_by)
       VALUES ($1, $2, 1, $3) RETURNING id`,
      [orgId, req.id, actorId]);

    const sources = await sourceProjectIds(client, orgId, targetHandoverId, item, entries);
    await ensureApprovalRows(client, orgId, req.id, batch.id, targetHandoverId, sources);
    await insertMoveEntries(client, orgId, req.id, batch.id, entries);
    const granted = await grantApprovers(client, orgId, req.id, [targetHandoverId, ...sources]);

    return { requestId: req.id, batchId: batch.id, granted };
  });

  invalidateGrants(orgId, out.granted);
  await moveNotify.dispatch(orgId, actorId, out.requestId, [{ kind: 'requested', batchId: out.batchId }]);
  return { request: await getRequestDetail(orgId, out.requestId), grantedUserIds: out.granted };
}

/**
 * The requester, or the owner if the requester's account is gone.
 *
 * "The requester adds entries" and "the requester withdraws" were both agreed.
 * requested_by is SET NULL when a user is deleted, and without the fallback a
 * request raised by someone who then left could never be withdrawn by anyone.
 */
function isRequester(req, actorId) {
  return req.requested_by != null ? req.requested_by === actorId : req.owner_user_id === actorId;
}

/**
 * Add entries logged after the request was raised.
 *
 * Goes into the latest waiting batch if NOBODY has decided anything on it yet —
 * nobody has approved a set that this would change. Otherwise a new batch, with
 * its own approval rows, so an approval already given is never silently
 * widened. Refused once batch 1 has moved: from then on, an assigned item is
 * closed and a kept recurring item's later work goes through the task.
 */
async function addEntries(orgId, actorId, requestId, entryIds) {
  const out = await withOrgTransaction(orgId, async (client) => {
    const req = await lockRequest(client, orgId, requestId);
    if (!isRequester(req, actorId)) {
      throw new DailyWorkError('Only the person who raised this request can add to it.',
        'NOT_REQUESTER', { requestId });
    }
    if (req.status !== 'pending') {
      throw new DailyWorkError(
        req.status === 'approved'
          ? 'The first part of this move has already happened, so entries can no longer be added to it.'
          : 'This request is closed.',
        'REQUEST_NOT_ADDABLE', { requestId, status: req.status });
    }

    const item = await lockItem(client, orgId, req.item_id);
    await assertItemMovable(client, orgId, item, req.target_handover_id);
    const entries = await loadSelectableEntries(client, orgId, item, entryIds, req.target_handover_id);
    if (!entries.length) throw new DailyWorkError('Choose at least one entry to add.', 'NO_ENTRIES');

    const { rows: [latest] } = await client.query(
      `SELECT b.id, b.batch_no, b.status,
              EXISTS (SELECT 1 FROM daily_work_move_approvals a
                       WHERE a.batch_id = b.id AND a.decision <> 'pending') AS any_decided
         FROM daily_work_move_batches b
        WHERE b.request_id = $1
        ORDER BY b.batch_no DESC LIMIT 1`,
      [requestId]);

    let batchId = latest.id;
    if (latest.status !== 'pending' || latest.any_decided) {
      const { rows: [b] } = await client.query(
        `INSERT INTO daily_work_move_batches (org_id, request_id, batch_no, added_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, requestId, latest.batch_no + 1, actorId]);
      batchId = b.id;
    }

    const sources = await sourceProjectIds(client, orgId, req.target_handover_id, item, entries);
    await ensureApprovalRows(client, orgId, requestId, batchId, req.target_handover_id, sources);
    await insertMoveEntries(client, orgId, requestId, batchId, entries);
    const granted = await grantApprovers(client, orgId, requestId, [req.target_handover_id, ...sources]);
    return { granted, batchId };
  });

  invalidateGrants(orgId, out.granted);
  // Approvers of that batch hear about it whether it is a new batch or the
  // waiting one — either way there is more for them to look at.
  await moveNotify.dispatch(orgId, actorId, requestId, [{ kind: 'requested', batchId: out.batchId }]);
  return { request: await getRequestDetail(orgId, requestId), grantedUserIds: out.granted };
}

/**
 * Withdraw whatever is still waiting.
 *
 * Before batch 1 moves, that is the whole request. After, it is any later batch
 * still waiting; what has moved stays moved.
 */
async function withdraw(orgId, actorId, requestId) {
  const closed = await withOrgTransaction(orgId, async (client) => {
    const req = await lockRequest(client, orgId, requestId);
    if (!isRequester(req, actorId)) {
      throw new DailyWorkError('Only the person who raised this request can withdraw it.',
        'NOT_REQUESTER', { requestId });
    }
    if (!req.is_open) {
      throw new DailyWorkError('There is nothing waiting on this request to withdraw.',
        'REQUEST_NOT_OPEN', { requestId });
    }

    const batchIds = await closePendingBatches(client, requestId, 'withdrawn');

    if (req.status === 'pending') {
      await client.query(
        `UPDATE daily_work_move_requests
            SET status = 'withdrawn', is_open = false, withdrawn_by = $2, withdrawn_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [requestId, actorId]);
    } else {
      await client.query(
        `UPDATE daily_work_move_requests SET is_open = false, updated_at = now() WHERE id = $1`,
        [requestId]);
    }
    return batchIds;
  });
  await moveNotify.dispatch(orgId, actorId, requestId, [{ kind: 'withdrawn', batchIds: closed }]);
  return getRequestDetail(orgId, requestId);
}

/** Close every waiting batch of a request and exclude its waiting entries. */
async function closePendingBatches(client, requestId, status, onlyBatchId = null) {
  const { rows: batches } = await client.query(
    `UPDATE daily_work_move_batches
        SET status = $2, decided_at = now()
      WHERE request_id = $1 AND status = 'pending'
        AND ($3::int IS NULL OR id = $3)
      RETURNING id`,
    [requestId, status, onlyBatchId]);
  if (!batches.length) return [];
  await client.query(
    `UPDATE daily_work_move_entries
        SET outcome = 'excluded'
      WHERE batch_id = ANY($1::int[]) AND outcome = 'pending'`,
    [batches.map(b => b.id)]);
  return batches.map(b => b.id);
}

/* ───────────────────────── deciding ────────────────────────────────── */

/**
 * An approver's decision for one project on one batch.
 *
 * @param input {
 *   handoverId        which project the actor is deciding for (required — an
 *                     approver may manage more than one project in a request)
 *   decision          'approve' | 'reject'
 *   reason            required to reject; optional otherwise
 *   untickEntryIds    daily_work_move_entries ids to leave out
 *   placement         target, batch 1, when approving:
 *                       { existingPlayInstanceId }  (new tasks: next step)
 *   batchId           optional; defaults to the earliest batch whose row for
 *                     this project is still undecided. Pass it to re-choose
 *                     the task on batch 1 while a later batch also waits.
 * }
 */
async function decide(orgId, actorId, requestId, input = {}) {
  const handoverId = Number(input.handoverId);
  if (!Number.isInteger(handoverId) || handoverId <= 0) {
    throw new DailyWorkError('Which project are you deciding for?', 'MISSING_PROJECT');
  }
  if (!['approve', 'reject'].includes(input.decision)) {
    throw new DailyWorkError("The decision is either 'approve' or 'reject'.", 'BAD_DECISION');
  }
  const reason = input.reason == null ? null : String(input.reason).trim() || null;
  if (input.decision === 'reject' && !reason) {
    throw new DailyWorkError('Say why, so the person knows what to do next.', 'REASON_REQUIRED');
  }
  if (reason && reason.length > MAX_NOTE) {
    throw new DailyWorkError(`The reason is ${reason.length - MAX_NOTE} characters too long.`, 'REASON_TOO_LONG');
  }

  // Outside the transaction: a read against other tables, and the answer does
  // not depend on anything this transaction writes.
  if (!(await projectMembers.canManageProject(handoverId, orgId, actorId))) {
    throw new DailyWorkError('Only a manager of that project can decide for it.',
      'NOT_PROJECT_MANAGER', { handoverId });
  }

  // What this decision caused, told to people once it has committed.
  const events = [];

  await withOrgTransaction(orgId, async (client) => {
    const req = await lockRequest(client, orgId, requestId);
    if (!req.is_open) {
      throw new DailyWorkError('This request has nothing waiting for a decision.',
        'REQUEST_NOT_OPEN', { requestId });
    }

    const batchId = input.batchId == null ? null : Number(input.batchId);
    const { rows: [appr] } = await client.query(
      `SELECT a.*, b.batch_no
         FROM daily_work_move_approvals a
         JOIN daily_work_move_batches b ON b.id = a.batch_id
        WHERE a.request_id = $1 AND a.handover_id = $2 AND b.status = 'pending'
          AND ($3::int IS NULL OR a.batch_id = $3)
        -- A row still waiting on this project comes before one it has already
        -- decided. Ordering by batch alone picked batch 1 for an approver who
        -- had approved it and was now deciding batch 2, and refused them with
        -- ALREADY_DECIDED. Re-choosing the task on an approved batch 1 while a
        -- later batch also waits on the same project needs batchId.
        ORDER BY (a.decision <> 'pending'), b.batch_no
        LIMIT 1
        FOR UPDATE OF a`,
      [requestId, handoverId, batchId]);
    if (!appr) {
      throw new DailyWorkError('There is nothing on this request waiting for that project.',
        'NOTHING_TO_DECIDE', { requestId, handoverId });
    }

    const placement = input.placement || null;
    const rechoosingTask = appr.decision === 'approved' && appr.role === 'target'
      && appr.batch_no === 1 && input.decision === 'approve' && placement;
    if (appr.decision !== 'pending' && !rechoosingTask) {
      throw new DailyWorkError('That decision has already been made.', 'ALREADY_DECIDED',
        { approvalId: appr.id, decision: appr.decision });
    }
    if (placement && !(appr.role === 'target' && appr.batch_no === 1)) {
      throw new DailyWorkError(
        'The task is chosen by the manager of the project the work is moving to, on the first batch.',
        'PLACEMENT_NOT_YOURS');
    }

    await untick(client, appr, asIds(input.untickEntryIds), actorId);

    if (input.decision === 'reject') {
      await client.query(
        `UPDATE daily_work_move_approvals
            SET decision = 'rejected', decided_by = $2, decided_at = now(), reason = $3
          WHERE id = $1`,
        [appr.id, actorId, reason]);
      events.push({ kind: 'rejected', batchId: appr.batch_id, handoverId, reason });

      if (appr.batch_no === 1) {
        // A rejection on the first batch ends the request — every waiting
        // batch with it.
        await closePendingBatches(client, requestId, 'rejected');
        await client.query(
          `UPDATE daily_work_move_requests
              SET status = 'rejected', is_open = false, decided_at = now(), updated_at = now()
            WHERE id = $1`,
          [requestId]);
      } else {
        // A later batch: only that batch's entries are dropped.
        await closePendingBatches(client, requestId, 'rejected', appr.batch_id);
        await refreshIsOpen(client, requestId);
      }
      return;
    }

    // ── approve ────────────────────────────────────────────────────
    if (appr.role === 'target' && appr.batch_no === 1) {
      const chosen = await validatePlacement(client, orgId, req, placement);
      if (chosen.placement === 'existing_task') {
        await client.query(
          `UPDATE daily_work_move_approvals
              SET decision = 'approved', decided_by = $2, decided_at = now(), reason = $3,
                  placement = 'existing_task', existing_play_instance_id = $4, new_task = NULL
            WHERE id = $1`,
          [appr.id, actorId, reason, chosen.task.id]);
      } else {
        // What the approver was shown is stored beside what they chose. The
        // plan can change before batch 1 moves, and "who approved what" has to
        // include what they knew when they did.
        const conflicts = await computeConflicts(client, orgId, req, chosen.spec);
        await client.query(
          `UPDATE daily_work_move_approvals
              SET decision = 'approved', decided_by = $2, decided_at = now(), reason = $3,
                  placement = 'new_task', existing_play_instance_id = NULL, new_task = $4::jsonb
            WHERE id = $1`,
          [appr.id, actorId, reason,
           JSON.stringify({ ...chosen.spec, conflictsAtDecision: conflicts })]);
      }
    } else {
      await client.query(
        `UPDATE daily_work_move_approvals
            SET decision = 'approved', decided_by = $2, decided_at = now(), reason = $3
          WHERE id = $1`,
        [appr.id, actorId, reason]);
    }

    await executeReadyBatches(client, orgId, actorId, requestId, events);
  });

  await moveNotify.dispatch(orgId, actorId, requestId, events);
  return getRequestDetail(orgId, requestId);
}

/**
 * Leave entries out of a batch.
 *
 * The target may untick any entry. A source project may untick only entries
 * whose SAVED tag is that project — its authority is over its own work, and an
 * entry tagged elsewhere is not its call. The tag read is the snapshot taken
 * when the entry joined the request.
 */
async function untick(client, appr, moveEntryIds, actorId) {
  if (!moveEntryIds.length) return;
  const { rows } = await client.query(
    `SELECT id, selected, outcome, snap_anchor_kind, snap_anchor_id
       FROM daily_work_move_entries
      WHERE batch_id = $1 AND id = ANY($2::int[])
      FOR UPDATE`,
    [appr.batch_id, moveEntryIds]);
  if (rows.length !== moveEntryIds.length) {
    throw new DailyWorkError('Some of those entries are not part of this batch.',
      'ENTRY_NOT_IN_BATCH', { moveEntryIds });
  }
  for (const r of rows) {
    if (r.outcome !== 'pending') {
      throw new DailyWorkError('That entry has already been dealt with.', 'ENTRY_NOT_PENDING', { moveEntryId: r.id });
    }
    if (appr.role === 'source'
        && !(r.snap_anchor_kind === 'handover' && r.snap_anchor_id === appr.handover_id)) {
      throw new DailyWorkError(
        'You can only leave out entries tagged to your own project.',
        'NOT_YOUR_ENTRY_TO_UNTICK', { moveEntryId: r.id });
    }
  }
  await client.query(
    `UPDATE daily_work_move_entries
        SET selected = false, unticked_at = now(), unticked_by = $2, unticked_for_handover_id = $3
      WHERE id = ANY($1::int[]) AND selected`,
    [moveEntryIds, actorId, appr.handover_id]);
}

/**
 * What a target approver chose, checked.
 *
 * @returns {Promise<{ placement: 'existing_task', task } | { placement: 'new_task', spec }>}
 */
async function validatePlacement(client, orgId, req, placement) {
  if (!placement) {
    throw new DailyWorkError('Choose the task this work should go to.', 'PLACEMENT_REQUIRED');
  }
  if (placement.newTask) {
    return { placement: 'new_task', spec: await validateNewTask(client, orgId, req, placement.newTask) };
  }
  const taskId = Number(placement.existingPlayInstanceId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new DailyWorkError('Choose the task this work should go to.', 'PLACEMENT_REQUIRED');
  }
  const task = await loadTask(client, orgId, taskId);
  assertTaskUsable(task, req);
  return { placement: 'existing_task', task };
}

/**
 * A new task as the approver described it, normalised and checked.
 *
 * STAGE: an existing active stage on the project, or 'custom' — the ad-hoc
 * bucket addPlay uses when no stage is named. Creating a stage from here was
 * left out on purpose: addPlay registers unknown stages through
 * _ensureStageExists, which writes on its own connection, so a stage made for a
 * move that then rolled back would stay on the project with nothing in it.
 *
 * DEPENDENCIES, in both directions:
 *   dependsOn   tasks the new one waits for
 *   dependents  existing tasks that should wait for the new one
 * All must be on the target project. A loop is refused the way
 * setPlayDependencies refuses one: walk upward from the prerequisites, and if a
 * dependent is reachable, adding the new task between them closes a circle.
 */
async function validateNewTask(client, orgId, req, raw = {}) {
  const title = String(raw.title || '').trim();
  if (!title) throw new DailyWorkError('The new task needs a title.', 'BLANK_TASK_TITLE');

  const description = raw.description == null ? null : String(raw.description).trim() || null;

  const stageKey = stageKeyFrom(raw.stageKey) || 'custom';
  let stageName = 'Added on this project';
  if (stageKey !== 'custom') {
    const { rows: [st] } = await client.query(
      `SELECT name FROM project_stages
        WHERE handover_id = $1 AND org_id = $2 AND key = $3 AND is_active = TRUE`,
      [req.target_handover_id, orgId, stageKey]);
    if (!st) {
      throw new DailyWorkError('Choose one of the stages this project already has.',
        'STAGE_NOT_ON_PROJECT', { stageKey });
    }
    stageName = st.name;
  }

  let dueDate = null;
  if (raw.dueDate != null && raw.dueDate !== '') {
    const d = String(raw.dueDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))
        || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) {
      throw new DailyWorkError('The due date must be a real date, YYYY-MM-DD.', 'BAD_DATE', { dueDate: d });
    }
    dueDate = d;
  }

  const isGate = raw.isGate === true;
  const dependsOn = asIds(raw.dependsOn);
  const dependents = asIds(raw.dependents);

  const all = [...new Set([...dependsOn, ...dependents])];
  if (all.length) {
    const { rows } = await client.query(
      `SELECT id FROM project_play_instances
        WHERE org_id = $1 AND handover_id = $2 AND id = ANY($3::int[])`,
      [orgId, req.target_handover_id, all]);
    if (rows.length !== all.length) {
      const found = new Set(rows.map(r => r.id));
      throw new DailyWorkError('Some of those tasks are not on this project.',
        'TASK_NOT_ON_PROJECT', { playInstanceIds: all.filter(id => !found.has(id)) });
    }
  }
  if (dependsOn.some(id => dependents.includes(id))) {
    throw new DailyWorkError('A task cannot both come before and after the new task.', 'DEPENDENCY_CYCLE');
  }
  if (dependsOn.length && dependents.length) {
    const { rows: cyc } = await client.query(
      `WITH RECURSIVE up(id) AS (
         SELECT unnest($1::int[])
         UNION
         SELECT unnest(p.depends_on)
           FROM project_play_instances p
           JOIN up ON up.id = p.id
          WHERE p.depends_on IS NOT NULL
       )
       SELECT id FROM up WHERE id = ANY($2::int[]) LIMIT 1`,
      [dependsOn, dependents]);
    if (cyc.length) {
      throw new DailyWorkError(
        'That would create a circular dependency: one of the tasks waiting for the new task is already '
        + 'something the new task would wait for.',
        'DEPENDENCY_CYCLE', { playInstanceId: cyc[0].id });
    }
  }

  return { title, description, stageKey, stageName, dueDate, isGate, dependsOn, dependents };
}

/**
 * What adding this task would do to the plan — shown before the approver
 * decides, and never enforced. There is no rescheduler; nothing here moves a
 * date.
 *
 * Each item is { kind, severity, message, ...details }:
 *   severity 'conflict'  a date or lock that collides with the plan as it is
 *   severity 'info'      worth knowing, not a collision
 *
 * THE CHECKS, and where each rule comes from:
 *
 *   after_go_live           due date later than the project's go-live.
 *                           Timeboxed only: a standing initiative cannot have a
 *                           go-live (chk_sh_standing_no_go_live).
 *   locks_later_stage       a later stage with gating 'strict', or 'gates' when
 *                           the new task is a gate, cannot start tasks while an
 *                           earlier-stage task is open — the rule in
 *                           handover._stageBlockers. Reported per stage, with how
 *                           many of its tasks have not started; 'info' instead
 *                           of 'conflict' when that stage is already locked.
 *   waits_on_earlier_stage  the new task's own stage is locked by open work in
 *                           earlier stages, so it cannot start yet.
 *   prerequisite_due_later  a task the new one waits for is due after it.
 *   prerequisite_open       ... is still open, so the new task cannot start
 *                           until it closes (2026_117: eligibility, not a block).
 *   dependent_due_earlier   a task that would wait for the new one is due
 *                           before it.
 *   dependent_started       ... is already under way; it keeps going, but it
 *                           now waits on something unfinished.
 *   owner_load              the owner's open tasks due by the new due date, and
 *                           their overdue tasks, across every open project.
 *   no_due_date             the date checks were skipped.
 *   added_scope             the plan is frozen, so this is recorded as added.
 */
async function computeConflicts(client, orgId, req, spec) {
  const out = [];
  const project = await loadProject(client, orgId, req.target_handover_id);
  const { dueDate } = spec;

  if (!dueDate) {
    out.push({ kind: 'no_due_date', severity: 'info',
      message: 'No due date, so the date checks were skipped.' });
  }

  if (dueDate && project.tracking_mode === 'timeboxed' && project.go_live_date
      && dueDate > project.go_live_date) {
    out.push({ kind: 'after_go_live', severity: 'conflict', goLiveDate: project.go_live_date,
      message: `Due ${dueDate}, after the project's go-live on ${project.go_live_date}.` });
  }

  // ── stage gating ──────────────────────────────────────────────────
  const { rows: [stage] } = await client.query(
    `SELECT key, name, sort_order, gating FROM project_stages
      WHERE handover_id = $1 AND org_id = $2 AND key = $3 AND is_active = TRUE`,
    [project.id, orgId, spec.stageKey]);

  if (stage) {
    const { rows: later } = await client.query(
      `SELECT ls.key, ls.name, ls.gating,
              (SELECT count(*)::int FROM project_play_instances t
                WHERE t.handover_id = ls.handover_id AND t.stage_key = ls.key
                  AND t.status NOT IN ('completed', 'skipped', 'cancelled', 'in_progress', 'in_review'))
                AS not_started,
              EXISTS (
                SELECT 1 FROM project_play_instances e
                  JOIN project_stages es
                    ON es.handover_id = e.handover_id AND es.key = e.stage_key AND es.is_active = TRUE
                 WHERE e.handover_id = ls.handover_id
                   AND e.status NOT IN ('completed', 'skipped', 'cancelled')
                   AND es.sort_order < ls.sort_order
                   AND (ls.gating = 'strict' OR (ls.gating = 'gates' AND e.is_gate = TRUE))
              ) AS already_locked
         FROM project_stages ls
        WHERE ls.handover_id = $1 AND ls.org_id = $2 AND ls.is_active = TRUE
          AND ls.sort_order > $3
          AND (ls.gating = 'strict' OR (ls.gating = 'gates' AND $4::boolean))
        ORDER BY ls.sort_order`,
      [project.id, orgId, stage.sort_order, spec.isGate]);
    for (const l of later) {
      out.push({
        kind: 'locks_later_stage', severity: l.already_locked ? 'info' : 'conflict',
        stageKey: l.key, stageName: l.name, notStarted: l.not_started, alreadyLocked: l.already_locked,
        message: l.already_locked
          ? `${l.name} is already waiting on earlier work; this adds one more thing it waits for.`
          : `${l.name} could not start any of its ${l.not_started} unstarted `
            + `${l.not_started === 1 ? 'task' : 'tasks'} until this task is done.`,
      });
    }

    if (stage.gating !== 'none') {
      const { rows: blockers } = await client.query(
        `SELECT DISTINCT es.name
           FROM project_play_instances e
           JOIN project_stages es
             ON es.handover_id = e.handover_id AND es.key = e.stage_key AND es.is_active = TRUE
          WHERE e.handover_id = $1
            AND e.status NOT IN ('completed', 'skipped', 'cancelled')
            AND es.sort_order < $2
            AND ($3 = 'strict' OR ($3 = 'gates' AND e.is_gate = TRUE))`,
        [project.id, stage.sort_order, stage.gating]);
      if (blockers.length) {
        out.push({ kind: 'waits_on_earlier_stage', severity: 'info',
          stages: blockers.map(b => b.name),
          message: `It cannot start until ${blockers.map(b => b.name).join(', ')} clears its gates.` });
      }
    }
  }

  // ── dependencies ──────────────────────────────────────────────────
  const taskRows = async (ids) => ids.length ? (await client.query(
    `SELECT id, title, status, due_date::text AS due_date FROM project_play_instances
      WHERE org_id = $1 AND id = ANY($2::int[]) ORDER BY due_date NULLS LAST, id`,
    [orgId, ids])).rows : [];

  for (const t of await taskRows(spec.dependsOn)) {
    const open = !CLOSED_TASK_STATUSES.includes(t.status);
    if (dueDate && open && t.due_date && t.due_date > dueDate) {
      out.push({ kind: 'prerequisite_due_later', severity: 'conflict', playInstanceId: t.id,
        message: `It waits for "${t.title}", which is due ${t.due_date} — after this task's ${dueDate}.` });
    } else if (open) {
      out.push({ kind: 'prerequisite_open', severity: 'info', playInstanceId: t.id,
        message: `It cannot start until "${t.title}" is done.` });
    }
  }
  for (const t of await taskRows(spec.dependents)) {
    const open = !CLOSED_TASK_STATUSES.includes(t.status);
    if (dueDate && open && t.due_date && t.due_date < dueDate) {
      out.push({ kind: 'dependent_due_earlier', severity: 'conflict', playInstanceId: t.id,
        message: `"${t.title}" would wait for it, but is due ${t.due_date} — before this task's ${dueDate}.` });
    }
    if (['in_progress', 'in_review'].includes(t.status)) {
      out.push({ kind: 'dependent_started', severity: 'info', playInstanceId: t.id,
        message: `"${t.title}" is already under way and would now wait on an unfinished task.` });
    }
  }

  // ── the owner's load ──────────────────────────────────────────────
  // The same OPEN predicates as the People screen: task not closed, project
  // not closed or retired, and the owner assigned through project_play_assignees.
  const today = await localToday(client, orgId, req.owner_user_id);
  const { rows: [load] } = await client.query(
    `SELECT
       count(*) FILTER (WHERE p.due_date < $3::date)::int AS overdue,
       count(*) FILTER (WHERE $4::date IS NOT NULL
                          AND p.due_date >= $3::date AND p.due_date <= $4::date)::int AS due_by
       FROM project_play_instances p
       JOIN sales_handovers h ON h.id = p.handover_id AND h.org_id = p.org_id
      WHERE p.org_id = $1
        AND EXISTS (SELECT 1 FROM project_play_assignees ppa
                     WHERE ppa.instance_id = p.id AND ppa.user_id = $2)
        AND p.status NOT IN ('completed', 'skipped', 'cancelled')
        AND h.status NOT IN ('completed', 'cancelled') AND h.retired_at IS NULL
        AND p.due_date IS NOT NULL`,
    [orgId, req.owner_user_id, today, dueDate]);
  if (load.overdue > 0 || load.due_by > 0) {
    const parts = [];
    if (dueDate) parts.push(`${load.due_by} open ${load.due_by === 1 ? 'task' : 'tasks'} due by ${dueDate}`);
    if (load.overdue > 0) parts.push(`${load.overdue} overdue`);
    out.push({ kind: 'owner_load', severity: 'info', dueBy: load.due_by, overdue: load.overdue,
      message: `The person this is for already has ${parts.join(' and ')}.` });
  }

  if (project.baseline_frozen_at) {
    out.push({ kind: 'added_scope', severity: 'info',
      message: 'The plan is already frozen, so this is recorded as added scope in plan vs actual.' });
  }

  return out;
}

/**
 * The conflicts for a proposed new task, for the target approver to look at
 * before deciding. Read-only.
 */
async function getConflicts(orgId, viewerId, requestId, newTask) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows: [req] } = await client.query(
      `SELECT * FROM daily_work_move_requests WHERE id = $1 AND org_id = $2`, [requestId, orgId]);
    if (!req) throw new DailyWorkError('No such move request', 'NO_SUCH_REQUEST', { requestId });
    if (!(await projectMembers.canManageProject(req.target_handover_id, orgId, viewerId))) {
      throw new DailyWorkError('Only a manager of the project this work is moving to can plan the task.',
        'NOT_PROJECT_MANAGER', { handoverId: req.target_handover_id });
    }
    if (req.status !== 'pending') {
      throw new DailyWorkError('The task for this request has already been decided.', 'REQUEST_NOT_OPEN', { requestId });
    }
    const spec = await validateNewTask(client, orgId, req, newTask);
    const project = await loadProject(client, orgId, req.target_handover_id);
    return {
      spec,
      addedScope: !!project.baseline_frozen_at,
      conflicts: await computeConflicts(client, orgId, req, spec),
    };
  });
}

/**
 * Create the task a target approver described, as batch 1 moves.
 *
 * The same row addPlay writes for an ad-hoc item — no playbook, no template,
 * channel 'internal_task', anchored to creation, at the end of its stage on the
 * 10-step scale — so the checklist treats it exactly like one.
 *
 * BASELINE, also as addPlay: on a frozen plan a task with a due date is born
 * with that date as its committed baseline, because nothing runs later to give
 * it one; on a draft plan it has none, and freezing the plan gives it one.
 *
 * ADDED SCOPE: scope_added_at is set only on a frozen plan. On a draft plan
 * the task is part of the plan, not an addition to it.
 *
 * Re-validated here, not trusted from the approval row: stages and tasks can
 * change between the approval and the moment batch 1 moves.
 */
async function createTaskForMove(client, orgId, req, project, rawSpec) {
  const spec = await validateNewTask(client, orgId, req, rawSpec);
  const frozen = !!project.baseline_frozen_at;

  const { rows: [{ next_order: nextOrder }] } = await client.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order
       FROM project_play_instances
      WHERE handover_id = $1 AND org_id = $2 AND stage_key = $3`,
    [project.id, orgId, spec.stageKey]);

  const baselineDue = frozen && spec.dueDate ? spec.dueDate : null;

  const { rows: [task] } = await client.query(
    `INSERT INTO project_play_instances
       (handover_id, org_id, playbook_id, play_id, stage_key, title, description,
        channel, priority, execution_type, is_gate, due_date, due_anchor,
        sort_order, status, owner_user_id, baseline_due_date, baseline_source,
        depends_on, added_by_move_request_id, scope_added_at)
     VALUES ($1, $2, NULL, NULL, $3, $4, $5,
             'internal_task', 'medium', 'parallel', $6, $7::date, 'created',
             $8, 'not_started', $9, $10::date, $11::text,
             $12::int[], $13, CASE WHEN $14 THEN now() END)
     RETURNING id, title, status, handover_id`,
    [project.id, orgId, spec.stageKey, spec.title, spec.description,
     spec.isGate, spec.dueDate, nextOrder, req.owner_user_id,
     baselineDue, baselineDue ? 'original' : null,
     spec.dependsOn.length ? spec.dependsOn : null, req.id, frozen]);

  if (spec.dependents.length) {
    await client.query(
      `UPDATE project_play_instances
          SET depends_on = array_append(COALESCE(depends_on, '{}'::int[]), $1), updated_at = now()
        WHERE org_id = $2 AND handover_id = $3 AND id = ANY($4::int[])
          AND NOT ($1 = ANY(COALESCE(depends_on, '{}'::int[])))`,
      [task.id, orgId, project.id, spec.dependents]);
  }
  return task;
}

async function loadTask(client, orgId, taskId) {
  const { rows } = await client.query(
    `SELECT id, title, status, handover_id FROM project_play_instances
      WHERE id = $1 AND org_id = $2`,
    [taskId, orgId]);
  return rows[0] || null;
}

function assertTaskUsable(task, req) {
  if (!task || task.handover_id !== req.target_handover_id) {
    throw new DailyWorkError('That task is not on the project this work is moving to.',
      'TASK_NOT_ON_PROJECT', { playInstanceId: task ? task.id : null });
  }
  if (CLOSED_TASK_STATUSES.includes(task.status)) {
    throw new DailyWorkError(
      'That task is closed. The manager of the project this work is moving to needs to choose another task.',
      'TASK_CLOSED', { playInstanceId: task.id, status: task.status });
  }
}

async function refreshIsOpen(client, requestId) {
  // Only 'approved' is left to this; chk_dwmr_open_shape pins the rest.
  await client.query(
    `UPDATE daily_work_move_requests r
        SET is_open = EXISTS (SELECT 1 FROM daily_work_move_batches b
                               WHERE b.request_id = r.id AND b.status = 'pending'),
            updated_at = now()
      WHERE r.id = $1 AND r.status = 'approved'`,
    [requestId]);
}

/**
 * Move every batch that is fully approved and allowed to move.
 *
 * Batch 1 first, always. A later batch can be fully approved before batch 1 is
 * — batch 1 may still be waiting on a source project — and it cannot move
 * before there is a task, so it waits and moves the moment batch 1 does.
 */
async function executeReadyBatches(client, orgId, actorId, requestId, events = []) {
  const { rows: batches } = await client.query(
    `SELECT b.id, b.batch_no,
            NOT EXISTS (SELECT 1 FROM daily_work_move_approvals a
                         WHERE a.batch_id = b.id AND a.decision <> 'approved') AS all_approved
       FROM daily_work_move_batches b
      WHERE b.request_id = $1 AND b.status = 'pending'
      ORDER BY b.batch_no`,
    [requestId]);

  for (const b of batches) {
    if (!b.all_approved) {
      if (b.batch_no === 1) break;
      continue;
    }
    const { rows: [req] } = await client.query(
      `SELECT * FROM daily_work_move_requests WHERE id = $1`, [requestId]);
    if (b.batch_no !== 1 && req.status !== 'approved') break;
    await executeBatch(client, orgId, actorId, req, b);
    events.push({ kind: 'moved', batchId: b.id });
  }
  await refreshIsOpen(client, requestId);
}

/* ───────────────────────── the move itself ─────────────────────────── */

async function executeBatch(client, orgId, actorId, req, batch) {
  const target = await loadProject(client, orgId, req.target_handover_id);
  if (!isProjectOpen(target)) {
    throw new DailyWorkError(
      `${target ? target.name : 'That project'} has closed, so this work cannot be moved onto it.`,
      'PROJECT_CLOSED', { handoverId: req.target_handover_id });
  }

  const item = await lockItem(client, orgId, req.item_id);
  let task;
  let placement = req.placement;
  if (batch.batch_no === 1) {
    const { rows: [targetAppr] } = await client.query(
      `SELECT placement, existing_play_instance_id, new_task FROM daily_work_move_approvals
        WHERE batch_id = $1 AND role = 'target'`,
      [batch.id]);
    if (!targetAppr || !targetAppr.placement) {
      throw new DailyWorkError('The task has not been chosen yet.', 'PLACEMENT_REQUIRED');
    }
    // Re-checked here, not just when the request was raised: the owner may
    // have closed the item, or logged against a task, in the meantime.
    await assertItemMovable(client, orgId, item, req.target_handover_id);
    placement = targetAppr.placement;

    if (placement === 'existing_task') {
      if (!targetAppr.existing_play_instance_id) {
        throw new DailyWorkError(
          'The task that was chosen has since been deleted. The project manager needs to choose another.',
          'TASK_GONE');
      }
      task = await loadTask(client, orgId, targetAppr.existing_play_instance_id);
    } else {
      // Only now, when the move is certain. conflictsAtDecision is the record
      // of what the approver saw and is not part of the task.
      const spec = { ...(targetAppr.new_task || {}) };
      delete spec.conflictsAtDecision;
      task = await createTaskForMove(client, orgId, req, target, spec);
    }
  } else {
    task = await loadTask(client, orgId, req.play_instance_id);
  }

  assertTaskUsable(task, req);
  await dw.assertActiveMember(client, orgId, req.owner_user_id);

  await ensureProjectMember(client, orgId, target.id, req.owner_user_id, actorId);
  await ensureAssignee(client, task.id, req.owner_user_id, actorId);

  const { rows: moveRows } = await client.query(
    `SELECT * FROM daily_work_move_entries
      WHERE batch_id = $1 AND outcome = 'pending'
      ORDER BY snap_entry_date, id
      FOR UPDATE`,
    [batch.id]);
  const selected = moveRows.filter(r => r.selected);

  const excludedIds = moveRows.filter(r => !r.selected).map(r => r.id);
  if (excludedIds.length) {
    await client.query(
      `UPDATE daily_work_move_entries SET outcome = 'excluded' WHERE id = ANY($1::int[])`,
      [excludedIds]);
  }

  const openedOn = selected.length
    ? selected.map(r => dateText(r.snap_entry_date)).sort()[0]
    : await localToday(client, orgId, req.owner_user_id);
  const { item: linked } = await dw.findOrCreateLinkedItem(
    client, orgId, req.owner_user_id, { id: task.id, title: task.title, handover_id: target.id },
    openedOn, actorId);
  const accountId = await dw.resolveAccountId(client, orgId, 'handover', target.id);

  for (const row of selected) {
    await moveOne(client, { orgId, actorId, row, req, item, linked, target, accountId });
  }

  if (batch.batch_no === 1) {
    if (item.kind === 'assigned') {
      await client.query(
        `UPDATE daily_work_items SET status = 'moved', closed_at = now(), updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [item.id, orgId]);
    }
  }

  await client.query(
    `UPDATE daily_work_move_batches
        SET status = 'approved', decided_at = now(), executed_at = now()
      WHERE id = $1`,
    [batch.id]);

  if (batch.batch_no === 1) {
    await client.query(
      `UPDATE daily_work_move_requests
          SET status = 'approved', placement = $4, play_instance_id = $2,
              decided_at = now(), executed_at = now(),
              recurring_decision = CASE WHEN $3 THEN 'pending' ELSE recurring_decision END,
              updated_at = now()
        WHERE id = $1`,
      [req.id, task.id, item.kind === 'recurring', placement]);
  }
}

/** node-postgres may return a DATE as a Date; everything here compares text. */
function dateText(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  // A Date built at LOCAL midnight by the driver — read back in local parts,
  // which is the date that was stored.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Put the owner on the project.
 *
 * Logging against a task needs an approved membership (getNoteVisibility), and
 * setAssignees refuses to add a non-member to a task. Approving a move is the
 * project manager staffing their project, which is exactly the case
 * requestMember approves automatically (byManager), so the row is approved
 * here directly. Side 'delivery': an internal-customer seat is the acceptor,
 * and requestMember never self-approves those.
 *
 * An existing DELIVERY row that is pending or rejected is approved. A row the
 * person left or declined is re-approved and its exit cleared — the move
 * request is the record of why they are back.
 *
 * An unapproved INTERNAL-CUSTOMER row is not touched. That seat is the one who
 * accepts the work as done, requestMember sends it to an org admin even when a
 * project manager adds it, and approving a move must not be a way around that.
 * The move is refused with the reason instead.
 */
async function ensureProjectMember(client, orgId, handoverId, userId, actorId) {
  await client.query(
    `INSERT INTO project_members
       (org_id, context_type, context_id, user_id, status, requested_by, reviewed_by,
        reviewed_at, review_reason, side)
     VALUES ($1, 'handover', $2, $3, 'approved', $4, $4, now(),
             'Added when daily work was moved onto this project', 'delivery')
     ON CONFLICT (context_type, context_id, user_id) DO UPDATE
        SET status        = 'approved',
            reviewed_by   = EXCLUDED.reviewed_by,
            reviewed_at   = now(),
            review_reason = EXCLUDED.review_reason,
            exited_at     = NULL,
            exit_reason   = NULL
      WHERE project_members.status <> 'approved'
        AND project_members.side = 'delivery'`,
    [orgId, handoverId, userId, actorId]);

  const { rows } = await client.query(
    `SELECT 1 FROM project_members
      WHERE org_id = $1 AND context_type = 'handover' AND context_id = $2 AND user_id = $3
        AND status = 'approved'`,
    [orgId, handoverId, userId]);
  if (!rows[0]) {
    throw new DailyWorkError(
      'This person has a request to join the project as its internal customer, which only an org admin '
      + 'can approve. Once that is settled, this work can be moved.',
      'MEMBERSHIP_NEEDS_ADMIN', { handoverId, userId });
  }
}

/** Put the owner on the task. assignedToSql is how every read finds a person's tasks. */
async function ensureAssignee(client, taskId, userId, actorId) {
  await client.query(
    `INSERT INTO project_play_assignees (instance_id, user_id, assigned_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (instance_id, user_id) DO NOTHING`,
    [taskId, userId, actorId]);
}

async function moveOne(client, { orgId, actorId, row, req, item, linked, target, accountId }) {
  const { rows: [entry] } = await client.query(
    `SELECT ${ENTRY_COLUMNS} FROM daily_work_entries
      WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [row.entry_id, orgId]);

  if (!entry || entry.item_id !== req.item_id) {
    await client.query(
      `UPDATE daily_work_move_entries
          SET outcome = 'excluded', left_out_reason = 'The entry was no longer on the item when the move ran.'
        WHERE id = $1`,
      [row.id]);
    return;
  }

  const { rows: [onTask] } = await client.query(
    `SELECT ${ENTRY_COLUMNS} FROM daily_work_entries
      WHERE org_id = $1 AND item_id = $2 AND entry_date = $3::date FOR UPDATE`,
    [orgId, linked.id, entry.entry_date]);

  if (!onTask) {
    // Re-point and re-tag. updated_at is deliberately not touched: the task
    // feed marks an entry "edited" when updated_at > created_at, and moving
    // someone's words is not editing them.
    await client.query(
      `UPDATE daily_work_entries
          SET item_id = $3, anchor_kind = 'handover', anchor_id = $4, account_id = $5
        WHERE id = $1 AND org_id = $2`,
      [entry.id, orgId, linked.id, target.id, accountId]);
    await client.query(
      `UPDATE daily_work_move_entries SET outcome = 'moved', moved_at = now() WHERE id = $1`,
      [row.id]);
    return;
  }

  await mergePair(client, orgId, actorId, row, entry, onTask, item.title);
}

/**
 * Merge a source entry into the task's entry for the same date, or leave it
 * out if the result would be too long.
 *
 * THE TEXT. The source is appended under a line naming where it came from, so
 * the person editing it later can see the seam. The separator counts toward the
 * limit. The task entry's stage is kept — it is what the project already shows.
 *
 * NEVER TRUNCATED. The design's rule since 2026_131: nothing is cut for anyone.
 * Too long means the entry stays where it is with the reason, and merges the
 * moment either side is short enough (tryPendingMerges).
 *
 * EVIDENCE AND NOTES are copied as NEW rows, not re-pointed.
 * play_evidence_immutable and play_notes_append_only refuse any UPDATE that
 * changes daily_work_entry_id. They are BEFORE UPDATE triggers only, so an
 * INSERT may carry the original accepted_by / accepted_at, author_id /
 * created_at and revocation or deletion state — the copy says exactly what the
 * original said. The originals then go with the source entry (ON DELETE
 * CASCADE), and copied_evidence / copied_notes map each copy to its original.
 */
async function mergePair(client, orgId, actorId, row, source, onTask, sourceTitle) {
  const sep = `\n\n— moved from "${sourceTitle}" —\n`;
  const description = `${onTask.description}${sep}${source.description}`;
  const nextSteps = onTask.next_steps && source.next_steps
    ? `${onTask.next_steps}${sep}${source.next_steps}`
    : (onTask.next_steps || source.next_steps || null);

  const overDesc = description.length - MAX_DESCRIPTION;
  const overNext = nextSteps ? nextSteps.length - MAX_NEXT_STEPS : 0;
  if (overDesc > 0 || overNext > 0) {
    const parts = [];
    if (overDesc > 0) parts.push(`the work would be ${description.length} characters`);
    if (overNext > 0) parts.push(`the next steps would be ${nextSteps.length} characters`);
    await client.query(
      `UPDATE daily_work_move_entries
          SET outcome = 'left_out_too_long', target_entry_id = $2, left_out_reason = $3
        WHERE id = $1`,
      [row.id, onTask.id,
       `There is already work logged on the task for this day, and together ${parts.join(' and ')} `
       + `— the limit is ${MAX_DESCRIPTION}. Shorten either one and it moves automatically.`]);
    return 'left_out_too_long';
  }

  await client.query(
    `UPDATE daily_work_entries
        SET description = $3, next_steps = $4, updated_at = now(), last_edited_by = $5
      WHERE id = $1 AND org_id = $2`,
    [onTask.id, orgId, description, nextSteps, actorId]);

  const copiedEvidence = [];
  const { rows: evidence } = await client.query(
    `SELECT * FROM play_evidence WHERE daily_work_entry_id = $1 ORDER BY id`, [source.id]);
  for (const ev of evidence) {
    const { rows: [c] } = await client.query(
      `INSERT INTO play_evidence
         (org_id, project_play_instance_id, daily_work_entry_id, channel, whatsapp_message_id,
          snapshot_body, snapshot_sender, snapshot_sent_at, snapshot_thread_id, note,
          accepted_by, accepted_at, revoked_at, revoked_by, revoke_reason, storage_file_id,
          snapshot_file_name, snapshot_mime_type, snapshot_file_size, snapshot_web_url,
          msteams_message_id)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20)
       RETURNING id`,
      [ev.org_id, onTask.id, ev.channel, ev.whatsapp_message_id,
       ev.snapshot_body, ev.snapshot_sender, ev.snapshot_sent_at, ev.snapshot_thread_id, ev.note,
       ev.accepted_by, ev.accepted_at, ev.revoked_at, ev.revoked_by, ev.revoke_reason,
       ev.storage_file_id, ev.snapshot_file_name, ev.snapshot_mime_type, ev.snapshot_file_size,
       ev.snapshot_web_url, ev.msteams_message_id]);
    copiedEvidence.push({ from: ev.id, to: c.id });
  }

  const copiedNotes = [];
  const { rows: notes } = await client.query(
    `SELECT * FROM play_notes WHERE daily_work_entry_id = $1 ORDER BY id`, [source.id]);
  for (const n of notes) {
    const { rows: [c] } = await client.query(
      `INSERT INTO play_notes
         (org_id, project_play_instance_id, daily_work_entry_id, author_id, body, note_type,
          is_internal, created_at, deleted_at, deleted_by)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [n.org_id, onTask.id, n.author_id, n.body, n.note_type, n.is_internal,
       n.created_at, n.deleted_at, n.deleted_by]);
    await client.query(
      `INSERT INTO play_note_attachments
         (org_id, play_note_id, storage_file_id, file_name, mime_type, file_size, web_url,
          uploaded_by, created_at)
       SELECT org_id, $2, storage_file_id, file_name, mime_type, file_size, web_url,
              uploaded_by, created_at
         FROM play_note_attachments WHERE play_note_id = $1`,
      [n.id, c.id]);
    copiedNotes.push({ from: n.id, to: c.id });
  }

  await client.query(
    `UPDATE daily_work_move_entries
        SET outcome = 'merged', moved_at = now(), needs_edit = true, target_entry_id = $2,
            left_out_reason = NULL,
            copied_evidence = $3::jsonb, copied_notes = $4::jsonb
      WHERE id = $1`,
    [row.id, onTask.id, JSON.stringify(copiedEvidence), JSON.stringify(copiedNotes)]);

  await client.query(`DELETE FROM daily_work_entries WHERE id = $1 AND org_id = $2`, [source.id, orgId]);
  return 'merged';
}

/**
 * Merge anything left out for length that fits now.
 *
 * Called with the id of an entry that was just saved, inside the transaction
 * that saved it: dailyWork._saveDayIn (My day and the task composer both reach
 * it) and editFlaggedEntry below. Looks for left-out rows where that entry is
 * either side of the pair.
 *
 * Attributed to the entry's owner. They made the edit that let it fit.
 */
async function tryPendingMerges(client, orgId, entryId) {
  const { rows } = await client.query(
    `SELECT * FROM daily_work_move_entries
      WHERE org_id = $1 AND outcome = 'left_out_too_long'
        AND (entry_id = $2 OR target_entry_id = $2)
      FOR UPDATE`,
    [orgId, entryId]);

  for (const row of rows) {
    const { rows: [source] } = await client.query(
      `SELECT ${ENTRY_COLUMNS} FROM daily_work_entries WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [row.entry_id, orgId]);
    const { rows: [onTask] } = await client.query(
      `SELECT ${ENTRY_COLUMNS} FROM daily_work_entries WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [row.target_entry_id, orgId]);
    if (!source || !onTask || source.entry_date !== onTask.entry_date) continue;

    const { rows: [item] } = await client.query(
      `SELECT title FROM daily_work_items WHERE id = $1`, [row.snap_item_id]);
    await mergePair(client, orgId, source.user_id, row, source, onTask, item ? item.title : 'another item');
  }
}

/* ───────────────────────── the owner's follow-ups ──────────────────── */

async function lockMoveEntryForOwner(client, orgId, userId, moveEntryId) {
  const { rows: [row] } = await client.query(
    `SELECT m.*, r.owner_user_id
       FROM daily_work_move_entries m
       JOIN daily_work_move_requests r ON r.id = m.request_id
      WHERE m.id = $1 AND m.org_id = $2
      FOR UPDATE OF m`,
    [moveEntryId, orgId]);
  if (!row) throw new DailyWorkError('No such entry on a move request', 'NO_SUCH_MOVE_ENTRY', { moveEntryId });
  if (row.owner_user_id !== userId) {
    throw new DailyWorkError('Only the person whose work this is can change it.',
      'NOT_YOUR_ENTRY', { moveEntryId });
  }
  return row;
}

/**
 * Edit an entry flagged by a move — the one place an entry may be edited
 * outside the backfill window.
 *
 * @param which  'task'     the task's entry: a merge that needs editing, or
 *                          the other side of a left-out pair
 *               'original' the left-out entry itself, still on its old item
 *
 * Bypasses dailyWork._saveDayIn on purpose, for two reasons: that path applies
 * the backfill window, and it refuses a moved item — which is exactly where a
 * left-out entry on an assigned item lives. The same blank and length rules
 * apply here.
 */
async function editFlaggedEntry(orgId, userId, moveEntryId, input = {}) {
  const which = input.which || 'task';
  const description = String(input.description || '');
  // Absent means "leave next steps as they are". The editor on My day edits the
  // description only; treating a missing field as "clear it" would silently
  // erase the next steps of every entry someone tidied up.
  const changeNextSteps = input.nextSteps !== undefined;
  const nextSteps = input.nextSteps == null ? null : String(input.nextSteps);

  if (!description.trim()) {
    throw new DailyWorkError('Say what you did — this cannot be left empty.', 'BLANK_DESCRIPTION');
  }
  if (description.length > MAX_DESCRIPTION) {
    throw new DailyWorkError(
      `${description.length - MAX_DESCRIPTION} characters too long — trim it, nothing is cut for you`,
      'DESCRIPTION_TOO_LONG', { length: description.length, limit: MAX_DESCRIPTION });
  }
  if (nextSteps && nextSteps.length > MAX_NEXT_STEPS) {
    throw new DailyWorkError(
      `Next steps is ${nextSteps.length - MAX_NEXT_STEPS} characters too long`, 'NEXT_STEPS_TOO_LONG');
  }

  await withOrgTransaction(orgId, async (client) => {
    const row = await lockMoveEntryForOwner(client, orgId, userId, moveEntryId);

    let entryId;
    if (row.needs_edit) {
      if (which !== 'task') {
        throw new DailyWorkError('This merge is edited on the task\'s entry.', 'BAD_WHICH');
      }
      entryId = row.target_entry_id;
    } else if (row.outcome === 'left_out_too_long') {
      if (!['task', 'original'].includes(which)) {
        throw new DailyWorkError("Choose 'task' or 'original'.", 'BAD_WHICH');
      }
      entryId = which === 'task' ? row.target_entry_id : row.entry_id;
    } else {
      throw new DailyWorkError('That entry has nothing waiting to be edited.', 'NOT_FLAGGED', { moveEntryId });
    }
    if (!entryId) {
      throw new DailyWorkError('That entry no longer exists.', 'NO_SUCH_ENTRY', { moveEntryId });
    }

    const { rowCount } = await client.query(
      `UPDATE daily_work_entries
          SET description = $3,
              next_steps = CASE WHEN $6 THEN $4 ELSE next_steps END,
              updated_at = now(), last_edited_by = $5
        WHERE id = $1 AND org_id = $2 AND user_id = $5`,
      [entryId, orgId, description.trim(),
       nextSteps && nextSteps.trim() ? nextSteps.trim() : null, userId, changeNextSteps]);
    if (!rowCount) {
      throw new DailyWorkError('That entry no longer exists.', 'NO_SUCH_ENTRY', { moveEntryId });
    }

    await tryPendingMerges(client, orgId, entryId);
  });

  return getMoveEntry(orgId, moveEntryId);
}

/** The explicit Done that clears "needs edit". */
async function markEntryDone(orgId, userId, moveEntryId) {
  await withOrgTransaction(orgId, async (client) => {
    const row = await lockMoveEntryForOwner(client, orgId, userId, moveEntryId);
    if (!row.needs_edit) {
      throw new DailyWorkError('That entry has nothing waiting to be edited.', 'NOT_FLAGGED', { moveEntryId });
    }
    await client.query(
      `UPDATE daily_work_move_entries
          SET needs_edit = false, needs_edit_cleared_at = now(), needs_edit_cleared_by = $2
        WHERE id = $1`,
      [moveEntryId, userId]);
  });
  return getMoveEntry(orgId, moveEntryId);
}

/**
 * The owner's answer, on My day, for a recurring item whose work moved.
 * @param decision 'retire' | 'keep'
 */
async function setRecurringDecision(orgId, userId, requestId, decision) {
  if (!['retire', 'keep'].includes(decision)) {
    throw new DailyWorkError("Choose 'retire' or 'keep'.", 'BAD_DECISION');
  }
  await withOrgTransaction(orgId, async (client) => {
    const req = await lockRequest(client, orgId, requestId);
    if (req.owner_user_id !== userId) {
      throw new DailyWorkError('Only the person whose item this is can decide.', 'NOT_YOUR_ITEM', { requestId });
    }
    if (req.recurring_decision !== 'pending') {
      throw new DailyWorkError('There is no decision waiting on this item.', 'NOTHING_TO_DECIDE', { requestId });
    }
    if (decision === 'retire') {
      await client.query(
        `UPDATE daily_work_items
            SET status = 'retired', closed_at = now(), updated_at = now()
          WHERE id = $1 AND org_id = $2 AND kind = 'recurring' AND status = 'active'`,
        [req.item_id, orgId]);
    }
    await client.query(
      `UPDATE daily_work_move_requests
          SET recurring_decision = $2, recurring_decided_by = $3, recurring_decided_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [requestId, decision === 'retire' ? 'retired' : 'kept', userId]);
  });
  return getRequestDetail(orgId, requestId);
}

/* ───────────────────────── reads ───────────────────────────────────── */

/**
 * A request with everything a screen needs: the item, the target, every batch,
 * every approval with who decided, and every entry with its outcome.
 *
 * No permission check — callers are this file, after a write the actor was
 * allowed to make, and getRequest, which checks first.
 */
async function getRequestDetail(orgId, requestId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows: [r] } = await client.query(
      `SELECT r.id, r.item_id, r.owner_user_id, r.requested_by, r.target_handover_id, r.note,
              r.status, r.is_open, r.placement, r.play_instance_id, r.recurring_decision,
              r.decided_at, r.executed_at, r.withdrawn_at, r.created_at,
              i.title AS item_title, i.kind AS item_kind, i.status AS item_status,
              COALESCE(NULLIF(btrim(h.name), ''), 'Untitled project') AS target_name,
              COALESCE(h.tracking_mode, 'timeboxed') AS target_tracking_mode,
              p.title AS task_title,
              ou.first_name || ' ' || ou.last_name AS owner_name,
              ru.first_name || ' ' || ru.last_name AS requested_by_name
         FROM daily_work_move_requests r
         JOIN daily_work_items i ON i.id = r.item_id
         JOIN sales_handovers h  ON h.id = r.target_handover_id
         LEFT JOIN project_play_instances p ON p.id = r.play_instance_id
         LEFT JOIN users ou ON ou.id = r.owner_user_id
         LEFT JOIN users ru ON ru.id = r.requested_by
        WHERE r.id = $1 AND r.org_id = $2`,
      [requestId, orgId]);
    if (!r) throw new DailyWorkError('No such move request', 'NO_SUCH_REQUEST', { requestId });

    const { rows: batches } = await client.query(
      `SELECT id, batch_no, status, created_at, decided_at, executed_at
         FROM daily_work_move_batches WHERE request_id = $1 ORDER BY batch_no`,
      [requestId]);

    const { rows: approvals } = await client.query(
      `SELECT a.id, a.batch_id, a.handover_id, a.role, a.decision, a.decided_at, a.reason,
              a.placement, a.existing_play_instance_id, a.new_task,
              COALESCE(NULLIF(btrim(h.name), ''), 'Untitled project') AS project_name,
              du.first_name || ' ' || du.last_name AS decided_by_name,
              p.title AS existing_task_title
         FROM daily_work_move_approvals a
         JOIN sales_handovers h ON h.id = a.handover_id
         LEFT JOIN users du ON du.id = a.decided_by
         LEFT JOIN project_play_instances p ON p.id = a.existing_play_instance_id
        WHERE a.request_id = $1
        ORDER BY a.batch_id, (a.role = 'target') DESC, a.id`,
      [requestId]);

    const { rows: entries } = await client.query(
      `SELECT m.id, m.batch_id, m.entry_id, m.selected, m.unticked_at, m.unticked_for_handover_id,
              m.outcome, m.target_entry_id, m.left_out_reason, m.moved_at,
              m.needs_edit, m.needs_edit_cleared_at,
              m.snap_entry_date::text AS entry_date, m.snap_description, m.snap_next_steps,
              m.snap_day_stage, m.snap_anchor_kind, m.snap_anchor_id,
              CASE m.snap_anchor_kind WHEN 'handover' THEN sh.name END AS snap_anchor_label,
              e.description AS current_description,
              te.description AS task_entry_description
         FROM daily_work_move_entries m
         LEFT JOIN sales_handovers sh
                ON m.snap_anchor_kind = 'handover' AND sh.id = m.snap_anchor_id
         LEFT JOIN daily_work_entries e  ON e.id = m.entry_id
         LEFT JOIN daily_work_entries te ON te.id = m.target_entry_id
        WHERE m.request_id = $1
        ORDER BY m.snap_entry_date, m.id`,
      [requestId]);

    return { ...r, batches, approvals, entries };
  });
}

/**
 * A request, for someone allowed to see it: the owner, the requester, anyone
 * whose chain contains the owner, or a manager of any project involved. The
 * last group sees everything — the work is moving onto or out of their plan.
 *
 * Anyone else gets NO_SUCH_REQUEST rather than a refusal, so the answer does
 * not confirm the request exists.
 */
async function getRequest(orgId, viewerId, requestId) {
  const detail = await getRequestDetail(orgId, requestId);
  if (detail.owner_user_id === viewerId || detail.requested_by === viewerId) return detail;
  if (await canActFor(orgId, viewerId, detail.owner_user_id)) return detail;
  const projects = [...new Set(detail.approvals.map(a => a.handover_id))];
  for (const hid of projects) {
    if (await projectMembers.canManageProject(hid, orgId, viewerId)) return detail;
  }
  throw new DailyWorkError('No such move request', 'NO_SUCH_REQUEST', { requestId });
}

async function getMoveEntry(orgId, moveEntryId) {
  const { rows: [m] } = await pool.query(
    `SELECT m.id, m.request_id, m.outcome, m.needs_edit, m.needs_edit_cleared_at,
            m.left_out_reason, m.entry_id, m.target_entry_id,
            m.snap_entry_date::text AS entry_date,
            e.description AS original_description, e.next_steps AS original_next_steps,
            te.description AS task_description, te.next_steps AS task_next_steps
       FROM daily_work_move_entries m
       LEFT JOIN daily_work_entries e  ON e.id = m.entry_id
       LEFT JOIN daily_work_entries te ON te.id = m.target_entry_id
      WHERE m.id = $1 AND m.org_id = $2`,
    [moveEntryId, orgId]);
  return m || null;
}

/**
 * Everything waiting on the viewer as an approver: pending approval rows, on
 * waiting batches of open requests, for projects the viewer manages. Org
 * admins see every project, the same way myReviewQueue treats them.
 */
async function listReviewQueue(orgId, viewerId) {
  const { rows: [me] } = await pool.query(
    `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`,
    [orgId, viewerId]);
  if (!me) return [];
  const isOrgAdmin = ['admin', 'owner'].includes(me.role);

  const { rows } = await pool.query(
    `SELECT a.id AS approval_id, a.request_id, a.batch_id, b.batch_no, a.handover_id, a.role,
            COALESCE(NULLIF(btrim(h.name), ''), 'Untitled project') AS project_name,
            r.item_id, i.title AS item_title, i.kind AS item_kind,
            r.owner_user_id, ou.first_name || ' ' || ou.last_name AS owner_name,
            ru.first_name || ' ' || ru.last_name AS requested_by_name,
            COALESCE(NULLIF(btrim(t.name), ''), 'Untitled project') AS target_name,
            b.created_at AS waiting_since,
            (SELECT count(*)::int FROM daily_work_move_entries m
              WHERE m.batch_id = b.id AND m.selected) AS entry_count
       FROM daily_work_move_approvals a
       JOIN daily_work_move_batches b  ON b.id = a.batch_id AND b.status = 'pending'
       JOIN daily_work_move_requests r ON r.id = a.request_id AND r.is_open
       JOIN sales_handovers h ON h.id = a.handover_id
       JOIN sales_handovers t ON t.id = r.target_handover_id
       JOIN daily_work_items i ON i.id = r.item_id
       LEFT JOIN users ou ON ou.id = r.owner_user_id
       LEFT JOIN users ru ON ru.id = r.requested_by
      WHERE a.org_id = $1 AND a.decision = 'pending'
        AND ($3::boolean OR ${projectMembers.manageableProjectSql('h', '$2', '$1')})
      ORDER BY b.created_at, a.id`,
    [orgId, viewerId, isOrgAdmin]);
  return rows;
}

/**
 * The owner's side, for My day: their open requests, the retire-or-keep
 * questions waiting, and the entries a move flagged for them.
 */
async function listMine(orgId, userId) {
  const { rows: requests } = await pool.query(
    `SELECT r.id, r.item_id, r.status, r.is_open, r.recurring_decision, r.created_at,
            i.title AS item_title, i.kind AS item_kind,
            COALESCE(NULLIF(btrim(h.name), ''), 'Untitled project') AS target_name
       FROM daily_work_move_requests r
       JOIN daily_work_items i ON i.id = r.item_id
       JOIN sales_handovers h ON h.id = r.target_handover_id
      WHERE r.org_id = $1 AND r.owner_user_id = $2
        AND (r.is_open OR r.recurring_decision = 'pending')
      ORDER BY r.created_at DESC`,
    [orgId, userId]);

  // item_title is the ORIGINAL item's, because mergePair names it in the
  // separator — the editor needs it to count the merged length exactly.
  const { rows: flagged } = await pool.query(
    `SELECT m.id, m.request_id, m.outcome, m.needs_edit, m.left_out_reason,
            m.snap_entry_date::text AS entry_date,
            si.title AS item_title,
            COALESCE(NULLIF(btrim(h.name), ''), 'Untitled project') AS target_name,
            e.description AS original_description,
            te.description AS task_description
       FROM daily_work_move_entries m
       JOIN daily_work_move_requests r ON r.id = m.request_id
       JOIN sales_handovers h ON h.id = r.target_handover_id
       LEFT JOIN daily_work_items si   ON si.id = m.snap_item_id
       LEFT JOIN daily_work_entries e  ON e.id = m.entry_id
       LEFT JOIN daily_work_entries te ON te.id = m.target_entry_id
      WHERE m.org_id = $1 AND r.owner_user_id = $2
        AND (m.needs_edit OR m.outcome = 'left_out_too_long')
      ORDER BY m.snap_entry_date, m.id`,
    [orgId, userId]);

  return { requests, flagged };
}

/**
 * Everything the "Move to a project" form needs for one item: whether it can
 * move and why not, the entries to choose from, and the projects it can go to.
 *
 * For the owner or anyone whose chain contains them — the same people who may
 * raise the request. Anyone else gets NO_SUCH_ITEM.
 *
 * ENTRIES: the most recent ENTRY_LIMIT, newest first, with the total. Each
 * carries what the form needs to disable it rather than let the server refuse
 * it: already part of another request, or tagged to a standing initiative (the
 * form allows those only when that initiative is the target).
 *
 * TARGETS: open projects and initiatives, named. If the item itself belongs to
 * a standing initiative, that initiative is the only target — see
 * assertItemMovable.
 */
const ENTRY_LIMIT = 200;

async function getMoveOptions(orgId, viewerId, itemId) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) throw new DailyWorkError('Which item?', 'MISSING_ITEM');

  return withOrgTransaction(orgId, async (client) => {
    const { rows: [item] } = await client.query(
      `SELECT i.id, i.owner_user_id, i.kind, i.title, i.status, i.anchor_kind, i.anchor_id,
              i.play_instance_id,
              CASE WHEN i.anchor_kind = 'handover' THEN h.name END AS anchor_label,
              CASE WHEN i.anchor_kind = 'handover' THEN COALESCE(h.tracking_mode, 'timeboxed') END
                AS anchor_tracking_mode,
              u.first_name || ' ' || u.last_name AS owner_name,
              (SELECT r.id FROM daily_work_move_requests r
                WHERE r.item_id = i.id AND r.is_open LIMIT 1) AS open_request_id
         FROM daily_work_items i
         LEFT JOIN sales_handovers h
                ON i.anchor_kind = 'handover' AND h.id = i.anchor_id AND h.org_id = i.org_id
         LEFT JOIN users u ON u.id = i.owner_user_id
        WHERE i.id = $1 AND i.org_id = $2`,
      [id, orgId]);
    if (!item || !(await canActFor(orgId, viewerId, item.owner_user_id))) {
      throw new DailyWorkError('No such work item', 'NO_SUCH_ITEM', { itemId: id });
    }

    let reason = null;
    if (item.play_instance_id) reason = 'This item is already logged against a project task.';
    else if (!isItemOpen(item)) reason = 'Only open items can be moved. This one is closed.';
    else if (item.open_request_id) reason = 'There is already an open move request for this item.';
    const lockedTargetId = item.anchor_tracking_mode === 'standing' ? item.anchor_id : null;

    const { rows: entries } = await client.query(
      `SELECT e.id, e.entry_date::text AS entry_date, e.description, e.day_stage,
              e.anchor_kind, e.anchor_id,
              CASE WHEN e.anchor_kind = 'handover' THEN h.name END AS anchor_label,
              (e.anchor_kind = 'handover' AND COALESCE(h.tracking_mode, 'timeboxed') = 'standing')
                AS anchor_is_standing,
              EXISTS (SELECT 1 FROM daily_work_move_entries m
                       WHERE m.entry_id = e.id AND m.outcome IN ('pending', 'left_out_too_long'))
                AS in_other_request
         FROM daily_work_entries e
         LEFT JOIN sales_handovers h
                ON e.anchor_kind = 'handover' AND h.id = e.anchor_id AND h.org_id = e.org_id
        WHERE e.item_id = $1 AND e.org_id = $2
        ORDER BY e.entry_date DESC, e.id DESC
        LIMIT $3`,
      [id, orgId, ENTRY_LIMIT]);
    const { rows: [{ n: totalEntries }] } = await client.query(
      `SELECT count(*)::int AS n FROM daily_work_entries WHERE item_id = $1 AND org_id = $2`, [id, orgId]);

    const { rows: targets } = await client.query(
      `SELECT h.id, COALESCE(NULLIF(btrim(h.name), ''), d.name, 'Untitled project') AS name,
              COALESCE(h.tracking_mode, 'timeboxed') AS tracking_mode,
              h.go_live_date::text AS go_live_date
         FROM sales_handovers h
         LEFT JOIN deals d ON d.id = h.deal_id AND d.org_id = h.org_id
        WHERE h.org_id = $1
          AND h.status NOT IN ('completed', 'cancelled')
          AND h.retired_at IS NULL
          AND ($2::int IS NULL OR h.id = $2)
        ORDER BY COALESCE(h.tracking_mode, 'timeboxed') DESC, name`,
      [orgId, lockedTargetId]);

    return {
      item: { ...item, movable: !reason, reason, lockedTargetId },
      entries,
      totalEntries,
      targets,
    };
  });
}

/**
 * What the target approver chooses from: the project's tasks and its stages,
 * plus the item's title as the default for a new task.
 *
 * Every task comes back with its status. An existing-task placement must pick
 * an open one; a new task may wait for any task, open or closed.
 */
async function getPlacementOptions(orgId, viewerId, requestId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows: [req] } = await client.query(
      `SELECT r.id, r.target_handover_id, i.title AS item_title
         FROM daily_work_move_requests r
         JOIN daily_work_items i ON i.id = r.item_id
        WHERE r.id = $1 AND r.org_id = $2`,
      [requestId, orgId]);
    if (!req) throw new DailyWorkError('No such move request', 'NO_SUCH_REQUEST', { requestId });
    if (!(await projectMembers.canManageProject(req.target_handover_id, orgId, viewerId))) {
      throw new DailyWorkError('Only a manager of the project this work is moving to can choose the task.',
        'NOT_PROJECT_MANAGER', { handoverId: req.target_handover_id });
    }

    const { rows: tasks } = await client.query(
      `SELECT p.id, p.title, p.stage_key, COALESCE(ps.name, p.stage_key) AS stage_name,
              p.status, p.due_date::text AS due_date, p.is_gate
         FROM project_play_instances p
         LEFT JOIN project_stages ps
                ON ps.handover_id = p.handover_id AND ps.key = p.stage_key AND ps.is_active = TRUE
        WHERE p.handover_id = $1 AND p.org_id = $2
        ORDER BY ps.sort_order NULLS LAST, p.stage_key, p.sort_order, p.id`,
      [req.target_handover_id, orgId]);

    const { rows: stages } = await client.query(
      `SELECT key, name, gating FROM project_stages
        WHERE handover_id = $1 AND org_id = $2 AND is_active = TRUE
        ORDER BY sort_order, key`,
      [req.target_handover_id, orgId]);

    return { itemTitle: req.item_title, tasks, stages };
  });
}

module.exports = {
  getMoveOptions,
  getPlacementOptions,
  createRequest,
  addEntries,
  withdraw,
  decide,
  setRecurringDecision,
  editFlaggedEntry,
  markEntryDone,
  tryPendingMerges,
  getConflicts,
  getRequest,
  listReviewQueue,
  listMine,
};
