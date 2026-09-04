/**
 * playReview.service.js
 *
 * DROP-IN LOCATION: backend/services/playReview.service.js  (NEW FILE)
 *
 * The review loop on a project checklist task (2026_130).
 *
 * ── WHY THIS IS A SEPARATE SERVICE ──────────────────────────────────────────
 *
 * handover.service.js already has two write paths for a play's status and they
 * are split deliberately:
 *
 *   updatePlay()   — in-flight status only. Refuses 'completed'/'skipped',
 *                    because a plain PATCH would skip gates, evidence and
 *                    completed_at and leave a row claiming to be done with no
 *                    completion date.
 *   completePlay() — the guarded path: stage gates, prerequisites, evidence
 *                    policy, next-play firing, dependency unblocking.
 *
 * A review transition is neither. It needs completePlay's guards but not its
 * side effects (on submission), and it needs to REVERSE those side effects (on
 * rejection) — which nothing in the codebase could do, because nothing recorded
 * what a completion had produced.
 *
 * Bolting 'in_review' onto updatePlay's allowlist would have made submission
 * the one status change that skips every check, which is exactly backwards:
 * submission is the moment the checks matter most, because it is the moment
 * someone else is asked to trust the work.
 *
 * ── THE MATRIX ──────────────────────────────────────────────────────────────
 *
 *   from                    to             who              extra
 *   ────────────────────────────────────────────────────────────────────────
 *   open*                   in_review      assignee, mgr    evidence, target
 *   open*                   completed      assignee, mgr    evidence
 *   open*                   skipped        assignee, mgr    evidence
 *   open*                   cancelled      assignee, mgr    evidence
 *   in_review               completed      manager only     —  (approve)
 *   in_review               skipped        manager only     —  (approve)
 *   in_review               cancelled      manager only     —  (approve)
 *   in_review               in_progress    manager only     reason (reject)
 *   completed/skipped/
 *   cancelled               in_progress    manager only     reason (reject)
 *
 *   * open = not_started | in_progress | blocked | snoozed
 *
 * The assignee can move a task INTO review but cannot act on one that is
 * already there. Without that asymmetry the review gate is decorative — the
 * submitter would simply approve themselves.
 *
 * ── EVIDENCE ────────────────────────────────────────────────────────────────
 *
 * Required on every transition out of an open status, UNCONDITIONALLY —
 * evidence_config (`required` / `requiredForGates`) does not soften it. A
 * manager cannot judge a submission with nothing to look at, and if the direct
 * completion path were exempt it would immediately become the way to dodge the
 * rule. Free text counts: the point is that a human wrote down what happened,
 * not that a file was uploaded.
 *
 * Evidence captured at submission carries into completion_evidence on approval,
 * so the manager is not asked for it again.
 */

const { pool }              = require('../config/database');
const PlaybookPlayService   = require('./PlaybookPlayService');
const PlayCompletionService = require('./PlayCompletionService');
const projectMembers        = require('./projectMembers.service');
const projectSettings       = require('./projectSettings.service');
const notifier              = require('./playReviewNotifier.service');

// Statuses a play can hold while still open for work.
const OPEN_STATUSES     = ['not_started', 'in_progress', 'blocked', 'snoozed'];
// What a submission can be asking for.
const TERMINAL_STATUSES = ['completed', 'skipped', 'cancelled'];
// Where a rejection lands. Always in_progress, never back to not_started: the
// work was done, it was found wanting, and it is now being redone.
const REJECT_TO         = 'in_progress';

const EVIDENCE_MAX = 4000;

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Who is this user, relative to ONE play?
 *
 * 'manager'  — org admin/owner, the Project Manager (assigned_service_owner_id),
 *              the project creator, or (2026_137) an approved project_members
 *              row carrying can_manage. Delegates to canManageProject so there
 *              is one definition of project authority in the codebase.
 * 'assignee' — project_play_instances.owner_user_id, and only that. The
 *              project_play_assignees table looks like a second answer but is
 *              not one: its only writer, reassignPlayForProject(), is
 *              unreachable from any route, so it is empty in every live org.
 *              owner_user_id is what the checklist displays and what the
 *              inline owner chip writes — the visible assignment is the real
 *              one.
 * null       — no authority over this play.
 *
 * An UNASSIGNED play (owner_user_id NULL) therefore resolves to 'manager' or
 * null: nobody inherits it by being nearby.
 */
async function resolveActorRole(handoverId, instanceId, orgId, userId) {
  if (!userId) return { role: null, ownerUserId: null };

  const { rows: [play] } = await pool.query(
    `SELECT owner_user_id, status, review_target_status
       FROM project_play_instances
      WHERE id = $1 AND handover_id = $2 AND org_id = $3`,
    [instanceId, handoverId, orgId]
  );
  if (!play) {
    throw Object.assign(new Error('Play does not belong to this project'), { status: 404 });
  }

  // Manager first: a Project Manager who is also the assignee of a task is
  // acting as the manager, and should not lose approval rights on their own
  // work by virtue of owning it. (They still cannot approve their own
  // submission — that is enforced by the transition matrix, not by role.)
  if (await projectMembers.canManageProject(handoverId, orgId, userId)) {
    return { role: 'manager', ownerUserId: play.owner_user_id, play };
  }
  if (play.owner_user_id != null && play.owner_user_id === userId) {
    return { role: 'assignee', ownerUserId: play.owner_user_id, play };
  }
  return { role: null, ownerUserId: play.owner_user_id, play };
}

/**
 * May this user edit this play at all? Exposed so the UI can render a row
 * read-only rather than offer controls and then be refused.
 */
async function canEditPlay(handoverId, instanceId, orgId, userId) {
  const { role, play } = await resolveActorRole(handoverId, instanceId, orgId, userId);
  if (!role) return false;
  // A play under review is frozen for its assignee — the manager is looking at
  // it, and a submission that can still be edited underneath them is not a
  // submission. Notes stay open to everyone regardless; they are the channel
  // for "one more thing" while a review is pending.
  if (play.status === 'in_review' && role === 'assignee') return false;
  return true;
}

/**
 * May this user move this play's due date?
 *
 * Historically anyone could, deliberately — the comment in updatePlay argues
 * that recording the move matters more than restricting it. That stays true
 * for managers. For assignees it is now off by default: a date an assignee can
 * move at will is not a commitment, and Plan vs Actual is measuring against it.
 * Orgs that liked the old behaviour turn allow_assignee_due_date_change on.
 */
async function canChangeDueDate(handoverId, instanceId, orgId, userId) {
  const { role } = await resolveActorRole(handoverId, instanceId, orgId, userId);
  if (role === 'manager') return true;
  if (role !== 'assignee') return false;
  const cfg = await projectSettings.get(orgId);
  return cfg.allow_assignee_due_date_change === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARDS (local copies — see note)
// ═══════════════════════════════════════════════════════════════════════════
//
// handover.service.js has _stageBlockers and _outstandingPrereqs but does not
// export them, and it will require THIS module (for the due-date rule), so
// reaching back into it would create a cycle. The two queries are short and
// stable; duplicating them is cheaper than the indirection a shared module
// would add. If a third caller ever appears, lift both into a helper module.

async function _stageBlockers(instanceId, orgId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT COALESCE(ps2.name, e.stage_key) AS name
       FROM project_play_instances p
       JOIN project_stages pst ON pst.handover_id = p.handover_id
                              AND pst.key = p.stage_key AND pst.is_active = TRUE
       JOIN project_play_instances e ON e.handover_id = p.handover_id
       LEFT JOIN project_stages ps2 ON ps2.handover_id = e.handover_id
                                   AND ps2.key = e.stage_key AND ps2.is_active = TRUE
      WHERE p.id = $1 AND p.org_id = $2
        AND e.status NOT IN ('completed', 'skipped', 'cancelled')
        AND ps2.sort_order < pst.sort_order
        AND (pst.gating = 'strict' OR (pst.gating = 'gates' AND e.is_gate = TRUE))`,
    [instanceId, orgId]
  );
  return rows.map(r => r.name);
}

async function _outstandingPrereqs(instanceId, orgId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.status
       FROM project_play_instances p
       JOIN project_play_instances d ON d.id = ANY(p.depends_on)
      WHERE p.id = $1 AND p.org_id = $2
        AND d.status NOT IN ('completed', 'skipped', 'cancelled')
      ORDER BY d.id`,
    [instanceId, orgId]
  );
  return rows;
}

/**
 * Gate and prerequisite checks, applied only when the end state is
 * 'completed'.
 *
 * A skip or a cancel is a decision that the work will NOT happen, and blocking
 * it on unfinished prerequisites would strand exactly the tasks most likely to
 * need skipping. Completion is the claim that the work DID happen, which is
 * the claim the dependency graph exists to police.
 */
async function _assertClearToComplete(instanceId, orgId) {
  const stageBlockers = await _stageBlockers(instanceId, orgId);
  if (stageBlockers.length) {
    throw Object.assign(
      new Error(`This stage is locked until ${stageBlockers.join(', ')} clears its gates.`),
      { status: 409, code: 'STAGE_LOCKED', stageBlockedBy: stageBlockers });
  }
  const outstanding = await _outstandingPrereqs(instanceId, orgId);
  if (outstanding.length) {
    throw Object.assign(
      new Error(`Blocked by: ${outstanding.map(p => p.title).join(', ')}. `
              + 'Complete those first, or remove the dependency.'),
      { status: 409, code: 'PREREQ_INCOMPLETE', blockedBy: outstanding });
  }
}

/**
 * Normalise whatever the client sent into the { snippet } shape the rest of
 * the codebase already reads (completion_evidence, _evidencePolicy).
 *
 * A bare string is accepted because "evidence can just be text" is the common
 * case — a line describing what was done and where it landed.
 */
function _normaliseEvidence(raw) {
  if (raw == null) return null;
  const obj = typeof raw === 'string' ? { snippet: raw } : { ...raw };
  const snippet = String(obj.snippet ?? '').trim();
  if (!snippet) return null;
  if (snippet.length > EVIDENCE_MAX) {
    throw Object.assign(
      new Error(`Evidence cannot be longer than ${EVIDENCE_MAX} characters.`),
      { status: 400 });
  }
  return { ...obj, snippet };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION BOOKKEEPING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every action id currently attached to this project.
 *
 * Used to diff before/after a completion so we learn which actions that
 * completion produced. PlayCompletionService.fireNextPlay() returns a COUNT,
 * not ids, and it is called by five modules — widening its return type to
 * serve one of them would be the wrong trade. The diff is contained here and
 * costs one indexed query either side.
 */
async function _actionIdsOnProject(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT id FROM actions WHERE handover_id = $1 AND org_id = $2`,
    [handoverId, orgId]
  );
  return new Set(rows.map(r => r.id));
}

/**
 * Withdraw the actions a now-rejected completion had produced.
 *
 * Cancel rather than delete: the action existed, someone may have seen it in
 * their queue, and a deleted row cannot explain itself. Already-completed
 * actions are left alone — someone did that work, and revoking the trigger
 * does not un-do it.
 */
async function _cancelFiredActions(instanceId, orgId) {
  const { rows: [inst] } = await pool.query(
    `SELECT fired_action_ids, action_id FROM project_play_instances
      WHERE id = $1 AND org_id = $2`, [instanceId, orgId]);
  if (!inst) return { cancelled: 0 };

  let cancelled = 0;
  if (Array.isArray(inst.fired_action_ids) && inst.fired_action_ids.length) {
    const { rowCount } = await pool.query(
      `UPDATE actions SET status = 'cancelled', updated_at = now()
        WHERE id = ANY($1) AND org_id = $2 AND status <> 'completed'`,
      [inst.fired_action_ids, orgId]);
    cancelled = rowCount;
  }

  // The play's OWN action was marked completed by completePlayForProject.
  // Reopening the play must reopen it, or the assignee is asked to redo work
  // that their queue still shows as finished.
  //
  // 'not_started', NOT 'pending': actions_status_check permits exactly
  // not_started | in_progress | blocked | snoozed | completed | skipped |
  // cancelled. 'pending' appears in some notification code paths but is not a
  // legal value in this column and would raise here.
  if (inst.action_id) {
    await pool.query(
      `UPDATE actions
          SET status = 'not_started', completed = false,
              completed_at = NULL, completed_by = NULL, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [inst.action_id, orgId]);
  }
  return { cancelled };
}

/**
 * Re-approval after a rejection. The chain was cancelled, not deleted, so
 * re-firing would hit fireNextPlay's ON CONFLICT DO NOTHING and silently
 * produce nothing — the downstream work would vanish on the second approval.
 * Un-cancelling is what makes the loop survivable.
 */
async function _restoreFiredActions(instanceId, orgId) {
  const { rows: [inst] } = await pool.query(
    `SELECT fired_action_ids FROM project_play_instances WHERE id = $1 AND org_id = $2`,
    [instanceId, orgId]);
  if (!inst || !Array.isArray(inst.fired_action_ids) || !inst.fired_action_ids.length) {
    return { restored: 0 };
  }
  const { rowCount } = await pool.query(
    `UPDATE actions SET status = 'not_started', updated_at = now()
      WHERE id = ANY($1) AND org_id = $2 AND status = 'cancelled'`,
    [inst.fired_action_ids, orgId]);
  return { restored: rowCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════════════════════════

async function _recordTransition(client, {
  orgId, handoverId, instanceId, from, to, targetStatus, actorId, reason, evidence,
}) {
  await client.query(
    `INSERT INTO project_play_status_transitions
       (org_id, handover_id, project_play_instance_id, from_status, to_status,
        target_status, actor_id, reason, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [orgId, handoverId, instanceId, from, to, targetStatus ?? null, actorId,
     reason ?? null, evidence ? JSON.stringify(evidence) : null]
  );
}

/**
 * Mirror the manager's reason into the task's note thread.
 *
 * The transitions table is the machine record; play_notes is where a human
 * looking at the task six weeks later actually reads. A rejection that only
 * exists in an audit table is a rejection nobody sees.
 *
 * note_type 'system' is reserved by 2026_120 for machine-written notes and is
 * exactly this case: the sentence is the manager's, the act of filing it is
 * not. is_internal FALSE — the assignee must be able to read why their work
 * came back.
 */
async function _mirrorReasonToNote(client, { orgId, instanceId, actorId, body }) {
  await client.query(
    `INSERT INTO play_notes
       (org_id, project_play_instance_id, author_id, body, note_type, is_internal)
     VALUES ($1, $2, $3, $4, 'system', FALSE)`,
    [orgId, instanceId, actorId, body]
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// THE TRANSITION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Move a play through the review workflow.
 *
 * @param {number} handoverId
 * @param {number} instanceId
 * @param {number} orgId
 * @param {number} userId
 * @param {object} data
 *   @param {string}  data.to            'in_review' | 'completed' | 'skipped' |
 *                                       'cancelled' | 'in_progress'
 *   @param {string} [data.targetStatus] required when to === 'in_review'
 *   @param {string|object} [data.evidence]  required leaving an open status
 *   @param {string} [data.reason]       required on a rejection
 * @returns {{ instance, from, to, notified }}
 */
async function transition(handoverId, instanceId, orgId, userId, data = {}) {
  const to = String(data.to || '').trim();
  const { role, play } = await resolveActorRole(handoverId, instanceId, orgId, userId);

  if (!role) {
    throw Object.assign(
      new Error('Only the person this task is assigned to, or the project manager, can move it.'),
      { status: 403, code: 'NOT_PERMITTED' });
  }

  const from = play.status;
  const isOpen = OPEN_STATUSES.includes(from);

  // ── Route ────────────────────────────────────────────────────────────────
  if (to === 'in_review')                      return _submit({ handoverId, instanceId, orgId, userId, role, from, isOpen, data });
  if (TERMINAL_STATUSES.includes(to))          return _close ({ handoverId, instanceId, orgId, userId, role, from, isOpen, to, play, data });
  if (to === REJECT_TO)                        return _reject({ handoverId, instanceId, orgId, userId, role, from, data });

  throw Object.assign(
    new Error(`Cannot move a task to '${to}'. Use the checklist controls for start, pause and block.`),
    { status: 400, code: 'BAD_TRANSITION' });
}

// ── Submit for review ──────────────────────────────────────────────────────
async function _submit({ handoverId, instanceId, orgId, userId, role, from, isOpen, data }) {
  if (!isOpen) {
    throw Object.assign(
      new Error(from === 'in_review'
        ? 'This task is already under review.'
        : 'Only a task that is still open can be sent for review.'),
      { status: 409, code: 'BAD_TRANSITION' });
  }

  const targetStatus = String(data.targetStatus || 'completed').trim();
  if (!TERMINAL_STATUSES.includes(targetStatus)) {
    throw Object.assign(
      new Error(`targetStatus must be one of: ${TERMINAL_STATUSES.join(', ')}.`),
      { status: 400 });
  }

  const evidence = _normaliseEvidence(data.evidence);
  if (!evidence) {
    throw Object.assign(
      new Error('Add evidence before sending this for review — a note on what was done is enough.'),
      { status: 400, code: 'EVIDENCE_REQUIRED' });
  }

  if (targetStatus === 'completed') await _assertClearToComplete(instanceId, orgId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [inst] } = await client.query(
      `UPDATE project_play_instances
          SET status = 'in_review',
              review_target_status = $1,
              review_submitted_at  = now(),
              review_submitted_by  = $2,
              review_evidence      = $3::jsonb,
              updated_at           = now()
        WHERE id = $4 AND org_id = $5 AND status = $6
        RETURNING *`,
      [targetStatus, userId, JSON.stringify(evidence), instanceId, orgId, from]);

    // Zero rows means someone else moved it between our read and our write.
    if (!inst) {
      throw Object.assign(
        new Error('This task changed while you were working on it. Reload and try again.'),
        { status: 409, code: 'CONCURRENT_UPDATE' });
    }

    await _recordTransition(client, {
      orgId, handoverId, instanceId, from, to: 'in_review',
      targetStatus, actorId: userId, evidence,
    });
    await client.query('COMMIT');

    const notified = await notifier.notify('submitted', {
      orgId, handoverId, instance: inst, actorId: userId, role,
      targetStatus, evidence,
    });
    return { instance: inst, from, to: 'in_review', notified };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Approve out of review, or close directly ───────────────────────────────
async function _close({ handoverId, instanceId, orgId, userId, role, from, isOpen, to, play, data }) {
  const fromReview = from === 'in_review';

  if (!fromReview && !isOpen) {
    throw Object.assign(
      new Error(`This task is already ${from}.`), { status: 409, code: 'BAD_TRANSITION' });
  }

  // Approval is the manager's act. An assignee approving their own submission
  // would make the review gate decorative.
  if (fromReview && role !== 'manager') {
    throw Object.assign(
      new Error('This task is with the project manager for review.'),
      { status: 403, code: 'REVIEW_PENDING' });
  }

  // Approving something other than what was asked for would silently rewrite
  // the request — a manager who wants a different outcome rejects and says so.
  if (fromReview && play.review_target_status && play.review_target_status !== to) {
    throw Object.assign(
      new Error(`This task was submitted to be marked ${play.review_target_status}, not ${to}. `
              + 'Send it back if a different outcome is needed.'),
      { status: 409, code: 'TARGET_MISMATCH' });
  }

  // Evidence: reuse what was submitted, or require it fresh on the direct path.
  let evidence = null;
  if (fromReview) {
    const { rows: [cur] } = await pool.query(
      `SELECT review_evidence FROM project_play_instances WHERE id = $1 AND org_id = $2`,
      [instanceId, orgId]);
    evidence = cur?.review_evidence || null;
  } else {
    evidence = _normaliseEvidence(data.evidence);
    if (!evidence) {
      throw Object.assign(
        new Error('Add evidence before closing this task — a note on what was done is enough.'),
        { status: 400, code: 'EVIDENCE_REQUIRED' });
    }
  }

  if (to === 'completed' && !fromReview) await _assertClearToComplete(instanceId, orgId);

  // ── Apply ────────────────────────────────────────────────────────────────
  // completePlayForProject / skipPlayForProject own the side effects (action
  // closure, dependency unblocking). Reimplementing them here would be a
  // second definition of what "done" means.
  const before = await _actionIdsOnProject(handoverId, orgId);

  if (to === 'completed') {
    await PlaybookPlayService.completePlayForProject(instanceId, userId, orgId);
  } else if (to === 'skipped') {
    await PlaybookPlayService.skipPlayForProject(instanceId, userId, orgId);
  } else {
    const { rows: [cancelled] } = await pool.query(
      `UPDATE project_play_instances
          SET status = 'cancelled', overridden_by = $1, updated_at = now()
        WHERE id = $2 AND org_id = $3
          AND status IN ('not_started', 'in_progress', 'blocked', 'snoozed', 'in_review')
        RETURNING handover_id, play_id`,
      [userId, instanceId, orgId]);
    if (!cancelled) {
      throw Object.assign(
        new Error('This task changed while you were working on it. Reload and try again.'),
        { status: 409, code: 'CONCURRENT_UPDATE' });
    }
    // A cancelled task SATISFIES its dependents (see the predicate note in
    // handover.service). Anything sitting in 'blocked' behind it must be
    // released, exactly as skipPlayForProject does — otherwise cancelling a
    // step strands everything downstream of it in a status nothing will clear.
    if (cancelled.play_id) {
      await PlaybookPlayService._resolveDependenciesForProject(
        cancelled.handover_id, cancelled.play_id, orgId, userId
      ).catch(err => console.error(
        `[playReview] dependency release failed after cancelling ${instanceId}:`, err.message));
    }
  }

  // Next-play chain. Awaited rather than fire-and-forget: we need to know which
  // actions this completion produced so a later rejection can withdraw them.
  if (to === 'completed') {
    const { rows: [inst0] } = await pool.query(
      `SELECT play_id FROM project_play_instances WHERE id = $1 AND org_id = $2`,
      [instanceId, orgId]);
    if (inst0?.play_id) {
      try {
        await PlayCompletionService.fireNextPlay('handover', handoverId, inst0.play_id, orgId, userId);
      } catch (err) {
        // Contained, as at the original call site: a next-play failure must not
        // fail the completion that has already been written.
        console.error(`[playReview] next-play hook failed for project ${handoverId}:`, err.message);
      }
    }
  }

  const after = await _actionIdsOnProject(handoverId, orgId);
  const fired = [...after].filter(id => !before.has(id));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [inst] } = await client.query(
      `UPDATE project_play_instances
          SET completion_note     = COALESCE($1, completion_note),
              completion_evidence = COALESCE($2::jsonb, completion_evidence),
              fired_action_ids    = CASE WHEN $3::int[] IS NULL OR array_length($3::int[], 1) IS NULL
                                         THEN fired_action_ids ELSE $3::int[] END,
              review_target_status = NULL,
              review_submitted_at  = NULL,
              review_submitted_by  = NULL,
              review_evidence      = NULL,
              updated_at = now()
        WHERE id = $4 AND org_id = $5
        RETURNING *`,
      [data.completionNote ?? null,
       evidence ? JSON.stringify(evidence) : null,
       fired.length ? fired : null,
       instanceId, orgId]);

    await _recordTransition(client, {
      orgId, handoverId, instanceId, from, to,
      actorId: userId, reason: data.reason ?? null, evidence,
    });
    await client.query('COMMIT');

    // Re-approval after a rejection: the chain was cancelled, not deleted.
    if (from === 'in_review' || to === 'completed') {
      await _restoreFiredActions(instanceId, orgId).catch(() => {});
    }

    const notified = await notifier.notify(fromReview ? 'approved' : 'closed_direct', {
      orgId, handoverId, instance: inst, actorId: userId, role, targetStatus: to, evidence,
    });
    return { instance: inst, from, to, notified };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Reject: send it back ───────────────────────────────────────────────────
async function _reject({ handoverId, instanceId, orgId, userId, role, from, data }) {
  if (role !== 'manager') {
    throw Object.assign(
      new Error('Only the project manager can send a task back.'),
      { status: 403, code: 'NOT_PERMITTED' });
  }
  if (from !== 'in_review' && !TERMINAL_STATUSES.includes(from)) {
    throw Object.assign(
      new Error('Only a task that is under review or already closed can be sent back.'),
      { status: 409, code: 'BAD_TRANSITION' });
  }

  const reason = String(data.reason || '').trim();
  if (!reason) {
    throw Object.assign(
      new Error('Say why this is going back — the assignee needs to know what to fix.'),
      { status: 400, code: 'REASON_REQUIRED' });
  }

  // Withdraw the downstream work a completion had set in motion. Runs before
  // the status flip so that if it fails, the play stays closed and consistent
  // rather than reopening with live actions hanging off it.
  let withdrawn = { cancelled: 0 };
  if (TERMINAL_STATUSES.includes(from)) {
    withdrawn = await _cancelFiredActions(instanceId, orgId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [inst] } = await client.query(
      `UPDATE project_play_instances
          SET status = $1,
              completed_at = NULL, completed_by = NULL,
              review_target_status = NULL,
              review_submitted_at  = NULL,
              review_submitted_by  = NULL,
              review_evidence      = NULL,
              updated_at = now()
        WHERE id = $2 AND org_id = $3 AND status = $4
        RETURNING *`,
      [REJECT_TO, instanceId, orgId, from]);

    if (!inst) {
      throw Object.assign(
        new Error('This task changed while you were working on it. Reload and try again.'),
        { status: 409, code: 'CONCURRENT_UPDATE' });
    }

    await _recordTransition(client, {
      orgId, handoverId, instanceId, from, to: REJECT_TO, actorId: userId, reason,
    });
    await _mirrorReasonToNote(client, {
      orgId, instanceId, actorId: userId,
      body: `Sent back for rework: ${reason}`,
    });
    await client.query('COMMIT');

    const notified = await notifier.notify('rejected', {
      orgId, handoverId, instance: inst, actorId: userId, role, reason,
    });

    // Dependents that were unblocked by the now-revoked completion are NOT
    // cascaded back. _outstandingPrereqs is computed live, so anything not yet
    // started re-locks on its own; anything already in flight represents work
    // someone actually did, and undoing it would be worse than surfacing it.
    const affected = await dependentsInFlight(instanceId, orgId);

    return { instance: inst, from, to: REJECT_TO, notified, withdrawn, affected };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Dependents of this play that are already past 'not_started'.
 *
 * Surfaced on a rejection so the UI can say "Site handover and Punch list have
 * already started off the back of this" rather than leaving the manager to
 * discover it. Advisory only — nothing is changed.
 */
async function dependentsInFlight(instanceId, orgId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.status
       FROM project_play_instances d
      WHERE d.org_id = $1
        AND $2 = ANY(d.depends_on)
        AND d.status NOT IN ('not_started', 'blocked')
      ORDER BY d.id`,
    [orgId, instanceId]);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY + QUEUE
// ═══════════════════════════════════════════════════════════════════════════

async function history(handoverId, instanceId, orgId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.from_status, t.to_status, t.target_status, t.reason,
            t.evidence, t.created_at,
            u.first_name || ' ' || u.last_name AS actor_name
       FROM project_play_status_transitions t
       LEFT JOIN users u ON u.id = t.actor_id
      WHERE t.project_play_instance_id = $1 AND t.handover_id = $2 AND t.org_id = $3
      ORDER BY t.created_at DESC, t.id DESC`,
    [instanceId, handoverId, orgId]);
  return rows.map(r => ({
    id: r.id, from: r.from_status, to: r.to_status,
    targetStatus: r.target_status, reason: r.reason,
    evidence: r.evidence, at: r.created_at, actorName: r.actor_name,
  }));
}

/**
 * Everything on this project currently awaiting review. The reason 'in_review'
 * is a status rather than a flag.
 */
async function reviewQueue(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.stage_key, p.due_date,
            p.review_target_status, p.review_submitted_at, p.review_evidence,
            su.first_name || ' ' || su.last_name AS submitted_by_name,
            ou.first_name || ' ' || ou.last_name AS owner_name
       FROM project_play_instances p
       LEFT JOIN users su ON su.id = p.review_submitted_by
       LEFT JOIN users ou ON ou.id = p.owner_user_id
      WHERE p.handover_id = $1 AND p.org_id = $2 AND p.status = 'in_review'
      ORDER BY p.review_submitted_at ASC NULLS LAST, p.id`,
    [handoverId, orgId]);
  return rows.map(r => ({
    playInstanceId: r.id, title: r.title, stageKey: r.stage_key,
    dueDate: r.due_date, targetStatus: r.review_target_status,
    submittedAt: r.review_submitted_at, submittedByName: r.submitted_by_name,
    ownerName: r.owner_name, evidence: r.review_evidence,
  }));
}

/**
 * Everything awaiting THIS user's review, across every project they are
 * accountable for.
 *
 * reviewQueue() above answers "what is waiting on this project". That is the
 * right question when you are already looking at a project, and the wrong one
 * when you run six of them — the person who has to clear these does not know
 * which project to open, which is precisely the failure that makes reviews sit.
 *
 * SCOPE mirrors canManageProject, expressed as one query rather than N calls:
 *   • org admin/owner  → every project in the org
 *   • everyone else    → projects where they are the service owner, the
 *                        creator, or an approved member with can_manage
 *
 * THE NON-ADMIN ARM IS NOT WRITTEN OUT HERE ANY MORE. It comes from
 * projectMembers.manageableProjectSql, which is the same fragment
 * canManageProject is built from.
 *
 * This is why. The rule used to be hand-copied into this query, and when
 * 2026_137 added can_manage the copy did not know. The result would have been
 * silent and confusing in the specific way permission bugs always are: a member
 * granted authority sees approve and reject buttons on every task on the
 * project — because the checklist asks canManageProject — and then opens their
 * review queue and finds it empty, because this query still believed authority
 * meant two columns on sales_handovers. Nothing errors. The screen just
 * disagrees with itself, and the person concludes the queue is broken.
 *
 * Sharing the fragment does not remove the duplication — this still cannot call
 * the function once per project — but it makes the duplication one edit deep
 * instead of two, and a grep for manageableProjectSql now finds every query
 * that depends on the rule.
 *
 * Watchers are deliberately NOT in scope. Being told about a review is not the
 * same as being able to act on one, and a queue that lists work you cannot
 * clear is a worse instrument than no queue.
 *
 * Ordered oldest-submission-first: the thing that has been waiting longest is
 * the thing most likely to be blocking someone.
 */
async function myReviewQueue(orgId, userId, { limit = 100 } = {}) {
  if (!userId) return [];

  const { rows: [me] } = await pool.query(
    `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`,
    [orgId, userId]);
  if (!me) return [];
  const isOrgAdmin = ['admin', 'owner'].includes(me.role);

  const { rows } = await pool.query(
    `SELECT p.id                AS play_instance_id,
            p.title,
            p.stage_key,
            p.due_date,
            p.review_target_status,
            p.review_submitted_at,
            p.handover_id,
            COALESCE(NULLIF(btrim(h.name), ''), d.name, a.name, 'Untitled project') AS project_name,
            su.first_name || ' ' || su.last_name AS submitted_by_name,
            ou.first_name || ' ' || ou.last_name AS owner_name
       FROM project_play_instances p
       JOIN sales_handovers h ON h.id = p.handover_id AND h.org_id = p.org_id
       LEFT JOIN deals    d  ON d.id = h.deal_id
       LEFT JOIN accounts a  ON a.id = h.account_id
       LEFT JOIN users   su  ON su.id = p.review_submitted_by
       LEFT JOIN users   ou  ON ou.id = p.owner_user_id
      WHERE p.org_id = $1
        AND p.status = 'in_review'
        -- A cancelled or completed PROJECT should not surface tasks to review.
        -- Its checklist is history, and anything left in review on it is a
        -- loose end to clean up, not work to action.
        AND h.status NOT IN ('cancelled', 'completed')
        AND ($3::boolean IS TRUE
             OR ${projectMembers.manageableProjectSql('h', '$2', '$1')})
      ORDER BY p.review_submitted_at ASC NULLS LAST, p.id
      LIMIT $4`,
    [orgId, userId, isOrgAdmin, limit]);

  return rows.map(r => ({
    playInstanceId:   r.play_instance_id,
    handoverId:       r.handover_id,
    projectName:      r.project_name,
    title:            r.title,
    stageKey:         r.stage_key,
    dueDate:          r.due_date,
    targetStatus:     r.review_target_status,
    submittedAt:      r.review_submitted_at,
    submittedByName:  r.submitted_by_name,
    ownerName:        r.owner_name,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// WATCHERS
// ═══════════════════════════════════════════════════════════════════════════

async function listWatchers(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT w.user_id, u.first_name || ' ' || u.last_name AS name, u.email
       FROM project_play_watchers w
       JOIN users u ON u.id = w.user_id
      WHERE w.handover_id = $1 AND w.org_id = $2
      ORDER BY u.first_name, u.last_name`,
    [handoverId, orgId]);
  return rows.map(r => ({ userId: r.user_id, name: r.name, email: r.email }));
}

/**
 * Replace the watcher list wholesale. Gated on project authority: who gets
 * told about review activity is a project-management decision.
 */
async function setWatchers(handoverId, orgId, actorId, userIds = []) {
  if (!(await projectMembers.canManageProject(handoverId, orgId, actorId))) {
    throw Object.assign(
      new Error('Only the project manager or an org admin can change who is alerted.'),
      { status: 403 });
  }
  const ids = [...new Set((userIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger))];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM project_play_watchers WHERE handover_id = $1 AND org_id = $2`,
      [handoverId, orgId]);
    for (const uid of ids) {
      await client.query(
        `INSERT INTO project_play_watchers (org_id, handover_id, user_id, created_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT (handover_id, user_id) DO NOTHING`,
        [orgId, handoverId, uid, actorId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return listWatchers(handoverId, orgId);
}

/**
 * Seed a new project's watchers from the org default.
 *
 * Copied in rather than read through: a project that has been running for
 * three months should not have its alert list silently re-pointed because an
 * admin edited an org setting. Call from the project-creation path; safe to
 * call twice (it no-ops once watchers exist).
 */
async function seedWatchersFromOrgDefault(handoverId, orgId, actorId) {
  const existing = await listWatchers(handoverId, orgId);
  if (existing.length) return existing;

  const cfg = await projectSettings.get(orgId);
  const ids = Array.isArray(cfg.review_watcher_user_ids) ? cfg.review_watcher_user_ids : [];
  if (!ids.length) return [];

  for (const uid of ids) {
    await pool.query(
      `INSERT INTO project_play_watchers (org_id, handover_id, user_id, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (handover_id, user_id) DO NOTHING`,
      [orgId, handoverId, uid, actorId ?? null]).catch(() => {});
  }
  return listWatchers(handoverId, orgId);
}

module.exports = {
  transition,
  resolveActorRole,
  canEditPlay,
  canChangeDueDate,
  history,
  reviewQueue,
  myReviewQueue,
  dependentsInFlight,
  listWatchers,
  setWatchers,
  seedWatchersFromOrgDefault,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
};
