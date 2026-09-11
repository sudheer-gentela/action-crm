#!/usr/bin/env node
/**
 * verify_move_requests_142.js — behavioural verification of migration 2026_142.
 *
 * STANDALONE, same shape as verify_task_linked_136.js. Run it the same way:
 *
 *   node verify_move_requests_142.js
 *
 * with DATABASE_URL either in .env or set inline.
 *
 * What it proves, beyond "the tables exist":
 *
 *   - one OPEN request per item — including an approved request that still has
 *     a batch waiting, which a status-only index would let through
 *   - is_open cannot disagree with status where status decides it
 *   - a pending request holds no outcome, an approved one holds all of it
 *   - approvals and entries cannot point at a batch of a different request
 *   - a rejection must carry a reason; placement belongs to the target only
 *   - an entry cannot be outstanding in two requests at once
 *   - the entry-outcome shapes: unticked never moved, moved has a time,
 *     left-out has a reason, needs_edit belongs to a merge and is raised or
 *     cleared but never both
 *   - a merge deleting its source entry leaves the snapshot intact
 *   - deleting an ad-hoc task an approver named does not raise a constraint
 *     error — the named task simply goes
 *   - 'moved' is accepted for an assigned item and refused for a recurring one
 *   - scope_added_at survives its request being deleted
 *   - the grant source vocabulary, and that it survives its request going
 *   - deleting a user who requested or decided leaves the record with the name
 *     cleared; deleting the owner removes their requests with their items
 *   - no new foreign key to users(id) is NO ACTION (see the migration header on
 *     superAdmin.routes.js user deletion)
 *
 * TEARDOWN ORDER MATTERS. daily_work_move_requests.play_instance_id and
 * daily_work_items.play_instance_id are both ON DELETE NO ACTION towards
 * project_play_instances, which cascades from sales_handovers. Requests and
 * items must go before projects, or the teardown is refused — the constraints
 * working, not a harness bug.
 *
 * NOTE: none of the tables this touches carry RLS today, so a plain pool sees
 * every row. If that changes, this harness must set app.current_org_id per
 * statement or every query silently returns nothing.
 */

try { require('dotenv').config(); } catch { /* fine — env may be set inline */ }

let Pool;
try {
  ({ Pool } = require('pg'));
} catch {
  console.error('\nThe pg module is not installed in this folder.\n');
  console.error('From the folder holding this script:');
  console.error('  npm install pg dotenv\n');
  process.exit(2);
}

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  console.error('\nNo DATABASE_URL found.\n');
  console.error('Put it in a .env file next to this script, or (PowerShell):');
  console.error('  $env:DATABASE_URL="postgresql://..."; node verify_move_requests_142.js\n');
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

const FIXTURE_ORG  = 'DW142_VERIFY_FIXTURE';
const FIXTURE_SLUG = 'dw142-verify-fixture';

const NEW_TABLES = [
  'daily_work_move_requests', 'daily_work_move_batches',
  'daily_work_move_approvals', 'daily_work_move_entries',
];

let passed = 0, failed = 0;
const failures = [];

function pass(name) { passed++; console.log(`  PASS  ${name}`); }
function fail(name, detail) {
  failed++; failures.push(name);
  console.log(`  FAIL  ${name}\n          ${detail}`);
}
function check(name, condition, detail) {
  condition ? pass(name) : fail(name, detail || 'condition was false');
}

/**
 * Assert that `fn` fails with a NAMED constraint.
 *
 * err.constraint is what separates "the constraint did its job" from "the
 * fixture had a typo and the insert died for another reason". A bare try/catch
 * would call both a pass.
 */
async function expectViolation(name, constraintName, fn) {
  try {
    await fn();
    fail(name, `expected ${constraintName} to reject this, but the write succeeded`);
  } catch (err) {
    if (err.constraint === constraintName) pass(name);
    else fail(name, `expected constraint ${constraintName}, got ${err.constraint || '(none)'} — ${err.message}`);
  }
}

async function expectSuccess(name, fn) {
  try { const out = await fn(); pass(name); return out; }
  catch (err) {
    fail(name, `expected this to be accepted, got ${err.constraint || err.code} — ${err.message}`);
    return null;
  }
}

const q = (sql, params) => pool.query(sql, params);

/* ───────────────────────── structure ───────────────────────── */

async function structureChecks() {
  console.log('\nSTRUCTURE');

  const { rows: tables } = await q(
    `SELECT c.relname, c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
    [NEW_TABLES]);
  for (const t of NEW_TABLES) {
    const row = tables.find(r => r.relname === t);
    check(`${t} exists`, !!row);
    check(`${t} has no RLS, like the tables it sits beside`, row && !row.relrowsecurity);
  }

  // Every named constraint the service and this harness rely on. A constraint
  // that exists under another name is a constraint whose violation the service
  // cannot recognise.
  const expected = {
    daily_work_move_requests: [
      'chk_dwmr_status', 'chk_dwmr_placement', 'chk_dwmr_recurring_decision',
      'chk_dwmr_pending_shape', 'chk_dwmr_approved_shape', 'chk_dwmr_open_shape',
      'chk_dwmr_rejected_shape', 'chk_dwmr_withdrawn_shape', 'chk_dwmr_recurring_decided_shape',
    ],
    daily_work_move_batches: [
      'uq_dwmb_request_batch_no', 'uq_dwmb_id_request', 'chk_dwmb_batch_no',
      'chk_dwmb_status', 'chk_dwmb_decided_shape', 'chk_dwmb_executed_shape',
    ],
    daily_work_move_approvals: [
      'fk_dwma_batch', 'uq_dwma_batch_handover', 'chk_dwma_role', 'chk_dwma_decision',
      'chk_dwma_decided_shape', 'chk_dwma_rejection_reason', 'chk_dwma_placement',
      'chk_dwma_new_task_shape',
    ],
    daily_work_move_entries: [
      'fk_dwme_batch', 'chk_dwme_outcome', 'chk_dwme_unticked_outcome',
      'chk_dwme_unticked_shape', 'chk_dwme_moved_shape', 'chk_dwme_left_out_reason',
      'chk_dwme_needs_edit_shape', 'chk_dwme_copies_shape',
    ],
    project_play_instances: ['fk_ppi_added_by_move_request'],
    user_module_access: ['chk_uma_source', 'fk_uma_source_move_request'],
  };
  for (const [table, names] of Object.entries(expected)) {
    const { rows } = await q(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = ('public.' || $1)::regclass AND conname = ANY($2)`,
      [table, names]);
    const have = new Set(rows.map(r => r.conname));
    const missing = names.filter(n => !have.has(n));
    check(`${table}: all ${names.length} named constraints present`,
      missing.length === 0, `missing: ${missing.join(', ')}`);
  }

  const { rows: idx } = await q(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [['uq_dwmr_one_open_per_item', 'idx_dwmr_target_open', 'idx_dwmr_owner',
      'idx_dwmr_recurring_pending', 'idx_dwmb_pending', 'idx_dwma_pending_by_project',
      'idx_dwma_request', 'uq_dwme_entry_outstanding', 'idx_dwme_request_batch',
      'idx_dwme_target_open', 'idx_ppi_scope_added']]);
  const i = n => idx.find(r => r.indexname === n)?.indexdef || '';

  check('uq_dwmr_one_open_per_item is UNIQUE', /CREATE UNIQUE INDEX/i.test(i('uq_dwmr_one_open_per_item')));
  // Keyed on is_open, not status: an approved request with a later batch
  // waiting must still block a second request.
  check('uq_dwmr_one_open_per_item is partial on is_open',
    /WHERE is_open/i.test(i('uq_dwmr_one_open_per_item')), i('uq_dwmr_one_open_per_item') || 'missing');
  check('uq_dwme_entry_outstanding is UNIQUE', /CREATE UNIQUE INDEX/i.test(i('uq_dwme_entry_outstanding')));
  check('uq_dwme_entry_outstanding covers pending AND left_out_too_long',
    /pending/.test(i('uq_dwme_entry_outstanding')) && /left_out_too_long/.test(i('uq_dwme_entry_outstanding')),
    i('uq_dwme_entry_outstanding') || 'missing');
  for (const n of ['idx_dwmr_target_open', 'idx_dwmr_recurring_pending', 'idx_dwmb_pending',
                   'idx_dwma_pending_by_project', 'idx_dwme_target_open', 'idx_ppi_scope_added']) {
    check(`${n} exists and is partial`, /WHERE/i.test(i(n)), i(n) || 'missing');
  }
  for (const n of ['idx_dwmr_owner', 'idx_dwma_request', 'idx_dwme_request_batch']) {
    check(`${n} exists`, !!i(n));
  }

  // ── Delete actions ──────────────────────────────────────────────────
  // 'a' NO ACTION, 'c' CASCADE, 'n' SET NULL, 'r' RESTRICT.
  const { rows: fks } = await q(
    `SELECT conrelid::regclass::text AS on_table, conname, confdeltype,
            confrelid::regclass::text AS ref_table,
            (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
              WHERE attrelid = conrelid AND attnum = ANY(conkey)) AS cols
       FROM pg_constraint
      WHERE contype = 'f'
        AND (conrelid = ANY($1::regclass[])
             OR conname = ANY($2))`,
    [NEW_TABLES.map(t => `public.${t}`),
     ['fk_ppi_added_by_move_request', 'fk_uma_source_move_request']]);

  const toUsersNoAction = fks.filter(f => f.ref_table === 'users' && f.confdeltype === 'a');
  check('no new foreign key to users(id) is NO ACTION',
    toUsersNoAction.length === 0,
    toUsersNoAction.map(f => `${f.on_table}.${f.cols}`).join(', '));

  const fkOn = (table, col) => fks.find(f => f.on_table === table && (f.cols || []).join(',') === col);
  const expectDel = (label, table, col, want) => {
    const f = fkOn(table, col);
    check(label, f?.confdeltype === want, f ? `confdeltype = ${f.confdeltype}` : 'foreign key missing');
  };
  expectDel('requests.play_instance_id is NO ACTION (org delete cascades both sides)',
    'daily_work_move_requests', 'play_instance_id', 'a');
  expectDel('requests.item_id cascades with the item', 'daily_work_move_requests', 'item_id', 'c');
  expectDel('requests.owner_user_id cascades with the owner', 'daily_work_move_requests', 'owner_user_id', 'c');
  expectDel('requests.requested_by is SET NULL', 'daily_work_move_requests', 'requested_by', 'n');
  expectDel('approvals.existing_play_instance_id is SET NULL', 'daily_work_move_approvals',
    'existing_play_instance_id', 'n');
  expectDel('entries.entry_id is SET NULL (a merge deletes the source entry)',
    'daily_work_move_entries', 'entry_id', 'n');
  expectDel('approvals batch FK is composite and cascades', 'daily_work_move_approvals',
    'request_id,batch_id', 'c');
  expectDel('entries batch FK is composite and cascades', 'daily_work_move_entries',
    'request_id,batch_id', 'c');
  expectDel('project_play_instances.added_by_move_request_id is SET NULL',
    'project_play_instances', 'added_by_move_request_id', 'n');
  expectDel('user_module_access.source_move_request_id is SET NULL',
    'user_module_access', 'source_move_request_id', 'n');

  // ── The fence ───────────────────────────────────────────────────────
  const { rows: defs } = await q(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = ANY($1)`,
    [['chk_dwi_status_by_kind', 'chk_dwi_anchor_kind', 'project_play_instances_baseline_source_chk']]);
  const d = n => defs.find(r => r.conname === n)?.def || '';

  const statusDef = d('chk_dwi_status_by_kind');
  const recurringBranch = statusDef.slice(statusDef.indexOf('recurring'));
  const assignedBranch  = statusDef.slice(0, statusDef.indexOf('recurring'));
  check("'moved' is in the ASSIGNED status branch", /moved/.test(assignedBranch), statusDef);
  check("'moved' is NOT in the recurring status branch",
    statusDef.includes('recurring') && !/moved/.test(recurringBranch), statusDef);
  check('chk_dwi_anchor_kind is unchanged (no task anchor)',
    /handover/.test(d('chk_dwi_anchor_kind')) && !/play/.test(d('chk_dwi_anchor_kind')),
    d('chk_dwi_anchor_kind') || 'missing');
  check('baseline_source vocabulary is unchanged (added scope is its own column)',
    /rebaselined/.test(d('project_play_instances_baseline_source_chk'))
      && !/added/.test(d('project_play_instances_baseline_source_chk')),
    d('project_play_instances_baseline_source_chk') || 'missing');

  // daily_work_entries, play_evidence and play_notes must be exactly as they
  // were. A new column on either of the last two would also need both
  // immutability trigger functions edited (see 2026_131 section 8).
  const { rows: cols } = await q(
    `SELECT table_name, count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
        AND column_name ~ '(move|scope_added)'
      GROUP BY table_name`,
    [['daily_work_entries', 'play_evidence', 'play_notes']]);
  check('daily_work_entries, play_evidence and play_notes gained no move columns',
    cols.length === 0, cols.map(c => `${c.table_name}: ${c.n}`).join(', '));

  const { rows: trg } = await q(
    `SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = ANY($1::regclass[])`,
    [NEW_TABLES.map(t => `public.${t}`)]);
  check('the new tables carry no triggers', trg.length === 0, trg.map(t => t.tgname).join(', '));

  const { rows: [moved] } = await q(
    `SELECT count(*)::int AS n FROM daily_work_items WHERE status = 'moved'`);
  check('no existing item holds moved', moved.n === 0, `${moved.n} rows`);
}

/* ───────────────────────── fixture ─────────────────────────── */

async function setup() {
  await teardown();   // in case a previous run died before its finally block

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [FIXTURE_ORG, FIXTURE_SLUG]);

  const mkUser = async (first) => {
    const { rows: [u] } = await q(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
       VALUES ($1, 'x', $2, 'Fixture', $3) RETURNING id`,
      [`dw142.${first.toLowerCase()}.${Date.now()}@fixture.invalid`, first, org.id]);
    await q(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1, $2, 'member')`,
      [org.id, u.id]);
    return u.id;
  };

  // Ana logs the work. Mo is her manager and raises requests for her. Pat
  // decides. Cy created the projects. Kept distinct so the user-deletion checks
  // can remove Ana, Mo and Pat without touching a reference this migration does
  // not own — sales_handovers.created_by is NOT NULL, so its creator cannot be
  // deleted without reassigning the project first, which is not what is being
  // tested here.
  const ana = await mkUser('Ana');
  const mo  = await mkUser('Mo');
  const pat = await mkUser('Pat');
  const cy  = await mkUser('Cy');

  const mkProject = async (name, trackingMode) => {
    const { rows: [h] } = await q(
      `INSERT INTO sales_handovers
         (org_id, name, project_kind, tracking_mode, status, created_by)
       VALUES ($1, $2, 'internal', $3, 'in_progress', $4) RETURNING id`,
      [org.id, name, trackingMode, cy]);
    return h.id;
  };

  const target = await mkProject('DW142 Target', 'timeboxed');
  const source = await mkProject('DW142 Source', 'timeboxed');

  return { orgId: org.id, ana, mo, pat, target, source };
}

async function teardown() {
  const orgSel = `(SELECT id FROM organizations WHERE name = '${FIXTURE_ORG}')`;
  // Requests first: their play_instance_id is NO ACTION towards tasks, and the
  // project delete below cascades to tasks. Batches, approvals and move entries
  // cascade from requests.
  await q(`DELETE FROM daily_work_move_requests WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM daily_work_entries       WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM daily_work_items         WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM sales_handovers          WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM user_module_access       WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM org_users                WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM users                    WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM organizations            WHERE name = '${FIXTURE_ORG}'`);
}

/* ───────────────────────── helpers ─────────────────────────── */

let seq = 0;

async function mkTask(orgId, handoverId) {
  seq += 1;
  const { rows: [p] } = await q(
    `INSERT INTO project_play_instances
       (handover_id, org_id, stage_key, title, status, sort_order)
     VALUES ($1, $2, 'custom', $3, 'not_started', $4) RETURNING id`,
    [handoverId, orgId, `DW142 task ${seq}`, seq * 10]);
  return p.id;
}

async function mkItem(orgId, ownerId, kind = 'assigned') {
  seq += 1;
  const { rows: [i] } = await q(
    `INSERT INTO daily_work_items (org_id, owner_user_id, kind, title, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, ownerId, kind, `DW142 item ${seq}`, kind === 'assigned' ? 'in_progress' : 'active']);
  return i.id;
}

async function mkEntry(orgId, itemId, userId, date) {
  const { rows: [e] } = await q(
    `INSERT INTO daily_work_entries
       (org_id, item_id, user_id, entry_date, description, day_stage)
     VALUES ($1, $2, $3, $4, 'DW142 entry text', 'in_progress') RETURNING id`,
    [orgId, itemId, userId, date]);
  return e.id;
}

/** A pending request with its batch 1. Returns { requestId, batchId }. */
async function mkRequest(f, itemId, extra = {}) {
  const { rows: [r] } = await q(
    `INSERT INTO daily_work_move_requests
       (org_id, item_id, owner_user_id, requested_by, target_handover_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [f.orgId, itemId, f.ana, extra.requestedBy || f.ana, f.target]);
  const { rows: [b] } = await q(
    `INSERT INTO daily_work_move_batches (org_id, request_id, batch_no, added_by)
     VALUES ($1, $2, 1, $3) RETURNING id`,
    [f.orgId, r.id, extra.requestedBy || f.ana]);
  return { requestId: r.id, batchId: b.id };
}

/** Close a request so the item is free for another. */
async function closeRequest(requestId) {
  await q(
    `UPDATE daily_work_move_requests
        SET status = 'withdrawn', is_open = false, withdrawn_at = now()
      WHERE id = $1`, [requestId]);
}

/** A move-entry row, snapshot filled from the entry. */
async function mkMoveEntry(f, requestId, batchId, entryId, cols = {}) {
  const names = Object.keys(cols);
  const { rows: [m] } = await q(
    `INSERT INTO daily_work_move_entries
       (org_id, request_id, batch_id, entry_id,
        snap_item_id, snap_entry_date, snap_description, snap_day_stage
        ${names.map(n => `, ${n}`).join('')})
     SELECT $1, $2, $3, e.id, e.item_id, e.entry_date, e.description, e.day_stage
            ${names.map((_, k) => `, $${k + 5}`).join('')}
       FROM daily_work_entries e WHERE e.id = $4
     RETURNING id`,
    [f.orgId, requestId, batchId, entryId, ...names.map(n => cols[n])]);
  if (!m) throw new Error(`fixture: entry ${entryId} not found`);
  return m.id;
}

/* ───────────────────────── behaviour ───────────────────────── */

async function requestChecks(f) {
  console.log('\nBEHAVIOUR — requests and the one-open-request rule');

  const item = await mkItem(f.orgId, f.ana);
  const first = await mkRequest(f, item);
  pass('a pending request is accepted');

  await expectViolation('a second open request on the same item is refused',
    'uq_dwmr_one_open_per_item', () => mkRequest(f, item));

  await expectViolation('pending with is_open = false is refused',
    'chk_dwmr_open_shape',
    () => q(`UPDATE daily_work_move_requests SET is_open = false WHERE id = $1`, [first.requestId]));

  const task = await mkTask(f.orgId, f.target);
  await expectViolation('a pending request cannot already name its task',
    'chk_dwmr_pending_shape',
    () => q(`UPDATE daily_work_move_requests SET play_instance_id = $2 WHERE id = $1`,
      [first.requestId, task]));

  await expectViolation('approved without the outcome recorded is refused',
    'chk_dwmr_approved_shape',
    () => q(`UPDATE daily_work_move_requests SET status = 'approved' WHERE id = $1`, [first.requestId]));

  await expectViolation('withdrawn without withdrawn_at is refused',
    'chk_dwmr_withdrawn_shape',
    () => q(`UPDATE daily_work_move_requests SET status = 'withdrawn', is_open = false
              WHERE id = $1`, [first.requestId]));

  await expectViolation('rejected but still open is refused',
    'chk_dwmr_open_shape',
    () => q(`UPDATE daily_work_move_requests SET status = 'rejected', decided_at = now()
              WHERE id = $1`, [first.requestId]));

  await expectSuccess('withdrawing closes the request',
    () => closeRequest(first.requestId));

  const second = await expectSuccess('once closed, a new request on the item is accepted',
    () => mkRequest(f, item));

  // ── approved, with a later batch waiting ────────────────────────────
  // This is why the index keys on is_open rather than status.
  if (second) {
    await expectSuccess('an approved request that is still open is accepted',
      () => q(`UPDATE daily_work_move_requests
                  SET status = 'approved', placement = 'existing_task',
                      play_instance_id = $2, decided_at = now(), executed_at = now()
                WHERE id = $1`, [second.requestId, task]));

    await expectViolation('while it is open, a further request on the item is refused',
      'uq_dwmr_one_open_per_item', () => mkRequest(f, item));

    await q(`UPDATE daily_work_move_requests SET is_open = false WHERE id = $1`, [second.requestId]);
    const third = await expectSuccess('once its last batch is decided, the item is free again',
      () => mkRequest(f, item));
    if (third) await closeRequest(third.requestId);

    await expectViolation("a recurring decision of 'retired' needs its time",
      'chk_dwmr_recurring_decided_shape',
      () => q(`UPDATE daily_work_move_requests SET recurring_decision = 'retired'
                WHERE id = $1`, [second.requestId]));
    await expectSuccess("'pending' needs no time — it is the question waiting",
      () => q(`UPDATE daily_work_move_requests SET recurring_decision = 'pending'
                WHERE id = $1`, [second.requestId]));
  }
}

async function batchAndApprovalChecks(f) {
  console.log('\nBEHAVIOUR — batches and approvals');

  const itemA = await mkItem(f.orgId, f.ana);
  const itemB = await mkItem(f.orgId, f.ana);
  const a = await mkRequest(f, itemA);
  const b = await mkRequest(f, itemB);

  await expectViolation('batch_no 0 is refused', 'chk_dwmb_batch_no',
    () => q(`INSERT INTO daily_work_move_batches (org_id, request_id, batch_no) VALUES ($1, $2, 0)`,
      [f.orgId, a.requestId]));
  await expectViolation('a duplicate batch number on one request is refused',
    'uq_dwmb_request_batch_no',
    () => q(`INSERT INTO daily_work_move_batches (org_id, request_id, batch_no) VALUES ($1, $2, 1)`,
      [f.orgId, a.requestId]));
  await expectViolation('a pending batch cannot carry decided_at', 'chk_dwmb_decided_shape',
    () => q(`UPDATE daily_work_move_batches SET decided_at = now() WHERE id = $1`, [a.batchId]));
  await expectViolation('an approved batch must have executed', 'chk_dwmb_executed_shape',
    () => q(`UPDATE daily_work_move_batches SET status = 'approved', decided_at = now()
              WHERE id = $1`, [a.batchId]));

  // Plain SQL rather than a column-map helper: role is part of what each check
  // is about, so it is always written out.
  const plainApproval = (reqId, batchId, handoverId, role, extraSql = '', extra = []) =>
    q(`INSERT INTO daily_work_move_approvals
         (org_id, request_id, batch_id, handover_id, role${extraSql ? `, ${extraSql}` : ''})
       VALUES ($1, $2, $3, $4, $5${extra.map((_, k) => `, $${k + 6}`).join('')})
       RETURNING id`,
      [f.orgId, reqId, batchId, handoverId, role, ...extra]);

  await expectViolation('an approval cannot point at a batch of another request',
    'fk_dwma_batch', () => plainApproval(a.requestId, b.batchId, f.target, 'target'));

  const { rows: [targetRow] } = await plainApproval(a.requestId, a.batchId, f.target, 'target');
  pass('a target approval on its own batch is accepted');

  await expectViolation('one approval per project per batch',
    'uq_dwma_batch_handover', () => plainApproval(a.requestId, a.batchId, f.target, 'source'));

  const { rows: [sourceRow] } = await plainApproval(a.requestId, a.batchId, f.source, 'source');
  pass('a source approval for another project on the same batch is accepted');

  await expectViolation('a decision needs its time', 'chk_dwma_decided_shape',
    () => q(`UPDATE daily_work_move_approvals SET decision = 'approved' WHERE id = $1`, [targetRow.id]));

  await expectViolation('a rejection without a reason is refused', 'chk_dwma_rejection_reason',
    () => q(`UPDATE daily_work_move_approvals
                SET decision = 'rejected', decided_at = now(), decided_by = $2
              WHERE id = $1`, [sourceRow.id, f.pat]));
  await expectViolation('a blank reason is refused too', 'chk_dwma_rejection_reason',
    () => q(`UPDATE daily_work_move_approvals
                SET decision = 'rejected', decided_at = now(), reason = '   '
              WHERE id = $1`, [sourceRow.id]));

  const task = await mkTask(f.orgId, f.target);
  await expectViolation('a source approval cannot choose placement', 'chk_dwma_placement',
    () => q(`UPDATE daily_work_move_approvals
                SET placement = 'existing_task', existing_play_instance_id = $2
              WHERE id = $1`, [sourceRow.id, task]));
  await expectViolation('a new-task spec needs new_task placement', 'chk_dwma_new_task_shape',
    () => q(`UPDATE daily_work_move_approvals
                SET placement = 'existing_task', new_task = '{"title":"x"}'
              WHERE id = $1`, [targetRow.id]));

  await expectSuccess('the target approver can name an existing task',
    () => q(`UPDATE daily_work_move_approvals
                SET placement = 'existing_task', existing_play_instance_id = $2,
                    decision = 'approved', decided_at = now(), decided_by = $3
              WHERE id = $1`, [targetRow.id, task, f.pat]));

  // Before the move there is no linked item, so the ad-hoc task is still
  // deletable. That delete must not raise a constraint error in Projects.
  await expectSuccess('deleting an ad-hoc task an approver named is not refused',
    () => q(`DELETE FROM project_play_instances WHERE id = $1`, [task]));
  const { rows: [after] } = await q(
    `SELECT placement, existing_play_instance_id FROM daily_work_move_approvals WHERE id = $1`,
    [targetRow.id]);
  check('the named task is cleared, the decision is kept',
    after.existing_play_instance_id === null && after.placement === 'existing_task',
    JSON.stringify(after));

  await closeRequest(a.requestId);
  await closeRequest(b.requestId);
}

async function entryChecks(f) {
  console.log('\nBEHAVIOUR — move entries');

  const item  = await mkItem(f.orgId, f.ana, 'recurring');
  const other = await mkItem(f.orgId, f.ana);
  const e1 = await mkEntry(f.orgId, item, f.ana, '2026-09-01');
  const e2 = await mkEntry(f.orgId, item, f.ana, '2026-09-02');
  const e3 = await mkEntry(f.orgId, item, f.ana, '2026-09-03');

  const r1 = await mkRequest(f, item);
  const rOther = await mkRequest(f, other);

  await expectViolation('a move entry cannot point at a batch of another request',
    'fk_dwme_batch', () => mkMoveEntry(f, r1.requestId, rOther.batchId, e1));

  const m1 = await expectSuccess('a pending move entry with its snapshot is accepted',
    () => mkMoveEntry(f, r1.requestId, r1.batchId, e1));

  await expectViolation('an unticked entry needs unticked_at', 'chk_dwme_unticked_shape',
    () => q(`UPDATE daily_work_move_entries SET selected = false WHERE id = $1`, [m1]));
  await expectViolation('an unticked entry cannot have moved', 'chk_dwme_unticked_outcome',
    () => q(`UPDATE daily_work_move_entries
                SET selected = false, unticked_at = now(), outcome = 'moved', moved_at = now()
              WHERE id = $1`, [m1]));
  await expectViolation('moved needs moved_at', 'chk_dwme_moved_shape',
    () => q(`UPDATE daily_work_move_entries SET outcome = 'moved' WHERE id = $1`, [m1]));
  await expectViolation('left out needs a reason', 'chk_dwme_left_out_reason',
    () => q(`UPDATE daily_work_move_entries SET outcome = 'left_out_too_long' WHERE id = $1`, [m1]));
  await expectViolation('needs_edit on a plain move is refused', 'chk_dwme_needs_edit_shape',
    () => q(`UPDATE daily_work_move_entries
                SET outcome = 'moved', moved_at = now(), needs_edit = true WHERE id = $1`, [m1]));
  await expectViolation('needs_edit raised and cleared at once is refused', 'chk_dwme_needs_edit_shape',
    () => q(`UPDATE daily_work_move_entries
                SET outcome = 'merged', moved_at = now(), needs_edit = true,
                    needs_edit_cleared_at = now()
              WHERE id = $1`, [m1]));
  await expectViolation('copied evidence belongs to a merge only', 'chk_dwme_copies_shape',
    () => q(`UPDATE daily_work_move_entries
                SET outcome = 'moved', moved_at = now(), copied_evidence = '[]'
              WHERE id = $1`, [m1]));

  // ── an entry cannot be outstanding twice ────────────────────────────
  // r1 approved and closed, with e2 left out waiting to auto-merge; a new
  // request on the same (kept, recurring) item selects e2 again.
  const task = await mkTask(f.orgId, f.target);
  await mkMoveEntry(f, r1.requestId, r1.batchId, e2,
    { outcome: 'left_out_too_long', left_out_reason: 'combined text over 2000 characters' });
  pass('a left-out entry with its reason is accepted');
  await q(`UPDATE daily_work_move_batches SET status = 'approved', decided_at = now(), executed_at = now()
            WHERE id = $1`, [r1.batchId]);
  await q(`UPDATE daily_work_move_requests
              SET status = 'approved', is_open = false, placement = 'existing_task',
                  play_instance_id = $2, decided_at = now(), executed_at = now()
            WHERE id = $1`, [r1.requestId, task]);

  const r2 = await mkRequest(f, item);
  await expectViolation('an entry still waiting to merge cannot join a second request',
    'uq_dwme_entry_outstanding', () => mkMoveEntry(f, r2.requestId, r2.batchId, e2));
  await expectSuccess('a different entry on the same item can',
    () => mkMoveEntry(f, r2.requestId, r2.batchId, e3));

  // ── a merge deletes its source entry; the record survives ───────────
  await q(`UPDATE daily_work_move_entries
              SET outcome = 'merged', moved_at = now(), needs_edit = true,
                  target_entry_id = NULL, copied_evidence = '[]', copied_notes = '[]'
            WHERE id = $1`, [m1]);
  await expectSuccess('the merged source entry can be deleted',
    () => q(`DELETE FROM daily_work_entries WHERE id = $1`, [e1]));
  const { rows: [rec] } = await q(
    `SELECT entry_id, snap_description, snap_entry_date::text AS d, needs_edit
       FROM daily_work_move_entries WHERE id = $1`, [m1]);
  check('the move record keeps its snapshot with entry_id cleared',
    rec.entry_id === null && rec.snap_description === 'DW142 entry text'
      && rec.d === '2026-09-01' && rec.needs_edit === true,
    JSON.stringify(rec));

  await expectSuccess('clearing needs_edit with its time is accepted',
    () => q(`UPDATE daily_work_move_entries
                SET needs_edit = false, needs_edit_cleared_at = now(), needs_edit_cleared_by = $2
              WHERE id = $1`, [m1, f.ana]));

  await closeRequest(r2.requestId);
  await closeRequest(rOther.requestId);
}

async function statusChecks(f) {
  console.log("\nBEHAVIOUR — 'moved'");

  const assigned  = await mkItem(f.orgId, f.ana, 'assigned');
  const recurring = await mkItem(f.orgId, f.ana, 'recurring');

  await expectSuccess("an assigned item can be 'moved'",
    () => q(`UPDATE daily_work_items SET status = 'moved', closed_at = now() WHERE id = $1`, [assigned]));
  await expectViolation("a recurring item cannot be 'moved'", 'chk_dwi_status_by_kind',
    () => q(`UPDATE daily_work_items SET status = 'moved' WHERE id = $1`, [recurring]));
  await expectSuccess('every existing assigned status is still accepted',
    async () => {
      for (const s of ['yet_to_start', 'in_progress', 'in_review', 'completed', 'dropped']) {
        await q(`UPDATE daily_work_items SET status = $2 WHERE id = $1`, [assigned, s]);
      }
    });
  await expectViolation("the old word 'not_started' is still refused", 'chk_dwi_status_by_kind',
    () => q(`UPDATE daily_work_items SET status = 'not_started' WHERE id = $1`, [assigned]));
}

async function scopeAndGrantChecks(f) {
  console.log('\nBEHAVIOUR — added scope and grant source outlive their request');

  const item = await mkItem(f.orgId, f.ana);
  const r = await mkRequest(f, item);
  const task = await mkTask(f.orgId, f.target);

  await q(`UPDATE project_play_instances
              SET added_by_move_request_id = $2, scope_added_at = now() WHERE id = $1`,
    [task, r.requestId]);

  await expectViolation('an unknown grant source is refused', 'chk_uma_source',
    () => q(`INSERT INTO user_module_access (org_id, user_id, module_key, source)
             VALUES ($1, $2, 'dailywork', 'because')`, [f.orgId, f.pat]));
  await expectSuccess("'move_request_approver' is accepted",
    () => q(`INSERT INTO user_module_access
               (org_id, user_id, module_key, granted_by, source, source_move_request_id)
             VALUES ($1, $2, 'dailywork', $3, 'move_request_approver', $4)`,
      [f.orgId, f.pat, f.ana, r.requestId]));

  await expectSuccess('the request can be deleted',
    () => q(`DELETE FROM daily_work_move_requests WHERE id = $1`, [r.requestId]));

  const { rows: [t] } = await q(
    `SELECT added_by_move_request_id, scope_added_at FROM project_play_instances WHERE id = $1`, [task]);
  check('the task keeps scope_added_at when its request goes',
    t.added_by_move_request_id === null && t.scope_added_at !== null, JSON.stringify(t));

  const { rows: [g] } = await q(
    `SELECT source, source_move_request_id FROM user_module_access
      WHERE org_id = $1 AND user_id = $2 AND module_key = 'dailywork'`, [f.orgId, f.pat]);
  check('the grant keeps its source when its request goes',
    g && g.source === 'move_request_approver' && g.source_move_request_id === null,
    JSON.stringify(g));
}

async function userDeletionChecks(f) {
  console.log('\nBEHAVIOUR — deleting users');

  // Mo raises a request for Ana, Pat decides. Deleting Mo and then Pat must
  // leave the request with the names cleared — never fail.
  const item = await mkItem(f.orgId, f.ana);
  const r = await mkRequest(f, item, { requestedBy: f.mo });
  await q(`INSERT INTO daily_work_move_approvals
             (org_id, request_id, batch_id, handover_id, role, decision, decided_by, decided_at, reason)
           VALUES ($1, $2, $3, $4, 'target', 'rejected', $5, now(), 'not this quarter')`,
    [f.orgId, r.requestId, r.batchId, f.target, f.pat]);
  await q(`UPDATE daily_work_move_requests SET status = 'rejected', is_open = false, decided_at = now()
            WHERE id = $1`, [r.requestId]);

  await expectSuccess('deleting the manager who raised it is not refused',
    () => q(`DELETE FROM users WHERE id = $1`, [f.mo]));
  const { rows: [req] } = await q(
    `SELECT requested_by, status FROM daily_work_move_requests WHERE id = $1`, [r.requestId]);
  check('the request survives with requested_by cleared',
    req && req.requested_by === null && req.status === 'rejected', JSON.stringify(req));

  await expectSuccess('deleting the approver is not refused',
    () => q(`DELETE FROM users WHERE id = $1`, [f.pat]));
  const { rows: [appr] } = await q(
    `SELECT decided_by, decision, reason FROM daily_work_move_approvals WHERE request_id = $1`,
    [r.requestId]);
  check('the decision survives with decided_by cleared',
    appr && appr.decided_by === null && appr.decision === 'rejected' && appr.reason === 'not this quarter',
    JSON.stringify(appr));

  // The owner's requests go with the owner's items.
  await expectSuccess('deleting the owner is not refused',
    () => q(`DELETE FROM users WHERE id = $1`, [f.ana]));
  const { rows: [left] } = await q(
    `SELECT count(*)::int AS n FROM daily_work_move_requests WHERE org_id = $1`, [f.orgId]);
  check("the owner's requests are removed with them", left.n === 0, `${left.n} remain`);
}

/* ───────────────────────── run ─────────────────────────────── */

(async () => {
  console.log('\nverify_move_requests_142 — migration 2026_142');
  console.log(`target:      ${CONN.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`fixture org: ${FIXTURE_ORG}\n`);

  let fixture;
  try {
    await structureChecks();
    fixture = await setup();
    await requestChecks(fixture);
    await batchAndApprovalChecks(fixture);
    await entryChecks(fixture);
    await statusChecks(fixture);
    await scopeAndGrantChecks(fixture);
    // Last: it deletes the fixture's users.
    await userDeletionChecks(fixture);
  } catch (err) {
    fail('harness aborted', err.stack || err.message);
  } finally {
    try { await teardown(); console.log('\nfixture torn down'); }
    catch (err) {
      console.log(`\nWARNING: teardown failed — ${err.message}`);
      console.log('The fixture org is STILL PRESENT. Remove it with:\n');
      console.log('  BEGIN;');
      // The teardown order, and it is load-bearing: requests and items before
      // the projects whose tasks they point at.
      for (const t of ['daily_work_move_requests', 'daily_work_entries', 'daily_work_items',
                       'sales_handovers', 'user_module_access', 'org_users', 'users']) {
        console.log(`  DELETE FROM ${t} WHERE org_id = (SELECT id FROM organizations WHERE name = '${FIXTURE_ORG}');`);
      }
      console.log(`  DELETE FROM organizations WHERE name = '${FIXTURE_ORG}';`);
      console.log('  COMMIT;\n');
    }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(x => `  - ${x}`).join('\n')}`);
    process.exit(1);
  }
  console.log('2026_142 verified.\n');
})();
