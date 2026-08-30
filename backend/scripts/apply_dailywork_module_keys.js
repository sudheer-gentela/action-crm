#!/usr/bin/env node
// apply_dailywork_module_keys.js
//
//   cd C:\Projects\dw-verify
//   node apply_dailywork_module_keys.js --dry-run     show the diff, change nothing
//   node apply_dailywork_module_keys.js               apply
//
// Adds 'dailywork' to every hardcoded module-key list in the backend.
//
// ── Why a script and not five manual edits ───────────────────────────
//
// There are SIX copies of the same list, in five files. Adding the key to one
// and missing another produces a partially-working module rather than a broken
// one, and each miss fails in a different, confusing way:
//
//   moduleAccess.service.js      user grants are silently filtered out, so
//                                every user looks ungranted
//   requireModule.middleware.js  getOrgModules omits the key, so the FRONTEND
//                                never learns the module is on — access control
//                                works, the nav stays hidden, and it looks like
//                                a frontend bug
//   orgAdmin.routes.js (x2)      the org admin toggle appears to work and
//                                silently saves nothing
//   superAdmin.routes.js         the platform 'allowed' flag cannot be set
//                                from the UI
//   user-preferences.routes.js   the module cannot be pinned in the nav
//                                (cosmetic — included, easy to drop)
//
// ── Line endings ─────────────────────────────────────────────────────
//
// Several backend files have MIXED line endings. This script only inserts text
// inside existing lines and never rewrites newlines, so a file with CRLF stays
// CRLF. It reports which files are mixed, because opening one in an editor that
// normalises on save turns a one-line review into a whole-file diff.
//
// Idempotent: a list that already contains 'dailywork' is left alone.

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const KEY = 'dailywork';

const REPO_CANDIDATES = [
  process.env.DW_REPO,
  path.join(__dirname, '..', 'action-crm-clean', 'backend'),
  'C:/Projects/action-crm-clean/backend',
  path.join(__dirname, '..', 'backend'),
].filter(Boolean);

const REPO = REPO_CANDIDATES.find(p => {
  try { return fs.existsSync(path.join(p, 'services', 'moduleAccess.service.js')); }
  catch { return false; }
});

if (!REPO) {
  console.error('\nCould not find the backend. Looked in:\n');
  REPO_CANDIDATES.forEach(p => console.error('  ' + p));
  console.error('\n  set DW_REPO=C:\\Projects\\action-crm-clean\\backend\n');
  process.exit(2);
}

const TARGETS = [
  { file: 'services/moduleAccess.service.js',        why: 'user grants are filtered against this' },
  { file: 'middleware/requireModule.middleware.js',  why: 'getOrgModules tells the frontend what is on' },
  { file: 'routes/orgAdmin.routes.js',               why: 'org admin read and toggle (two lists)' },
  { file: 'routes/superAdmin.routes.js',             why: 'platform allowed flag' },
  { file: 'routes/user-preferences.routes.js',       why: 'pinnable in the nav (cosmetic)' },
];

// Matches a module-key array by NAME, then appends the key inside the brackets,
// matching the quote style already in use. Anchoring on the variable name
// rather than on the exact list contents means this still works if someone has
// reordered or added a module since.
const LIST_RE = /((?:MODULE_KEYS|PINNABLE_MODULE_IDS)\s*=\s*\[)([^\]]*)\]/g;

let changedFiles = 0, changedLists = 0, alreadyDone = 0;
const mixed = [];

for (const target of TARGETS) {
  const full = path.join(REPO, target.file);

  if (!fs.existsSync(full)) {
    console.log(`\n  MISSING  ${target.file} — skipped`);
    continue;
  }

  const before = fs.readFileSync(full, 'utf8');

  const crlf = (before.match(/\r\n/g) || []).length;
  const lf = (before.match(/(?<!\r)\n/g) || []).length;
  if (crlf && lf) mixed.push(`${target.file} (${crlf} CRLF, ${lf} LF)`);

  let hitsHere = 0, skipsHere = 0;
  const after = before.replace(LIST_RE, (match, head, body) => {
    if (body.includes(`'${KEY}'`) || body.includes(`"${KEY}"`)) { skipsHere++; return match; }
    hitsHere++;
    const quote = body.includes('"') && !body.includes("'") ? '"' : "'";
    const trimmed = body.replace(/\s+$/, '');
    return `${head}${trimmed}, ${quote}${KEY}${quote}]`;
  });

  console.log(`\n${target.file}`);
  console.log(`  ${target.why}`);

  if (skipsHere) { alreadyDone += skipsHere; console.log(`  ok       ${skipsHere} list(s) already have ${KEY}`); }
  if (!hitsHere) { if (!skipsHere) console.log(`  none     no module-key list found here`); continue; }

  // Show exactly what changes, so the diff is reviewed before it is applied.
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  beforeLines.forEach((line, i) => {
    if (line !== afterLines[i]) {
      console.log(`  line ${i + 1}`);
      console.log(`    -  ${line.trim()}`);
      console.log(`    +  ${afterLines[i].trim()}`);
    }
  });

  if (!DRY) {
    fs.writeFileSync(full, after, 'utf8');
    console.log(`  ${DRY ? 'would write' : 'written'}`);
  }
  changedFiles++;
  changedLists += hitsHere;
}

console.log('\n' + '─'.repeat(62));
console.log(`${changedLists} list(s) in ${changedFiles} file(s) ${DRY ? 'would be' : 'were'} updated; ${alreadyDone} already had it.`);

if (mixed.length) {
  console.log('\nMixed line endings, do not let an editor normalise these:');
  mixed.forEach(m => console.log(`  - ${m}`));
  console.log('Check `git diff --stat` — a file you barely touched showing hundreds');
  console.log('of changed lines means the endings were rewritten.');
}

if (DRY) {
  console.log('\nDry run. Re-run without --dry-run to apply.\n');
} else if (changedLists) {
  console.log('\nRestart the backend, then confirm the guard with a request to the');
  console.log('REAL api host (not the page origin — that serves the SPA shell):\n');
  console.log('  it must return 404 with a JSON body while the org flag is off.\n');
}
