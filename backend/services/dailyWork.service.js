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
const dwDate = require('./dailyWorkDate');

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

    const { rows } = await client.query(
      `INSERT INTO daily_work_items
         (org_id, owner_user_id, kind, title, activity_type_key,
          anchor_kind, anchor_id, account_id, status, department_team_id,
          created_by, assigned_by, target_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [orgId, ownerUserId, kind, title.trim(), activityTypeKey,
       anchorKind, anchorId, accountId, status, teamId,
       actorUserId, assignedBy, targetDate]);

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
async function saveDay(orgId, userId, entries, { asOf = new Date() } = {}) {
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

  return withOrgTransaction(orgId, async (client) => {
    await assertActiveMember(client, orgId, userId);

    const tz = await dwDate.resolveTimezone(
      (sql, params) => client.query(sql, params), orgId, userId);
    const entryDate = dwDate.localDate(tz, asOf);

    const teamId = await resolvePrimaryTeamId(client, orgId, userId);
    const saved = [];

    for (const entry of entries) {
      const { rows: itemRows } = await client.query(
        `SELECT id, kind, status, owner_user_id, activity_type_key,
                anchor_kind, anchor_id, account_id
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
            anchor_kind, anchor_id, account_id, is_continuation, last_edited_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$3)
         ON CONFLICT (org_id, item_id, entry_date) DO UPDATE
            SET description    = EXCLUDED.description,
                next_steps     = EXCLUDED.next_steps,
                day_stage      = EXCLUDED.day_stage,
                last_edited_by = EXCLUDED.last_edited_by,
                updated_at     = now()
         RETURNING *`,
        [orgId, entry.itemId, userId, entryDate,
         entry.description.trim(), entry.nextSteps || null, entry.dayStage,
         teamId, item.activity_type_key,
         item.anchor_kind, item.anchor_id, item.account_id, isContinuation]);

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
    const entryDate = date || dwDate.localDate(tz, asOf);

    const { rows } = await client.query(
      `SELECT i.id                AS item_id,
              i.kind, i.title, i.status, i.activity_type_key,
              i.anchor_kind, i.anchor_id, i.account_id, i.target_date,
              i.assigned_by, i.created_at,
              a.name              AS account_name,
              e.id                AS entry_id,
              e.description, e.next_steps, e.day_stage, e.is_continuation,
              prior.entry_date    AS prior_date,
              prior.description   AS prior_description,
              (SELECT count(*)::int FROM play_evidence pe
                WHERE pe.daily_work_entry_id = e.id) AS evidence_count
         FROM daily_work_items i
         LEFT JOIN accounts a
                ON a.id = i.account_id AND a.org_id = i.org_id
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

    return { entryDate, timezone: tz, rows };
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
 * Four kinds come back, and the difference between the middle two is the whole
 * basis of the account view:
 *
 *   customer project — a handover with an account. Work here is attributed.
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
 */
async function getAnchorOptions(orgId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT 'handover'::text AS anchor_kind, h.id AS anchor_id, h.name AS label,
              CASE WHEN h.project_kind = 'internal' THEN 'internal_project'
                   ELSE 'customer_project' END AS group_key,
              h.account_id, a.name AS account_name
         FROM sales_handovers h
         LEFT JOIN accounts a ON a.id = h.account_id AND a.org_id = h.org_id
        WHERE h.org_id = $1
          AND h.status NOT IN ('cancelled','completed')
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

module.exports = {
  getAnchorOptions,
  createItem,
  assignItem,
  saveDay,
  getDay,
  resolveAccountId,
  resolvePrimaryTeamId,
  DailyWorkError,
  DAY_STAGES,
  MAX_DESCRIPTION,
};
