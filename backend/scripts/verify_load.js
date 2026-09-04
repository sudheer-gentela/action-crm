#!/usr/bin/env node
/**
 * verify_load.js — adapted from backend/scripts/verify_module_load.js.
 *
 * Only change of substance: ROOT is passed in (the original hard-codes
 * 'gw/backend' relative to its own directory, which is not this layout), and
 * EXPECT is per-target rather than global, so one run can assert a different
 * export set for each module.
 *
 * Usage: node verify_load.js <backendRoot> <rel>[:exportA,exportB] ...
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

// argv[2] is the root ONLY if it is not itself a target spec. A target spec
// always names a .js file; a root never does. Without this, running
//   node verify_load.js services/foo.js
// would try to use 'services/foo.js' as the backend root and report the
// confusing "Not a backend root" rather than auto-detecting and checking it.
const looksLikeTarget = (a) => !!a && /\.js(:|$)/.test(a);
const rootArg = looksLikeTarget(process.argv[2]) ? null : process.argv[2];
const ROOT = locateBackendRoot(rootArg);
const TARGETS = process.argv.slice(rootArg ? 3 : 2);

// Running this with no targets used to load nothing and print "All modules
// loaded." — a green result that verified nothing at all, which is the single
// most dangerous thing a verification script can do. Default to the modules
// this window actually changed, and say so.
const DEFAULT_TARGETS = [
  'services/projectMembers.service.js:canManageProject,manageableProjectSql,changeRole,listForHandover,reviewMember,selfExit,removeMember,requestMember,updateMemberContact,updateUserContact,autoApproveDecision',
  'services/playReview.service.js:myReviewQueue,resolveActorRole,transition,canEditPlay,listWatchers,setWatchers',
  'services/handover.service.js:createProject,canRebaseline,getById,list,setPlayDependencies',
  'routes/projectMembers.routes.js',
  'routes/handovers.routes.js',
];
if (!TARGETS.length) {
  console.log('No targets given — checking the modules changed in 2026_137.\n');
  TARGETS.push(...DEFAULT_TARGETS);
}

const makeStub = () => {
  const fn = function stub() { return stub; };
  return new Proxy(fn, {
    get: (t, k) => {
      if (k === 'then') return undefined;            // not thenable
      if (k === Symbol.toPrimitive) return () => 'stub';
      if (!(k in t)) t[k] = makeStub();
      return t[k];
    },
    apply: () => makeStub(),
    construct: () => makeStub(),
  });
};

const REAL_PREFIXES = [ROOT];
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

Module._load = function (request, parent, isMain) {
  let resolved;
  try { resolved = origResolve.call(this, request, parent, isMain); }
  catch { return makeStub(); }
  if (resolved.endsWith('.node')) return makeStub();
  if (REAL_PREFIXES.some(p => resolved.startsWith(p)) && !resolved.includes('node_modules')) {
    return origLoad.call(this, request, parent, isMain);
  }
  return makeStub();
};

let failures = 0;

for (const arg of TARGETS) {
  // Split on the LAST colon, not the first.
  //
  // `services/foo.js:doThing,doOther` splits the same either way, but an
  // absolute Windows path — `C:\repo\backend\services\foo.js` — has a colon at
  // index 1, and splitting on the first would take the module path to be `C`
  // and the export list to be the rest of the path. Every target would then
  // fail to load with a message about a file called C.
  //
  // Guarded on index > 1 so a bare drive-letter colon is not mistaken for an
  // export separator on a path carrying no exports at all.
  const cut = arg.lastIndexOf(':');
  const rel = cut > 1 ? arg.slice(0, cut) : arg;
  const expectCsv = cut > 1 ? arg.slice(cut + 1) : '';
  const abs = path.resolve(ROOT, rel);
  try {
    delete require.cache[abs];
    const mod = require(abs);
    const keys = typeof mod === 'function'
      ? ['(bare function export)']
      : Object.keys(mod || {});
    console.log(`  ok    ${rel} — ${keys.length} export(s)`);
    for (const e of (expectCsv || '').split(',').filter(Boolean)) {
      if (typeof mod !== 'object' || !(e in mod)) {
        console.log(`  FAIL  ${rel}: expected export '${e}' is missing`);
        failures++;
      } else if (typeof mod[e] !== 'function') {
        console.log(`  FAIL  ${rel}: export '${e}' is not a function`);
        failures++;
      }
    }
  } catch (err) {
    console.log(`  FAIL  ${rel}: ${err.message}`);
    failures++;
  }
}

console.log(failures ? `\n${failures} problem(s).` : '\nAll modules loaded.');
process.exit(failures ? 1 : 0);
