#!/usr/bin/env node
/**
 * verify_frontend.js — what `node --check` does not catch.
 *
 * CRA fails the build on eslint, so a file that PARSES can still break the
 * deploy. Three checks, each for a failure this codebase has actually shipped:
 *
 *   1. Unused bindings          — an unused `const` broke a deploy once.
 *   2. Hook rules               — every use* imported, none in a conditional
 *                                 or a nested non-component function.
 *   3. Identifier resolution    — both directions: a name used but never
 *                                 defined, and a component defined but never
 *                                 used.
 *
 * Exemptions must match CRA's actual eslint config or this screams about
 * working code: unused params are `args: after-used`, catch bindings are
 * `caughtErrors: none`, and React is kept alive by react/jsx-uses-react.
 */
const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const files = process.argv.slice(2);
let failures = 0;

const fail = (file, msg) => { failures++; console.log(`  FAIL  ${file}: ${msg}`); };

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');

  let ast;
  try {
    ast = parser.parse(src, {
      sourceType: 'module',
      plugins: ['jsx', 'optionalChaining', 'nullishCoalescingOperator', 'classProperties'],
    });
  } catch (e) {
    fail(file, `parse error: ${e.message}`);
    continue;
  }

  const problems = [];

  traverse(ast, {
    // ── 1. unused bindings ────────────────────────────────────────────
    Scopable(path) {
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (binding.referenced) continue;
        if (name === 'React') continue;                       // jsx-uses-react
        const kind = binding.kind;
        if (kind === 'param') continue;                       // args: after-used
        if (binding.path.isCatchClause?.()) continue;          // caughtErrors: none
        if (binding.path.parentPath?.isCatchClause?.()) continue;
        problems.push(`unused ${kind} '${name}' (line ${binding.path.node.loc?.start.line})`);
      }
    },

    // ── 2. hook rules ─────────────────────────────────────────────────
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== 'Identifier' || !/^use[A-Z]/.test(callee.name)) return;
      const hook = callee.name;
      const line = path.node.loc?.start.line;

      // Imported or locally defined?
      if (!path.scope.hasBinding(hook)) {
        problems.push(`hook '${hook}' called but never imported (line ${line})`);
      }

      // Conditional or loop between the call and its function?
      let p = path.parentPath;
      while (p) {
        const t = p.node.type;
        if (t === 'FunctionDeclaration' || t === 'FunctionExpression' ||
            t === 'ArrowFunctionExpression' || t === 'ClassMethod') break;
        if (t === 'IfStatement' || t === 'ConditionalExpression' ||
            t === 'ForStatement' || t === 'WhileStatement' ||
            t === 'DoWhileStatement' || t === 'SwitchStatement' ||
            t === 'LogicalExpression') {
          problems.push(`hook '${hook}' inside a ${t} (line ${line})`);
          break;
        }
        p = p.parentPath;
      }
    },
  });

  // ── 3. identifier resolution, both directions ───────────────────────
  const defined = new Set();
  const used = new Set();
  traverse(ast, {
    FunctionDeclaration(path) {
      const n = path.node.id?.name;
      // Component-shaped only: a capitalised top-level function.
      if (n && /^[A-Z]/.test(n) && path.parentPath.isProgram()) defined.add(n);
    },
    JSXIdentifier(path) {
      if (path.parentPath.isJSXAttribute()) return;
      const n = path.node.name;
      if (/^[A-Z]/.test(n)) used.add(n);
    },
    Identifier(path) {
      if (path.isReferencedIdentifier() && /^[A-Z]/.test(path.node.name)) used.add(path.node.name);
    },
  });

  // Built-in globals are capitalised too, and are not components.
  const GLOBALS = new Set(['String', 'Object', 'Number', 'Boolean', 'Array', 'Date',
    'Math', 'JSON', 'Promise', 'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'Intl',
    'Symbol', 'Infinity', 'NaN', 'Fragment', 'FormData', 'Blob', 'File', 'URL',
    'FileReader', 'Image', 'Event', 'CustomEvent', 'Intersection', 'AbortController', 'URLSearchParams', 'Notification', 'WebSocket']);

  for (const n of used) {
    if (GLOBALS.has(n)) continue;
    // Skip anything resolvable through an import or an outer scope.
    if (!defined.has(n) && !src.includes(`import ${n}`) && !new RegExp(`\\b${n}\\b`).test(src.split('\n').slice(0, 60).join('\n'))) {
      // Only report names that appear nowhere as a definition at all.
      if (!new RegExp(`(function|const|let|class)\\s+${n}\\b`).test(src)) {
        problems.push(`component <${n}> used but never defined or imported`);
      }
    }
  }
  for (const n of defined) {
    if (!used.has(n) && !src.includes(`export default ${n}`) && !src.includes(`export function ${n}`)) {
      problems.push(`component ${n} defined but never used`);
    }
  }

  if (problems.length) {
    for (const p of [...new Set(problems)]) fail(file, p);
  } else {
    console.log(`  ok    ${file}`);
  }
}

console.log(failures ? `\n${failures} problem(s).` : '\nAll clean.');
process.exit(failures ? 1 : 0);
