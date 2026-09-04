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
import { ProjectItemRow, daysBetween, dueText, useOpenProjectTask } from './dailyWorkProjectLink';
import TaskWorkComposer from './TaskWorkComposer';
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

// 2026_136. What a row owned by a project task may be logged at — the same
// three the server's LINKED_DAY_STAGES accepts. Finishing is deliberately
// absent: it happens on the task, so it keeps passing through whatever gating,
// review and evidence rules that project applies. Derived from STAGES rather
// than typed out again, so a change to the vocabulary cannot update one list
// and leave the other behind.
const CLOSING_STAGES = ['completed', 'dropped'];
const LINKED_STAGES = STAGES.filter(s => !CLOSING_STAGES.includes(s.value));

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
  // Setup readiness, shown to ADMINS ONLY and only while something is missing.
  // The endpoint is admin-gated, so a member's call would 403 — and that is the
  // right shape anyway: a member cannot fix a missing holiday calendar, and
  // telling them their own numbers may be wrong without giving them a way to
  // act is worry with no remedy. Their admin sees it here and on Setup.
  const [setupGaps, setSetupGaps] = useState(null);
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

  // Which day is on screen. null means "today, whatever the server says it is"
  // — the browser never computes today itself, because the entry date is the
  // OWNER's local date resolved server-side and a laptop with a wrong clock or
  // a different timezone would disagree with the day its work actually lands on.
  const [viewDate, setViewDate] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiService.dailyWork.getDay(viewDate || undefined);
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
  }, [viewDate]);

  useEffect(() => {
    if (!isOrgAdmin()) return;
    let alive = true;
    apiService.dailyWork.setupReadiness()
      .then(r => { if (alive && r?.data && !r.data.ready) setSetupGaps(r.data); })
      .catch(() => {});   // never let a reporting call disturb the screen
    return () => { alive = false; };
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

  /**
   * Change the item itself — its name, or what it is anchored to.
   *
   * The endpoint has always accepted these. PATCH /daily-work/items/:id takes
   * title, activityTypeKey, anchorKind/anchorId and targetDate, and patches
   * only the keys actually present. The UI just never sent anything but
   * activityTypeKey, so a typo in an item name was permanent and an item
   * anchored to the wrong initiative could only be retired and recreated —
   * which loses its history, because entries belong to the item.
   */
  const patchItem = async (itemId, patch) => {
    try {
      await apiService.dailyWork.updateItem(itemId, patch);
      await load();
      setNotice({ kind: 'info', text: 'Item updated.' });
    } catch (err) {
      setNotice({ kind: 'stop', text: readError(err, 'Could not update that item') });
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
      // day.entryDate, not viewDate: the server told us which day this is, and
      // sending back what it said keeps the save aimed at the day on screen even
      // if viewDate is null (today). Sending null here would still mean today,
      // but only by coincidence of the two agreeing.
      const { data } = await apiService.dailyWork.saveDay(entries, day.entryDate);
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
        // 2026_140. The day this composer is open on, not today.
        //
        // Without it the item opened today and then failed saveDay's "that
        // item did not exist yet on the day you are logging" check for the
        // very entry it was added to carry — so adding an item while
        // backfilling Tuesday was impossible on Thursday. The date was on
        // screen the whole time; it just was not being sent.
        //
        // The server clamps forward dates to today, so a composer open on a
        // future day cannot create an item that does not exist yet.
        // day.entryDate, not viewDate: the server returns the day it actually
        // resolved in the owner's timezone, and that is the date saveDay will
        // compare opened_on against. A client-side guess could differ by one
        // across midnight and reintroduce the bug in a rarer form.
        openedOn: day?.entryDate || null,
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
  // Everything the date navigation needs, derived from what the server sent.
  // backfillDays has a fallback because an older server will not send it — in
  // which case navigation stays put at today rather than guessing a window.
  const backfillDays = day?.backfillDays ?? 0;
  const isToday      = !!day && (!day.today || day.entryDate === day.today);
  const earliestDay  = day?.today ? addDaysStr(day.today, -backfillDays) : null;
  const canGoBack    = !!day && !!earliestDay && day.entryDate > earliestDay;

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
          {/* Date navigation, bounded by the window the SERVER reported. The
              browser never computes "today" or the earliest allowed day itself:
              the entry date is the owner's local date resolved server-side, and
              a laptop in the wrong timezone would offer days the save would then
              refuse. day.today is what the server called today. */}
          <div className="dw-daynav">
            <button type="button" className="dw-btn dw-btn-sm"
                    disabled={!canGoBack}
                    title={canGoBack ? 'Previous day' : `You can only log the last ${backfillDays} days`}
                    onClick={() => setViewDate(addDaysStr(day.entryDate, -1))}>←</button>
            <button type="button" className="dw-btn dw-btn-sm"
                    disabled={isToday}
                    title="Next day"
                    onClick={() => setViewDate(addDaysStr(day.entryDate, 1))}>→</button>
            {!isToday && (
              <button type="button" className="dw-btn dw-btn-sm" onClick={() => setViewDate(null)}>
                Today
              </button>
            )}
            {!isToday && (
              <span className="dw-badge review">writing up an earlier day</span>
            )}
          </div>
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

      {/* Reported, never enforced — nothing below is blocked. It is worth
          saying because the failure is silent: an unscheduled person is
          measured against Mon-Fri with no holidays, and a wrong rate looks
          exactly like a right one. */}
      {setupGaps && (
        <div className="dw-banner warn">
          <b>Daily work is not fully set up yet.</b>{' '}
          {setupGaps.checks.filter(c => !c.advisory && !c.ok).map(c => c.label).join(' · ')}.
          {' '}Rates on this screen may be measured against the wrong days until
          that is fixed.{' '}
          {isOrgAdmin() && (
            <button type="button" className="dw-btn-link" onClick={() => setTab('setup')}>
              Open setup
            </button>
          )}
        </div>
      )}

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

      {/* 2026_141. Above My project work, because a review is somebody ELSE
          waiting on you — it has a person attached and it goes stale in a way
          your own task list does not. */}
      <ReviewQueueCard />

      {/* onPosted reloads the day. Logging against a project task from here
          creates a daily work item, and the log underneath has to pick it up —
          without this the person posts an update and their own day still says
          nothing was written. */}
      <MyProjectWork me={me} today={day.today} onPosted={load} />

      {mode === 'log'
        ? <DayLog day={day} rows={rows} written={written} drafts={drafts} saved={saved}
                  history={history.filter(h => h.entry_date !== day.entryDate)}
                  me={me} activityTypes={activityTypes}
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
            ) : isMobile ? (
              /* Cards are the phone layout now, not a choice. The Table/Cards
                 toggle is gone: two layouts for one screen meant two places to
                 fix anything, and the table is what the screen is for on a
                 wide monitor. ItemCard stays because five columns of inputs
                 genuinely do not fit 380px. */
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
                anchors={anchors}
                onPatchItem={patchItem}
              />
            )}

            <div className="dw-add">
              {!adding ? (
                <button className="dw-btn" onClick={() => setAdding(true)}>+ Add a work item</button>
              ) : (
                <div className="dw-addform dw-addbar">
                  {/* ONE ROW, not a three-column card with stacked labels.
                      The card gave each of three fields its own uppercase
                      label and a full-width block, which is ~200px of form to
                      type a title into. Labels move to placeholders and
                      aria-label: the fields are self-describing once their
                      placeholder text says what they are, and the note below
                      already explains what the button does. */}
                  <input id="dw-new-title" type="text" value={newItem.title}
                         aria-label="What is the work"
                         placeholder="What is the work — e.g. LinkedIn outreach"
                         onKeyDown={e => { if (e.key === 'Enter' && newItem.title.trim()) addItem(); }}
                         onChange={e => setNewItem({ ...newItem, title: e.target.value })} />
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
                  <select id="dw-new-anchor" value={newItem.anchor}
                          aria-label="Project or client"
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
                  <button className="dw-btn dw-btn-primary" onClick={addItem}>Add item</button>
                  <button className="dw-btn" onClick={() => setAdding(false)}>Cancel</button>
                  {/* Kept, on its own line under the bar. It is the one thing a
                      first-time user genuinely needs: that this is not a line
                      for today but a thing that comes back tomorrow. */}
                  <div className="dw-note dw-addbar-note">
                    This creates a <b>work item</b>, not just a line for today. It stays on
                    your list every day until you mark it complete or dropped.
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
 * How far ahead the My project work card looks.
 *
 * A VIEW FILTER, applied here in the browser — NOT a predicate added to
 * getPersonProjectItems. That query is shared with the People screen and with
 * the link check behind every "open this task"; narrowing it server-side would
 * make a manager's timeline shorter and, worse, would make checkProjectLink
 * refuse a link to a task that fell outside the window, since it validates by
 * asking that same query whether the task is still there.
 *
 * The design's reasoning against a window still holds and is what shapes the
 * rules below: a task due in three weeks that somebody worked on today has to
 * stay loggable, or that person goes back to typing a free-text item. So
 * nothing is ever unreachable — the count of what is hidden is shown with a
 * one-click way to see it, and two categories are never hidden at all:
 *
 *   - anything OVERDUE, which is the opposite of "not due yet"
 *   - anything with NO due date, including every task on a standing
 *     initiative, which would otherwise be permanently invisible here
 */
const DUE_WINDOWS = [
  { key: '7',   label: '7 days',  days: 7 },
  { key: '14',  label: '2 weeks', days: 14 },
  { key: '30',  label: '1 month', days: 30 },
  { key: 'all', label: 'All',     days: null },
];

function withinWindow(item, today, days) {
  if (days == null) return true;
  if (item.isOverdue) return true;
  if (!item.dueDate) return true;
  if (!today) return true;          // no server date to measure against
  const ahead = daysBetween(today, item.dueDate);
  return ahead == null || ahead <= days;
}

/**
 * One row of the project work table, plus the composer it opens.
 *
 * SEPARATE COMPONENT because each row owns whether its composer is open, and
 * a map() in the parent cannot hold per-row state without a hook inside a
 * loop. It shares the open-task action and the due wording with the card
 * layout through dailyWorkProjectLink, so the two layouts cannot come to
 * disagree about either.
 */
function ProjectWorkRow({ item, person, today, onRefuse, onPosted }) {
  const [logging, setLogging] = useState(false);
  const { open, busy, linkable } = useOpenProjectTask({
    item, person, period: null, anchorDate: null, filters: null, onRefuse });
  const loggable = item.kind === 'task' && !!item.playInstanceId;

  return (
    <>
      <tr>
        <td className="dw-projtable-task">
          <b>{item.title}</b>
          {item.kind === 'commitment' && <span className="dw-badge">commitment</span>}
        </td>
        <td>
          {item.project}
          {item.isStanding && <span className="dw-badge">standing</span>}
        </td>
        <td>
          <span className={`dw-badge ${item.isOverdue ? 'carried' : ''}`}>
            {dueText(item, today)}
          </span>
        </td>
        <td>
          {linkable && (
            <button type="button" className="dw-btn-link" onClick={open} disabled={busy}>
              {busy ? 'opening…' : 'Open this task'}
            </button>
          )}
        </td>
        <td>
          {loggable && (
            <button type="button" className="dw-btn-link"
                    aria-expanded={logging}
                    onClick={() => setLogging(v => !v)}>
              {logging ? 'Hide' : 'Log work on this'}
            </button>
          )}
        </td>
      </tr>
      {logging && loggable && (
        <tr className="dw-projtable-detail">
          <td colSpan={5}>
            <TaskWorkComposer playInstanceId={item.playInstanceId}
                              startOpen onPosted={onPosted} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The project work list as a table — task, project, due, and the two actions.
 *
 * WHY THIS EXISTS ALONGSIDE THE CARD LAYOUT, which is the same argument
 * ItemTable makes against ItemCard: five columns of controls do not fit 380px,
 * and a stacked row does not let someone scan ten tasks for the one they
 * worked on. So the table is the desktop layout and the cards are the phone
 * one, chosen by the same useIsMobile breakpoint the rest of this screen uses.
 *
 * The composer opens INSIDE the table, in a full-width row under the task it
 * belongs to, rather than in a panel elsewhere on the screen. Someone logging
 * three tasks in a row stays in one place and never loses which task they are
 * writing about.
 */
function ProjectWorkTable({ items, person, today, onRefuse, onPosted }) {
  return (
    <div className="dw-grid-wrap dw-projtable-wrap">
      <table className="dw-grid dw-projtable">
        <colgroup>
          <col style={{ width: '34%' }} />
          <col style={{ width: '24%' }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '12%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Task</th>
            <th>Project</th>
            <th>Due</th>
            <th><span className="dw-sr-only">Open</span></th>
            <th><span className="dw-sr-only">Log work</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map(i => (
            <ProjectWorkRow key={i.id} item={i} person={person} today={today}
                            onRefuse={onRefuse} onPosted={onPosted} />
          ))}
        </tbody>
      </table>
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
/**
 * Task reviews waiting on this person, on their own day (2026_141).
 *
 * ── WHY IT IS HERE AND NOT ONLY IN PROJECTS ─────────────────────────────────
 *
 * myReviewQueue has existed since the review loop shipped and was rendered on
 * ONE screen: Projects → My Work. Daily Work has no concept of a review at all
 * — grep the module and the only hit is daily_work_items.status, an unrelated
 * column.
 *
 * That is fine for someone who lives in Projects. It is not fine for a Project
 * Manager whose day starts in Daily Work: six approvals sat one module away
 * from the person they were waiting on, which is exactly the "review sitting
 * unseen" failure the notification work was built to prevent.
 *
 * ── IT DOES NOT DUPLICATE THE PROJECTS BANNER ───────────────────────────────
 *
 * Same endpoint, same rows, deliberately. This is not a second queue with its
 * own rules — myReviewQueue is the single definition of "awaiting my review",
 * and it is scoped by the same authority rule as everything else
 * (manageableProjectSql). A second query here would be a second answer.
 *
 * ── RENDERS NOTHING WHEN EMPTY ──────────────────────────────────────────────
 *
 * Most people are not reviewers, and a permanent "0 awaiting review" card on
 * everyone's day is noise on the screen people open first every morning.
 */
function ReviewQueueCard() {
  const [rows, setRows] = useState(null);   // null = loading or unavailable

  useEffect(() => {
    // Guarded like the other cross-module reads: a missing method throws
    // synchronously, before a promise exists, so a trailing .catch() would not
    // catch it and a stale bundle would take My day down rather than hiding a
    // card.
    if (typeof apiService.handovers?.myReviewQueue !== 'function') return;
    let alive = true;
    apiService.handovers.myReviewQueue()
      .then(r => { if (alive) setRows(r.data?.items || r.data || []); })
      // Silent. Projects may not be enabled for this person at all, and Daily
      // Work must not report a failure for a module they were never offered.
      .catch(() => { if (alive) setRows([]); })
    return () => { alive = false; };
  }, []);

  if (!rows || rows.length === 0) return null;

  // Grouped by project, matching the Projects banner. A flat list of six task
  // titles from two projects reads as six unrelated things.
  const byProject = new Map();
  for (const r of rows) {
    const key = r.handoverId;
    if (!byProject.has(key)) byProject.set(key, { name: r.projectName, items: [] });
    byProject.get(key).items.push(r);
  }

  return (
    <div className="dw-card" style={{ borderLeft: '3px solid #f59e0b' }}>
      <div className="dw-card-head">
        <h2>🔔 Awaiting your review</h2>
        <span className="m">
          {rows.length} {rows.length === 1 ? 'task' : 'tasks'} across{' '}
          {byProject.size} {byProject.size === 1 ? 'project' : 'projects'}
        </span>
      </div>
      <div className="dw-item-body" style={{ paddingTop: 8 }}>
        {[...byProject.entries()].map(([hid, grp]) => (
          <div key={hid} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 3 }}>
              {grp.name}
            </div>
            {grp.items.map(i => (
              <div key={i.playInstanceId}
                   /* 'open-project-task', NOT 'handover-deeplink'.
                      The second is listened for inside HandoverView, which is
                      not mounted while this screen is on — dispatching it from
                      here fires into nothing, silently. App.js listens for
                      this one, changes the route, and then raises the other.
                      dailyWorkProjectLink already uses it for the same reason.

                      No checkProjectLink call first, unlike that component:
                      this row exists because the SERVER put it in the review
                      queue, so the viewer's authority is already established.
                      Re-asking would be asking a different question (does this
                      person have open work here) than the one that produced
                      the row. */
                   onClick={() => window.dispatchEvent(new CustomEvent('open-project-task', {
                     detail: { handoverId: hid, playInstanceId: i.playInstanceId,
                               scope: 'assigned', sub: 'details' } }))}
                   style={{ fontSize: 13, padding: '3px 0', cursor: 'pointer', color: '#1f2937' }}>
                {i.title}
                {i.submittedByName && (
                  <span className="dw-meta" style={{ marginLeft: 6 }}>
                    {/* Names the person, not the status. "Deepika asked to mark
                        it done" tells you who is blocked; "in_review" does
                        not. */}
                    — {i.submittedByName} asked to mark it{' '}
                    {String(i.targetStatus || 'completed').replace(/_/g, ' ')}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MyProjectWork({ me, today, onPosted }) {
  const [items, setItems] = useState([]);
  const [notice, setNotice] = useState(null);
  const [window_, setWindow] = useState('7');
  const isMobile = useIsMobile(768);

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

  const days = (DUE_WINDOWS.find(w => w.key === window_) || DUE_WINDOWS[0]).days;
  const shown = items.filter(i => withinWindow(i, today, days));
  const hidden = items.length - shown.length;
  const overdue = shown.filter(i => i.isOverdue);
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
          {shown.length} of {items.length}
          {overdue.length > 0 && ` · ${overdue.length} overdue`}
        </span>
        <select aria-label="Due within" value={window_}
                onChange={e => setWindow(e.target.value)}
                style={{ width: 'auto', marginLeft: 'auto', fontSize: 13,
                         padding: '4px 8px', alignSelf: 'center' }}>
          {DUE_WINDOWS.map(w => (
            <option key={w.key} value={w.key}>
              {w.days == null ? 'All open tasks' : `Due within ${w.label}`}
            </option>
          ))}
        </select>
      </div>

      {notice && (
        <div className="dw-banner warn" style={{ margin: '10px 12px 0' }}>
          {notice}
          <button className="dw-btn dw-btn-sm" style={{ marginLeft: 10 }}
                  onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {/* Table on a wide screen, stacked rows on a phone — the same
          breakpoint and the same reasoning as ItemTable vs ItemCard above.
          Five columns do not fit 380px, and a stacked row does not let anyone
          scan ten tasks for the one they worked on. */}
      {isMobile ? (
        <div className="dw-daylog">
          {shown.map(i => (
            // canLog only here. On the People screen this same row belongs to
            // somebody else's timeline, and saveDay refuses an entry written
            // for another owner — so the composer is offered on the one screen
            // where the reader is the person who did the work.
            <ProjectItemRow key={i.id} item={i} person={person}
                            period={null} anchorDate={null} filters={null}
                            canLog today={today} onPosted={onPosted}
                            onRefuse={setNotice} />
          ))}
          {shown.length === 0 && (
            <div className="dw-detail-item">
              <div className="dw-meta">Nothing due in this window.</div>
            </div>
          )}
        </div>
      ) : shown.length === 0 ? (
        <div className="dw-detail-item">
          <div className="dw-meta">Nothing due in this window.</div>
        </div>
      ) : (
        <ProjectWorkTable items={shown} person={person} today={today}
                          onRefuse={setNotice} onPosted={onPosted} />
      )}

      {/* Never a dead end. Someone who worked today on a task due in three
          weeks has to be able to reach it, or they fall back to typing a
          free-text item and the link to the project is lost. */}
      {hidden > 0 && (
        <div style={{ padding: '6px 12px 10px' }}>
          <button type="button" className="dw-btn-link" onClick={() => setWindow('all')}>
            {hidden} more further out — show {hidden === 1 ? 'it' : 'them'}
          </button>
        </div>
      )}
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
function DayLog({ day, rows, written, drafts, saved, history, onEdit, me, activityTypes }) {
  // key -> label, for the Activity column. Built once per render rather than
  // scanned per row: a day with six items would otherwise walk the whole
  // vocabulary six times to print six words.
  const activityLabel = (key) =>
    (activityTypes || []).find(t => t.key === key)?.label || null;

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

      {/* ROWS, matching Edit rows.
       *
       * This was a stack of blocks — today as a card with a run-together
       * summary and a nested detail list, then one block per past day — so the
       * same log read one way while writing it and another way while reading
       * it back, and neither lined up with the other.
       *
       * TWO ROW SHAPES IN ONE TABLE, deliberately. Today is known per ITEM,
       * because the drafts are in hand; earlier days come from the history
       * rollup, which is per DAY with the descriptions already joined
       * server-side. Rather than pretend they are the same, each shape fills
       * the columns it can: a past row names its item count where today names
       * the item.
       */}
      <div className="dw-logtable-wrap">
        <table className="dw-logtable">
          {/* The same columns as Edit rows, in the same order. Reading back
              what you wrote should not mean re-learning where things are —
              and the expanded per-item rows below now line up cell for cell
              with the day rows above them, which was the point. */}
          <colgroup>
            <col style={{ width: '11%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '33%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '10%' }} />
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
            {written.length ? written.map((r, i) => (
              <tr key={r.item_id} className="today">
                {/* The date is printed once per day, not once per row: five
                    identical dates down a column is noise, and the blank cells
                    group the day visually without needing a rule. */}
                <td className="dw-logdate">
                  {i === 0 ? <>{formatDateShort(day.entryDate)} <span className="dw-today-tag">today</span></> : ''}
                </td>
                <td className="dw-logitem">
                  {r.title}
                  {/* Stage rides with the item rather than holding a column of
                      its own: it is one short word, and the width it was using
                      is worth more to Activity and Initiative. */}
                  <span className="dw-badge">{stageLabel(drafts[r.item_id]?.dayStage)}</span>
                  {r.evidence_count > 0 && (
                    <span className="dw-badge">{r.evidence_count} evidence</span>
                  )}
                </td>
                <td>
                  {drafts[r.item_id]?.description}
                  {drafts[r.item_id]?.nextSteps && (
                    <div className="dw-meta"><b>Next:</b> {drafts[r.item_id].nextSteps}</div>
                  )}
                </td>
                <td className="dw-col-activity dw-meta">{activityLabel(r.activity_type_key) || '—'}</td>
                <td className="dw-col-initiative dw-meta">{r.anchor_label || r.account_name || '—'}</td>
                <td className="dw-logactions">
                  <button className="dw-btn-link" onClick={() => onEdit(r.item_id)}>Edit</button>
                </td>
              </tr>
            )) : (
              <tr className="today">
                <td className="dw-logdate">
                  {formatDateShort(day.entryDate)} <span className="dw-today-tag">today</span>
                </td>
                <td colSpan={5}>
                  <span className="dw-none">Not logged yet.</span>
                  <button className="dw-btn dw-btn-sm dw-btn-primary" style={{ marginLeft: 10 }}
                          onClick={() => onEdit(rows[0]?.item_id)}>
                    Log today's work
                  </button>
                </td>
              </tr>
            )}

            {past.map(d => <PastDayRow key={d.entry_date} day={d} me={me} activityLabel={activityLabel} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * An earlier day, read-only, as one row — expandable into its items.
 *
 * The row shows the day's descriptions already joined by the rollup, which is
 * the right summary but the wrong place to stop: a day that reads "This is a
 * test This is a test" gives no way to tell which item was which, and backfill
 * makes looking back at earlier days a normal thing to do rather than an
 * archival curiosity.
 *
 * FETCHED ON DEMAND, not with the log. There is one of these per day in the
 * window; requesting every day's items up front would be a request per day for
 * detail almost none of which gets read. Cached once fetched, so collapsing and
 * reopening does not re-request.
 *
 * Uses the SAME endpoint the manager surface uses, scoped to the viewer.
 * getVisibleUserIds always includes the viewer themselves, so this is the
 * person's own data by the same rule that lets a manager see a report's — not
 * a second, member-only path that could drift from it.
 *
 * Still read-only. Editing an earlier day is what the date navigation above is
 * for: step back to it and the full Edit rows grid applies, within the window
 * the server allows. Editing from a summary row would be a second way to write
 * the same entry, bypassing that window check.
 */
function PastDayRow({ day, me, activityLabel }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const long = day.work_done && day.work_done.length > 160;

  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (items || !me) return;
    setBusy(true);
    setFailed(false);
    try {
      const { data } = await apiService.dailyWork.teamDayDetail({ user: me, date: day.entry_date });
      setItems(data || []);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <React.Fragment>
      <tr>
        <td className="dw-logdate">{formatDateShort(day.entry_date)}</td>
        <td className="dw-logitem muted">
          {day.item_count} {day.item_count === 1 ? 'item' : 'items'}
          {day.evidence_count > 0 && (
            <span className="dw-badge">{day.evidence_count} evidence</span>
          )}
        </td>
        {/* The clamp goes on an inner div, never the cell. .dw-clamp sets
            display:-webkit-box, and a cell whose display is overridden drops
            out of the table layout — the column widths stop applying. */}
        <td>
          <div className={open || !long ? '' : 'dw-clamp'}>{day.work_done}</div>
        </td>
        {/* Empty on the DAY row, filled on the item rows below. A day rolls up
            several items that may carry different activities and different
            initiatives, so there is no single value to put here — and inventing
            one ("mixed", or the first item's) would be a claim the data does
            not make. */}
        <td className="dw-col-activity" />
        <td className="dw-col-initiative" />
        <td className="dw-logactions">
          <button className="dw-btn-link" onClick={toggle} aria-expanded={open}>
            {open ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>

      {/* ONE ROW PER ITEM, in the same six columns as everything else. These
          were free-form blocks inside a colSpan cell, which put an item's title
          under the Item header but its description under it rather than beside
          it — the columns stopped meaning anything the moment a row was
          expanded. */}
      {open && busy && (
        <tr className="dw-item-row"><td /><td colSpan={5} className="dw-item-status">Loading…</td></tr>
      )}
      {open && failed && (
        <tr className="dw-item-row">
          <td /><td colSpan={5} className="dw-item-status">Could not load that day&apos;s items.</td>
        </tr>
      )}
      {open && !busy && !failed && items && items.length === 0 && (
        <tr className="dw-item-row">
          <td /><td colSpan={5} className="dw-item-status">No items recorded for that day.</td>
        </tr>
      )}
      {open && !busy && !failed && (items || []).map(item => (
        <tr className="dw-item-row" key={item.entry_id}>
          <td />
          <td className="dw-logitem">
            {item.title}
            <span className="dw-badge">{item.day_stage.replace(/_/g, ' ')}</span>
            {item.evidence_count > 0 && (
              <span className="dw-badge">{item.evidence_count} evidence</span>
            )}
          </td>
          <td>
            {item.description}
            {item.next_steps && (
              <div className="dw-meta"><b>Next:</b> {item.next_steps}</div>
            )}
          </td>
          {/* activity_label comes from the server now; activityLabel() is the
              fallback for a key whose type has since been deleted, which the
              join would return as NULL. */}
          <td className="dw-col-activity dw-meta">
            {item.activity_label || activityLabel(item.activity_type_key) || '—'}
          </td>
          <td className="dw-col-initiative dw-meta">
            {item.anchor_label || item.account_name || '—'}
          </td>
          <td className="dw-logactions" />
        </tr>
      ))}
    </React.Fragment>
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
/**
 * The item name, renamed in place.
 *
 * Click the name, type, press Enter. Escape abandons; blur saves, because a
 * click elsewhere after typing means the edit is finished, not discarded.
 *
 * REPLACES the Item settings block that used to sit in the details panel. That
 * put the field a long way from the name it edits and, being inside an
 * expanding row, pushed every item below it down the screen to rename one.
 *
 * An empty name is refused rather than saved: title is NOT NULL on
 * daily_work_items, and an item with a blank name cannot be picked out of a
 * list afterwards. Reverting to the current value is the least surprising
 * response — nothing was typed, so nothing changes.
 */
function InlineTitle({ title, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title || '');

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next) { setDraft(title || ''); return; }
    if (next === (title || '')) return;
    onSave(next);
  };

  if (!editing) {
    return (
      <button type="button" className="dw-grid-title dw-grid-title-btn"
              title="Click to rename"
              onClick={() => { setDraft(title || ''); setEditing(true); }}>
        {title}
      </button>
    );
  }
  return (
    <input
      className="dw-grid-title-input"
      autoFocus value={draft} aria-label="Item name"
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { setDraft(title || ''); setEditing(false); }
      }}
    />
  );
}

function ItemTable({ rows, drafts, rowErrors, activityTypes, expanded, onExpand,
                     setDraft, setItemActivity, retireItem, onEvidence, entryDate,
                     anchors, onPatchItem }) {
  // Which row has had "+ Next steps" clicked. A row whose draft already has
  // next steps shows the field regardless, so this only tracks the empty ones
  // someone has opened.
  const [nextOpenFor, setNextOpenFor] = useState(null);
  return (
    <div className="dw-grid-wrap">
      <table className="dw-grid">
        <colgroup>
          <col style={{ width: '7%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: '30%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '4%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Item</th>
            <th>What did you do today</th>
            <th>Activity</th>
            <th>Initiative</th>
            <th>Stage</th>
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
            const nextOpen    = nextOpenFor === row.item_id;
            // 2026_136. A row owned by a project task: the title, the
            // initiative and the two closing stages all belong to the task,
            // and the server refuses each of them here. The controls are
            // hidden rather than left to fail, and the composer on the task
            // (or on the My project work card above) is where the work is
            // actually logged.
            const linked      = !!row.play_instance_id;
            const stages      = linked ? LINKED_STAGES : STAGES;

            return (
              <React.Fragment key={row.item_id}>
                <tr className={stage === 'dropped' ? 'dropped' : ''}>
                  {/* The date being logged. Every row carries the same one —
                      Edit rows only ever writes today — so this is orientation
                      rather than data: the grid otherwise gives no clue which
                      day the typing lands on, and the heading scrolls away. */}
                  <td className="dw-grid-date">{formatDateShort(entryDate)}</td>

                  <td className="dw-grid-item">
                    {/* Click to rename, in place. It was a text field in a
                        settings block below the row, which meant renaming
                        pushed every other row down and put the field a long way
                        from the name it edits.

                        NOT offered on a task-linked row (2026_136): the title
                        belongs to the project task, updateItem refuses to
                        change it, and an editor that always fails is worse
                        than no editor. */}
                    {linked
                      ? <span className="dw-grid-title">{row.title}</span>
                      : <InlineTitle title={row.title}
                                     onSave={next => onPatchItem(row.item_id, { title: next })} />}
                    {linked && <span className="dw-badge">project task</span>}
                    {/* Inline with the title rather than on their own line, so
                        the row stays one line deep. target_date is back: it was
                        on the card header and dropping it lost the only place a
                        one-off item's due date was visible. */}
                    {row.kind === 'assigned' && !linked && <span className="dw-badge assigned">one-off</span>}
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
                    {/* Next steps lost its column to Initiative and lives here
                        instead, under the description it follows on from. It
                        is optional and usually empty, so an always-present
                        column spent 14% of the width on blank boxes. Shown
                        when it has content or when asked for; otherwise one
                        small link. */}
                    {(draft.nextSteps || nextOpen) ? (
                      <textarea
                        aria-label={`Next steps for ${row.title}`}
                        className="dw-grid-ta dw-grid-next"
                        rows={1}
                        autoFocus={nextOpen && !draft.nextSteps}
                        value={draft.nextSteps || ''}
                        placeholder="What happens tomorrow?"
                        onChange={e => setDraft(row.item_id, { nextSteps: e.target.value })}
                      />
                    ) : (
                      <button type="button" className="dw-btn-link dw-grid-next-add"
                              onClick={() => setNextOpenFor(row.item_id)}>
                        + Next steps
                      </button>
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

                  {/* Which initiative this item feeds. It was not shown at all
                      — only account_name, which a standing initiative never
                      has — so the one thing the anchor exists to record was
                      invisible on the row that records it. Editable in place
                      for the same reason the title is. */}
                  <td>
                    {linked ? (
                      // The anchor is the task's project and updateItem
                      // refuses to move it, so this is a fact rather than a
                      // choice. anchor_label is resolved live by getDay, so a
                      // renamed initiative reads under its current name.
                      <span className="dw-grid-anchor">{row.anchor_label || '—'}</span>
                    ) : (
                    <select aria-label={`Initiative for ${row.title}`}
                            value={row.anchor_kind && row.anchor_id
                              ? `${row.anchor_kind}:${row.anchor_id}` : ''}
                            onChange={e => {
                              const [kind, id] = e.target.value ? e.target.value.split(':') : [null, null];
                              // Sent as a pair: updateItem re-resolves
                              // account_id only when the anchor is in the
                              // patch, so one without the other would leave
                              // the account pointing at the old anchor.
                              onPatchItem(row.item_id, {
                                anchorKind: kind,
                                anchorId: id ? Number(id) : null,
                              });
                            }}>
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
                    )}
                  </td>

                  <td>
                    <select aria-label={`Stage for ${row.title}`} value={stage}
                            onChange={e => setDraft(row.item_id, { dayStage: e.target.value })}>
                      {stages.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    {linked && (
                      <div className="dw-meta">Finish it on the task</div>
                    )}
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
                {(row.play_instance_id ? LINKED_STAGES : STAGES)
                  .map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {/* Same rule as the grid. The card is the phone view of the same
                  row, and offering a stage here that the desktop hides would
                  make the refusal depend on which device someone opened. */}
              {row.play_instance_id && (
                <div className="dw-item-status">Finish it on the task.</div>
              )}
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
/**
 * Shift a YYYY-MM-DD string by whole days, staying a calendar date.
 *
 * Built the same component-wise way as the formatters: a local Date, shifted by
 * setDate, read back through local getters. Doing it with new Date(str) would
 * parse as UTC and hand back the wrong day for anyone west of Greenwich, and
 * doing it with millisecond arithmetic would drift by an hour across a DST
 * boundary — which is precisely the week someone is most likely to be writing
 * up an earlier day.
 */
function addDaysStr(dateStr, n) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const at = new Date(y, m - 1, d);
  at.setDate(at.getDate() + n);
  const pad = v => String(v).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

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
