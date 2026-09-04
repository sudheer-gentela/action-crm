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

const ROOT = path.resolve(process.argv[2]);

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

for (const arg of process.argv.slice(3)) {
  const [rel, expectCsv] = arg.split(':');
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
