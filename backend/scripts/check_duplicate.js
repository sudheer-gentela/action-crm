#!/usr/bin/env node
/**
 * check_duplicate.js — 2026_141 project duplication and template extraction.
 *
 * WHY THIS EXISTS. The remap is the one piece of this feature where a wrong
 * answer looks entirely right. depends_on holds sibling INSTANCE ids; copy them
 * verbatim and the new project's tasks point at the OLD project's tasks. Nothing
 * errors. The checklist renders. The strip renders. The new project is simply
 * blocked by work it has no relationship to, and _outstandingPrereqs refuses to
 * start tasks whose prerequisites live somewhere the user cannot even see.
 *
 * The template path has the same shape running the other way — instance ids to
 * PLAY ids — and getting that backwards produces a template whose dependencies
 * point at play ids that happen to collide with someone else's playbook.
 *
 * Neither is visible to node --check, lint, or a module-load check.
 */
const Module = require('module');
const path = require('path');

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
      console.error(`\nNot a backend root: ${abs}\n`);
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
  console.error(`\nCould not find the backend root.\n\nPass it explicitly:\n` +
    `  node ${path.basename(process.argv[1])} <path-to-backend>\n\n` +
    `Looked in:\n${tried.map(t => `  ${t}`).join('\n')}\n`);
  process.exit(2);
}

const ROOT = locateBackendRoot(process.argv[2]);

// ── A tiny in-memory stand-in for the two tables that matter ────────────────
let nextId = 1000;
const inserted = { plays: [], playbookPlays: [], handovers: [], members: [], stages: [] };
const updates = [];
let srcPlays = [];
let srcHandover = null;
let srcStages = [];
const sqlSeen = [];

const respond = async (sql, params) => {
  sqlSeen.push({ sql, params });
  const q = sql.replace(/\s+/g, ' ').trim();

  if (/^SELECT \* FROM sales_handovers/.test(q)) return { rows: srcHandover ? [srcHandover] : [] };
  if (/^SELECT id, name, tracking_mode, go_live_date FROM sales_handovers/.test(q)) {
    return { rows: srcHandover ? [srcHandover] : [] };
  }
  if (/^INSERT INTO sales_handovers/.test(q)) {
    const id = ++nextId; inserted.handovers.push({ id, params }); return { rows: [{ id }] };
  }
  if (/^INSERT INTO project_stages/.test(q)) { inserted.stages.push({ params }); return { rowCount: srcStages.length }; }
  if (/^SELECT key, name, sort_order, gating FROM project_stages/.test(q)) return { rows: srcStages };
  if (/^SELECT \* FROM project_play_instances/.test(q)) {
    // The stub applies the one predicate under test. Returning every row
    // regardless would make "cancelled tasks are excluded" pass for a query
    // that excludes nothing — a stub too dumb to fail is a stub that certifies
    // anything.
    return { rows: /status <> 'cancelled'/.test(q)
      ? srcPlays.filter(p => p.status !== 'cancelled')
      : srcPlays };
  }
  if (/^INSERT INTO project_play_instances/.test(q)) {
    const id = ++nextId; inserted.plays.push({ id, params }); return { rows: [{ id }] };
  }
  if (/^INSERT INTO playbooks/.test(q)) { const id = ++nextId; return { rows: [{ id }] }; }
  if (/^INSERT INTO playbook_plays/.test(q)) {
    const id = ++nextId; inserted.playbookPlays.push({ id, params }); return { rows: [{ id }] };
  }
  if (/^INSERT INTO project_members/.test(q)) { inserted.members.push({ params }); return { rowCount: 2 }; }
  if (/^UPDATE project_play_instances/.test(q) || /^UPDATE playbook_plays/.test(q)) {
    updates.push({ sql: q, params }); return { rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

const makeStub = () => {
  const fn = function stub() { return stub; };
  return new Proxy(fn, {
    get: (t, k) => (k === 'then' ? undefined : (k === Symbol.toPrimitive ? () => 'stub'
      : (t[k] || (t[k] = makeStub())))),
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
        withOrgTransaction: async (o, fn) => fn({ query: respond }),
      };
    }
    return dbStub;
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
const reset = () => {
  nextId = 1000; sqlSeen.length = 0; updates.length = 0;
  for (const k of Object.keys(inserted)) inserted[k].length = 0;
};

/**
 * A plan with a FORWARD edge: task 1 depends on task 3, which is inserted
 * after it. That is the case a one-pass copy silently drops, and it is why the
 * remap has to be a second pass.
 */
function makePlan() {
  return [
    { id: 1, stage_key: 's1', title: 'A', description: null, channel: null,
      priority: 'medium', execution_type: 'parallel', is_gate: false,
      due_date: '2026-03-10', sort_order: 1, is_manual: false, playbook_id: 7,
      due_anchor: 'created', owner_user_id: 55, play_id: 100,
      depends_on: [3], parent_instance_id: null, status: 'completed' },
    { id: 2, stage_key: 's1', title: 'B', description: 'b', channel: null,
      priority: 'high', execution_type: 'parallel', is_gate: true,
      due_date: '2026-03-20', sort_order: 2, is_manual: false, playbook_id: 7,
      due_anchor: 'created', owner_user_id: 56, play_id: 101,
      // Includes 999, which does not exist — the dangling case.
      depends_on: [1, 999], parent_instance_id: 1, status: 'not_started' },
    { id: 3, stage_key: 's2', title: 'C (ad hoc)', description: null, channel: null,
      priority: 'low', execution_type: 'parallel', is_gate: false,
      due_date: null, sort_order: 3, is_manual: true, playbook_id: null,
      due_anchor: 'created', owner_user_id: null, play_id: null,
      depends_on: null, parent_instance_id: null, status: 'not_started' },
    { id: 4, stage_key: 's2', title: 'D (cancelled)', description: null, channel: null,
      priority: 'low', execution_type: 'parallel', is_gate: false,
      due_date: '2026-04-01', sort_order: 4, is_manual: false, playbook_id: 7,
      due_anchor: 'created', owner_user_id: null, play_id: 102,
      depends_on: null, parent_instance_id: null, status: 'cancelled' },
  ];
}

const paramOf = (row, i) => row.params[i];

(async () => {
  // ══ duplicateProject ══════════════════════════════════════════════════════
  console.log('\n── duplicateProject: the remap ──');
  reset();
  srcHandover = { id: 1, kind: 'customer', name: 'Apollo', account_id: 9, deal_id: 4,
    budget: 1000, assigned_service_owner_id: 55, go_live_date: '2026-03-01',
    tracking_mode: 'timeboxed' };
  srcPlays = makePlan();
  srcStages = [{ key: 's1', name: 'One', sort_order: 1, gating: 'none' }];

  let out = await svc.duplicateProject(1, 1, 77,
    { name: 'Apollo II', goLiveDate: '2026-04-01' });

  check('every source task was inserted', inserted.plays.length === 4,
    String(inserted.plays.length));
  check('cancelled tasks ARE copied by a duplicate',
    inserted.plays.some(p => p.params.includes('D (cancelled)')));

  // The map: source index → new id, in insertion order.
  const newIds = inserted.plays.map(p => p.id);
  const map = new Map(srcPlays.map((p, i) => [p.id, newIds[i]]));

  const depUpdate = updates.find(u => u.params[0] === map.get(1));
  check('a FORWARD edge (1 → 3) survives the second pass', !!depUpdate,
    'task 1 depended on a task inserted after it');
  check('and it points at the NEW id, not the old one',
    !!depUpdate && JSON.stringify(depUpdate.params[1]) === JSON.stringify([map.get(3)]),
    depUpdate && JSON.stringify(depUpdate.params[1]));

  const dep2 = updates.find(u => u.params[0] === map.get(2));
  check('a dangling id (999) is dropped, not carried',
    !!dep2 && JSON.stringify(dep2.params[1]) === JSON.stringify([map.get(1)]),
    dep2 && JSON.stringify(dep2.params[1]));
  check('parent_instance_id is remapped too',
    !!dep2 && dep2.params[2] === map.get(1), dep2 && String(dep2.params[2]));

  // THE BUG THIS FILE EXISTS FOR: no new id may equal a source id.
  check('no copied dependency references a SOURCE instance id',
    updates.every(u => (u.params[1] || []).every(x => !srcPlays.some(p => p.id === x))),
    JSON.stringify(updates.map(u => u.params[1])));

  check('the report counts what it remapped',
    out.remappedDeps === 2 && out.remappedParents === 1, JSON.stringify(out));

  console.log('\n── duplicateProject: what is reset ──');
  // status is a literal in the INSERT, not a parameter — assert on the text.
  const insSql = sqlSeen.find(s => /INSERT INTO project_play_instances/.test(s.sql)).sql;
  check("every copied task starts at 'not_started'", /'not_started'/.test(insSql));
  for (const col of ['completed_at', 'completed_by', 'completion_note', 'completion_evidence',
                     'action_id', 'fired_action_ids', 'overridden_by',
                     'review_target_status', 'review_submitted_at', 'review_submitted_by',
                     'review_evidence', 'baseline_due_date', 'baseline_source']) {
    check(`${col} is not copied`, !new RegExp(`\\b${col}\\b`).test(insSql));
  }

  console.log('\n── duplicateProject: the options ──');
  check('dates shift by the go-live gap (Mar 1 → Apr 1 = 31 days)',
    out.shiftDays === 31, String(out.shiftDays));
  const taskA = inserted.plays[0];
  check('a dated task moved by exactly that gap',
    paramOf(taskA, 10) === '2026-04-10', String(paramOf(taskA, 10)));
  check('owners are dropped by default', paramOf(taskA, 15) === null,
    String(paramOf(taskA, 15)));

  reset(); srcPlays = makePlan();
  await svc.duplicateProject(1, 1, 77,
    { name: 'X', goLiveDate: '2026-04-01', carryOwners: true });
  check('carryOwners keeps the per-task owner',
    paramOf(inserted.plays[0], 15) === 55, String(paramOf(inserted.plays[0], 15)));

  reset(); srcPlays = makePlan();
  await svc.duplicateProject(1, 1, 77, { name: 'X', carryDates: false });
  check('carryDates false clears every due date',
    inserted.plays.every(p => paramOf(p, 10) === null));

  reset(); srcPlays = makePlan();
  await svc.duplicateProject(1, 1, 77, { name: 'X', carryMembers: false });
  check('carryMembers false copies no members', inserted.members.length === 0);

  reset(); srcPlays = makePlan();
  await svc.duplicateProject(1, 1, 77, { name: 'X' });
  check('members are copied by default', inserted.members.length === 1);
  const memSql = sqlSeen.find(s => /INSERT INTO project_members/.test(s.sql)).sql;
  check('only approved, non-exited members',
    /status = 'approved'/.test(memSql) && /exited_at IS NULL/.test(memSql));

  // A copy must not inherit the deal: one deal produces one project.
  check('deal_id is NOT carried',
    inserted.handovers[0].params[4] === null,
    String(inserted.handovers[0].params[4]));

  reset(); srcPlays = makePlan();
  let threw = null;
  try { await svc.duplicateProject(1, 1, 77, { name: '   ' }); }
  catch (e) { threw = e; }
  check('a blank name is refused', !!threw && threw.status === 400);
  check('and nothing was written', inserted.handovers.length === 0);

  // ══ saveProjectAsTemplate ═════════════════════════════════════════════════
  console.log('\n── saveProjectAsTemplate ──');
  reset(); srcPlays = makePlan();
  srcHandover = { id: 1, name: 'Apollo', tracking_mode: 'timeboxed', go_live_date: '2026-03-01' };

  const tpl = await svc.saveProjectAsTemplate(1, 1, 77, { name: 'Apollo template' });

  check('cancelled tasks are EXCLUDED from a template',
    !inserted.playbookPlays.some(p => p.params.includes('D (cancelled)')));
  const selSql = sqlSeen.find(s => /SELECT \* FROM project_play_instances/.test(s.sql)).sql;
  check('the exclusion is in SQL', /status <> 'cancelled'/.test(selSql));

  check('ad-hoc tasks ARE promoted to plays',
    inserted.playbookPlays.some(p => p.params.includes('C (ad hoc)')));

  const tplIds = inserted.playbookPlays.map(p => p.id);
  const kept = srcPlays.filter(p => p.status !== 'cancelled');
  const tplMap = new Map(kept.map((p, i) => [p.id, tplIds[i]]));
  const tplUpd = updates.find(u => /UPDATE playbook_plays/.test(u.sql) && u.params[0] === tplMap.get(1));
  check('dependencies remap to PLAY ids, not instance ids',
    !!tplUpd && JSON.stringify(tplUpd.params[1]) === JSON.stringify([tplMap.get(3)]),
    tplUpd && JSON.stringify(tplUpd.params[1]));
  check('no template dependency references a source INSTANCE id',
    updates.filter(u => /UPDATE playbook_plays/.test(u.sql))
      .every(u => (u.params[1] || []).every(x => !kept.some(p => p.id === x))));

  // due_offset_days, not a date: a template that hard-codes last quarter's
  // calendar is not reusable.
  check('a dated task becomes an OFFSET from go-live (Mar 10 − Mar 1 = 9)',
    paramOf(inserted.playbookPlays[0], 9) === 9,
    String(paramOf(inserted.playbookPlays[0], 9)));
  check("and claims the 'go_live' anchor",
    paramOf(inserted.playbookPlays[0], 11) === 'go_live',
    String(paramOf(inserted.playbookPlays[0], 11)));
  const adhoc = inserted.playbookPlays.find(p => p.params.includes('C (ad hoc)'));
  check('an undated task gets a NULL offset, not zero',
    paramOf(adhoc, 9) === null, String(paramOf(adhoc, 9)));
  check("and does NOT claim go_live (that would make it due on the day itself)",
    paramOf(adhoc, 11) !== 'go_live', String(paramOf(adhoc, 11)));

  check('stage names travel with the template', tpl.stages === 1, JSON.stringify(tpl));

  reset(); srcPlays = makePlan();
  threw = null;
  try { await svc.saveProjectAsTemplate(1, 1, 77, { name: '' }); }
  catch (e) { threw = e; }
  check('a blank template name is refused', !!threw && threw.status === 400);

  console.log(failures ? `\n${failures} problem(s).` : '\nAll duplication checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
