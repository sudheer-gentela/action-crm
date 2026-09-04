// DailyWorkSetupView.js
//
// Owner and admin only. Three things live here. The last two decide the DENOMINATOR
// of every rate in the module:
//
//   Activity list       the shared vocabulary for the KIND of work, which is
//                       the only thing comparable across people
//   Holiday calendars   which days are not expected of anyone on that calendar
//   Working weeks       which weekdays each person is expected to log, and
//                       which calendar applies to them
//
// That is why this is not in the manager's team view. Someone with reports can
// read a rate; changing what the rate is measured against is a different act,
// and it silently restates figures people have already been shown.
//
// ── Effective dating ─────────────────────────────────────────────────
//
// Changing a working week adds a ROW, it does not rewrite the old one. Someone
// moving to a four-day week in June keeps their May days measured against the
// week that was actually in force then. The form asks for the date the change
// takes effect for exactly this reason, and defaults to today rather than
// backdating quietly.
//
// ── Dates are strings ────────────────────────────────────────────────
//
// 'YYYY-MM-DD' throughout, never a Date object. new Date('2026-08-28') is UTC
// midnight and renders as the 27th west of UTC.

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './DailyWork.css';

// Bit 0 is Monday, matching weekday_mask in 2026_131. Mon-Fri is 31.
const DAYS = [
  { bit: 0, short: 'M', label: 'Monday' },
  { bit: 1, short: 'T', label: 'Tuesday' },
  { bit: 2, short: 'W', label: 'Wednesday' },
  { bit: 3, short: 'T', label: 'Thursday' },
  { bit: 4, short: 'F', label: 'Friday' },
  { bit: 5, short: 'S', label: 'Saturday' },
  { bit: 6, short: 'S', label: 'Sunday' },
];
const MON_FRI = 31;

export default function DailyWorkSetupView() {
  const [calendars, setCalendars] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, s, r] = await Promise.all([
        apiService.dailyWork.listCalendars(),
        apiService.dailyWork.listSchedules(),
        // Reported, not enforced. A failure here must not take the screen
        // down — the sections below still work without it.
        apiService.dailyWork.setupReadiness().catch(() => null),
      ]);
      setCalendars(c.data || []);
      setSchedules(s.data || []);
      setReadiness(r?.data || null);
    } catch (err) {
      // requireRole fails closed, so a 403 here is a real answer rather than a
      // glitch: this person is not an owner or admin.
      if (err?.response?.status === 403) setDenied(true);
      else setNotice({ kind: 'stop', text: readError(err, 'Could not load the setup') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (fn, okText) => {
    try {
      await fn();
      if (okText) setNotice({ kind: 'info', text: okText });
      await load();
    } catch (err) {
      setNotice({ kind: 'stop', text: readError(err, 'That did not work') });
    }
  };

  if (loading) return <div className="dw"><div className="dw-spinner">Loading…</div></div>;

  if (denied) {
    return (
      <div className="dw">
        <div className="dw-banner warn">
          Only an owner or admin can change holiday calendars and working weeks.
          These decide what everyone's logging rate is measured against.
        </div>
      </div>
    );
  }


  return (
    <div className="dw">
      <div className="dw-head">
        <div>
          <h1>Daily work setup</h1>
          <div className="dw-sub">
            The shared activity list, holiday calendars and working weeks
          </div>
        </div>
      </div>

      {notice && <div className={`dw-banner ${notice.kind}`}>{notice.text}</div>}

      {/* Missing configuration does not break anything — the metric falls back
          to Mon-Fri with no holidays. It is worth saying out loud precisely
          because it is silent: a wrong rate looks exactly like a right one. */}
      <ReadinessPanel readiness={readiness} calendars={calendars} onRun={run} />

      <BackfillSection onRun={run} />
      <ActivityTypeSection onRun={run} />
      <CalendarSection calendars={calendars} onRun={run} />
      <ScheduleSection schedules={schedules} calendars={calendars} onRun={run} />
    </div>
  );
}


/* ── readiness ──────────────────────────────────────────────────────── */

/**
 * What is still missing before this org's numbers mean anything.
 *
 * REPORTS, DOES NOT GATE. A hard gate would take a running org offline the
 * moment somebody retired their last activity type, which is a worse failure
 * than an incomplete setup — and the module degrades honestly anyway: an
 * unscheduled person is measured against Mon-Fri with no holidays, which is a
 * guess rather than a crash. The point of saying it out loud is that the
 * failure is SILENT. A wrong rate looks exactly like a right one.
 *
 * Each line names the consequence rather than the setting. "3 people have no
 * working week, so they have no denominator and no rate" is actionable;
 * "setup incomplete" is not.
 */
function ReadinessPanel({ readiness, calendars, onRun }) {
  const [bulk, setBulk] = useState(null);   // 'schedules' | 'timezone' | null
  const [mask, setMask] = useState(MON_FRI);
  const [calId, setCalId] = useState('');
  const [from, setFrom] = useState(todayString());
  const [tz, setTz] = useState('');

  if (!readiness) return null;

  const checks  = readiness.checks || [];
  const pending = checks.filter(c => !c.advisory && !c.ok);
  const missingSchedules = checks.find(c => c.key === 'schedules');
  const missingTz        = checks.find(c => c.key === 'timezones');

  const close = () => { setBulk(null); setTz(''); };

  return (
    <div className="dw-card" style={{ marginBottom: 14 }}>
      <div className="dw-card-head">
        <h2>Before this is trustworthy</h2>
        <span className="m">
          {readiness.ready
            ? 'Everything required is set'
            : `${pending.length} still to do`}
        </span>
      </div>
      <div className="dw-item-body" style={{ paddingTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {checks.map(c => (
            <div key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span aria-hidden="true" style={{ fontSize: 13, lineHeight: '18px', flexShrink: 0 }}>
                {c.advisory ? 'ℹ️' : c.ok ? '✅' : '⚠️'}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: '#111827' }}>{c.label}</div>
                <div className="dw-meta" style={{ margin: 0 }}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── The two bulk actions ────────────────────────────────────────
            An admin with ten people should not fill in ten identical forms;
            that is why the seed script existed. BOTH ONLY TOUCH PEOPLE WITH
            NO VALUE SET, so neither can quietly restate the four-day week or
            the different timezone somebody chose deliberately. */}
        {(missingSchedules?.count > 0 || missingTz?.count > 0) && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--dw-line-2)', paddingTop: 12 }}>
            {!bulk && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {missingSchedules?.count > 0 && (
                  <button className="dw-btn" onClick={() => setBulk('schedules')}>
                    Set a working week for the {missingSchedules.count} without one
                  </button>
                )}
                {missingTz?.count > 0 && (
                  <button className="dw-btn" onClick={() => setBulk('timezone')}>
                    Set a timezone for the {missingTz.count} without one
                  </button>
                )}
              </div>
            )}

            {bulk === 'schedules' && (
              <div>
                <div className="dw-field" style={{ marginTop: 0 }}>
                  <label>Working days</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {DAYS.map(d => (
                      <button key={d.bit} type="button" title={d.label}
                              aria-pressed={!!(mask & (1 << d.bit))}
                              onClick={() => setMask(m => m ^ (1 << d.bit))}
                              className={`dw-btn ${(mask & (1 << d.bit)) ? 'dw-btn-primary' : ''}`}
                              style={{ minWidth: 34, padding: '4px 8px' }}>{d.short}</button>
                    ))}
                  </div>
                </div>
                <div className="dw-assigngrid" style={{ marginTop: 10 }}>
                  <div className="dw-field">
                    <label htmlFor="dw-bulk-cal">Holiday calendar</label>
                    <select id="dw-bulk-cal" value={calId} onChange={e => setCalId(e.target.value)}>
                      <option value="">No calendar</option>
                      {calendars.map(c => (
                        <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' (default)' : ''}</option>
                      ))}
                    </select>
                  </div>
                  <div className="dw-field">
                    <label htmlFor="dw-bulk-from">In force from</label>
                    <input id="dw-bulk-from" type="date" value={from}
                           onChange={e => setFrom(e.target.value)} />
                  </div>
                </div>
                {/* The single most common way to get this wrong. */}
                <div className="dw-item-status" style={{ marginTop: 6 }}>
                  Set this to the day the pilot starts, not today. Days before it
                  have no schedule and so no denominator — they will not count.
                </div>
                <div className="dw-addform-actions">
                  <button className="dw-btn dw-btn-primary"
                          disabled={!mask}
                          onClick={() => { onRun(
                            () => apiService.dailyWork.bulkSetSchedules({
                              weekdayMask: mask,
                              holidayCalendarId: calId || null,
                              effectiveFrom: from,
                            }),
                            'Working weeks set for everyone who had none.'); close(); }}>
                    Apply to {missingSchedules.count}
                  </button>
                  <button className="dw-btn" onClick={close}>Cancel</button>
                </div>
              </div>
            )}

            {bulk === 'timezone' && (
              <div>
                <div className="dw-field" style={{ marginTop: 0 }}>
                  <label htmlFor="dw-bulk-tz">Timezone</label>
                  <input id="dw-bulk-tz" type="text" value={tz}
                         placeholder="e.g. Asia/Kolkata"
                         onChange={e => setTz(e.target.value)} />
                  {/* Checked against the IANA set server-side, so a typo is
                      refused rather than silently falling back to UTC and
                      shifting somebody's dates by hours. */}
                  <div className="dw-item-status">
                    An IANA name. It decides which day a person&apos;s evening work
                    counts for, which is why it is set here rather than read from
                    whichever device they happened to log in on.
                  </div>
                </div>
                <div className="dw-addform-actions">
                  <button className="dw-btn dw-btn-primary" disabled={!tz.trim()}
                          onClick={() => { onRun(
                            () => apiService.dailyWork.bulkSetTimezone(tz.trim()),
                            'Timezone set for everyone who had none.'); close(); }}>
                    Apply to {missingTz.count}
                  </button>
                  <button className="dw-btn" onClick={close}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── backfill window ────────────────────────────────────────────────── */

/**
 * How many days back somebody may log work.
 *
 * WHY THIS IS A SETTING AT ALL (2026_140). It was a constant of 5, whose own
 * comment said it lived in the service "precisely so it can become a setting
 * without a migration". The pilot hit the edge: with a five-day window, a
 * Monday write-up of the previous Monday is impossible, and a Friday catch-up
 * on the whole week sits exactly on the boundary.
 *
 * SELF-FETCHING, like the sections beside it, rather than taking the value as a
 * prop. The parent loads calendars, schedules and readiness; threading a fourth
 * through for one number would make every section depend on one loader.
 */
function BackfillSection({ onRun }) {
  const [cfg, setCfg]     = useState(null);
  const [value, setValue] = useState('');
  const [busy, setBusy]   = useState(false);
  const [msg, setMsg]     = useState(null);

  const load = useCallback(async () => {
    if (typeof apiService.dailyWork?.getSettings !== 'function') return;
    try {
      const { data } = await apiService.dailyWork.getSettings();
      setCfg(data);
      setValue(String(data.backfillDays));
    } catch { setCfg(null); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const { data } = await apiService.dailyWork.setSettings({ backfillDays: Number(value) });
      setCfg(data);
      setValue(String(data.backfillDays));
      setMsg({ kind: 'info', text: 'Saved.' });
      onRun?.();
    } catch (err) {
      setMsg({ kind: 'stop', text: readError(err, 'Could not save that.') });
    } finally { setBusy(false); }
  };

  if (!cfg) return null;

  const n = Number(value);
  const valid = Number.isInteger(n) && n >= cfg.backfillMin && n <= cfg.backfillMax;
  const dirty = String(cfg.backfillDays) !== String(value);

  return (
    <div className="dw-card" style={{ marginTop: 14 }}>
      <div className="dw-card-head">
        <h2>How far back people can log</h2>
        <span className="m">
          {cfg.backfillDaysIsDefault ? 'Not set — using the default' : 'Set for this organisation'}
        </span>
      </div>
      <div className="dw-item-body" style={{ paddingTop: 10 }}>
        <p className="dw-meta" style={{ marginTop: 0 }}>
          Most people write up yesterday's work this morning, so some window is
          necessary. A long one is not free: if a month of history can be
          entered on the last day of it, the logging rate stops describing
          anything.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                      marginTop: 10 }}>
          <input type="number" value={value} min={cfg.backfillMin} max={cfg.backfillMax}
                 onChange={e => setValue(e.target.value)}
                 style={{ width: 90, padding: '6px 8px', borderRadius: 6,
                          border: '1px solid var(--dw-line-2)', fontFamily: 'inherit' }} />
          <span className="dw-meta">
            days back{n === 0 && valid ? ' — the current day only' : ''}
          </span>
          <button className="dw-btn" disabled={busy || !valid || !dirty} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {!valid && (
            <span className="dw-meta" style={{ color: 'var(--dw-stop, #991b1b)' }}>
              A whole number between {cfg.backfillMin} and {cfg.backfillMax}.
            </span>
          )}
        </div>
        {/* Says what the number MEANS today, not just what it is. "5" is
            abstract; "back to Sunday 30 August" is the thing an admin is
            actually deciding. */}
        {valid && (
          <p className="dw-meta" style={{ marginTop: 8 }}>
            {n === 0
              ? 'People will only be able to log the current day.'
              : `Today, that reaches back to ${backfillEdgeLabel(n)}.`}
          </p>
        )}
        {msg && <div className={`dw-banner ${msg.kind}`} style={{ marginTop: 10 }}>{msg.text}</div>}
      </div>
    </div>
  );
}

/** The earliest date the current window allows, as words. */
function backfillEdgeLabel(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ── activity types ─────────────────────────────────────────────────── */

/**
 * The org's shared activity vocabulary.
 *
 * WHY A SHARED LIST AT ALL. Anchors are select-only for a reason the module
 * learned early: ten people free-typing container names produce three
 * spellings of the same thing inside a fortnight. Activity types are the same
 * bet applied to the KIND of work — and the payoff is the one thing an anchor
 * cannot give you. The anchor answers "which initiative"; the activity type
 * answers "what kind of work", and only the second is comparable across
 * people. Without it "how much went into video editing across the team" has
 * no answer, because every person's item title is their own wording.
 *
 * Loads its own data rather than taking it from the parent: nothing else on
 * this screen needs it, and threading it through would mean the parent
 * reloading calendars and schedules every time somebody renames a label.
 *
 * Retired types are fetched too. The list has to show what it retired in
 * order to offer bringing it back — a retire button that makes the row vanish
 * with no way to undo is a delete wearing a softer word.
 */
function ActivityTypeSection({ onRun }) {
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [editing, setEditing] = useState(null);   // key being renamed
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiService.dailyWork.listAllActivityTypes()
      .then(({ data }) => setTypes(data || []))
      .catch(() => setTypes([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // onRun reloads the PARENT's data, which this section does not use, so each
  // action reloads locally too. Passed through anyway for its error banner:
  // the server's message is the useful one, and it already knows how to show
  // it — "that name was merged into X, use that instead" is worth reading.
  const act = (fn, okText) => onRun(async () => { await fn(); load(); }, okText);

  const add = () => {
    const clean = label.trim();
    if (!clean) return;
    act(() => apiService.dailyWork.createActivityType(clean),
        `"${clean}" added to the shared list`);
    setLabel('');
  };

  const active    = types.filter(t => t.status === 'active');
  const candidate = types.filter(t => t.status === 'candidate');
  const retired   = types.filter(t => t.status === 'retired');

  // COMPACT ROWS. Each entry used to stack — name on one line, buttons on a
  // second with marginTop — inside .dw-dayrow's 14px vertical padding, so a
  // list of nine ran close to 700px and the screen was mostly gap. One flex
  // line with the name left and the controls right roughly halves that.
  //
  // Styled inline rather than by editing .dw-dayrow, which is shared with the
  // day list on the main Daily Work screen. Tightening the shared class would
  // have quietly reflowed a screen nobody asked about.
  const ROW = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '7px 16px', borderBottom: '1px solid var(--dw-line-2)' };

  const row = (t) => (
    <div style={ROW} key={t.key}>
      {editing === t.key ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
          <input value={draft} autoFocus onChange={e => setDraft(e.target.value)}
                 style={{ flex: 1, minWidth: 200 }}
                 onKeyDown={e => { if (e.key === 'Enter') {
                   act(() => apiService.dailyWork.renameActivityType(t.key, draft.trim()), 'Renamed');
                   setEditing(null);
                 } }} />
          <button className="dw-btn dw-btn-sm" onClick={() => {
            act(() => apiService.dailyWork.renameActivityType(t.key, draft.trim()), 'Renamed');
            setEditing(null);
          }}>Save</button>
          <button className="dw-btn dw-btn-sm" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      ) : (
        <>
          <div className="dw-work" style={{ flex: 1, minWidth: 160, lineHeight: 1.3 }}>
            <b>{t.label}</b>
            {t.status === 'candidate' &&
              <span className="dw-badge carried" style={{ marginLeft: 8 }}>proposed</span>}
            {t.status === 'retired' &&
              <span className="dw-badge" style={{ marginLeft: 8 }}>retired</span>}
          </div>
          {/* Right-aligned and no longer wrapped in its own block: the buttons
              sit on the same line as the name they act on. dw-btn-sm keeps a
              36px min-height, which is the tap target and stays. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {t.status === 'candidate' && (
              <button className="dw-btn dw-btn-sm" onClick={() =>
                act(() => apiService.dailyWork.promoteActivityType(t.key),
                    `"${t.label}" added to the shared list`)}>
                Accept
              </button>
            )}
            <button className="dw-btn dw-btn-sm" onClick={() => {
              setEditing(t.key); setDraft(t.label);
            }}>Rename</button>
            {t.status === 'retired' ? (
              <button className="dw-btn dw-btn-sm" onClick={() =>
                act(() => apiService.dailyWork.setActivityTypeRetired(t.key, false),
                    `"${t.label}" is back on the list`)}>
                Bring back
              </button>
            ) : (
              <button className="dw-btn dw-btn-sm" onClick={() =>
                act(() => apiService.dailyWork.setActivityTypeRetired(t.key, true),
                    `"${t.label}" retired`)}>
                Retire
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="dw-card" style={{ marginBottom: 16 }}>
      <div className="dw-card-head">
        <h2>Activity list</h2>
        <span className="m">
          {loading ? 'Loading…'
            : active.length === 0
              ? 'Empty — nobody can classify their work yet'
              : `${active.length} in use${candidate.length ? ` · ${candidate.length} proposed` : ''}`}
        </span>
      </div>

      {/* Empty is the state every org starts in — nothing seeds this table —
          and it is silent: the picker still works, it just offers only
          "Other", so the vocabulary accretes one free-typed proposal at a
          time in whatever wording came first. Say so. */}
      {!loading && active.length === 0 && (
        <div className="dw-item-body">
          <div className="dw-note">
            Nothing here yet. Until you add some, everyone picking "Kind of activity"
            sees only <b>Other</b>, and each name they type arrives here as a separate
            proposal — which is how the same work ends up under three different names.
          </div>
        </div>
      )}

      {/* padding overridden from .dw-item-body's 0 16px 16px: the add row sits
          directly above the list, and 16px under it plus the first row's own
          padding read as a gap between the control and what it adds to. */}
      <div className="dw-item-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 16px' }}>
        <input value={label} placeholder="e.g. Editing demo videos"
               onChange={e => setLabel(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') add(); }}
               style={{ flex: 1, minWidth: 220 }} />
        <button className="dw-btn dw-btn-primary" onClick={add}>Add activity</button>
      </div>

      {candidate.length > 0 && (
        <>
          <div className="dw-item-body" style={{ padding: '8px 16px 4px' }}>
            <div className="dw-meta">
              Proposed by someone picking "Other". Accept it, or rename it to match
              something already on the list.
            </div>
          </div>
          <div className="dw-daylog">{candidate.map(row)}</div>
        </>
      )}

      {active.length > 0 && <div className="dw-daylog">{active.map(row)}</div>}

      {retired.length > 0 && (
        <>
          <div className="dw-item-body" style={{ padding: '8px 16px 4px' }}>
            <div className="dw-meta">
              Retired — not offered to anyone, but kept so past entries still read
              correctly.
            </div>
          </div>
          <div className="dw-daylog">{retired.map(row)}</div>
        </>
      )}
    </div>
  );
}

/* ── calendars ──────────────────────────────────────────────────────── */

function CalendarSection({ calendars, onRun }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(null);

  return (
    <div className="dw-card" style={{ marginBottom: 16 }}>
      <div className="dw-card-head">
        <h2>Holiday calendars</h2>
        <span className="m">
          {calendars.length === 0
            ? 'None yet — every weekday counts as a working day'
            : `${calendars.length} ${calendars.length === 1 ? 'calendar' : 'calendars'}`}
        </span>
      </div>

      <div className="dw-daylog">
        {calendars.map(c => (
          <div className="dw-dayrow" key={c.id}>
            <div className="t" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b>{c.name}</b>
              {c.is_default && <span className="dw-badge assigned">default</span>}
              <span className="dw-badge">{c.date_count} {c.date_count === 1 ? 'date' : 'dates'}</span>
              <span className="dw-badge">{c.people} {c.people === 1 ? 'person' : 'people'}</span>
              <button className="dw-btn-link" style={{ marginLeft: 'auto' }}
                      onClick={() => setOpen(open === c.id ? null : c.id)}>
                {open === c.id ? 'Hide dates' : 'Dates'}
              </button>
            </div>

            {c.date_count === 0 && (
              <div className="dw-meta">
                No dates — anyone on this calendar has every scheduled weekday counted.
              </div>
            )}

            {open === c.id && (
              <CalendarDates calendar={c} onRun={onRun} />
            )}
          </div>
        ))}
      </div>

      <div className="dw-item-body" style={{ paddingTop: 14 }}>
        {adding ? (
          <>
            <div className="dw-field" style={{ marginTop: 0 }}>
              <label htmlFor="dw-cal-name">Calendar name</label>
              <input id="dw-cal-name" type="text" value={name} autoFocus
                     placeholder="e.g. India, or UK"
                     onChange={e => setName(e.target.value)} />
            </div>
            <div className="dw-addform-actions">
              <button className="dw-btn dw-btn-primary" onClick={() => {
                onRun(() => apiService.dailyWork.createCalendar({
                  name, isDefault: calendars.length === 0,
                }), `Created "${name}".`);
                setName(''); setAdding(false);
              }}>Create</button>
              <button className="dw-btn" onClick={() => { setAdding(false); setName(''); }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button className="dw-btn" onClick={() => setAdding(true)}>+ Add a calendar</button>
        )}
      </div>
    </div>
  );
}

/**
 * The dates in one calendar, and a paste box for adding many.
 *
 * The paste box exists because holidays arrive as a list once a year, and
 * fourteen separate date pickers is the kind of chore that means the calendar
 * never gets filled in — and an empty calendar quietly inflates everyone's
 * denominator.
 */
function CalendarDates({ calendar, onRun }) {
  const [bulk, setBulk] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const parse = () => bulk.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    // "2026-10-02, Gandhi Jayanti" or "2026-10-02 Gandhi Jayanti" or bare
    const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})[\s,]*(.*)$/);
    return m ? { date: m[1], label: m[2] || null } : { date: trimmed, label: null };
  }).filter(Boolean);

  const parsed = parse();
  const bad = parsed.filter(p => !/^\d{4}-\d{2}-\d{2}$/.test(p.date));

  return (
    <div className="dw-detail">
      {calendar.dates.length > 0 && (
        <div className="dw-ev" style={{ marginBottom: 10 }}>
          {calendar.dates.map(d => (
            <div className="dw-ev-item" key={d.id}>
              <span className="k">{d.holiday_date}</span>
              <span style={{ flex: 1 }}>{d.label || 'Unnamed'}</span>
              <button className="dw-btn-link"
                      onClick={() => onRun(() => apiService.dailyWork.removeHoliday(d.id),
                        `Removed ${d.holiday_date}.`)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd ? (
        <>
          <div className="dw-field" style={{ marginTop: 0 }}>
            <label htmlFor={`dw-bulk-${calendar.id}`}>
              One per line — date first, name after
            </label>
            <textarea
              id={`dw-bulk-${calendar.id}`}
              rows={5}
              value={bulk}
              placeholder={'2026-10-02, Gandhi Jayanti\n2026-10-20, Diwali\n2026-12-25, Christmas'}
              onChange={e => setBulk(e.target.value)}
            />
            <div className="dw-foot">
              {bad.length > 0
                ? <span className="dw-err">{bad.length} {bad.length === 1 ? 'line is' : 'lines are'} not YYYY-MM-DD</span>
                : parsed.length > 0 && <span className="dw-meta">{parsed.length} to add</span>}
            </div>
          </div>
          <div className="dw-addform-actions">
            <button className="dw-btn dw-btn-sm dw-btn-primary"
                    disabled={!parsed.length || bad.length > 0}
                    onClick={() => {
                      onRun(async () => {
                        const { data } = await apiService.dailyWork.addHolidays(calendar.id, parsed);
                        return data;
                      }, `Added to ${calendar.name}. Dates already there were left alone.`);
                      setBulk(''); setShowAdd(false);
                    }}>
              Add these
            </button>
            <button className="dw-btn dw-btn-sm" onClick={() => { setShowAdd(false); setBulk(''); }}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="dw-addform-actions">
          <button className="dw-btn dw-btn-sm" onClick={() => setShowAdd(true)}>Add dates</button>
          {!calendar.is_default && (
            <button className="dw-btn dw-btn-sm"
                    onClick={() => onRun(() => apiService.dailyWork.setDefaultCalendar(calendar.id),
                      `"${calendar.name}" is now the default.`)}>
              Make default
            </button>
          )}
          {calendar.people === 0 && (
            <button className="dw-btn dw-btn-sm"
                    onClick={() => onRun(() => apiService.dailyWork.deleteCalendar(calendar.id),
                      `Deleted "${calendar.name}".`)}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── working weeks ──────────────────────────────────────────────────── */

function ScheduleSection({ schedules, calendars, onRun }) {
  return (
    <div className="dw-card">
      <div className="dw-card-head">
        <h2>Working weeks</h2>
        <span className="m">Everyone granted the module</span>
      </div>
      <div className="dw-daylog">
        {schedules.length === 0 && (
          <div className="dw-dayrow">
            <div className="dw-none">
              Nobody has been granted the module yet.
            </div>
          </div>
        )}
        {schedules.map(s => (
          <ScheduleRow key={s.user_id} row={s} calendars={calendars} onRun={onRun} />
        ))}
      </div>
    </div>
  );
}

function ScheduleRow({ row, calendars, onRun }) {
  const [editing, setEditing] = useState(false);
  const [mask, setMask] = useState(row.weekday_mask || MON_FRI);
  const [calendarId, setCalendarId] = useState(row.holiday_calendar_id || '');
  const [from, setFrom] = useState(todayString());
  const [tz, setTz] = useState(row.timezone || '');

  const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || `User ${row.user_id}`;
  const toggle = bit => setMask(m => m ^ (1 << bit));

  return (
    <div className="dw-dayrow">
      <div className="t" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{name}</b>
        {row.timezone && <span className="dw-badge">{row.timezone}</span>}
        {row.schedule_id ? (
          <>
            <span className="dw-badge">{describeMask(row.weekday_mask)}</span>
            <span className="dw-badge">{row.calendar_name || 'no calendar'}</span>
            <span className="dw-badge">from {row.effective_from}</span>
          </>
        ) : (
          <span className="dw-badge carried">no working week set</span>
        )}
        {!row.timezone && <span className="dw-badge carried">no timezone</span>}
        <button className="dw-btn-link" style={{ marginLeft: 'auto' }}
                onClick={() => setEditing(!editing)}>
          {editing ? 'Cancel' : row.schedule_id ? 'Change' : 'Set it'}
        </button>
      </div>

      {editing && (
        <div className="dw-detail">
          <div className="dw-field" style={{ marginTop: 0 }}>
            <label>Days they are expected to log</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {DAYS.map(d => {
                const on = (mask & (1 << d.bit)) !== 0;
                return (
                  <button key={d.bit} type="button" title={d.label}
                          onClick={() => toggle(d.bit)}
                          aria-pressed={on}
                          style={{
                            width: 44, height: 44, borderRadius: 8, cursor: 'pointer',
                            border: `1.5px solid ${on ? '#1A3A5C' : '#e2e8f0'}`,
                            background: on ? '#1A3A5C' : '#fff',
                            color: on ? '#fff' : '#64748b',
                            fontWeight: on ? 700 : 400, font: 'inherit',
                          }}>
                    {d.short}
                  </button>
                );
              })}
            </div>
            {mask === 0 && (
              <div className="dw-err" style={{ marginTop: 6 }}>
                Pick at least one day — a week with none has no denominator at all.
              </div>
            )}
          </div>

          <div className="dw-field">
            <label htmlFor={`dw-tz-${row.user_id}`}>Timezone</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input id={`dw-tz-${row.user_id}`} type="text" value={tz}
                     placeholder="e.g. Asia/Kolkata"
                     onChange={e => setTz(e.target.value)} />
              <button className="dw-btn dw-btn-sm" disabled={!tz.trim()}
                      onClick={() => onRun(
                        () => apiService.dailyWork.setUserTimezone(row.user_id, tz.trim()),
                        `${name} is now on ${tz.trim()}.`)}>
                Set
              </button>
            </div>
            <div className="dw-item-status">
              Decides which day their evening work counts for. Left blank, it falls
              back to the organisation's calendar.
            </div>
          </div>

          <div className="dw-addgrid" style={{ marginTop: 14 }}>
            <div className="dw-field" style={{ marginTop: 0 }}>
              <label htmlFor={`dw-cal-${row.user_id}`}>Holiday calendar</label>
              <select id={`dw-cal-${row.user_id}`} value={calendarId}
                      onChange={e => setCalendarId(e.target.value)}>
                <option value="">None — every scheduled weekday counts</option>
                {calendars.map(c => (
                  <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>
            <div className="dw-field" style={{ marginTop: 0 }}>
              <label htmlFor={`dw-from-${row.user_id}`}>Takes effect from</label>
              <input id={`dw-from-${row.user_id}`} type="date" value={from}
                     onChange={e => setFrom(e.target.value)} />
            </div>
          </div>

          <div className="dw-item-status">
            This adds a dated change rather than replacing the old one, so days
            before {from || 'that date'} stay measured against the week that was
            in force then.
          </div>

          <div className="dw-addform-actions">
            <button className="dw-btn dw-btn-sm dw-btn-primary" disabled={!mask || !from}
                    onClick={() => {
                      onRun(() => apiService.dailyWork.setSchedule(row.user_id, {
                        weekdayMask: mask,
                        holidayCalendarId: calendarId ? Number(calendarId) : null,
                        effectiveFrom: from,
                      }), `${name}: ${describeMask(mask)} from ${from}.`);
                      setEditing(false);
                    }}>
              Save
            </button>
            <button className="dw-btn dw-btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── helpers ────────────────────────────────────────────────────────── */

function describeMask(mask) {
  if (!mask) return 'no days';
  if (mask === MON_FRI) return 'Mon–Fri';
  if (mask === 63) return 'Mon–Sat';
  if (mask === 127) return 'every day';
  return DAYS.filter(d => mask & (1 << d.bit)).map(d => d.label.slice(0, 3)).join(', ');
}

/** Today as 'YYYY-MM-DD' in the browser's zone — a default, not a source of truth. */
function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readError(err, fallback) {
  return err?.response?.data?.error || err?.message || fallback;
}
