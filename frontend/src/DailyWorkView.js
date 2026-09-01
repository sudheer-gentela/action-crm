// DailyWorkView.js
//
// The member surface. Two modes on one screen:
//
//   'log'  — read. One row per DAY, the day's descriptions run together, which
//            is the shape the spreadsheet had and the shape people already know
//            how to read. Opens here.
//   'edit' — write. One card per open work item, one save for the whole day.
//
// The read mode is the default because most visits are "what did I put down
// yesterday", not "let me log today". Making the data-entry form the landing
// page is what made the thing this replaces feel like a chore.
//
// ── Two rules that look like details and are not ─────────────────────
//
// 1. DATES ARE STRINGS, 'YYYY-MM-DD', in both directions. The backend casts
//    every date column to text on purpose: node-postgres parses DATE at local
//    midnight, so a Date object reports the previous day for anyone east of
//    UTC. Never call new Date() on one of these and never send one back.
//
// 2. THE DAY'S DATE IS NEVER SENT WHEN SAVING. The server resolves it from the
//    owner's timezone. Posting it would let a browser pick which day its work
//    counted for, which is the whole integrity of the metric.
//
// ── Why the description is a hard gate ───────────────────────────────
//
// The sheet being replaced contains rows filed with an empty description and a
// title holding five separate pieces of work. The save is refused rather than
// trimmed, and the character counter warns before it blocks, so nobody loses
// what they typed. Never truncate silently: the person cannot tell it happened.

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import { hashSegment, writeHash } from './hashNav';
import { ProjectItemRow } from './dailyWorkProjectLink';
import DailyWorkTeamView from './DailyWorkTeamView';
import DailyWorkSetupView from './DailyWorkSetupView';
import useIsMobile from './useIsMobile';
import './DailyWork.css';

// Who is looking. The team tab and the rate both need it, and the rollup comes
// back keyed by user_id with no indication of which row is yours.
const currentUserId = () => {
  try { return JSON.parse(localStorage.getItem('user') || '{}').id || null; }
  catch { return null; }
};

// Only for deciding whether to OFFER the setup tab. The endpoints behind it are
// guarded by requireRole on the server, which fails closed — this is a UI hint,
// not a permission check, and the view handles a 403 on its own.
const isOrgAdmin = () => {
  try {
    const u = JSON.parse(localStorage.getItem('user') || '{}');
    return ['owner', 'admin'].includes(u.org_role || u.role);
  } catch { return false; }
};

const SOFT_LIMIT = 1000;
const HARD_LIMIT = 2000;

// One vocabulary for item status and day stage — 2026_132 aligned them
// deliberately. Do not reintroduce a second set of words.
const STAGES = [
  { value: 'yet_to_start', label: 'Yet to start' },
  { value: 'in_progress',  label: 'In progress' },
  { value: 'in_review',    label: 'In progress · in review' },
  { value: 'completed',    label: 'Complete' },
  { value: 'dropped',      label: 'Dropped' },
];
const stageLabel = v => (STAGES.find(s => s.value === v) || {}).label || v;

// ── URL hash ──────────────────────────────────────────────────────────
//
//   #/dailywork                  My day
//   #/dailywork/people           the People list
//   #/dailywork/people/<userId>  one person
//   #/dailywork/setup            Setup
//
// Ownership, per hashNav.js: App owns segment 0, THIS view owns segment 1
// (the tab), and DailyWorkTeamView owns segment 2 (the person). Each writes
// only its own segment — a parent that rewrites unconditionally wipes the
// person id on every render.
//
// The URL word is 'people' while the internal state word is still 'team'.
// The screen was renamed and the state was not; the URL is the thing people
// paste into Slack, so it gets the current name and the mapping lives here
// rather than being smeared across the file.
const TAB_FROM_SEGMENT = { people: 'team', setup: 'setup' };
const SEGMENT_FROM_TAB = { team: 'people', setup: 'setup' };

export default function DailyWorkView() {
  const isMobile = useIsMobile(768);

  // 'day' | 'team' | 'setup', restored from the hash so a refresh — or a
  // pasted link — lands where it says it does. Setup is demoted immediately
  // for a non-admin: its tab button would not render, so honouring the hash
  // would leave them on a screen with no way back to the others.
  const [tab, setTab] = useState(() => {
    const t = TAB_FROM_SEGMENT[hashSegment(1)] || 'day';
    return (t === 'setup' && !isOrgAdmin()) ? 'day' : t;
  });
  const [mode, setMode] = useState('log');
  // 'table' | 'cards' for the edit surface. Persisted, because it is a working
  // preference rather than a per-visit choice — someone who wants the grid
  // wants it every morning. Read defensively: a corrupt or absent value falls
  // back to the table, which is the denser of the two and what the screen is
  // for on a wide monitor.
  const [layout, setLayout] = useState(() => {
    try {
      return localStorage.getItem('gw_dailywork_layout') === 'cards' ? 'cards' : 'table';
    } catch { return 'table'; }
  });
  const setLayoutPref = useCallback((next) => {
    setLayout(next);
    try { localStorage.setItem('gw_dailywork_layout', next); } catch { /* private mode */ }
  }, []);
  // Which row has its details panel open in the table. One at a time: the panel
  // spans the full width, so two open at once pushes the rest off screen.
  const [expandedRow, setExpandedRow] = useState(null);
  const [me] = useState(currentUserId);
  const [canSetUp] = useState(isOrgAdmin);
  const [myRate, setMyRate] = useState(null);  // my row from the rollup
  const [hasReports, setHasReports] = useState(false);
  // Whether the rollup that decides hasReports has come back yet. Needed
  // because hasReports starts false and only turns true after a call: without
  // this, a hash-restored People tab would be demoted to My day in the moment
  // between mount and that response, which is every single load.
  const [reportsResolved, setReportsResolved] = useState(false);
  const [history, setHistory] = useState([]);  // person-days before today
  const [candidates, setCandidates] = useState([]);
  const [stalled, setStalled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [day, setDay] = useState(null);          // { entryDate, timezone, rows }
  const [drafts, setDrafts] = useState({});      // itemId -> { description, nextSteps, dayStage }
  const [openItem, setOpenItem] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rowErrors, setRowErrors] = useState({});
  const [notice, setNotice] = useState(null);

  const [anchors, setAnchors] = useState([]);
  const [activityTypes, setActivityTypes] = useState([]);
  const [adding, setAdding] = useState(false);
  const [newItem, setNewItem] = useState({ title: '', activityTypeKey: '', anchor: '' });

  /* ── load ─────────────────────────────────────────────────────────── */

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiService.dailyWork.getDay();
      setDay(data);

      // Seed drafts from whatever is already saved for today. The description
      // is NOT pre-filled from yesterday: prefilling stale text produces a
      // compliant-looking log that says nothing. Yesterday's line is shown
      // above the box with a button to copy it, which is a choice rather than
      // a default.
      const next = {};
      (data.rows || []).forEach(r => {
        next[r.item_id] = {
          description: r.description || '',
          nextSteps:   r.next_steps || '',
          dayStage:    r.day_stage || r.status || 'in_progress',
        };
      });
      setDrafts(next);
      setSaved((data.rows || []).some(r => r.entry_id));
    } catch (err) {
      setError(readError(err, 'Could not load your day'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (mode !== 'edit' || anchors.length) return;
    apiService.dailyWork.getAnchors()
      .then(({ data }) => setAnchors(data || []))
      .catch(() => { /* the picker is optional; work can be logged unanchored */ });
  }, [mode, anchors.length]);

  /**
   * One call, two answers.
   *
   * The rollup is scoped to the viewer plus their manager chain, so:
   *   - the row whose user_id is mine carries my own rate, which §9 makes
   *     self-visible on purpose — nobody should learn their compliance figure
   *     from their manager
   *   - more than one row back means I have reports, which is what decides
   *     whether the team tab exists at all
   *
   * Failing quietly is deliberate: a member whose rollup errors should still be
   * able to log their day. The rate is information, not a gate.
   */
  useEffect(() => {
    apiService.dailyWork.teamRollup({})
      .then(({ data }) => {
        const rows = data.rows || [];
        setHasReports(rows.length > 1);
        setMyRate(rows.find(r => r.user_id === me) || null);
      })
      .catch(() => {})
      // Resolved on BOTH paths. On the error path hasReports stays false, so
      // a hash-restored People tab is demoted — which is the right direction:
      // this call failing is indistinguishable from having no reports, and
      // failing closed matches how orgContext treats the same uncertainty.
      .finally(() => setReportsResolved(true));
  }, [me]);

  // Demote a tab the viewer cannot actually use, once we know. Only after the
  // lookup resolves, and only downward — this never selects a tab, it only
  // gives up on one the hash asked for.
  useEffect(() => {
    if (!reportsResolved) return;
    if (tab === 'team' && !hasReports) setTab('day');
  }, [reportsResolved, hasReports, tab]);

  // Coming back from a project. The tab has to move too — the crumb is only
  // ever written from the People screen, and restoring the person while My day
  // is showing would put them somewhere they cannot see.
  useEffect(() => {
    const onRestore = () => setTab('team');
    window.addEventListener('dailywork-restore', onRestore);
    return () => window.removeEventListener('dailywork-restore', onRestore);
  }, []);

  // Mirror the open tab into segment 1, leaving segment 2 alone.
  //
  // The guard is load-bearing: writeHash truncates at the first empty part, so
  // an unconditional write from here would erase the person id that
  // DailyWorkTeamView just put there. Rewrite only when OUR segment is
  // actually wrong — which on a genuine tab switch is correct, because leaving
  // a stale person id under a different tab would be worse.
  useEffect(() => {
    if (hashSegment(0) !== 'dailywork') return;
    const seg = SEGMENT_FROM_TAB[tab] || null;
    if ((hashSegment(1) || null) === seg) return;
    writeHash(['dailywork', seg]);
  }, [tab]);

  // The last week of my own days, so the log reads as a log rather than as a
  // single row. Same endpoint the manager uses, scoped to myself — it is gated
  // by the module, not by having reports.
  useEffect(() => {
    if (!me) return;
    apiService.dailyWork.teamLog({ users: String(me) })
      .then(({ data }) => setHistory(data.rows || []))
      .catch(() => {});
  }, [me, saved]);

  /**
   * The two queues, from endpoints that mean different things depending on who
   * is asking — which is the point of scoping them by the manager chain rather
   * than by a role flag.
   *
   *   stalled     for a member, their OWN assigned work with nothing logged
   *               against it. For a manager, that plus their reports'.
   *   candidates  every proposed activity type in the org. A member cares about
   *               the ones they proposed; a manager has to decide on all of them.
   *
   * Both fail quietly. A queue that fails to load should not stop someone
   * logging their day.
   */
  useEffect(() => {
    apiService.dailyWork.stalled().then(({ data }) => setStalled(data || [])).catch(() => {});
    apiService.dailyWork.candidates().then(({ data }) => setCandidates(data || [])).catch(() => {});
  }, [saved]);

  const loadActivityTypes = useCallback(() => {
    apiService.dailyWork.listActivityTypes()
      .then(({ data }) => setActivityTypes(data || []))
      .catch(() => {});
  }, []);
  // Refetched on every TAB CHANGE, not once on mount.
  //
  // DEFECT FIXED. Setup is not a separate screen — DailyWorkView renders
  // <DailyWorkSetupView /> as a child and stays mounted the whole time, so
  // this component's state survives the round trip. The effect used to depend
  // on [loadActivityTypes] alone, which is useCallback([]) and therefore
  // stable forever, so the list was fetched once when Daily Work first opened
  // and never again. Rename an activity in Setup, switch back to My day, and
  // the picker still offered the labels from before the rename — with the
  // right KEYS underneath, so picking one worked and simply showed the wrong
  // name. Only a full page reload corrected it.
  //
  // Adding `tab` costs one small GET per tab switch and removes the entire
  // class of staleness: whatever Setup did, coming back re-reads it.
  useEffect(() => { loadActivityTypes(); }, [tab, loadActivityTypes]);

  /**
   * Set an item's activity type.
   *
   * This changes the ITEM, not just today's row, because the activity is what
   * the work IS rather than what happened on one day. Entries already saved
   * keep their own snapshot, so nothing written earlier moves.
   *
   * A label typed into "Other" becomes a candidate type immediately and is used
   * straight away — waiting for a manager to approve a word before you can
   * describe your own day is how people stop bothering.
   */
  const retireItem = async (itemId) => {
    try {
      await apiService.dailyWork.retireItem(itemId);
      setNotice({ kind: 'info', text: "Stopped. It will not be on tomorrow's list." });
      await load();
    } catch (err) {
      setNotice({ kind: 'stop', text: readError(err, 'Could not stop that item') });
    }
  };

  const setItemActivity = async (itemId, value, freeText) => {
    try {
      let key = value;
      if (value === '__other__') {
        if (!freeText || !freeText.trim()) return;
        const { data } = await apiService.dailyWork.proposeActivityType(freeText.trim());
        key = data.key;
        loadActivityTypes();
        if (data.wasMerged) {
          setNotice({ kind: 'info',
            text: `That was merged into "${key}" earlier, so it has been filed there.` });
        }
      }
      await apiService.dailyWork.updateItem(itemId, { activityTypeKey: key || null });
      setDay(d => ({
        ...d,
        rows: d.rows.map(r => r.item_id === itemId ? { ...r, activity_type_key: key || null } : r),
      }));
    } catch (err) {
      setNotice({ kind: 'stop', text: readError(err, 'Could not set the activity') });
    }
  };

  /* ── editing ──────────────────────────────────────────────────────── */

  const setDraft = (itemId, patch) => {
    setDrafts(d => ({ ...d, [itemId]: { ...d[itemId], ...patch } }));
    setRowErrors(e => (e[itemId] ? { ...e, [itemId]: null } : e));
    setSaved(false);
  };

  const save = async () => {
    const rows = day.rows || [];
    const entries = rows
      .map(r => ({ itemId: r.item_id, ...(drafts[r.item_id] || {}) }))
      .filter(e => (e.description || '').trim());

    if (!entries.length) {
      setNotice({ kind: 'stop', text: 'Write something against at least one item first.' });
      return;
    }

    // Check locally before the round trip so the message appears next to the
    // offending box. The server enforces the same rules regardless — this is
    // for speed, not for safety.
    const errs = {};
    entries.forEach(e => {
      if (e.description.length > HARD_LIMIT) {
        errs[e.itemId] = `${e.description.length - HARD_LIMIT} characters too long — trim it, nothing is cut for you`;
      }
    });
    if (Object.keys(errs).length) {
      setRowErrors(errs);
      setOpenItem(Number(Object.keys(errs)[0]));
      setNotice({ kind: 'stop', text: 'Some rows are too long. Nothing was saved or shortened.' });
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      const { data } = await apiService.dailyWork.saveDay(entries);
      setSaved(true);
      setMode('log');
      setNotice({ kind: 'info', text: `Saved ${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'} for ${data.entryDate}.` });
      await load();
    } catch (err) {
      // The server's message is written for the person, so show it as-is:
      // "3 characters too long — trim it, nothing is cut for you".
      const details = err?.response?.data;
      if (details?.details?.itemId) {
        setRowErrors({ [details.details.itemId]: details.error });
        setOpenItem(details.details.itemId);
        setMode('edit');
      }
      setNotice({ kind: 'stop', text: readError(err, 'Could not save your day') });
    } finally {
      setSaving(false);
    }
  };

  const addItem = async () => {
    if (!newItem.title.trim()) {
      setNotice({ kind: 'stop', text: 'Give the item a name first.' });
      return;
    }
    const [anchorKind, anchorId] = newItem.anchor ? newItem.anchor.split(':') : [null, null];
    try {
      await apiService.dailyWork.createItem({
        kind: 'recurring',
        title: newItem.title.trim(),
        activityTypeKey: newItem.activityTypeKey || null,
        anchorKind: anchorKind || null,
        anchorId: anchorId ? Number(anchorId) : null,
      });
      setNewItem({ title: '', activityTypeKey: '', anchor: '' });
      setAdding(false);
      setNotice({ kind: 'info', text: "Added. It will be on tomorrow's list until you mark it complete or dropped." });
      await load();
    } catch (err) {
      setNotice({ kind: 'stop', text: readError(err, 'Could not add that item') });
    }
  };

  /* ── render ───────────────────────────────────────────────────────── */

  if (loading) return <div className="dw"><div className="dw-spinner">Loading your day…</div></div>;

  if (error) {
    return (
      <div className="dw">
        <div className="dw-banner stop">{error}</div>
        <button className="dw-btn" onClick={load}>Try again</button>
      </div>
    );
  }

  const rows = day.rows || [];
  const written = rows.filter(r => (drafts[r.item_id]?.description || '').trim());
  const openRows = rows.filter(r => !['completed', 'dropped', 'retired'].includes(r.status));

  return (
    <div className="dw">
      {(hasReports || canSetUp) && (
        <div className="dw-toggle" style={{ marginBottom: 16 }} role="group" aria-label="Section">
          <button type="button" aria-pressed={tab === 'day'} onClick={() => setTab('day')}>
            My day
          </button>
          {hasReports && (
            <button type="button" aria-pressed={tab === 'team'} onClick={() => setTab('team')}>
              People
            </button>
          )}
          {canSetUp && (
            <button type="button" aria-pressed={tab === 'setup'} onClick={() => setTab('setup')}>
              Setup
            </button>
          )}
        </div>
      )}

      {tab === 'team' ? <DailyWorkTeamView />
       : tab === 'setup' ? <DailyWorkSetupView /> : (
      <>
      <div className="dw-head">
        <div>
          <h1>{formatDate(day.entryDate)}</h1>
          <div className="dw-sub">
            Your local date{day.timezone ? ` · ${day.timezone}` : ''}
            {openRows.length > 0 && ` · ${openRows.length} open ${openRows.length === 1 ? 'item' : 'items'}`}
          </div>
        </div>
        <div className="dw-head-actions">
          {myRate && myRate.working_days > 0 && (
            // Your own figure, before anyone else sees it. null rate means the
            // whole window was holiday — no rate rather than a zero, because
            // zero reads as a failure nobody committed.
            <span className={`dw-rate ${myRate.rate !== null && myRate.rate < 0.6 ? 'low' : ''}`}>
              <span className="dot" />
              Logged <b>{myRate.days_logged}</b> of <b>{myRate.working_days}</b> working days
            </span>
          )}
          <div className="dw-toggle" role="group" aria-label="View or edit">
            <button type="button" aria-pressed={mode === 'log'} onClick={() => setMode('log')}>
              Day view
            </button>
            <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
              Edit rows
            </button>
          </div>
          {mode === 'edit' && !isMobile && (
            // Only in edit mode, and only where a five-column grid fits. On a
            // phone the cards are the layout, so a toggle offering the other
            // one would be a control with no effect.
            <div className="dw-toggle" role="group" aria-label="Layout">
              <button type="button" aria-pressed={layout === 'table'}
                      onClick={() => setLayoutPref('table')}>Table</button>
              <button type="button" aria-pressed={layout === 'cards'}
                      onClick={() => setLayoutPref('cards')}>Cards</button>
            </div>
          )}
          {mode === 'edit' && (
            // On a phone the save lives here rather than in a sticky bottom bar:
            // iOS moves bottom-fixed elements when the keyboard opens.
            <button className="dw-btn dw-btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : "Save today's work"}
            </button>
          )}
        </div>
      </div>

      {notice && <div className={`dw-banner ${notice.kind}`}>{notice.text}</div>}

      <WaitingPanel
        me={me}
        hasReports={hasReports}
        rows={rows}
        drafts={drafts}
        stalled={stalled}
        candidates={candidates}
        onOpenItem={itemId => { setOpenItem(itemId); setMode('edit'); }}
        onOpenTeam={() => setTab('team')}
      />

      <MyProjectWork me={me} />

      {mode === 'log'
        ? <DayLog day={day} rows={rows} written={written} drafts={drafts} saved={saved}
                  history={history.filter(h => h.entry_date !== day.entryDate)}
                  onEdit={itemId => { setOpenItem(itemId); setMode('edit'); }} />
        : (
          <>
            {rows.length === 0 ? (
              <div className="dw-card">
                <div className="dw-empty">
                  <p>
                    You have no work items yet.<br />
                    An item is a piece of ongoing work — you write against it each day,
                    and it stays on your list until you close it.
                  </p>
                  <button className="dw-btn dw-btn-primary" onClick={() => setAdding(true)}>
                    Add your first item
                  </button>
                </div>
              </div>
            ) : (isMobile || layout === 'cards') ? (
              <div className="dw-items">
                {rows.map(row => (
                  <ItemCard
                    key={row.item_id}
                    row={row}
                    draft={drafts[row.item_id] || {}}
                    error={rowErrors[row.item_id]}
                    isOpen={isMobile ? openItem === row.item_id : true}
                    onToggle={() => setOpenItem(openItem === row.item_id ? null : row.item_id)}
                    onChange={patch => setDraft(row.item_id, patch)}
                    onEvidence={load}
                    collapsible={isMobile}
                    activityTypes={activityTypes}
                    onActivity={(value, freeText) => setItemActivity(row.item_id, value, freeText)}
                    onRetire={retireItem}
                  />
                ))}
              </div>
            ) : (
              <ItemTable
                rows={rows}
                drafts={drafts}
                rowErrors={rowErrors}
                activityTypes={activityTypes}
                expanded={expandedRow}
                onExpand={setExpandedRow}
                setDraft={setDraft}
                setItemActivity={setItemActivity}
                retireItem={retireItem}
                onEvidence={load}
                entryDate={day.entryDate}
              />
            )}

            <div className="dw-add">
              {!adding ? (
                <button className="dw-btn" onClick={() => setAdding(true)}>+ Add a work item</button>
              ) : (
                <div className="dw-addform">
                  <div className="dw-addgrid">
                    <div className="dw-field" style={{ marginTop: 0 }}>
                      <label htmlFor="dw-new-title">What is the work</label>
                      <input id="dw-new-title" type="text" value={newItem.title}
                             placeholder="e.g. LinkedIn outreach"
                             onChange={e => setNewItem({ ...newItem, title: e.target.value })} />
                    </div>
                    <div className="dw-field" style={{ marginTop: 0 }}>
                      <label htmlFor="dw-new-activity">Kind of activity</label>
                      <ActivityPicker
                        id="dw-new-activity"
                        types={activityTypes}
                        value={newItem.activityTypeKey}
                        onPick={(value, freeText) => {
                          if (value !== '__other__') {
                            setNewItem({ ...newItem, activityTypeKey: value });
                            return;
                          }
                          apiService.dailyWork.proposeActivityType(freeText)
                            .then(({ data }) => {
                              setNewItem({ ...newItem, activityTypeKey: data.key });
                              loadActivityTypes();
                            })
                            .catch(err => setNotice({ kind: 'stop', text: readError(err, 'Could not add that') }));
                        }}
                      />
                    </div>
                    <div className="dw-field" style={{ marginTop: 0 }}>
                      <label htmlFor="dw-new-anchor">Project or client</label>
                      <select id="dw-new-anchor" value={newItem.anchor}
                              onChange={e => setNewItem({ ...newItem, anchor: e.target.value })}>
                        <option value="">Not tied to one</option>
                        {groupAnchors(anchors).map(g => (
                          <optgroup key={g.label} label={g.label}>
                            {g.options.map(o => (
                              <option key={`${o.anchor_kind}:${o.anchor_id}`}
                                      value={`${o.anchor_kind}:${o.anchor_id}`}>
                                {o.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="dw-note">
                    This creates a <b>work item</b>, not just a line for today. It stays on
                    your list every day until you mark it complete or dropped.
                  </div>
                  <div className="dw-addform-actions">
                    <button className="dw-btn dw-btn-primary" onClick={addItem}>Add item</button>
                    <button className="dw-btn" onClick={() => setAdding(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </>
      )}
    </div>
  );
}

/* ── the day log ────────────────────────────────────────────────────── */

/**
 * What is sitting with you, and what is sitting with someone else.
 *
 * Derived entirely from queries that already exist — nothing here is stored,
 * and none of it is a work item. Turning "review two activity types" into a
 * daily_work_item would mean logging work about logging work, and would inflate
 * days-logged for whoever happened to have admin chores that day.
 *
 * The panel deliberately shows BOTH directions. A member seeing "with your
 * manager · nothing for you to do" is the difference between a queue that feels
 * like a to-do list and one that feels like being chased.
 *
 * It renders nothing when there is nothing waiting. An empty panel that says
 * "all clear" every day teaches people to stop reading the space.
 */
function WaitingPanel({ me, hasReports, rows, drafts, stalled, candidates, onOpenItem, onOpenTeam }) {
  const items = [];

  // Assigned to me and untouched. For a member the stalled endpoint returns
  // only their own, so this is genuinely "yours to move".
  (stalled || []).filter(s => s.owner_user_id === me).forEach(s => items.push({
    key: `mine:${s.item_id}`,
    badge: 'yours',
    badgeClass: 'assigned',
    title: s.title,
    why: s.last_entry_date
      ? `Nothing logged since ${formatDate(s.last_entry_date)}`
      : 'Assigned to you, never logged against',
    action: { label: 'Log against it', run: () => onOpenItem(s.item_id) },
  }));

  // Handed back and waiting on someone else. Nothing for them to do, and saying
  // so is the point.
  rows.filter(r => (drafts[r.item_id]?.dayStage || r.status) === 'in_review').forEach(r => items.push({
    key: `review:${r.item_id}`,
    badge: 'with your manager',
    badgeClass: 'review',
    title: r.title,
    why: 'Marked in review — nothing for you to do until they come back',
  }));

  // Activity types I proposed, still awaiting a decision. They work in the
  // meantime; this is information, not a blocker.
  (candidates || []).filter(c => c.created_by === me).forEach(c => items.push({
    key: `mycand:${c.key}`,
    badge: 'proposed',
    badgeClass: 'review',
    title: c.label,
    why: 'You named this activity — it works now, your manager decides if it joins the shared list',
  }));

  if (hasReports) {
    (candidates || []).forEach(c => items.push({
      key: `review-cand:${c.key}`,
      badge: 'to review',
      badgeClass: 'carried',
      title: c.label,
      why: `Proposed by ${c.first_name || 'someone'}${c.uses ? ` · used ${c.uses} ${c.uses === 1 ? 'time' : 'times'}` : ''}`,
      action: { label: 'Review', run: onOpenTeam },
    }));

    (stalled || []).filter(s => s.owner_user_id !== me).forEach(s => items.push({
      key: `chase:${s.item_id}`,
      badge: 'chase',
      badgeClass: 'carried',
      title: s.title,
      why: `${s.first_name || 'Someone'} ${s.last_name || ''}`.trim() +
           (s.last_entry_date
             ? ` — nothing since ${formatDate(s.last_entry_date)}`
             : ' — never logged against'),
      action: { label: 'Open people', run: onOpenTeam },
    }));
  }

  if (!items.length) return null;

  return (
    <div className="dw-card" style={{ marginBottom: 14 }}>
      <div className="dw-card-head">
        <h2>Waiting on you</h2>
        <span className="m">{items.length} {items.length === 1 ? 'thing' : 'things'}</span>
      </div>
      <div className="dw-daylog">
        {items.map(i => (
          <div className="dw-dayrow" key={i.key}>
            <div className="t" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`dw-badge ${i.badgeClass}`}>{i.badge}</span>
              <b>{i.title}</b>
              {i.action && (
                <button className="dw-btn-link" style={{ marginLeft: 'auto' }} onClick={i.action.run}>
                  {i.action.label}
                </button>
              )}
            </div>
            <div className="dw-meta">{i.why}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * My own project work — the same rows my manager sees on my timeline.
 *
 * Deliberately the SAME component and the SAME endpoint the People screen
 * uses, not a lighter version. GET /people/:userId already answers for the
 * viewer themselves, because getVisibleUserIds returns [viewer, ...reports] —
 * so nothing new was needed on the server, and asking the same question the
 * same way means the two screens cannot come to disagree about what I am late
 * for. A manager saying "you have four overdue" and My day showing three is
 * the failure this shape rules out.
 *
 * Only rendered when there is something to show. An empty card on the screen
 * whose job is logging today is noise, and the module works fine for orgs with
 * no Projects module at all — where this call returns nothing and this stays
 * invisible.
 */
function MyProjectWork({ me }) {
  const [items, setItems] = useState([]);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let alive = true;
    apiService.dailyWork.person(me, {})
      .then(({ data }) => { if (alive) setItems(data.projectItems || []); })
      // Silent. The Projects module may be off for this org, and My day has to
      // keep working regardless — the same reason the route wraps its own
      // project side in _projectSideOrEmpty.
      .catch(() => {});
    return () => { alive = false; };
  }, [me]);

  if (items.length === 0) return null;

  const overdue = items.filter(i => i.isOverdue);
  // A person row is what ProjectItemRow expects, and on this screen the person
  // is me. Built here rather than fetched: the crumb only needs an id and a
  // name to come back to, and the rollup that would supply one is a manager's
  // call that an individual has no reason to make.
  const person = { user_id: me, first_name: 'My', last_name: 'day' };

  return (
    <div className="dw-card" style={{ marginBottom: 14 }}>
      <div className="dw-card-head">
        <h2>My project work</h2>
        <span className="m">
          {items.length} open
          {overdue.length > 0 && ` · ${overdue.length} overdue`}
        </span>
      </div>

      {notice && (
        <div className="dw-banner warn" style={{ margin: '10px 12px 0' }}>
          {notice}
          <button className="dw-btn dw-btn-sm" style={{ marginLeft: 10 }}
                  onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="dw-daylog">
        {items.map(i => (
          <ProjectItemRow key={i.id} item={i} person={person}
                          period={null} anchorDate={null} filters={null}
                          onRefuse={setNotice} />
        ))}
      </div>
    </div>
  );
}

/**
 * The log: ONE ROW PER DAY, the day's descriptions run together.
 *
 * That is the shape the spreadsheet had, which is the point — the manager still
 * gets the familiar block, and the parts underneath were never lost. Today's
 * row is built from the drafts so unsaved work shows immediately; earlier days
 * come from the server already grouped and concatenated.
 */
function DayLog({ day, rows, written, drafts, saved, history, onEdit }) {
  const joined = written.map(r => (drafts[r.item_id]?.description || '').trim()).join(' ');
  const past = history || [];

  if (!written.length && !past.length) {
    return (
      <div className="dw-card">
        <div className="dw-empty">
          <p>
            Nothing logged yet.
            {rows.length > 0 && <><br />You have {rows.length} open {rows.length === 1 ? 'item' : 'items'} waiting.</>}
          </p>
          <button className="dw-btn dw-btn-primary" onClick={() => onEdit(rows[0]?.item_id)}>
            Log today's work
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dw-card">
      <div className="dw-card-head">
        <h2>My daily log</h2>
        <span className={`m ${saved ? 'saved' : ''}`}>
          {written.length === 0
            ? 'Nothing logged today'
            : saved ? `Today saved · ${written.length} ${written.length === 1 ? 'item' : 'items'}`
                    : `${written.length} written, not saved yet`}
        </span>
      </div>

      <div className="dw-daylog">
        <div className="dw-dayrow today">
          <div className="dw-date">{formatDate(day.entryDate)} · today</div>
          {written.length ? (
            <>
              <div className="dw-work">{joined}</div>
              <div className="dw-meta">{written.length} {written.length === 1 ? 'item' : 'items'}</div>
              <div className="dw-detail">
                {written.map(r => (
                  <div className="dw-detail-item" key={r.item_id}>
                    <div className="t">
                      <b>{r.title}</b>
                      <span className="dw-badge">{stageLabel(drafts[r.item_id]?.dayStage)}</span>
                      {r.evidence_count > 0 && (
                        <span className="dw-badge">{r.evidence_count} evidence</span>
                      )}
                      <button className="dw-btn-link" style={{ marginLeft: 'auto' }}
                              onClick={() => onEdit(r.item_id)}>Edit</button>
                    </div>
                    <div className="d">{drafts[r.item_id]?.description}</div>
                    {drafts[r.item_id]?.nextSteps && (
                      <div className="dw-meta"><b>Next:</b> {drafts[r.item_id].nextSteps}</div>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="dw-none">Not logged yet.</div>
              <button className="dw-btn dw-btn-sm dw-btn-primary" style={{ marginTop: 10 }}
                      onClick={() => onEdit(rows[0]?.item_id)}>
                Log today's work
              </button>
            </>
          )}
        </div>

        {past.map(d => <PastDay key={d.entry_date} day={d} />)}
      </div>
    </div>
  );
}

/**
 * An earlier day, read-only.
 *
 * Deliberately not editable from here. Correcting three days ago is a real
 * need, but it is also how a compliance log stops meaning anything, so it
 * should be a considered feature rather than a side effect of the log being
 * on screen.
 */
function PastDay({ day }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dw-dayrow">
      <div className="dw-date">{formatDate(day.entry_date)}</div>
      <div className={`dw-work ${open ? '' : 'dw-clamp'}`}>{day.work_done}</div>
      <div className="dw-meta">
        {day.item_count} {day.item_count === 1 ? 'item' : 'items'}
        {day.evidence_count > 0 && ` · ${day.evidence_count} evidence`}
        {day.work_done && day.work_done.length > 160 && (
          <button className="dw-btn-link" style={{ marginLeft: 10 }}
                  onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── one work item ──────────────────────────────────────────────────── */

/**
 * The edit surface as a TABLE — one row per work item.
 *
 * WHY THIS EXISTS ALONGSIDE ItemCard. The card layout gives each item a
 * heading, a prior-entry line, four labelled fields and an evidence block, and
 * on a wide screen that is roughly 600px of chrome per item. It reads well for
 * one item and badly for six: logging a day becomes scrolling, and the thing a
 * person actually wants — to see every item at once and type a line against
 * each — is the one thing it does not offer.
 *
 * WHAT MOVES AND WHAT DOES NOT. The four fields written EVERY day (description,
 * activity, stage, next steps) are the columns. Everything written rarely or
 * read occasionally — the prior entry, evidence, retiring a recurring item —
 * goes behind a per-row expander rather than being dropped, because losing the
 * only route to attaching evidence would be a worse trade than the space it
 * costs.
 *
 * table-layout: fixed with explicit widths, so a long item title wraps inside
 * its column instead of stretching the table and pushing the typing space off
 * screen. That is the whole point of the layout and it does not survive auto
 * table sizing.
 *
 * DESKTOP ONLY. Five columns of inputs do not fit a 380px viewport, and the
 * cards are already the mobile answer — DailyWorkView keeps them there
 * regardless of this preference.
 */
function ItemTable({ rows, drafts, rowErrors, activityTypes, expanded, onExpand,
                     setDraft, setItemActivity, retireItem, onEvidence, entryDate }) {
  return (
    <div className="dw-grid-wrap">
      <table className="dw-grid">
        <colgroup>
          <col style={{ width: '8%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '28%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '11%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '4%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Item</th>
            <th>What did you do today</th>
            <th>Activity</th>
            <th>Stage</th>
            <th>Next steps</th>
            <th><span className="dw-sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const draft       = drafts[row.item_id] || {};
            const description = draft.description || '';
            const length      = description.length;
            const overSoft    = length >= SOFT_LIMIT;
            const overHard    = length > HARD_LIMIT;
            const stage       = draft.dayStage || 'in_progress';
            const closed      = stage === 'completed' || stage === 'dropped';
            const isOpen      = expanded === row.item_id;
            const error       = rowErrors[row.item_id];

            return (
              <React.Fragment key={row.item_id}>
                <tr className={stage === 'dropped' ? 'dropped' : ''}>
                  {/* The date being logged. Every row carries the same one —
                      Edit rows only ever writes today — so this is orientation
                      rather than data: the grid otherwise gives no clue which
                      day the typing lands on, and the heading scrolls away. */}
                  <td className="dw-grid-date">{formatDateShort(entryDate)}</td>

                  <td className="dw-grid-item">
                    <span className="dw-grid-title">{row.title}</span>
                    {/* Inline with the title rather than on their own line, so
                        the row stays one line deep. target_date is back: it was
                        on the card header and dropping it lost the only place a
                        one-off item's due date was visible. */}
                    {row.kind === 'assigned' && <span className="dw-badge assigned">one-off</span>}
                    {row.assigned_by && <span className="dw-badge assigned">assigned</span>}
                    {row.target_date && <span className="dw-badge">by {formatDateShort(row.target_date)}</span>}
                    {row.account_name && <span className="dw-badge">{row.account_name}</span>}
                    {stage === 'in_review' && <span className="dw-badge review">in review</span>}
                  </td>

                  <td>
                    <textarea
                      aria-label={`What did you do today on ${row.title}`}
                      className={`dw-grid-ta ${overHard ? 'over' : overSoft ? 'warn' : ''}`}
                      rows={1}
                      value={description}
                      placeholder="What did you actually do?"
                      onChange={e => setDraft(row.item_id, { description: e.target.value })}
                    />
                    {(error || overSoft) && (
                      <div className="dw-foot">
                        {error && <span className="dw-err">{error}</span>}
                        {overSoft && (
                          <span className={`dw-count ${overHard ? 'over' : 'warn'}`}>
                            {length} / {HARD_LIMIT}
                          </span>
                        )}
                      </div>
                    )}
                  </td>

                  <td>
                    <ActivityPicker
                      id={`dw-grid-activity-${row.item_id}`}
                      types={activityTypes}
                      value={row.activity_type_key}
                      onPick={(value, freeText) => setItemActivity(row.item_id, value, freeText)}
                    />
                  </td>

                  <td>
                    <select aria-label={`Stage for ${row.title}`} value={stage}
                            onChange={e => setDraft(row.item_id, { dayStage: e.target.value })}>
                      {STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </td>

                  <td>
                    <textarea
                      aria-label={`Next steps for ${row.title}`}
                      className="dw-grid-ta"
                      rows={1}
                      value={draft.nextSteps || ''}
                      placeholder="What happens tomorrow?"
                      onChange={e => setDraft(row.item_id, { nextSteps: e.target.value })}
                    />
                  </td>

                  {/* Icon, not a text link: the label sat under the title and
                      made every row two lines deep to carry a control most
                      rows never need. title and aria-label do the naming that
                      the visible text used to, so it stays findable by hover
                      and reachable by screen reader. */}
                  <td className="dw-grid-actions">
                    <button type="button" className="dw-icon-btn"
                            aria-expanded={isOpen}
                            aria-label={`History and evidence for ${row.title}`}
                            title="History, evidence, and settings for this item"
                            onClick={() => onExpand(isOpen ? null : row.item_id)}>
                      {isOpen ? '×' : '⋯'}
                    </button>
                  </td>
                </tr>

                {isOpen && (
                  <tr className="dw-grid-detail">
                    <td colSpan={7}>
                      {row.prior_description ? (
                        <div className="dw-prior">
                          <b>{formatDate(row.prior_date)}:</b> {row.prior_description}
                          {' '}
                          <button className="dw-btn-link"
                                  onClick={() => setDraft(row.item_id,
                                    { description: row.prior_description })}>
                            Start from this
                          </button>
                        </div>
                      ) : (
                        <div className="dw-prior empty"><b>No earlier entry</b> for this item.</div>
                      )}

                      {row.kind === 'recurring' && closed && (
                        <div className="dw-item-status">Done for today. It returns tomorrow.</div>
                      )}

                      <div className="dw-field">
                        <label>Evidence</label>
                        {!row.entry_id ? (
                          <div className="dw-item-status">
                            Save the day first, then you can attach to it.
                          </div>
                        ) : (
                          <EvidenceList entryId={row.entry_id} closed={closed}
                                        onChange={onEvidence} />
                        )}
                      </div>

                      {row.kind === 'recurring' && (
                        <div className="dw-field">
                          <RetireControl title={row.title}
                                         onRetire={() => retireItem(row.item_id)} />
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ItemCard({ row, draft, error, isOpen, onToggle, onChange, onEvidence, collapsible,
                   activityTypes, onActivity, onRetire }) {

  const description = draft.description || '';
  const length = description.length;
  const overSoft = length >= SOFT_LIMIT;
  const overHard = length > HARD_LIMIT;
  const stage = draft.dayStage || 'in_progress';
  const closed = stage === 'completed' || stage === 'dropped';

  return (
    <div className={`dw-item ${isOpen ? 'dw-open' : ''} ${stage === 'dropped' ? 'dropped' : ''}`}>
      {collapsible ? (
        <button className="dw-item-head" onClick={onToggle} aria-expanded={isOpen}>
          <ItemHeader row={row} description={description} stage={stage} />
        </button>
      ) : (
        <div className="dw-item-head"><ItemHeader row={row} description={description} stage={stage} /></div>
      )}

      {isOpen && (
        <div className="dw-item-body">
          <div className="dw-item-grid">
            <div className="dw-field desc" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor={`dw-desc-${row.item_id}`}>What did you do today</label>

              {row.prior_description ? (
                <div className="dw-prior">
                  <b>{formatDate(row.prior_date)}:</b> {row.prior_description}
                  {' '}
                  <button className="dw-btn-link"
                          onClick={() => onChange({ description: row.prior_description })}>
                    Start from this
                  </button>
                </div>
              ) : (
                <div className="dw-prior empty"><b>No earlier entry</b> for this item.</div>
              )}

              <textarea
                id={`dw-desc-${row.item_id}`}
                className={overHard ? 'over' : overSoft ? 'warn' : ''}
                rows={4}
                value={description}
                placeholder="What did you actually do?"
                onChange={e => onChange({ description: e.target.value })}
              />

              <div className="dw-foot">
                {error && <span className="dw-err">{error}</span>}
                {overSoft && (
                  <span className={`dw-count ${overHard ? 'over' : 'warn'}`}>
                    {length} / {HARD_LIMIT}
                  </span>
                )}
              </div>
            </div>

            <div className="dw-field">
              <label htmlFor={`dw-activity-${row.item_id}`}>Activity</label>
              <ActivityPicker
                id={`dw-activity-${row.item_id}`}
                types={activityTypes}
                value={row.activity_type_key}
                onPick={onActivity}
              />
            </div>

            <div className="dw-field">
              <label htmlFor={`dw-stage-${row.item_id}`}>Stage</label>
              <select id={`dw-stage-${row.item_id}`} value={stage}
                      onChange={e => onChange({ dayStage: e.target.value })}>
                {STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {row.kind === 'recurring' && closed && (
                <div className="dw-item-status">Done for today. It returns tomorrow.</div>
              )}
            </div>

            <div className="dw-field">
              <label htmlFor={`dw-next-${row.item_id}`}>Next steps (optional)</label>
              <textarea id={`dw-next-${row.item_id}`} rows={2} style={{ minHeight: 60 }}
                        value={draft.nextSteps || ''}
                        placeholder="What happens tomorrow?"
                        onChange={e => onChange({ nextSteps: e.target.value })} />
            </div>

            {row.kind === 'recurring' && (
              <div className="dw-field" style={{ gridColumn: '1 / -1' }}>
                <RetireControl title={row.title} onRetire={() => onRetire(row.item_id)} />
              </div>
            )}

            <div className="dw-field" style={{ gridColumn: '1 / -1' }}>
              <label>Evidence</label>
              {!row.entry_id ? (
                <div className="dw-item-status">Save the day first, then you can attach to it.</div>
              ) : (
                <EvidenceList entryId={row.entry_id} closed={closed} onChange={onEvidence} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemHeader({ row, description, stage }) {
  const written = (description || '').trim().length > 0;
  return (
    <>
      <div className="dw-item-title">{row.title}</div>
      <div className="dw-item-badges">
        {row.kind === 'assigned'
          ? <span className="dw-badge assigned">one-off</span>
          : <span className="dw-badge">recurring</span>}
        {row.assigned_by && <span className="dw-badge assigned">assigned</span>}
        {row.target_date && <span className="dw-badge">by {formatDate(row.target_date)}</span>}
        {row.account_name && <span className="dw-badge">{row.account_name}</span>}
        {stage === 'in_review' && <span className="dw-badge review">in review</span>}
      </div>
      <div className={`dw-item-status ${written ? 'done' : ''}`}>
        {written ? 'Written for today' : 'Nothing written yet'}
      </div>
    </>
  );
}

/**
 * Everything attached to one entry, withdrawn rows included.
 *
 * Evidence is immutable in the database — the only permitted update is setting
 * the revocation fields, and re-revoking is refused. So there is no edit here:
 * there is Withdraw, and there is Replace, which withdraws and attaches in one
 * transaction so the entry is never briefly left with nothing.
 *
 * Withdrawn rows stay on screen, struck through, with who withdrew them and
 * why. A correction that erased what it replaced would be indistinguishable
 * from never having made the mistake.
 */
function EvidenceList({ entryId, closed, onChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState(null);       // null | 'add' | { action, id }
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    apiService.dailyWork.listEvidence(entryId)
      .then(({ data }) => setItems(data || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [entryId]);

  useEffect(() => { load(); }, [load]);

  const reset = () => { setMode(null); setNote(''); setReason(''); setErr(null); };

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'add') {
        await apiService.dailyWork.attachEvidence(entryId, { note: note.trim() });
      } else if (mode.action === 'revoke') {
        await apiService.dailyWork.revokeEvidence(mode.id, reason.trim());
      } else {
        await apiService.dailyWork.replaceEvidence(mode.id, { note: note.trim(), reason: reason.trim() });
      }
      reset();
      load();
      if (onChange) onChange();
    } catch (e) {
      setErr(readError(e, 'That did not work'));
    } finally {
      setBusy(false);
    }
  };

  const live = items.filter(i => !i.revoked_at);

  if (loading) return <div className="dw-item-status">Loading evidence…</div>;

  return (
    <>
      {items.length > 0 && (
        <div className="dw-ev">
          {items.map(i => (
            <div className="dw-ev-item" key={i.id}
                 style={i.revoked_at ? { opacity: 0.65 } : undefined}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="k">{i.revoked_at ? 'withdrawn' : i.channel}</span>
                <div style={i.revoked_at ? { textDecoration: 'line-through' } : undefined}>
                  {i.note}
                </div>
                {i.revoked_at && (
                  <div className="dw-meta">
                    Withdrawn by {i.revoked_first || 'someone'} — {i.revoke_reason}
                  </div>
                )}
              </div>
              {!i.revoked_at && (
                <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="dw-btn-link"
                          onClick={() => { setMode({ action: 'replace', id: i.id }); setNote(i.note || ''); }}>
                    Replace
                  </button>
                  <button className="dw-btn-link" onClick={() => setMode({ action: 'revoke', id: i.id })}>
                    Withdraw
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {err && <div className="dw-err" style={{ marginBottom: 8 }}>{err}</div>}

      {mode ? (
        <div>
          {(mode === 'add' || mode.action === 'replace') && (
            <input type="text" value={note} autoFocus
                   placeholder="Paste a link, or write one sentence"
                   onChange={e => setNote(e.target.value)} />
          )}
          {mode !== 'add' && (
            <input type="text" value={reason}
                   style={{ marginTop: 8 }}
                   placeholder={mode.action === 'revoke'
                     ? 'Why are you withdrawing it?' : 'Why are you replacing it?'}
                   onChange={e => setReason(e.target.value)} />
          )}
          <div className="dw-addform-actions">
            <button className="dw-btn dw-btn-sm dw-btn-primary" onClick={run} disabled={busy}>
              {busy ? 'Working…'
                : mode === 'add' ? 'Attach'
                : mode.action === 'revoke' ? 'Withdraw' : 'Replace'}
            </button>
            <button className="dw-btn dw-btn-sm" onClick={reset}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="dw-btn dw-btn-sm" onClick={() => setMode('add')}>
          Attach evidence
        </button>
      )}

      {closed && live.length === 0 && (
        <div className="dw-item-status">
          Closing without evidence — your manager sees this as unverified.
        </div>
      )}
    </>
  );
}

/**
 * Stop a recurring item.
 *
 * Retire, not delete. The entries stay and the history stays readable; the item
 * simply stops appearing on tomorrow's list. Deleting would cascade away
 * everything anyone ever logged against it, which is a strange price for
 * tidying a list.
 *
 * Two taps, because an item that quietly disappears from someone's morning is
 * worse than one that takes a moment to remove.
 */
function RetireControl({ title, onRetire }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button className="dw-btn dw-btn-sm" onClick={() => setConfirming(true)}>
        Stop tracking this
      </button>
    );
  }
  return (
    <div className="dw-banner warn" style={{ marginBottom: 0 }}>
      Stop tracking <b>{title}</b>? It leaves tomorrow's list. Everything already
      logged against it stays, and you can start it again later.
      <div className="dw-addform-actions">
        <button className="dw-btn dw-btn-sm dw-btn-primary" onClick={onRetire}>
          Stop tracking it
        </button>
        <button className="dw-btn dw-btn-sm" onClick={() => setConfirming(false)}>Keep it</button>
      </div>
    </div>
  );
}

/**
 * The activity dropdown, with "Other" as an escape hatch.
 *
 * Members never get write access to the shared list — that is what the
 * candidate status is for. What they get is a way to name the thing they
 * actually did without waiting for anyone, and the manager decides afterwards
 * whether it joins the list or folds into something that already exists.
 *
 * Candidates are shown, marked, because the person who proposed one has to keep
 * using it while it waits.
 */
function ActivityPicker({ id, types, value, onPick }) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');

  const known = (types || []).some(t => t.key === value);

  return (
    <>
      <select
        id={id}
        value={other ? '__other__' : (known ? value : '')}
        onChange={e => {
          if (e.target.value === '__other__') { setOther(true); return; }
          setOther(false);
          onPick(e.target.value || null);
        }}
      >
        <option value="">Not set</option>
        {(types || []).map(t => (
          <option key={t.key} value={t.key}>
            {t.label}{t.status === 'candidate' ? ' (proposed)' : ''}
          </option>
        ))}
        <option value="__other__">Other…</option>
      </select>

      {other && (
        <div style={{ marginTop: 8 }}>
          <input
            type="text"
            value={text}
            placeholder="Name it — your manager reviews these"
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && text.trim()) {
                onPick('__other__', text.trim());
                setText(''); setOther(false);
              }
            }}
          />
          <div className="dw-addform-actions">
            <button className="dw-btn dw-btn-sm dw-btn-primary"
                    onClick={() => { if (text.trim()) { onPick('__other__', text.trim()); setText(''); setOther(false); } }}>
              Use this
            </button>
            <button className="dw-btn dw-btn-sm" onClick={() => { setOther(false); setText(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* ── helpers ────────────────────────────────────────────────────────── */

/**
 * Format a 'YYYY-MM-DD' STRING for display.
 *
 * Parsed with explicit parts rather than new Date(str): the Date constructor
 * treats a bare date string as UTC midnight and then renders it in the
 * browser's zone, which shows the previous day for anyone west of UTC. Building
 * it from the parts keeps the calendar date the backend sent.
 */
function formatDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

/**
 * The same date, short, for the table's Date column.
 *
 * Parsed the same way as formatDate — component-wise into a LOCAL Date rather
 * than new Date('2026-09-01'), which the spec says to read as UTC and which
 * therefore renders as the previous day for anyone west of Greenwich. The
 * entry date is a calendar date the person chose, not an instant.
 */
function formatDateShort(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short',
  });
}

function groupAnchors(anchors) {
  // Keys come from getAnchorOptions. Unknown keys fall through to the raw key
  // below rather than rendering blank, but every key the server can emit should
  // be named here — 'standing' arrived with 2026_133.
  const labels = {
    standing: 'Standing initiatives',
    customer_project: 'Customer projects',
    internal_project: 'Internal projects',
    account: 'Accounts',
    campaign: 'Campaigns',
  };

  // EXPLICIT GROUP ORDER, with Accounts last.
  //
  // The server sorts `ORDER BY group_key, label` and this function used to
  // take Object.keys(groups), i.e. insertion order — so the groups came out in
  // ALPHABETICAL order of the internal key, which puts 'account' first. Every
  // account in the org therefore sat at the top of the picker, and the three
  // groups people actually anchor to were below a scroll of company names.
  // Alphabetical order of an internal identifier is not a ranking of anything.
  //
  // Accounts is not removed, because anchoring straight at a customer with no
  // project is a real case getAnchorOptions supports deliberately. It is just
  // the longest list and the least often wanted, so it goes to the bottom
  // where its length costs nothing.
  const ORDER = ['campaign', 'internal_project', 'standing', 'customer_project', 'account'];

  const groups = {};
  (anchors || []).forEach(a => {
    (groups[a.group_key] = groups[a.group_key] || []).push(a);
  });

  // Sorted by position in ORDER; anything not listed keeps its old behaviour of
  // appearing after the known groups rather than vanishing, so a group_key
  // added server-side later still shows up.
  const rank = k => { const i = ORDER.indexOf(k); return i === -1 ? ORDER.length : i; };

  return Object.keys(groups)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map(k => ({ label: labels[k] || k, options: groups[k] }));
}

function readError(err, fallback) {
  return err?.response?.data?.error || err?.message || fallback;
}
