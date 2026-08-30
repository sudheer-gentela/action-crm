#!/usr/bin/env node
// apply_dailywork_app_registration.js
//
//   cd C:\Projects\dw-verify
//   node apply_dailywork_app_registration.js --dry-run
//   node apply_dailywork_app_registration.js
//
// Three edits to frontend/src/App.js. Idempotent, and it prints each change
// before applying it.
//
//   1. import DailyWorkView
//   2. add the nav entry to ALL_MODULE_ITEMS
//   3. add the render branch, gated on orgModules.dailywork
//
// Nothing else needs touching:
//
//   Sidebar   — App.js already filters ALL_MODULE_ITEMS by orgModules, so the
//               entry appears once the org flag and the user grant are both on.
//   /org/context — iterates whatever keys exist in settings.modules rather than
//               a hardcoded list, so it already returns dailywork.
//   normaliseModules — already collapses { allowed, enabled } to a boolean.
//
// Line endings are preserved: this only inserts text around existing anchors.

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');

const CANDIDATES = [
  process.env.DW_FRONTEND,
  path.join(__dirname, '..', 'action-crm-clean', 'frontend', 'src'),
  'C:/Projects/action-crm-clean/frontend/src',
  path.join(__dirname, '..', 'frontend', 'src'),
].filter(Boolean);

const SRC = CANDIDATES.find(p => {
  try { return fs.existsSync(path.join(p, 'App.js')); } catch { return false; }
});

if (!SRC) {
  console.error('\nCould not find frontend/src. Looked in:\n');
  CANDIDATES.forEach(p => console.error('  ' + p));
  console.error('\n  set DW_FRONTEND=C:\\Projects\\action-crm-clean\\frontend\\src\n');
  process.exit(2);
}

const APP = path.join(SRC, 'App.js');
let src = fs.readFileSync(APP, 'utf8');
const original = src;

const crlf = (src.match(/\r\n/g) || []).length;
const lf = (src.match(/(?<!\r)\n/g) || []).length;
const EOL = crlf > lf ? '\r\n' : '\n';

const done = [];
const skipped = [];

/* ── 1. the import ──────────────────────────────────────────────────── */

if (src.includes("import DailyWorkView")) {
  skipped.push('import already present');
} else {
  // Anchor on an existing view import so the new one lands with its peers
  // rather than at the top of the file above the React import.
  const anchor = src.match(/^import ContractsView.*$/m) || src.match(/^import ActionsView.*$/m);
  if (!anchor) {
    console.error('\nCould not find a view import to anchor to. Add this line by hand:\n');
    console.error("  import DailyWorkView from './DailyWorkView';\n");
    process.exit(1);
  }
  src = src.replace(anchor[0], `${anchor[0]}${EOL}import DailyWorkView from './DailyWorkView';`);
  done.push(`import added after: ${anchor[0].trim()}`);
}

/* ── 2. the nav entry ───────────────────────────────────────────────── */

if (/ALL_MODULE_ITEMS[\s\S]{0,600}?id: 'dailywork'/.test(src)) {
  skipped.push('nav entry already present');
} else {
  const anchor = "  { id: 'preview',     label: 'Data Preview', icon: '🔎' },";
  if (!src.includes(anchor)) {
    console.error('\nCould not find the ALL_MODULE_ITEMS anchor. Add this by hand inside it:\n');
    console.error("  { id: 'dailywork',   label: 'Daily Work',  icon: '📋' },\n");
    process.exit(1);
  }
  src = src.replace(anchor,
    `  { id: 'dailywork',   label: 'Daily Work',  icon: '📋' },${EOL}${anchor}`);
  done.push('nav entry added to ALL_MODULE_ITEMS');
}

/* ── 3. the render branch ───────────────────────────────────────────── */

if (src.includes("currentTab === 'dailywork'")) {
  skipped.push('render branch already present');
} else {
  const anchor = "          {currentTab === 'preview'     && <PreviewContacts />}";
  if (!src.includes(anchor)) {
    console.error('\nCould not find the render anchor. Add a branch by hand near the others.\n');
    process.exit(1);
  }
  // Same disabled-state shape as prospecting and contracts use, so an org
  // without the module sees the familiar message rather than a blank panel.
  const branch = [
    anchor,
    "          {currentTab === 'dailywork'   && (",
    '            orgModules.dailywork',
    '              ? <DailyWorkView />',
    "              : <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12, color:'#94a3b8' }}>",
    "                  <div style={{ fontSize:48 }}>📋</div>",
    "                  <div style={{ fontSize:16, fontWeight:600, color:'#475569' }}>Daily Work module is disabled</div>",
    "                  <div style={{ fontSize:13 }}>An org admin can enable it under Org Admin → Modules.</div>",
    '                </div>',
    '          )}',
  ].join(EOL);
  src = src.replace(anchor, branch);
  done.push('render branch added, gated on orgModules.dailywork');
}

/* ── report ─────────────────────────────────────────────────────────── */

console.log(`\nApp.js — ${path.resolve(APP)}`);
console.log(`line endings: ${crlf && lf ? `MIXED (${crlf} CRLF, ${lf} LF)` : (EOL === '\r\n' ? 'CRLF' : 'LF')}\n`);

skipped.forEach(s => console.log(`  ok      ${s}`));
done.forEach(d => console.log(`  ${DRY ? 'would' : 'did  '}   ${d}`));

if (!done.length) {
  console.log('\nNothing to do — App.js is already registered.\n');
} else if (DRY) {
  console.log('\nDry run, nothing written. Re-run without --dry-run to apply.\n');
} else {
  fs.writeFileSync(APP, src, 'utf8');
  console.log(`\nWritten. ${original.length} -> ${src.length} bytes.`);
  console.log('\nCheck `git diff --stat frontend/src/App.js` — it should show a handful');
  console.log('of changed lines. Hundreds means the line endings were rewritten.\n');
}
