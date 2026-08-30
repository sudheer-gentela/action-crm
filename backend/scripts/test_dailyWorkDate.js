#!/usr/bin/env node
// test_dailyWorkDate.js
//
//   node test_dailyWorkDate.js
//
// No database, no npm install, no dependencies. Every function under test is
// pure except resolveTimezone, which takes its query function as an argument
// and is exercised here with a fake.
//
// That is the point of the module's shape. Calendar logic that needs a live
// Postgres to test gets tested once against a happy path; calendar logic that
// runs in milliseconds gets tested against DST, month ends, leap years and the
// two zones furthest from UTC, which is where the bugs actually live.

// ── Finding the module ───────────────────────────────────────────────
//
// The module under test is production code and lives in the repo; this test
// runs from wherever the other harnesses live, so it looks in a few places
// rather than assuming. Override with DW_DATE_MODULE if your layout differs.
//
// It prints which file it loaded. A test that silently picks up a stale copy
// from the wrong folder is worse than one that cannot find the file at all.

const path = require('path');
const fs = require('fs');

const CANDIDATES = [
  process.env.DW_DATE_MODULE,
  path.join(__dirname, 'dailyWorkDate.js'),
  path.join(__dirname, '..', 'action-crm-clean', 'backend', 'services', 'dailyWorkDate.js'),
  'C:/Projects/action-crm-clean/backend/services/dailyWorkDate.js',
  path.join(__dirname, '..', 'backend', 'services', 'dailyWorkDate.js'),
].filter(Boolean);

const modulePath = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });

if (!modulePath) {
  console.error('\nCould not find dailyWorkDate.js. Looked in:\n');
  CANDIDATES.forEach(p => console.error('  ' + p));
  console.error('\nSet the path explicitly:');
  console.error('  set DW_DATE_MODULE=C:\\Projects\\action-crm-clean\\backend\\services\\dailyWorkDate.js');
  console.error('  node test_dailyWorkDate.js\n');
  process.exit(2);
}

const t = require(path.resolve(modulePath));
console.log(`\ntesting: ${path.resolve(modulePath)}`);

let passed = 0, failed = 0;
const failures = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else {
    failed++; failures.push(name);
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
  }
}

const at = iso => new Date(iso);

console.log('\nlocalDate — the day boundary');

// The bug this module exists to prevent. One instant, three different answers,
// and the naive implementation returns whichever the server happens to be.
eq('19:00 UTC is already tomorrow in Kolkata',
  t.localDate('Asia/Kolkata', at('2026-08-27T19:00:00Z')), '2026-08-28');
eq('the same instant is still yesterday in Los Angeles',
  t.localDate('America/Los_Angeles', at('2026-08-27T19:00:00Z')), '2026-08-27');
eq('and is the 27th in UTC itself',
  t.localDate('UTC', at('2026-08-27T19:00:00Z')), '2026-08-27');

eq('just before local midnight in Kolkata',
  t.localDate('Asia/Kolkata', at('2026-08-27T18:29:59Z')), '2026-08-27');
eq('one second later it is the next day',
  t.localDate('Asia/Kolkata', at('2026-08-27T18:30:00Z')), '2026-08-28');

console.log('\nlocalDate — extremes and DST');

eq('UTC+14 is a day ahead',
  t.localDate('Pacific/Kiritimati', at('2026-08-27T12:00:00Z')), '2026-08-28');
eq('UTC-11 is a day behind',
  t.localDate('Pacific/Niue', at('2026-08-27T05:00:00Z')), '2026-08-26');

// 08 Mar 2026 is the US spring-forward. An implementation that adds 24 hours
// to an instant lands on the wrong date here; formatting an instant does not.
eq('New York the instant before spring forward',
  t.localDate('America/New_York', at('2026-03-08T06:59:00Z')), '2026-03-08');
eq('New York after the clocks jump',
  t.localDate('America/New_York', at('2026-03-08T07:01:00Z')), '2026-03-08');
eq('Lord Howe half-hour DST offset',
  t.localDate('Australia/Lord_Howe', at('2026-08-27T13:45:00Z')), '2026-08-28');

console.log('\nlocalDate — fallbacks');

eq('an invalid zone falls back to UTC rather than throwing',
  t.localDate('Not/AZone', at('2026-08-27T19:00:00Z')), '2026-08-27');
eq('null falls back to UTC',
  t.localDate(null, at('2026-08-27T19:00:00Z')), '2026-08-27');
eq('a valid zone is reported valid', t.isValidZone('Asia/Kolkata'), true);
eq('a bogus zone is reported invalid', t.isValidZone('Mars/Olympus'), false);

console.log('\nlocalHour — what the reminder fires on');

eq('18:30 UTC is midnight in Kolkata',
  t.localHour('Asia/Kolkata', at('2026-08-27T18:30:00Z')), 0);
eq('midnight reads as 0, never 24',
  t.localHour('UTC', at('2026-08-27T00:15:00Z')), 0);
eq('12:30 UTC is 18:00 in Kolkata',
  t.localHour('Asia/Kolkata', at('2026-08-27T12:30:00Z')), 18);
eq('23:00 local reads as 23',
  t.localHour('UTC', at('2026-08-27T23:59:00Z')), 23);

console.log('\nweekdayIndex — bit 0 is Monday');

eq('Mon 24 Aug 2026 is 0', t.weekdayIndex('2026-08-24'), 0);
eq('Fri 28 Aug 2026 is 4', t.weekdayIndex('2026-08-28'), 4);
eq('Sat 29 Aug 2026 is 5', t.weekdayIndex('2026-08-29'), 5);
eq('Sun 30 Aug 2026 is 6', t.weekdayIndex('2026-08-30'), 6);

const MONFRI = 31;
eq('Mon-Fri mask includes Friday', t.isScheduledDay('2026-08-28', MONFRI), true);
eq('Mon-Fri mask excludes Saturday', t.isScheduledDay('2026-08-29', MONFRI), false);
eq('Mon-Fri mask excludes Sunday', t.isScheduledDay('2026-08-30', MONFRI), false);
eq('a Tue/Thu mask (0b0001010 = 10) excludes Monday',
  t.isScheduledDay('2026-08-24', 10), false);
eq('a Tue/Thu mask includes Thursday', t.isScheduledDay('2026-08-27', 10), true);

console.log('\neachDate — walking calendar dates');

eq('an inclusive range', t.eachDate('2026-08-27', '2026-08-29'),
  ['2026-08-27','2026-08-28','2026-08-29']);
eq('a single day', t.eachDate('2026-08-27', '2026-08-27'), ['2026-08-27']);
eq('an inverted range yields nothing', t.eachDate('2026-08-29', '2026-08-27'), []);
eq('crossing a month end', t.eachDate('2026-08-30', '2026-09-01'),
  ['2026-08-30','2026-08-31','2026-09-01']);
eq('crossing a year end', t.eachDate('2026-12-31', '2027-01-01'),
  ['2026-12-31','2027-01-01']);
// 2028 is the next leap year; 29 Feb must exist and must not be skipped.
eq('a leap day is not skipped', t.eachDate('2028-02-28', '2028-03-01'),
  ['2028-02-28','2028-02-29','2028-03-01']);
// The US spring-forward day is 23 hours long. Stepping instants naively
// produces a duplicate or a gap here.
eq('a 23-hour DST day still yields one date each',
  t.eachDate('2026-03-07', '2026-03-09'),
  ['2026-03-07','2026-03-08','2026-03-09']);

console.log('\nworkingDays — the denominator');

const week = ['2026-08-24', '2026-08-30'];   // Mon to Sun

eq('a plain Mon-Fri week is five days',
  t.workingDays(...week, { weekdayMask: MONFRI }).length, 5);

eq('a holiday removes a day',
  t.workingDays(...week, { weekdayMask: MONFRI, holidays: new Set(['2026-08-26']) }).length, 4);

eq('a personal exception removes a day',
  t.workingDays(...week, { weekdayMask: MONFRI, exceptions: new Set(['2026-08-25']) }).length, 4);

eq('a holiday and an exception on the same day only remove one',
  t.workingDays(...week, {
    weekdayMask: MONFRI,
    holidays: new Set(['2026-08-26']),
    exceptions: new Set(['2026-08-26']),
  }).length, 4);

eq('a holiday falling on a weekend removes nothing',
  t.workingDays(...week, { weekdayMask: MONFRI, holidays: new Set(['2026-08-29']) }).length, 5);

eq('a six-day week counts Saturday',
  t.workingDays(...week, { weekdayMask: 63 }).length, 6);

eq('no calendar configured still yields every weekday',
  t.workingDays(...week, { weekdayMask: MONFRI }),
  ['2026-08-24','2026-08-25','2026-08-26','2026-08-27','2026-08-28']);

console.log('\nloggingRate');

const working = t.workingDays(...week, { weekdayMask: MONFRI });

eq('four of five weekdays',
  t.loggingRate(['2026-08-24','2026-08-25','2026-08-26','2026-08-27'], working),
  { logged: 4, working: 5, rate: 0.8 });

eq('the same date logged twice counts once',
  t.loggingRate(['2026-08-24','2026-08-24'], working),
  { logged: 1, working: 5, rate: 0.2 });

// Saturday work is real and appears in the log. It is not evidence about a
// weekday that was missed, so it must not push anyone past 100%.
eq('Saturday work does not inflate the rate above 1',
  t.loggingRate(
    ['2026-08-24','2026-08-25','2026-08-26','2026-08-27','2026-08-28','2026-08-29'],
    working),
  { logged: 5, working: 5, rate: 1 });

eq('a fully holidayed range has no rate, not zero',
  t.loggingRate([], []), { logged: 0, working: 0, rate: null });

console.log('\nresolveTimezone — the fallback chain');

const fake = (userTz, orgTz) => async () => ({ rows: [{ user_tz: userTz, org_tz: orgTz }] });

(async () => {
  eq('the user timezone wins',
    await t.resolveTimezone(fake('Asia/Kolkata', 'Europe/London'), 1, 1), 'Asia/Kolkata');
  eq('no user timezone falls to the org calendar',
    await t.resolveTimezone(fake(null, 'Europe/London'), 1, 1), 'Europe/London');
  eq('neither falls to UTC',
    await t.resolveTimezone(fake(null, null), 1, 1), 'UTC');
  eq('an invalid user timezone falls to the org rather than throwing',
    await t.resolveTimezone(fake('Not/AZone', 'Europe/London'), 1, 1), 'Europe/London');
  eq('an invalid user AND org timezone falls to UTC',
    await t.resolveTimezone(fake('Not/AZone', 'Also/Bogus'), 1, 1), 'UTC');
  eq('an empty string is not a timezone',
    await t.resolveTimezone(fake('', 'Europe/London'), 1, 1), 'Europe/London');
  eq('a missing user row falls to UTC',
    await t.resolveTimezone(async () => ({ rows: [] }), 1, 1), 'UTC');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('dailyWorkDate verified.\n');
})();
