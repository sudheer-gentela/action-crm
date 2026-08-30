#!/usr/bin/env node
// seed_daily_work.js
//
//   cd C:\Projects\dw-verify
//   node seed_daily_work.js --dry-run          show what it would do, change nothing
//   node seed_daily_work.js                    apply
//
// Seeds everything the pilot organization needs BEFORE the module is switched
// on. Ordering matters and is the reason this is a script rather than a
// migration: a person who logs an entry before their daily_work_schedules row
// exists has a denominator with no basis, and the first rate they ever see is
// wrong. For a compliance feature that is the worst possible first impression.
//
// Idempotent. Run it again after adding the remaining users and it will seed
// only what is missing. Nothing here deletes anything.
//
// It does NOT switch the module on. That is a deliberate separate step, printed
// at the end once everything it depends on exists.
//
// ── Edit the CONFIG block below before running ───────────────────────

const CONFIG = {
  // Find it with: SELECT id, name FROM organizations ORDER BY id;
  orgId: 112,

  // Who the grants and seeded rows are recorded as coming from. A real user id
  // in the same org — normally the manager running the pilot.
  actorUserId: 18,

  // Everyone in the pilot, by email. Missing users are reported, not created:
  // creating a user account as a side effect of a seed script is how you end up
  // with duplicates that have no password and cannot log in.
  memberEmails: [
'chandini.koppara@aquarient.com',
'sharath.ankala@aquarient.com',
'pranay.vatnala@aquarient.com',
'pavan.kanugo@aquarient.com',
'deepika.tigulla@aquarient.com',
'saideep.seelam@aquarient.com',
'srujana.dogga@aquarient.com',
'manikanta.kamboji@aquarient.com'
    // 'chandini@example.com',
  ],

  // From the observed sheet. Confirm before running — do not invent these.
  activityTypes: [
    { key: 'emails',       label: 'Emails' },
    { key: 'li_connects',  label: 'LinkedIn connection requests' },
    { key: 'li_posts',     label: 'LinkedIn posts' },
    { key: 'marketing_research',     label: 'Marketing Research' },
    { key: 'tech_research',     label: 'Technology Research' },
    { key: 'list_updates', label: 'List updates' },
    { key: 'reports',      label: 'Reports' },
    { key: 'learning',     label: 'Learning / certification' },
    { key: 'tracker_update',     label: 'Tracker Sheet Update' },
  ],

  // Internal initiatives, created as sales_handovers with project_kind
  // 'internal'. The schema guarantees these carry no account, which is what
  // makes "Internal Projects" an exact query rather than a guess.
  internalProjects: [
    'PowerBI',
    'Claude',
    'Skill Development',
    'MCAE',
    'Salesforce Campaigns',
    'Data Campaigns',
    'AI Learning',
  ],

  holidayCalendar: {
    name: 'India',
    isDefault: true,
    // Only the remaining dates matter for the pilot window. An empty list is
    // valid: the denominator is then every scheduled weekday, which is
    // slightly pessimistic rather than broken.
    dates: [
      { date: '2026-10-02', label: 'Gandhi Jayanti' },
      { date: '2026-09-14', label: 'Vinayaka Chavithi' },
      { date: '2026-12-25', label: 'Christman' },
    ],
  },

  // Bit 0 = Monday, so Mon-Fri = 31. Six days would be 63.
  weekdayMask: 31,

  // The schedule applies from this date. Anything before it has no schedule and
  // so no denominator — set it to the pilot start, not to today, or the first
  // days of the pilot will not count.
  effectiveFrom: '2026-08-31',

  // Timezone written to users.timezone for anyone who has none. Must be
  // manager-set rather than sniffed from a browser: a compliance metric whose
  // day boundary moves when someone travels is not a metric.
  timezone: 'Asia/Kolkata',
};

/* ──────────────────────────────────────────────────────────────────── */

const DRY = process.argv.includes('--dry-run');

try { require('dotenv').config(); } catch {}

let Pool;
try { ({ Pool } = require('pg')); }
catch { console.error('\nRun `npm install pg dotenv` in this folder first.\n'); process.exit(2); }

const CONN = process.env.DATABASE_URL;
if (!CONN) { console.error('\nNo DATABASE_URL set.\n'); process.exit(2); }

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4, connectionTimeoutMillis: 10000,
});

const actions = [];
const skipped = [];
const problems = [];

const did = m => { actions.push(m); console.log(`  ${DRY ? 'would' : 'did  '}  ${m}`); };
const same = m => { skipped.push(m); console.log(`  ok     ${m}`); };
const bad  = m => { problems.push(m); console.log(`  ISSUE  ${m}`); };

const q = (sql, params) => pool.query(sql, params);

async function main() {
  console.log(`\nseed_daily_work — ${DRY ? 'DRY RUN, nothing will change' : 'APPLYING'}`);
  console.log(`target: ${CONN.replace(/:[^:@/]+@/, ':****@')}\n`);

  if (!CONFIG.orgId || !CONFIG.actorUserId) {
    console.error('Set orgId and actorUserId in the CONFIG block first.\n');
    console.error('  SELECT id, name FROM organizations ORDER BY id;');
    console.error('  SELECT u.id, u.email FROM users u WHERE u.org_id = <orgId>;\n');
    process.exit(2);
  }

  const { rows: [org] } = await q(`SELECT id, name FROM organizations WHERE id = $1`, [CONFIG.orgId]);
  if (!org) { console.error(`No organization with id ${CONFIG.orgId}.\n`); process.exit(2); }
  console.log(`organization: ${org.name} (${org.id})\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(CONFIG.orgId, 10)}'`);

    await seedActivityTypes(client);
    await seedInternalProjects(client);
    const calendarId = await seedHolidayCalendar(client);
    const members = await resolveMembers(client);
    await seedTimezones(client, members);
    await seedSchedules(client, members, calendarId);
    await grantModule(client, members);

    if (DRY) { await client.query('ROLLBACK'); }
    else     { await client.query('COMMIT'); }

    report(members);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`\nAborted, nothing was changed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

/* ── activity types ─────────────────────────────────────────────────── */

async function seedActivityTypes(client) {
  console.log('activity types');
  for (const t of CONFIG.activityTypes) {
    const { rows } = await client.query(
      `SELECT key, status FROM daily_activity_types WHERE org_id = $1 AND key = $2`,
      [CONFIG.orgId, t.key]);

    if (rows[0]) { same(`${t.key} already exists (${rows[0].status})`); continue; }

    await client.query(
      `INSERT INTO daily_activity_types (org_id, key, label, is_system, status, sort_order, created_by)
       VALUES ($1,$2,$3,TRUE,'active',$4,$5)`,
      [CONFIG.orgId, t.key, t.label, CONFIG.activityTypes.indexOf(t) * 10, CONFIG.actorUserId]);
    did(`create activity type ${t.key} — ${t.label}`);
  }
  console.log('');
}

/* ── internal projects ──────────────────────────────────────────────── */

async function seedInternalProjects(client) {
  console.log('internal projects');
  for (const name of CONFIG.internalProjects) {
    const { rows } = await client.query(
      `SELECT id FROM sales_handovers
        WHERE org_id = $1 AND name = $2 AND project_kind = 'internal'`,
      [CONFIG.orgId, name]);

    if (rows[0]) { same(`${name} already exists (id ${rows[0].id})`); continue; }

    // project_kind 'internal' requires account_id AND deal_id to both be null
    // — sales_handovers_kind_shape_chk. That constraint is what makes these
    // reliably account-free.
    await client.query(
      `INSERT INTO sales_handovers (org_id, name, project_kind, status, created_by)
       VALUES ($1,$2,'internal','in_progress',$3)`,
      [CONFIG.orgId, name, CONFIG.actorUserId]);
    did(`create internal project ${name}`);
  }
  console.log('');
}

/* ── holiday calendar ───────────────────────────────────────────────── */

async function seedHolidayCalendar(client) {
  console.log('holiday calendar');
  const { name, isDefault, dates } = CONFIG.holidayCalendar;

  let { rows } = await client.query(
    `SELECT id, is_default FROM holiday_calendars WHERE org_id = $1 AND name = $2`,
    [CONFIG.orgId, name]);

  let calendarId;
  if (rows[0]) {
    calendarId = rows[0].id;
    same(`calendar "${name}" already exists (id ${calendarId})`);
  } else {
    // uq_holiday_calendars_one_default allows at most one default per org, so
    // check before claiming it rather than letting the insert fail.
    const { rows: existingDefault } = await client.query(
      `SELECT id, name FROM holiday_calendars WHERE org_id = $1 AND is_default`, [CONFIG.orgId]);

    const claimDefault = isDefault && !existingDefault[0];
    if (isDefault && existingDefault[0]) {
      bad(`"${existingDefault[0].name}" is already the default calendar — creating "${name}" as non-default`);
    }

    const { rows: created } = await client.query(
      `INSERT INTO holiday_calendars (org_id, name, is_default, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [CONFIG.orgId, name, claimDefault, CONFIG.actorUserId]);
    calendarId = created[0].id;
    did(`create calendar "${name}"${claimDefault ? ' as the org default' : ''}`);
  }

  if (!dates.length) {
    bad('no holiday dates configured — every scheduled weekday will count as a working day');
  }

  for (const h of dates) {
    const { rows: existing } = await client.query(
      `SELECT id FROM holiday_calendar_dates
        WHERE org_id = $1 AND calendar_id = $2 AND holiday_date = $3`,
      [CONFIG.orgId, calendarId, h.date]);

    if (existing[0]) { same(`${h.date} already in the calendar`); continue; }

    await client.query(
      `INSERT INTO holiday_calendar_dates (org_id, calendar_id, holiday_date, label)
       VALUES ($1,$2,$3,$4)`, [CONFIG.orgId, calendarId, h.date, h.label || null]);
    did(`add holiday ${h.date} — ${h.label || 'unnamed'}`);
  }
  console.log('');
  return calendarId;
}

/* ── members ────────────────────────────────────────────────────────── */

async function resolveMembers(client) {
  console.log('members');
  const found = [];

  for (const email of CONFIG.memberEmails) {
    const { rows } = await client.query(
      `SELECT u.id, u.email, u.timezone, ou.is_active
         FROM users u
         JOIN org_users ou ON ou.user_id = u.id AND ou.org_id = $1
        WHERE lower(u.email) = lower($2)`,
      [CONFIG.orgId, email]);

    if (!rows[0]) { bad(`${email} — no such user in this organization, skipped`); continue; }
    // is_active lives on org_users, not users. An inactive seat with a
    // schedule row would sit in every report as a permanent absence.
    if (!rows[0].is_active) { bad(`${email} — inactive in this org, skipped`); continue; }

    found.push(rows[0]);
    same(`${email} (id ${rows[0].id})`);
  }

  if (!CONFIG.memberEmails.length) bad('no memberEmails configured');
  console.log('');
  return found;
}

async function seedTimezones(client, members) {
  console.log('timezones');
  for (const m of members) {
    if (m.timezone) { same(`${m.email} already set to ${m.timezone}`); continue; }
    await client.query(`UPDATE users SET timezone = $1 WHERE id = $2`, [CONFIG.timezone, m.id]);
    did(`set ${m.email} to ${CONFIG.timezone}`);
  }
  console.log('');
}

/* ── schedules ──────────────────────────────────────────────────────── */

async function seedSchedules(client, members, calendarId) {
  console.log('work schedules');
  for (const m of members) {
    const { rows } = await client.query(
      `SELECT id, effective_from::text AS effective_from, weekday_mask
         FROM daily_work_schedules
        WHERE org_id = $1 AND user_id = $2
        ORDER BY effective_from DESC LIMIT 1`,
      [CONFIG.orgId, m.id]);

    if (rows[0]) {
      same(`${m.email} already has a schedule from ${rows[0].effective_from} (mask ${rows[0].weekday_mask})`);
      continue;
    }

    await client.query(
      `INSERT INTO daily_work_schedules
         (org_id, user_id, weekday_mask, holiday_calendar_id, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [CONFIG.orgId, m.id, CONFIG.weekdayMask, calendarId, CONFIG.effectiveFrom, CONFIG.actorUserId]);
    did(`schedule ${m.email} — mask ${CONFIG.weekdayMask} from ${CONFIG.effectiveFrom}`);
  }
  console.log('');
}

/* ── grants ─────────────────────────────────────────────────────────── */

async function grantModule(client, members) {
  console.log('module grants');
  for (const m of members) {
    const { rows } = await client.query(
      `SELECT 1 FROM user_module_access
        WHERE org_id = $1 AND user_id = $2 AND module_key = 'dailywork'`,
      [CONFIG.orgId, m.id]);

    if (rows[0]) { same(`${m.email} already granted`); continue; }

    // INSERT directly rather than through moduleAccess.setUserModules, which
    // DELETEs every grant for the user before re-inserting the list it is
    // given. Called with only 'dailywork' it would silently revoke prospecting,
    // contracts and everything else.
    await client.query(
      `INSERT INTO user_module_access (org_id, user_id, module_key, granted_by)
       VALUES ($1,$2,'dailywork',$3)
       ON CONFLICT (org_id, user_id, module_key) DO NOTHING`,
      [CONFIG.orgId, m.id, CONFIG.actorUserId]);
    did(`grant dailywork to ${m.email}`);
  }
  console.log('');
}

/* ── report ─────────────────────────────────────────────────────────── */

function report(members) {
  console.log('─'.repeat(60));
  console.log(`${actions.length} ${DRY ? 'would change' : 'changed'}, ${skipped.length} already correct`);

  if (problems.length) {
    console.log(`\n${problems.length} to look at:`);
    problems.forEach(p => console.log(`  - ${p}`));
  }

  if (DRY) {
    console.log('\nDry run — everything above was rolled back. Re-run without --dry-run to apply.\n');
    return;
  }

  console.log(`\n${members.length} people are seeded and granted.`);
  console.log('\nThe module is still OFF. Before switching it on, confirm:');
  console.log('  - every member above has a schedule row and a timezone');
  console.log('  - the holiday dates are right for the pilot window');
  console.log('  - GET /api/daily-work/day returns 404 for a granted user (the org flag is what lifts it)');
  console.log('\nThen:\n');
  console.log(`  UPDATE organizations`);
  console.log(`     SET settings = jsonb_set(coalesce(settings,'{}'::jsonb),`);
  console.log(`           '{modules,dailywork}', '{"allowed": true, "enabled": true}'::jsonb, true)`);
  console.log(`   WHERE id = ${CONFIG.orgId};`);
  console.log('\nrequireModule caches for 60 seconds, so wait a minute before testing.\n');
}

main();
