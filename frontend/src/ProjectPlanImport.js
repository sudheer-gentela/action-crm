// ProjectPlanImport.js
//
// Paste a plan from a spreadsheet, map the columns, check what will be
// created, then commit.
//
// ── THE SHAPE, AND WHY IT IS THREE STEPS ─────────────────────────────
//
//   1  PASTE   a tab-separated block, which is what copying from Excel,
//              Google Sheets or Numbers puts on the clipboard
//   2  MAP     say which column is which — never guessed silently
//   3  PREVIEW every row exactly as it will be created, with the computed
//              dates EDITABLE, then commit
//
// The preview is not a confirmation dialog. It is the last point at which the
// plan is cheap to change: once committed these are real tasks that people
// will log work against, and on a frozen plan their dates become baselines.
// So it shows what was read, what was assumed, and what will be created — and
// lets every date be corrected before any of that is true.
//
// ── COLUMN MAPPING IS EXPLICIT ───────────────────────────────────────
//
// Headers are used to PRE-SELECT the mapping, never to decide it. A sheet with
// "Owner" meaning a team rather than a person, or "Due" meaning a milestone
// rather than a task date, would import silently wrong — and the failure would
// only surface weeks later as a variance report nobody trusts. Pre-selecting
// costs a glance; guessing costs the plan.

import React, { useState, useMemo, useCallback } from 'react';
import { apiService } from './apiService';

const FIELDS = [
  { key: 'ignore',      label: 'Ignore' },
  { key: 'phase',       label: 'Phase / stage' },
  { key: 'title',       label: 'Task' },
  { key: 'duration',    label: 'Duration' },
  { key: 'dueDate',     label: 'Due date' },
  { key: 'description', label: 'Description' },
  { key: 'owner',       label: 'Owner' },
];

// What a header has to look like to pre-select a field. Deliberately narrow:
// a near-miss that pre-selects the wrong column is worse than one that
// pre-selects nothing, because the person reads the mapping row as confirmed
// rather than as a suggestion.
const HEADER_HINTS = [
  [/^(phase|stage|module|workstream|group)/i, 'phase'],
  [/^(task|activity|step|deliverable|item|work)/i, 'title'],
  [/^(duration|days|effort|estimate|est)/i, 'duration'],
  [/^(due|end|finish|target|deadline|date)/i, 'dueDate'],
  [/^(desc|detail|note|scope)/i, 'description'],
  [/^(owner|assignee|responsible|who|resource)/i, 'owner'],
];

/**
 * Split pasted text into a grid.
 *
 * TABS FIRST, because that is what a spreadsheet actually puts on the
 * clipboard. Comma is the fallback for someone pasting a CSV file's contents,
 * and it is only used when no line contains a tab — a plan with commas in its
 * task descriptions would otherwise be shredded into the wrong columns.
 */
function parsePaste(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
    .filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  const delimiter = lines.some(l => l.includes('\t')) ? '\t' : ',';
  return lines.map(l => l.split(delimiter).map(c => c.trim()));
}

/** Does this row look like headers rather than data? */
function looksLikeHeader(cells) {
  if (!cells) return false;
  const hits = cells.filter(c => HEADER_HINTS.some(([re]) => re.test(c))).length;
  return hits >= 2;
}

/**
 * Match an owner cell to a real user.
 *
 * Exact email, then exact full name, then a unique first-name match. A first
 * name matching two people resolves to NOBODY rather than to the first one
 * found: a task silently assigned to the wrong Priya is worse than an
 * unassigned task, which is at least visible.
 */
function matchOwner(cell, users) {
  const text = String(cell || '').trim().toLowerCase();
  if (!text) return null;
  const name = u => (u.name || `${u.first_name || ''} ${u.last_name || ''}`).trim().toLowerCase();

  const byEmail = (users || []).filter(u => (u.email || '').toLowerCase() === text);
  if (byEmail.length === 1) return byEmail[0].id;

  const byFull = (users || []).filter(u => name(u) === text);
  if (byFull.length === 1) return byFull[0].id;

  const byFirst = (users || []).filter(u => (u.first_name || '').toLowerCase() === text);
  if (byFirst.length === 1) return byFirst[0].id;

  return null;
}

const S = {
  panel:  { border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, background: '#fff' },
  head:   { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
  h:      { margin: 0, fontSize: 14, color: '#374151', fontWeight: 700 },
  note:   { fontSize: 11, color: '#6b7280' },
  ta:     { width: '100%', minHeight: 150, fontSize: 12, fontFamily: 'ui-monospace, monospace',
            padding: 8, borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box' },
  primary:{ fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: 'none',
            background: '#0369a1', color: '#fff', cursor: 'pointer' },
  quiet:  { fontSize: 12, padding: '6px 12px', borderRadius: 6, fontWeight: 600,
            border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer' },
  select: { fontSize: 11, padding: '3px 5px', borderRadius: 4, border: '1px solid #d1d5db',
            width: '100%' },
  input:  { fontSize: 11, padding: '3px 5px', borderRadius: 4, border: '1px solid #d1d5db' },
  table:  { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:     { textAlign: 'left', fontSize: 10, fontWeight: 700, color: '#94a3b8',
            letterSpacing: 0.4, textTransform: 'uppercase', padding: '6px 8px',
            borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' },
  td:     { padding: '6px 8px', borderTop: '1px solid #f3f4f6', verticalAlign: 'top' },
  warn:   { fontSize: 11, color: '#92400e', background: '#fffbeb',
            border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px' },
  err:    { fontSize: 12, color: '#991b1b', background: '#fef2f2',
            border: '1px solid #fecaca', borderRadius: 6, padding: '8px 10px' },
  ok:     { fontSize: 12, color: '#065f46', background: '#ecfdf5',
            border: '1px solid #a7f3d0', borderRadius: 6, padding: '8px 10px' },
};

export default function ProjectPlanImport({ handoverId, users, onClose, onImported }) {
  const [step, setStep] = useState('paste');     // paste | map | preview | done
  const [raw, setRaw] = useState('');
  const [grid, setGrid] = useState([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState([]);    // column index -> field key
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState(null);
  const [dates, setDates] = useState({});        // row index -> edited date
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const read = () => {
    const parsed = parsePaste(raw);
    if (parsed.length === 0) { setError('Nothing to read — paste the rows above.'); return; }
    const header = looksLikeHeader(parsed[0]);
    const width = Math.max(...parsed.map(r => r.length));
    const guess = Array.from({ length: width }, (_, i) => {
      if (!header) return i === 0 ? 'title' : 'ignore';
      const cell = parsed[0][i] || '';
      const hit = HEADER_HINTS.find(([re]) => re.test(cell));
      return hit ? hit[1] : 'ignore';
    });
    setGrid(parsed);
    setHasHeader(header);
    setMapping(guess);
    setError('');
    setStep('map');
  };

  const bodyRows = useMemo(
    () => (hasHeader ? grid.slice(1) : grid), [grid, hasHeader]);

  /** The pasted grid as the shape the server's preview expects. */
  const toRows = useCallback(() => bodyRows.map(cells => {
    const get = (field) => {
      const i = mapping.indexOf(field);
      return i >= 0 ? (cells[i] || '') : '';
    };
    return {
      phase: get('phase'),
      title: get('title'),
      duration: get('duration'),
      dueDate: get('dueDate'),
      description: get('description'),
      ownerUserId: matchOwner(get('owner'), users),
    };
  }), [bodyRows, mapping, users]);

  const runPreview = async (nextStart = startDate) => {
    setBusy(true); setError('');
    try {
      const { data } = await apiService.handovers.previewPlanImport(handoverId,
        { rows: toRows(), startDate: nextStart });
      setPreview(data);
      setDates({});
      setStep('preview');
    } catch (err) {
      setError(err?.response?.data?.error?.message
        || err?.response?.data?.error
        || 'Could not read that plan.');
    } finally { setBusy(false); }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const rows = preview.rows.filter(r => !r.skip).map(r => ({
        phase: r.phase,
        title: r.title,
        description: r.description,
        ownerUserId: r.ownerUserId,
        dueDate: dates[r.index] !== undefined ? dates[r.index] : r.dueDate,
        isGate: r.isGate,
      }));
      const { data } = await apiService.handovers.importPlan(handoverId, rows);
      setResult(data);
      setStep('done');
      onImported?.();
    } catch (err) {
      setError(err?.response?.data?.error?.message
        || err?.response?.data?.error
        || 'Could not create those tasks.');
    } finally { setBusy(false); }
  };

  const mappedFields = mapping.filter(m => m !== 'ignore');
  const hasTitle = mappedFields.includes('title');
  const duplicate = FIELDS.map(f => f.key)
    .filter(k => k !== 'ignore' && mapping.filter(m => m === k).length > 1);

  return (
    <div style={S.panel}>
      <div style={S.head}>
        <h4 style={S.h}>Import a plan</h4>
        <span style={S.note}>
          {step === 'paste'   && 'Paste the rows from your spreadsheet'}
          {step === 'map'     && 'Say which column is which'}
          {step === 'preview' && 'Check what will be created — dates are editable'}
          {step === 'done'    && 'Done'}
        </span>
        <button type="button" style={{ ...S.quiet, marginLeft: 'auto' }} onClick={onClose}>
          Close
        </button>
      </div>

      {error && <div style={{ ...S.err, marginBottom: 10 }}>{error}</div>}

      {/* ── 1. paste ─────────────────────────────────────────────────── */}
      {step === 'paste' && (
        <>
          <p style={{ ...S.note, marginTop: 0 }}>
            Select the rows in Excel or Google Sheets and paste them here. Include
            the header row if you have one. Phase, Task, Duration, Description and
            Owner in any order — you map them in the next step.
          </p>
          <textarea style={S.ta} value={raw} placeholder={
            'Phase\tTask\tDuration\tOwner\n'
            + 'Core model\tBase detection pipeline\t5 days\tpriya@example.com\n'
            + 'Core model\tInitial training\t3\tManikanta'}
            onChange={e => setRaw(e.target.value)} />
          <div style={{ marginTop: 10 }}>
            <button type="button" style={S.primary} onClick={read}>Read the rows</button>
          </div>
        </>
      )}

      {/* ── 2. map ───────────────────────────────────────────────────── */}
      {step === 'map' && (
        <>
          <div style={{ ...S.note, marginBottom: 8 }}>
            {grid.length} line{grid.length === 1 ? '' : 's'} read.
            {' '}
            <label style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={hasHeader}
                     onChange={e => setHasHeader(e.target.checked)} />
              {' '}the first line is a header
            </label>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {mapping.map((m, i) => (
                    <th key={i} style={S.th}>
                      <select style={S.select} value={m}
                              aria-label={`Column ${i + 1}`}
                              onChange={e => setMapping(
                                mapping.map((x, j) => (j === i ? e.target.value : x)))}>
                        {FIELDS.map(f => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                      {hasHeader && (
                        <div style={{ ...S.note, marginTop: 3, textTransform: 'none' }}>
                          {grid[0][i] || <em>blank</em>}
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.slice(0, 5).map((cells, r) => (
                  <tr key={r}>
                    {mapping.map((m, i) => (
                      <td key={i} style={{ ...S.td, color: m === 'ignore' ? '#9ca3af' : '#374151' }}>
                        {cells[i] || ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {bodyRows.length > 5 && (
            <div style={{ ...S.note, marginTop: 6 }}>
              …and {bodyRows.length - 5} more. All of them come through to the next step.
            </div>
          )}

          {!hasTitle && (
            <div style={{ ...S.warn, marginTop: 10 }}>
              One column has to be the Task — that is the only field a row cannot do without.
            </div>
          )}
          {duplicate.length > 0 && (
            <div style={{ ...S.warn, marginTop: 10 }}>
              Two columns are both mapped to the same field. Only one can be used.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" style={S.quiet} onClick={() => setStep('paste')}>Back</button>
            <label style={S.note}>
              Start the schedule on{' '}
              <input type="date" style={S.input} value={startDate}
                     onChange={e => setStartDate(e.target.value)} />
            </label>
            <button type="button" style={S.primary}
                    disabled={busy || !hasTitle || duplicate.length > 0}
                    onClick={() => runPreview()}>
              {busy ? 'Working…' : 'Work out the dates'}
            </button>
          </div>
          <div style={{ ...S.note, marginTop: 6 }}>
            Tasks are scheduled one after another from that date, skipping weekends and
            your org's holidays. Every date is editable in the next step, and a row that
            already has a date keeps it.
          </div>
        </>
      )}

      {/* ── 3. preview ───────────────────────────────────────────────── */}
      {step === 'preview' && preview && (
        <>
          <div style={{ ...S.note, marginBottom: 8 }}>
            <b>{preview.summary.willCreate}</b> tasks
            {preview.newStages.length > 0 && <> · <b>{preview.newStages.length}</b> new stages</>}
            {preview.summary.skipped > 0 && <> · {preview.summary.skipped} skipped</>}
            {preview.summary.unassigned > 0 && <> · {preview.summary.unassigned} unassigned</>}
            {preview.summary.lastDue && <> · runs to {preview.summary.lastDue}</>}
          </div>

          {preview.planFrozen && (
            <div style={{ ...S.warn, marginBottom: 10 }}>
              This plan is already committed, so each task you create now is baselined to
              the date you give it here. Get the dates right before importing — changing one
              afterwards is recorded as slip.
            </div>
          )}
          {preview.summary.unassigned > 0 && (
            <div style={{ ...S.warn, marginBottom: 10 }}>
              {preview.summary.unassigned} row{preview.summary.unassigned === 1 ? '' : 's'} could
              not be matched to a person. They import unassigned — an owner name that matches
              two people is left blank rather than guessed. You can set owners on the checklist
              afterwards.
            </div>
          )}

          <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Task</th>
                  <th style={S.th}>Phase</th>
                  <th style={S.th}>Days</th>
                  <th style={S.th}>Due</th>
                  <th style={S.th}>Owner</th>
                  <th style={S.th}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map(r => {
                  const owner = (users || []).find(u => u.id === r.ownerUserId);
                  return (
                    <tr key={r.index} style={{ opacity: r.skip ? 0.45 : 1 }}>
                      <td style={S.td}>
                        {r.title || <em style={{ color: '#991b1b' }}>no task name</em>}
                      </td>
                      <td style={S.td}>
                        {r.phase || <span style={{ color: '#9ca3af' }}>—</span>}
                        {r.stageIsNew && <span style={{ ...S.note, marginLeft: 4 }}>new</span>}
                      </td>
                      <td style={S.td}>{r.durationDays}</td>
                      <td style={S.td}>
                        {r.skip ? '—' : (
                          <input type="date" style={S.input}
                                 aria-label={`Due date for ${r.title}`}
                                 value={dates[r.index] !== undefined ? dates[r.index] : (r.dueDate || '')}
                                 onChange={e => setDates({ ...dates, [r.index]: e.target.value })} />
                        )}
                      </td>
                      <td style={S.td}>
                        {owner
                          ? (owner.name || `${owner.first_name || ''} ${owner.last_name || ''}`.trim())
                          : <span style={{ color: '#9ca3af' }}>unassigned</span>}
                      </td>
                      <td style={{ ...S.td, ...S.note }}>
                        {r.notes.length ? r.notes.join('; ') : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" style={S.quiet} onClick={() => setStep('map')}>Back</button>
            <label style={S.note}>
              Reschedule from{' '}
              <input type="date" style={S.input} value={startDate}
                     onChange={e => { setStartDate(e.target.value); runPreview(e.target.value); }} />
            </label>
            <button type="button" style={S.primary}
                    disabled={busy || preview.summary.willCreate === 0}
                    onClick={commit}>
              {busy ? 'Creating…' : `Create ${preview.summary.willCreate} tasks`}
            </button>
          </div>
        </>
      )}

      {/* ── done ─────────────────────────────────────────────────────── */}
      {step === 'done' && result && (
        <div style={S.ok}>
          Created {result.tasksCreated} task{result.tasksCreated === 1 ? '' : 's'}
          {result.stagesCreated > 0 && ` and ${result.stagesCreated} stage${result.stagesCreated === 1 ? '' : 's'}`}.
          {result.baselined && ' They are baselined to the dates you set.'}
          {' '}They are on the checklist now.
        </div>
      )}
    </div>
  );
}
