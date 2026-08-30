#!/usr/bin/env node
// preflight_daily_work.js
//
//   cd C:\Projects\dw-verify
//   node preflight_daily_work.js
//
// Read-only. Answers one question: is this organization safe to switch the
// daily work module on for?
//
// It writes nothing and changes nothing, so it is safe to run repeatedly and
// safe to run after the module is live.
//
// The three things it checks are the three that produce a WRONG NUMBER rather
// than an error if they are missing. A missing schedule row does not break the
// screen — it produces a rate computed against a default denominator the person
// never agreed to, and nobody notices until someone disputes their figure.
//
// Set the org id below, or pass it: node preflight_daily_work.js 42

const ORG_ID = Number(process.argv[2]) || null;

try { require('dotenv').config(); } catch {}

let Pool;
try { ({ Pool } = require('pg')); }
catch { console.error('\nRun `npm install pg dotenv` here first.\n'); process.exit(2); }

const CONN = process.env.DATABASE_URL;
if (!CONN) { console.error('\nNo DATABASE_URL set.\n'); process.exit(2); }
if (!ORG_ID) {
  console.error('\nPass the org id:  node preflight_daily_work.js 42\n');
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4, connectionTimeoutMillis: 10000,
});

let blocking = 0, warnings = 0;
const stop = m => { blocking++; console.log(`  BLOCKING  ${m}`); };
const warn = m => { warnings++; console.log(`  warning   ${m}`); };
const ok   = m =>              console.log(`  ok        ${m}`);

const q = (sql, params) => pool.query(sql, params);

(async () => {
  console.log(`\npreflight — organization ${ORG_ID}`);
  console.log(`target: ${CONN.replace(/:[^:@/]+@/, ':****@')}\n`);

  try {
    const { rows: [org] } = await q(
      `SELECT id, name,
              settings->'modules'->'dailywork' AS flag,
              settings->'calendar'->>'timezone' AS org_tz
         FROM organizations WHERE id = $1`, [ORG_ID]);

    if (!org) { console.log(`No organization ${ORG_ID}.\n`); process.exit(2); }
    console.log(`${org.name}\n`);

    /* ── who is granted ─────────────────────────────────────────────── */

    console.log('granted members');
    const { rows: granted } = await q(
      `SELECT u.id, u.email, u.timezone,
              ou.is_active,
              s.weekday_mask, s.effective_from::text AS effective_from,
              s.holiday_calendar_id,
              c.name AS calendar_name
         FROM user_module_access g
         JOIN users u      ON u.id = g.user_id
         JOIN org_users ou ON ou.user_id = u.id AND ou.org_id = g.org_id
         LEFT JOIN LATERAL (
                SELECT weekday_mask, effective_from, holiday_calendar_id
                  FROM daily_work_schedules d
                 WHERE d.org_id = g.org_id AND d.user_id = g.user_id
                 ORDER BY effective_from DESC LIMIT 1
              ) s ON TRUE
         LEFT JOIN holiday_calendars c ON c.id = s.holiday_calendar_id
        WHERE g.org_id = $1 AND g.module_key = 'dailywork'
        ORDER BY u.email`, [ORG_ID]);

    if (!granted.length) {
      stop('nobody has been granted the dailywork module — run the seed first');
    }

    for (const m of granted) {
      const issues = [];
      // A person with no schedule row still gets a rate: the service falls back
      // to Mon-Fri with no holidays. That is a reasonable default and a bad
      // surprise, because it is not what anyone chose.
      if (!m.weekday_mask) issues.push('no schedule row');
      if (!m.timezone) issues.push('no timezone — their day boundary would fall back to the org or UTC');
      if (!m.is_active) issues.push('inactive in org_users — would appear as a permanent absence');
      if (m.weekday_mask && !m.holiday_calendar_id) issues.push('schedule has no holiday calendar');

      if (issues.length) stop(`${m.email}: ${issues.join('; ')}`);
      else ok(`${m.email} — mask ${m.weekday_mask} from ${m.effective_from}, ${m.calendar_name}, ${m.timezone}`);
    }

    // Someone with a schedule but no grant will never see the feature, and
    // will silently sit in nobody's reports.
    const { rows: orphans } = await q(
      `SELECT u.email FROM daily_work_schedules s
         JOIN users u ON u.id = s.user_id
        WHERE s.org_id = $1
          AND NOT EXISTS (SELECT 1 FROM user_module_access g
                           WHERE g.org_id = s.org_id AND g.user_id = s.user_id
                             AND g.module_key = 'dailywork')`, [ORG_ID]);
    orphans.forEach(o => warn(`${o.email} has a schedule but no grant — they will not see the module`));

    /* ── the calendar ───────────────────────────────────────────────── */

    console.log('\nholiday calendar');
    const { rows: calendars } = await q(
      `SELECT c.id, c.name, c.is_default,
              count(d.id)::int AS dates,
              min(d.holiday_date)::text AS first_date,
              max(d.holiday_date)::text AS last_date
         FROM holiday_calendars c
         LEFT JOIN holiday_calendar_dates d ON d.calendar_id = c.id
        WHERE c.org_id = $1
        GROUP BY c.id, c.name, c.is_default
        ORDER BY c.is_default DESC, c.name`, [ORG_ID]);

    if (!calendars.length) stop('no holiday calendar exists for this organization');

    for (const c of calendars) {
      if (c.dates === 0) {
        warn(`"${c.name}" has no dates — every scheduled weekday will count as a working day`);
      } else {
        ok(`"${c.name}"${c.is_default ? ' (default)' : ''} — ${c.dates} dates, ${c.first_date} to ${c.last_date}`);
      }
    }

    // Holidays entirely in the past tell you the calendar was set up once and
    // never maintained; the pilot window would have none.
    const { rows: [future] } = await q(
      `SELECT count(*)::int AS n FROM holiday_calendar_dates
        WHERE org_id = $1 AND holiday_date >= CURRENT_DATE`, [ORG_ID]);
    if (calendars.some(c => c.dates > 0) && future.n === 0) {
      warn('every holiday on file is in the past — nothing will be excluded during the pilot');
    }

    /* ── the vocabulary and the anchors ─────────────────────────────── */

    console.log('\nseeded vocabulary');
    const { rows: [types] } = await q(
      `SELECT count(*) FILTER (WHERE status = 'active')::int    AS active,
              count(*) FILTER (WHERE status = 'candidate')::int AS candidate
         FROM daily_activity_types WHERE org_id = $1`, [ORG_ID]);
    if (!types.active) stop('no active activity types — members would have only the Other escape hatch');
    else ok(`${types.active} activity types active, ${types.candidate} awaiting a decision`);

    const { rows: [projects] } = await q(
      `SELECT count(*)::int AS n FROM sales_handovers
        WHERE org_id = $1 AND project_kind = 'internal'
          AND status NOT IN ('cancelled','completed')`, [ORG_ID]);
    if (!projects.n) warn('no internal projects — internal work can only be logged unattributed');
    else ok(`${projects.n} internal projects available to anchor to`);

    /* ── the flag ───────────────────────────────────────────────────── */

    console.log('\nmodule flag');
    if (!org.flag) {
      ok('dailywork is OFF — this is correct until everything above is clean');
    } else {
      const on = org.flag.allowed && org.flag.enabled;
      if (on) warn(`dailywork is already ON (${JSON.stringify(org.flag)})`);
      else ok(`dailywork present but not fully on: ${JSON.stringify(org.flag)}`);
    }

    /* ── verdict ────────────────────────────────────────────────────── */

    console.log('\n' + '─'.repeat(62));
    if (blocking) {
      console.log(`${blocking} blocking, ${warnings} warnings — do NOT switch the module on yet.\n`);
      process.exitCode = 1;
    } else {
      console.log(`0 blocking, ${warnings} warnings — safe to switch on.\n`);
      if (!org.flag) {
        console.log(`  UPDATE organizations`);
        console.log(`     SET settings = jsonb_set(coalesce(settings,'{}'::jsonb),`);
        console.log(`           '{modules,dailywork}', '{"allowed": true, "enabled": true}'::jsonb, true)`);
        console.log(`   WHERE id = ${ORG_ID};\n`);
      }
    }
  } catch (err) {
    console.error(`\npreflight failed: ${err.message}\n`);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
})();
