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
import DailyWorkTeamView from './DailyWorkTeamView';
import useIsMobile from './useIsMobile';
import './DailyWork.css';

// Who is looking. The team tab and the rate both need it, and the rollup comes
// back keyed by user_id with no indication of which row is yours.
const currentUserId = () => {
  try { return JSON.parse(localStorage.getItem('user') || '{}').id || null; }
  catch { return null; }
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

export default function DailyWorkView() {
  const isMobile = useIsMobile(768);

  const [tab, setTab] = useState('day');        // 'day' | 'team'
  const [mode, setMode] = useState('log');
  const [me] = useState(currentUserId);
  const [myRate, setMyRate] = useState(null);  // my row from the rollup
  const [hasReports, setHasReports] = useState(false);
  const [history, setHistory] = useState([]);  // person-days before today
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
      .catch(() => {});
  }, [me]);

  // The last week of my own days, so the log reads as a log rather than as a
  // single row. Same endpoint the manager uses, scoped to myself — it is gated
  // by the module, not by having reports.
  useEffect(() => {
    if (!me) return;
    apiService.dailyWork.teamLog({ users: String(me) })
      .then(({ data }) => setHistory(data.rows || []))
      .catch(() => {});
  }, [me, saved]);

  const loadActivityTypes = useCallback(() => {
    apiService.dailyWork.listActivityTypes()
      .then(({ data }) => setActivityTypes(data || []))
      .catch(() => {});
  }, []);
  useEffect(() => { loadActivityTypes(); }, [loadActivityTypes]);

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
      {hasReports && (
        <div className="dw-toggle" style={{ marginBottom: 16 }} role="group" aria-label="My day or my team">
          <button type="button" aria-pressed={tab === 'day'} onClick={() => setTab('day')}>
            My day
          </button>
          <button type="button" aria-pressed={tab === 'team'} onClick={() => setTab('team')}>
            My team
          </button>
        </div>
      )}

      {tab === 'team' ? <DailyWorkTeamView /> : (
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
            ) : (
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
                  />
                ))}
              </div>
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

function ItemCard({ row, draft, error, isOpen, onToggle, onChange, onEvidence, collapsible,
                   activityTypes, onActivity }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceText, setEvidenceText] = useState('');
  const [attaching, setAttaching] = useState(false);

  const description = draft.description || '';
  const length = description.length;
  const overSoft = length >= SOFT_LIMIT;
  const overHard = length > HARD_LIMIT;
  const stage = draft.dayStage || 'in_progress';
  const closed = stage === 'completed' || stage === 'dropped';

  const attach = async () => {
    if (!evidenceText.trim() || !row.entry_id) return;
    setAttaching(true);
    try {
      await apiService.dailyWork.attachEvidence(row.entry_id, { note: evidenceText.trim() });
      setEvidenceText('');
      setEvidenceOpen(false);
      onEvidence();
    } finally {
      setAttaching(false);
    }
  };

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

            <div className="dw-field" style={{ gridColumn: '1 / -1' }}>
              <label>Evidence</label>
              {!row.entry_id ? (
                <div className="dw-item-status">Save the day first, then you can attach to it.</div>
              ) : (
                <>
                  {row.evidence_count > 0 && (
                    <div className="dw-ev">
                      <div className="dw-ev-item">
                        <span className="k">attached</span>
                        {row.evidence_count} {row.evidence_count === 1 ? 'item' : 'items'}
                      </div>
                    </div>
                  )}
                  {evidenceOpen ? (
                    <>
                      <input type="text" value={evidenceText}
                             placeholder="Paste a link, or write one sentence"
                             onChange={e => setEvidenceText(e.target.value)} />
                      <div className="dw-addform-actions">
                        <button className="dw-btn dw-btn-sm dw-btn-primary"
                                onClick={attach} disabled={attaching}>
                          {attaching ? 'Attaching…' : 'Attach'}
                        </button>
                        <button className="dw-btn dw-btn-sm" onClick={() => setEvidenceOpen(false)}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <button className="dw-btn dw-btn-sm" onClick={() => setEvidenceOpen(true)}>
                      Attach evidence
                    </button>
                  )}
                  {closed && !row.evidence_count && (
                    <div className="dw-item-status">
                      Closing without evidence — your manager sees this as unverified.
                    </div>
                  )}
                </>
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

function groupAnchors(anchors) {
  const labels = {
    customer_project: 'Customer projects',
    internal_project: 'Internal projects',
    account: 'Accounts',
    campaign: 'Campaigns',
  };
  const groups = {};
  (anchors || []).forEach(a => {
    (groups[a.group_key] = groups[a.group_key] || []).push(a);
  });
  return Object.keys(groups).map(k => ({ label: labels[k] || k, options: groups[k] }));
}

function readError(err, fallback) {
  return err?.response?.data?.error || err?.message || fallback;
}
