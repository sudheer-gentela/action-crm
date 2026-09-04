#!/usr/bin/env node
/**
 * check_sql.js — render the SQL myReviewQueue actually sends.
 *
 * `node --check` proves the template literal PARSES. It says nothing about
 * whether the interpolated fragment produces balanced, single-statement SQL
 * with the placeholders the parameter array supplies — and that is the whole
 * failure mode of building a WHERE clause by string concatenation.
 *
 * So: stub the pool, call the function, capture the text, and assert on it.
 */
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(process.argv[2]);
const captured = [];

// ONE instance, not one per require. Module._load is called afresh for every
// requiring module, so returning a new object each time handed playReview and
// this harness two different pools — and the mutation below landed on the one
// nothing was using.
let dbStub = null;

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); }
    catch { return null; }
  })();

  // The one module we replace wholesale: everything else in backend/ loads for
  // real, so a fragment coming from projectMembers.service is the fragment the
  // running server would use, not a copy of it written here.
  if (resolved && resolved.endsWith(path.join('config', 'database.js'))) {
    if (!dbStub) {
      let call = 0;
      dbStub = {
        pool: {
          query: async (sql, params) => {
            captured.push({ sql, params });
            call++;
            // myReviewQueue's first query is the org_users role lookup, and it
            // returns early on an empty result — so the query under test would
            // never be issued. One row gets it past that gate as a non-admin,
            // which is the arm we actually want to see rendered.
            if (call === 1) return { rows: [{ role: 'member' }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
          connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
        },
      };
    }
    return dbStub;
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

(async () => {
  const playReview = require(path.join(ROOT, 'services/playReview.service.js'));
  let failures = 0;
  const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : ` — ${detail || ''}`}`);
    if (!cond) failures++;
  };

  await playReview.myReviewQueue(7, 42, { limit: 50 });

  const q = captured.find(c => /in_review/.test(c.sql));
  check('myReviewQueue issued its main query', !!q);
  if (!q) { process.exit(1); }

  const sql = q.sql;
  console.log('\n--- rendered WHERE tail ---');
  console.log(sql.slice(sql.indexOf('WHERE')).trim());
  console.log('--- end ---\n');

  check('parentheses balanced',
    (sql.match(/\(/g) || []).length === (sql.match(/\)/g) || []).length,
    `${(sql.match(/\(/g) || []).length} open vs ${(sql.match(/\)/g) || []).length} close`);
  check('single statement (no stray semicolon)', !sql.trim().slice(0, -1).includes(';'));
  check('can_manage predicate present', /pm\.can_manage\s*=\s*TRUE/.test(sql));
  check('approved-only predicate present', /pm\.status\s*=\s*'approved'/.test(sql));
  check('exited_at guard present', /pm\.exited_at IS NULL/.test(sql));
  check('scoped to this project', /pm\.context_id\s*=\s*h\.id/.test(sql));
  check('scoped to this org', /pm\.org_id\s*=\s*\$1/.test(sql));
  check('service owner arm retained', /h\.assigned_service_owner_id\s*=\s*\$2/.test(sql));
  check('creator arm retained', /h\.created_by\s*=\s*\$2/.test(sql));
  check('org-admin arm retained', /\$3::boolean IS TRUE/.test(sql));

  // The parameter array must supply every placeholder the rendered text uses,
  // and no more. A fragment that referenced $5 would 500 at runtime only.
  const used = [...new Set((sql.match(/\$(\d+)/g) || []).map(s => Number(s.slice(1))))].sort((a, b) => a - b);
  check('placeholders are exactly $1..$N with no gaps',
    used.length > 0 && used[used.length - 1] === used.length,
    `used ${used.join(',')}`);
  check('parameter array length matches highest placeholder',
    q.params.length === used[used.length - 1],
    `${q.params.length} params vs $${used[used.length - 1]}`);

  // The alias the fragment introduces must not collide with one the outer
  // query already binds, or Postgres resolves the inner reference to the outer
  // table and the subquery silently stops filtering.
  //
  // The subquery's own `FROM project_members pm` has to come out of the text
  // first, or it is its own false positive — which is what the first run of
  // this check reported. Balanced-paren scan from each EXISTS ( to its match.
  const stripSubqueries = (text) => {
    let out = '', i = 0;
    while (i < text.length) {
      const m = /EXISTS\s*\(/i.exec(text.slice(i));
      if (!m) { out += text.slice(i); break; }
      const start = i + m.index + m[0].length;
      out += text.slice(i, start - 1);
      let depth = 1, j = start;
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      i = j;
    }
    return out;
  };
  const outerAliases = (stripSubqueries(sql).match(/\b(?:FROM|JOIN)\s+\w+\s+(\w+)/g) || [])
    .map(s => s.trim().split(/\s+/).pop())
    .filter(a => !/^(SELECT|WHERE|ON|AND|OR)$/i.test(a));
  check('subquery alias pm does not collide with an outer alias',
    !outerAliases.includes('pm'),
    `outer aliases: ${outerAliases.join(', ')}`);

  console.log(failures ? `\n${failures} problem(s).` : '\nSQL checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('harness error:', e.message); process.exit(1); });
