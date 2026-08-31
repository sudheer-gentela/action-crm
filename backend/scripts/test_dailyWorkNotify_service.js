#!/usr/bin/env node
// test_dailyWorkNotify_service.js
//
//   cd C:\Projects\dw-verify
//   node test_dailyWorkNotify_service.js
//
// Phase 6 runs unattended, hourly, against everyone. Every assertion here is
// about a case where the WRONG behaviour is silent: a nudge on someone's day
// off, a second nudge after a redeploy, a nudge to a departed colleague. None
// of those throws. They just annoy people until the notification is ignored,
// and by then the habit is gone.
//
// The clock is injected (`now`), so each guard is tested at the exact instant
// it matters rather than by waiting for one.

const path = require('path');
const fs = require('fs');

try { require('dotenv').config(); } catch {}

let Pool;
try { ({ Pool } = require('pg')); }
catch { console.error('\nRun `npm install pg dotenv` here first.\n'); process.exit(2); }

const CONN = process.env.DATABASE_URL;
if (!CONN) { console.error('\nNo DATABASE_URL.\n'); process.exit(2); }

const REPO_CANDIDATES = [
  process.env.DW_REPO,
  path.join(__dirname, '..', 'action-crm-clean', 'backend'),
  'C:/Projects/action-crm-clean/backend',
  path.join(__dirname, '..', 'backend'),
].filter(Boolean);

const REPO = REPO_CANDIDATES.find(p => {
  try { return fs.existsSync(path.join(p, 'services', 'dailyWorkNotify.service.js')); }
  catch { return false; }
});
if (!REPO) {
  console.error('\nCould not find dailyWorkNotify.service.js. Looked in:\n');
  REPO_CANDIDATES.forEach(p => console.error('  ' + p));
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4, connectionTimeoutMillis: 10000,
});

async function withOrgTransaction(orgId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }
}

const dbPath = path.resolve(REPO, 'config', 'database.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { pool, db: pool, withOrgTransaction, query: (t, p) => pool.query(t, p) },
};

const svc = require(path.resolve(REPO, 'services', 'dailyWork.service.js'));
const notify = require(path.resolve(REPO, 'services', 'dailyWorkNotify.service.js'));
console.log(`\ntesting: ${path.resolve(REPO, 'services', 'dailyWorkNotify.service.js')}`);

let passed = 0, failed = 0;
const failures = [];
const pass = n => { passed++; console.log(`  PASS  ${n}`); };
const fail = (n, d) => { failed++; failures.push(n); console.log(`  FAIL  ${n}\n          ${d}`); };
const check = (n, c, d) => c ? pass(n) : fail(n, d || 'condition was false');
const eq = (n, a, e) => check(n, JSON.stringify(a) === JSON.stringify(e),
  `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const q = (sql, params) => pool.query(sql, params);
const FIXTURE_ORG = 'DWNOTIFY_VERIFY_FIXTURE';

// Thu 27 Aug 2026. 11:30 UTC is 17:00 in Kolkata — the reminder hour.
const AT_1700_IST = new Date('2026-08-27T11:30:00Z');
const AT_1200_IST = new Date('2026-08-27T06:30:00Z');
const AT_1800_IST = new Date('2026-08-27T12:30:00Z');
const SAT_1700_IST = new Date('2026-08-29T11:30:00Z');
const TODAY = '2026-08-27';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  for (const t of ['notifications', 'play_notes', 'play_evidence',
                   'daily_work_entries', 'daily_work_items',
                   'daily_work_schedules', 'daily_work_exceptions',
                   'daily_activity_types', 'holiday_calendar_dates', 'holiday_calendars',
                   'org_hierarchy', 'user_module_access', 'team_memberships', 'teams',
                   'team_dimensions', 'org_users', 'users']) {
    await q(`DELETE FROM ${t} WHERE org_id = ${org}`, [FIXTURE_ORG]).catch(() => {});
  }
  await q(`DELETE FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
}

async function setup() {
  await teardown();

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug, settings)
     VALUES ($1,'dwnotify-verify-fixture',
             '{"calendar":{"timezone":"Asia/Kolkata"},"modules":{"dailywork":{"allowed":true,"enabled":true}}}'::jsonb)
     RETURNING id`, [FIXTURE_ORG]);

  const mkUser = async (first, tz) => {
    const { rows: [u] } = await q(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id, timezone)
       VALUES ($1,'x',$2,'Fixture',$3,$4) RETURNING id`,
      [`dwn.${first}.${Date.now()}@fixture.invalid`, first, org.id, tz]);
    await q(`INSERT INTO org_users (org_id, user_id, role, is_active) VALUES ($1,$2,'member',TRUE)`,
      [org.id, u.id]);
    await q(`INSERT INTO user_module_access (org_id, user_id, module_key) VALUES ($1,$2,'dailywork')`,
      [org.id, u.id]);
    return u.id;
  };

  const manager  = await mkUser('Manager', 'Asia/Kolkata');
  const logger   = await mkUser('Logger', 'Asia/Kolkata');    // logs today
  const slacker  = await mkUser('Slacker', 'Asia/Kolkata');   // does not
  const onLeave  = await mkUser('Onleave', 'Asia/Kolkata');   // approved leave
  const departed = await mkUser('Departed', 'Asia/Kolkata');  // inactive seat
  const london   = await mkUser('London', 'Europe/London');   // another zone
  const noSched  = await mkUser('Noschedule', 'Asia/Kolkata');

  await q(`UPDATE org_users SET is_active = FALSE WHERE org_id = $1 AND user_id = $2`,
    [org.id, departed]);

  for (const uid of [logger, slacker, onLeave, departed, london, noSched]) {
    await q(`INSERT INTO org_hierarchy (org_id, user_id, reports_to, relationship_type)
             VALUES ($1,$2,$3,'solid')`, [org.id, uid, manager]);
  }

  const { rows: [cal] } = await q(
    `INSERT INTO holiday_calendars (org_id, name, is_default)
     VALUES ($1,'Fixture',TRUE) RETURNING id`, [org.id]);

  // Everyone Mon-Fri except noSched, who deliberately has none.
  for (const uid of [manager, logger, slacker, onLeave, departed, london]) {
    await q(`INSERT INTO daily_work_schedules
               (org_id, user_id, weekday_mask, holiday_calendar_id, effective_from)
             VALUES ($1,$2,31,$3,'2026-01-01')`, [org.id, uid, cal.id]);
  }

  await q(`INSERT INTO daily_work_exceptions
             (org_id, user_id, exception_date, reason, approved_by, approved_at)
           VALUES ($1,$2,$3,'Fixture leave',$4,now())`, [org.id, onLeave, TODAY, manager]);

  // Logger has logged today.
  const item = await svc.createItem(org.id, logger, { kind: 'recurring', title: 'logged work' });
  await svc.saveDay(org.id, logger,
    [{ itemId: item.id, description: 'did the thing', dayStage: 'in_progress' }],
    { asOf: AT_1200_IST });

  return { orgId: org.id, manager, logger, slacker, onLeave, departed, london, noSched, calId: cal.id };
}

const sentTo = async (orgId, userId, type) => {
  const { rows } = await q(
    `SELECT id, title, body, metadata FROM notifications
      WHERE org_id = $1 AND user_id = $2 AND type = $3`, [orgId, userId, type]);
  return rows;
};

async function run(f) {
  console.log('\nREMINDER — the hour gate');

  const early = await notify.runReminders({ now: AT_1200_IST });
  eq('nothing fires at the wrong local hour', early.sent, 0);
  check('and everyone was skipped for that reason',
    early.skipped.wrong_hour >= 1, JSON.stringify(early.skipped));

  console.log('\nREMINDER — who gets one');

  const run1 = await notify.runReminders({ now: AT_1700_IST });
  check('the person who has not logged is reminded',
    (await sentTo(f.orgId, f.slacker, 'dailywork_reminder')).length === 1,
    // Print WHY. The first run of this suite failed here and the reason —
    // every person skipped as wrong_hour, because an absent org setting
    // coerced to midnight — was invisible without it.
    `no reminder for the slacker. skips: ${JSON.stringify(run1.skipped)}, sent ${run1.sent}`);

  eq('the person who already logged is not',
    (await sentTo(f.orgId, f.logger, 'dailywork_reminder')).length, 0);
  eq('the person on approved leave is not',
    (await sentTo(f.orgId, f.onLeave, 'dailywork_reminder')).length, 0);

  // The guard whose absence produced 34 unread digests for a departed member.
  eq('an inactive seat is never reminded',
    (await sentTo(f.orgId, f.departed, 'dailywork_reminder')).length, 0);

  // Not nudged rather than nudged against a default nobody chose.
  eq('someone with no working week set is not reminded',
    (await sentTo(f.orgId, f.noSched, 'dailywork_reminder')).length, 0);

  // 17:00 IST is 12:30 in London — not their hour.
  eq('someone in another timezone waits for their own hour',
    (await sentTo(f.orgId, f.london, 'dailywork_reminder')).length, 0);

  const rem = (await sentTo(f.orgId, f.slacker, 'dailywork_reminder'))[0];
  if (!rem) {
    fail('the reminder records the local date it was for', 'no reminder to inspect');
    fail('and says nothing about previous days', 'no reminder to inspect');
  } else {
    eq('the reminder records the local date it was for', rem.metadata.entry_date, TODAY);
    check('and says nothing about previous days — there is no backlog to clear',
      !/yesterday|behind|missed|overdue/i.test(rem.body), rem.body);
  }

  console.log('\nREMINDER — the default hour');

  // The bug this suite caught on its first run: with no dailywork settings on
  // the org, Number(null) === 0 passed the range check and the reminder hour
  // resolved to midnight. Every org today is in exactly that state.
  eq('an absent setting falls back to the default, not midnight',
    notify.hourOr(null, notify.DEFAULT_REMINDER_HOUR), notify.DEFAULT_REMINDER_HOUR);
  eq('an empty string does too',
    notify.hourOr('', notify.DEFAULT_REMINDER_HOUR), notify.DEFAULT_REMINDER_HOUR);
  eq('but a deliberate midnight is honoured', notify.hourOr('0', 17), 0);
  eq('an out-of-range hour falls back', notify.hourOr('24', 17), 17);
  eq('and so does something that is not a number', notify.hourOr('six', 17), 17);

  console.log('\nREMINDER — never twice');

  // A redeploy, a retry, or simply the same hour coming round again.
  const run2 = await notify.runReminders({ now: AT_1700_IST });
  eq('a second sweep in the same hour sends nothing', run2.sent, 0);
  eq('still exactly one reminder on file',
    (await sentTo(f.orgId, f.slacker, 'dailywork_reminder')).length, 1);
  check('and it says why it skipped', run2.skipped.already_reminded >= 1,
    JSON.stringify(run2.skipped));

  console.log('\nREMINDER — days nobody is expected to work');

  await q(`DELETE FROM notifications WHERE org_id = $1`, [f.orgId]);
  const sat = await notify.runReminders({ now: SAT_1700_IST });
  eq('nobody is reminded on a Saturday', sat.sent, 0);
  check('because it is not a scheduled day', sat.skipped.not_a_working_day >= 1,
    JSON.stringify(sat.skipped));

  await q(`INSERT INTO holiday_calendar_dates (org_id, calendar_id, holiday_date, label)
           VALUES ($1,$2,$3,'Fixture holiday')`, [f.orgId, f.calId, TODAY]);
  const hol = await notify.runReminders({ now: AT_1700_IST });
  eq('nobody is reminded on a holiday', hol.sent, 0);
  check('and the reason is the holiday', hol.skipped.holiday >= 1, JSON.stringify(hol.skipped));
  await q(`DELETE FROM holiday_calendar_dates WHERE org_id = $1`, [f.orgId]);

  console.log('\nROLLUP — the manager');

  await q(`DELETE FROM notifications WHERE org_id = $1`, [f.orgId]);
  const roll = await notify.runRollups({ now: AT_1800_IST });
  check('the manager gets a rollup', roll.sent >= 1, JSON.stringify(roll));

  const got = await sentTo(f.orgId, f.manager, 'dailywork_rollup');
  eq('exactly one', got.length, 1);
  if (!got.length) {
    fail('rollup content', `no rollup to inspect. skips: ${JSON.stringify(roll.skipped)}`);
    return;
  }
  check('it names who logged', /Logger/.test(got[0].body), got[0].body);
  check('and who has not', /Slacker/.test(got[0].body), got[0].body);
  check('an inactive colleague is not listed at all', !/Departed/.test(got[0].body), got[0].body);
  check('it says a missing day is an absence, not a backlog',
    /absence/i.test(got[0].body), got[0].body);
  eq('the logged and missing ids are recorded',
    got[0].metadata.logged_ids.includes(f.logger), true);

  // The reason the rollup has to apply the reminder's guards. Someone on
  // approved leave appearing in what a manager reads as a chase list is enough
  // for the whole thing to stop being trusted.
  check('someone on approved leave is not in the chase list',
    !got[0].metadata.missing_ids.includes(f.onLeave),
    `Onleave is listed as not-yet: ${got[0].body}`);
  check('they are shown as not expected today instead',
    got[0].metadata.off_today_ids.includes(f.onLeave), got[0].body);
  check('and the wording says so', /Not expected today/.test(got[0].body), got[0].body);

  check('someone with no working week is flagged as unconfigured, not chased',
    got[0].metadata.unconfigured_ids.includes(f.noSched) &&
    !got[0].metadata.missing_ids.includes(f.noSched), got[0].body);
  check('and the manager is told they are not being reminded',
    /not being reminded/.test(got[0].body), got[0].body);

  // "2 of 5" when three were on holiday is a false accusation dressed as a
  // statistic.
  check('the headline counts only those expected to log',
    /of 3 logged today/.test(got[0].title), got[0].title);

  eq('someone with no reports gets no rollup',
    (await sentTo(f.orgId, f.slacker, 'dailywork_rollup')).length, 0);

  const roll2 = await notify.runRollups({ now: AT_1800_IST });
  eq('the rollup is not sent twice either', roll2.sent, 0);

  console.log('\nROLLUP — a good day still gets one');

  await q(`DELETE FROM notifications WHERE org_id = $1`, [f.orgId]);
  // Everyone EXPECTED to log must log — which is Logger, Slacker and London.
  // Onleave is on leave and Noschedule has no working week, so neither is
  // expected, and that is the point of the assertion below.
  const item2 = await svc.createItem(f.orgId, f.slacker, { kind: 'recurring', title: 'late work' });
  await svc.saveDay(f.orgId, f.slacker,
    [{ itemId: item2.id, description: 'got to it eventually', dayStage: 'in_progress' }],
    { asOf: AT_1700_IST });

  const item3 = await svc.createItem(f.orgId, f.london, { kind: 'recurring', title: 'london work' });
  await svc.saveDay(f.orgId, f.london,
    [{ itemId: item3.id, description: 'logged from London', dayStage: 'in_progress' }],
    { asOf: AT_1200_IST });

  await notify.runRollups({ now: AT_1800_IST });
  const good = (await sentTo(f.orgId, f.manager, 'dailywork_rollup'))[0];
  check('a rollup still arrives when everyone logged', !!good, 'no rollup on a good day');
  // A rollup that only arrives when something is wrong reads as an accusation.
  check('and it says so plainly', /Everyone logged/i.test(good.body), good.body);
  check('nobody is in the chase list', good.metadata.missing_ids.length === 0,
    JSON.stringify(good.metadata.missing_ids));
  check('while those not expected are still named, so the day is legible',
    /Not expected today/.test(good.body), good.body);
}

(async () => {
  console.log(`target:      ${CONN.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`fixture org: ${FIXTURE_ORG}`);
  try {
    const f = await setup();
    await run(f);
  } catch (err) {
    fail('harness aborted', err.stack || err.message);
  } finally {
    try { await teardown(); console.log('\nfixture torn down'); }
    catch (err) { console.log(`\nWARNING: teardown failed — ${err.message}`); }
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(x => `  - ${x}`).join('\n')}`);
    process.exit(1);
  }
  console.log('dailyWorkNotify.service verified.\n');
})();
