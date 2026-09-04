#!/usr/bin/env node
/**
 * check_changerole.js — exercise changeRole's 2026_137 guards.
 *
 * WHY THIS EXISTS. Every failure mode in these guards is SILENT. A guard that
 * does not fire produces a successful-looking write: the toggle flips, the
 * panel refreshes, and someone who should not hold project authority now does.
 * There is no error to notice. Nothing in lint or `node --check` can see it.
 *
 * So: stub the pool, drive changeRole with each combination that matters, and
 * assert on the UPDATE statement it produced (or the error it threw).
 */
const Module = require('module');
const path = require('path');

// ── Locating the backend ────────────────────────────────────────────────────
//
// LOCATE, do not assume. The first version of these harnesses took the backend
// root as a required argv[2] and did `path.resolve(process.argv[2])` with no
// guard, so running them the obvious way — `node check_sql.js` — threw
// ERR_INVALID_ARG_TYPE from inside node:path with a stack trace that named
// nothing about this script. A verification tool whose failure mode is a
// cryptic crash is worse than no tool: it costs time and teaches you to
// distrust it.
//
// So: take an explicit root when given one, otherwise search the obvious
// places. A backend root is identified by the two things every target here
// needs — a services/ directory and config/database.js — rather than by its
// name, so a directory called something else still resolves and a directory
// called 'backend' that is not one does not.
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
      console.error(
        `\nNot a backend root: ${abs}\n` +
        `Expected to find services/ and config/database.js inside it.\n`);
      process.exit(2);
    }
    return abs;
  }

  // Walk up from the working directory, checking each level and its backend/
  // subdirectory. Covers being run from the repo root, from backend/ itself,
  // or from a scratch directory beside either.
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

  console.error(
    `\nCould not find the backend root.\n\n` +
    `Pass it explicitly:\n` +
    `  node ${path.basename(process.argv[1])} <path-to-backend>\n\n` +
    `e.g.  node ${path.basename(process.argv[1])} C:\\Projects\\gowarmcrm\\backend\n\n` +
    `Looked in:\n${tried.map(t => `  ${t}`).join('\n')}\n`);
  process.exit(2);
}

const ROOT = locateBackendRoot(process.argv[2]);

let memberRow = null;
let lastUpdate = null;

let dbStub = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
  })();
  if (resolved && resolved.endsWith(path.join('config', 'database.js'))) {
    if (!dbStub) {
      dbStub = {
        pool: {
          query: async (sql, params) => {
            if (/^\s*SELECT id, side, status, can_manage/.test(sql)) {
              return { rows: memberRow ? [memberRow] : [], rowCount: memberRow ? 1 : 0 };
            }
            if (/^\s*UPDATE project_members/.test(sql)) {
              lastUpdate = { sql, params };
              return { rows: [{ id: params[0] }], rowCount: 1 };
            }
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

const svc = require(path.join(ROOT, 'services/projectMembers.service.js'));

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : ` — ${detail || ''}`}`);
  if (!cond) failures++;
};

// Reconstruct "what would this UPDATE actually set", by resolving each
// `col = $n` against the params array. Asserting on the SQL text alone would
// pass on `can_manage = $5` while $5 held the wrong value.
function resolved() {
  if (!lastUpdate) return null;
  const { sql, params } = lastUpdate;
  const setClause = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
  const out = {};
  for (const part of setClause.split(',')) {
    const m = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(part);
    if (!m) continue;
    const [, col, rhs] = m;
    const p = /^\$(\d+)$/.exec(rhs);
    out[col] = p ? params[Number(p[1]) - 1] : rhs;
  }
  return out;
}

async function run(label, row, patch) {
  memberRow = row; lastUpdate = null;
  try {
    await svc.changeRole(10, 1, row.id, patch);
    return { ok: true, set: resolved() };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code, status: e.status };
  }
}

(async () => {
  const approvedDelivery = { id: 5, side: 'delivery', status: 'approved', can_manage: false };
  const pendingDelivery  = { id: 6, side: 'delivery', status: 'pending',  can_manage: false };
  const acceptor         = { id: 7, side: 'internal_customer', status: 'approved', can_manage: false };
  const managerDelivery  = { id: 8, side: 'delivery', status: 'approved', can_manage: true };

  console.log('\n── granting can_manage ──');

  let r = await run('grant on approved delivery', approvedDelivery, { canManage: true });
  check('approved delivery member CAN be granted', r.ok && r.set.can_manage === true,
    r.ok ? `can_manage=${r.set?.can_manage}` : r.error);

  r = await run('grant on pending', pendingDelivery, { canManage: true });
  check('pending member is REFUSED', !r.ok && r.code === 'MEMBER_NOT_APPROVED',
    r.ok ? 'the write went through' : `${r.code}`);
  check('pending refusal is a 400, not a 500', !r.ok && r.status === 400, `status ${r.status}`);

  r = await run('grant on internal customer', acceptor, { canManage: true });
  check('internal customer is REFUSED', !r.ok && r.code === 'ACCEPTOR_CANNOT_MANAGE',
    r.ok ? 'the write went through' : `${r.code}`);

  console.log('\n── withdrawing ──');

  r = await run('withdraw', managerDelivery, { canManage: false });
  check('an existing manager CAN be withdrawn', r.ok && r.set.can_manage === false,
    r.ok ? `can_manage=${r.set?.can_manage}` : r.error);

  // Withdrawal must not be blocked by the approved-only rule. Someone whose
  // membership lapsed into pending is exactly who you most want to be able to
  // strip authority from, and a guard that refuses is a guard that traps it.
  r = await run('withdraw on pending', { ...pendingDelivery, can_manage: true }, { canManage: false });
  check('withdrawal is allowed even on a pending row', r.ok && r.set.can_manage === false,
    r.ok ? '' : r.error);

  console.log('\n── the side switch ──');

  r = await run('manager moved to internal customer', managerDelivery, { side: 'internal_customer' });
  check('side switch resets status to pending',
    r.ok && /pending/.test(String(r.set.status)), r.ok ? String(r.set.status) : r.error);
  check('side switch CLEARS can_manage',
    r.ok && /FALSE/i.test(String(r.set.can_manage)),
    r.ok ? `can_manage=${r.set?.can_manage}` : r.error);

  // The combination that would otherwise slip past: ask for the acceptor side
  // and the flag in one patch. pm.side is still 'delivery' when the guard runs,
  // so a guard reading the STORED side rather than the incoming one would let
  // this through and then set the side to internal_customer underneath it.
  r = await run('grant + become acceptor in one patch', approvedDelivery,
    { canManage: true, side: 'internal_customer' });
  check('grant + side switch in one patch is REFUSED',
    !r.ok && r.code === 'ACCEPTOR_CANNOT_MANAGE',
    r.ok ? `WROTE can_manage=${r.set?.can_manage} side=${r.set?.side}` : r.code);

  console.log('\n── untouched behaviour ──');

  r = await run('role change only', approvedDelivery, { roleId: 3 });
  check('a patch with no canManage does not touch the column',
    r.ok && !('can_manage' in r.set), r.ok ? Object.keys(r.set).join(',') : r.error);

  r = await run('departed member', { ...approvedDelivery, status: 'left' }, { canManage: true });
  check('a member who has left is still refused outright', !r.ok, r.ok ? 'went through' : '');

  console.log(failures ? `\n${failures} problem(s).` : '\nAll changeRole guards behave.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
