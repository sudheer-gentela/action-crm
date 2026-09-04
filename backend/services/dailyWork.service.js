// dailyWork.service.js
//
// Write path for daily work tracking, plus the one read the member surface
// needs. The reporting reads — the team log, the period roll-up, the account
// view — live in dailyWorkQuery.service.js so this file stays about
// invariants rather than about SQL shapes.
//
// Everything here runs through withOrgTransaction, which sets
// app.current_org_id. No table in this module has row-level security today.
// That is a live decision, not an oversight, and going through the org-scoped
// helper now means enabling it later is a no-op here instead of an audit of
// every query.
//
// ── The four rules this file exists to hold ──────────────────────────
//
// 1. SNAPSHOT, NEVER JOIN. department_team_id, activity_type_key, the anchor
//    pair and account_id are resolved once at write and copied onto the row.
//    Reads never re-derive them. Someone moving from Marketing to Delivery in
//    November must not rewrite what October says they did.
//
// 2. entry_date IS THE OWNER'S LOCAL DATE, resolved by dailyWorkDate and
//    never accepted from the client. A browser can be in any timezone, and a
//    posted date is a posted claim about which day the work counts for.
//
// 3. NEVER TRUNCATE A DESCRIPTION. Over 2000 characters the save is refused
//    with the overage named, and nothing is written. Silently shortening what
//    someone wrote about their own day is the one unrecoverable error here —
//    they cannot tell it happened.
//
// 4. STAGE LIVES IN DIFFERENT PLACES FOR THE TWO KINDS. For assigned work the
//    stage is a property of the item and completing it closes the item. For
//    recurring work the stage describes THAT DAY only; the item stays active
//    forever. Collapsing these is the mistake that makes "completion rate"
//    meaningless, because recurring work would complete every day.

const { withOrgTransaction } = require('../config/database');
const hierarchyService = require('./hierarchyService');
const dwDate = require('./dailyWorkDate');

// ── Why every date column is cast to text ────────────────────────────
//
// node-postgres parses a Postgres DATE into a JS Date at LOCAL midnight. On a
// server at UTC+5:30, entry_date 2026-08-28 becomes 2026-08-27T18:30:00Z, and
// anything that then calls toISOString() — including Express serialising the
// response to JSON — reports the day before. Every user east of UTC would see
// their own entries dated one day early.
//
// That is the exact failure this module exists to prevent, arriving through
// the driver rather than through the logic. A calendar date is a string here
// and stays a string all the way to the browser.
//
// Casting in SQL rather than registering a global pg type parser for OID 1082:
// that parser is process-wide and would change how every other module in the
// app reads dates.
//
// Enumerating the columns also stops RETURNING * from leaking whatever a
// future migration adds straight into the API response.

const ITEM_COLUMNS = `
  id, org_id, owner_user_id, kind, title, activity_type_key,
  anchor_kind, anchor_id, account_id, status, department_team_id,
  created_by, assigned_by, play_instance_id,
  target_date::text AS target_date,
  opened_on::text   AS opened_on,
  closed_at, created_at, updated_at`;

const ENTRY_COLUMNS = `
  id, org_id, item_id, user_id,
  entry_date::text AS entry_date,
  description, next_steps, day_stage, department_team_id, activity_type_key,
  anchor_kind, anchor_id, account_id, is_continuation,
  written_on::text AS written_on,
  created_at, updated_at, last_edited_by`;

const MAX_DESCRIPTION = 2000;
const MAX_NEXT_STEPS = 2000;

// One vocabulary, shared by daily_work_entries.day_stage and, for assigned
// work, daily_work_items.status. 2026_132 aligned these deliberately; do not
// reintroduce a translation layer.
const DAY_STAGES = ['yet_to_start', 'in_progress', 'in_review', 'completed', 'dropped'];
const CLOSING_STAGES = ['completed', 'dropped'];
const RECURRING_STATUSES = ['active', 'retired'];

class DailyWorkError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'DailyWorkError';
    this.code = code;
    this.details = details;
  }
}

/* ───────────────────────── snapshot resolution ─────────────────────── */

/**
 * Which account does this anchor belong to?
 *
 * Resolved ONCE, at write. See 2026_132 for why this is a stored column and
 * not a join: sales_handovers.account_id is mutable, so a join would move
 * closed history when a project is re-parented.
 *
 *   'account'  -> the anchor is the account
 *   'handover' -> the project's account, which may itself be null
 *   'campaign' -> null. Campaign work is internal by definition; there is no
 *                 account link in prospecting_campaigns to follow even if we
 *                 wanted one.
 *   null       -> null, meaning unattributed rather than internal. Those are
 *                 different states and the second one is worth seeing.
 */
async function resolveAccountId(client, orgId, anchorKind, anchorId) {
  if (!anchorKind || !anchorId) return null;

  if (anchorKind === 'account') {
    const { rows } = await client.query(
      `SELECT id FROM accounts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [anchorId, orgId]);
    return rows[0] ? rows[0].id : null;
  }

  if (anchorKind === 'handover') {
    const { rows } = await client.query(
      `SELECT account_id FROM sales_handovers WHERE id = $1 AND org_id = $2`,
      [anchorId, orgId]);
    return rows[0] ? rows[0].account_id : null;
  }

  return null;   // campaign, and anything added to the vocabulary later
}

/**
 * The person's department at the moment of writing.
 *
 * Departments are modelled as teams on an 'internal' dimension — 2026_131
 * chose that over a new table because the structure already existed. Note
 * teams.dimension holds team_dimensions.key, not its id; it is a string join,
 * which is easy to get subtly wrong.
 *
 * Returns null when someone has no primary team. That is a seeding gap, not an
 * error, and it must not block them logging their day.
 */
async function resolvePrimaryTeamId(client, orgId, userId) {
  const { rows } = await client.query(
    `SELECT tm.team_id
       FROM team_memberships tm
       JOIN teams t  ON t.id = tm.team_id AND t.org_id = tm.org_id
       JOIN team_dimensions td
              ON td.key = t.dimension
             AND td.org_id = t.org_id
             AND td.applies_to = 'internal'
      WHERE tm.org_id = $1
        AND tm.user_id = $2
        AND tm.is_primary = TRUE
        AND t.is_active = TRUE
      ORDER BY tm.id
      LIMIT 1`,
    [orgId, userId]);
  return rows[0] ? rows[0].team_id : null;
}

/** Membership is per organization: is_active lives on org_users, not users. */
async function assertActiveMember(client, orgId, userId) {
  const { rows } = await client.query(
    `SELECT 1 FROM org_users
      WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`,
    [orgId, userId]);
  if (!rows[0]) {
    throw new DailyWorkError('That person is not an active member of this organization',
      'INACTIVE_MEMBER', { userId });
  }
}

/* ───────────────────────── items ───────────────────────────────────── */

/**
 * Create a work item.
 *
 * kind 'recurring' — open-ended, opens as 'active'
 * kind 'assigned'  — finite, opens as 'yet_to_start', may carry an advisory
 *                    target_date and an assigner
 *
 * The design originally tied kind to who creates it: members make recurring
 * work, managers assign deliverables. The pilot walkthrough broke that — a
 * manager handing down standing ownership ("LinkedIn posts are yours now") is
 * recurring work created by a manager. So kind and creator are independent
 * here, which is what the schema always allowed.
 */
async function createItem(orgId, actorUserId, input) {
  const {
    ownerUserId = actorUserId,
    kind,
    title,
    activityTypeKey = null,
    anchorKind = null,
    anchorId = null,
    targetDate = null,
    assignedBy = null,
    // 2026_140. The day being logged, when this item is created during a
    // backfill. Clamped to today below — see the note at the INSERT.
    openedOn = null,
  } = input;

  if (!['recurring', 'assigned'].includes(kind)) {
    throw new DailyWorkError('kind must be recurring or assigned', 'BAD_KIND', { kind });
  }
  if (!title || !title.trim()) {
    throw new DailyWorkError('An item needs a title', 'BLANK_TITLE');
  }
  if (targetDate && kind !== 'assigned') {
    throw new DailyWorkError(
      'Only assigned work can carry a target date — recurring work never completes',
      'TARGET_ON_RECURRING');
  }

  return withOrgTransaction(orgId, async (client) => {
    await assertActiveMember(client, orgId, ownerUserId);

    const accountId = await resolveAccountId(client, orgId, anchorKind, anchorId);
    const teamId = await resolvePrimaryTeamId(client, orgId, ownerUserId);
    const status = kind === 'assigned' ? 'yet_to_start' : 'active';

    // ── opened_on (2026_140) ─────────────────────────────────────────────
    //
    // TWO BUGS FIXED HERE, and the second was blocking real work.
    //
    // 1. IT WAS THE DATABASE'S CURRENT_DATE, which is UTC. opened_on is a
    //    LOCAL date everywhere it is read — saveDay compares it against
    //    entryDate, which comes from the owner's own calendar — so a UTC
    //    default was comparing two different things. At UTC+5:30 the drift
    //    runs the harmless way, because UTC's date is behind and the check
    //    only gets more permissive. West of UTC it runs the other way, and
    //    somebody logging their own CURRENT day is refused for an item they
    //    created an hour ago. Resolved from the owner's timezone now.
    //
    // 2. AN ITEM CREATED DURING A BACKFILL OPENED TODAY, and then failed
    //    saveDay's "that item did not exist yet" check for the very day it
    //    was created to describe. Someone who forgot to log Tuesday, and on
    //    Thursday adds an item to record what they did, was refused — with a
    //    message that is accurate and describes a situation the product
    //    created. openedOn lets the caller say which day is being logged.
    //
    // LEAST, not a bare openedOn: an item may open in the PAST, never in the
    // future. Without the clamp, a future date would create an item that does
    // not exist yet — the inverse of the hole the saveDay check guards, opened
    // by the fix for it.
    const tz = await dwDate.resolveTimezone(
      (sql, params) => client.query(sql, params), orgId, ownerUserId);
    const localToday = dwDate.localDate(tz);
    const openedOnDate = openedOn && openedOn < localToday ? openedOn : localToday;

    const { rows } = await client.query(
      `INSERT INTO daily_work_items
         (org_id, owner_user_id, kind, title, activity_type_key,
          anchor_kind, anchor_id, account_id, status, department_team_id,
          created_by, assigned_by, target_date, opened_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${ITEM_COLUMNS}`,
      [orgId, ownerUserId, kind, title.trim(), activityTypeKey,
       anchorKind, anchorId, accountId, status, teamId,
       actorUserId, assignedBy, targetDate, openedOnDate]);

    return rows[0];
  });
}

/**
 * Assign work to someone.
 *
 * Deliberately not a separate table or a separate concept — an assignment IS
 * an item with assigned_by set. The manager chooses the kind: a finite
 * deliverable, or standing work they are handing over.
 */
async function assignItem(orgId, managerUserId, input) {
  return createItem(orgId, managerUserId, {
    ...input,
    assignedBy: managerUserId,
  });
}

/**
 * Change what an item IS — its activity type, or what it is anchored to.
 *
 * Entries already written are NOT touched. They hold their own snapshot of the
 * activity, anchor, account and department as those were on the day, which is
 * the point of snapshotting: correcting an item today must not rewrite what
 * last month says. New entries pick up the new values.
 *
 * Owner only. A manager who thinks an item is mis-categorised should say so
 * rather than silently reclassify someone else's work — and the candidate
 * queue already gives them the vocabulary decision, which is the part that
 * genuinely needs a manager.
 */
async function updateItem(orgId, userId, itemId, patch) {
  const { title, activityTypeKey, anchorKind, anchorId, targetDate, status } = patch;

  return withOrgTransaction(orgId, async (client) => {
    const { rows: found } = await client.query(
      `SELECT id, kind, owner_user_id, play_instance_id
         FROM daily_work_items WHERE id = $1 AND org_id = $2`,
      [itemId, orgId]);

    const item = found[0];
    if (!item) throw new DailyWorkError('No such work item', 'NO_SUCH_ITEM', { itemId });
    if (item.owner_user_id !== userId) {
      throw new DailyWorkError('That item belongs to someone else', 'NOT_YOUR_ITEM', { itemId });
    }

    // ── A TASK-LINKED ITEM IS NOT EDITABLE HERE (2026_136) ────────────
    //
    // Everything this function changes — the title, the anchor, the target
    // date, the status — is owned by the TASK on a linked item. Letting any
    // of them be edited from Daily Work gives the project record and the
    // person's log a second way to disagree, which is the whole thing one
    // shared row exists to prevent.
    //
    // Each is refused separately rather than with one blanket message,
    // because the right next action differs and this text is what the screen
    // shows. The controls are hidden in the UI too; this is the server
    // saying the same thing, because a hidden control is a hint and this
    // endpoint is reachable directly.
    if (item.play_instance_id) {
      if (title !== undefined) {
        throw new DailyWorkError(
          'This item takes its name from the project task. Rename the task instead.',
          'LINKED_ITEM_TITLE', { itemId });
      }
      if (anchorKind !== undefined || anchorId !== undefined) {
        throw new DailyWorkError(
          'This item is tied to a project task and cannot be moved to another initiative.',
          'LINKED_ITEM_ANCHOR', { itemId });
      }
      if (targetDate !== undefined) {
        throw new DailyWorkError(
          "The task's due date is the date for this work. Change it on the project.",
          'LINKED_ITEM_TARGET', { itemId });
      }
      if (status !== undefined) {
        // Including 'retired', which is what "Stop tracking this" would send.
        // Retiring the item directly would leave a live task whose next
        // update silently opened a second item for the same work.
        throw new DailyWorkError(
          'This item closes when its project task does. Complete, skip or cancel the task instead.',
          'LINKED_ITEM_STATUS', { itemId });
      }
    }
    if (targetDate && item.kind !== 'assigned') {
      throw new DailyWorkError(
        'Only assigned work can carry a target date — recurring work never completes',
        'TARGET_ON_RECURRING');
    }
    if (title !== undefined && !String(title).trim()) {
      throw new DailyWorkError('An item needs a title', 'BLANK_TITLE');
    }

    // Retiring is the ONLY status change allowed here, and only for recurring
    // work. Assigned items take their status from the day's stage, so letting
    // both paths write it would give two answers to one question.
    //
    // Retire rather than delete: the entries stay, the history stays readable,
    // and the item simply stops appearing on tomorrow's list. Deleting would
    // cascade away everything anyone ever logged against it.
    if (status !== undefined) {
      if (item.kind !== 'recurring') {
        throw new DailyWorkError(
          "An assigned item's status comes from the day's stage — mark it complete or dropped instead",
          'STATUS_ON_ASSIGNED', { itemId });
      }
      if (!RECURRING_STATUSES.includes(status)) {
        throw new DailyWorkError(
          `Recurring work is either ${RECURRING_STATUSES.join(' or ')}`,
          'BAD_STATUS', { status });
      }
    }

    // The anchor and the account move together or not at all. Re-resolving only
    // when the anchor is part of the patch stops an unrelated title edit from
    // quietly re-deriving an account that was corrected by hand.
    const changingAnchor = anchorKind !== undefined || anchorId !== undefined;
    const accountId = changingAnchor
      ? await resolveAccountId(client, orgId, anchorKind || null, anchorId || null)
      : null;

    const { rows } = await client.query(
      `UPDATE daily_work_items
          SET title             = COALESCE($3, title),
              activity_type_key = CASE WHEN $4::boolean THEN $5 ELSE activity_type_key END,
              anchor_kind       = CASE WHEN $6::boolean THEN $7 ELSE anchor_kind END,
              anchor_id         = CASE WHEN $6::boolean THEN $8 ELSE anchor_id END,
              account_id        = CASE WHEN $6::boolean THEN $9 ELSE account_id END,
              target_date       = CASE WHEN $10::boolean THEN $11 ELSE target_date END,
              status            = CASE WHEN $12::boolean THEN $13 ELSE status END,
              closed_at         = CASE WHEN $12::boolean AND $13 = 'retired' THEN now()
                                       WHEN $12::boolean THEN NULL
                                       ELSE closed_at END,
              updated_at        = now()
        WHERE id = $1 AND org_id = $2
        RETURNING ${ITEM_COLUMNS}`,
      [itemId, orgId,
       title === undefined ? null : String(title).trim(),
       activityTypeKey !== undefined, activityTypeKey || null,
       changingAnchor, anchorKind || null, anchorId || null, accountId,
       targetDate !== undefined, targetDate || null,
       status !== undefined, status || null]);

    return rows[0];
  });
}

/* ───────────────────────── the day's entries ───────────────────────── */

function validateEntry(entry, index) {
  const where = `row ${index + 1}`;

  if (!entry.itemId) {
    throw new DailyWorkError(`${where} has no item`, 'MISSING_ITEM');
  }
  const description = (entry.description || '');
  if (!description.trim()) {
    throw new DailyWorkError(
      `${where}: say what you did — this cannot be left empty`,
      'BLANK_DESCRIPTION', { itemId: entry.itemId });
  }
  if (description.length > MAX_DESCRIPTION) {
    // Named overage, and nothing is written. The person trims their own words;
    // we never choose which of them to discard.
    throw new DailyWorkError(
      `${where}: ${description.length - MAX_DESCRIPTION} characters too long — trim it, nothing is cut for you`,
      'DESCRIPTION_TOO_LONG',
      { itemId: entry.itemId, length: description.length, limit: MAX_DESCRIPTION });
  }
  if ((entry.nextSteps || '').length > MAX_NEXT_STEPS) {
    throw new DailyWorkError(
      `${where}: next steps is ${entry.nextSteps.length - MAX_NEXT_STEPS} characters too long`,
      'NEXT_STEPS_TOO_LONG', { itemId: entry.itemId });
  }
  if (!DAY_STAGES.includes(entry.dayStage)) {
    throw new DailyWorkError(
      `${where}: ${entry.dayStage} is not a stage`,
      'BAD_STAGE', { itemId: entry.itemId, dayStage: entry.dayStage });
  }
}

/**
 * Save a whole day in one call.
 *
 * One save for the day, not one per row — that was the finding from watching
 * how the spreadsheet was actually used. Which means validation is all-or-
 * nothing: if the fourth row is too long, the first three are not written
 * either. Partial saves would leave someone believing they had logged a day
 * they had not.
 *
 * entry_date is resolved from the OWNER's timezone, never posted. `asOf` exists
 * so the reminder and tests can pin the instant; it is not a client input.
 */
/**
 * How many days back a person may write. Five working-ish days, so Friday's
 * work is still writable the following Wednesday, and a Monday-morning writeup
 * of the previous week is not a special case.
 *
 * A CONSTANT, not a per-org setting, until someone asks for one. The value is
 * policy and lives here rather than in a CHECK constraint precisely so it can
 * become a setting without a migration.
 */
const BACKFILL_DAYS = 5;

/**
 * saveDay's body, on a caller-supplied client.
 *
 * SPLIT OUT FOR ONE REASON (2026_136): posting an update from a project task
 * has to find-or-create the item and write the entry in the SAME transaction.
 * Two transactions would leave an empty item behind whenever the entry was
 * then refused — a row on someone's My day for work they were told was not
 * saved.
 *
 * So there is one body and two entry points into it, and neither is the
 * "real" one. Everything that makes an entry trustworthy — the backfill
 * window, the blank check, written_on, the ownership check, the snapshot —
 * lives here and therefore cannot differ between the two screens. A second
 * copy of this upsert is exactly how the project's record and the person's
 * log would come apart.
 */
async function _saveDayIn(client, orgId, userId, entries, { asOf = new Date(), date = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new DailyWorkError('Nothing to save', 'EMPTY_SAVE');
  }
  entries.forEach(validateEntry);

  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.itemId)) {
      throw new DailyWorkError(
        'The same item appears twice in one day',
        'DUPLICATE_ITEM', { itemId: e.itemId });
    }
    seen.add(e.itemId);
  }

  {
    await assertActiveMember(client, orgId, userId);

    const tz = await dwDate.resolveTimezone(
      (sql, params) => client.query(sql, params), orgId, userId);
    const today = dwDate.localDate(tz, asOf);

    // The requested date, checked against the window. `today` is still resolved
    // server-side from the owner's timezone — the client proposes a date, it
    // does not get to decide what "today" is, so it cannot widen its own window
    // by lying about the clock.
    let entryDate = today;
    if (date != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new DailyWorkError('Date must be YYYY-MM-DD', 'BAD_DATE', { date });
      }
      if (date > today) {
        // Structurally impossible to store anyway (2026_135's CHECK), but
        // caught here so the person gets a sentence rather than a constraint
        // violation.
        throw new DailyWorkError('You cannot log work for a future day',
          'FUTURE_DATE', { date });
      }
      const earliest = dwDate.addDays(today, -BACKFILL_DAYS);
      if (date < earliest) {
        throw new DailyWorkError(
          `You can only log work for the last ${BACKFILL_DAYS} days. ${date} is further back than that.`,
          'OUTSIDE_BACKFILL_WINDOW', { date, earliest });
      }
      entryDate = date;
    }

    const teamId = await resolvePrimaryTeamId(client, orgId, userId);
    const saved = [];

    for (const entry of entries) {
      const { rows: itemRows } = await client.query(
        `SELECT id, kind, status, owner_user_id, activity_type_key,
                anchor_kind, anchor_id, account_id, play_instance_id,
                opened_on::text AS opened_on
           FROM daily_work_items
          WHERE id = $1 AND org_id = $2`,
        [entry.itemId, orgId]);

      const item = itemRows[0];
      if (!item) {
        throw new DailyWorkError('That work item does not exist',
          'NO_SUCH_ITEM', { itemId: entry.itemId });
      }
      if (item.owner_user_id !== userId) {
        // Logging someone else's day is not a feature. A manager who wants
        // work recorded assigns an item; the owner writes the entry.
        throw new DailyWorkError('That item belongs to someone else',
          'NOT_YOUR_ITEM', { itemId: entry.itemId });
      }

      // ── STATUS IS ALWAYS AN EXPLICIT ACT (2026_136) ─────────────────
      //
      // On a task-linked item the day's stage may say the work is under way
      // or gone for review, but never that it is finished. Rule 4 below
      // writes an assigned item's status straight from this stage, and
      // CLOSING_STAGES would close the item while the task it tracks is
      // still open — leaving a live task whose next update has nowhere to
      // go, because uq_dwi_owner_play forbids a second item.
      //
      // Refusing here rather than quietly downgrading the stage: a progress
      // note must not be able to smuggle a task to done, and someone who
      // meant to finish the task should be sent to the control that actually
      // does it, with whatever gating, review and evidence that project
      // requires still in front of them.
      if (item.play_instance_id && CLOSING_STAGES.includes(entry.dayStage)) {
        throw new DailyWorkError(
          'This tracks a project task, so finishing it happens on the project — '
          + 'use Mark done or Send for review there. Log progress here as far as '
          + '"Sent for review".',
          'LINKED_STAGE_NOT_CLOSABLE',
          { itemId: entry.itemId, dayStage: entry.dayStage,
            playInstanceId: item.play_instance_id });
      }

      // An entry cannot predate its item. Without this, backfilling five days
      // lets someone log work against an item created this morning onto a day
      // when it did not exist — which reads, later, as a record that was always
      // there. opened_on is the item's own local-date field, so this compares
      // like with like.
      if (item.opened_on && entryDate < item.opened_on) {
        throw new DailyWorkError(
          'That item did not exist yet on the day you are logging',
          'ITEM_NOT_OPEN_YET', { itemId: entry.itemId, entryDate, openedOn: item.opened_on });
      }

      // Carried over, rather than started today. Cheap to compute here and
      // impossible to reconstruct later once the days blur together.
      const { rows: priorRows } = await client.query(
        `SELECT 1 FROM daily_work_entries
          WHERE org_id = $1 AND item_id = $2 AND entry_date < $3 LIMIT 1`,
        [orgId, entry.itemId, entryDate]);
      const isContinuation = priorRows.length > 0;

      // The snapshot. Taken from the item, so an entry always agrees with the
      // item as it was on the day it was written.
      const { rows: entryRows } = await client.query(
        `INSERT INTO daily_work_entries
           (org_id, item_id, user_id, entry_date, description, next_steps,
            day_stage, department_team_id, activity_type_key,
            anchor_kind, anchor_id, account_id, is_continuation, last_edited_by,
            written_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$3,$14)
         ON CONFLICT (org_id, item_id, entry_date) DO UPDATE
            SET description    = EXCLUDED.description,
                next_steps     = EXCLUDED.next_steps,
                day_stage      = EXCLUDED.day_stage,
                last_edited_by = EXCLUDED.last_edited_by,
                updated_at     = now()
         RETURNING ${ENTRY_COLUMNS}`,
        [orgId, entry.itemId, userId, entryDate,
         entry.description.trim(), entry.nextSteps || null, entry.dayStage,
         teamId, item.activity_type_key,
         item.anchor_kind, item.anchor_id, item.account_id, isContinuation,
         // Deliberately absent from the DO UPDATE list. written_on records when
         // the day was first written up; re-saving today to fix a typo is an
         // edit, not a second writing, and updated_at/last_edited_by already
         // carry that. Letting it move would turn "written late" into "last
         // touched late" and quietly erase the distinction the column exists for.
         today]);

      // Rule 4. The stage means different things for the two kinds.
      if (item.kind === 'assigned') {
        const closing = CLOSING_STAGES.includes(entry.dayStage);
        await client.query(
          `UPDATE daily_work_items
              SET status = $1,
                  closed_at = CASE WHEN $2 THEN now() ELSE NULL END,
                  updated_at = now()
            WHERE id = $3 AND org_id = $4`,
          [entry.dayStage, closing, item.id, orgId]);
      }
      // Recurring items are untouched. "Complete" on a recurring row means the
      // work is done for TODAY. The item returns tomorrow, which is the whole
      // point of it being recurring.

      saved.push(entryRows[0]);
    }

    return { entryDate, timezone: tz, entries: saved };
  }
}

/**
 * Save a whole day in one call — the My day entry point.
 *
 * Opens the transaction and hands straight to _saveDayIn. Nothing else lives
 * here on purpose: any rule added to this function rather than to the body
 * would apply to one of the two screens and not the other.
 */
async function saveDay(orgId, userId, entries, opts = {}) {
  return withOrgTransaction(orgId, (client) =>
    _saveDayIn(client, orgId, userId, entries, opts));
}

/* ───────────────────────── task-linked work (2026_136) ─────────────── */

/**
 * The stages a task-linked item may be logged at.
 *
 * DAY_STAGES minus CLOSING_STAGES. Exported so the composer offers exactly
 * what _saveDayIn will accept, rather than offering five and refusing two.
 */
const LINKED_DAY_STAGES = DAY_STAGES.filter(s => !CLOSING_STAGES.includes(s));

/**
 * Resolve a project task to the facts needed to log against it.
 *
 * SELECT ONLY, and deliberately not an authorisation check — the route asks
 * handover.service.getNoteVisibility for that, so "who may write against this
 * task" has one answer shared with notes rather than a second rule here that
 * drifts from it.
 *
 * The three refusals below are about the WORK, not the person:
 *
 *   - a closed task has nothing left to log against, and its items are
 *     already closed by trg_close_daily_work_items_for_play
 *   - a completed, cancelled or retired project is excluded from
 *     getPersonProjectItems and from the anchor picker, so accepting an
 *     update here would create an item nothing else will ever show
 *
 * Retirement is a timestamp rather than a status (2026_133), so it needs its
 * own predicate — `status NOT IN (...)` cannot see it.
 */
async function getTaskForUpdate(orgId, playInstanceId, client = null) {
  const run = client
    ? (sql, params) => client.query(sql, params)
    : (sql, params) => withOrgTransaction(orgId, c => c.query(sql, params));

  const { rows } = await run(
    `SELECT p.id, p.title, p.status, p.due_date::text AS due_date,
            p.owner_user_id, p.handover_id,
            h.name AS project_name, h.status AS project_status,
            h.retired_at, COALESCE(h.tracking_mode, 'timeboxed') AS tracking_mode
       FROM project_play_instances p
       JOIN sales_handovers h ON h.id = p.handover_id AND h.org_id = p.org_id
      WHERE p.id = $1 AND p.org_id = $2`,
    [playInstanceId, orgId]);

  const task = rows[0];
  if (!task) {
    throw new DailyWorkError('No such task', 'NO_SUCH_TASK', { playInstanceId });
  }
  if (['completed', 'skipped', 'cancelled'].includes(task.status)) {
    throw new DailyWorkError(
      'That task is closed. Reopen it on the project if there is more to do.',
      'TASK_CLOSED', { playInstanceId, status: task.status });
  }
  if (['completed', 'cancelled'].includes(task.project_status) || task.retired_at) {
    throw new DailyWorkError(
      'That project is closed, so there is nowhere for this work to be counted.',
      'PROJECT_CLOSED', { playInstanceId, handoverId: task.handover_id });
  }
  return task;
}

/**
 * Post one person's update against one project task.
 *
 * ── FIND-OR-CREATE, THEN THE ORDINARY SAVE ───────────────────────────
 *
 * One item per (person, task), created by the first post and never by
 * anything else — uq_dwi_owner_play makes a second impossible, so this is a
 * real invariant rather than a convention.
 *
 * Both halves are in ONE transaction. Split across two, a refused entry would
 * leave an item behind with nothing logged against it: a row on the person's
 * My day for work they were just told was not saved.
 *
 * ── WHY opened_on IS THE ENTRY DATE, NOT TODAY ───────────────────────
 *
 * _saveDayIn refuses an entry that predates its item (ITEM_NOT_OPEN_YET), and
 * that rule is right for ordinary items: backfilling onto a day before the
 * item existed would read later as a record that was always there.
 *
 * A linked item is different. It is an artefact of the first POST, not of
 * when the work began — the task itself existed all along. Left at the
 * CURRENT_DATE default, the very first update on a task could never be
 * backfilled: writing up Monday's work on Wednesday would create the item on
 * Wednesday and then refuse Monday, which is exactly the Monday-morning
 * writeup the five-day window exists for.
 *
 * So the item opens on the day being logged, and an existing item's
 * opened_on is lowered when someone backfills further than they have before.
 * It never moves forward — an item that has held Monday keeps holding it.
 */
async function postTaskUpdate(orgId, userId, input = {}) {
  const {
    playInstanceId,
    description,
    nextSteps = null,
    dayStage,
    date = null,
    asOf = new Date(),
  } = input;

  if (!playInstanceId) {
    throw new DailyWorkError('Which task?', 'MISSING_TASK');
  }
  // Checked before the transaction as well as inside _saveDayIn, so the
  // composer gets the specific sentence rather than a generic bad-stage one.
  if (!LINKED_DAY_STAGES.includes(dayStage)) {
    throw new DailyWorkError(
      `A project task can be logged as ${LINKED_DAY_STAGES.join(', ')} — `
      + 'finishing it happens on the project.',
      'BAD_LINKED_STAGE', { dayStage });
  }

  return withOrgTransaction(orgId, async (client) => {
    await assertActiveMember(client, orgId, userId);

    const task = await getTaskForUpdate(orgId, playInstanceId, client);

    // The same resolution _saveDayIn will do. Done here too because the item's
    // opened_on has to be settled before the entry is written, and the window
    // check has to refuse a bad date before anything is created.
    const tz = await dwDate.resolveTimezone(
      (sql, params) => client.query(sql, params), orgId, userId);
    const today = dwDate.localDate(tz, asOf);
    let entryDate = today;
    if (date != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new DailyWorkError('Date must be YYYY-MM-DD', 'BAD_DATE', { date });
      }
      if (date > today) {
        throw new DailyWorkError('You cannot log work for a future day',
          'FUTURE_DATE', { date });
      }
      const earliest = dwDate.addDays(today, -BACKFILL_DAYS);
      if (date < earliest) {
        throw new DailyWorkError(
          `You can only log work for the last ${BACKFILL_DAYS} days. ${date} is further back than that.`,
          'OUTSIDE_BACKFILL_WINDOW', { date, earliest });
      }
      entryDate = date;
    }

    const { rows: existing } = await client.query(
      `SELECT ${ITEM_COLUMNS} FROM daily_work_items
        WHERE org_id = $1 AND owner_user_id = $2 AND play_instance_id = $3`,
      [orgId, userId, playInstanceId]);

    let item = existing[0];
    let created = false;

    if (!item) {
      // anchor = the PROJECT, not the task. anchor_kind stays 'handover' and
      // its CHECK is untouched, so "daily work is not anchored to a task"
      // holds literally and the anchor picker is unchanged. The task link is
      // the separate column.
      const accountId = await resolveAccountId(client, orgId, 'handover', task.handover_id);
      const teamId = await resolvePrimaryTeamId(client, orgId, userId);

      const { rows } = await client.query(
        `INSERT INTO daily_work_items
           (org_id, owner_user_id, kind, title, anchor_kind, anchor_id, account_id,
            status, department_team_id, created_by, play_instance_id, opened_on)
         VALUES ($1,$2,'assigned',$3,'handover',$4,$5,
                 'yet_to_start',$6,$2,$7,$8)
         RETURNING ${ITEM_COLUMNS}`,
        [orgId, userId, task.title, task.handover_id, accountId,
         teamId, playInstanceId, entryDate]);
      item = rows[0];
      created = true;
    } else if (item.opened_on && entryDate < item.opened_on) {
      const { rows } = await client.query(
        `UPDATE daily_work_items SET opened_on = $3, updated_at = now()
          WHERE id = $1 AND org_id = $2
          RETURNING ${ITEM_COLUMNS}`,
        [item.id, orgId, entryDate]);
      item = rows[0];
    }

    const saved = await _saveDayIn(client, orgId, userId,
      [{ itemId: item.id, description, nextSteps, dayStage }],
      { asOf, date: entryDate });

    return {
      entryDate: saved.entryDate,
      timezone: saved.timezone,
      itemCreated: created,
      item,
      entry: saved.entries[0],
    };
  });
}

/**
 * Everything the composer needs for one task, on either screen.
 *
 * ── WHO SEES WHAT ────────────────────────────────────────────────────
 *
 * `feed` carries EVERY person's updates on this ONE task, not just the
 * viewer's. That is a deliberate widening of daily work's normal rule, where
 * a description is visible to the owner and their manager chain
 * (canSeeEntry), and it is scoped as narrowly as the purpose allows: one
 * task, to people who can already read and write notes on that same task.
 *
 * The reason is the goal of the whole feature. Two people working a task each
 * write what they did, and the project is supposed to show that the task
 * moved. A feed that showed each person only their own half would leave the
 * task looking untouched to everyone except the last person to type — and
 * plan vs actual already reports days logged across every person, so the fact
 * that colleagues are logging is not private either way.
 *
 * If that trade is wrong for an org it is one predicate, here, and nothing
 * else in the module depends on it.
 */
async function getTaskWork(orgId, userId, playInstanceId, { asOf = new Date() } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT p.id, p.title, p.status, p.due_date::text AS due_date,
              p.owner_user_id, p.handover_id,
              h.name AS project_name, h.status AS project_status,
              h.retired_at, COALESCE(h.tracking_mode, 'timeboxed') AS tracking_mode
         FROM project_play_instances p
         JOIN sales_handovers h ON h.id = p.handover_id AND h.org_id = p.org_id
        WHERE p.id = $1 AND p.org_id = $2`,
      [playInstanceId, orgId]);

    const task = rows[0];
    if (!task) {
      throw new DailyWorkError('No such task', 'NO_SUCH_TASK', { playInstanceId });
    }

    // Read, unlike postTaskUpdate, does NOT refuse a closed task or project.
    // Someone reviewing what happened on a finished piece of work is the case
    // this most needs to answer; `canPost` below is what the composer keys on.
    const closed = ['completed', 'skipped', 'cancelled'].includes(task.status)
      || ['completed', 'cancelled'].includes(task.project_status)
      || task.retired_at != null;

    const { rows: feed } = await client.query(
      `SELECT e.id AS entry_id, e.item_id, e.user_id,
              e.entry_date::text AS entry_date,
              e.description, e.next_steps, e.day_stage,
              e.written_on::text AS written_on,
              e.created_at, e.updated_at,
              (e.updated_at > e.created_at) AS edited,
              u.first_name, u.last_name
         FROM daily_work_entries e
         JOIN daily_work_items i ON i.id = e.item_id AND i.org_id = e.org_id
         LEFT JOIN users u ON u.id = e.user_id
        WHERE i.org_id = $1 AND i.play_instance_id = $2
        ORDER BY e.entry_date DESC, e.updated_at DESC`,
      [orgId, playInstanceId]);

    const { rows: mine } = await client.query(
      `SELECT ${ITEM_COLUMNS} FROM daily_work_items
        WHERE org_id = $1 AND owner_user_id = $2 AND play_instance_id = $3`,
      [orgId, userId, playInstanceId]);

    const tz = await dwDate.resolveTimezone(
      (sql, params) => client.query(sql, params), orgId, userId);
    const today = dwDate.localDate(tz, asOf);

    return {
      task: {
        playInstanceId: task.id,
        handoverId:     task.handover_id,
        title:          task.title,
        status:         task.status,
        dueDate:        task.due_date,
        ownerUserId:    task.owner_user_id,
        project:        task.project_name,
        projectStatus:  task.project_status,
        isStanding:     task.tracking_mode === 'standing',
        isRetired:      task.retired_at != null,
      },
      // Whether the WORK can still be logged. The route ANDs this with the
      // viewer's permission before the composer is offered.
      canPost: !closed,
      // So the composer can find its own row in the feed to prefill from, and
      // label the rest by name. Derived here rather than left to the client to
      // infer from `item`, which is null until the first post.
      viewerUserId: userId,
      item: mine[0] || null,
      feed,
      today,
      timezone: tz,
      earliest: dwDate.addDays(today, -BACKFILL_DAYS),
      stages: LINKED_DAY_STAGES,
    };
  });
}

/* ───────────────────────── the member's day ────────────────────────── */

/**
 * Everything the member surface needs for one day: the open items, whatever
 * has been logged against them, and the previous entry for each so the row can
 * offer "start from this".
 *
 * Open items are ordered by creation, not by entry — an item keeps the same
 * slot every day, so the list does not reshuffle underneath someone who is
 * halfway through typing.
 */
async function getDay(orgId, userId, { date = null, asOf = new Date() } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const tz = await dwDate.resolveTimezone(
      (sql, params) => client.query(sql, params), orgId, userId);
    // Both, always. entryDate is the day being shown; today is what the server
    // considers today in the owner's timezone, and the client needs it to know
    // whether it is looking at the past and how far back it may still go. A
    // browser computing today itself would disagree the moment its clock or
    // timezone differed from the one the save will use.
    const today = dwDate.localDate(tz, asOf);
    const entryDate = date || today;

    const { rows } = await client.query(
      `SELECT i.id                AS item_id,
              i.kind, i.title, i.status, i.activity_type_key,
              i.anchor_kind, i.anchor_id, i.account_id,
              -- 2026_136. The client needs to know which rows are owned by a
              -- project task: those lose inline rename, the initiative picker
              -- and the closing stages, because the task owns all three. A row
              -- that offered controls the server then refuses would be a worse
              -- surprise than one that never offered them.
              i.play_instance_id,
              i.target_date::text  AS target_date,
              i.assigned_by, i.created_at,
              a.name              AS account_name,
              e.id                AS entry_id,
              e.description, e.next_steps, e.day_stage, e.is_continuation,
              prior.entry_date::text AS prior_date,
              prior.description   AS prior_description,
              (SELECT count(*)::int FROM play_evidence pe
                WHERE pe.daily_work_entry_id = e.id) AS evidence_count,
              -- The anchor as a WORD. The row already carried anchor_kind and
              -- anchor_id, which is what gets stored, and the day log rendered
              -- "—" for every item because a key is not a name and the client
              -- had nothing to resolve it against — DailyWorkView fetches the
              -- anchor list only in edit mode.
              --
              -- Read live rather than snapshotted, matching getDayDetail: a
              -- renamed initiative reads under its current name, which is the
              -- rule the anchor picker already follows.
              CASE i.anchor_kind
                WHEN 'handover' THEN h.name
                WHEN 'account'  THEN aa.name
                WHEN 'campaign' THEN pc.name
              END AS anchor_label
         FROM daily_work_items i
         LEFT JOIN accounts a
                ON a.id = i.account_id AND a.org_id = i.org_id
         -- Each guarded by anchor_kind as well as the id, so an id that happens
         -- to exist in another table cannot supply a name for the wrong kind of
         -- anchor.
         LEFT JOIN sales_handovers h
                ON i.anchor_kind = 'handover' AND h.id = i.anchor_id AND h.org_id = i.org_id
         LEFT JOIN accounts aa
                ON i.anchor_kind = 'account'  AND aa.id = i.anchor_id AND aa.org_id = i.org_id
         LEFT JOIN prospecting_campaigns pc
                ON i.anchor_kind = 'campaign' AND pc.id = i.anchor_id AND pc.org_id = i.org_id
         LEFT JOIN daily_work_entries e
                ON e.item_id = i.id AND e.org_id = i.org_id AND e.entry_date = $3
         LEFT JOIN LATERAL (
                SELECT p.entry_date, p.description
                  FROM daily_work_entries p
                 WHERE p.item_id = i.id AND p.org_id = i.org_id AND p.entry_date < $3
                 ORDER BY p.entry_date DESC
                 LIMIT 1
              ) prior ON TRUE
        WHERE i.org_id = $1
          AND i.owner_user_id = $2
          AND (i.status NOT IN ('completed','dropped','retired') OR e.id IS NOT NULL)
        ORDER BY i.created_at, i.id`,
      [orgId, userId, entryDate]);

    return { entryDate, today, timezone: tz, rows };
  });
}

/**
 * What a person may anchor work to.
 *
 * SELECT ONLY. The daily work surface never creates a project, an account or a
 * campaign — an admin or project manager sets those up, and the ten choose
 * from them. Ten people free-typing project names produces "PowerBI",
 * "Power BI" and "PowerBi" as three separate projects inside a fortnight, and
 * no amount of reporting recovers from that.
 *
 * Five kinds come back, and the difference between customer and internal
 * projects is the whole basis of the account view:
 *
 *   standing         — a standing initiative (2026_133). Grouped by TRACKING
 *                      MODE ahead of project_kind, because "the recurring
 *                      things I log against" is one bucket to the person
 *                      picking, whether or not it happens to have an account.
 *                      Before this, initiatives were scattered through the two
 *                      project groups and there was nowhere to look for them.
 *   customer project — a time-boxed handover with an account. Work here is
 *                      attributed.
 *   internal project — project_kind 'internal'. The schema GUARANTEES no
 *                      account (sales_handovers_kind_shape_chk), so this is
 *                      the Internal Projects bucket exactly, not a heuristic.
 *   account          — anchoring straight at a customer with no project.
 *   campaign         — internal by nature; prospecting_campaigns has no
 *                      account link to follow.
 *
 * Cancelled and completed projects are excluded: you should not be able to
 * start logging against something that finished. Work already anchored to them
 * keeps its anchor, because the entry holds a snapshot.
 *
 * RETIRED INITIATIVES ARE EXCLUDED TOO, and the predicate is separate from the
 * status one on purpose. Retirement (2026_133) is a TIMESTAMP, not a seventh
 * status value — see that migration's header for why — so `status NOT IN (...)`
 * cannot see it. This query predates retirement and had no idea it existed,
 * which meant a retired initiative stayed in this picker and people could keep
 * filing new work against it. That is precisely what retirement exists to stop.
 *
 * Work already anchored to a retired initiative is untouched, for the same
 * reason as a completed project: the entry holds a snapshot, and retire never
 * deletes.
 */
async function getAnchorOptions(orgId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT 'handover'::text AS anchor_kind, h.id AS anchor_id, h.name AS label,
              CASE WHEN COALESCE(h.tracking_mode, 'timeboxed') = 'standing' THEN 'standing'
                   WHEN h.project_kind = 'internal' THEN 'internal_project'
                   ELSE 'customer_project' END AS group_key,
              h.account_id, a.name AS account_name
         FROM sales_handovers h
         LEFT JOIN accounts a ON a.id = h.account_id AND a.org_id = h.org_id
        WHERE h.org_id = $1
          AND h.status NOT IN ('cancelled','completed')
          AND h.retired_at IS NULL
          AND h.name IS NOT NULL

        UNION ALL

       SELECT 'account'::text, a.id, a.name, 'account'::text, a.id, a.name
         FROM accounts a
        WHERE a.org_id = $1 AND a.deleted_at IS NULL

        UNION ALL

       SELECT 'campaign'::text, c.id, c.name, 'campaign'::text, NULL::integer, NULL::varchar
         FROM prospecting_campaigns c
        WHERE c.org_id = $1 AND c.status = 'active'

        ORDER BY group_key, label`,
      [orgId]);

    return rows;
  });
}

/* ───────────────────────── activity vocabulary ─────────────────────── */

/**
 * The shared list, for every picker in the module.
 *
 * Merged types are excluded: they are history, not choices. Candidates ARE
 * included by default and flagged, because the person who proposed one needs to
 * keep using it while it waits for a decision — a proposal that stops working
 * until a manager looks at it is a proposal nobody makes twice.
 *
 * Sorted by sort_order then label so the seeded list keeps the order it was
 * seeded in and anything added later lands alphabetically after it.
 */
/**
 * Derive the stable key for an activity label.
 *
 * ONE definition, used by both the member's "Other" path and the manager's
 * add-to-list path. It was inline in propose before there was a second
 * caller; two copies of this would mean 'LinkedIn Posts' and 'linkedin posts'
 * could land on different keys depending on which screen typed them, which is
 * exactly the vocabulary drift the shared list exists to prevent.
 */
function activityKey(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

async function listActivityTypes(orgId, { includeCandidates = true,
                                          includeRetired = false } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    // 'merged' is never returned: a merged type has been folded into another
    // and offering it would let someone file against a key that redirects.
    // 'retired' IS returned on request, because the management screen has to
    // show what it retired in order to bring it back, and because label
    // lookup for historical entries needs it — the rollup groups on the raw
    // key and has no join, so if a retired key cannot be resolved to a label
    // it becomes an unlabelled bucket nobody can explain.
    const statuses = ['active'];
    if (includeCandidates) statuses.push('candidate');
    if (includeRetired) statuses.push('retired');

    const { rows } = await client.query(
      `SELECT key, label, status, is_system, sort_order
         FROM daily_activity_types
        WHERE org_id = $1
          AND status = ANY($2)
        ORDER BY sort_order, label`,
      [orgId, statuses]);
    return rows;
  });
}

/**
 * A manager or admin adds a type straight to the shared list.
 *
 * Distinct from proposeActivityType, which exists for MEMBERS and always
 * produces a candidate. The difference is not the caller's convenience, it is
 * who is allowed to shape the org's vocabulary: a member proposing gets a
 * usable key immediately and a manager decides later, while a manager adding
 * one has already made that decision. Routing an admin through
 * propose-then-promote would work but would put a candidate in the review
 * queue that the reviewer themselves just created.
 *
 * Reuses the same key derivation as propose, so 'LinkedIn Posts' typed here
 * and 'linkedin posts' proposed by a member land on the SAME key and collide
 * loudly rather than becoming two types that differ only in case.
 */
async function createActivityType(orgId, userId, label) {
  const clean = String(label || '').trim();
  if (!clean) throw new DailyWorkError('Give the activity a name', 'NO_LABEL');
  const key = activityKey(clean);

  return withOrgTransaction(orgId, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT key, label, status, merged_into_key FROM daily_activity_types
        WHERE org_id = $1 AND key = $2`, [orgId, key]);

    if (existing[0]) {
      const e = existing[0];
      // Every pre-existing state gets its own answer rather than one generic
      // "already exists", because the right next action differs in each case
      // and the screen shows this text.
      if (e.status === 'active') {
        throw new DailyWorkError(`"${e.label}" is already on the list`,
          'ALREADY_ACTIVE', { key });
      }
      if (e.status === 'candidate') {
        // Adding a name someone already proposed IS accepting it.
        const { rows } = await client.query(
          `UPDATE daily_activity_types SET status = 'active', updated_at = now()
            WHERE org_id = $1 AND key = $2 RETURNING key, label, status`,
          [orgId, key]);
        return { ...rows[0], promotedExisting: true };
      }
      if (e.status === 'retired') {
        const { rows } = await client.query(
          `UPDATE daily_activity_types SET status = 'active', label = $3, updated_at = now()
            WHERE org_id = $1 AND key = $2 RETURNING key, label, status`,
          [orgId, key, clean]);
        return { ...rows[0], reactivatedExisting: true };
      }
      throw new DailyWorkError(
        `"${clean}" was merged into "${e.merged_into_key}" — use that instead`,
        'ALREADY_MERGED', { key, mergedInto: e.merged_into_key });
    }

    const { rows } = await client.query(
      `INSERT INTO daily_activity_types (org_id, key, label, is_system, status, created_by)
       VALUES ($1,$2,$3,FALSE,'active',$4)
       RETURNING key, label, status`,
      [orgId, key, clean, userId]);
    return rows[0];
  });
}

/**
 * Change what a type is CALLED. The key never moves.
 *
 * That separation is the whole point: entries store the key, so renaming is
 * free and retroactive — every historical entry picks up the new wording. If
 * the key moved, renaming would orphan every entry written before it.
 *
 * The consequence to be aware of: a type keyed 'linkedin_posts' can end up
 * labelled "Instagram posts". Odd to read in the database, correct for the
 * user, and the alternative (rewriting keys across every entry) is far worse.
 */
async function renameActivityType(orgId, key, label) {
  const clean = String(label || '').trim();
  if (!clean) throw new DailyWorkError('Give the activity a name', 'NO_LABEL');

  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `UPDATE daily_activity_types SET label = $3, updated_at = now()
        WHERE org_id = $1 AND key = $2 AND status <> 'merged'
        RETURNING key, label, status`,
      [orgId, key, clean]);
    if (!rows[0]) {
      throw new DailyWorkError('No such activity type, or it has been merged away',
        'NO_SUCH_TYPE', { key });
    }
    return rows[0];
  });
}

/**
 * Take a type out of circulation, or put it back.
 *
 * Retire, never delete — daily_work_entries.activity_type_key has no foreign
 * key, so deleting would leave historical entries pointing at nothing and the
 * manager rollup would group them into an unlabelled bucket rather than fail
 * visibly. See 2026_134.
 *
 * Existing ITEMS keep the retired key too. They are not rewritten: an item is
 * someone's ongoing work, and silently changing what it is classified as
 * because an admin tidied the list would be a worse surprise than a stale
 * label. It stops being offered for anything NEW, which is what retiring means.
 */
async function setActivityTypeRetired(orgId, key, retired) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows: current } = await client.query(
      `SELECT status FROM daily_activity_types WHERE org_id = $1 AND key = $2`,
      [orgId, key]);
    if (!current[0]) {
      throw new DailyWorkError('No such activity type', 'NO_SUCH_TYPE', { key });
    }
    // A merged type is already out of circulation and points somewhere else.
    // Retiring it would say nothing; un-retiring it would resurrect a type
    // whose entries now belong to its merge target.
    if (current[0].status === 'merged') {
      throw new DailyWorkError('That type was merged into another one',
        'IS_MERGED', { key });
    }

    const next = retired ? 'retired' : 'active';
    const { rows } = await client.query(
      `UPDATE daily_activity_types SET status = $3, updated_at = now()
        WHERE org_id = $1 AND key = $2
        RETURNING key, label, status`,
      [orgId, key, next]);
    return rows[0];
  });
}

/**
 * A member picked "Other" and named it.
 *
 * The named thing becomes a CANDIDATE type immediately, so their entry has a
 * real key from the moment it is written rather than free text that has to be
 * reconciled later. The manager decides afterwards whether it joins the shared
 * list or folds into something that already exists.
 *
 * Members never get write access to the shared vocabulary — that is the whole
 * point of the candidate status. What they get is an escape hatch that does
 * not require waiting for anyone.
 *
 * A label that already exists returns the existing key rather than creating a
 * near-duplicate. Two people naming the same thing on the same day is the
 * common case, not an edge case.
 */
async function proposeActivityType(orgId, userId, label) {
  const clean = (label || '').trim();
  if (!clean) throw new DailyWorkError('An activity type needs a name', 'BLANK_LABEL');

  const key = activityKey(clean);
  if (!key) throw new DailyWorkError('That name has no letters or digits in it', 'BAD_LABEL');

  return withOrgTransaction(orgId, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT key, label, status, merged_into_key FROM daily_activity_types
        WHERE org_id = $1 AND key = $2`, [orgId, key]);

    if (existing[0]) {
      // Already merged away: hand back what it was merged into, so the entry
      // is written against the surviving key rather than a dead one.
      if (existing[0].status === 'merged') {
        return { key: existing[0].merged_into_key, reused: true, wasMerged: true };
      }
      return { key: existing[0].key, reused: true, wasMerged: false };
    }

    const { rows } = await client.query(
      `INSERT INTO daily_activity_types (org_id, key, label, is_system, status, created_by)
       VALUES ($1,$2,$3,FALSE,'candidate',$4)
       RETURNING key, label, status`,
      [orgId, key, clean, userId]);

    return { ...rows[0], reused: false, wasMerged: false };
  });
}

/** Manager accepts a candidate into the shared list. */
async function promoteActivityType(orgId, managerUserId, key) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `UPDATE daily_activity_types
          SET status = 'active', updated_at = now()
        WHERE org_id = $1 AND key = $2 AND status = 'candidate'
        RETURNING key, label, status`,
      [orgId, key]);

    if (!rows[0]) {
      throw new DailyWorkError('No candidate activity type with that key',
        'NO_SUCH_CANDIDATE', { key });
    }
    return rows[0];
  });
}

/**
 * Fold one activity type into another.
 *
 * Existing entries and items are REPOINTED at the surviving key rather than
 * left alone and resolved through merged_into_key at read time. That is a
 * deliberate exception to "never rewrite history", and worth being explicit
 * about:
 *
 *   - A merge is an explicit, deliberate correction by a manager, not a
 *     passive join that fires on every read. Nobody's history changes because
 *     an unrelated record moved.
 *   - The audit trail survives: the merged row stays, with status 'merged' and
 *     merged_into_key set. chk_dat_merge_shape exists precisely so that pair
 *     cannot come apart.
 *   - The alternative means every filter, group-by and count has to follow a
 *     chain of merges, recursively, forever. That cost lands on every query in
 *     the module for the life of the product, to preserve a distinction the
 *     manager just said should not exist.
 */
async function mergeActivityType(orgId, managerUserId, key, intoKey) {
  if (key === intoKey) {
    throw new DailyWorkError('An activity type cannot be merged into itself', 'MERGE_SELF');
  }

  return withOrgTransaction(orgId, async (client) => {
    const { rows: target } = await client.query(
      `SELECT key, status FROM daily_activity_types
        WHERE org_id = $1 AND key = $2`, [orgId, intoKey]);

    if (!target[0]) {
      throw new DailyWorkError('Nothing to merge into', 'NO_SUCH_TARGET', { intoKey });
    }
    // Merging into something already merged would build a chain, which is the
    // thing repointing exists to avoid.
    if (target[0].status !== 'active') {
      throw new DailyWorkError('Can only merge into an active activity type',
        'TARGET_NOT_ACTIVE', { intoKey, status: target[0].status });
    }

    const { rowCount: entriesMoved } = await client.query(
      `UPDATE daily_work_entries SET activity_type_key = $1, updated_at = now()
        WHERE org_id = $2 AND activity_type_key = $3`, [intoKey, orgId, key]);

    await client.query(
      `UPDATE daily_work_items SET activity_type_key = $1, updated_at = now()
        WHERE org_id = $2 AND activity_type_key = $3`, [intoKey, orgId, key]);

    const { rows } = await client.query(
      `UPDATE daily_activity_types
          SET status = 'merged', merged_into_key = $1, updated_at = now()
        WHERE org_id = $2 AND key = $3
        RETURNING key, label, status, merged_into_key`,
      [intoKey, orgId, key]);

    if (!rows[0]) {
      throw new DailyWorkError('No activity type with that key', 'NO_SUCH_TYPE', { key });
    }
    return { ...rows[0], entriesMoved };
  });
}

/* ───────────────────────── evidence ────────────────────────────────── */

/**
 * Attach evidence to ONE ENTRY.
 *
 * Per entry, never per day. The same file supporting work on three different
 * days is three rows — they can share a storage_file_id, but each one belongs
 * to the day it evidences. Attaching to a day would mean the person-day view
 * owned something, and that view is derived and owns nothing.
 *
 * channel 'manual' covers both a pasted link and a written sentence; the
 * source-shape CHECK only demands extra columns for whatsapp, file and teams.
 *
 * Evidence is immutable once written — play_evidence_immutable() blocks any
 * UPDATE. That asymmetry is intended: an entry is someone's account of their
 * day and can be corrected, while evidence is a claim that something happened
 * and should not be quietly edited afterwards.
 */
async function attachEvidence(orgId, userId, { entryId, note, channel = 'manual', storageFileId = null }) {
  if (!note || !note.trim()) {
    throw new DailyWorkError('Evidence needs a link or a sentence', 'BLANK_EVIDENCE');
  }
  if (channel === 'file' && !storageFileId) {
    throw new DailyWorkError('File evidence needs a stored file', 'MISSING_FILE');
  }

  return withOrgTransaction(orgId, async (client) => {
    const { rows: entry } = await client.query(
      `SELECT id, user_id FROM daily_work_entries WHERE id = $1 AND org_id = $2`,
      [entryId, orgId]);

    if (!entry[0]) {
      throw new DailyWorkError('No such entry', 'NO_SUCH_ENTRY', { entryId });
    }
    if (entry[0].user_id !== userId) {
      throw new DailyWorkError('That entry belongs to someone else',
        'NOT_YOUR_ENTRY', { entryId });
    }

    const { rows } = await client.query(
      `INSERT INTO play_evidence
         (org_id, daily_work_entry_id, channel, note, storage_file_id, accepted_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, daily_work_entry_id, channel, note, accepted_at`,
      [orgId, entryId, channel, note.trim(), storageFileId, userId]);

    return rows[0];
  });
}

/**
 * Who may read the Tier 2 content on an entry: the owner, and their manager
 * chain. Tier 2 is description, next steps and evidence — §10 of the design
 * keeps it narrower than Tier 1 on purpose.
 */
async function canSeeEntry(orgId, viewerId, ownerId) {
  if (viewerId === ownerId) return true;
  const subordinates = await hierarchyService.getSubordinates(orgId, viewerId);
  return subordinates.includes(ownerId);
}

/** Everything attached to one entry, revoked rows included. */
async function listEvidence(orgId, viewerId, entryId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows: entry } = await client.query(
      `SELECT id, user_id FROM daily_work_entries WHERE id = $1 AND org_id = $2`,
      [entryId, orgId]);
    if (!entry[0]) throw new DailyWorkError('No such entry', 'NO_SUCH_ENTRY', { entryId });

    if (!(await canSeeEntry(orgId, viewerId, entry[0].user_id))) {
      throw new DailyWorkError('That entry belongs to someone else', 'NOT_YOUR_ENTRY', { entryId });
    }

    // Revoked rows come back too, marked. That is the whole audit trail: a
    // correction that erased what it replaced would be indistinguishable from
    // never having made the mistake.
    const { rows } = await client.query(
      `SELECT e.id, e.channel, e.note, e.storage_file_id,
              e.accepted_by, e.accepted_at,
              e.revoked_at, e.revoked_by, e.revoke_reason,
              a.first_name AS accepted_first, a.last_name AS accepted_last,
              r.first_name AS revoked_first,  r.last_name AS revoked_last
         FROM play_evidence e
         LEFT JOIN users a ON a.id = e.accepted_by
         LEFT JOIN users r ON r.id = e.revoked_by
        WHERE e.org_id = $1 AND e.daily_work_entry_id = $2
        ORDER BY e.accepted_at`,
      [orgId, entryId]);

    return rows;
  });
}

/**
 * Withdraw a piece of evidence.
 *
 * Evidence is immutable — play_evidence_immutable() refuses every update except
 * setting the revocation fields, and refuses re-revoking something already
 * revoked. So there is no edit: there is a withdrawal, which keeps the original
 * row, who withdrew it, when, and why.
 *
 * The reason is mandatory in the database too
 * (play_evidence_revoke_shape_chk), which is the right place for it — a
 * revocation with no reason is just a deletion wearing a hat.
 */
async function revokeEvidence(orgId, userId, evidenceId, reason) {
  if (!reason || !reason.trim()) {
    throw new DailyWorkError('Say why you are withdrawing it', 'BLANK_REASON');
  }

  return withOrgTransaction(orgId, async (client) => {
    const { rows: found } = await client.query(
      `SELECT ev.id, ev.revoked_at, e.user_id
         FROM play_evidence ev
         JOIN daily_work_entries e ON e.id = ev.daily_work_entry_id
        WHERE ev.id = $1 AND ev.org_id = $2`,
      [evidenceId, orgId]);

    const row = found[0];
    if (!row) throw new DailyWorkError('No such evidence', 'NO_SUCH_EVIDENCE', { evidenceId });
    if (row.user_id !== userId) {
      throw new DailyWorkError('That belongs to someone else', 'NOT_YOUR_ENTRY', { evidenceId });
    }
    if (row.revoked_at) {
      throw new DailyWorkError('That was already withdrawn', 'ALREADY_REVOKED', { evidenceId });
    }

    const { rows } = await client.query(
      `UPDATE play_evidence
          SET revoked_at = now(), revoked_by = $1, revoke_reason = $2
        WHERE id = $3 AND org_id = $4
        RETURNING id, revoked_at, revoke_reason`,
      [userId, reason.trim(), evidenceId, orgId]);

    return rows[0];
  });
}

/**
 * Correct a piece of evidence: withdraw the old, attach the new, in one go.
 *
 * One transaction, so an entry is never briefly left with nothing attached, and
 * the pair is never half-applied. What the reader ends up with is both rows —
 * the withdrawn one with its reason, and the replacement — which is a more
 * honest record than an edit that leaves no trace of the original.
 */
async function replaceEvidence(orgId, userId, evidenceId, { note, reason, channel = 'manual' }) {
  if (!note || !note.trim()) {
    throw new DailyWorkError('The replacement needs a link or a sentence', 'BLANK_EVIDENCE');
  }
  if (!reason || !reason.trim()) {
    throw new DailyWorkError('Say why you are replacing it', 'BLANK_REASON');
  }

  return withOrgTransaction(orgId, async (client) => {
    const { rows: found } = await client.query(
      `SELECT ev.id, ev.revoked_at, ev.daily_work_entry_id, e.user_id
         FROM play_evidence ev
         JOIN daily_work_entries e ON e.id = ev.daily_work_entry_id
        WHERE ev.id = $1 AND ev.org_id = $2`,
      [evidenceId, orgId]);

    const row = found[0];
    if (!row) throw new DailyWorkError('No such evidence', 'NO_SUCH_EVIDENCE', { evidenceId });
    if (row.user_id !== userId) {
      throw new DailyWorkError('That belongs to someone else', 'NOT_YOUR_ENTRY', { evidenceId });
    }
    if (row.revoked_at) {
      throw new DailyWorkError('That was already withdrawn', 'ALREADY_REVOKED', { evidenceId });
    }

    await client.query(
      `UPDATE play_evidence
          SET revoked_at = now(), revoked_by = $1, revoke_reason = $2
        WHERE id = $3 AND org_id = $4`,
      [userId, reason.trim(), evidenceId, orgId]);

    const { rows } = await client.query(
      `INSERT INTO play_evidence
         (org_id, daily_work_entry_id, channel, note, accepted_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, channel, note, accepted_at`,
      [orgId, row.daily_work_entry_id, channel, note.trim(), userId]);

    return { revoked: evidenceId, replacement: rows[0] };
  });
}

/**
 * Departments, for the manager's filter.
 *
 * Teams on an INTERNAL dimension — 2026_131 reused the existing team model
 * rather than adding a table. teams.dimension holds team_dimensions.key, a
 * string join rather than an id, which is easy to get subtly wrong.
 */
async function listDepartments(orgId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT t.id, t.name
         FROM teams t
         JOIN team_dimensions td
                ON td.key = t.dimension AND td.org_id = t.org_id
               AND td.applies_to = 'internal'
        WHERE t.org_id = $1 AND t.is_active = TRUE
        ORDER BY t.name`,
      [orgId]);
    return rows;
  });
}

/* ───────────────────────── calendars and schedules ─────────────────── */

/**
 * Every calendar in the org, with its dates and how many people use it.
 *
 * The usage count matters: deleting a calendar that four people are scheduled
 * against silently changes four denominators, so the screen has to be able to
 * say so before anyone clicks.
 */
async function listCalendars(orgId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows: calendars } = await client.query(
      `SELECT c.id, c.name, c.is_default,
              (SELECT count(*)::int FROM daily_work_schedules s
                WHERE s.org_id = c.org_id AND s.holiday_calendar_id = c.id) AS people,
              (SELECT count(*)::int FROM holiday_calendar_dates d
                WHERE d.org_id = c.org_id AND d.calendar_id = c.id) AS date_count
         FROM holiday_calendars c
        WHERE c.org_id = $1
        ORDER BY c.is_default DESC, c.name`,
      [orgId]);

    const { rows: dates } = await client.query(
      `SELECT id, calendar_id, holiday_date::text AS holiday_date, label
         FROM holiday_calendar_dates
        WHERE org_id = $1
        ORDER BY holiday_date`,
      [orgId]);

    return calendars.map(c => ({
      ...c,
      dates: dates.filter(d => d.calendar_id === c.id),
    }));
  });
}

async function createCalendar(orgId, userId, { name, isDefault = false }) {
  if (!name || !name.trim()) {
    throw new DailyWorkError('A calendar needs a name', 'BLANK_NAME');
  }

  return withOrgTransaction(orgId, async (client) => {
    // uq_holiday_calendars_one_default permits one default per org, so the
    // existing one is stood down first rather than letting the insert fail with
    // a constraint name nobody outside this file would recognise.
    if (isDefault) {
      await client.query(
        `UPDATE holiday_calendars SET is_default = FALSE WHERE org_id = $1 AND is_default`,
        [orgId]);
    }

    const { rows } = await client.query(
      `INSERT INTO holiday_calendars (org_id, name, is_default, created_by)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, is_default`,
      [orgId, name.trim(), !!isDefault, userId]);

    return rows[0];
  });
}

async function setDefaultCalendar(orgId, calendarId) {
  return withOrgTransaction(orgId, async (client) => {
    await client.query(
      `UPDATE holiday_calendars SET is_default = FALSE WHERE org_id = $1 AND is_default`,
      [orgId]);
    const { rows } = await client.query(
      `UPDATE holiday_calendars SET is_default = TRUE
        WHERE id = $1 AND org_id = $2
        RETURNING id, name, is_default`,
      [calendarId, orgId]);
    if (!rows[0]) throw new DailyWorkError('No such calendar', 'NO_SUCH_CALENDAR', { calendarId });
    return rows[0];
  });
}

async function deleteCalendar(orgId, calendarId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows: users } = await client.query(
      `SELECT count(*)::int AS n FROM daily_work_schedules
        WHERE org_id = $1 AND holiday_calendar_id = $2`, [orgId, calendarId]);

    // Refuse rather than cascade. Removing a calendar out from under a
    // schedule would change those people's working days with no trace of why.
    if (users[0].n > 0) {
      throw new DailyWorkError(
        `${users[0].n} ${users[0].n === 1 ? 'person is' : 'people are'} using this calendar — move them first`,
        'CALENDAR_IN_USE', { calendarId, people: users[0].n });
    }

    const { rowCount } = await client.query(
      `DELETE FROM holiday_calendars WHERE id = $1 AND org_id = $2`, [calendarId, orgId]);
    if (!rowCount) throw new DailyWorkError('No such calendar', 'NO_SUCH_CALENDAR', { calendarId });
    return { deleted: calendarId };
  });
}

/**
 * Add holidays. Accepts a list, because nobody wants to click through fourteen
 * dates one at a time.
 *
 * Dates already present are skipped rather than erroring, so pasting next
 * year's list over this year's is safe and reports what it actually added.
 */
async function addHolidays(orgId, calendarId, dates) {
  if (!Array.isArray(dates) || !dates.length) {
    throw new DailyWorkError('No dates given', 'NO_DATES');
  }

  return withOrgTransaction(orgId, async (client) => {
    const { rows: cal } = await client.query(
      `SELECT id FROM holiday_calendars WHERE id = $1 AND org_id = $2`, [calendarId, orgId]);
    if (!cal[0]) throw new DailyWorkError('No such calendar', 'NO_SUCH_CALENDAR', { calendarId });

    const added = [];
    const skipped = [];
    for (const d of dates) {
      const date = (d.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new DailyWorkError(`"${date}" is not a date in YYYY-MM-DD form`, 'BAD_DATE', { date });
      }
      const { rows } = await client.query(
        `INSERT INTO holiday_calendar_dates (org_id, calendar_id, holiday_date, label)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (calendar_id, holiday_date) DO NOTHING
         RETURNING id, holiday_date::text AS holiday_date, label`,
        [orgId, calendarId, date, (d.label || '').trim() || null]);
      rows[0] ? added.push(rows[0]) : skipped.push(date);
    }
    return { added, skipped };
  });
}

async function removeHoliday(orgId, dateId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM holiday_calendar_dates WHERE id = $1 AND org_id = $2`, [dateId, orgId]);
    if (!rowCount) throw new DailyWorkError('No such holiday', 'NO_SUCH_HOLIDAY', { dateId });
    return { deleted: dateId };
  });
}

/**
 * Who is on which calendar and which working week.
 *
 * Scoped to people granted the module — someone without it has no denominator
 * to get wrong, and listing the whole org would bury the ten in a hundred.
 */
async function listSchedules(orgId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.timezone,
              s.id AS schedule_id, s.weekday_mask,
              s.effective_from::text AS effective_from,
              s.holiday_calendar_id, c.name AS calendar_name
         FROM user_module_access g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN LATERAL (
                SELECT id, weekday_mask, effective_from, holiday_calendar_id
                  FROM daily_work_schedules d
                 WHERE d.org_id = g.org_id AND d.user_id = g.user_id
                 ORDER BY effective_from DESC LIMIT 1
              ) s ON TRUE
         LEFT JOIN holiday_calendars c ON c.id = s.holiday_calendar_id
        WHERE g.org_id = $1 AND g.module_key = 'dailywork'
        ORDER BY u.first_name, u.last_name`,
      [orgId]);
    return rows;
  });
}

/**
 * Change someone's working week or calendar.
 *
 * A new EFFECTIVE-DATED ROW, never an update in place. Someone moving to a
 * four-day week in June must still have their May days counted against the old
 * mask, and rewriting the row would silently restate every rate they have ever
 * been shown. Setting the same effective_from twice does update, because that
 * is a correction to a change not yet in force rather than a new one.
 */
async function setSchedule(orgId, userId, actorUserId, { weekdayMask, holidayCalendarId, effectiveFrom }) {
  if (!Number.isInteger(weekdayMask) || weekdayMask < 1 || weekdayMask > 127) {
    throw new DailyWorkError('A working week must include at least one day', 'BAD_MASK', { weekdayMask });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom || '')) {
    throw new DailyWorkError('effectiveFrom must be YYYY-MM-DD', 'BAD_DATE');
  }

  return withOrgTransaction(orgId, async (client) => {
    await assertActiveMember(client, orgId, userId);

    const { rows } = await client.query(
      `INSERT INTO daily_work_schedules
         (org_id, user_id, weekday_mask, holiday_calendar_id, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, user_id, effective_from) DO UPDATE
          SET weekday_mask = EXCLUDED.weekday_mask,
              holiday_calendar_id = EXCLUDED.holiday_calendar_id
       RETURNING id, weekday_mask, effective_from::text AS effective_from, holiday_calendar_id`,
      [orgId, userId, weekdayMask, holidayCalendarId || null, effectiveFrom, actorUserId]);

    return rows[0];
  });
}

/**
 * Set someone's timezone, deliberately.
 *
 * This exists because the login-time browser capture was removed: it decided
 * which DAY a person's work counted for, and getting that from whichever device
 * they first opened is not a decision anybody made.
 *
 * Validated against the IANA set through Intl, so a typo is refused here rather
 * than silently falling back to UTC at read time and shifting one person's
 * dates by hours.
 */
async function setUserTimezone(orgId, userId, timezone) {
  const tz = (timezone || '').trim();
  if (tz && !dwDate.isValidZone(tz)) {
    throw new DailyWorkError(`"${tz}" is not a timezone`, 'BAD_TIMEZONE', { timezone: tz });
  }

  return withOrgTransaction(orgId, async (client) => {
    await assertActiveMember(client, orgId, userId);
    const { rows } = await client.query(
      `UPDATE users SET timezone = $1, updated_at = now()
        WHERE id = $2 AND org_id = $3
        RETURNING id, timezone`,
      [tz || null, userId, orgId]);
    if (!rows[0]) throw new DailyWorkError('No such user', 'NO_SUCH_USER', { userId });
    return rows[0];
  });
}

/* ═══════════════════════ provisioning and readiness ═══════════════════════
 *
 * Everything below replaces scripts/seed_daily_work.js as the route into a new
 * org. That script worked, but it required a person with the database URL and
 * a hand-edited CONFIG block for every org, which does not scale past the
 * first one and cannot be handed to a customer.
 *
 * The split is deliberate and mirrors how the module is gated:
 *
 *   super admin   provisions (allowed) and seeds the BARE MINIMUM — enough
 *                 that the org admin lands on a working screen instead of
 *                 four empty ones
 *   org admin     enables, then supplies the values only they know: their
 *                 own activity vocabulary, their holidays, who works which
 *                 days, and in which timezone
 *
 * Nothing here blocks anyone. getSetupReadiness reports; it does not gate.
 * A hard gate would take a running org offline the moment somebody retired
 * their last activity type, which is a worse failure than an incomplete setup.
 */

// One placeholder, not a starter vocabulary. The activity list is the only
// thing comparable across people, and a seeded generic list is worse than an
// empty one: people pick the nearest wrong option from a list somebody else
// wrote, and the org never defines its own. One row exists so the module is
// usable on day one and so the shape of the thing is obvious.
const STARTER_ACTIVITY = { key: 'general', label: 'General work' };
const STARTER_CALENDAR = 'Default';

/**
 * What seeding WOULD do, without doing any of it.
 *
 * Read-only, and it exists because a button whose only feedback is a banner
 * somewhere above the fold is indistinguishable from a button that did
 * nothing. Same two constants the seeder uses, so the preview cannot describe
 * something different from what gets written.
 */
async function previewStarterData(orgId) {
  return withOrgTransaction(orgId, async (client) => {
    const [types, cals] = await Promise.all([
      client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'active')::int AS active,
                count(*) FILTER (WHERE key = $2)::int AS starter
           FROM daily_activity_types WHERE org_id = $1`,
        [orgId, STARTER_ACTIVITY.key]),
      client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE is_default)::int AS defaults
           FROM holiday_calendars WHERE org_id = $1`, [orgId]),
    ]);
    const t = types.rows[0], c = cals.rows[0];

    const wouldCreate = [];
    const alreadyThere = [];

    if (t.starter > 0) alreadyThere.push(`activity type "${STARTER_ACTIVITY.label}"`);
    else wouldCreate.push(`activity type "${STARTER_ACTIVITY.label}"`);

    if (c.total > 0) alreadyThere.push(
      `${c.total} holiday ${c.total === 1 ? 'calendar' : 'calendars'}`
      + (c.defaults ? '' : ' (none marked default)'));
    else wouldCreate.push(`holiday calendar "${STARTER_CALENDAR}", no dates`);

    return {
      wouldCreate,
      alreadyThere,
      current: {
        activityTypes: t.total, activeActivityTypes: t.active,
        calendars: c.total, defaultCalendars: c.defaults,
      },
    };
  });
}

/**
 * Seed the minimum an org needs before its admin can do anything useful.
 *
 * Idempotent, and additive only — it creates what is missing and touches
 * nothing that exists. Safe to re-run on an org that has already been set up
 * by hand, which matters because org 112 was.
 *
 * Deliberately does NOT create schedules, timezones or holidays. Those are
 * facts about the org's people that only the org knows, and inventing them
 * would produce a denominator with no basis — the exact failure the seed
 * script's header warns about.
 */
async function seedStarterData(orgId, actorUserId = null) {
  return withOrgTransaction(orgId, async (client) => {
    const created = [];

    const { rows: [act] } = await client.query(
      `INSERT INTO daily_activity_types (org_id, key, label, is_system, status, created_by)
       VALUES ($1, $2, $3, TRUE, 'active', $4)
       ON CONFLICT (org_id, key) DO NOTHING
       RETURNING key`,
      [orgId, STARTER_ACTIVITY.key, STARTER_ACTIVITY.label, actorUserId]);
    if (act) created.push(`activity type "${STARTER_ACTIVITY.label}"`);

    // Only when the org has NO calendar at all. An org that already named its
    // own must not acquire a second one called "Default" beside it.
    const { rows: [existing] } = await client.query(
      `SELECT id FROM holiday_calendars WHERE org_id = $1 LIMIT 1`, [orgId]);
    if (!existing) {
      await client.query(
        `INSERT INTO holiday_calendars (org_id, name, is_default, created_by)
         VALUES ($1, $2, TRUE, $3)`,
        [orgId, STARTER_CALENDAR, actorUserId]);
      created.push(`holiday calendar "${STARTER_CALENDAR}" (no dates yet)`);
    }

    return { created, seeded: created.length > 0 };
  });
}

/**
 * What is still missing before this org's numbers mean anything.
 *
 * Reported, never enforced. Each check names the thing it would break, because
 * "3 people have no working week" is actionable and "setup incomplete" is not.
 */
async function getSetupReadiness(orgId) {
  return withOrgTransaction(orgId, async (client) => {
    const [types, cals, sched, org] = await Promise.all([
      client.query(
        `SELECT count(*)::int AS n FROM daily_activity_types
          WHERE org_id = $1 AND status = 'active'`, [orgId]),
      client.query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE is_default)::int AS defaults,
                COALESCE(sum(d.dates), 0)::int AS dates
           FROM holiday_calendars c
           LEFT JOIN LATERAL (
                  SELECT count(*)::int AS dates FROM holiday_calendar_dates x
                   WHERE x.calendar_id = c.id AND x.org_id = c.org_id
                ) d ON TRUE
          WHERE c.org_id = $1`, [orgId]),
      // The same LATERAL listSchedules uses, so the counts here and the rows
      // on screen can never disagree.
      client.query(
        `SELECT count(*)::int AS members,
                count(*) FILTER (WHERE s.id IS NULL)::int AS no_schedule,
                count(*) FILTER (WHERE u.timezone IS NULL OR u.timezone = '')::int AS no_tz
           FROM user_module_access g
           JOIN users u ON u.id = g.user_id
           LEFT JOIN LATERAL (
                  SELECT id FROM daily_work_schedules d
                   WHERE d.org_id = g.org_id AND d.user_id = g.user_id
                   ORDER BY effective_from DESC LIMIT 1
                ) s ON TRUE
          WHERE g.org_id = $1 AND g.module_key = 'dailywork'`, [orgId]),
      client.query(
        `SELECT settings->'dailywork'->>'reminder_hour' AS hour
           FROM organizations WHERE id = $1`, [orgId]),
    ]);

    const t = types.rows[0], c = cals.rows[0], s = sched.rows[0];
    const rawHour = org.rows[0]?.hour;

    const checks = [
      {
        key: 'members', ok: s.members > 0,
        label: 'Somebody has been given the module',
        detail: s.members > 0
          ? `${s.members} ${s.members === 1 ? 'person has' : 'people have'} access`
          : 'Grant it to people under Settings → Members. Enabling the module '
            + 'gives it to admins only.',
        count: s.members,
      },
      {
        key: 'activity_types', ok: t.n > 0,
        label: 'An activity list',
        detail: t.n > 0
          ? `${t.n} active ${t.n === 1 ? 'type' : 'types'}`
          : 'Without one there is no shared vocabulary, and nothing is '
            + 'comparable between people.',
        count: t.n,
      },
      {
        key: 'calendar', ok: c.n > 0 && c.defaults > 0,
        label: 'A default holiday calendar',
        detail: c.n === 0 ? 'No calendar exists.'
              : c.defaults === 0 ? `${c.n} calendars, none marked default.`
              : `${c.dates} ${c.dates === 1 ? 'holiday' : 'holidays'} recorded. `
                + 'An empty calendar is valid — every scheduled weekday then counts.',
        count: c.n,
      },
      {
        key: 'timezones', ok: s.members > 0 && s.no_tz === 0,
        label: 'Everyone has a timezone',
        detail: s.no_tz > 0
          ? `${s.no_tz} without one. It decides which DAY their work counts for.`
          : 'Set for everyone.',
        count: s.no_tz,
      },
      {
        key: 'schedules', ok: s.members > 0 && s.no_schedule === 0,
        label: 'Everyone has a working week',
        detail: s.no_schedule > 0
          ? `${s.no_schedule} without one, so they have no denominator and no rate.`
          : 'Set for everyone.',
        count: s.no_schedule,
      },
      {
        // Advisory: hourOr() in dailyWorkNotify falls back to 17:00 local, so
        // an org that never touches this is correct rather than broken.
        key: 'reminder_hour', ok: true, advisory: true,
        label: 'Reminder hour',
        detail: rawHour ? `${rawHour}:00 local` : '17:00 local (the default)',
      },
    ];

    return {
      ready: checks.every(x => x.advisory || x.ok),
      checks,
      members: s.members,
    };
  });
}

/**
 * Give a working week to everyone who has none.
 *
 * ONLY to those who have none. An admin with ten people should not click
 * through ten identical forms, but neither should one button quietly restate
 * the four-day week somebody deliberately set last month — so this never
 * touches a person who already has a schedule row of any kind.
 */
async function bulkSetSchedules(orgId, actorUserId, { weekdayMask, holidayCalendarId, effectiveFrom }) {
  if (!Number.isInteger(weekdayMask) || weekdayMask < 1 || weekdayMask > 127) {
    throw new DailyWorkError('A working week must include at least one day', 'BAD_MASK', { weekdayMask });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom || '')) {
    throw new DailyWorkError('effectiveFrom must be YYYY-MM-DD', 'BAD_DATE');
  }

  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO daily_work_schedules
         (org_id, user_id, weekday_mask, holiday_calendar_id, effective_from, created_by)
       SELECT $1, g.user_id, $2, $3, $4, $5
         FROM user_module_access g
         JOIN org_users ou ON ou.user_id = g.user_id AND ou.org_id = g.org_id
        WHERE g.org_id = $1 AND g.module_key = 'dailywork'
          AND ou.is_active = TRUE
          AND NOT EXISTS (SELECT 1 FROM daily_work_schedules d
                           WHERE d.org_id = g.org_id AND d.user_id = g.user_id)
       ON CONFLICT (org_id, user_id, effective_from) DO NOTHING
       RETURNING user_id`,
      [orgId, weekdayMask, holidayCalendarId || null, effectiveFrom, actorUserId]);
    return { updated: rows.length };
  });
}

/** Give a timezone to everyone who has none. Same rule: never overwrites. */
async function bulkSetTimezone(orgId, timezone) {
  const tz = (timezone || '').trim();
  if (!tz || !dwDate.isValidZone(tz)) {
    throw new DailyWorkError(`"${tz}" is not a timezone`, 'BAD_TIMEZONE', { timezone: tz });
  }
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `UPDATE users u SET timezone = $2, updated_at = now()
         FROM user_module_access g
        WHERE g.org_id = $1 AND g.module_key = 'dailywork'
          AND u.id = g.user_id AND u.org_id = $1
          AND (u.timezone IS NULL OR u.timezone = '')
       RETURNING u.id`,
      [orgId, tz]);
    return { updated: rows.length, timezone: tz };
  });
}

module.exports = {
  // Exported so the route and any future settings screen read the same number
  // the validation uses, rather than repeating 5 in three places.
  BACKFILL_DAYS,
  getAnchorOptions,
  setUserTimezone,
  seedStarterData,
  previewStarterData,
  getSetupReadiness,
  bulkSetSchedules,
  bulkSetTimezone,
  listCalendars,
  createCalendar,
  setDefaultCalendar,
  deleteCalendar,
  addHolidays,
  removeHoliday,
  listSchedules,
  setSchedule,
  listEvidence,
  revokeEvidence,
  replaceEvidence,
  listDepartments,
  listActivityTypes,
  createActivityType,
  renameActivityType,
  setActivityTypeRetired,
  updateItem,
  proposeActivityType,
  promoteActivityType,
  mergeActivityType,
  attachEvidence,
  createItem,
  assignItem,
  saveDay,
  getDay,
  // 2026_136 — task-linked daily work.
  getTaskForUpdate,
  postTaskUpdate,
  getTaskWork,
  resolveAccountId,
  resolvePrimaryTeamId,
  DailyWorkError,
  DAY_STAGES,
  LINKED_DAY_STAGES,
  MAX_DESCRIPTION,
};
