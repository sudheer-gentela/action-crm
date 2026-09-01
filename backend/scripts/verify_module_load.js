#!/usr/bin/env node
/**
 * verify_module_load.js — loading beats syntax checking.
 *
 * `node --check` passed twice on a file where a rewrite had silently deleted
 * two functions. Loading the module executes module scope and reveals the
 * export surface, which is what actually catches that.
 *
 * Stubs must be CALLABLE AND INDEXABLE. requireModule exports a bare function
 * while most services export an object; a plain-object stub breaks the first
 * kind and a bare function breaks the second.
 */
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, 'gw/backend');

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

// Everything outside the module under test is stubbed; relative requires from
// within backend/ load for real, so a deleted function in a sibling shows up.
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

const targets = process.argv.slice(2);
let failures = 0;

for (const rel of targets) {
  const abs = path.resolve(ROOT, rel);
  try {
    delete require.cache[abs];
    const mod = require(abs);
    const keys = typeof mod === 'function'
      ? ['(bare function export)']
      : Object.keys(mod || {});
    console.log(`  ok    ${rel} — ${keys.length} export(s)`);
    // The specific regression: a named export that vanished.
    const expected = (process.env.EXPECT || '').split(',').filter(Boolean);
    for (const e of expected) {
      if (typeof mod === 'object' && !(e in mod)) {
        console.log(`  FAIL  ${rel}: expected export '${e}' is missing`);
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
