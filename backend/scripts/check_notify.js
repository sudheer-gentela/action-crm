#!/usr/bin/env node
/**
 * check_notify.js — 2026_138 notification routing.
 *
 * WHY THIS EXISTS. Every failure here is silent in the worst direction. A basis
 * resolved wrongly does not error — it means the Project Manager quietly stops
 * receiving submissions on their own project, and the first anyone knows is a
 * review that sat for a week. An unblock notice that fires one prerequisite too
 * early sends someone to a task that then refuses to start. Neither shows up in
 * lint, `node --check`, or a module-load check.
 *
 * Stubs the pool, drives the real functions, asserts on what they produced.
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
    `e.g.  node ${path.basename(process.argv[1])} C:\\Projects\\gowarmcrm\\backend\n\n` +
    `Looked in:\n${tried.map(t => `  ${t}`).join('\n')}\n`);
  process.exit(2);
}

const ROOT = locateBackendRoot(process.argv[2]);

// ── Stub layer ──────────────────────────────────────────────────────────────
// `handlers` is swapped per scenario: each entry is [matcher, responder].
let handlers = [];
const sqlSeen = [];
const created = [];      // every createNotification call

const respond = async (sql, params) => {
  sqlSeen.push({ sql, params });
  for (const [match, fn] of handlers) {
    if (match instanceof RegExp ? match.test(sql) : match(sql)) return fn(params, sql);
  }
  return { rows: [], rowCount: 0 };
};

let dbStub = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
  })();

  if (resolved && resolved.endsWith(path.join('config', 'database.js'))) {
    if (!dbStub) {
      dbStub = {
        pool: { query: respond, connect: async () => ({ query: respond, release() {} }) },
        query: respond,
      };
    }
    return dbStub;
  }
  // notificationService is replaced so createNotification is observable without
  // dragging in the Bull queue. The notifier under test is NOT stubbed.
  if (resolved && resolved.endsWith(path.join('services', 'notificationService.js'))) {
    return {
      createNotification: async (orgId, userId, type, title, body, et, eid, meta) => {
        created.push({ orgId, userId, type, title, body, meta });
        return { id: created.length };
      },
      getUserNotificationPrefs: async () => ({ channels: {} }),
    };
  }
  if (resolved && (resolved.includes('node_modules') || resolved.endsWith('.node'))) {
    const fn = function stub() { return stub; };
    return new Proxy(fn, {
      get: (t, k) => (k === 'then' ? undefined : (t[k] || (t[k] = stub))),
      apply: () => stub, construct: () => stub,
    });
  }
  return origLoad.call(this, request, parent, isMain);
};

const notifier = require(path.join(ROOT, 'services/playReviewNotifier.service.js'));
const unblock  = require(path.join(ROOT, 'services/dependencyNotifier.service.js'));

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : ` — ${detail || ''}`}`);
  if (!cond) failures++;
};
const reset = () => { created.length = 0; sqlSeen.length = 0; handlers = []; };

(async () => {
  // ══ 1. shouldNotify: the pure rule ════════════════════════════════════════
  console.log('\n── shouldNotify ──');
  const EVENTS = ['submitted', 'approved', 'rejected', 'closed_direct'];
  const BASES  = ['owner', 'creator', 'assignee', 'watcher', 'member'];
  const expected = {
    owner:    { submitted: true,  approved: true, rejected: true,  closed_direct: true },
    creator:  { submitted: true,  approved: true, rejected: true,  closed_direct: true },
    assignee: { submitted: true,  approved: true, rejected: true,  closed_direct: true },
    watcher:  { submitted: true,  approved: true, rejected: true,  closed_direct: true },
    // The whole point of 2026_138.
    member:   { submitted: false, approved: true, rejected: false, closed_direct: true },
  };
  for (const b of BASES) {
    for (const e of EVENTS) {
      const got = notifier.shouldNotify(e, b);
      check(`${b} / ${e} → ${expected[b][e]}`, got === expected[b][e], `got ${got}`);
    }
  }

  // An unrecognised basis must FAIL OPEN. A future basis nobody updated this
  // list for should over-notify, not silently drop somebody's alerts.
  check('an unknown basis still receives everything',
    notifier.shouldNotify('submitted', 'some_future_basis') === true);

  // ══ 2. resolveRecipients: the rendered SQL ════════════════════════════════
  console.log('\n── resolveRecipients SQL ──');
  reset();
  handlers = [[/WITH candidates/, () => ({ rows: [] })]];
  await notifier.resolveRecipients(10, 1, { actorId: 99, assigneeId: 42 });
  const rq = sqlSeen.find(s => /WITH candidates/.test(s.sql));
  check('issued the candidates query', !!rq);
  if (rq) {
    const sql = rq.sql;
    check('parentheses balanced',
      (sql.match(/\(/g) || []).length === (sql.match(/\)/g) || []).length);
    check('DISTINCT ON collapses to one row per person', /DISTINCT ON \(c\.user_id\)/.test(sql));
    // Load-bearing: without ORDER BY rank a PM who is also a member could be
    // resolved as 'member' and stop receiving submissions on their own project.
    check('ORDER BY keeps the most permissive basis', /ORDER BY c\.user_id, c\.rank/.test(sql));
    check('members are approved-only', /pm\.status\s*=\s*'approved'/.test(sql));
    check('members are non-exited', /pm\.exited_at IS NULL/.test(sql));
    check('actor is excluded', /c\.user_id <> COALESCE\(\$4::int, -1\)/.test(sql));
    check('inactive org users excluded', /ou\.is_active = TRUE/.test(sql));
    const used = [...new Set((sql.match(/\$(\d+)/g) || []).map(s => Number(s.slice(1))))].sort((a, b) => a - b);
    check('placeholders $1..$N with no gaps', used[used.length - 1] === used.length, `used ${used.join(',')}`);
    check('params length matches', rq.params.length === used[used.length - 1],
      `${rq.params.length} vs $${used[used.length - 1]}`);
    // Rank order decides which basis wins the DISTINCT ON. If 'member' were not
    // last, it would shadow a more permissive reason for the same person.
    const rankOf = (basis) => {
      const m = new RegExp(`'${basis}'[^,]*,\\s*(\\d+)`).exec(sql)
             || new RegExp(`'${basis}'::text AS basis, (\\d+)`).exec(sql);
      return m ? Number(m[1]) : null;
    };
    check("'member' ranks last of all bases",
      rankOf('member') === 5, `member rank ${rankOf('member')}`);
  }

  // ══ 3. notify(): filtering end to end ═════════════════════════════════════
  console.log('\n── notify() filtering ──');
  const TEAM = [
    { user_id: 1, basis: 'owner',    name: 'Pat PM',   email: 'pm@x.com' },
    { user_id: 2, basis: 'watcher',  name: 'Wan Watch', email: 'w@x.com' },
    { user_id: 3, basis: 'member',   name: 'Mem One',  email: 'm1@x.com' },
    { user_id: 4, basis: 'member',   name: 'Mem Two',  email: 'm2@x.com' },
    { user_id: 5, basis: 'assignee', name: 'Ass Ign',  email: 'a@x.com' },
  ];
  const ctxRow = { rows: [{ project_name: 'Apollo', actor_name: 'Sam Actor' }] };

  for (const [event, wantIds, wantSuppressed] of [
    ['submitted',     [1, 2, 5],          2],
    ['rejected',      [1, 2, 5],          2],
    ['approved',      [1, 2, 3, 4, 5],    0],
    ['closed_direct', [1, 2, 3, 4, 5],    0],
  ]) {
    reset();
    handlers = [
      // Matched on actor_name, not on 'FROM sales_handovers h' — the
      // candidates query contains that string too, and a looser matcher
      // answered BOTH queries with the context row, so resolveRecipients saw
      // no user_id and every recipient list came back empty.
      [/AS actor_name/, () => ctxRow],
      [/WITH candidates/, () => ({ rows: TEAM })],
    ];
    const res = await notifier.notify(event, {
      orgId: 1, handoverId: 10, actorId: 99, targetStatus: 'completed',
      instance: { id: 7, title: 'Wire the thing', owner_user_id: 5 },
    });
    const got = created.map(c => c.userId).sort((a, b) => a - b);
    check(`${event} → users [${wantIds}]`,
      JSON.stringify(got) === JSON.stringify(wantIds), `got [${got}]`);
    check(`${event} reports suppressed=${wantSuppressed}`,
      res.suppressed === wantSuppressed, `got ${res.suppressed}`);
  }

  // The basis must be recorded, or "why did this person get this?" is only
  // answerable by re-running a resolver against membership that has changed.
  reset();
  handlers = [
    [/AS actor_name/, () => ctxRow],
    [/WITH candidates/, () => ({ rows: TEAM })],
  ];
  await notifier.notify('approved', {
    orgId: 1, handoverId: 10, actorId: 99, targetStatus: 'completed',
    instance: { id: 7, title: 'T', owner_user_id: 5 },
  });
  check('every notification records its basis',
    created.length > 0 && created.every(c => typeof c.meta?.basis === 'string'));

  // ══ 4. newlyUnblocked: the query ══════════════════════════════════════════
  console.log('\n── newlyUnblocked SQL ──');
  reset();
  handlers = [[/FROM project_play_instances dep/, () => ({ rows: [] })]];
  await unblock.newlyUnblocked(7, 1);
  const uq = sqlSeen.find(s => /FROM project_play_instances dep/.test(s.sql));
  check('issued the dependents query', !!uq);
  if (uq) {
    const sql = uq.sql;
    check('parentheses balanced',
      (sql.match(/\(/g) || []).length === (sql.match(/\)/g) || []).length);
    // Reads the INSTANCE graph. Reading playbook_plays.depends_on instead would
    // make this silent for every hand-wired dependency, which is all of them.
    check('matches on the instance depends_on array', /\$1 = ANY\(dep\.depends_on\)/.test(sql));
    // Without this the notice fires when ONE of three prerequisites clears, and
    // the reader walks into a refusal from _outstandingPrereqs.
    check('requires NO remaining outstanding prerequisite', /NOT EXISTS/.test(sql));
    check('the three satisfying statuses agree with _outstandingPrereqs',
      /'completed',\s*'skipped',\s*'cancelled'/.test(sql));
    check('only notifiable dependent statuses', /dep\.status = ANY\(\$3::text\[\]\)/.test(sql));
    check('scoped by org', /dep\.org_id = \$2/.test(sql));
  }

  // ══ 5. unblock recipients: owner, else PM ═════════════════════════════════
  console.log('\n── unblock recipients ──');

  reset();
  handlers = [
    [/FROM users u\s*$|WHERE u\.id = \$1/, () => ({ rows: [{ id: 55, name: 'Ollie Owner' }] })],
  ];
  let rec = await unblock.resolveUnblockRecipients(
    { id: 3, title: 'T', ownerUserId: 55, handoverId: 10 }, 1, 99);
  check('an owned dependent notifies its owner',
    rec.length === 1 && rec[0].userId === 55 && rec[0].basis === 'assignee',
    JSON.stringify(rec));

  reset();
  rec = await unblock.resolveUnblockRecipients(
    { id: 3, title: 'T', ownerUserId: 99, handoverId: 10 }, 1, 99);
  check('the actor is never told they unblocked themselves',
    rec.length === 0, JSON.stringify(rec));
  check('and no query is issued for that case', sqlSeen.length === 0);

  reset();
  handlers = [
    [/assigned_service_owner_id/, () => ({ rows: [{ id: 77, name: 'Pat PM' }] })],
  ];
  rec = await unblock.resolveUnblockRecipients(
    { id: 3, title: 'T', ownerUserId: null, handoverId: 10 }, 1, 99);
  check('an UNASSIGNED dependent falls back to the project manager',
    rec.length === 1 && rec[0].userId === 77 && rec[0].basis === 'owner_fallback',
    JSON.stringify(rec));

  // The PM must not be copied on owned tasks as well, or a dense graph makes
  // them the recipient of most of this traffic.
  reset();
  handlers = [
    [/WHERE u\.id = \$1/, () => ({ rows: [{ id: 55, name: 'Ollie Owner' }] })],
    [/assigned_service_owner_id/, () => ({ rows: [{ id: 77, name: 'Pat PM' }] })],
  ];
  rec = await unblock.resolveUnblockRecipients(
    { id: 3, title: 'T', ownerUserId: 55, handoverId: 10 }, 1, 99);
  check('the PM is NOT copied when the task has an owner',
    !rec.some(r => r.userId === 77), JSON.stringify(rec));

  // ══ 6. notifyUnblocked: end to end, and it must never throw ═══════════════
  console.log('\n── notifyUnblocked ──');
  reset();
  handlers = [
    [/FROM project_play_instances dep/, () => ({ rows: [
      { id: 21, title: 'Next task', owner_user_id: 55, handover_id: 10 },
      { id: 22, title: 'Other task', owner_user_id: null, handover_id: 10 },
    ] })],
    [/completed_title/, () => ({ rows: [{ project_name: 'Apollo', completed_title: 'Prereq' }] })],
    [/WHERE u\.id = \$1/, () => ({ rows: [{ id: 55, name: 'Ollie Owner' }] })],
    [/assigned_service_owner_id/, () => ({ rows: [{ id: 77, name: 'Pat PM' }] })],
  ];
  const out = await unblock.notifyUnblocked(7, 1, 99);
  check('reports both dependents unblocked', out.unblocked === 2, JSON.stringify(out));
  check('notified the owner and the PM fallback',
    created.map(c => c.userId).sort().join(',') === '55,77', created.map(c => c.userId).join(','));
  check('uses the play_unblocked type (kept out of the review digest sweep)',
    created.every(c => c.type === 'play_unblocked'), created.map(c => c.type).join(','));
  check('the unassigned notice says so in its title',
    created.some(c => c.meta.basis === 'owner_fallback' && /unassigned/i.test(c.title)),
    created.map(c => c.title).join(' | '));

  // Called from inside a committed completion path. A throw here surfaces as a
  // failed completion, the user retries, and the retry fails with "this task
  // changed while you were working on it".
  reset();
  handlers = [[/.*/, () => { throw new Error('database on fire'); }]];
  let threw = false;
  try { await unblock.notifyUnblocked(7, 1, 99); } catch { threw = true; }
  check('never throws, whatever the database does', !threw);

  reset();
  handlers = [[/AS actor_name/, () => { throw new Error('nope'); }]];
  threw = false;
  try {
    await notifier.notify('approved', { orgId: 1, handoverId: 10, actorId: 9, instance: { id: 1 } });
  } catch { threw = true; }
  check('notify() never throws either', !threw);

  // ══ 7. Watchers: self-subscriptions survive a manager's edit ══════════════
  //
  // The silent failure this guards: setWatchers is DELETE-then-INSERT, so
  // without the self_subscribed predicate a manager adding one person wipes
  // everyone who subscribed themselves. Nobody errors; they just stop being
  // told things, and the only evidence is mail that does not arrive.
  console.log('\n── watcher self-subscription ──');
  const playReview = require(path.join(ROOT, 'services/playReview.service.js'));

  reset();
  handlers = [
    // canManageProject, called first by setWatchers.
    [/member_can_manage/, () => ({ rows: [{ org_role: 'admin' }] })],
    [/DELETE FROM project_play_watchers/, () => ({ rowCount: 1 })],
    [/INSERT INTO project_play_watchers/, () => ({ rowCount: 1 })],
    [/FROM project_play_watchers w/, () => ({ rows: [] })],
  ];
  await playReview.setWatchers(10, 1, 5, [3, 4]);

  const del = sqlSeen.find(s => /DELETE FROM project_play_watchers/.test(s.sql));
  check('setWatchers issued a DELETE', !!del);
  check('the DELETE spares self-subscribed rows',
    !!del && /self_subscribed = FALSE/.test(del.sql), del?.sql);

  const ins = sqlSeen.find(s => /INSERT INTO project_play_watchers/.test(s.sql));
  check('manager-added rows are written as NOT self-subscribed',
    !!ins && /self_subscribed/.test(ins.sql) && /FALSE\)/.test(ins.sql), ins?.sql);
  // DO UPDATE here would let a manager convert somebody's own subscription into
  // one the manager can then delete — the same outcome by a longer route.
  check('an existing row is left alone, not converted',
    !!ins && /DO NOTHING/.test(ins.sql) && !/DO UPDATE/.test(ins.sql));

  reset();
  handlers = [[/FROM sales_handovers h/, () => ({ rows: [] })]];   // not eligible
  let refused = false;
  try { await playReview.setSelfWatch(10, 1, 42, true); }
  catch (e) { refused = e.status === 403 && e.code === 'NOT_ON_PROJECT'; }
  check('someone not on the project cannot subscribe to it', refused);

  reset();
  handlers = [
    [/FROM sales_handovers h/, () => ({ rows: [{ ok: 1 }] })],
    [/INSERT INTO project_play_watchers/, () => ({ rowCount: 1 })],
  ];
  const sub = await playReview.setSelfWatch(10, 1, 42, true);
  check('an eligible person can subscribe', sub.subscribed === true);
  const selfIns = sqlSeen.find(s => /INSERT INTO project_play_watchers/.test(s.sql));
  check('their row is marked self-subscribed',
    !!selfIns && /TRUE\)/.test(selfIns.sql), selfIns?.sql);

  reset();
  handlers = [[/DELETE FROM project_play_watchers/, () => ({ rowCount: 1 })]];
  const unsub = await playReview.setSelfWatch(10, 1, 42, false);
  check('unsubscribing needs no eligibility check',
    unsub.subscribed === false && !sqlSeen.some(s => /FROM sales_handovers h/.test(s.sql)));
  const selfDel = sqlSeen.find(s => /DELETE FROM project_play_watchers/.test(s.sql));
  check('unsubscribing cannot delete a manager-added row',
    !!selfDel && /self_subscribed = TRUE/.test(selfDel.sql), selfDel?.sql);

  console.log(failures ? `\n${failures} problem(s).` : '\nAll notification routing checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
