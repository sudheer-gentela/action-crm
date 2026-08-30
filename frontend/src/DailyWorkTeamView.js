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
  const [filters, setFilters] = useState({ account: '', anchor: '', activity: '' });

  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [rollup, setRollup]   = useState([]);
  const [log, setLog]         = useState([]);
  const [window_, setWindow]  = useState({ from: null, to: null });

  const [anchors, setAnchors]       = useState([]);
  const [activityTypes, setActivityTypes] = useState([]);
  const [stalled, setStalled]       = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [accountSummary, setAccountSummary] = useState(null);

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

      const [rollupRes, logRes] = await Promise.all([
        apiService.dailyWork.teamRollup(params),
        apiService.dailyWork.teamLog(params),
      ]);

      setRollup(rollupRes.data.rows || []);
      setLog(logRes.data.rows || []);
      setWindow({ from: rollupRes.data.from, to: rollupRes.data.to });

      // The anchor follows the server's idea of the window the first time, so
      // "today" means the viewer's local today rather than the browser's.
      if (!anchorDate && rollupRes.data.to) setAnchor(rollupRes.data.to);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load your team');
    } finally {
      setLoading(false);
    }
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [period, anchorDate, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiService.dailyWork.getAnchors().then(({ data }) => setAnchors(data || [])).catch(() => {});
    apiService.dailyWork.stalled().then(({ data }) => setStalled(data || [])).catch(() => {});
    apiService.dailyWork.candidates().then(({ data }) => setCandidates(data || [])).catch(() => {});
    apiService.dailyWork.listActivityTypes()
      .then(({ data }) => setActivityTypes(data || [])).catch(() => {});
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

  return (
    <div className="dw">
      <div className="dw-head">
        <div>
          <h1>My team</h1>
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
        </div>
      </div>

      {notice && <div className={`dw-banner ${notice.kind}`}>{notice.text}</div>}
      {error && <div className="dw-banner stop">{error}</div>}

      {/* ── filters ─────────────────────────────────────────────────── */}

      <div className="dw-card" style={{ marginBottom: 14 }}>
        <div className="dw-item-body" style={{ paddingTop: 14 }}>
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
              <label htmlFor="dw-f-sort">Sort</label>
              <select id="dw-f-sort" value={sortBy} onChange={e => setSortBy(e.target.value)}>
                <option value="name">By name</option>
                <option value="gaps">Fewest days logged first</option>
              </select>
            </div>
          </div>
          {(filters.account || filters.anchor || filters.activity) && (
            <button className="dw-btn dw-btn-sm" style={{ marginTop: 12 }}
                    onClick={() => setFilters({ account: '', anchor: '', activity: '' })}>
              Clear filters
            </button>
          )}
        </div>
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

      {/* ── the team ────────────────────────────────────────────────── */}

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
              log={log.filter(l => l.user_id === person.user_id)}
              expanded={expanded}
              details={details}
              onToggle={toggle}
              onOpenDay={openDay}
            />
          ))}
        </div>
      )}

      {/* ── queues ──────────────────────────────────────────────────── */}

      {stalled.length > 0 && (
        <div className="dw-card" style={{ marginTop: 16 }}>
          <div className="dw-card-head">
            <h2>Assigned work that isn't moving</h2>
            <span className="m">Assigned items only — recurring work never completes</span>
          </div>
          <div className="dw-daylog">
            {stalled.map(s => (
              <div className="dw-dayrow" key={s.item_id}>
                <div className="dw-work">
                  <b>{s.title}</b> — {s.first_name} {s.last_name}
                </div>
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

      {candidates.length > 0 && (
        <div className="dw-card" style={{ marginTop: 16 }}>
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
    </div>
  );
}

/* ── one person ─────────────────────────────────────────────────────── */

function PersonRow({ person, period, log, expanded, details, onToggle, onOpenDay }) {
  const key = `p:${person.user_id}`;
  const isOpen = !!expanded[key];
  const name = `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown';

  // A day period is already one row per person; there is nothing to roll up.
  if (period === 'day') {
    const today = log[0];
    return (
      <div className="dw-item">
        <div className="dw-item-head">
          <div className="dw-item-title">{name}</div>
          {today ? (
            <>
              <div className="dw-work dw-clamp" style={{ marginTop: 8 }}>{today.work_done}</div>
              <div className="dw-item-status">
                {today.item_count} {today.item_count === 1 ? 'item' : 'items'}
                {today.evidence_count > 0 && ` · ${today.evidence_count} evidence`}
              </div>
            </>
          ) : (
            <div className="dw-item-status">
              Not logged. The absence is the signal — there is nothing to clear.
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`dw-item ${isOpen ? 'dw-open' : ''}`}>
      <button className="dw-item-head" onClick={() => onToggle(key)} aria-expanded={isOpen}>
        <div className="dw-item-title">{name}</div>
        <div className="dw-item-badges" style={{ alignItems: 'center' }}>
          <DayStrip days={person.days} />
          <span className="dw-badge">
            {person.days_logged} of {person.working_days} days
          </span>
          {person.rate !== null && (
            <span className={`dw-badge ${person.rate < 0.6 ? 'carried' : ''}`}>
              {Math.round(person.rate * 100)}%
            </span>
          )}
          {!person.has_schedule && (
            <span className="dw-badge carried">no schedule set</span>
          )}
        </div>
        <div className="dw-item-status">
          {person.entry_count} {person.entry_count === 1 ? 'entry' : 'entries'}
          {person.account_ids.length > 0 && ` · ${person.account_ids.length} accounts`}
        </div>
      </button>

      {isOpen && (
        <div className="dw-item-body">
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

function accountOptions(anchors) {
  const seen = new Map();
  (anchors || []).forEach(a => {
    if (a.account_id && !seen.has(a.account_id)) {
      seen.set(a.account_id, { id: a.account_id, name: a.account_name || a.label });
    }
  });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
