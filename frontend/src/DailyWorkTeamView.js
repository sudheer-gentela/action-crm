// DailyWorkTeamView.js
//
// The manager surface. Rendered inside DailyWorkView behind a tab, and shown
// only to someone with reports.
//
// ── The one idea that keeps this usable ──────────────────────────────
//
// THE ROW GRAIN FOLLOWS THE PERIOD.
//
//   Day            one row per person for that date
//   Week / Month   one row per person for the WHOLE period, with a strip of
//                  squares for the days; expand to the days, expand a day to
//                  the items
//
// Fifteen people over a week is seventy-five person-days. Listing those is a
// wall nobody reads, and the manager's real question is never "show me
// everything" — it is "who is drifting", which is why 'fewest days logged
// first' is one click away.
//
// ── Dates are strings ────────────────────────────────────────────────
//
// 'YYYY-MM-DD', both directions, never a Date object. new Date('2026-08-28')
// parses as UTC midnight and renders as the 27th for anyone west of UTC — the
// same class of bug the backend avoids by casting every date column to text.
//
// ── Nothing here is stored ───────────────────────────────────────────
//
// Every number on this screen is derived at read. There is no summary table to
// drift out of step with the entries, which is the failure this codebase has
// already had twice.

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import { hashIdSegment, hashSegment, writeHash } from './hashNav';
import { ProjectItemRow, dueText } from './dailyWorkProjectLink';
import './DailyWork.css';

const PERIODS = [
  { value: 'day',   label: 'Day' },
  { value: 'week',  label: 'Week' },
  { value: 'month', label: 'Month' },
];

export default function DailyWorkTeamView() {
  const [period, setPeriod]   = useState('day');
  const [anchorDate, setAnchor] = useState(null);   // 'YYYY-MM-DD'
  const [sortBy, setSortBy]   = useState('name');
  const [filters, setFilters] = useState({ account: '', anchor: '', activity: '', department: '' });

  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [rollup, setRollup]   = useState([]);
  const [log, setLog]         = useState([]);
  const [window_, setWindow]  = useState({ from: null, to: null });

  const [anchors, setAnchors]       = useState([]);
  const [activityTypes, setActivityTypes] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [stalled, setStalled]       = useState([]);
  const [candidates, setCandidates] = useState([]);
  // The rows behind the overdue chip, and — separately — whether the people
  // list below is narrowed to the people who appear in them.
  //
  // Two pieces of state, not one, because they are two views of the same fact
  // and a manager uses each at a different moment: "what is late" when
  // something is on fire, "who is behind" on a Monday. Collapsing them into
  // one mode would force a choice the screen has no basis to make.
  const [overdue, setOverdue] = useState([]);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [accountSummary, setAccountSummary] = useState(null);

  const [assigning, setAssigning] = useState(false);
  // Hide the two project columns entirely when the org has no Projects module.
  // A column of zeros reads as "nothing assigned", which is a different and
  // wrong claim.
  const [hasProjects, setHasProjects] = useState(false);
  // The full-page person view. null = the list.
  //
  // Holds the whole rollup ROW, not an id — PersonPage renders the name, the
  // day strip and the logged/working counts straight off it. So a person named
  // in the URL cannot be opened until the rollup has arrived and we can find
  // their row, which is the same two-step HandoverView uses for a deep-linked
  // project.
  const [openPerson, setOpenPerson] = useState(null);
  // A userId from the URL, waiting for the rollup. Cleared once resolved,
  // whether or not a matching row turned up.
  const [pendingPersonId, setPendingPersonId] = useState(
    () => (hashSegment(1) === 'people' ? hashIdSegment(2) : null));
  // Which attention queue is expanded, if any. One at a time — both open at
  // once pushes the people off the screen, which is the thing this replaced.
  const [showQueue, setShowQueue] = useState(null);
  // Filters start CLOSED. Five dropdowns in an always-open card pushed the
  // people themselves below the fold, so the screen opened on its own controls
  // instead of its content. Opens automatically when a filter is active, so a
  // narrowed list never looks like the whole list.
  const [showFilters, setShowFilters] = useState(false);
  const [expanded, setExpanded] = useState({});   // key -> true
  const [details, setDetails]   = useState({});   // `${user}:${date}` -> rows
  const [notice, setNotice]     = useState(null);

  /* ── window ───────────────────────────────────────────────────────── */

  const range = useCallback(() => {
    if (!anchorDate) return {};                 // let the server default it
    if (period === 'day') return { from: anchorDate, to: anchorDate };
    const [y, m, d] = anchorDate.split('-').map(Number);
    if (period === 'month') {
      const last = new Date(y, m, 0).getDate();
      return { from: `${pad(y, 4)}-${pad(m)}-01`, to: `${pad(y, 4)}-${pad(m)}-${pad(last)}` };
    }
    // Week: Monday to Sunday containing the anchor. Built from calendar parts,
    // never by adding milliseconds to an instant.
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(y, m - 1, d - dow));
    const sunday = new Date(Date.UTC(y, m - 1, d - dow + 6));
    return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
  }, [period, anchorDate]);

  /* ── load ─────────────────────────────────────────────────────────── */

  // useCallback, so it can be a dependency of `load` without rebuilding it on
  // every render — which, with the effect below keyed on load, would be an
  // endless fetch loop. Keyed on `filters`, which is the only thing it reads.
  const apiFilters = useCallback(() => {
    const f = {};
    if (filters.account) f.account = filters.account;
    if (filters.activity) f.activity = filters.activity;
    if (filters.department) f.department = filters.department;
    if (filters.anchor) {
      const [kind, id] = filters.anchor.split(':');
      f.anchorKind = kind; f.anchorId = id;
    }
    return f;
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = range();
      const params = { ...r, ...apiFilters() };

      // /people replaces the plain rollup here: same rows, plus the open and
      // overdue project counts. It degrades on its own if the Projects module
      // is off, so this call never needs to know whether the org has it.
      const [peopleRes, logRes] = await Promise.all([
        apiService.dailyWork.people(params),
        apiService.dailyWork.teamLog(params),
      ]);

      setRollup(peopleRes.data.people || []);
      setHasProjects(peopleRes.data.projectsAvailable !== false);
      setLog(logRes.data.rows || []);
      setWindow({ from: peopleRes.data.from, to: peopleRes.data.to });

      // The anchor follows the server's idea of the window the first time, so
      // "today" means the viewer's local today rather than the browser's.
      if (!anchorDate && peopleRes.data.to) setAnchor(peopleRes.data.to);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load your people');
    } finally {
      setLoading(false);
    }
    // DEFECT FIXED. This was [range], with the exhaustive-deps rule silenced.
    //
    // `range` depends on [period, anchorDate], so `load` was rebuilt only when
    // the period or the date moved — never when the FILTERS changed. But load
    // calls apiFilters(), which reads `filters` from the closure it was built
    // in. The effect below did list `filters`, so a filter change re-ran the
    // effect, which then called the STALE load, which sent the filters as they
    // were one change ago. The first filter you picked sent none at all.
    //
    // That is the whole "filters do not work" report: the list was showing
    // unfiltered data. It also explains why expanding a row returned nothing —
    // openDay is a plain function, rebuilt every render, so IT sent the current
    // filters while the rollup beside it had been built from the previous ones.
    // The two disagreeing is the signature of this bug, not a second one.
    //
    // The disable comment goes with it. It was hiding exactly the dependency
    // that mattered.
  }, [range, apiFilters, anchorDate]);

  // Keyed on `load` alone now. load already closes over period, anchorDate
  // (through range) and filters, so listing them again would be three ways to
  // say one thing — and the version that drifts is the one that gets silenced.
  useEffect(() => { load(); }, [load]);

  // Restore where the manager was before they left for a project.
  //
  // Sets period and anchor date as well as the person: the People screen keeps
  // those in component state, and this module unmounts on tab switch, so
  // without them someone who left from Week comes back to Day.
  //
  // Routed through pendingPersonId rather than setOpenPerson so it waits for
  // the rollup like every other restore — the row object it needs does not
  // exist yet at this moment.
  useEffect(() => {
    const onRestore = (e) => {
      const d = e.detail || {};
      if (d.period) setPeriod(d.period);
      if (d.anchor) setAnchor(d.anchor);
      if (d.filters) setFilters(d.filters);
      if (d.userId) setPendingPersonId(d.userId);
    };
    window.addEventListener('dailywork-restore', onRestore);
    return () => window.removeEventListener('dailywork-restore', onRestore);
  }, []);

  /* ── the person in the URL ────────────────────────────────────────── */

  // Once the rollup lands, open whoever the link named.
  //
  // SAY SO WHEN IT CANNOT. A link can name someone outside the sender's
  // manager chain, someone who has left, or someone the current filters
  // exclude — and the three are indistinguishable from here. Silently landing
  // on the list would leave the recipient thinking the link was stale when it
  // may be their own filter hiding the row, so the screen says which it is
  // not, and does not guess.
  useEffect(() => {
    if (!pendingPersonId) return;
    if (loading || rollup.length === 0) return;
    const row = rollup.find(r => r.user_id === pendingPersonId);
    if (row) setOpenPerson(row);
    else setNotice({ kind: 'warn', text:
      'That link points at somebody who is not in this list — they may be outside your team, or hidden by the filters or period above.' });
    setPendingPersonId(null);
  }, [pendingPersonId, rollup, loading]);

  // Mirror the open person into segment 2. Held until any restore resolves, or
  // this would clear the very id it is waiting on. Segment 1 belongs to
  // DailyWorkView, so it is passed through unchanged rather than assumed:
  // this component is only ever mounted under 'people', but writing the word
  // it reads keeps the two from drifting.
  useEffect(() => {
    if (hashSegment(0) !== 'dailywork' || hashSegment(1) !== 'people') return;
    if (pendingPersonId) return;
    writeHash(['dailywork', 'people', openPerson ? openPerson.user_id : null]);
  }, [openPerson, pendingPersonId]);

  useEffect(() => {
    apiService.dailyWork.getAnchors().then(({ data }) => setAnchors(data || [])).catch(() => {});
    apiService.dailyWork.stalled().then(({ data }) => setStalled(data || [])).catch(() => {});
    apiService.dailyWork.candidates().then(({ data }) => setCandidates(data || [])).catch(() => {});
    apiService.dailyWork.overdue().then(({ data }) => setOverdue(data.items || [])).catch(() => {});
    apiService.dailyWork.listActivityTypes()
      .then(({ data }) => setActivityTypes(data || [])).catch(() => {});
    apiService.dailyWork.listDepartments()
      .then(({ data }) => setDepartments(data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!filters.account) { setAccountSummary(null); return; }
    const r = range();
    apiService.dailyWork.accountSummary({ account: filters.account, ...r })
      .then(({ data }) => setAccountSummary(data))
      .catch(() => setAccountSummary(null));
  }, [filters.account, period, anchorDate]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── expanding ────────────────────────────────────────────────────── */

  const toggle = key => setExpanded(e => ({ ...e, [key]: !e[key] }));

  const openDay = async (userId, date) => {
    const key = `${userId}:${date}`;
    toggle(key);
    if (details[key]) return;
    // Fetched only when opened. Most rows never are, and pulling every item for
    // every day to serve the few that get opened is what makes a screen that is
    // fine at ten people unusable at a hundred.
    try {
      const { data } = await apiService.dailyWork.teamDayDetail({
        user: userId, date, ...apiFilters() });
      setDetails(d => ({ ...d, [key]: data || [] }));
    } catch { /* the row still shows its summary */ }
  };

  /* ── vocabulary queue ─────────────────────────────────────────────── */

  const promote = async (key) => {
    try {
      await apiService.dailyWork.promoteActivityType(key);
      setCandidates(c => c.filter(x => x.key !== key));
      setNotice({ kind: 'info', text: `"${key}" added to the shared list.` });
    } catch (err) {
      setNotice({ kind: 'stop', text: err?.response?.data?.error || 'Could not promote that' });
    }
  };

  const merge = async (key, intoKey) => {
    if (!intoKey) return;
    try {
      const { data } = await apiService.dailyWork.mergeActivityType(key, intoKey);
      setCandidates(c => c.filter(x => x.key !== key));
      setNotice({ kind: 'info',
        text: `Merged into "${intoKey}". ${data.entriesMoved} existing ${data.entriesMoved === 1 ? 'entry' : 'entries'} moved across.` });
      load();
    } catch (err) {
      setNotice({ kind: 'stop', text: err?.response?.data?.error || 'Could not merge that' });
    }
  };

  /* ── render ───────────────────────────────────────────────────────── */

  if (loading && !rollup.length) {
    return <div className="dw"><div className="dw-spinner">Loading your team…</div></div>;
  }

  const sorted = sortBy === 'gaps'
    ? [...rollup].sort((a, b) => (a.days_logged - b.days_logged) || cmpName(a, b))
    : [...rollup].sort(cmpName);

  const loggedToday = rollup.filter(r => r.days_logged > 0).length;
  const totalOverdue = rollup.reduce((n, r) => n + (r.overdueTasks || 0), 0);

  // Who appears in the overdue rows. Derived from the ROWS rather than from
  // r.overdueTasks > 0 so the filter and the queue can never disagree about
  // which people they are talking about — one of them would otherwise be
  // reading a count and the other a list.
  const overduePeopleIds = new Set(overdue.map(o => o.userId));

  // Names for the queue. The rollup is the single source: the queue endpoint
  // deliberately returns userId only.
  const nameOf = (userId) => {
    const r = rollup.find(x => x.user_id === userId);
    return r ? `${r.first_name} ${r.last_name}`.trim() : 'Someone on your team';
  };

  // The narrowed list. Applied AFTER sorting so the order a manager chose is
  // preserved through the filter rather than reshuffled by it.
  const activeFilterCount =
    ['account', 'anchor', 'activity', 'department'].filter(k => filters[k]).length;

  // FILTERS NARROW THE PEOPLE LIST, not just the numbers in it.
  //
  // getRollup returns a row for EVERY user in scope by design — "the absence
  // of a row is exactly the case this screen exists to show", so somebody who
  // logged nothing still appears with a zero rather than vanishing. That is
  // right with no filter applied. With one applied it made the filters look
  // broken: picking department "General Management" left all eight people on
  // screen, Marketing/BD included, because only the aggregates were filtered.
  //
  // Applying a filter changes the question from "who is keeping up" to "who
  // did work matching this", and somebody with no matching entry is not part
  // of that answer. entry_count is computed by getRollup WITH the filters
  // applied, so it is already the right test — no second request needed.
  //
  // The filters match the ENTRY's snapshot, not the person: the department
  // filter finds entries filed under a department, which is what makes it
  // meaningful for someone who moved teams mid-period.
  const filtered = activeFilterCount > 0
    ? sorted.filter(p => (p.entry_count || 0) > 0)
    : sorted;

  const visiblePeople = overdueOnly
    ? filtered.filter(p => overduePeopleIds.has(p.user_id))
    : filtered;

  // The person page is a full screen, not an overlay: it replaces the list
  // rather than sitting on top of it, so the back control is the only way out
  // and there is never a half-covered list behind it to wonder about.
  if (openPerson) {
    const fresh = rollup.find(r => r.user_id === openPerson.user_id) || openPerson;
    return (
      <PersonPage
        person={fresh}
        range={range()}
        filters={apiFilters()}
        /* The window as the USER chose it, not as the API receives it.
           range() is already collapsed to {from,to}, which cannot be turned
           back into "week of 24 Aug" — and the return crumb has to restore
           the choice, not a derived pair of dates. */
        period={period}
        anchorDate={anchorDate}
        onBack={() => setOpenPerson(null)}
      />
    );
  }

  return (
    <div className="dw">
      <div className="dw-head">
        <div>
          <h1>People</h1>
          {/* Said ONCE, here. It used to repeat on every unlogged row, which on
              a day when nobody has logged yet is the same sentence eight times
              and no information at all. */}
          <div className="dw-sub" style={{ marginBottom: 2 }}>
            A day with no entry is simply an absence — nothing expires and nothing accumulates.
          </div>
          <div className="dw-sub">
            {window_.from === window_.to
              ? formatDate(window_.from)
              : `${formatDate(window_.from)} — ${formatDate(window_.to)}`}
            {' · '}{loggedToday} of {rollup.length} logged
          </div>
        </div>
        <div className="dw-head-actions">
          <div className="dw-toggle" role="group" aria-label="Period">
            {PERIODS.map(p => (
              <button key={p.value} type="button" aria-pressed={period === p.value}
                      onClick={() => setPeriod(p.value)}>{p.label}</button>
            ))}
          </div>
          {period === 'day' && (
            <>
              <button className="dw-btn dw-btn-sm" onClick={() => setAnchor(shiftDate(anchorDate, -1))}>‹</button>
              <button className="dw-btn dw-btn-sm" onClick={() => setAnchor(shiftDate(anchorDate, 1))}>›</button>
            </>
          )}
          <button className="dw-btn dw-btn-primary" onClick={() => setAssigning(a => !a)}>
            {assigning ? 'Cancel' : 'Assign work'}
          </button>
        </div>
      </div>

      {notice && <div className={`dw-banner ${notice.kind}`}>{notice.text}</div>}
      {error && <div className="dw-banner stop">{error}</div>}

      {assigning && (
        <AssignForm
          people={rollup}
          anchors={anchors}
          activityTypes={activityTypes}
          onCancel={() => setAssigning(false)}
          onDone={(msg) => { setAssigning(false); setNotice({ kind: 'info', text: msg }); load(); }}
          onError={(msg) => setNotice({ kind: 'stop', text: msg })}
        />
      )}

      {/* ── filters ─────────────────────────────────────────────────── */}

      <div className="dw-card" style={{ marginBottom: 14 }}>
        <div className="dw-item-body" style={{ paddingTop: 12, paddingBottom: activeFilterCount || showFilters ? undefined : 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button className="dw-btn dw-btn-sm" onClick={() => setShowFilters(v => !v)}
                    aria-expanded={showFilters || activeFilterCount > 0}>
              Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
            </button>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
                    aria-label="Sort" style={{ maxWidth: 220 }}>
              <option value="name">By name</option>
              <option value="gaps">Fewest days logged first</option>
            </select>
            {activeFilterCount > 0 && (
              <button className="dw-btn dw-btn-sm"
                      onClick={() => setFilters({ account: '', anchor: '', activity: '', department: '' })}>
                Clear
              </button>
            )}
            {/* Not the logged count — the header already carries that. This
                says how many rows the filters are actually showing, which is
                the one thing a filter bar owes the reader. */}
            <span className="m" style={{ marginLeft: 'auto' }}>
              {rollup.length} {rollup.length === 1 ? 'person' : 'people'}
            </span>
          </div>
        </div>

        {(showFilters || activeFilterCount > 0) && (
        <div className="dw-item-body" style={{ paddingTop: 4 }}>
          <div className="dw-addgrid">
            <div className="dw-field" style={{ marginTop: 0 }}>
              <label htmlFor="dw-f-account">Account</label>
              <select id="dw-f-account" value={filters.account}
                      onChange={e => setFilters({ ...filters, account: e.target.value, anchor: '' })}>
                <option value="">All accounts</option>
                <option value="internal">Internal projects</option>
                <option value="none">No project or client set</option>
                {accountOptions(anchors).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="dw-field" style={{ marginTop: 0 }}>
              <label htmlFor="dw-f-anchor">Project</label>
              <select id="dw-f-anchor" value={filters.anchor}
                      onChange={e => setFilters({ ...filters, anchor: e.target.value })}>
                <option value="">All projects</option>
                {anchors.filter(a => a.anchor_kind === 'handover').map(a => (
                  <option key={a.anchor_id} value={`handover:${a.anchor_id}`}>{a.label}</option>
                ))}
              </select>
            </div>
            <div className="dw-field" style={{ marginTop: 0 }}>
              <label htmlFor="dw-f-activity">Activity</label>
              <select id="dw-f-activity" value={filters.activity}
                      onChange={e => setFilters({ ...filters, activity: e.target.value })}>
                <option value="">All activities</option>
                {activityTypes.map(t => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="dw-field" style={{ marginTop: 0 }}>
              <label htmlFor="dw-f-dept">Department</label>
              {/* Filters the ENTRY's snapshotted department, not the person's
                  current team — which is why October keeps answering the same
                  thing after someone transfers in November. */}
              <select id="dw-f-dept" value={filters.department}
                      onChange={e => setFilters({ ...filters, department: e.target.value })}>
                <option value="">All departments</option>
                {departments.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>

          </div>
        </div>
        )}
      </div>

      {/* ── account summary, only when one account is chosen ─────────── */}

      {accountSummary && accountSummary.totals.entries > 0 && (
        <div className="dw-banner info">
          <b>{accountSummary.totals.entries} {accountSummary.totals.entries === 1 ? 'entry' : 'entries'}</b>
          {' from '}{accountSummary.totals.people} {accountSummary.totals.people === 1 ? 'person' : 'people'}
          {accountSummary.byActivity.length > 0 && (
            <> · mostly {accountSummary.byActivity[0].activity_key.replace(/_/g, ' ')}</>
          )}
        </div>
      )}

      {/* ── needs attention ─────────────────────────────────────────
          The two queues used to be full sections at the BOTTOM of this screen,
          below every person. As chips they are one glance instead of a scroll,
          and each still opens the list it summarises. The overdue chip is the
          project side, which had no home here before. */}

      {(stalled.length > 0 || candidates.length > 0 || totalOverdue > 0) && (
        <div className="dw-card" style={{ marginBottom: 14 }}>
          <div className="dw-item-body" style={{ paddingTop: 12, display: 'flex',
                                                  flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span className="m">Needs attention</span>
            {stalled.length > 0 && (
              <button className="dw-btn dw-btn-sm" onClick={() => setShowQueue(q => q === 'stalled' ? null : 'stalled')}>
                {stalled.length} {stalled.length === 1 ? 'item' : 'items'} not moving
              </button>
            )}
            {candidates.length > 0 && (
              <button className="dw-btn dw-btn-sm" onClick={() => setShowQueue(q => q === 'vocab' ? null : 'vocab')}>
                {candidates.length} activity {candidates.length === 1 ? 'type' : 'types'} to review
              </button>
            )}
            {totalOverdue > 0 && (
              <button className="dw-btn dw-btn-sm"
                      onClick={() => setShowQueue(q => q === 'overdue' ? null : 'overdue')}>
                {totalOverdue} project {totalOverdue === 1 ? 'task' : 'tasks'} overdue
              </button>
            )}
          </div>
        </div>
      )}

      {showQueue === 'stalled' && stalled.length > 0 && (
        <div className="dw-card" style={{ marginBottom: 14 }}>
          <div className="dw-card-head">
            <h2>Assigned work that isn't moving</h2>
            <span className="m">Assigned items only — recurring work never completes</span>
          </div>
          <div className="dw-daylog">
            {stalled.map(s => (
              <div className="dw-dayrow" key={s.item_id}>
                <div className="dw-work"><b>{s.title}</b> — {s.first_name} {s.last_name}</div>
                <div className="dw-meta">
                  {s.last_entry_date
                    ? `Last entry ${formatDate(s.last_entry_date)}, ${s.days_quiet} days ago`
                    : `Never logged against — opened ${formatDate(s.opened_on)}`}
                  {s.target_date && ` · target ${formatDate(s.target_date)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showQueue === 'vocab' && candidates.length > 0 && (
        <div className="dw-card" style={{ marginBottom: 14 }}>
          <div className="dw-card-head">
            <h2>Activity types waiting on you</h2>
            <span className="m">Someone picked "Other" and named it</span>
          </div>
          <div className="dw-daylog">
            {candidates.map(c => (
              <CandidateRow key={c.key} candidate={c}
                            targets={activityTypes.filter(t => t.status === 'active' && t.key !== c.key)}
                            onPromote={() => promote(c.key)}
                            onMerge={intoKey => merge(c.key, intoKey)} />
            ))}
          </div>
        </div>
      )}

      {showQueue === 'overdue' && (
        <div className="dw-card" style={{ marginBottom: 14 }}>
          <div className="dw-card-head">
            <h2>Project work past its date</h2>
            {/* The count comes from the same place the chip's does — the
                rollup — while the rows come from a separate query. If these
                two numbers ever differ, the two queries have drifted; see the
                lockstep note on getOverdueProjectItemsByUsers. Showing both
                makes that visible instead of silent. */}
            <span className="m">
              {overdue.length} {overdue.length === 1 ? 'item' : 'items'}
              {overdue.length !== totalOverdue && ` (chip says ${totalOverdue})`}
              {' · worst first'}
            </span>
          </div>

          <div className="dw-item-body" style={{ paddingTop: 10 }}>
            <button className="dw-btn dw-btn-sm"
                    onClick={() => { setOverdueOnly(true); setShowQueue(null); }}>
              Show these {overduePeopleIds.size} in the list
            </button>
          </div>

          <div className="dw-daylog">
            {overdue.length === 0 ? (
              <div className="dw-dayrow"><div className="dw-meta">
                Nothing overdue, or the Projects module is off for this org.
              </div></div>
            ) : overdue.map(o => (
              /* The same row the timelines use, so a manager can go straight
                 from the queue to the task and close it out. person is built
                 from the row rather than looked up: the crumb only needs an id
                 and a name to come back to. */
              <ProjectItemRow
                key={o.id} item={o}
                person={{ user_id: o.userId, first_name: nameOf(o.userId), last_name: '' }}
                period={period} anchorDate={anchorDate} filters={apiFilters()}
                who={nameOf(o.userId)}
                onRefuse={(text) => setNotice({ kind: 'warn', text })} />
            ))}
          </div>
        </div>
      )}

      {/* ── the people ──────────────────────────────────────────────── */}

      {rollup.length === 0 ? (
        <div className="dw-card"><div className="dw-empty">
          <p>Nobody reports to you yet, or nobody in your team has the module.</p>
        </div></div>
      ) : (
        <div className="dw-items">
          {overdueOnly && (
            <div className="dw-banner info" style={{ marginBottom: 10 }}>
              Showing only people with overdue project work — {visiblePeople.length} of {rollup.length}.
              <button className="dw-btn dw-btn-sm" style={{ marginLeft: 10 }}
                      onClick={() => setShowQueue('overdue')}>Back to the task list</button>
              <button className="dw-btn dw-btn-sm" style={{ marginLeft: 6 }}
                      onClick={() => setOverdueOnly(false)}>Show everyone</button>
            </div>
          )}
          {/* A filter that hides every row is worse than no filter: the screen
              looks broken and gives no way out. Only reachable if the rows and
              the rollup disagree about who is late, which is exactly when
              someone needs telling. */}
          {overdueOnly && visiblePeople.length === 0 && (
            <div className="dw-card"><div className="dw-empty">
              <p>Nobody in the current list has overdue project work.</p>
            </div></div>
          )}
          {/* Same reasoning as the overdue banner above: a filter that empties
              the screen has to say so and offer the way back, or the page just
              looks broken. */}
          {!overdueOnly && activeFilterCount > 0 && visiblePeople.length === 0 && (
            <div className="dw-card"><div className="dw-empty">
              <p>Nobody logged work matching these filters in this period.</p>
              <button className="dw-btn dw-btn-sm"
                      onClick={() => setFilters({ account: '', anchor: '', activity: '', department: '' })}>
                Clear filters
              </button>
            </div></div>
          )}
          {/* ONE TABLE, one row per person. This was a stack of cards, each
              with a two-line head and a nested block body, so comparing eight
              people meant reading eight paragraphs — and the numbers that
              actually get compared (days logged, entries, overdue) sat in
              badges at different horizontal positions on every card.
              A table puts them in columns.

              The DAY period keeps its own shape below: with one day in range
              there is nothing to roll up, so those rows open the full view
              instead of expanding. */}
          <div className="dw-logtable-wrap">
            <table className="dw-logtable dw-peopletable">
              <colgroup>
                <col style={{ width: '30%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '25%' }} />
                <col style={{ width: '12%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="dw-col-days">{period === 'day' ? 'Logged' : 'Days logged'}</th>
                  <th>Entries</th>
                  <th className="dw-col-work">{period === 'day' ? 'What they logged' : 'Projects'}</th>
                  <th><span className="dw-sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visiblePeople.map(person => (
                  <PersonRow
                    key={person.user_id}
                    person={person}
                    period={period}
                    hasProjects={hasProjects}
                    log={log.filter(l => l.user_id === person.user_id)}
                    expanded={expanded}
                    details={details}
                    onToggle={toggle}
                    onOpenDay={openDay}
                    onOpenPerson={setOpenPerson}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}

/**
 * One person, everything, on one page.
 *
 * THE TIMELINE IS THE POINT. Daily work entries and project tasks arrive as two
 * separate lists, each with its own date, and are interleaved HERE rather than
 * on the server — because the two dates mean different things and the label has
 * to survive the merge. An entry sits on the day it was DONE. A task sits on the
 * day it is DUE. Flattening them server-side into one sorted list would throw
 * away exactly the distinction that makes the screen readable.
 *
 * Tasks with no due date cannot go on the timeline at all — there is no day to
 * put them on and inventing one would be a lie — so they get their own short
 * list underneath, which is also the honest place for them.
 *
 * "Not logged" days are shown, not skipped. Holidays and non-working days never
 * reach the list, so a gap always means a day someone was expected to log and
 * did not. That is the signal the whole module exists to surface.
 */
/**
 * Copy the current URL.
 *
 * Reads window.location at click time rather than holding the URL in state:
 * the effect that writes the hash has already run by the time this is on
 * screen, and re-deriving it here would be a second place for the link to be
 * wrong.
 *
 * The period and the filters are deliberately NOT in the URL, so the recipient
 * gets this person on their own default window rather than the sender's. That
 * is a decision, not an omission — say it, so nobody reports it as a bug.
 *
 * clipboard.writeText is unavailable on an insecure origin and can be refused
 * even on a secure one, so the failure path shows the URL to copy by hand
 * instead of a dead button.
 */
function CopyLinkButton() {
  const [state, setState] = useState('idle');   // 'idle' | 'done' | 'failed'

  const copy = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setState('done');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('failed');
      window.prompt('Copy this link', url);
      setTimeout(() => setState('idle'), 2000);
    }
  };

  return (
    <button className="dw-btn" onClick={copy}
            title="Link to this person. Opens on the recipient's own period and filters.">
      {state === 'done' ? 'Link copied' : 'Copy link'}
    </button>
  );
}

/**
 * The person page's own period control (2026_140).
 *
 * SEPARATE FROM the People screen's Day/Week/Month. That one governs a table of
 * nine people and is about compliance over a fixed span; this one is about one
 * person and has to reach forwards, because half of what is on this page is
 * work that is DUE rather than work that was DONE. A Month button cannot ask
 * "what has he got coming".
 *
 * Offsets rather than named ranges, so "past 7" and "next 7" are the same
 * arithmetic in opposite directions and cannot drift apart.
 */
const PERSON_RANGES = [
  { key: 'past7',   label: 'Past 7 days',  back: 6,  fwd: 0 },
  { key: 'past30',  label: 'Past 30 days', back: 29, fwd: 0 },
  { key: 'next7',   label: 'Next 7 days',  back: 0,  fwd: 6 },
  { key: 'next30',  label: 'Next 30 days', back: 0,  fwd: 29 },
];

function personRange(key) {
  const r = PERSON_RANGES.find(x => x.key === key) || PERSON_RANGES[0];
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const shift = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  return { from: iso(shift(-r.back)), to: iso(shift(r.fwd)) };
}

function PersonPage({ person, range, filters, period, anchorDate, onBack }) {
  const [state, setState] = useState({
    loading: true, log: [], projectItems: [], projects: [],
    assigned: [], assignedOutside: 0, projectItemsOutside: 0,
  });
  // Defaults to the past week: the question someone arrives with is almost
  // always "has this person been logging", and that is backward-looking.
  const [rangeKey, setRangeKey] = useState('past7');
  const [showAll,  setShowAll]  = useState(false);
  // Local rather than the list's notice: that one is rendered in the branch
  // above this component, so it is off-screen whenever a person is open.
  const [linkNotice, setLinkNotice] = useState(null);
  const onRefuse = useCallback((text) => setLinkNotice(text), []);

  const pRange = personRange(rangeKey);

  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true }));
    apiService.dailyWork.person(person.user_id, {
      ...pRange, ...filters, includeClosed: showAll,
    })
      .then(({ data }) => { if (alive) setState({
        loading: false,
        log: data.log || [],
        projectItems: data.projectItems || [],
        projects: data.projects || [],
        assigned: data.assigned || [],
        assignedOutside: data.assignedOutside || 0,
        projectItemsOutside: data.projectItemsOutside || 0,
      }); })
      .catch(() => { if (alive) setState({ loading: false, log: [], projectItems: [],
        projects: [], assigned: [], assignedOutside: 0, projectItemsOutside: 0 }); });
    return () => { alive = false; };
    // pRange is derived from rangeKey, so keying on the key rather than the
    // object avoids a new object identity refetching on every render.
  }, [person.user_id, rangeKey, showAll]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown';
  const { log, projectItems, projects, assigned, assignedOutside, projectItemsOutside } = state;

  // ── Updates logged against each task (2026_140) ───────────────────────────
  //
  // ONE call for every task on screen, not one per row. The table needs a count
  // on every row, and fetching per row is N requests to render one screen with
  // counts popping in one at a time.
  //
  // Keyed off a sorted, joined id string rather than the array: a new array
  // with identical contents is a new dependency on every render, so passing
  // projectItems itself would refetch forever.
  const [updates, setUpdates] = useState({});
  const [openTask, setOpenTask] = useState(null);

  // ── Per-item detail for one logged day (2026_140) ─────────────────────────
  //
  // The day row is an AGGREGATE: getLog groups by (user, entry_date) and does
  // string_agg on the descriptions, so activity, initiative and stage exist
  // only as per-day SETS. A day with three items across two initiatives can
  // honestly say "2 initiatives" and nothing more — which is the aggregation
  // talking, not the data.
  //
  // getDayDetail already returns those three per ITEM, resolved to labels. So
  // the columns go on an expansion rather than on the summary row, where they
  // would be true.
  //
  // Fetched on open, once. Most rows are never expanded, and pulling every
  // item for every day to serve the few that are is what makes a screen fine
  // at one week and unusable at thirty days.
  const [openDayKey, setOpenDayKey] = useState(null);
  const [dayDetail, setDayDetail] = useState({});

  const toggleDay = async (dateStr) => {
    const isOpen = openDayKey === dateStr;
    setOpenDayKey(isOpen ? null : dateStr);
    if (isOpen || dayDetail[dateStr]) return;
    if (typeof apiService.dailyWork?.teamDayDetail !== 'function') return;
    try {
      const { data } = await apiService.dailyWork.teamDayDetail({
        user: person.user_id, date: dateStr, ...filters });
      setDayDetail(d => ({ ...d, [dateStr]: data || [] }));
    } catch {
      // The summary row stays. Failing to load the breakdown must not remove
      // the thing it breaks down.
      setDayDetail(d => ({ ...d, [dateStr]: [] }));
    }
  };
  const taskIds = projectItems
    .filter(i => i.kind === 'task' && i.playInstanceId)
    .map(i => i.playInstanceId);
  const taskIdKey = [...taskIds].sort((a, b) => a - b).join(',');

  useEffect(() => {
    if (!taskIdKey) { setUpdates({}); return; }
    if (typeof apiService.dailyWork?.personTaskUpdates !== 'function') return;
    let alive = true;
    apiService.dailyWork.personTaskUpdates(person.user_id, taskIdKey.split(',').map(Number))
      .then(({ data }) => { if (alive) setUpdates(data.byTask || {}); })
      // Silent. Not knowing the counts is a cosmetic loss — every row reads
      // "Updates (0)" — and must not take the task table down with it.
      .catch(() => { if (alive) setUpdates({}); });
    return () => { alive = false; };
  }, [person.user_id, taskIdKey]);

  const overdue = projectItems.filter(i => i.isOverdue).length;

  // ── TWO TABLES, NOT ONE INTERLEAVED TIMELINE (2026_140) ───────────────────
  //
  // This screen used to bucket everything by date: one block per day, project
  // tasks filed on the day they were DUE, daily work on the day it was DONE.
  // That is the right shape on My Day, where somebody is logging today's work
  // against today's tasks and the two genuinely belong on one line.
  //
  // It is the wrong shape here. A manager opens this page asking "what is
  // outstanding?", and interleaving buries three overdue tasks among the days
  // they happened to fall due on — each in its own card, roughly 150px of
  // height for fifteen words. Three items filled the viewport.
  //
  // So: their open work in one table, ordered by how late it is; their daily
  // log in another, ordered by date. Same two tables My Day already uses, which
  // is also why they need no explaining to anyone who has seen that screen.
  //
  // ORDERED BY LATENESS, not by due date. The old cards showed "due 28 Sept,
  // due 22 Sept, due 18 Sept" and left the reader subtracting from today to
  // rank them. Undated work sorts last rather than being exiled to its own
  // card at the bottom — it is open work, and having no date is not a reason
  // to put it somewhere else.
  const taskRows = [...projectItems].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return String(a.title).localeCompare(String(b.title));
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });

  // Every working day in the window, newest first, whether or not anything was
  // logged. The GAPS are the point on a compliance screen — a day with no row
  // at all reads as a day that did not exist.
  const byDate = new Map();
  for (const d of (person.days || [])) byDate.set(d.date, { date: d.date, entries: [] });
  for (const l of log) {
    if (!byDate.has(l.entry_date)) byDate.set(l.entry_date, { date: l.entry_date, entries: [] });
    byDate.get(l.entry_date).entries.push(l);
  }
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="dw">
      <div className="dw-head">
        <div>
          <h1>{name}</h1>
          <div className="dw-sub">
            {person.days_logged} of {person.working_days} days logged
            {person.rate !== null && ` · ${Math.round(person.rate * 100)}%`}
            {!person.has_schedule && ' · no schedule set'}
          </div>
        </div>
        <div className="dw-head-actions">
          <CopyLinkButton />
          <button className="dw-btn" onClick={onBack}>← All people</button>
        </div>
      </div>

      {linkNotice && (
        <div className="dw-banner warn" style={{ marginBottom: 12 }}>
          {linkNotice}
          <button className="dw-btn dw-btn-sm" style={{ marginLeft: 10 }}
                  onClick={() => setLinkNotice(null)}>Dismiss</button>
        </div>
      )}

      {/* ── The two controls (2026_140) ────────────────────────────────────
          Separate rather than one combined dropdown: "when" and "what state"
          are independent questions, and folding them together produces eight
          combinations with names nobody thinks in. */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap',
                    margin: '0 0 14px' }}>
        <div style={{ display: 'inline-flex', border: '0.5px solid var(--dw-line-2)',
                      borderRadius: 8, overflow: 'hidden' }}>
          {PERSON_RANGES.map(r => (
            <button key={r.key} type="button"
                    onClick={() => setRangeKey(r.key)}
                    aria-pressed={rangeKey === r.key}
                    style={{ padding: '5px 11px', fontSize: 12, border: 'none',
                             cursor: 'pointer', fontFamily: 'inherit',
                             background: rangeKey === r.key ? '#0f2f4a' : 'transparent',
                             color: rangeKey === r.key ? '#fff' : 'inherit' }}>
              {r.label}
            </button>
          ))}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={showAll}
                 onChange={e => setShowAll(e.target.checked)} />
          {/* "and dropped" is spelled out. A dropped item is a fact a manager
              wants, and rolling it silently under the word "submitted" would
              make abandoned work indistinguishable from work never started. */}
          Show all work submitted (completed and dropped)
        </label>
      </div>

      {projects.length > 0 && (
        <div className="dw-card" style={{ marginBottom: 14 }}>
          <div className="dw-card-head">
            <h2>Projects and initiatives</h2>
            {overdue > 0 && <span className="m">{overdue} overdue</span>}
          </div>
          <div className="dw-item-body" style={{ paddingTop: 10 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {projects.map(p => (
                <span className="dw-badge" key={p.handoverId} title={p.account || ''}>
                  {p.project}
                  {/* The label: without it a standing initiative and a project
                      read as the same thing, and "no end date" looks like
                      missing data rather than the whole point of it. */}
                  {p.isStanding ? ' · standing' : (p.goLiveDate ? ` · ${formatDate(p.goLiveDate)}` : '')}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {state.loading ? (
        <div className="dw-spinner">Loading…</div>
      ) : (
        <>
          <div className="dw-card">
            <div className="dw-card-head">
              <h2>Their daily log</h2>
              <span className="m">Every working day in this period</span>
            </div>
            {days.length === 0 ? (
              <div className="dw-empty"><p>Nothing in this period.</p></div>
            ) : (
              <table className="dw-logtable">
                <colgroup>
                  <col style={{ width: '16%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '61%' }} />
                  <col style={{ width: '10%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Date</th><th>Item</th><th>What was done</th>
                    <th><span className="dw-sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {days.map(d => {
                    const e = d.entries[0];
                    const count = d.entries.reduce((n, x) => n + (x.item_count || 0), 0);
                    const isOpen = openDayKey === d.date;
                    const rows = dayDetail[d.date];
                    return (
                      <React.Fragment key={d.date}>
                        <tr>
                          <td className="dw-logdate">{formatDate(d.date)}</td>
                          <td className="dw-logitem muted">
                            {e ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Not logged'}
                          </td>
                          <td className="dw-logwork">
                            {e
                              ? d.entries.map(x => x.work_done).filter(Boolean).join(' ')
                              : <span className="dw-none">—</span>}
                          </td>
                          <td className="dw-logactions">
                            {/* Only on days that HAVE something. A day nobody
                                logged has no items to break down, and a control
                                that opens an empty panel is worse than none. */}
                            {e && (
                              <button type="button" className="dw-btn-link"
                                      aria-expanded={isOpen}
                                      onClick={() => toggleDay(d.date)}>
                                {isOpen ? 'Hide' : 'Details'}
                              </button>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="dw-person-detail">
                            <td colSpan={4}>
                              {rows === undefined ? (
                                <div className="dw-meta">Loading…</div>
                              ) : rows.length === 0 ? (
                                <div className="dw-meta">No items to show for this day.</div>
                              ) : (
                                <table className="dw-logtable dw-daytable">
                                  <colgroup>
                                    <col style={{ width: '26%' }} />
                                    <col style={{ width: '32%' }} />
                                    <col style={{ width: '14%' }} />
                                    <col style={{ width: '16%' }} />
                                    <col style={{ width: '12%' }} />
                                  </colgroup>
                                  <thead>
                                    <tr>
                                      <th>Item</th><th>What was done</th>
                                      <th>Activity</th><th>Initiative</th><th>Stage</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rows.map(r => (
                                      <tr key={r.entry_id}>
                                        <td className="dw-logwork"><b>{r.title}</b></td>
                                        <td className="dw-logwork">{r.description}</td>
                                        {/* The LABELS, not the keys. getDayDetail
                                            resolves activity_type_key and
                                            anchor_kind/id to words server-side —
                                            the row also carries the raw keys, and
                                            rendering those would print
                                            'linkedin_outreach' at a manager. */}
                                        <td className="dw-logitem muted">
                                          {r.activity_label || <span className="dw-none">—</span>}
                                        </td>
                                        <td className="dw-logitem muted">
                                          {r.anchor_label || <span className="dw-none">—</span>}
                                        </td>
                                        <td className="dw-logitem muted">
                                          {String(r.day_stage || '').replace(/_/g, ' ')
                                            || <span className="dw-none">—</span>}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="dw-card" style={{ marginTop: 14 }}>
            <div className="dw-card-head">
              <h2>Assigned to them</h2>
              <span className="m">
                {assigned.length} {assigned.length === 1 ? 'item' : 'items'}
                {showAll ? ' · including completed and dropped' : ''}
              </span>
            </div>
            {assigned.length === 0 ? (
              <div className="dw-empty"><p>Nothing assigned in this period.</p></div>
            ) : (
              <table className="dw-logtable dw-tasktable">
                <colgroup>
                  <col style={{ width: '38%' }} />
                  <col style={{ width: '20%' }} />
                  <col style={{ width: '16%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '12%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Item</th><th>Assigned by</th><th>Target</th>
                    <th>Status</th><th>Last logged</th>
                  </tr>
                </thead>
                <tbody>
                  {assigned.map(a => (
                    <tr key={a.id}>
                      <td className="dw-logwork">
                        <b>{a.title}</b>
                        {/* chk_dwi_linked_is_assigned restricts play_instance_id
                            to assigned items, so this is the only place the
                            project link can surface. Marked rather than
                            duplicated as a row in the project table below. */}
                        {a.playInstanceId && (
                          <span className="dw-badge" style={{ marginLeft: 6 }}>on a project task</span>
                        )}
                      </td>
                      <td className="dw-logitem muted">{a.assignedByName || '—'}</td>
                      <td>
                        {a.targetDate
                          ? <span className="dw-badge">{formatDate(a.targetDate)}</span>
                          : <span className="dw-meta">no date</span>}
                      </td>
                      <td className="dw-logitem muted">
                        {String(a.status || '').replace(/_/g, ' ')}
                      </td>
                      <td className="dw-logitem muted">
                        {/* Never logged is the state that matters most here: an
                            item nobody has touched is exactly what this table
                            was added to make visible. */}
                        {a.lastEntryDate
                          ? formatDate(a.lastEntryDate)
                          : <span className="dw-none">never</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {assignedOutside > 0 && (
              <div className="dw-meta" style={{ padding: '8px 14px 10px' }}>
                {assignedOutside} more open outside this period.
              </div>
            )}
          </div>

          <div className="dw-card" style={{ marginTop: 14 }}>
            <div className="dw-card-head">
              <h2>Their project work</h2>
              <span className="m">
                {taskRows.length} open{overdue > 0 ? ` · ${overdue} overdue` : ''}
              </span>
            </div>
            {taskRows.length === 0 ? (
              <div className="dw-empty"><p>No open project work.</p></div>
            ) : (
              <table className="dw-logtable dw-tasktable">
                <colgroup>
                  <col style={{ width: '38%' }} />
                  <col style={{ width: '24%' }} />
                  <col style={{ width: '17%' }} />
                  <col style={{ width: '21%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Project</th>
                    <th>Due</th>
                    <th><span className="dw-sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {taskRows.map(i => {
                    const u = updates[String(i.playInstanceId)] || { updates: [], total: 0 };
                    const isOpen = openTask === i.id;
                    return (
                      <React.Fragment key={i.id}>
                        <tr>
                          <td className="dw-logwork"><b>{i.title}</b></td>
                          <td className="dw-logitem muted">
                            {i.project}{i.isStanding ? ' · standing' : ''}
                          </td>
                          <td>
                            {/* dueText already computes "6 days late" / "due in
                                5 days". The cards showed the raw date and left
                                the reader subtracting from today to rank three
                                overdue tasks. */}
                            {i.dueDate
                              ? <span className={`dw-badge ${i.isOverdue ? 'carried' : ''}`}>
                                  {dueText(i, null)}
                                </span>
                              : <span className="dw-meta">no date</span>}
                            {i.kind === 'commitment' && <span className="dw-badge">commitment</span>}
                          </td>
                          <td className="dw-logactions">
                            <ProjectItemRow item={i} person={person} period={period}
                                            anchorDate={anchorDate} filters={filters}
                                            onRefuse={onRefuse} variant="link" />
                            {i.kind === 'task' && i.playInstanceId && (
                              <button type="button" className="dw-btn-link"
                                      aria-expanded={isOpen}
                                      onClick={() => setOpenTask(isOpen ? null : i.id)}>
                                {isOpen ? 'Hide' : 'Updates'} ({u.total})
                              </button>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="dw-person-detail">
                            <td colSpan={4}>
                              {u.updates.length === 0 ? (
                                <div className="dw-meta">
                                  Nothing logged against this task yet.
                                </div>
                              ) : (
                                <>
                                  <div className="dw-meta" style={{ marginBottom: 6 }}>
                                    Work logged against this task
                                  </div>
                                  {u.updates.map(x => (
                                    <div className="dw-taskupdate" key={x.entryId}>
                                      <div className="dw-meta">{formatDate(x.date)}</div>
                                      <div className="dw-work">{x.description}</div>
                                    </div>
                                  ))}
                                  {/* The count is the truth; the list is capped.
                                      Saying so beats a row that reads 34 and
                                      opens onto 20 with no explanation. */}
                                  {u.total > u.updates.length && (
                                    <div className="dw-meta" style={{ marginTop: 6 }}>
                                      Showing the {u.updates.length} most recent of {u.total}.
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
            {projectItemsOutside > 0 && (
              <div className="dw-meta" style={{ padding: '8px 14px 10px' }}>
                {projectItemsOutside} more open outside this period.
              </div>
            )}
          </div>

        </>
      )}

    </div>
  );
}

/* ── one person ─────────────────────────────────────────────────────── */

/**
 * The project side of one person's work, inside the daily work module.
 *
 * WHY THIS IS HERE AND NOT A MERGE. The complaint was having to move between
 * two modules to see one person's work. The answer is not to merge them: most
 * daily work has no project at all — outreach, list updates, research — so a
 * project-shaped home would make the common case homeless. Each module keeps
 * its own axis; this is the small amount daily work borrows so it stops being
 * a dead end.
 *
 * Loaded lazily, only when the row is expanded, and only once. A team view is
 * one row per person and fetching this for everybody up front would be N
 * requests for panels most people never open.
 *
 * A 404 means the Projects module is off for this org. That is not an error
 * worth showing — the panel simply does not exist here.
 */
function PersonProjectPanel({ userId }) {
  const [state, setState] = useState({ loading: true, data: null, unavailable: false });

  useEffect(() => {
    let alive = true;
    apiService.dailyWork.personProjectSummary(userId)
      .then(r => { if (alive) setState({ loading: false, data: r.data, unavailable: false }); })
      .catch(e => {
        if (!alive) return;
        setState({ loading: false, data: null, unavailable: e?.response?.status === 404 });
      });
    return () => { alive = false; };
  }, [userId]);

  if (state.unavailable) return null;
  if (state.loading) {
    return <div className="dw-item-status" style={{ paddingTop: 8 }}>Loading projects…</div>;
  }
  const projects    = state.data?.projects || [];
  const commitments = state.data?.commitments || [];
  if (projects.length === 0 && commitments.length === 0) return null;

  return (
    <div className="dw-detail-item" style={{ borderTop: '1px solid #e5e7eb', marginTop: 8, paddingTop: 10 }}>
      <div className="t"><b>Projects and initiatives</b></div>

      {projects.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 2px' }}>
          {projects.map(p => (
            <span key={p.handoverId} className="dw-badge" title={p.account || ''}>
              {p.project}
              {/* The label item 2 was about: without it a standing initiative
                  and a time-boxed project read as the same kind of thing, and
                  "no end date" looks like missing data rather than the point. */}
              {p.isStanding ? ' · standing' : (p.goLiveDate ? ` · ${formatDate(p.goLiveDate)}` : '')}
            </span>
          ))}
        </div>
      )}

      {commitments.length > 0 && (
        <>
          <div className="dw-meta" style={{ marginTop: 8 }}><b>Open commitments</b></div>
          {commitments.map(c => (
            <div className="dw-detail-item" key={c.id} style={{ paddingLeft: 12 }}>
              <div className="t">
                <span>{c.description}</span>
                <span className="dw-badge">{c.project}</span>
                {/* Lateness is decided on the server so the two modules cannot
                    disagree about what "overdue" means, and a commitment on a
                    standing initiative is never flagged — same reason the
                    initiative itself never is. */}
                {c.isOverdue && <span className="dw-badge carried">overdue</span>}
              </div>
              {c.dueDate && (
                <div className="dw-meta"><b>Due:</b> {formatDate(c.dueDate)}</div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** Initials, from whatever name parts exist. Two letters, never more. */
function initialsOf(person) {
  const a = (person.first_name || '').trim()[0] || '';
  const b = (person.last_name || '').trim()[0] || '';
  return (a + b).toUpperCase() || '?';
}

/**
 * Who this is and how they are doing — the line that was missing.
 *
 * The trailing record rather than the viewed window: on the day tab the window
 * rate is "0 of 1 days" for everyone, which is true and tells you nothing. What
 * answers "is this person keeping up" is their last few weeks, and that has to
 * stay legible while you are reading a single day.
 */
function PersonIdentity({ person }) {
  const t = person.trailing_rate;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <div aria-hidden="true" style={{
        width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
        background: '#ede9fe', color: '#5b21b6', fontSize: 12, fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{initialsOf(person)}</div>
      <div style={{ minWidth: 0 }}>
        <div className="dw-item-title" style={{ margin: 0 }}>
          {`${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown'}
        </div>
        {/* Department dropped from the line. It repeats for everyone in a team,
            so it added a column's worth of width to every row while telling you
            nothing that distinguishes one person from the next — and the
            department FILTER above is still there for when it does matter. */}
        <div className="dw-meta" style={{ margin: 0 }}>
          {/* The trailing window is the LAST 28 DAYS (routes: addDays(win.to,
              -27)), not the period on screen. Unlabelled, it printed "0 of 19
              days" directly above the strip's "0 of 21 this month" — two
              different denominators for what looked like the same measure. */}
          {person.trailing_working_days
            ? `${person.trailing_days_logged} of ${person.trailing_working_days} · last 4 weeks`
            : 'no working days in range'}
          {t !== null && t !== undefined && ` · ${Math.round(t * 100)}%`}
        </div>
      </div>
    </div>
  );
}

// onOpenPerson is gone with the "Open full view" button it drove. The person
// page itself is not dead — setOpenPerson still runs from the hash route, which
// is what Copy link produces — but it is no longer reachable by clicking a row.
// Left unused it would be a no-unused-vars warning, and CRA builds with CI=true
// where a warning fails the build.
function PersonRow({ person, period, hasProjects = false, log, expanded, details,
                     onToggle, onOpenDay, onOpenPerson }) {
  const key = `p:${person.user_id}`;
  const isOpen = !!expanded[key];

  // A day period is already one row per person; there is nothing to roll up, so
  // the row opens the full view rather than expanding.
  if (period === 'day') {
    const today = log[0];
    // With one day in range there is no per-day list to open — the expansion
    // goes straight to that day's ITEMS, which is the only detail left. Same
    // fetch-on-demand as the week and month periods; a person who logged
    // nothing has nothing to expand into, so they get no control rather than
    // one that opens an empty panel.
    const dayKey = today ? `${person.user_id}:${today.entry_date}` : null;
    const dayOpen = !!(dayKey && expanded[dayKey]);
    return (
      <>
        <tr className={`dw-person-row ${dayOpen ? 'dw-open' : ''}`}>
          <td>
            {/* The NAME opens the person page (2026_140). It previously opened
                that day's items — but the actions cell already carries a
                Details link that does exactly that, so the row had two controls
                doing one thing and no control for the thing people actually
                came for.

                Rendered as a button even when there is nothing logged: the
                person page is worth opening precisely when somebody has logged
                nothing, which is the case the old code left with no control at
                all. */}
            <button type="button" className="dw-person-toggle dw-person-link"
                    title="Open this person's full view"
                    onClick={() => onOpenPerson && onOpenPerson(person)}>
              <PersonIdentity person={person} />
            </button>
          </td>
          <td className="dw-col-days">
            <span className={`dw-badge ${today ? '' : 'carried'}`}>
              {today ? `${today.item_count} logged` : 'not yet'}
            </span>
          </td>
          <td>{today ? today.item_count : 0}</td>
          <td className="dw-col-work">
            {/* The clamp goes on an inner div: .dw-clamp sets display:-webkit-box
                and a cell whose display is overridden drops out of the table
                layout entirely. */}
            {today ? <div className={dayOpen ? '' : 'dw-clamp'}>{today.work_done}</div>
                   : <span className="dw-none">Not logged yet.</span>}
          </td>
          <td className="dw-logactions">
            {hasProjects && person.overdueTasks > 0 && (
              <span className="dw-badge carried">{person.overdueTasks} overdue</span>
            )}
            {today && (
              <button type="button" className="dw-btn-link" aria-expanded={dayOpen}
                      onClick={() => onOpenDay(person.user_id, today.entry_date)}>
                {dayOpen ? 'Hide' : 'Details'}
              </button>
            )}
          </td>
        </tr>

        {dayOpen && (
          <tr className="dw-person-detail">
            <td colSpan={5}>
              {/* THE SAME TABLE the week and month periods use, minus the day
                  rows — with one day in range there is nothing to list above
                  the items. Switching shape between periods meant the detail
                  you get depended on which button was pressed, and the columns
                  moved underneath you.

                  undefined and [] mean different things: openDay caches under
                  the key only once the fetch resolves, so undefined is "still
                  loading" and an empty array is "loaded, and there was
                  nothing". Collapsing them with `|| []` would assert nothing
                  was logged during every fetch. */}
              {details[dayKey] === undefined ? (
                <div className="dw-item-status">Loading…</div>
              ) : details[dayKey].length === 0 ? (
                <div className="dw-item-status">No items recorded for that day.</div>
              ) : (
                <table className="dw-logtable dw-daytable">
                  <colgroup>
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '31%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '8%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Item</th>
                      <th>What was done</th>
                      <th className="dw-col-activity">Activity</th>
                      <th className="dw-col-initiative">Initiative</th>
                      <th><span className="dw-sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {details[dayKey].map(item => (
                      <tr key={item.entry_id}>
                        <td className="dw-logdate">{formatDate(today.entry_date)}</td>
                        <td className="dw-logitem">
                          {item.title}
                          <span className="dw-badge">{item.day_stage.replace(/_/g, ' ')}</span>
                          {item.evidence_count > 0
                            ? <span className="dw-badge">{item.evidence_count} evidence</span>
                            : ['completed', 'dropped'].includes(item.day_stage)
                              && <span className="dw-badge carried">unverified</span>}
                        </td>
                        <td>
                          {item.description}
                          {item.next_steps && (
                            <div className="dw-meta"><b>Next:</b> {item.next_steps}</div>
                          )}
                        </td>
                        <td className="dw-col-activity dw-meta">{item.activity_label || '—'}</td>
                        <td className="dw-col-initiative dw-meta">
                          {item.anchor_label || item.account_name || '—'}
                        </td>
                        <td className="dw-logactions" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </td>
          </tr>
        )}
      </>
    );
  }

  return (
    <>
      <tr className={`dw-person-row ${isOpen ? 'dw-open' : ''}`}>
        <td>
          {/* The name opens the person page; the Days link at the end of the
              row still expands in place (2026_140).

              They both used to call onToggle, so the row offered the same
              action twice and the person page — which has existed since it
              shipped and renders the full timeline, logged work interleaved
              with project tasks on the day they are due — was reachable ONLY by
              typing its URL. That was carried as an open item across three
              handoffs. This is the click-through. */}
          <button type="button" className="dw-person-toggle dw-person-link"
                  title="Open this person's full view"
                  onClick={() => onOpenPerson && onOpenPerson(person)}>
            <PersonIdentity person={person} />
          </button>
        </td>
        <td className="dw-col-days">
          <DayStrip days={person.days} />
          <div className="dw-meta">
            {person.days_logged} of {person.working_days} this {period}
          </div>
          {!person.has_schedule && <span className="dw-badge carried">no schedule set</span>}
        </td>
        <td>
          {person.entry_count}
          {/* 2026_140. account_count, not account_ids.length. The server now
              sends the number instead of the array — only the count was ever
              read here. `?? (person.account_ids || []).length` keeps this
              rendering correctly against a backend that has not shipped yet,
              rather than showing nothing during a staged deploy. */}
          {(person.account_count ?? (person.account_ids || []).length) > 0 && (
            <div className="dw-meta">
              {person.account_count ?? (person.account_ids || []).length} accounts
            </div>
          )}
        </td>
        <td className="dw-col-work">
          {/* Hidden entirely when the org has no Projects module — a zero would
              read as "nothing assigned", a different and wrong claim from "we
              cannot see". */}
          {hasProjects ? (
            <>
              {person.openTasks > 0 && (
                <span className="dw-badge">{person.openTasks} {person.openTasks === 1 ? 'task' : 'tasks'}</span>
              )}
              {person.overdueTasks > 0 && (
                <span className="dw-badge carried">{person.overdueTasks} overdue</span>
              )}
              {!person.openTasks && !person.overdueTasks && <span className="dw-meta">—</span>}
            </>
          ) : <span className="dw-meta">—</span>}
        </td>
        <td className="dw-logactions">
          {/* aria-expanded moved here from the name in 2026_140, following the
              behaviour. Leaving it on the name would have told a screen reader
              that the name expands a region when it now navigates instead —
              which is worse than having no state at all. */}
          <button type="button" className="dw-btn-link" aria-expanded={isOpen}
                  onClick={() => onToggle(key)}>
            {isOpen ? 'Hide' : 'Days'}
          </button>
        </td>
      </tr>

      {isOpen && (
        <tr className="dw-person-detail">
          <td colSpan={5}>

            {log.length === 0 ? (
              <div className="dw-item-status">Nothing logged in this period.</div>
            ) : (
              /* ONE ROW PER LOGGED DAY, which is what the person row expands
                 into. The day's descriptions arrive already joined by the
                 rollup, so the row shows that concatenation; the per-item
                 breakdown is a further expansion, fetched only when asked
                 for — openDay is a request, not something to fire for every
                 day of every person on screen. */
              <table className="dw-logtable dw-daytable">
                <colgroup>
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '31%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '8%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Item</th>
                    <th>What was done</th>
                    <th className="dw-col-activity">Activity</th>
                    <th className="dw-col-initiative">Initiative</th>
                    <th><span className="dw-sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {log.map(d => {
                    const dayKey = `${person.user_id}:${d.entry_date}`;
                    const dayOpen = !!expanded[dayKey];
                    return (
                      <React.Fragment key={d.entry_date}>
                        <tr>
                          <td className="dw-logdate">{formatDate(d.entry_date)}</td>
                          <td className="dw-logitem muted">
                            {d.item_count} {d.item_count === 1 ? 'item' : 'items'}
                          </td>
                          <td>
                            <div className={dayOpen ? '' : 'dw-clamp'}>{d.work_done}</div>
                          </td>
                          {/* Empty on the day row: a day rolls up items that may
                              carry different activities and initiatives, so there
                              is no one value to print. */}
                          <td className="dw-col-activity" />
                          <td className="dw-col-initiative" />
                          <td className="dw-logactions">
                            <button className="dw-btn-link"
                                    onClick={() => onOpenDay(person.user_id, d.entry_date)}>
                              {dayOpen ? 'Hide' : 'Details'}
                            </button>
                          </td>
                        </tr>
                        {dayOpen && (details[dayKey] || []).map(item => (
                          <tr className="dw-item-detail" key={item.entry_id}>
                            <td />
                            <td className="dw-logitem">
                              {item.title}
                              <span className="dw-badge">{item.day_stage.replace(/_/g, ' ')}</span>
                              {item.evidence_count > 0
                                ? <span className="dw-badge">{item.evidence_count} evidence</span>
                                : ['completed', 'dropped'].includes(item.day_stage)
                                  && <span className="dw-badge carried">unverified</span>}
                            </td>
                            <td>
                              {item.description}
                              {item.next_steps && (
                                <div className="dw-meta"><b>Next:</b> {item.next_steps}</div>
                              )}
                            </td>
                            <td className="dw-col-activity dw-meta">{item.activity_label || '—'}</td>
                            <td className="dw-col-initiative dw-meta">
                              {item.anchor_label || item.account_name || '—'}
                            </td>
                            <td className="dw-logactions" />
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}

            <PersonProjectPanel userId={person.user_id} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * One square per working day. Holidays and approved leave are not in the list
 * at all, so an empty square always means a day someone was expected to log and
 * did not — never a weekend or a holiday being counted against them.
 */
/**
 * The strip of working days for one person over the period.
 *
 * ── A DAY THAT HAS NOT HAPPENED IS NOT A MISSED DAY ──────────────────
 *
 * Every cell used to be either green or red, which meant that opening the
 * MONTH view on the 3rd painted eighteen red squares per person for days that
 * are still in the future. Eight people, and the screen read as a team in
 * total collapse when in fact almost nothing was yet due. The one question
 * this screen exists to answer — who is drifting — was drowned by it.
 *
 * Three states, not two: logged, missed (a working day in the past with
 * nothing on it), and not yet (today onwards). Today counts as still open —
 * somebody logging at 6pm has not missed anything at 10am.
 *
 * ── AND IT HAS TO WRAP ───────────────────────────────────────────────
 *
 * .dw-logtable is table-layout: fixed and the days column is a 20% <col>, so
 * a strip wider than that column does not widen it — it OVERFLOWS, which is
 * why a 21-day month ran underneath the Entries heading and left the entry
 * count sitting under the squares. Fixed layout gives no slack, so the strip
 * must fit: smaller cells, and wrapping when even those do not.
 */
function DayStrip({ days }) {
  if (!days || !days.length) return null;

  // Local today, not the server's. Every other date in Daily Work is
  // owner-local, and for a team at UTC+5:30 a UTC "today" is the previous day
  // for the first five and a half hours of every morning — which would paint
  // today's cell as missed before anyone had started.
  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;

  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 2, maxWidth: '100%' }}>
      {days.map(d => {
        // The date may arrive as a bare date or a timestamp depending on how
        // the driver serialises a DATE column. Compare the calendar day only.
        const date   = String(d.date).slice(0, 10);
        const future = date > today;
        const state  = d.logged ? 'logged' : future ? 'future' : 'missed';
        const skin = {
          logged: { background: '#dcfce7', border: '#86efac' },
          missed: { background: '#fee2e2', border: '#fca5a5' },
          future: { background: '#fff',    border: '#e5e7eb' },
        }[state];
        return (
          <span
            key={d.date}
            title={`${date} — ${d.logged ? 'logged' : future ? 'not yet' : 'not logged'}`}
            style={{
              width: 12, height: 12, borderRadius: 3, display: 'inline-block',
              flexShrink: 0,
              background: skin.background,
              border: `1px solid ${skin.border}`,
            }}
          />
        );
      })}
    </span>
  );
}

/**
 * Hand work to someone.
 *
 * The kind choice is the important control, and it is not a formality — the two
 * kinds are measured differently and cannot be swapped later without rewriting
 * what the reports mean:
 *
 *   one-off   completes once. Its stage lives on the item, and it appears in
 *             "assigned work that isn't moving" when nothing is logged.
 *   standing  never completes. It joins their daily rows every morning and
 *             counts towards days logged, not towards any completion figure.
 *
 * The design originally tied kind to who created it — members made recurring
 * work, managers assigned deliverables. Handing down standing ownership
 * ("LinkedIn posts are yours now") broke that, so the manager chooses.
 *
 * Rendered inline rather than as a fixed modal: on a phone a fixed overlay
 * fights the keyboard, and this form is mostly typing.
 */
function AssignForm({ people, anchors, activityTypes, onCancel, onDone, onError }) {
  const [form, setForm] = useState({
    ownerUserId: '', kind: 'assigned', title: '',
    activityTypeKey: '', anchor: '', targetDate: '',
  });
  const [busy, setBusy] = useState(false);

  const set = patch => setForm(f => ({ ...f, ...patch }));

  const submit = async () => {
    if (!form.ownerUserId) { onError('Choose who it is for.'); return; }
    if (!form.title.trim()) { onError('Say what needs doing.'); return; }

    const [anchorKind, anchorId] = form.anchor ? form.anchor.split(':') : [null, null];
    setBusy(true);
    try {
      const { data } = await apiService.dailyWork.assign({
        ownerUserId: Number(form.ownerUserId),
        kind: form.kind,
        title: form.title.trim(),
        activityTypeKey: form.activityTypeKey || null,
        anchorKind: anchorKind || null,
        anchorId: anchorId ? Number(anchorId) : null,
        // Only one-off work can carry a target date — the database refuses it
        // on recurring work, so the field is not even sent.
        targetDate: form.kind === 'assigned' && form.targetDate ? form.targetDate : null,
      });
      const who = people.find(p => p.user_id === Number(form.ownerUserId));
      const name = who ? `${who.first_name} ${who.last_name}`.trim() : 'them';
      onDone(form.kind === 'assigned'
        ? `Assigned "${data.title}" to ${name}. It is on their list from today.`
        : `"${data.title}" added to ${name}'s standing work. It returns every morning.`);
    } catch (err) {
      onError(err?.response?.data?.error || 'Could not assign that');
    } finally {
      setBusy(false);
    }
  };

  return (
    /* ── Compacted ─────────────────────────────────────────────────────
       Seven full-width stacked blocks became three rows. Nothing was
       removed — the kind explainer moved beside its toggle instead of
       under it, and the four short controls that were on three separate
       rows now share one auto-fitting row. The form is mostly typing,
       and a form you have to scroll to reach the Assign button on is a
       form people abandon. */
    <div className="dw-card dw-assignform" style={{ marginBottom: 14 }}>
      <div className="dw-card-head"><h2>Assign work</h2></div>
      <div className="dw-item-body" style={{ paddingTop: 10 }}>

        <div className="dw-field" style={{ marginTop: 0 }}>
          <div className="dw-kindrow">
            <div className="dw-toggle">
              <button type="button" aria-pressed={form.kind === 'assigned'}
                      onClick={() => set({ kind: 'assigned' })}>One-off deliverable</button>
              <button type="button" aria-pressed={form.kind === 'recurring'}
                      onClick={() => set({ kind: 'recurring', targetDate: '' })}>Standing work</button>
            </div>
            {/* Beside the toggle, not beneath it. The two kinds are measured
                differently and cannot be swapped later, so the explanation
                stays — it just stops costing a row of its own. */}
            <div className="dw-item-status">
              {form.kind === 'assigned'
                ? 'Completes once. Its stage lives on the item, and it shows up as stalled if nothing is logged against it.'
                : 'Never completes — only ever done for today. It joins their rows every morning and counts towards days logged.'}
            </div>
          </div>
        </div>

        <div className="dw-field">
          <label htmlFor="dw-a-title">What needs doing</label>
          <input id="dw-a-title" type="text" value={form.title}
                 placeholder="e.g. Q3 pipeline dashboard"
                 onChange={e => set({ title: e.target.value })} />
        </div>

        <div className="dw-assigngrid">
          <div className="dw-field" style={{ marginTop: 0 }}>
            <label htmlFor="dw-a-who">Assign to</label>
            <select id="dw-a-who" value={form.ownerUserId}
                    onChange={e => set({ ownerUserId: e.target.value })}>
              <option value="">Choose someone</option>
              {people.map(p => (
                <option key={p.user_id} value={p.user_id}>
                  {`${p.first_name || ''} ${p.last_name || ''}`.trim() || `User ${p.user_id}`}
                </option>
              ))}
            </select>
          </div>

          <div className="dw-field" style={{ marginTop: 0 }}>
            <label htmlFor="dw-a-activity">Kind of activity</label>
            <select id="dw-a-activity" value={form.activityTypeKey}
                    onChange={e => set({ activityTypeKey: e.target.value })}>
              <option value="">Not set</option>
              {(activityTypes || []).map(t => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="dw-field" style={{ marginTop: 0 }}>
            <label htmlFor="dw-a-anchor">Project or client</label>
            <select id="dw-a-anchor" value={form.anchor}
                    onChange={e => set({ anchor: e.target.value })}>
              <option value="">Not tied to one</option>
              {groupAnchors(anchors).map(g => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map(o => (
                    <option key={`${o.anchor_kind}:${o.anchor_id}`}
                            value={`${o.anchor_kind}:${o.anchor_id}`}>{o.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Inside the same row rather than on its own. The row auto-fits, so
              it becomes three columns for standing work and four for a
              deliverable without leaving a hole. */}
          {form.kind === 'assigned' && (
            <div className="dw-field" style={{ marginTop: 0 }}>
              <label htmlFor="dw-a-target">Target date</label>
              <input id="dw-a-target" type="date" value={form.targetDate}
                     title="Advisory. It is shown and it sorts the stalled list — it never makes anything overdue and it sends no reminders."
                     onChange={e => set({ targetDate: e.target.value })} />
            </div>
          )}
        </div>

        {form.kind === 'assigned' && (
          /* The advisory wording still has to be SAID — a date field on an
             assignment reads as a deadline unless told otherwise. One line
             under the row instead of a block under the field. */
          <div className="dw-item-status" style={{ marginTop: 8 }}>
            The target date is advisory — it sorts the stalled list, never makes
            anything overdue, and sends no reminders.
          </div>
        )}

        <div className="dw-addform-actions">
          <button className="dw-btn dw-btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Assigning…' : 'Assign'}
          </button>
          <button className="dw-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function CandidateRow({ candidate, targets, onPromote, onMerge }) {
  const [merging, setMerging] = useState(false);
  const [target, setTarget] = useState('');

  return (
    <div className="dw-dayrow">
      <div className="dw-work">
        <b>{candidate.label}</b>
        <span className="dw-meta" style={{ marginLeft: 8 }}>
          from {candidate.first_name} {candidate.last_name}
          {candidate.uses > 0 && ` · used ${candidate.uses} ${candidate.uses === 1 ? 'time' : 'times'}`}
        </span>
      </div>
      {merging ? (
        <div className="dw-addform-actions" style={{ marginTop: 10 }}>
          {/* A dropdown, not a text box. Nobody should have to know that
              "Demo call" is stored as demo_call, and a typo here would fail
              against a key that does not exist. */}
          <select value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">Merge into…</option>
            {(targets || []).map(t => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
          <button className="dw-btn dw-btn-sm dw-btn-primary"
                  onClick={() => onMerge(target)} disabled={!target}>
            Merge
          </button>
          <button className="dw-btn dw-btn-sm" onClick={() => setMerging(false)}>Cancel</button>
        </div>
      ) : (
        <div className="dw-addform-actions" style={{ marginTop: 10 }}>
          <button className="dw-btn dw-btn-sm dw-btn-primary" onClick={onPromote}>
            Add to the list
          </button>
          <button className="dw-btn dw-btn-sm" onClick={() => setMerging(true)}>Merge…</button>
        </div>
      )}
    </div>
  );
}

/* ── helpers ────────────────────────────────────────────────────────── */

const pad = (n, w = 2) => String(n).padStart(w, '0');
const cmpName = (a, b) =>
  `${a.first_name || ''}${a.last_name || ''}`.localeCompare(`${b.first_name || ''}${b.last_name || ''}`);

/** Shift a 'YYYY-MM-DD' string by whole days, staying in calendar space. */
function shiftDate(dateStr, delta) {
  if (!dateStr) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  return shifted.toISOString().slice(0, 10);
}

/** See DailyWorkView: parse the parts, never new Date(str). */
function formatDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short' });
}

function groupAnchors(anchors) {
  const labels = {
    standing: 'Standing initiatives',
    customer_project: 'Customer projects',
    internal_project: 'Internal projects',
    account: 'Accounts',
    campaign: 'Campaigns',
  };
  // Kept identical to DailyWorkView's copy on purpose. This function is
  // duplicated in the two screens rather than shared, so a fix applied to one
  // and not the other means the same picker orders itself differently
  // depending on which screen opened it. See ORDER's rationale there.
  const ORDER = ['campaign', 'internal_project', 'standing', 'customer_project', 'account'];
  const groups = {};
  (anchors || []).forEach(a => { (groups[a.group_key] = groups[a.group_key] || []).push(a); });
  const rank = k => { const i = ORDER.indexOf(k); return i === -1 ? ORDER.length : i; };
  return Object.keys(groups)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map(k => ({ label: labels[k] || k, options: groups[k] }));
}

function accountOptions(anchors) {
  const seen = new Map();
  (anchors || []).forEach(a => {
    if (a.account_id && !seen.has(a.account_id)) {
      seen.set(a.account_id, { id: a.account_id, name: a.account_name || a.label });
    }
  });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
