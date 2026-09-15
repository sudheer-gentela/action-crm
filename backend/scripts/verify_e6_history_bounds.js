/**
 * verify_e6_history_bounds.js
 *
 * E6 removed a lower bound on history. This proves the replacement still bounds
 * the person it should, which the group-capture harness does not cover: that
 * harness has no group where a roster is synced, someone is absent from it, and
 * the same person turns up afterwards — the one case where bounding is correct.
 *
 * Three members of one group, one per case:
 *
 *   ALWAYS   in the first roster synced          → reads everything
 *   QUIET    seen only speaking, never rostered  → reads everything
 *   LATE     absent from a roster, present later → reads from when we noticed
 *
 * Then late_joiner_history='all' is flipped and LATE is re-checked, because a
 * setting nobody verifies is a setting that quietly does nothing.
 *
 * Runs the REAL buildVisibilityClause, not a copy of its SQL.
 *
 *   BACKEND_PATH / WA_REPO as for test_whatsapp_group_capture.js
 *   DATABASE_URL=... node verify_e6_history_bounds.js
 *
 * Everything hangs off one org named WA_E6_PROBE, removed at the end.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const BACKEND_PATH = '';

const LOCAL_MODULES = path.join(__dirname, 'node_modules');
if (fs.existsSync(LOCAL_MODULES)) {
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${process.env.NODE_PATH}${path.delimiter}${LOCAL_MODULES}`
    : LOCAL_MODULES;
  require('module').Module._initPaths();
}

const ROOT = path.resolve(
  BACKEND_PATH || process.env.WA_REPO || process.env.DW_REPO || path.join(__dirname, '..')
);
if (!fs.existsSync(path.join(ROOT, 'config', 'database.js'))) {
  console.error(`\nCannot find the backend at:\n  ${ROOT}\n\nSet BACKEND_PATH near the top of this file.\n`);
  process.exit(2);
}

const { pool } = require(path.join(ROOT, 'config', 'database'));
const access   = require(path.join(ROOT, 'services', 'whatsappAccess.service'));

const ORG_NAME = 'WA_E6_PROBE';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

const q = (sql, params) => pool.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];

async function teardown() {
  const org = await one(`SELECT id FROM organizations WHERE name = $1`, [ORG_NAME]);
  if (!org) return false;
  await q(`DELETE FROM whatsapp_thread_participants WHERE org_id = $1`, [org.id]);
  await q(`DELETE FROM whatsapp_messages WHERE org_id = $1`, [org.id]);
  await q(`DELETE FROM whatsapp_threads WHERE org_id = $1`, [org.id]);
  await q(`DELETE FROM whatsapp_sessions WHERE org_id = $1`, [org.id]);
  await q(`DELETE FROM org_users WHERE org_id = $1`, [org.id]);
  await q(`DELETE FROM users WHERE org_id = $1`, [org.id]);
  await q(`DELETE FROM organizations WHERE id = $1`, [org.id]);
  return true;
}

/** How many of the group's messages this user may read, via the real clause. */
async function visibleCount(orgId, userId, threadId) {
  const { clause, params } = await access.buildVisibilityClause(orgId, userId,
    { scope: 'participant', startIndex: 2 });
  const { rows: [r] } = await q(
    `SELECT count(*)::int AS n FROM whatsapp_messages m
      WHERE m.thread_id = $1 AND (${clause})`,
    [threadId, ...params]
  );
  return r.n;
}

(async () => {
  if (process.argv.includes('--teardown')) {
    console.log((await teardown()) ? 'Probe fixture removed.' : 'No fixture to remove.');
    await pool.end();
    return;
  }
  if (await one(`SELECT id FROM organizations WHERE name = $1`, [ORG_NAME])) {
    console.error(`A ${ORG_NAME} org already exists. Run with --teardown first.`);
    await pool.end();
    process.exitCode = 2;
    return;
  }

  let code = 0;
  try {
    const org = await one(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [ORG_NAME, 'wa-e6-probe']);
    const orgId = org.id;

    const mkUser = async (n, phone) => {
      const u = await one(
        `INSERT INTO users (org_id, email, password_hash, first_name, last_name,
                            whatsapp_phone, whatsapp_phone_verified_at)
         VALUES ($1,$2,'x',$3,'Probe',$4, now()) RETURNING id`,
        [orgId, `e6-${n}@probe.invalid`, n, phone]);
      return u.id;
    };
    const uAlways = await mkUser('always', '990000000091');
    const uQuiet  = await mkUser('quiet',  '990000000092');
    const uLate   = await mkUser('late',   '990000000093');

    await q(`INSERT INTO whatsapp_sessions (org_id, label, status) VALUES ($1,'probe','logged_out')`,
      [orgId]);

    const thread = await one(
      `INSERT INTO whatsapp_threads (org_id, kind, wa_group_id, status)
       VALUES ($1,'group','120363900000000091@g.us','active') RETURNING id`, [orgId]);

    // Four messages, all before anybody is marked as arriving late.
    for (let i = 0; i < 4; i++) {
      await q(
        `INSERT INTO whatsapp_messages
           (org_id, thread_id, wa_message_id, direction, body, status, created_at)
         VALUES ($1,$2,$3,'inbound',$4,'received', now() - ($5 || ' minutes')::interval)`,
        [orgId, thread.id, `probe-${i}`, `message ${i}`, String(30 - i * 5)]);
    }

    // ALWAYS: in the first roster. QUIET: seen speaking, thread never rostered
    // at the time. Both unbounded, and joined_at is deliberately LATER than the
    // messages so a bound, if one applied, would be visible.
    const addParticipant = async (userId, phone, source, bounded) => q(
      `INSERT INTO whatsapp_thread_participants
         (thread_id, org_id, wa_phone, user_id, side, joined_at, joined_source, history_bounded)
       VALUES ($1,$2,$3,$4,'internal', now() - interval '2 minutes', $5, $6)`,
      [thread.id, orgId, phone, userId, source, bounded]);

    await addParticipant(uAlways, '990000000091', 'first_roster',  false);
    await addParticipant(uQuiet,  '990000000092', 'first_message', false);
    // LATE: the thread had been rostered without them, so their absence was
    // observed and joined_at is a real upper bound on when they arrived.
    await q(`UPDATE whatsapp_threads SET roster_synced_at = now() - interval '10 minutes' WHERE id = $1`,
      [thread.id]);
    await addParticipant(uLate, '990000000093', 'later_roster', true);

    console.log('\n── E6 history bounds ───────────────────────────────────────');
    check('a member present in the first roster reads the whole group',
      (await visibleCount(orgId, uAlways, thread.id)) === 4,
      `saw ${await visibleCount(orgId, uAlways, thread.id)} of 4`);
    check('a member seen only speaking, never rostered, reads the whole group',
      (await visibleCount(orgId, uQuiet, thread.id)) === 4,
      `saw ${await visibleCount(orgId, uQuiet, thread.id)} of 4`);
    check('a member we WATCHED ARRIVE is still bounded to what came after',
      (await visibleCount(orgId, uLate, thread.id)) === 0,
      `saw ${await visibleCount(orgId, uLate, thread.id)} of 4 — the bound is not applying`);

    await q(`UPDATE whatsapp_sessions SET late_joiner_history = 'all' WHERE org_id = $1`, [orgId]);
    check("late_joiner_history='all' lifts the bound for the late joiner",
      (await visibleCount(orgId, uLate, thread.id)) === 4,
      `saw ${await visibleCount(orgId, uLate, thread.id)} of 4`);
    check("…and the setting is scoped to its own org, not global",
      (await one(`SELECT count(*)::int n FROM whatsapp_sessions
                   WHERE late_joiner_history = 'all' AND org_id <> $1`, [orgId])).n === 0);

    await q(`UPDATE whatsapp_sessions SET late_joiner_history = 'from_join' WHERE org_id = $1`, [orgId]);

    // left_at is the half that was always honest, and must survive the change.
    // Messages sit at -30, -25, -20 and -15 minutes. Leaving at -22 falls in a
    // gap rather than on a message, so the expected answer is 2 by arithmetic
    // and not by which side of an equals sign the comparison lands on.
    await q(`UPDATE whatsapp_thread_participants SET left_at = now() - interval '22 minutes'
              WHERE thread_id = $1 AND user_id = $2`, [thread.id, uAlways]);
    check('the upper bound still applies after someone leaves',
      (await visibleCount(orgId, uAlways, thread.id)) === 2,
      `saw ${await visibleCount(orgId, uAlways, thread.id)} of 4, expected the 2 sent before they left`);

    console.log(`\n${pass} passed, ${fail} failed`);
    code = fail ? 1 : 0;
  } catch (err) {
    console.error('\nPROBE ERROR:', err.stack || err.message);
    code = 3;
  } finally {
    try { await teardown(); } catch (err) { console.error('teardown failed:', err.message); }
    await pool.end().catch(() => {});
  }
  process.exitCode = code;
})();
