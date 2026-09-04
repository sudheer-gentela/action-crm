// ─────────────────────────────────────────────────────────────────────────────
// routes/dailyWork.routes.js
//
// All routes are under /api/daily-work
//
// ── Member surface ───────────────────────────────────────────────────────────
// GET    /daily-work/day                     today (or ?date=) — open items + entries
// POST   /daily-work/day                     save the whole day, one call
// GET    /daily-work/tasks/:id                one project task: item, feed, window
// POST   /daily-work/tasks/:id/update         log against a project task
// GET    /daily-work/anchors                 what work can be anchored to
// POST   /daily-work/items                   create a work item
// GET    /daily-work/activity-types          the shared list, for every picker
// PATCH  /daily-work/items/:id                change an item's activity or anchor
// POST   /daily-work/activity-types          propose one ("Other" + a name)
// GET    /daily-work/entries/:id/evidence    everything attached, revoked included
// POST   /daily-work/entries/:id/evidence    attach a link or a sentence
// POST   /daily-work/evidence/:id/revoke     withdraw it, with a reason
// POST   /daily-work/evidence/:id/replace    withdraw and attach a correction
// GET    /daily-work/departments             for the manager's filter
//
// ── Setup, owner and admin only ──────────────────────────────────────────────
// GET    /daily-work/calendars               calendars with their dates
// POST   /daily-work/calendars               create one
// POST   /daily-work/calendars/:id/default   make it the org default
// DELETE /daily-work/calendars/:id           refused while anyone uses it
// POST   /daily-work/calendars/:id/dates     add holidays, many at once
// DELETE /daily-work/holidays/:id            remove one
// GET    /daily-work/schedules               who is on which week and calendar
// PUT    /daily-work/schedules/:userId       set a working week, effective-dated
// PUT    /daily-work/schedules/:userId/timezone   set it deliberately, not from a browser
//
// requireRole fails CLOSED on error, unlike requireModule. That asymmetry is
// right here: a database blip should not hand out the ability to change
// everyone's working days.
//
// ── Manager surface ──────────────────────────────────────────────────────────
// GET    /daily-work/team/log                one row per person per day
// GET    /daily-work/team/day-detail         the items behind one of those rows
// GET    /daily-work/team/rollup             one row per person for a period
// GET    /daily-work/team/account-summary    what was delivered to an account
// GET    /daily-work/team/stalled            assigned work with no movement
// GET    /daily-work/team/candidates         activity types awaiting a decision
// POST   /daily-work/items/assign            assign work to a report
// POST   /daily-work/activity-types/:key/promote
// POST   /daily-work/activity-types/:key/merge
//
// ── Gating ───────────────────────────────────────────────────────────────────
//
// requireModule('dailywork') resolves platform-allowed AND org-enabled AND
// user-granted, and an absent key denies by default with 404 rather than 403 —
// the feature is invisible, not forbidden. That means this file can ship before
// anyone is granted access and nothing changes for anyone.
//
// Known and deliberately unchanged: requireModule calls next() on infrastructure
// error, so it FAILS OPEN. That is existing behaviour across every module in
// this codebase and is not something to fix quietly in a feature commit. During
// the pilot it means a database blip shows the feature to everyone rather than
// to nobody.
//
// ── Scope ────────────────────────────────────────────────────────────────────
//
// Every team read is bounded by getVisibleUserIds — the viewer plus their
// manager chain. A client-supplied user id is INTERSECTED with that set, never
// trusted. Asking for someone outside your chain returns nothing rather than an
// error, because a 403 would confirm the person exists.
//
// ── Errors ───────────────────────────────────────────────────────────────────
//
// The services throw DailyWorkError with a code. Those map to 400 with the code
// and message intact, because the message is written for the person: "3
// characters too long — trim it, nothing is cut for you" is the actual UI copy.
// Anything without a code is a 500 with a generic message and the detail in the
// log, since an unexpected error may carry SQL or connection strings.

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

const dailyWork  = require('../services/dailyWork.service');
const dailyQuery = require('../services/dailyWorkQuery.service');
const dwDate     = require('../services/dailyWorkDate');
// Cross-module, for the People screen. Required at the top rather than lazily
// so a broken import fails at boot instead of on the first request. The two
// routes that use it degrade gracefully when the Projects module is off for an
// org — see _projectSideOrEmpty below.
const handoverService = require('../services/handover.service');
// Role resolver, for the vocabulary gate below. Same one handovers.routes uses
// for canManageStanding, so "manager and above" means one thing across both.
const projectSettings = require('../services/projectSettings.service');

router.use(authenticateToken, orgContext, requireModule('dailywork'));

/* ───────────────────────── helpers ─────────────────────────────────── */

function handle(res, err, context) {
  if (err && err.code && err.name === 'DailyWorkError') {
    return res.status(400).json({ error: err.message, code: err.code, details: err.details });
  }
  console.error(`dailyWork.routes ${context}:`, err && err.message);
  return res.status(500).json({ error: 'Something went wrong saving your work' });
}

/**
 * Ids arriving from a browser are strings, or absent, or nonsense. Postgres
 * would reject a malformed one with a type error that surfaces as a 500; this
 * turns it into a 400 the client can act on.
 */
function asId(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;   // undefined = malformed
}

/** A YYYY-MM-DD string, or null. Never a Date — see dailyWorkDate on why. */
function asDate(value) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/**
 * The filter set, validated. Unknown keys are dropped rather than passed
 * through, so a client cannot widen its own scope by inventing a filter.
 */
function readFilters(query) {
  const filters = {};
  if (query.account) filters.accountKey = String(query.account);
  if (query.anchorKind && query.anchorId) {
    filters.anchorKind = String(query.anchorKind);
    filters.anchorId = asId(query.anchorId);
  }
  if (query.activity) filters.activityKey = String(query.activity);
  if (query.department) filters.departmentTeamId = asId(query.department);
  return filters;
}

/**
 * Bound a requested scope by what the viewer may actually see.
 *
 * Intersection, not validation: asking for someone outside your chain yields an
 * empty result, which tells the caller nothing about whether that person exists.
 */
async function scopeUserIds(orgId, viewerId, requested) {
  const visible = await dailyQuery.getVisibleUserIds(orgId, viewerId);
  if (!requested) return visible;
  const wanted = (Array.isArray(requested) ? requested : String(requested).split(','))
    .map(asId).filter(Boolean);
  return visible.filter(id => wanted.includes(id));
}

/* ───────────────────────── member surface ──────────────────────────── */

router.get('/day', async (req, res) => {
  try {
    const date = asDate(req.query.date);
    if (date === undefined) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const day = await dailyWork.getDay(req.orgId, req.userId, { date });
    // Told to the client rather than hardcoded there, so the window is defined
    // in one place. The UI uses it to bound its date navigation; the service
    // still enforces it on save, because a bound the client is told is a bound
    // the client can ignore.
    res.json({ ...day, backfillDays: dailyWork.BACKFILL_DAYS });
  } catch (err) { handle(res, err, 'GET /day'); }
});

router.post('/day', async (req, res) => {
  try {
    const { entries } = req.body || {};
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: 'entries must be a list', code: 'BAD_BODY' });
    }
    const date = asDate(req.body?.date);
    if (date === undefined) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    // asOf is still NOT taken from the body, and that is the whole design.
    // The client may now propose which DAY the work belongs to, but "today"
    // is resolved server-side in the owner's timezone, and saveDay measures
    // the proposal against it — so a browser cannot widen its own window by
    // lying about the clock, only choose a day inside a window the server
    // computed. Omit date entirely and it means today, exactly as before.
    const saved = await dailyWork.saveDay(req.orgId, req.userId, entries.map(e => ({
      itemId: asId(e.itemId),
      description: e.description,
      nextSteps: e.nextSteps,
      dayStage: e.dayStage,
    })), { date });
    res.json(saved);
  } catch (err) { handle(res, err, 'POST /day'); }
});

/* ─────────────── task-linked daily work (2026_136) ─────────────────── */

/**
 * Who may log work against a project task.
 *
 * DELEGATED to handover.service.getNoteVisibility — the same resolver that
 * decides who may post a note on that task: people on the project, or their
 * manager. Two rules for "may I write against this task" would drift, and the
 * one that drifted would be this one, because it is the newer of the two and
 * lives in another module.
 *
 * Fails CLOSED, and fails closed on a MISSING projects module too: if
 * handover.service throws — the module is off, the table is gone — nobody
 * gets a composer. That is the opposite posture from _projectSideOrEmpty
 * below, which degrades a READ to an empty list. A read that quietly returns
 * nothing is a smaller wrong than a write that quietly proceeds.
 */
async function _canLogAgainstTask(orgId, userId, handoverId) {
  try {
    const { canNote } = await handoverService.getNoteVisibility(handoverId, orgId, userId);
    return canNote === true;
  } catch (err) {
    console.warn('[dailywork] task permission check unavailable:', err.message);
    return false;
  }
}

// ── GET /tasks/:playInstanceId — the composer's state ───────────────────────
//
// Returns the task, this person's item if they have one, every update posted
// against the task, and the date window. One call, because the composer needs
// all of it before it can render a single field.
//
// Deliberately answers for a CLOSED task and a closed project as well. Reading
// what happened on finished work is the reviewing case, and it is the one that
// matters most; `canPost` is what the composer keys on, and it carries both
// halves — the work is still open AND you are allowed to write.
router.get('/tasks/:playInstanceId', async (req, res) => {
  try {
    const playInstanceId = asId(req.params.playInstanceId);
    if (!playInstanceId) {
      return res.status(400).json({ error: 'playInstanceId must be a positive integer' });
    }

    const state = await dailyWork.getTaskWork(req.orgId, req.userId, playInstanceId);
    const permitted = await _canLogAgainstTask(req.orgId, req.userId, state.task.handoverId);

    if (!permitted) {
      // Not a 403. The person can see this task on the project already — what
      // they cannot do is write against it, and the composer needs to know
      // that without losing the feed it was going to render underneath.
      return res.json({ ...state, canPost: false, canRead: true });
    }
    res.json({ ...state, canRead: true });
  } catch (err) { handle(res, err, 'GET /tasks/:playInstanceId'); }
});

// ── POST /tasks/:playInstanceId/update — the one write path ────────────────
//
// Called from BOTH entry points: the composer on the project task, and the
// composer on the My project work card in My day. Neither is the real one —
// two endpoints would mean two chances for the rules to differ.
//
// asOf is not taken from the body, for the same reason as POST /day: the
// client may propose which DAY the work belongs to, but "today" is resolved
// server-side in the owner's timezone.
router.post('/tasks/:playInstanceId/update', async (req, res) => {
  try {
    const playInstanceId = asId(req.params.playInstanceId);
    if (!playInstanceId) {
      return res.status(400).json({ error: 'playInstanceId must be a positive integer' });
    }
    const date = asDate(req.body?.date);
    if (date === undefined) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    // Resolved before the write so the permission check has a handover id to
    // ask about, and so a closed task or project is refused with its own
    // sentence rather than a permission one.
    const task = await dailyWork.getTaskForUpdate(req.orgId, playInstanceId);

    if (!(await _canLogAgainstTask(req.orgId, req.userId, task.handover_id))) {
      return res.status(403).json({
        error: 'Only people on this project, or their manager, can log work against its tasks',
        code: 'NOT_ON_PROJECT',
      });
    }

    const saved = await dailyWork.postTaskUpdate(req.orgId, req.userId, {
      playInstanceId,
      description: req.body?.description,
      nextSteps:   req.body?.nextSteps,
      dayStage:    req.body?.dayStage,
      date,
    });
    res.json(saved);
  } catch (err) { handle(res, err, 'POST /tasks/:playInstanceId/update'); }
});

router.get('/anchors', async (req, res) => {
  try {
    res.json(await dailyWork.getAnchorOptions(req.orgId));
  } catch (err) { handle(res, err, 'GET /anchors'); }
});

router.post('/items', async (req, res) => {
  try {
    const b = req.body || {};
    const anchorId = asId(b.anchorId);
    if (anchorId === undefined) return res.status(400).json({ error: 'anchorId must be an id' });
    const targetDate = asDate(b.targetDate);
    if (targetDate === undefined) return res.status(400).json({ error: 'targetDate must be YYYY-MM-DD' });

    // 2026_140. The day the composer is open on, so an item added while
    // backfilling opens on THAT day rather than today — and then passes
    // saveDay's "did not exist yet" check for the entry it was created for.
    // asDate returns undefined on a malformed value and null on absence, so
    // the explicit undefined test rejects junk instead of silently ignoring it.
    const openedOn = asDate(b.openedOn);
    if (openedOn === undefined) {
      return res.status(400).json({ error: 'openedOn must be YYYY-MM-DD' });
    }

    const item = await dailyWork.createItem(req.orgId, req.userId, {
      kind: b.kind,
      title: b.title,
      activityTypeKey: b.activityTypeKey || null,
      anchorKind: b.anchorKind || null,
      anchorId,
      targetDate,
      openedOn,
    });
    res.status(201).json(item);
  } catch (err) { handle(res, err, 'POST /items'); }
});

router.get('/activity-types', async (req, res) => {
  try {
    // Candidates are included and flagged. Someone who proposed a type must be
    // able to keep using it while it waits — a proposal that stops working
    // until a manager looks at it is a proposal nobody makes twice.
    res.json(await dailyWork.listActivityTypes(req.orgId, {
      includeCandidates: req.query.candidates !== 'false',
      includeRetired: req.query.retired === 'true',
    }));
  } catch (err) { handle(res, err, 'GET /activity-types'); }
});

router.patch('/items/:id', async (req, res) => {
  try {
    const itemId = asId(req.params.id);
    if (!itemId) return res.status(400).json({ error: 'bad item id' });

    const b = req.body || {};
    const patch = {};
    // Only keys actually present are patched. Sending undefined for the rest
    // is what lets the service tell "clear this" from "leave it alone".
    if ('title' in b) patch.title = b.title;
    if ('activityTypeKey' in b) patch.activityTypeKey = b.activityTypeKey;
    if ('anchorKind' in b || 'anchorId' in b) {
      const anchorId = asId(b.anchorId);
      if (anchorId === undefined) return res.status(400).json({ error: 'anchorId must be an id' });
      patch.anchorKind = b.anchorKind || null;
      patch.anchorId = anchorId;
    }
    if ('targetDate' in b) {
      const targetDate = asDate(b.targetDate);
      if (targetDate === undefined) return res.status(400).json({ error: 'targetDate must be YYYY-MM-DD' });
      patch.targetDate = targetDate;
    }

    res.json(await dailyWork.updateItem(req.orgId, req.userId, itemId, patch));
  } catch (err) { handle(res, err, 'PATCH /items/:id'); }
});

router.post('/activity-types', async (req, res) => {
  try {
    res.status(201).json(
      await dailyWork.proposeActivityType(req.orgId, req.userId, (req.body || {}).label));
  } catch (err) { handle(res, err, 'POST /activity-types'); }
});

router.get('/entries/:id/evidence', async (req, res) => {
  try {
    const entryId = asId(req.params.id);
    if (!entryId) return res.status(400).json({ error: 'bad entry id' });
    res.json(await dailyWork.listEvidence(req.orgId, req.userId, entryId));
  } catch (err) { handle(res, err, 'GET /entries/:id/evidence'); }
});

router.post('/evidence/:id/revoke', async (req, res) => {
  try {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad evidence id' });
    res.json(await dailyWork.revokeEvidence(req.orgId, req.userId, id, (req.body || {}).reason));
  } catch (err) { handle(res, err, 'POST /evidence/:id/revoke'); }
});

router.post('/evidence/:id/replace', async (req, res) => {
  try {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad evidence id' });
    const b = req.body || {};
    res.json(await dailyWork.replaceEvidence(req.orgId, req.userId, id, {
      note: b.note, reason: b.reason, channel: b.channel || 'manual',
    }));
  } catch (err) { handle(res, err, 'POST /evidence/:id/replace'); }
});

router.get('/departments', async (req, res) => {
  try {
    res.json(await dailyWork.listDepartments(req.orgId));
  } catch (err) { handle(res, err, 'GET /departments'); }
});

router.post('/entries/:id/evidence', async (req, res) => {
  try {
    const entryId = asId(req.params.id);
    if (!entryId) return res.status(400).json({ error: 'bad entry id' });
    const b = req.body || {};
    res.status(201).json(await dailyWork.attachEvidence(req.orgId, req.userId, {
      entryId,
      note: b.note,
      channel: b.channel || 'manual',
      storageFileId: asId(b.storageFileId) || null,
    }));
  } catch (err) { handle(res, err, 'POST /entries/:id/evidence'); }
});

/* ───────────────────────── manager surface ─────────────────────────── */

/**
 * Every team read shares the same window handling, so a missing range cannot
 * silently mean "everything ever" on one endpoint and "today" on another.
 * Default is the last seven days ending today, in the VIEWER's timezone.
 */
async function readWindow(req) {
  const from = asDate(req.query.from);
  const to   = asDate(req.query.to);
  if (from === undefined || to === undefined) return { bad: true };

  if (from && to) return { from, to };

  const { pool } = require('../config/database');
  const tz = await dwDate.resolveTimezone(
    (sql, params) => pool.query(sql, params), req.orgId, req.userId);
  const today = dwDate.localDate(tz);
  const dates = dwDate.eachDate(
    new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10), today);
  return { from: dates[0], to: today };
}

/**
 * Run a project-side lookup, or fall back to nothing.
 *
 * The People screen belongs to Daily Work and must work in an org that has no
 * Projects module — those rows simply have no project column. Wrapping rather
 * than checking the module flag keeps this true even if the projects tables are
 * present but empty, or a query changes shape later.
 *
 * The failure is logged, never surfaced: a person's logging record is the point
 * of this screen and it should not go blank because the project half broke.
 */
async function _projectSideOrEmpty(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[dailywork] project-side ${label} unavailable:`, err.message);
    return fallback;
  }
}

// ── GET /people — the combined list ──────────────────────────────────────────
//
// One row per person the viewer may see, carrying both halves: the logging
// record from daily work and the open project work owed. This is the screen
// that replaced "My team".
//
// Scope is unchanged — scopeUserIds intersects with the manager chain, so a
// person outside it yields nothing rather than an error. The project side is
// then looked up for exactly that set, never wider: project tasks are more
// broadly visible than daily work descriptions, and this screen must not become
// the way around the tighter of the two boundaries.
router.get('/people', async (req, res) => {
  try {
    const win = await readWindow(req);
    if (win.bad) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });

    const userIds = await scopeUserIds(req.orgId, req.userId, req.query.users);
    const filters = readFilters(req.query);

    // A SECOND, WIDER WINDOW, always the same regardless of the selected period.
    //
    // The rollup is computed over the window being VIEWED, so on the day tab
    // everyone reads "0 of 1 days" — technically true and useless. What tells
    // you whether someone is keeping up is their record over a few weeks, and
    // that has to stay on screen while you are looking at a single day.
    //
    // Trailing 28 calendar days ending at the window's end, not "last 20
    // working days": working days are per-person, since schedules and holiday
    // calendars differ, so a fixed calendar span is the only span that means
    // the same thing for everyone. getRollup turns it into each person's own
    // working-day count from their own calendar.
    const trailingFrom = dwDate.addDays(win.to, -27);

    const [rollup, trailing, departments, workload] = await Promise.all([
      dailyQuery.getRollup(req.orgId, { userIds, from: win.from, to: win.to, filters }),
      // 2026_140: slim. Two integers per person are read off this — see
      // trailingBy below — and it was building and serialising a full 28-day
      // strip, four arrays and a name for each of them to produce them.
      dailyQuery.getRollup(req.orgId, {
        userIds, from: trailingFrom, to: win.to, filters, slim: true }),
      dailyQuery.getDepartmentsByUser(req.orgId, userIds),
      _projectSideOrEmpty('workload',
        () => handoverService.getProjectWorkloadByUser(req.orgId, userIds),
        new Map()),
    ]);

    const trailingBy = new Map(trailing.map(t => [t.user_id, t]));

    res.json({
      ...win,
      // projectsAvailable lets the client hide the two project columns entirely
      // rather than render a row of zeros that reads as "nothing assigned".
      projectsAvailable: workload.size > 0 || userIds.length === 0,
      trailingFrom,
      people: rollup.map(p => {
        const t = trailingBy.get(p.user_id) || {};
        return {
          ...p,
          department: departments.get(p.user_id) || null,
          // Namespaced rather than overwriting days_logged: the row shows the
          // viewed window AND the trailing record, and a reader has to be able
          // to tell which number answers which question.
          trailing_days_logged:  t.days_logged  ?? null,
          trailing_working_days: t.working_days ?? null,
          trailing_rate:         t.rate ?? null,
          ...(workload.get(p.user_id) || { openTasks: 0, overdueTasks: 0 }),
        };
      }),
    });
  } catch (err) { handle(res, err, 'GET /people'); }
});

// ── GET /people/overdue — the queue behind the overdue chip ──────────────────
//
// Same visible set as GET /people, so the queue can never show work belonging
// to someone whose row the manager cannot see on the list above it.
//
// Returns userId and NO NAME. The caller is the People screen, which already
// holds first_name and last_name for every visible person in the rollup it
// rendered the list from. Joining users again here would be a second source
// for the same string, and the two would eventually disagree on someone who
// had just been renamed.
//
// Declared BEFORE '/people/:userId'. Express matches in order, and with the
// parameterised route first 'overdue' would be captured as a :userId, asId
// would reject it, and this would 400 instead of ever running — the same
// hazard the plays/reorder route documents in handovers.routes.js.
router.get('/people/overdue', async (req, res) => {
  try {
    const userIds = await dailyQuery.getVisibleUserIds(req.orgId, req.userId);
    const items = await _projectSideOrEmpty('overdue queue',
      () => handoverService.getOverdueProjectItemsByUsers(req.orgId, userIds), []);
    res.json({ items });
  } catch (err) { handle(res, err, 'GET /people/overdue'); }
});

// ── GET /people/:userId/project/:handoverId — is this link still honest? ─────
//
// Called when a manager clicks a project task on someone's timeline, before
// navigating to Projects.
//
// WHAT THIS IS NOT. It is not an access gate. GET /sales/:id is org-scoped
// with no membership check, so anyone in the org can already fetch any project
// by id; the scope filtering on the Projects board is a view convenience, not
// a security boundary. Nothing here unlocks data that was previously out of
// reach, and no permission was widened to add this.
//
// WHAT IT IS. The link is offered on a DERIVED basis: you may open this
// project because this person, who is in your team, has an open task on it.
// That basis can evaporate between the page loading and the click — the task
// gets reassigned, completed, the project is retired or cancelled. When it
// does, the honest answer is to say why rather than to open a project the
// reason for opening no longer applies to.
//
// The two checks mirror the two halves of that sentence:
//
//   1. getVisibleUserIds — the same check GET /people/:userId already runs.
//      If you are not allowed to see that this person has the task, you are
//      not being handed a link because of it.
//   2. the project is in THIS PERSON's items. getPersonProjectLink asks that
//      question directly, about this one project, using the same predicates
//      the People screen's rows are drawn with — so every one of the ways the
//      basis can lapse is covered by one shared rule rather than by a second
//      list of conditions here that would drift from it.
//
//      It used to fetch the person's ENTIRE item list and search it. That was
//      airtight and unpageable: the moment the display list is paged, a project
//      on page two is genuinely there and the validator cannot see it, so the
//      click is refused with a message that reads exactly like the truthful
//      refusal. Split in 2026_139; the shared predicates in handover.service
//      are what keeps the two honest.
//
//      NOTE the commitment half does not test project status — that is
//      pre-existing behaviour, documented at OPEN_COMMITMENT_PREDICATES, and
//      the sentence above is not true for a commitment on a completed project.
//      Preserved deliberately so the link keeps matching what is on screen.
//
// Returns the scope segment too, because the caller has to know which board
// tab to land on and only the tracking mode decides that.
router.get('/people/:userId/project/:handoverId', async (req, res) => {
  try {
    const target = asId(req.params.userId);
    const handoverId = asId(req.params.handoverId);
    if (!target || !handoverId) {
      return res.status(400).json({ error: 'userId and handoverId must be positive integers' });
    }

    const visible = await dailyQuery.getVisibleUserIds(req.orgId, req.userId);
    if (!visible.includes(target)) {
      // Same shape as the refusals below rather than a 403 with no body: the
      // client renders `reason` verbatim, so every path has to carry one.
      return res.status(403).json({
        ok: false,
        reason: 'They are not in your team any more, so this link no longer applies.',
      });
    }

    const match = await handoverService.getPersonProjectLink(target, req.orgId, handoverId);
    if (!match) {
      return res.status(403).json({
        ok: false,
        reason: 'This task is no longer open and assigned to them — it may have been '
              + 'reassigned or completed, or the project closed or retired.',
      });
    }

    res.json({
      ok: true,
      handoverId,
      // 'initiatives' and 'assigned' are the hash words HandoverView parses,
      // not internal names. Decided here because tracking_mode is a server
      // fact and the client should not be re-deriving which tab a project
      // lives on from a boolean.
      scope: match.isStanding ? 'initiatives' : 'assigned',
      project: match.project,
      title: match.title,
    });
  } catch (err) { handle(res, err, 'GET /people/:userId/project/:handoverId'); }
});

// ── GET /people/:userId — one person, both halves ────────────────────────────
//
// The full-page person view. Returns the daily work log and the project items
// separately, each carrying its own date, and lets the client interleave them.
//
// NOT merged server-side on purpose. A daily work entry is anchored to the day
// it was DONE; a project task is anchored to the day it is DUE. Those are
// different meanings, and flattening them into one sorted list here would throw
// away the distinction the client needs to label them.
// ── GET /people/:userId/task-updates — what they logged against their tasks ──
//
// 2026_140. daily_work_items.play_instance_id has been written since 2026_136
// and read by nothing. This is the read.
//
// Scoped by getVisibleUserIds, exactly like every other /people route here —
// NOT by the wider project-authority rule the Projects module uses. The two
// modules bound team reads differently on purpose, and quietly widening one of
// them through a new endpoint is how a boundary stops meaning anything. A
// project manager who is not in the reporting line reads this person's work on
// the Projects side, where that rule lives.
//
// Task ids come from the caller rather than being derived here: the client
// already has the person's task list on screen, and re-deriving it server-side
// would be a second definition of "their open work" that could disagree with
// the one the rows were drawn from.
router.get('/people/:userId/task-updates', async (req, res) => {
  try {
    const target = asId(req.params.userId);
    if (!target) return res.status(400).json({ error: 'userId must be a positive integer' });

    const visible = await dailyQuery.getVisibleUserIds(req.orgId, req.userId);
    if (!visible.includes(target)) return res.json({ byTask: {} });

    const ids = String(req.query.plays || '')
      .split(',').map(x => asId(x)).filter(Boolean);
    // Bounded so a hand-built URL cannot ask for an unbounded array. A plan of
    // 49 tasks is the case this serves; 200 is generous for it.
    if (ids.length > 200) {
      return res.status(400).json({ error: 'too many task ids — send at most 200' });
    }

    res.json({ byTask: await dailyQuery.getTaskUpdates(req.orgId, target, ids) });
  } catch (err) { handle(res, err, 'GET /people/:userId/task-updates'); }
});

router.get('/people/:userId', async (req, res) => {
  try {
    const target = asId(req.params.userId);
    if (!target) return res.status(400).json({ error: 'userId must be a positive integer' });

    const visible = await dailyQuery.getVisibleUserIds(req.orgId, req.userId);
    if (!visible.includes(target)) return res.json({ log: [], projectItems: [], projects: [] });

    const win = await readWindow(req);
    if (win.bad) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });

    // 2026_140. Two new switches, both defaulting to what this route did
    // before, so the People screen's own callers are unaffected.
    //
    //   includeClosed — also return completed and dropped work
    //   window        — whether the date range narrows the WORK tables too, or
    //                   only the daily log
    //
    // The window applies to target_date / due_date, which is a different axis
    // from the entry_date the log is filtered on. That is the point: "what is
    // due this week" and "what was logged this week" are the two questions this
    // page answers, and they were being answered with one date.
    const includeClosed = req.query.includeClosed === 'true';
    const windowWork    = req.query.windowWork !== 'false';
    const workRange     = windowWork ? { from: win.from, to: win.to } : {};

    const [log, assigned, assignedOutside, projectSide] = await Promise.all([
      dailyQuery.getLog(req.orgId, {
        userIds: [target], from: win.from, to: win.to, filters: readFilters(req.query) }),
      dailyQuery.getAssignedItems(req.orgId, target, { ...workRange, includeClosed }),
      // Only meaningful when the window is narrowing something. Skipped
      // otherwise rather than returning a misleading zero.
      windowWork ? dailyQuery.countAssignedOutside(req.orgId, target, workRange) : 0,
      _projectSideOrEmpty('person items', async () => ({
        projectItems: await handoverService.getPersonProjectItems(target, req.orgId,
          { ...workRange, includeClosed }),
        projectItemsOutside: windowWork
          ? await handoverService.countPersonProjectItemsOutside(target, req.orgId, workRange)
          : 0,
        projects: (await handoverService.getTeamMemberProjects(target, req.orgId))
          .filter(p => !p.isRetired),
      }), { projectItems: [], projectItemsOutside: 0, projects: [] }),
    ]);

    res.json({ ...win, log, assigned, assignedOutside, includeClosed, windowWork, ...projectSide });
  } catch (err) { handle(res, err, 'GET /people/:userId'); }
});

router.get('/team/log', async (req, res) => {
  try {
    const win = await readWindow(req);
    if (win.bad) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    const userIds = await scopeUserIds(req.orgId, req.userId, req.query.users);
    res.json({
      ...win,
      rows: await dailyQuery.getLog(req.orgId, {
        userIds, from: win.from, to: win.to, filters: readFilters(req.query) }),
    });
  } catch (err) { handle(res, err, 'GET /team/log'); }
});

router.get('/team/day-detail', async (req, res) => {
  try {
    const userId = asId(req.query.user);
    const date = asDate(req.query.date);
    if (!userId || !date) return res.status(400).json({ error: 'user and date are required' });

    // Scope first. Without this, any id in the query string would read anyone's
    // description, which is Tier 2 content.
    const visible = await dailyQuery.getVisibleUserIds(req.orgId, req.userId);
    if (!visible.includes(userId)) return res.json([]);

    res.json(await dailyQuery.getDayDetail(req.orgId, userId, date, readFilters(req.query)));
  } catch (err) { handle(res, err, 'GET /team/day-detail'); }
});

router.get('/team/rollup', async (req, res) => {
  try {
    const win = await readWindow(req);
    if (win.bad) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    const userIds = await scopeUserIds(req.orgId, req.userId, req.query.users);
    res.json({
      ...win,
      rows: await dailyQuery.getRollup(req.orgId, {
        userIds, from: win.from, to: win.to, filters: readFilters(req.query) }),
    });
  } catch (err) { handle(res, err, 'GET /team/rollup'); }
});

router.get('/team/account-summary', async (req, res) => {
  try {
    const win = await readWindow(req);
    if (win.bad) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    if (!req.query.account) return res.status(400).json({ error: 'account is required' });
    const userIds = await scopeUserIds(req.orgId, req.userId, req.query.users);
    res.json(await dailyQuery.getAccountSummary(req.orgId, {
      accountKey: String(req.query.account), userIds, from: win.from, to: win.to }));
  } catch (err) { handle(res, err, 'GET /team/account-summary'); }
});

router.get('/team/stalled', async (req, res) => {
  try {
    const userIds = await scopeUserIds(req.orgId, req.userId, req.query.users);
    const { pool } = require('../config/database');
    const tz = await dwDate.resolveTimezone(
      (sql, params) => pool.query(sql, params), req.orgId, req.userId);
    const staleDays = Number(req.query.staleDays);
    res.json(await dailyQuery.getStalledAssigned(req.orgId, {
      userIds,
      asOfDate: dwDate.localDate(tz),
      staleDays: Number.isInteger(staleDays) && staleDays > 0 ? staleDays : 3,
    }));
  } catch (err) { handle(res, err, 'GET /team/stalled'); }
});

router.get('/team/candidates', async (req, res) => {
  try {
    res.json(await dailyQuery.getCandidateActivityTypes(req.orgId));
  } catch (err) { handle(res, err, 'GET /team/candidates'); }
});

router.post('/items/assign', async (req, res) => {
  try {
    const b = req.body || {};
    const ownerUserId = asId(b.ownerUserId);
    if (!ownerUserId) return res.status(400).json({ error: 'ownerUserId is required' });

    // You may only assign work to someone in your own chain.
    const visible = await dailyQuery.getVisibleUserIds(req.orgId, req.userId);
    if (!visible.includes(ownerUserId)) {
      return res.status(403).json({ error: 'That person does not report to you' });
    }

    const anchorId = asId(b.anchorId);
    if (anchorId === undefined) return res.status(400).json({ error: 'anchorId must be an id' });
    const targetDate = asDate(b.targetDate);
    if (targetDate === undefined) return res.status(400).json({ error: 'targetDate must be YYYY-MM-DD' });

    res.status(201).json(await dailyWork.assignItem(req.orgId, req.userId, {
      ownerUserId,
      kind: b.kind || 'assigned',
      title: b.title,
      activityTypeKey: b.activityTypeKey || null,
      anchorKind: b.anchorKind || null,
      anchorId,
      targetDate,
    }));
  } catch (err) { handle(res, err, 'POST /items/assign'); }
});

/**
 * Who may reshape the org's shared activity vocabulary: manager and above.
 *
 * Promote and merge had NO gate at all — any member could accept a candidate
 * into the shared list, or fold one type into another and move every entry
 * with it. That is org-wide vocabulary being edited by anyone, and merge in
 * particular is destructive in a way a member cannot undo.
 *
 * Same rule and same idiom as canManageStanding in handovers.routes: there is
 * no 'manager' role, so management is a position in org_hierarchy. And the
 * same failure direction — orgContext leaves subordinateIds empty when the
 * hierarchy lookup errors, so a blip narrows this to owners and admins rather
 * than opening it to everyone.
 */
async function canManageVocabulary(req) {
  // Role is resolved, not read off req: orgContext sets req.orgId and
  // req.subordinateIds and nothing else. Same resolver canManageStanding uses,
  // so the two gates cannot come to disagree about who counts as an admin.
  const role = await projectSettings.resolveRole(req.orgId, req.userId);
  if (['owner', 'admin'].includes(role)) return true;
  return (req.subordinateIds || []).length > 0;
}

async function requireVocabularyManager(req, res) {
  if (await canManageVocabulary(req)) return true;
  res.status(403).json({
    error: 'Only a manager, admin or owner can change the shared activity list',
  });
  return false;
}

// Add straight to the shared list. Distinct from POST /activity-types, which
// is the member's "Other" path and always yields a candidate.
router.post('/activity-types/manage', async (req, res) => {
  try {
    if (!(await requireVocabularyManager(req, res))) return;
    res.status(201).json(
      await dailyWork.createActivityType(req.orgId, req.userId, (req.body || {}).label));
  } catch (err) { handle(res, err, 'POST /activity-types/manage'); }
});

router.patch('/activity-types/:key', async (req, res) => {
  try {
    if (!(await requireVocabularyManager(req, res))) return;
    const b = req.body || {};

    // Rename and retire are separate operations on purpose. A single PATCH
    // that did both would have to decide what "rename a retired type" means,
    // and the screen never asks for both at once.
    if (typeof b.label === 'string') {
      return res.json(await dailyWork.renameActivityType(req.orgId, req.params.key, b.label));
    }
    if (typeof b.retired === 'boolean') {
      return res.json(
        await dailyWork.setActivityTypeRetired(req.orgId, req.params.key, b.retired));
    }
    res.status(400).json({ error: 'Send either label (to rename) or retired (to retire)' });
  } catch (err) { handle(res, err, 'PATCH /activity-types/:key'); }
});

router.post('/activity-types/:key/promote', async (req, res) => {
  try {
    if (!(await requireVocabularyManager(req, res))) return;
    res.json(await dailyWork.promoteActivityType(req.orgId, req.userId, req.params.key));
  } catch (err) { handle(res, err, 'POST /activity-types/:key/promote'); }
});

router.post('/activity-types/:key/merge', async (req, res) => {
  try {
    if (!(await requireVocabularyManager(req, res))) return;
    const intoKey = (req.body || {}).intoKey;
    if (!intoKey) return res.status(400).json({ error: 'intoKey is required' });
    res.json(await dailyWork.mergeActivityType(req.orgId, req.userId, req.params.key, intoKey));
  } catch (err) { handle(res, err, 'POST /activity-types/:key/merge'); }
});

/* ───────────────────────── setup: calendars ────────────────────────── */
//
// Holiday calendars and working weeks decide the denominator of every rate in
// this module. Changing one silently restates figures people have already been
// shown, so this is owner and admin only — not merely anyone with reports.

const adminOnly = requireRole('owner', 'admin');

router.get('/calendars', adminOnly, async (req, res) => {
  try {
    res.json(await dailyWork.listCalendars(req.orgId));
  } catch (err) { handle(res, err, 'GET /calendars'); }
});

router.post('/calendars', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    res.status(201).json(await dailyWork.createCalendar(req.orgId, req.userId, {
      name: b.name, isDefault: !!b.isDefault,
    }));
  } catch (err) { handle(res, err, 'POST /calendars'); }
});

router.post('/calendars/:id/default', adminOnly, async (req, res) => {
  try {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad calendar id' });
    res.json(await dailyWork.setDefaultCalendar(req.orgId, id));
  } catch (err) { handle(res, err, 'POST /calendars/:id/default'); }
});

router.delete('/calendars/:id', adminOnly, async (req, res) => {
  try {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad calendar id' });
    res.json(await dailyWork.deleteCalendar(req.orgId, id));
  } catch (err) { handle(res, err, 'DELETE /calendars/:id'); }
});

router.post('/calendars/:id/dates', adminOnly, async (req, res) => {
  try {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad calendar id' });
    const dates = (req.body || {}).dates;
    res.json(await dailyWork.addHolidays(req.orgId, id, dates));
  } catch (err) { handle(res, err, 'POST /calendars/:id/dates'); }
});

router.delete('/holidays/:id', adminOnly, async (req, res) => {
  try {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad holiday id' });
    res.json(await dailyWork.removeHoliday(req.orgId, id));
  } catch (err) { handle(res, err, 'DELETE /holidays/:id'); }
});

router.get('/schedules', adminOnly, async (req, res) => {
  try {
    res.json(await dailyWork.listSchedules(req.orgId));
  } catch (err) { handle(res, err, 'GET /schedules'); }
});

// ── setup: readiness and bulk provisioning ──────────────────────────────
//
// Declared BEFORE the /schedules/:userId handlers. Express matches in order,
// and although these are POSTs against PUTs today, a future PUT /schedules/bulk
// would otherwise be swallowed by :userId and try to parse "bulk" as an id.

router.get('/setup/readiness', adminOnly, async (req, res) => {
  try {
    res.json(await dailyWork.getSetupReadiness(req.orgId));
  } catch (err) { handle(res, err, 'GET /setup/readiness'); }
});

router.post('/schedules/bulk', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await dailyWork.bulkSetSchedules(req.orgId, req.userId, {
      weekdayMask: Number(b.weekdayMask),
      holidayCalendarId: asId(b.holidayCalendarId) || null,
      effectiveFrom: b.effectiveFrom,
    }));
  } catch (err) { handle(res, err, 'POST /schedules/bulk'); }
});

router.post('/schedules/timezone/bulk', adminOnly, async (req, res) => {
  try {
    res.json(await dailyWork.bulkSetTimezone(req.orgId, (req.body || {}).timezone));
  } catch (err) { handle(res, err, 'POST /schedules/timezone/bulk'); }
});

router.put('/schedules/:userId/timezone', adminOnly, async (req, res) => {
  try {
    const userId = asId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'bad user id' });
    res.json(await dailyWork.setUserTimezone(req.orgId, userId, (req.body || {}).timezone));
  } catch (err) { handle(res, err, 'PUT /schedules/:userId/timezone'); }
});

router.put('/schedules/:userId', adminOnly, async (req, res) => {
  try {
    const userId = asId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'bad user id' });
    const b = req.body || {};
    res.json(await dailyWork.setSchedule(req.orgId, userId, req.userId, {
      weekdayMask: Number(b.weekdayMask),
      holidayCalendarId: asId(b.holidayCalendarId) || null,
      effectiveFrom: b.effectiveFrom,
    }));
  } catch (err) { handle(res, err, 'PUT /schedules/:userId'); }
});

module.exports = router;
