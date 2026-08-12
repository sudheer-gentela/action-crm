/**
 * phase1_acceptance.js
 *
 * Runs the Phase 1 acceptance list against a seeded fixture, by calling the
 * REAL service functions — not SQL stand-ins for them. The whole point of the
 * critical checks is that the guard lives in JavaScript: an assertion written
 * in SQL would pass while `bindGroup` still ran the unguarded back-fill.
 *
 * WHERE THIS FILE LIVES
 *   backend/scripts/phase1_acceptance.js
 *
 *   scripts/, not db/ and not a tests/ directory: it is executable Node that
 *   requires the service layer, which is what everything already in scripts/
 *   is. Its two SQL companions go in backend/db/ beside the migration they
 *   verify. It is NOT wired into any test runner — it needs a seeded database
 *   and would fail in CI without one.
 *
 * USAGE
 *   cd backend
 *   psql "$DATABASE_URL" -f db/phase1_schema_audit.sql    # expect zero rows
 *   psql "$DATABASE_URL" -f db/2026_108_conversation_bindings.sql
 *   psql "$DATABASE_URL" -f db/phase1_schema_audit.sql    # expect zero rows again
 *   psql "$DATABASE_URL" -f db/phase1_fixture.sql
 *   DATABASE_URL=... node scripts/phase1_acceptance.js
 *   psql "$DATABASE_URL" -f db/phase1_teardown.sql
 *
 * SAFE ON A DATABASE WITH REAL DATA IN IT: every id comes from the fixture map,
 * and the harness refuses to run if the fixture org is missing. It never
 * touches a row it did not create. Prefer a scratch database anyway.
 */

'use strict';

const path = require('path');
const { pool } = require(path.join(__dirname, '..', 'config', 'database'));
const session  = require(path.join(__dirname, '..', 'services', 'whatsappSession.service'));
const waService = require(path.join(__dirname, '..', 'services', 'whatsapp.service'));
const bindings = require(path.join(__dirname, '..', 'services', 'conversationBindings.service'));
const accountRels = require(path.join(__dirname, '..', 'services', 'accountRelationships.service'));

let pass = 0, fail = 0;
const results = [];

function check(name, condition, detail = '') {
  if (condition) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
}

async function countMessages(orgId, threadId, { attributed = null } = {}) {
  const where = attributed === true  ? 'AND handover_id IS NOT NULL'
              : attributed === false ? 'AND handover_id IS NULL'
              : '';
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM whatsapp_messages
      WHERE org_id = $1 AND thread_id = $2 ${where}`,
    [orgId, threadId]
  );
  return r.n;
}

async function threadProject(orgId, threadId) {
  const { rows: [r] } = await pool.query(
    `SELECT handover_id FROM whatsapp_threads WHERE id = $1 AND org_id = $2`,
    [threadId, orgId]
  );
  return r ? r.handover_id : undefined;
}

(async () => {
  const { rows: idRows } = await pool.query(`SELECT k, v FROM phase1_fixture_ids`);
  if (!idRows.length) {
    console.error('No fixture found. Run db/phase1_fixture.sql first.');
    process.exit(2);
  }
  const ID = Object.fromEntries(idRows.map(r => [r.k, r.v]));
  const org = ID.org, user = ID.user;

  // ── 1. No regression: a legacy project group binds and back-fills ────────
  {
    const before = await countMessages(org, ID.g_project_thread, { attributed: false });
    const r = await session.bindGroup(org, user, ID.g_project, {
      mode: 'project', handoverId: ID.p1,
    });
    check('1a project bind succeeds', r.ok, JSON.stringify(r));
    check('1b back-fills every unattributed message', r.backfilled === before,
          `backfilled=${r.backfilled} expected=${before}`);
    check('1c thread carries the project', (await threadProject(org, ID.g_project_thread)) === ID.p1);
    check('1d nothing left unattributed',
          (await countMessages(org, ID.g_project_thread, { attributed: false })) === 0);
    const { rows: [g] } = await pool.query(
      `SELECT binding_status, is_watched FROM whatsapp_session_groups WHERE id = $1`, [ID.g_project]);
    check("1e binding_status is 'bound'", g.binding_status === 'bound', g.binding_status);
    check('1f bind implies watching', g.is_watched === true);
  }

  // ── candidate derivation, before any bind uses it ────────────────────────
  {
    const derived = await accountRels.projectsForRelationship(org, ID.vendor_account);
    const ids = derived.map(d => d.handoverId).sort();
    check('D1 derives the two vendor-side active projects',
          JSON.stringify(ids) === JSON.stringify([ID.p1, ID.p2].sort()),
          `got ${JSON.stringify(ids)} expected ${JSON.stringify([ID.p1, ID.p2].sort())}`);
    check('D2 excludes the completed project', !ids.includes(ID.p4));
    check('D3 excludes the project where the account is on the customer side',
          !ids.includes(ID.p3));
    check('D4 no duplicate rows per project', ids.length === new Set(ids).size);
  }

  // ── 2. Vendor bind back-fills ZERO. Assert on ROW COUNT. ────────────────
  {
    const unattributedBefore = await countMessages(org, ID.g_vendor_thread, { attributed: false });
    const attributedBefore   = await countMessages(org, ID.g_vendor_thread, { attributed: true });

    const bad = await session.bindGroup(org, user, ID.g_vendor, {
      mode: 'account', accountId: ID.plain_account,
    });
    check('2a refuses an account with no active vendor/partner row',
          !bad.ok && bad.code === 'NOT_A_VENDOR', JSON.stringify(bad));

    const r = await session.bindGroup(org, user, ID.g_vendor, {
      mode: 'account', accountId: ID.vendor_account,
    });
    check('2b vendor bind succeeds', r.ok, JSON.stringify(r));
    check('2c reports zero back-filled', r.backfilled === 0, `backfilled=${r.backfilled}`);
    check('2d unattributed row count UNCHANGED',
          (await countMessages(org, ID.g_vendor_thread, { attributed: false })) === unattributedBefore,
          `expected ${unattributedBefore}`);
    check('2e attributed row count UNCHANGED',
          (await countMessages(org, ID.g_vendor_thread, { attributed: true })) === attributedBefore,
          `expected ${attributedBefore}`);
    check('2f thread carries NO project', (await threadProject(org, ID.g_vendor_thread)) === null);
    check('2g candidates derived from the relationship', r.candidates === 2, `got ${r.candidates}`);

    const cands = await bindings.candidatesFor(org, r.bindingId);
    check("2h candidates marked 'derived'", cands.every(c => c.source === 'derived'));
    const { rows: [g] } = await pool.query(
      `SELECT binding_status FROM whatsapp_session_groups WHERE id = $1`, [ID.g_vendor]);
    check("2i binding_status is 'bound_account'", g.binding_status === 'bound_account', g.binding_status);
  }

  // ── 3. Pool bind ────────────────────────────────────────────────────────
  {
    const before = await countMessages(org, ID.g_pool_thread, { attributed: false });
    const empty = await session.bindGroup(org, user, ID.g_pool, { mode: 'pool', candidateIds: [] });
    check('3a refuses a pool bind with no candidates',
          !empty.ok && empty.code === 'NO_CANDIDATES', JSON.stringify(empty));

    const r = await session.bindGroup(org, user, ID.g_pool, {
      mode: 'pool', candidateIds: [ID.p2, ID.p3],
    });
    check('3b pool bind succeeds', r.ok, JSON.stringify(r));
    check('3c back-fills nothing', r.backfilled === 0);
    check('3d unattributed row count UNCHANGED',
          (await countMessages(org, ID.g_pool_thread, { attributed: false })) === before);
    check('3e thread carries NO project', (await threadProject(org, ID.g_pool_thread)) === null);
    const cands = await bindings.candidatesFor(org, r.bindingId);
    check('3f both declared projects stored', cands.length === 2, `got ${cands.length}`);
    check("3g candidates marked 'declared'", cands.every(c => c.source === 'declared'));
    check('3h an INTERNAL project is a valid candidate',
          cands.some(c => c.handover_id === ID.p3));
  }

  // ── 4. Untracked group produces no message rows ─────────────────────────
  {
    const r = await session.ingestGroupMessage(ID.session, {
      jid: 'g_unwatched@g.us',
      messageId: 'acceptance_untracked_1',
      participantJid: '919999999001@s.whatsapp.net',
      timestamp: Math.floor(Date.now() / 1000),
      raw: { message: { conversation: 'should never be stored' } },
    });
    check('4a ingest refuses an unwatched group', !r.stored && r.reason === 'NOT_WATCHED',
          JSON.stringify(r));
    check('4b ZERO message rows exist for it',
          (await countMessages(org, ID.g_unwatched_thread)) === 0);
  }

  // ── 6. Conservative chain on an entity thread ───────────────────────────
  {
    const { rows: [thread] } = await pool.query(
      `SELECT * FROM whatsapp_threads WHERE id = $1`, [ID.g_vendor_thread]);

    const plain = await waService.resolveInboundHandover(org, thread, {
      timestamp: Math.floor(Date.now() / 1000),
    });
    check('6a a plain message in a vendor thread lands UNASSIGNED',
          plain.handoverId === null, JSON.stringify(plain));
    check('6b and carries no source', plain.source === null, String(plain.source));

    const reply = await waService.resolveInboundHandover(org, thread, {
      context: { id: 'g_vendor_msg_attributed' },
      timestamp: Math.floor(Date.now() / 1000),
    });
    check('6c a quoted reply STILL inherits the parent project',
          reply.handoverId === ID.p1 && reply.source === 'reply_context', JSON.stringify(reply));

    // Regression: the project group must still run the full chain.
    const { rows: [ptRow] } = await pool.query(
      `SELECT * FROM whatsapp_threads WHERE id = $1`, [ID.g_project_thread]);
    const legacy = await waService.resolveInboundHandover(org, ptRow, {
      timestamp: Math.floor(Date.now() / 1000),
    });
    check('6d a project thread still falls back to its own project',
          legacy.handoverId === ID.p1 && legacy.source === 'thread', JSON.stringify(legacy));
  }

  // ── 5. Downgrade guard: project → entity ────────────────────────────────
  {
    const attributedBefore = await pool.query(
      `SELECT id, handover_id FROM whatsapp_messages
        WHERE org_id = $1 AND thread_id = $2 AND handover_id IS NOT NULL ORDER BY id`,
      [org, ID.g_project_thread]);

    const refused = await session.bindGroup(org, user, ID.g_project, {
      mode: 'account', accountId: ID.vendor_account,
    });
    check('5a project → vendor WITHOUT force is refused',
          !refused.ok && refused.code === 'NEEDS_FORCE', JSON.stringify(refused));
    check('5b and the thread project is untouched',
          (await threadProject(org, ID.g_project_thread)) === ID.p1);

    const forced = await session.bindGroup(org, user, ID.g_project, {
      mode: 'account', accountId: ID.vendor_account, force: true,
    });
    check('5c with force it succeeds', forced.ok, JSON.stringify(forced));
    check('5d thread project cleared', (await threadProject(org, ID.g_project_thread)) === null);

    const after = await pool.query(
      `SELECT id, handover_id FROM whatsapp_messages
        WHERE org_id = $1 AND thread_id = $2 AND handover_id IS NOT NULL ORDER BY id`,
      [org, ID.g_project_thread]);
    check('5e already-attributed messages KEEP their handover_id',
          JSON.stringify(after.rows) === JSON.stringify(attributedBefore.rows.map(r => ({ ...r }))),
          `before=${attributedBefore.rows.length} after=${after.rows.length}`);
  }

  // ── 6b. Upgrade guard: entity → project (NOT in the original spec) ──────
  {
    const unassignedBefore = await countMessages(org, ID.g_vendor_thread, { attributed: false });

    const refused = await session.bindGroup(org, user, ID.g_vendor, {
      mode: 'project', handoverId: ID.p2,
    });
    check('7a vendor → project WITHOUT force is refused',
          !refused.ok && refused.code === 'NEEDS_FORCE', JSON.stringify(refused));

    const forced = await session.bindGroup(org, user, ID.g_vendor, {
      mode: 'project', handoverId: ID.p2, force: true,
    });
    check('7b with force it succeeds', forced.ok, JSON.stringify(forced));
    check('7c back-fill SUPPRESSED — this is the mass-misfile guard',
          forced.backfilled === 0 && forced.backfillSuppressed === true, JSON.stringify(forced));
    check('7d the unassigned messages are STILL unassigned',
          (await countMessages(org, ID.g_vendor_thread, { attributed: false })) === unassignedBefore,
          `expected ${unassignedBefore}`);
    check('7e no media requeued on that transition', forced.mediaRequeued === 0);
  }

  // ── 8. Adoption guards ──────────────────────────────────────────────────
  {
    // g_pool is still pool-bound with a null thread project.
    check('8a precondition: pool thread has no project',
          (await threadProject(org, ID.g_pool_thread)) === null);

    let linkErr = null;
    try {
      await waService.linkThreadToProject(ID.g_pool_thread, org, ID.p1, { force: true });
    } catch (e) { linkErr = e; }
    check('8b linkThreadToProject refuses an entity thread even with force',
          linkErr && linkErr.code === 'ENTITY_BOUND',
          linkErr ? `${linkErr.code}: ${linkErr.message}` : 'no error thrown');
    check('8c thread project still null after the refusal',
          (await threadProject(org, ID.g_pool_thread)) === null);

    const { rows: [m] } = await pool.query(
      `SELECT id FROM whatsapp_messages WHERE org_id = $1 AND thread_id = $2 LIMIT 1`,
      [org, ID.g_pool_thread]);
    const moved = await waService.moveMessage(m.id, org, user, {
      handoverId: ID.p2, scope: 'thread',
    });
    check('8d moveMessage still moves the MESSAGES', moved.moved > 0, JSON.stringify(moved));
    check('8e but does NOT write the thread project',
          moved.conversationMoved === false && moved.entityScoped === true, JSON.stringify(moved));
    check('8f thread project still null after the move',
          (await threadProject(org, ID.g_pool_thread)) === null);
  }

  // ── 9. The shape constraint ─────────────────────────────────────────────
  {
    let err = null;
    try {
      await pool.query(
        `INSERT INTO conversation_bindings
           (org_id, channel, thread_ref, binding_mode, handover_id, bound_account_id)
         VALUES ($1,'whatsapp','constraint_probe@g.us','account',$2,$3)`,
        [org, ID.p1, ID.vendor_account]);
    } catch (e) { err = e; }
    check('9a account mode carrying a handover_id is rejected',
          !!err && /conv_bindings_shape_chk/.test(err.message), err ? err.message : 'insert succeeded');

    err = null;
    try {
      await pool.query(
        `INSERT INTO conversation_bindings (org_id, channel, thread_ref, binding_mode)
         VALUES ($1,'whatsapp','constraint_probe2@g.us','project')`, [org]);
    } catch (e) { err = e; }
    check('9b project mode with no handover_id is rejected',
          !!err && /conv_bindings_shape_chk/.test(err.message), err ? err.message : 'insert succeeded');

    err = null;
    try {
      await pool.query(
        `INSERT INTO conversation_bindings (org_id, channel, thread_ref, binding_mode)
         VALUES ($1,'carrierpigeon','constraint_probe3@g.us','pool')`, [org]);
    } catch (e) { err = e; }
    check('9c an unknown channel is rejected',
          !!err && /conv_bindings_channel_chk/.test(err.message), err ? err.message : 'insert succeeded');
  }

  // ── 10. unbind reverts to legacy without inventing history ──────────────
  {
    const r = await session.unbindGroup(org, user, ID.g_pool);
    check('10a unbind removes the row', r.ok && r.removed === 1, JSON.stringify(r));
    check('10b does NOT restore a project link',
          (await threadProject(org, ID.g_pool_thread)) === null);
    check('10c does not retract what was filed',
          (await countMessages(org, ID.g_pool_thread, { attributed: true })) > 0);
    const { rows: [g] } = await pool.query(
      `SELECT binding_status, is_watched FROM whatsapp_session_groups WHERE id = $1`, [ID.g_pool]);
    check("10d status back to 'unbound'", g.binding_status === 'unbound', g.binding_status);
    check('10e capture is NOT switched off', g.is_watched === true);
    check('10f thread is legacy again — full chain resumes',
          (await bindings.isEntityBound(org, 'whatsapp', 'g_pool@g.us')) === false);
  }

  // ── 11. listTriage renders entity binds correctly ───────────────────────
  {
    const t = await session.listTriage(org, {});
    const vendor = t.groups.find(g => g.id === ID.g_vendor);
    check('11a triage row carries binding_mode', !!vendor && !!vendor.binding_mode,
          JSON.stringify(vendor && { m: vendor.binding_mode }));
    const { rows: [pg] } = await pool.query(
      `SELECT binding_status FROM whatsapp_session_groups WHERE id = $1`, [ID.g_project]);
    check('11b counts include the entity shapes',
          typeof t.counts.boundAccount === 'number' && typeof t.counts.boundPool === 'number',
          JSON.stringify(t.counts));
    check('11c project group downgraded earlier now reads bound_account',
          pg.binding_status === 'bound_account', pg.binding_status);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2 — candidate sync
  // ═══════════════════════════════════════════════════════════════════════
  const sync = require(path.join(__dirname, '..', 'services', 'conversationCandidateSync.service'));

  // Rebind the vendor group to account mode: check 7 left it as a project.
  let vendorBindingId;
  {
    const r = await session.bindGroup(org, user, ID.g_vendor, {
      mode: 'account', accountId: ID.vendor_account, force: true,
    });
    vendorBindingId = r.bindingId;
    check('S0 vendor group re-bound to account mode for Phase 2', r.ok && r.candidates === 2,
          JSON.stringify(r));
  }

  // ── S1. A vendor added to a NEW project becomes a candidate ─────────────
  {
    const r = await sync.resyncForAccount(org, ID.vendor_account, { reason: 'test-noop' });
    check('S1a resync with nothing changed is a no-op',
          r.changed === 0 && r.details.every(d => d.noop), JSON.stringify(r.details));

    // Put the vendor on P3 (internal, previously customer-side only).
    await pool.query(
      `INSERT INTO project_contacts (org_id, context_type, context_id, contact_id, side, role)
       VALUES ($1,'handover',$2,$3,'vendor','engagement_lead')`,
      [org, ID.p3, ID.vendor_contact]);

    const r2 = await sync.resyncForAccount(org, ID.vendor_account, { reason: 'test-add' });
    // NOTE: two bindings point at this account by now — check 5c downgraded the
    // project group onto the same vendor. Asserting on details[0] would be
    // asserting on row order; find the binding under test instead. That both
    // bindings updated is itself the multi-binding case working.
    const d1 = r2.details.find(d => d.bindingId === vendorBindingId);
    check('S1b the new project is added to the binding under test',
          !!d1 && d1.added.includes(ID.p3), JSON.stringify(r2.details));
    check('S1b2 and to every other binding on the same account',
          r2.details.every(d => d.added.includes(ID.p3)), JSON.stringify(r2.details));
    const cands = await bindings.candidatesFor(org, vendorBindingId);
    check('S1c candidate set now has three projects', cands.length === 3, `got ${cands.length}`);
    check('S1d and they are all still derived', cands.every(c => c.source === 'derived'));
  }

  // ── S2. Removing the vendor drops the project ──────────────────────────
  {
    await pool.query(
      `DELETE FROM project_contacts
        WHERE org_id=$1 AND context_type='handover' AND context_id=$2
          AND contact_id=$3 AND side='vendor'`,
      [org, ID.p3, ID.vendor_contact]);

    const r = await sync.resyncForAccount(org, ID.vendor_account, { reason: 'test-remove' });
    const d = r.details.find(x => x.bindingId === vendorBindingId);
    check('S2a the project is removed', !!d && d.removed.includes(ID.p3),
          JSON.stringify(r.details));
    check('S2b back to two candidates',
          (await bindings.candidatesFor(org, vendorBindingId)).length === 2);
  }

  // ── S3. A project completing drops it — the hook-invisible case ────────
  {
    await pool.query(`UPDATE sales_handovers SET status='completed' WHERE id=$1 AND org_id=$2`,
                     [ID.p2, org]);
    const r = await sync.resyncForAccount(org, ID.vendor_account, { reason: 'test-complete' });
    const d3 = r.details.find(x => x.bindingId === vendorBindingId);
    check('S3a a completed project leaves the shortlist',
          !!d3 && d3.removed.includes(ID.p2), JSON.stringify(r.details));
    await pool.query(`UPDATE sales_handovers SET status='in_progress' WHERE id=$1 AND org_id=$2`,
                     [ID.p2, org]);
    await sync.resyncForAccount(org, ID.vendor_account, { reason: 'test-restore' });
    check('S3b reopening restores it',
          (await bindings.candidatesFor(org, vendorBindingId)).length === 2);
  }

  // ── S4. DECLARED sets are never touched — the critical scoping ─────────
  {
    const pb = await session.bindGroup(org, user, ID.g_pool, {
      mode: 'pool', candidateIds: [ID.p1, ID.p2],
    });
    check('S4a pool re-bound with declared candidates', pb.ok && pb.candidates === 2);

    // Make the vendor's derived set change; the pool's declared set must not.
    await pool.query(
      `INSERT INTO project_contacts (org_id, context_type, context_id, contact_id, side, role)
       VALUES ($1,'handover',$2,$3,'vendor','engagement_lead')`,
      [org, ID.p3, ID.vendor_contact]);
    await sync.reconcileAll();

    const poolCands = await bindings.candidatesFor(org, pb.bindingId);
    check('S4b the declared pool set is untouched by a full reconcile',
          poolCands.length === 2 && poolCands.every(c => c.source === 'declared'),
          JSON.stringify(poolCands.map(c => [c.handover_id, c.source])));
    check('S4c while the derived set DID change',
          (await bindings.candidatesFor(org, vendorBindingId)).length === 3);
  }

  // ── S5. Ending the relationship empties the shortlist ──────────────────
  {
    const { rows: [rel] } = await pool.query(
      `SELECT id FROM account_relationships
        WHERE org_id=$1 AND account_id=$2 AND status='active' LIMIT 1`,
      [org, ID.vendor_account]);
    await pool.query(`UPDATE account_relationships SET status='ended', ended_at=now() WHERE id=$1`,
                     [rel.id]);

    const r = await sync.resyncForAccount(org, ID.vendor_account, { reason: 'test-ended' });
    check('S5a an ended relationship reports inactive', r.relationshipActive === false);
    check('S5b the derived shortlist is emptied, not left stale',
          (await bindings.candidatesFor(org, vendorBindingId)).length === 0);
    check('S5c the binding itself survives',
          !!(await bindings.forThread(org, 'whatsapp', 'g_vendor@g.us')));

    const empty = await sync.listEmptyCandidateBindings(org);
    check('S5d it surfaces as a binding with no live projects',
          empty.some(e => e.binding_id === vendorBindingId), JSON.stringify(empty.map(e=>e.binding_id)));
  }

  // ── S6. reconcileAll is idempotent ─────────────────────────────────────
  {
    const a = await sync.reconcileAll();
    const b = await sync.reconcileAll();
    check('S6a a second immediate reconcile changes nothing',
          b.changed === 0 && b.added === 0 && b.removed === 0, JSON.stringify(b));
    check('S6b and reports no errors', a.errors === 0 && b.errors === 0);
  }

  console.log('\nPhase 1 + 2 acceptance\n' + '='.repeat(60));
  console.log(results.join('\n'));
  console.log('='.repeat(60));
  console.log(`${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nHARNESS ERROR:', e);
  try { await pool.end(); } catch {}
  process.exit(2);
});
