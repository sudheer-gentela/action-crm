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
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        apiService.dailyWork.listCalendars(),
        apiService.dailyWork.listSchedules(),
      ]);
      setCalendars(c.data || []);
      setSchedules(s.data || []);
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

  const unscheduled = schedules.filter(s => !s.schedule_id);
  const noTimezone = schedules.filter(s => !s.timezone);

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
      {unscheduled.length > 0 && (
        <div className="dw-banner warn">
          <b>{unscheduled.length} {unscheduled.length === 1 ? 'person has' : 'people have'} no working week set.</b>{' '}
          They are being measured against Monday to Friday with no holidays, which
          may not be what they work.
        </div>
      )}
      {noTimezone.length > 0 && (
        <div className="dw-banner warn">
          <b>{noTimezone.length} {noTimezone.length === 1 ? 'person has' : 'people have'} no timezone.</b>{' '}
          Their day boundary falls back to the organisation's, so late-evening work
          may be filed against the wrong day.
        </div>
      )}

      <ActivityTypeSection onRun={run} />
      <CalendarSection calendars={calendars} onRun={run} />
      <ScheduleSection schedules={schedules} calendars={calendars} onRun={run} />
    </div>
  );
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
