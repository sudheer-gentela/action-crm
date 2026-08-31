// ─────────────────────────────────────────────────────────────────────────────
// routes/dailyWork.routes.js
//
// All routes are under /api/daily-work
//
// ── Member surface ───────────────────────────────────────────────────────────
// GET    /daily-work/day                     today (or ?date=) — open items + entries
// POST   /daily-work/day                     save the whole day, one call
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
    res.json(day);
  } catch (err) { handle(res, err, 'GET /day'); }
});

router.post('/day', async (req, res) => {
  try {
    const { entries } = req.body || {};
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: 'entries must be a list', code: 'BAD_BODY' });
    }
    // asOf is NOT taken from the body. The entry date is the owner's local
    // date resolved server-side; accepting it from the client would let a
    // browser choose which day its work counted for.
    const saved = await dailyWork.saveDay(req.orgId, req.userId, entries.map(e => ({
      itemId: asId(e.itemId),
      description: e.description,
      nextSteps: e.nextSteps,
      dayStage: e.dayStage,
    })));
    res.json(saved);
  } catch (err) { handle(res, err, 'POST /day'); }
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

    const item = await dailyWork.createItem(req.orgId, req.userId, {
      kind: b.kind,
      title: b.title,
      activityTypeKey: b.activityTypeKey || null,
      anchorKind: b.anchorKind || null,
      anchorId,
      targetDate,
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

    const [rollup, workload] = await Promise.all([
      dailyQuery.getRollup(req.orgId, { userIds, from: win.from, to: win.to, filters }),
      _projectSideOrEmpty('workload',
        () => handoverService.getProjectWorkloadByUser(req.orgId, userIds),
        new Map()),
    ]);

    res.json({
      ...win,
      // projectsAvailable lets the client hide the two project columns entirely
      // rather than render a row of zeros that reads as "nothing assigned".
      projectsAvailable: workload.size > 0 || userIds.length === 0,
      people: rollup.map(p => ({
        ...p,
        ...(workload.get(p.user_id) || { openTasks: 0, overdueTasks: 0 }),
      })),
    });
  } catch (err) { handle(res, err, 'GET /people'); }
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
router.get('/people/:userId', async (req, res) => {
  try {
    const target = asId(req.params.userId);
    if (!target) return res.status(400).json({ error: 'userId must be a positive integer' });

    const visible = await dailyQuery.getVisibleUserIds(req.orgId, req.userId);
    if (!visible.includes(target)) return res.json({ log: [], projectItems: [], projects: [] });

    const win = await readWindow(req);
    if (win.bad) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });

    const [log, projectSide] = await Promise.all([
      dailyQuery.getLog(req.orgId, {
        userIds: [target], from: win.from, to: win.to, filters: readFilters(req.query) }),
      _projectSideOrEmpty('person items', async () => ({
        projectItems: await handoverService.getPersonProjectItems(target, req.orgId),
        projects: (await handoverService.getTeamMemberProjects(target, req.orgId))
          .filter(p => !p.isRetired),
      }), { projectItems: [], projects: [] }),
    ]);

    res.json({ ...win, log, ...projectSide });
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

router.post('/activity-types/:key/promote', async (req, res) => {
  try {
    res.json(await dailyWork.promoteActivityType(req.orgId, req.userId, req.params.key));
  } catch (err) { handle(res, err, 'POST /activity-types/:key/promote'); }
});

router.post('/activity-types/:key/merge', async (req, res) => {
  try {
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
