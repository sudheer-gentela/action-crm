// planImport.service.js
//
// Getting a project plan out of a spreadsheet and into the product.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────
//
// Entering 49 tasks by hand is worse than not using the tool, so plans stay
// in spreadsheets and everything downstream — dependencies, gates, baselines,
// variance, daily work — never gets used on them.
//
// And they will KEEP being written in spreadsheets, because that is where a
// plan gets negotiated, usually before the project exists here and often with
// people who have no login. So this is not a temporary bridge to be removed
// once an editor exists; it is the front door.
//
// ── TWO CALLS, ONE OF WHICH WRITES NOTHING ───────────────────────────
//
//   preview()  pure computation. Turns durations into dates and reports what
//              would be created. No writes, so it can be re-run on every
//              keystroke while someone adjusts the start date.
//   commit()   one transaction, batched. Creates the stages and the tasks.
//
// The split matters because the dates are EDITABLE between the two. What is
// committed is whatever the person confirmed, not whatever this file
// computed — the schedule is a first draft of the dates, not an authority on
// them.
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────
//
// No duration column is stored. `est_days_low`/`est_days_high` were designed
// and then dropped: the plan is DATES, variance is measured against the frozen
// baseline, and a duration that nothing consumes after import is a number that
// goes stale in the schema. Duration is an input to this file and nothing else.
//
// No dependency graph and no cascade. depends_on exists and has cycle
// detection, but deriving it from a spreadsheet's row order would invent
// prerequisites nobody wrote down. A date that moves after import moves the
// way every other date in the product moves.

const { pool } = require('../config/database');
// Only the stage-key normaliser, from its own tiny module rather than from
// handover.service — that one reaches routes/orgAdmin.routes and pulls in
// express, which a batch importer has no business loading and the standalone
// harness cannot load at all.
const { stageKeyFrom } = require('./stageKey');

class PlanImportError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'PlanImportError';
    this.code = code;
    this.details = details;
    this.status = 400;
  }
}

// A guardrail, not a target. The largest real plan seen is ~50 rows; 500 is
// far past anything a person pastes deliberately and well short of what would
// hurt. Caught here so a runaway paste fails with a sentence rather than a
// statement timeout halfway through.
const MAX_ROWS = 500;

/* ───────────────────────── duration ────────────────────────────────── */

/**
 * Read a duration cell as a number of WORKING days.
 *
 * Accepts what people actually type: "3", "3d", "3 days", "3-5", "3–5 days"
 * (en dash and hyphen both), "2 weeks". A RANGE takes its upper bound — the
 * schedule has to pick one number, and picking the optimistic end of somebody
 * else's estimate is how a plan is late before it starts.
 *
 * Returns { days, note }. `note` is non-null whenever the cell was not a plain
 * number, so the preview can show what was read rather than silently deciding.
 * An unreadable cell becomes one day and says so: refusing the whole import
 * over one bad cell would send the person back to the spreadsheet, which is
 * the outcome this file exists to prevent.
 */
function parseDuration(raw) {
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!text) return { days: 1, note: 'no duration given — assumed 1 day' };

  const weeks = /week|wk/.test(text);
  // Both dash characters, plus 'to', so "3 to 5 days" reads the same as "3-5".
  const numbers = text.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) {
    return { days: 1, note: `could not read "${raw}" — assumed 1 day` };
  }

  const values = numbers.map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (values.length === 0) {
    return { days: 1, note: `could not read "${raw}" — assumed 1 day` };
  }

  const isRange = values.length > 1;
  let days = Math.ceil(Math.max(...values));
  if (weeks) days = days * 5;   // working days, not calendar days

  if (days > 365) {
    return { days: 365, note: `"${raw}" is longer than a year — capped at 365 days` };
  }

  const note = isRange
    ? `"${raw}" read as ${days} days (upper end of the range)`
    : weeks ? `"${raw}" read as ${days} working days`
    : null;
  return { days, note };
}

/* ───────────────────────── the calendar ────────────────────────────── */

/**
 * Non-working days for this org.
 *
 * Weekends always. Holidays from the org's DEFAULT holiday calendar if it has
 * one — the same table Daily Work uses, because an org that has already told
 * the product when its holidays are should not have to say it twice, and a
 * plan that schedules work on Diwali is wrong in a way everyone notices.
 *
 * Absent calendar is not an error. Most orgs will not have configured one when
 * they first import, and weekends alone is still much better than nothing.
 */
async function loadNonWorkingDays(orgId) {
  const { rows } = await pool.query(
    `SELECT d.holiday_date::text AS holiday_date
       FROM holiday_calendar_dates d
       JOIN holiday_calendars c ON c.id = d.calendar_id AND c.org_id = d.org_id
      WHERE d.org_id = $1 AND c.is_default AND c.is_active`,
    [orgId]);
  return new Set(rows.map(r => r.holiday_date));
}

/** ISO weekday, 1 = Monday .. 7 = Sunday, for a YYYY-MM-DD string read as UTC. */
function isoWeekday(iso) {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();   // 0 = Sunday
  return d === 0 ? 7 : d;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWorkingDay(iso, holidays) {
  return isoWeekday(iso) <= 5 && !holidays.has(iso);
}

/** The first working day on or after `iso`. */
function nextWorkingDay(iso, holidays) {
  let cursor = iso;
  // Bounded rather than while(true): a holiday table with a year of
  // consecutive dates would otherwise hang the request rather than fail it.
  for (let i = 0; i < 400; i++) {
    if (isWorkingDay(cursor, holidays)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new PlanImportError(
    'No working day found within a year of the start date — check the holiday calendar',
    'NO_WORKING_DAYS', { from: iso });
}

/* ───────────────────────── preview ─────────────────────────────────── */

/**
 * Turn durations into dates.
 *
 * SEQUENTIAL, in the order the rows were pasted. Each task starts on the first
 * working day after the previous one ends, and its due date is the working day
 * it ends on. A one-day task starting Friday is due Friday; the next starts
 * Monday.
 *
 * That is a deliberately dumb model, and the alternative is worse. Deriving
 * parallelism from a spreadsheet means guessing which rows can overlap, and a
 * guess that is wrong produces a plan that looks authoritative and is not.
 * Sequential is a first draft everyone can see the shape of, and every date is
 * editable before commit.
 *
 * A row that already carries an explicit date KEEPS it, and the sequence
 * continues from there — so a spreadsheet with real dates in it imports them
 * rather than having them recomputed.
 */
async function preview(handoverId, orgId, { rows = [], startDate = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PlanImportError('Nothing to import', 'EMPTY_IMPORT');
  }
  if (rows.length > MAX_ROWS) {
    throw new PlanImportError(
      `That is ${rows.length} rows. The most this will take at once is ${MAX_ROWS}.`,
      'TOO_MANY_ROWS', { rows: rows.length, limit: MAX_ROWS });
  }
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new PlanImportError('Start date must be YYYY-MM-DD', 'BAD_DATE', { startDate });
  }

  const { rows: [project] } = await pool.query(
    `SELECT id, status, baseline_frozen_at, started_at, go_live_date::text AS go_live_date
       FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]);
  if (!project) {
    throw new PlanImportError('Project not found', 'NO_SUCH_PROJECT', { handoverId });
  }

  const holidays = await loadNonWorkingDays(orgId);

  // Stages that already exist, so the preview can say which phases are new
  // rather than presenting all of them as if they were.
  const { rows: existingStages } = await pool.query(
    `SELECT key, name FROM project_stages
      WHERE handover_id = $1 AND org_id = $2 AND is_active = TRUE`,
    [handoverId, orgId]);
  const known = new Map(existingStages.map(s => [s.key, s.name]));

  const start = nextWorkingDay(
    startDate || new Date().toISOString().slice(0, 10), holidays);

  let cursor = start;
  const phases = [];
  const out = [];

  rows.forEach((row, index) => {
    const title = String(row.title || '').trim();
    const phase = String(row.phase || '').trim();
    const stageKey = phase ? stageKeyFrom(phase) : 'custom';

    const notes = [];
    if (!title) notes.push('no task name — this row will be skipped');

    const { days, note } = parseDuration(row.duration);
    if (note) notes.push(note);

    // An explicit date in the sheet wins over anything computed. Somebody who
    // typed a date meant it.
    let dueDate = null;
    if (row.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(row.dueDate).trim())) {
      dueDate = String(row.dueDate).trim();
      cursor = nextWorkingDay(addDays(dueDate, 1), holidays);
    } else if (row.dueDate) {
      notes.push(`could not read the date "${row.dueDate}" — scheduled instead`);
    }

    if (!dueDate && title) {
      // days - 1 further working days after the start day, so a one-day task
      // is due the day it starts rather than the day after.
      let end = nextWorkingDay(cursor, holidays);
      for (let d = 1; d < days; d++) end = nextWorkingDay(addDays(end, 1), holidays);
      dueDate = end;
      cursor = nextWorkingDay(addDays(end, 1), holidays);
    }

    if (phase && !known.has(stageKey) && !phases.some(p => p.key === stageKey)) {
      phases.push({ key: stageKey, name: phase, isNew: true });
    }

    out.push({
      index,
      title,
      phase: phase || null,
      stageKey,
      stageIsNew: !!phase && !known.has(stageKey),
      description: String(row.description || '').trim() || null,
      ownerUserId: row.ownerUserId != null && row.ownerUserId !== ''
        ? parseInt(row.ownerUserId, 10) : null,
      isGate: row.isGate === true,
      durationDays: days,
      dueDate,
      skip: !title,
      notes,
    });
  });

  const usable = out.filter(r => !r.skip);

  return {
    startDate: start,
    // Every one of these is a fact the person should see BEFORE committing,
    // not discover afterwards.
    planFrozen: !!project.baseline_frozen_at,
    newStages: phases,
    knownStages: [...known.entries()].map(([key, name]) => ({ key, name })),
    rows: out,
    summary: {
      total: out.length,
      willCreate: usable.length,
      skipped: out.length - usable.length,
      withNotes: out.filter(r => r.notes.length > 0).length,
      unassigned: usable.filter(r => !r.ownerUserId).length,
      firstDue: usable.length ? usable[0].dueDate : null,
      lastDue: usable.reduce((acc, r) => (r.dueDate && (!acc || r.dueDate > acc) ? r.dueDate : acc), null),
    },
  };
}

/* ───────────────────────── commit ──────────────────────────────────── */

/**
 * Create the stages and the tasks.
 *
 * ONE TRANSACTION and BATCHED, rather than a loop over addPlay(). That
 * function runs four queries plus a full _getPlays() per call: 49 tasks would
 * be roughly 250 round trips with no transaction around them, so a failure at
 * row 30 would leave 29 tasks behind and no way to tell which.
 *
 * ── BASELINE ─────────────────────────────────────────────────────────
 *
 * Same rule addPlay already applies, and it has to stay the same rule: a task
 * created on a project whose plan is already frozen is born with a committed
 * baseline, because nothing runs later to give it one. Without that, every
 * imported task on a live project would report isAdHoc forever and contribute
 * nothing to plan-vs-actual.
 *
 * ── WHAT IS NOT SET ──────────────────────────────────────────────────
 *
 * due_anchor is 'created', matching addPlay: an imported task has no playbook
 * template to take a go-live offset from, so there is nothing for the
 * go-live reschedule to compute against and leaving its date alone is the only
 * honest outcome.
 */
async function commit(handoverId, orgId, userId, { rows = [] } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PlanImportError('Nothing to import', 'EMPTY_IMPORT');
  }
  if (rows.length > MAX_ROWS) {
    throw new PlanImportError(
      `That is ${rows.length} rows. The most this will take at once is ${MAX_ROWS}.`,
      'TOO_MANY_ROWS', { rows: rows.length, limit: MAX_ROWS });
  }

  const clean = [];
  rows.forEach((row, i) => {
    const title = String(row.title || '').trim();
    if (!title) return;                       // preview already flagged these
    if (row.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.dueDate).trim())) {
      throw new PlanImportError(
        `Row ${i + 1} has a date this cannot read: "${row.dueDate}"`,
        'BAD_DATE', { index: i, dueDate: row.dueDate });
    }
    const phase = String(row.phase || '').trim();
    clean.push({
      title,
      description: String(row.description || '').trim() || null,
      stageKey: phase ? stageKeyFrom(phase) : 'custom',
      stageName: phase || null,
      ownerUserId: row.ownerUserId ? parseInt(row.ownerUserId, 10) : null,
      dueDate: row.dueDate ? String(row.dueDate).trim() : null,
      isGate: row.isGate === true,
    });
  });

  if (clean.length === 0) {
    throw new PlanImportError('None of those rows has a task name', 'NO_USABLE_ROWS');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [project] } = await client.query(
      `SELECT id, status, baseline_frozen_at FROM sales_handovers
        WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [handoverId, orgId]);
    if (!project) {
      throw new PlanImportError('Project not found', 'NO_SUCH_PROJECT', { handoverId });
    }
    // A completed or cancelled project is a record of what happened. Same rule
    // update() applies one level up.
    if (['completed', 'cancelled'].includes(project.status)) {
      throw new PlanImportError(
        `A ${project.status} project cannot take new tasks. Reopen it first.`,
        'PROJECT_TERMINAL', { status: project.status });
    }
    const frozen = !!project.baseline_frozen_at;

    // ── stages ────────────────────────────────────────────────────────
    //
    // In first-appearance order, appended after whatever the project already
    // has. ON CONFLICT DO NOTHING on the name so an import into a project that
    // already has these phases joins them rather than renaming them out from
    // under the existing tasks.
    const { rows: [{ next_order: baseOrder }] } = await client.query(
      `SELECT COALESCE(MAX(sort_order) FILTER (WHERE key <> 'custom'), 0) + 10 AS next_order
         FROM project_stages WHERE handover_id = $1 AND org_id = $2`,
      [handoverId, orgId]);

    const seen = [];
    for (const r of clean) {
      if (r.stageKey === 'custom' || seen.some(s => s.key === r.stageKey)) continue;
      seen.push({ key: r.stageKey, name: r.stageName });
    }

    let stagesCreated = 0;
    for (let i = 0; i < seen.length; i++) {
      const { rowCount } = await client.query(
        `INSERT INTO project_stages
           (handover_id, org_id, key, name, sort_order, source, created_by)
         VALUES ($1,$2,$3,$4,$5,'custom',$6)
         ON CONFLICT (handover_id, key) DO UPDATE
           SET is_active = TRUE, updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [handoverId, orgId, seen[i].key, seen[i].name, baseOrder + i * 10, userId]);
      if (rowCount) stagesCreated++;
    }

    // ── tasks ─────────────────────────────────────────────────────────
    //
    // sort_order continues from the end of each stage on the sparse 10-step
    // scale addPlay uses, so imported rows land after anything already there
    // and there is still room to insert between two of them afterwards.
    const { rows: tails } = await client.query(
      `SELECT stage_key, COALESCE(MAX(sort_order), 0) AS tail
         FROM project_play_instances
        WHERE handover_id = $1 AND org_id = $2
        GROUP BY stage_key`,
      [handoverId, orgId]);
    const tail = new Map(tails.map(t => [t.stage_key, Number(t.tail)]));

    const values = [];
    const params = [];
    clean.forEach((r) => {
      const next = (tail.get(r.stageKey) || 0) + 10;
      tail.set(r.stageKey, next);

      const baselineDue = (frozen && r.dueDate) ? r.dueDate : null;
      const p = params.length;
      params.push(handoverId, orgId, r.stageKey, r.title, r.description,
                  r.isGate, r.dueDate, next, r.ownerUserId,
                  baselineDue, baselineDue ? 'original' : null);
      values.push(
        `($${p + 1}, $${p + 2}, NULL, NULL, $${p + 3}, $${p + 4}, $${p + 5}, ` +
        `'internal_task', 'medium', 'parallel', $${p + 6}, $${p + 7}::date, 'created', ` +
        `$${p + 8}, 'not_started', $${p + 9}, $${p + 10}::date, $${p + 11}::text)`);
    });

    const { rows: created } = await client.query(
      `INSERT INTO project_play_instances
         (handover_id, org_id, playbook_id, play_id, stage_key, title, description,
          channel, priority, execution_type, is_gate, due_date, due_anchor,
          sort_order, status, owner_user_id, baseline_due_date, baseline_source)
       VALUES ${values.join(', ')}
       RETURNING id, title, stage_key`,
      params);

    await client.query('COMMIT');

    return {
      tasksCreated: created.length,
      stagesCreated,
      baselined: frozen,
      tasks: created.map(t => ({ playInstanceId: t.id, title: t.title, stageKey: t.stage_key })),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  preview,
  commit,
  PlanImportError,
  MAX_ROWS,
  // Exported for the harness: the duration reader and the working-day walk are
  // where the arithmetic actually lives, and they are worth testing without a
  // project in front of them.
  parseDuration,
  nextWorkingDay,
  isWorkingDay,
  addDays,
};
