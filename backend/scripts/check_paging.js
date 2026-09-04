#!/usr/bin/env node
/**
 * check_paging.js — 2026_139 list paging, search, and the read-path split.
 *
 * WHY THIS EXISTS, and why it matters more than usual.
 *
 * The paging code is LATENT. The frontend sends no q, limit or offset, so none
 * of this executes in production today. A wrong placeholder or an off-by-one in
 * the params array would therefore sit undetected until the day somebody
 * switches paging on — at which point it fails in a hurry, in a change nobody
 * expects to be risky, and the bug is months old and unattributable.
 *
 * The split has the opposite shape: it runs on every "open this project" click
 * from the People screen, and its failure is silent in the other direction — a
 * validator that drifts from the display refuses a link that is perfectly good,
 * with a message identical to the honest refusal.
 *
 * Stubs the pool, drives the real functions, asserts on the SQL they build.
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

let handlers = [];
const sqlSeen = [];
const respond = async (sql, params) => {
  sqlSeen.push({ sql, params });
  for (const [match, fn] of handlers) {
    if (match instanceof RegExp ? match.test(sql) : match(sql)) return fn(params, sql);
  }
  return { rows: [], rowCount: 0 };
};

let dbStub = null;
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

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); }
  catch {
    // UNRESOLVABLE, not merely third-party. handover.service transitively
    // requires route files that require express, which is not installed beside
    // this harness — the first version returned null here and fell through to
    // the real loader, which threw MODULE_NOT_FOUND before a single check ran.
    return makeStub();
  }
  if (resolved.endsWith(path.join('config', 'database.js'))) {
    if (!dbStub) {
      dbStub = {
        pool: { query: respond, connect: async () => ({ query: respond, release() {} }) },
        query: respond,
        // dailyWorkQuery wraps every read in this. Stubbed as a pass-through
        // that hands the callback a client speaking the same query interface —
        // the transaction is not what is under test here, the SQL it wraps is.
        withOrgTransaction: async (orgId, fn) => fn({ query: respond }),
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
const reset = () => { sqlSeen.length = 0; handlers = []; };

/**
 * SQL with `-- comments` removed.
 *
 * Needed because these queries are heavily commented and the comments contain
 * the very words being tested for. The first run of this harness reported six
 * failures for "limit=0 produces no LIMIT" — the clause was correctly absent,
 * and the regex was matching the word LIMIT inside a comment explaining when
 * window functions are evaluated. A check a comment can fool is not a check.
 */
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

/** Every placeholder the text uses must be supplied, exactly once, with no gaps. */
function placeholdersOk(sql, params) {
  const used = [...new Set((sql.match(/\$(\d+)/g) || []).map(s => Number(s.slice(1))))]
    .sort((a, b) => a - b);
  if (!used.length) return { ok: params.length === 0, used, why: 'no placeholders' };
  const contiguous = used[used.length - 1] === used.length;
  const matched = params.length === used[used.length - 1];
  return {
    ok: contiguous && matched,
    used,
    why: `used [${used.join(',')}] against ${params.length} params`,
  };
}

const listSql = () => sqlSeen.find(s => /FROM sales_handovers h/.test(s.sql) && /member_count/.test(s.sql));

(async () => {
  // ══ 1. The unpaged default — today's production behaviour ═════════════════
  console.log('\n── unpaged (what the frontend actually sends) ──');
  reset();
  await svc.list(1, 5, { scope: 'org', userRole: 'admin' });
  let q = listSql();
  check('issued the list query', !!q);
  if (q) {
    check('no LIMIT when none was asked for', !/\bLIMIT\b/.test(stripComments(q.sql)));
    check('no OFFSET either', !/\bOFFSET\b/.test(stripComments(q.sql)));
    const p = placeholdersOk(q.sql, q.params);
    check('placeholders contiguous and all supplied', p.ok, p.why);
    // Without this the caller has no total and the paging switch needs another
    // backend change — the whole point of landing the shape now.
    check('the total window function is present', /COUNT\(\*\) OVER\(\)/.test(q.sql));
  }

  // list() must still hand back an ARRAY. scripts/test_projectTracking_service
  // calls it directly and uses .some/.every/.map; an object would have broken
  // it at "dflt.some is not a function", in a script nobody runs before deploy.
  reset();
  handlers = [[/member_count/, () => ({ rows: [] })]];
  const arr = await svc.list(1, 5, { scope: 'org', userRole: 'admin' });
  check('list() still returns an array', Array.isArray(arr), typeof arr);

  // ══ 2. Paging ═════════════════════════════════════════════════════════════
  console.log('\n── limit and offset ──');
  reset();
  await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', limit: 25 });
  q = listSql();
  check('LIMIT appears when asked for', !!q && /LIMIT \$\d+/.test(stripComments(q.sql)));
  check('no OFFSET when it is zero', !!q && !/\bOFFSET\b/.test(stripComments(q.sql)));
  let p = q && placeholdersOk(q.sql, q.params);
  check('placeholders still contiguous with a limit', !!p && p.ok, p && p.why);
  check('the limit value reached the params array', !!q && q.params.includes(25));

  reset();
  await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', limit: 25, offset: 50 });
  q = listSql();
  check('OFFSET appears with a non-zero offset', !!q && /OFFSET \$\d+/.test(stripComments(q.sql)));
  p = q && placeholdersOk(q.sql, q.params);
  check('placeholders contiguous with limit AND offset', !!p && p.ok, p && p.why);
  check('both values reached the params array',
    !!q && q.params.includes(25) && q.params.includes(50), JSON.stringify(q && q.params));

  // A junk limit must produce NO clause, not `LIMIT NULL` and not `LIMIT NaN`.
  for (const bad of [0, -5, null, undefined, 'abc', 1.5]) {
    reset();
    await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', limit: bad });
    q = listSql();
    const pp = q && placeholdersOk(q.sql, q.params);
    check(`limit=${JSON.stringify(bad)} produces no LIMIT and valid params`,
      !!q && !/\bLIMIT\b/.test(stripComments(q.sql)) && pp.ok, pp && pp.why);
  }

  // An offset with no limit is meaningless and must not emit a bare OFFSET.
  reset();
  await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', offset: 40 });
  q = listSql();
  check('offset without limit emits nothing', !!q && !/\bOFFSET\b/.test(stripComments(q.sql)));

  // ══ 3. listPage's envelope ════════════════════════════════════════════════
  console.log('\n── listPage envelope ──');
  reset();
  handlers = [[/member_count/, () => ({ rows: [
    { id: 1, total_count: 137, tracking_mode: 'timeboxed', assigned_service_owner_id: 3 },
  ] })]];
  const page = await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', limit: 25, offset: 50 });
  check('handovers is still the first-class key', Array.isArray(page.handovers));
  check('total comes from the window function', page.total === 137, String(page.total));
  check('limit is echoed back', page.limit === 25, String(page.limit));
  check('offset is echoed back', page.offset === 50, String(page.offset));

  // An empty page has no row to read the window value from. Zero, not
  // undefined — the client renders "N projects" from it.
  reset();
  handlers = [[/member_count/, () => ({ rows: [] })]];
  const empty = await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', limit: 25 });
  check('an empty page reports total 0, not undefined', empty.total === 0, String(empty.total));

  // ══ 4. Search ═════════════════════════════════════════════════════════════
  console.log('\n── search ──');
  reset();
  await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', q: 'apollo' });
  q = listSql();
  check('q adds an ILIKE predicate', !!q && /ILIKE/.test(q.sql));
  check('it searches project, deal AND account name',
    !!q && /h\.name ILIKE/.test(q.sql) && /d\.name ILIKE/.test(q.sql) && /a\.name ILIKE/.test(q.sql));
  check('wildcards are added server-side, not expected from the caller',
    !!q && q.params.includes('%apollo%'), JSON.stringify(q && q.params.slice(-2)));
  p = q && placeholdersOk(q.sql, q.params);
  check('placeholders contiguous with a search', !!p && p.ok, p && p.why);

  // The three predicates must share ONE placeholder. Three copies would work
  // but would push the params array out of step with any later clause.
  const ilikeParams = q ? [...new Set((q.sql.match(/ILIKE \$(\d+)/g) || []))] : [];
  check('all three ILIKEs use the same placeholder', ilikeParams.length === 1,
    ilikeParams.join(' '));

  // A project genuinely called "50% off" must search for itself, not match
  // everything. % and _ are ILIKE wildcards and have to be escaped.
  for (const [raw, want] of [
    ['50% off',   '%50\\% off%'],
    ['a_b',       '%a\\_b%'],
    ['back\\end', '%back\\\\end%'],
  ]) {
    reset();
    await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', q: raw });
    q = listSql();
    check(`"${raw}" is escaped as ${JSON.stringify(want)}`,
      !!q && q.params.includes(want),
      JSON.stringify(q && q.params[q.params.length - 1]));
  }

  // Blank and whitespace-only must add no clause at all, or an empty search
  // box would filter on '%%' and quietly exclude rows with NULL names.
  for (const blank of ['', '   ', null, undefined]) {
    reset();
    await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', q: blank });
    q = listSql();
    check(`q=${JSON.stringify(blank)} adds no ILIKE`, !!q && !/ILIKE/.test(q.sql));
  }

  // Search must combine with paging without either breaking the other.
  reset();
  await svc.listPage(1, 5, { scope: 'org', userRole: 'admin', q: 'apollo', limit: 10, offset: 20 });
  q = listSql();
  p = q && placeholdersOk(q.sql, q.params);
  check('search + limit + offset together keep params in step', !!p && p.ok, p && p.why);
  check('and the ILIKE placeholder precedes the LIMIT one',
    !!q && Number(/ILIKE \$(\d+)/.exec(stripComments(q.sql))[1]) < Number(/LIMIT \$(\d+)/.exec(stripComments(q.sql))[1]));

  // ══ 5. The read-path split ════════════════════════════════════════════════
  console.log('\n── getPersonProjectLink vs getPersonProjectItems ──');

  reset();
  await svc.getPersonProjectItems(42, 1);
  const itemsPlaySql = sqlSeen.find(s => /FROM project_play_instances ppi/.test(s.sql))?.sql || '';
  const itemsCommitSql = sqlSeen.find(s => /FROM sales_handover_commitments c/.test(s.sql))?.sql || '';
  check('items path queries plays', !!itemsPlaySql);
  check('items path queries commitments', !!itemsCommitSql);

  reset();
  handlers = [[/.*/, () => ({ rows: [] })]];
  const link = await svc.getPersonProjectLink(42, 1, 10);
  const linkSql = sqlSeen.find(s => /project_play_instances ppi/.test(s.sql))?.sql || '';
  check('link path issues one query, not a full item fetch', sqlSeen.length === 1,
    `${sqlSeen.length} queries`);
  check('link path returns null when there is no open work', link === null);
  check('the link query is bounded', /LIMIT 1/.test(stripComments(linkSql)));
  check('it is scoped to ONE project', /h\.id = \$3/.test(linkSql));

  // THE INVARIANT. The link is offered because a row is on the screen, so the
  // validator must apply the same rule the display does. Compared as normalised
  // text: if these ever diverge, a good link starts being refused with a
  // message indistinguishable from the honest refusal.
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const PLAY_RULE = norm(`ppi.status NOT IN ('completed', 'skipped', 'cancelled')
    AND h.status NOT IN ('completed', 'cancelled') AND h.retired_at IS NULL`);
  check('display and link share the PLAY predicates',
    norm(itemsPlaySql).includes(PLAY_RULE) && norm(linkSql).includes(PLAY_RULE),
    `display:${norm(itemsPlaySql).includes(PLAY_RULE)} link:${norm(linkSql).includes(PLAY_RULE)}`);

  const COMMIT_RULE = norm(`c.status IN ('open','in_progress')`).replace(/,\s*/g, ", ");
  const linkHasCommit = /sales_handover_commitments c/.test(linkSql);
  check('the link query also covers commitments', linkHasCommit);
  check('display and link share the COMMITMENT predicate',
    norm(itemsCommitSql).replace(/'open','in_progress'/, "'open', 'in_progress'").includes(COMMIT_RULE)
      && norm(linkSql).includes(COMMIT_RULE),
    'commitment rule text differs between the two queries');

  // Documented asymmetry, asserted so it cannot change by accident in either
  // direction. The commitment half does NOT test project status — see
  // OPEN_COMMITMENT_PREDICATES. If someone tightens it, this fires and they
  // have to decide deliberately rather than discover it in the People screen.
  const commitPart = linkSql.slice(linkSql.indexOf('sales_handover_commitments'));
  check('commitment half still omits the project-status test (known asymmetry)',
    !/h\.status NOT IN/.test(commitPart) && !/h\.retired_at/.test(commitPart),
    'the asymmetry documented at OPEN_COMMITMENT_PREDICATES has changed');

  // ══ 6. Rollup payload bounding (2026_141) ═════════════════════════════════
  //
  // The silent failure: slim mode must change WHAT IS SENT and nothing about
  // WHAT IS COUNTED. If the counts drifted, the People screen's "last 4 weeks"
  // figure would be quietly wrong — a number nobody can check by eye.
  console.log('\n── rollup payload bounding ──');
  const dq = require(path.join(ROOT, 'services/dailyWorkQuery.service.js'));

  // Two people, one of whom logged on two of the days in the window.
  const entryRows = [
    { user_id: 7, first_name: 'Ann', last_name: 'A',
      logged_dates: ['2026-09-01', '2026-09-02'], entry_count: 5,
      account_ids: [11, 12, 13], activity_keys: ['call', 'email'] },
  ];
  const nameRows = [{ id: 7, first_name: 'Ann', last_name: 'A' },
                    { id: 8, first_name: 'Bob', last_name: 'B' }];

  const rollupHandlers = () => ([
    [/array_agg\(DISTINCT e\.entry_date/, () => ({ rows: entryRows })],
    [/SELECT id, first_name, last_name FROM users/, () => ({ rows: nameRows })],
  ]);

  reset(); handlers = rollupHandlers();
  const full = await dq.getRollup(1, { userIds: [7, 8], from: '2026-09-01', to: '2026-09-04' });
  const fullSql = sqlSeen.find(s => /array_agg\(DISTINCT e\.entry_date/.test(s.sql))?.sql || '';

  reset(); handlers = rollupHandlers();
  const slim = await dq.getRollup(1, { userIds: [7, 8], from: '2026-09-01', to: '2026-09-04', slim: true });
  const slimSql = sqlSeen.find(s => /array_agg\(DISTINCT e\.entry_date/.test(s.sql))?.sql || '';

  check('both modes return one row per person', full.length === 2 && slim.length === 2,
    `${full.length} / ${slim.length}`);

  // THE INVARIANT.
  const fullBy = new Map(full.map(r => [r.user_id, r]));
  const slimBy = new Map(slim.map(r => [r.user_id, r]));
  check('slim counts are IDENTICAL to full counts',
    [...fullBy.keys()].every(id =>
      fullBy.get(id).days_logged === slimBy.get(id).days_logged
      && fullBy.get(id).working_days === slimBy.get(id).working_days
      && fullBy.get(id).rate === slimBy.get(id).rate),
    JSON.stringify([...slimBy.values()]));

  check('slim omits the per-day strip', slim.every(r => r.days === undefined));
  check('slim omits the account and activity arrays',
    slim.every(r => r.account_ids === undefined && r.activity_keys === undefined));
  // An empty `days` would draw a strip with no squares — a plausible-looking
  // lie. Absent is the honest shape.
  check('slim omits rather than empties', slim.every(r => !('days' in r)));

  check('slim skips the array aggregation in SQL',
    /'\{\}'::int\[\]\s+AS account_ids/.test(slimSql), 'account_ids still aggregated');
  check('full mode still aggregates them',
    /array_remove\(array_agg\(DISTINCT e\.account_id\), NULL\)/.test(fullSql));
  // logged_dates feeds loggingRate and must survive slim, or the counts break.
  check('logged_dates is aggregated in BOTH modes',
    /array_agg\(DISTINCT e\.entry_date/.test(slimSql) && /array_agg\(DISTINCT e\.entry_date/.test(fullSql));

  check('full mode sends account_count', full.every(r => typeof r.account_count === 'number'));
  check('and the count matches the ids it replaced',
    fullBy.get(7).account_count === 3, String(fullBy.get(7).account_count));
  // Sending days plus both date arrays was the same information three times.
  check('full mode no longer sends logged_dates or working_dates',
    full.every(r => r.logged_dates === undefined && r.working_dates === undefined));
  check('but still sends the strip the screen draws',
    full.every(r => Array.isArray(r.days)));

  console.log(failures ? `\n${failures} problem(s).` : '\nAll paging, split and payload checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
