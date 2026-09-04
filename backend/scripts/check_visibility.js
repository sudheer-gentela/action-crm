#!/usr/bin/env node
/**
 * check_visibility.js — 2026_140 person-work visibility.
 *
 * WHY THIS EXISTS. This is the only harness in the set whose failure mode is a
 * DISCLOSURE. Everything else guards against somebody not being told something.
 * Here, a wrong answer means a person's tasks, commitments or messages are
 * handed to someone with no basis to see them — and nothing errors, nothing
 * looks wrong, and the only evidence is a screen that quietly shows too much.
 *
 * The three routes this covers were, until now, completely unscoped: any
 * authenticated user could read any other user's dashboard by putting their id
 * in the URL.
 */
const Module = require('module');
const path = require('path');

// ── Locating the backend ────────────────────────────────────────────────────
function locateBackendRoot(explicit) {
  const fs = require('fs');
  const isRoot = (p) => {
    try {
      return fs.statSync(path.join(p, 'services')).isDirectory()
          && fs.statSync(path.join(p, 'config', 'database.js')).isFile();
    } catch { return false; }
  };
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!isRoot(abs)) {
      console.error(`\nNot a backend root: ${abs}\n` +
        `Expected to find services/ and config/database.js inside it.\n`);
      process.exit(2);
    }
    return abs;
  }
  const tried = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    for (const cand of [path.join(dir, 'backend'), dir]) {
      tried.push(cand);
      if (isRoot(cand)) return cand;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  console.error(`\nCould not find the backend root.\n\n` +
    `Pass it explicitly:\n  node ${path.basename(process.argv[1])} <path-to-backend>\n\n` +
    `Looked in:\n${tried.map(t => `  ${t}`).join('\n')}\n`);
  process.exit(2);
}

const ROOT = locateBackendRoot(process.argv[2]);

let handlers = [];
let subordinates = [];
const sqlSeen = [];
const respond = async (sql, params) => {
  sqlSeen.push({ sql, params });
  for (const [match, fn] of handlers) {
    if (match instanceof RegExp ? match.test(sql) : match(sql)) return fn(params, sql);
  }
  return { rows: [], rowCount: 0 };
};

const makeStub = () => {
  const fn = function stub() { return stub; };
  return new Proxy(fn, {
    get: (t, k) => {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => 'stub';
      if (!(k in t)) t[k] = makeStub();
      return t[k];
    },
    apply: () => makeStub(), construct: () => makeStub(),
  });
};

let dbStub = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); }
  catch { return makeStub(); }

  if (resolved.endsWith(path.join('config', 'database.js'))) {
    if (!dbStub) {
      dbStub = {
        pool: { query: respond, connect: async () => ({ query: respond, release() {} }) },
        query: respond,
        withOrgTransaction: async (orgId, fn) => fn({ query: respond }),
      };
    }
    return dbStub;
  }
  // The reporting line is a separate service. Stubbed so each scenario can say
  // who reports to whom without building an org_hierarchy fixture.
  if (resolved.endsWith(path.join('services', 'hierarchyService.js'))) {
    return { getSubordinates: async () => subordinates };
  }
  if (resolved.includes('node_modules') || resolved.endsWith('.node')) return makeStub();
  return origLoad.call(this, request, parent, isMain);
};

const svc = require(path.join(ROOT, 'services/handover.service.js'));

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : ` — ${detail || ''}`}`);
  if (!cond) failures++;
};
const reset = () => { sqlSeen.length = 0; handlers = []; subordinates = []; };

const ORG = 1, VIEWER = 10, TARGET = 20;

/** Scenario builder: role of the viewer, and which shared projects come back. */
function scenario({ role = 'member', reports = [], sharedProjectIds = [] } = {}) {
  reset();
  subordinates = reports;
  handlers = [
    [/SELECT role FROM org_users/, () => ({ rows: role ? [{ role }] : [] })],
    [/FROM sales_handovers h\s+WHERE h\.org_id/, () => ({ rows: sharedProjectIds.map(id => ({ id })) })],
  ];
}

(async () => {
  // ══ 1. Who gets what scope ════════════════════════════════════════════════
  console.log('\n── canSeePersonWork ──');

  scenario({ role: 'admin' });
  let v = await svc.canSeePersonWork(ORG, VIEWER, TARGET);
  check('an org admin sees everything', v.scope === 'all', JSON.stringify(v));

  scenario({ role: 'owner' });
  v = await svc.canSeePersonWork(ORG, VIEWER, TARGET);
  check('an org owner sees everything', v.scope === 'all', JSON.stringify(v));

  scenario({ role: 'member', reports: [TARGET, 33] });
  v = await svc.canSeePersonWork(ORG, VIEWER, TARGET);
  check('a reporting manager sees everything', v.scope === 'all', JSON.stringify(v));

  scenario({ role: 'member', reports: [], sharedProjectIds: [41, 42] });
  v = await svc.canSeePersonWork(ORG, VIEWER, TARGET);
  check('a project manager is scoped to shared projects',
    v.scope === 'projects', JSON.stringify(v));
  check('and gets the ids to filter by',
    JSON.stringify(v.handoverIds) === '[41,42]', JSON.stringify(v.handoverIds));

  // THE DISCLOSURE CASE. A peer on a project — no reporting line, no authority.
  scenario({ role: 'member', reports: [], sharedProjectIds: [] });
  v = await svc.canSeePersonWork(ORG, VIEWER, TARGET);
  check('a colleague with no authority sees NOTHING',
    v.scope === null, JSON.stringify(v));

  // Not a member of the org at all.
  scenario({ role: null });
  v = await svc.canSeePersonWork(ORG, VIEWER, TARGET);
  check('someone not in the org sees nothing', v.scope === null, JSON.stringify(v));

  reset();
  v = await svc.canSeePersonWork(ORG, VIEWER, VIEWER);
  check('you can always see your own work', v.scope === 'all', JSON.stringify(v));
  check('and that needs no queries at all', sqlSeen.length === 0, `${sqlSeen.length} queries`);

  for (const args of [[null, VIEWER, TARGET], [ORG, null, TARGET], [ORG, VIEWER, null]]) {
    reset();
    v = await svc.canSeePersonWork(...args);
    check(`missing id ${JSON.stringify(args)} refuses`, v.scope === null);
  }

  // ══ 2. The shared-project query ═══════════════════════════════════════════
  console.log('\n── the project-authority query ──');
  scenario({ role: 'member', sharedProjectIds: [41] });
  await svc.canSeePersonWork(ORG, VIEWER, TARGET);
  const pq = sqlSeen.find(s => /FROM sales_handovers h\s+WHERE h\.org_id/.test(s.sql));
  check('issued the shared-project query', !!pq);
  if (pq) {
    const sql = pq.sql;
    check('parentheses balanced',
      (sql.match(/\(/g) || []).length === (sql.match(/\)/g) || []).length);
    // MEMBERSHIP alone must not qualify the viewer. Two engineers on one
    // project are peers, and peers reading each other's workload is a
    // different feature.
    check('the VIEWER arm requires authority, not membership',
      /pm\.can_manage\s*=\s*TRUE/.test(sql), 'can_manage missing — is manageableProjectSql used?');
    check('viewer authority includes service owner and creator',
      /assigned_service_owner_id = \$2/.test(sql) && /created_by = \$2/.test(sql));
    // The TARGET must actually be on it, or a manager would see the work of
    // people who are not on their projects.
    check('the TARGET arm accepts approved membership',
      /pm\.user_id = \$3/.test(sql) && /pm\.status = 'approved'/.test(sql));
    check('the TARGET arm accepts the deal team too',
      /dtm\.user_id = \$3/.test(sql));
    // Initiatives qualify: a standing initiative has no owner by design, so a
    // tracking_mode filter here would exclude exactly the containers the whole
    // org logs work against.
    check('initiatives are NOT excluded', !/tracking_mode/.test(sql));
    const used = [...new Set((sql.match(/\$(\d+)/g) || []).map(s => Number(s.slice(1))))].sort((a, b) => a - b);
    check('placeholders $1..$N with no gaps', used[used.length - 1] === used.length, `used ${used.join(',')}`);
    check('params length matches', pq.params.length === used[used.length - 1],
      `${pq.params.length} vs $${used[used.length - 1]}`);
  }

  // ══ 3. getPersonOpenWork honours the scope ════════════════════════════════
  console.log('\n── getPersonOpenWork ──');

  const TASK_ROWS = [
    { id: 1, title: 'A', due_date: '2020-01-01', status: 'not_started',
      project: 'Apollo', handover_id: 41, tracking_mode: 'timeboxed', stage_key: 's1' },
  ];
  const workHandlers = () => ([
    [/FROM project_play_instances ppi/, () => ({ rows: TASK_ROWS })],
    [/FROM sales_handover_commitments c/, () => ({ rows: [] })],
  ]);

  reset(); handlers = workHandlers();
  let w = await svc.getPersonOpenWork(TARGET, ORG, { scope: null, handoverIds: [] });
  check('no scope returns nothing', w.tasks.length === 0 && w.commitments.length === 0);
  check('and issues no queries at all', sqlSeen.length === 0, `${sqlSeen.length} queries`);

  reset(); handlers = workHandlers();
  w = await svc.getPersonOpenWork(TARGET, ORG, { scope: 'all', handoverIds: [] });
  const allSql = sqlSeen.find(s => /FROM project_play_instances ppi/.test(s.sql));
  check("scope 'all' returns the work", w.tasks.length === 1);
  check("scope 'all' passes restricted = false", allSql.params[2] === false,
    JSON.stringify(allSql.params));
  check('the scope is echoed back for the UI', w.scope === 'all');

  reset(); handlers = workHandlers();
  w = await svc.getPersonOpenWork(TARGET, ORG, { scope: 'projects', handoverIds: [41, 42] });
  const projSql = sqlSeen.find(s => /FROM project_play_instances ppi/.test(s.sql));
  check("scope 'projects' passes restricted = true", projSql.params[2] === true,
    JSON.stringify(projSql.params));
  check('and passes the id list', JSON.stringify(projSql.params[3]) === '[41,42]',
    JSON.stringify(projSql.params[3]));
  check('the restriction is applied in SQL, not in JS',
    /h\.id = ANY\(\$4::int\[\]\)/.test(projSql.sql));

  // An empty id list under 'projects' must not become "match everything".
  // ANY('{}') matches nothing, which would read as "no open work" — plausible
  // and wrong. Refused explicitly instead.
  reset(); handlers = workHandlers();
  w = await svc.getPersonOpenWork(TARGET, ORG, { scope: 'projects', handoverIds: [] });
  check('scope projects with no ids returns nothing and queries nothing',
    w.tasks.length === 0 && sqlSeen.length === 0, `${sqlSeen.length} queries`);

  // The counts on this panel must match the People screen, or a manager comes
  // to distrust both.
  reset(); handlers = workHandlers();
  w = await svc.getPersonOpenWork(TARGET, ORG, { scope: 'all', handoverIds: [] });
  const taskSql = sqlSeen.find(s => /FROM project_play_instances ppi/.test(s.sql)).sql;
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  check('shares the open-play predicates with the People screen',
    norm(taskSql).includes(norm(`ppi.status NOT IN ('completed', 'skipped', 'cancelled')
      AND h.status NOT IN ('completed', 'cancelled') AND h.retired_at IS NULL`)),
    'predicates differ from OPEN_PLAY_PREDICATES');
  check('overdue is computed server-side', typeof w.tasks[0].isOverdue === 'boolean');
  check('a 2020 due date on a live project reads as overdue', w.tasks[0].isOverdue === true);

  reset();
  handlers = [
    [/FROM project_play_instances ppi/, () => ({ rows: [{ ...TASK_ROWS[0], tracking_mode: 'standing' }] })],
    [/FROM sales_handover_commitments c/, () => ({ rows: [] })],
  ];
  w = await svc.getPersonOpenWork(TARGET, ORG, { scope: 'all', handoverIds: [] });
  check('a task on a standing initiative is never overdue',
    w.tasks[0].isOverdue === false && w.tasks[0].isStanding === true,
    JSON.stringify(w.tasks[0]));

  console.log(failures ? `\n${failures} problem(s).` : '\nAll visibility checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
