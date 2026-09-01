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

  const apiFilters = () => {
    const f = {};
    if (filters.account) f.account = filters.account;
    if (filters.activity) f.activity = filters.activity;
    if (filters.department) f.department = filters.department;
    if (filters.anchor) {
      const [kind, id] = filters.anchor.split(':');
      f.anchorKind = kind; f.anchorId = id;
    }
    return f;
  };

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
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [period, anchorDate, filters]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const activeFilterCount =
    ['account', 'anchor', 'activity', 'department'].filter(k => filters[k]).length;

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
              <span className="dw-badge carried">{totalOverdue} project {totalOverdue === 1 ? 'task' : 'tasks'} overdue</span>
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

      {/* ── the people ──────────────────────────────────────────────── */}

      {rollup.length === 0 ? (
        <div className="dw-card"><div className="dw-empty">
          <p>Nobody reports to you yet, or nobody in your team has the module.</p>
        </div></div>
      ) : (
        <div className="dw-items">
          {sorted.map(person => (
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
              onOpenPerson={() => setOpenPerson(person)}
            />
          ))}
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
 * The return crumb.
 *
 * Written when someone leaves Daily Work for a project, read by HandoverView
 * to offer a way back. Same shape as AgencyView's 'gwc_agency_deeplink':
 * JSON in sessionStorage, plus a CustomEvent for the case where the target
 * view is already mounted.
 *
 * sessionStorage rather than the URL, for three reasons that all point the
 * same way. writeHash uses history.replaceState on purpose — see hashNav.js,
 * "so the Back button keeps meaning leave the app" — so browser Back was
 * never going to bring anyone back here, and the return has to be explicit UI
 * either way. It survives a refresh, which is what someone mid-task needs. And
 * a pasted link must NOT tell the recipient to go back to Priya's day: they
 * were never there, and that crumb would be a lie about their own history.
 *
 * The period and anchor date travel with it because the People screen keeps
 * them in component state, not in the URL, and the module unmounts on tab
 * switch. Without them a manager on Week comes back to Day and has to find
 * their place again, which is the exact friction this is meant to remove.
 */
const RETURN_KEY = 'gwc_dailywork_return';

function writeReturnCrumb(person, period, anchorDate, filters) {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({
      userId:  person.user_id,
      name:    `${person.first_name} ${person.last_name}`.trim(),
      period:  period || null,
      anchor:  anchorDate || null,
      filters: filters || null,
    }));
  } catch { /* private mode, quota — the link still works, just no crumb back */ }
}

/**
 * One project task or commitment on someone's timeline.
 *
 * Checks the link before navigating rather than after. The basis for offering
 * it is derived — this person, in your team, has this task open — and that can
 * lapse between the page loading and the click. Navigating first and
 * discovering it there would dump the manager on a project with no explanation
 * of why they are looking at it.
 *
 * Commitments are NOT linked. They live on the same details tab, but nothing
 * scrolls to a specific one and the derived check keys on project tasks, so a
 * link would land somewhere vague. Left as a plain row until that is built.
 */
function ProjectItemRow({ item, person, period, anchorDate, filters, onRefuse }) {
  const [busy, setBusy] = useState(false);
  const linkable = item.kind === 'task' && !!item.handoverId;

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await apiService.dailyWork.checkProjectLink(person.user_id, item.handoverId);
      writeReturnCrumb(person, period, anchorDate, filters);
      window.dispatchEvent(new CustomEvent('open-project-task', {
        detail: { handoverId: item.handoverId, scope: data.scope, sub: 'details' },
      }));
    } catch (err) {
      // The server's sentence, not ours. It knows which of the several ways
      // the basis can lapse actually happened; a generic "could not open"
      // here would throw that away.
      onRefuse?.(err?.response?.data?.reason
        || 'That project could not be opened just now.');
      setBusy(false);
    }
  };

  const body = (
    <>
      <div className="t">
        <span className={`dw-badge ${item.isOverdue ? 'carried' : ''}`}>
          {item.kind === 'commitment' ? 'commitment due' : 'task due'}
        </span>
        <b>{item.title}</b>
        {item.isOverdue && <span className="dw-badge carried">overdue</span>}
      </div>
      <div className="dw-meta">
        {item.project}{item.isStanding ? ' · standing' : ''}
        {linkable && <> · {busy ? 'opening…' : 'open in Projects'}</>}
      </div>
    </>
  );

  if (!linkable) return <div className="dw-detail-item">{body}</div>;

  // A button, not an anchor: there is no URL to put in href — the destination
  // is decided by the server's scope answer, which arrives after the click.
  // A bare <a> with no href is unreachable by keyboard and announces nothing.
  return (
    <button type="button" className="dw-detail-item" onClick={open} disabled={busy}
            style={{ display: 'block', width: '100%', textAlign: 'left',
                     background: 'none', font: 'inherit', cursor: busy ? 'wait' : 'pointer' }}>
      {body}
    </button>
  );
}

function PersonPage({ person, range, filters, period, anchorDate, onBack }) {
  const [state, setState] = useState({ loading: true, log: [], projectItems: [], projects: [] });
  // Local rather than the list's notice: that one is rendered in the branch
  // above this component, so it is off-screen whenever a person is open.
  const [linkNotice, setLinkNotice] = useState(null);
  const onRefuse = useCallback((text) => setLinkNotice(text), []);

  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true }));
    apiService.dailyWork.person(person.user_id, { ...range, ...filters })
      .then(({ data }) => { if (alive) setState({ loading: false, log: data.log || [],
        projectItems: data.projectItems || [], projects: data.projects || [] }); })
      .catch(() => { if (alive) setState({ loading: false, log: [], projectItems: [], projects: [] }); });
    return () => { alive = false; };
  }, [person.user_id, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown';
  const { log, projectItems, projects } = state;

  const dated   = projectItems.filter(i => i.dueDate);
  const undated = projectItems.filter(i => !i.dueDate);
  const overdue = projectItems.filter(i => i.isOverdue).length;

  // One bucket per working day in the window, newest first, each carrying
  // whatever landed on it from either side.
  const byDate = new Map();
  for (const d of (person.days || [])) byDate.set(d.date, { date: d.date, entries: [], items: [] });
  for (const l of log) {
    if (!byDate.has(l.entry_date)) byDate.set(l.entry_date, { date: l.entry_date, entries: [], items: [] });
    byDate.get(l.entry_date).entries.push(l);
  }
  for (const i of dated) {
    if (!byDate.has(i.dueDate)) byDate.set(i.dueDate, { date: i.dueDate, entries: [], items: [] });
    byDate.get(i.dueDate).items.push(i);
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
        <div className="dw-card">
          <div className="dw-card-head">
            <h2>Timeline</h2>
            <span className="m">Work logged, and project tasks on the day they are due</span>
          </div>
          <div className="dw-daylog">
            {days.length === 0 ? (
              <div className="dw-empty"><p>Nothing in this period.</p></div>
            ) : days.map(d => (
              <div className="dw-dayrow" key={d.date}>
                <div className="dw-meta"><b>{formatDate(d.date)}</b></div>

                {d.entries.map(e => (
                  <div className="dw-detail-item" key={`e-${e.entry_date}-${e.user_id}`}>
                    <div className="t">
                      <span className="dw-badge">logged</span>
                      <span className="m">{e.item_count} {e.item_count === 1 ? 'item' : 'items'}</span>
                    </div>
                    <div className="d">{e.work_done}</div>
                  </div>
                ))}

                {d.items.map(i => (
                  <ProjectItemRow key={i.id} item={i} person={person}
                                  period={period} anchorDate={anchorDate}
                                  filters={filters} onRefuse={onRefuse} />
                ))}

                {d.entries.length === 0 && d.items.length === 0 && (
                  <div className="dw-meta">Not logged</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {undated.length > 0 && (
        <div className="dw-card" style={{ marginTop: 16 }}>
          <div className="dw-card-head">
            <h2>Project work with no date</h2>
            <span className="m">Nothing to place these on, so they sit here rather than on a day</span>
          </div>
          <div className="dw-daylog">
            {undated.map(i => (
              <div className="dw-dayrow" key={i.id}>
                <div className="dw-work"><b>{i.title}</b></div>
                <div className="dw-meta">
                  {i.project}{i.isStanding ? ' · standing initiative' : ''}
                  {i.kind === 'commitment' ? ' · commitment' : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
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
        <div className="dw-meta" style={{ margin: 0 }}>
          {person.department && <>{person.department} · </>}
          {person.trailing_working_days
            ? `${person.trailing_days_logged} of ${person.trailing_working_days} days`
            : 'no working days in range'}
          {t !== null && t !== undefined && ` · ${Math.round(t * 100)}%`}
        </div>
      </div>
    </div>
  );
}

function PersonRow({ person, period, hasProjects = false, log, expanded, details,
                     onToggle, onOpenDay, onOpenPerson }) {
  const key = `p:${person.user_id}`;
  const isOpen = !!expanded[key];
  // The name is rendered by PersonIdentity now, in both branches.

  // A day period is already one row per person; there is nothing to roll up, so
  // the row opens the full view rather than expanding.
  //
  // THE WHOLE ROW IS THE CONTROL. A per-row "Open full view" button cost a line
  // each and turned a list of eight people into a scroll. The row carries who,
  // how they are doing, and what they logged, on two lines.
  if (period === 'day') {
    const today = log[0];
    return (
      <div className="dw-item">
        <button className="dw-item-head" onClick={onOpenPerson}
                style={{ cursor: 'pointer', width: '100%', textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
            <PersonIdentity person={person} />
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {hasProjects && person.openTasks > 0 && (
                <span className="dw-badge">{person.openTasks} {person.openTasks === 1 ? 'task' : 'tasks'}</span>
              )}
              {hasProjects && person.overdueTasks > 0 && (
                <span className="dw-badge carried">{person.overdueTasks} overdue</span>
              )}
              {/* The status pill, so who-logged-today is answerable by scanning
                  one column instead of reading every row's prose. */}
              <span className={`dw-badge ${today ? '' : 'carried'}`}>
                {today ? `${today.item_count} logged` : 'not yet'}
              </span>
            </div>
          </div>
          {today && <div className="dw-work dw-clamp" style={{ marginTop: 8 }}>{today.work_done}</div>}
        </button>
      </div>
    );
  }

  return (
    <div className={`dw-item ${isOpen ? 'dw-open' : ''}`}>
      <button className="dw-item-head" onClick={() => onToggle(key)} aria-expanded={isOpen}>
        <PersonIdentity person={person} />
        <div className="dw-item-badges" style={{ alignItems: 'center' }}>
          <DayStrip days={person.days} />
          {/* This window, not the trailing one the identity line shows. Two
              different questions, so two different numbers, each labelled. */}
          <span className="dw-badge">
            {person.days_logged} of {person.working_days} this {period}
          </span>
          {!person.has_schedule && (
            <span className="dw-badge carried">no schedule set</span>
          )}
          {/* The project half of the row. Hidden entirely when the org has no
              Projects module — a zero would read as "nothing assigned", which
              is a different and wrong claim from "we cannot see". */}
          {hasProjects && person.openTasks > 0 && (
            <span className="dw-badge">{person.openTasks} project {person.openTasks === 1 ? 'task' : 'tasks'}</span>
          )}
          {hasProjects && person.overdueTasks > 0 && (
            <span className="dw-badge carried">{person.overdueTasks} overdue</span>
          )}
        </div>
        <div className="dw-item-status">
          {person.entry_count} {person.entry_count === 1 ? 'entry' : 'entries'}
          {person.account_ids.length > 0 && ` · ${person.account_ids.length} accounts`}
        </div>
      </button>

      {isOpen && (
        <div className="dw-item-body">
          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 8 }}>
            <button className="dw-btn dw-btn-sm" onClick={onOpenPerson}>
              Open full view →
            </button>
          </div>
          {log.length === 0 ? (
            <div className="dw-item-status" style={{ paddingTop: 12 }}>
              Nothing logged in this period.
            </div>
          ) : log.map(d => {
            const dayKey = `${person.user_id}:${d.entry_date}`;
            const dayOpen = !!expanded[dayKey];
            return (
              <div className="dw-detail-item" key={d.entry_date}>
                <div className="t">
                  <b>{formatDate(d.entry_date)}</b>
                  <span className="dw-badge">{d.item_count} {d.item_count === 1 ? 'item' : 'items'}</span>
                  <button className="dw-btn-link" style={{ marginLeft: 'auto' }}
                          onClick={() => onOpenDay(person.user_id, d.entry_date)}>
                    {dayOpen ? 'Hide' : 'Details'}
                  </button>
                </div>
                <div className={`d ${dayOpen ? '' : 'dw-clamp'}`}>{d.work_done}</div>

                {dayOpen && (details[dayKey] || []).map(item => (
                  <div className="dw-detail-item" key={item.entry_id} style={{ paddingLeft: 12 }}>
                    <div className="t">
                      <b>{item.title}</b>
                      <span className="dw-badge">{item.day_stage.replace(/_/g, ' ')}</span>
                      {item.account_name && <span className="dw-badge">{item.account_name}</span>}
                      {item.evidence_count > 0
                        ? <span className="dw-badge">{item.evidence_count} evidence</span>
                        : ['completed', 'dropped'].includes(item.day_stage)
                          && <span className="dw-badge carried">unverified</span>}
                    </div>
                    <div className="d">{item.description}</div>
                    {item.next_steps && (
                      <div className="dw-meta"><b>Next:</b> {item.next_steps}</div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}

          <PersonProjectPanel userId={person.user_id} />
        </div>
      )}
    </div>
  );
}

/**
 * One square per working day. Holidays and approved leave are not in the list
 * at all, so an empty square always means a day someone was expected to log and
 * did not — never a weekend or a holiday being counted against them.
 */
function DayStrip({ days }) {
  if (!days || !days.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {days.map(d => (
        <span
          key={d.date}
          title={`${d.date} — ${d.logged ? 'logged' : 'not logged'}`}
          style={{
            width: 14, height: 14, borderRadius: 3, display: 'inline-block',
            background: d.logged ? '#dcfce7' : '#fee2e2',
            border: `1px solid ${d.logged ? '#86efac' : '#fca5a5'}`,
          }}
        />
      ))}
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
    <div className="dw-card" style={{ marginBottom: 14 }}>
      <div className="dw-card-head"><h2>Assign work</h2></div>
      <div className="dw-item-body" style={{ paddingTop: 14 }}>

        <div className="dw-field" style={{ marginTop: 0 }}>
          <label>Kind of work</label>
          <div className="dw-toggle">
            <button type="button" aria-pressed={form.kind === 'assigned'}
                    onClick={() => set({ kind: 'assigned' })}>One-off deliverable</button>
            <button type="button" aria-pressed={form.kind === 'recurring'}
                    onClick={() => set({ kind: 'recurring', targetDate: '' })}>Standing work</button>
          </div>
          <div className="dw-item-status">
            {form.kind === 'assigned'
              ? 'Completes once. Its stage lives on the item, and it shows up as stalled if nothing is logged against it.'
              : 'Never completes — only ever done for today. It joins their rows every morning and counts towards days logged.'}
          </div>
        </div>

        <div className="dw-field">
          <label htmlFor="dw-a-title">What needs doing</label>
          <input id="dw-a-title" type="text" value={form.title}
                 placeholder="e.g. Q3 pipeline dashboard"
                 onChange={e => set({ title: e.target.value })} />
        </div>

        <div className="dw-addgrid" style={{ marginTop: 14 }}>
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
        </div>

        {form.kind === 'assigned' && (
          <div className="dw-field">
            <label htmlFor="dw-a-target">Target date (optional)</label>
            <input id="dw-a-target" type="date" value={form.targetDate}
                   onChange={e => set({ targetDate: e.target.value })} />
            <div className="dw-item-status">
              Advisory. It is shown and it sorts the stalled list — it never makes
              anything overdue and it sends no reminders.
            </div>
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
  const groups = {};
  (anchors || []).forEach(a => { (groups[a.group_key] = groups[a.group_key] || []).push(a); });
  return Object.keys(groups).map(k => ({ label: labels[k] || k, options: groups[k] }));
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
