import React, { useState, useRef, useCallback, useMemo } from 'react';
import { csvParse, IMPORT_FIELDS } from './csvUtils';

/**
 * CSVImportModal — shared 4-step import dialog for Accounts, Contacts, Deals
 *
 * Props:
 *   entity      — 'accounts' | 'contacts' | 'deals' | 'prospects'
 *   onImport    — async (rows, opts) => { imported, updated, errors } — calls bulk API.
 *                 opts = { mode, moveExistingIds }
 *   onClose     — () => void
 *   accounts    — array of existing accounts (for name→id matching in contacts/deals)
 *   supportsUpsert    — when true, shows an "update existing" toggle on preview
 *   upsertMatchLabel  — human label for the match key (e.g. "LinkedIn URL")
 *   campaignId        — when set, enables the conflicts step (already-in-campaign /
 *                       already-in-sequence check) before import
 *   campaignName      — display name of the target campaign
 *   onPreflight       — async (rows, campaignId) => { rows:[...], summary } — calls
 *                       /prospects/bulk-preflight. Required for the conflicts step.
 */
export default function CSVImportModal({ entity, onImport, onClose, accounts = [], supportsUpsert = false, upsertMatchLabel = 'LinkedIn URL', campaignId = null, campaignName = '', onPreflight = null }) {
  const fields = useMemo(() => IMPORT_FIELDS[entity] || [], [entity]);
  const entityLabel = entity.charAt(0).toUpperCase() + entity.slice(1);

  // Steps: 'upload' → 'mapping' → 'preview' → ['conflicts'] → 'importing' → 'result'
  const [step, setStep] = useState('upload');
  const [fileName, setFileName] = useState('');
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvRows, setCsvRows] = useState([]);
  const [mapping, setMapping] = useState({});       // fieldKey → csvColumnIndex
  const [validationErrors, setValidationErrors] = useState([]); // [{row, field, message}]
  const [mappedRows, setMappedRows] = useState([]);  // final objects
  const [result, setResult] = useState(null);        // { imported, updated, errors }
  // 'insert' = add new only; 'upsert' = update existing matches by the match key.
  const [mode, setMode] = useState('insert');
  // Conflicts step state.
  const [preflight, setPreflight] = useState(null);      // { rows, summary } from API
  const [preflightLoading, setPreflightLoading] = useState(false);
  // Set when the preflight check fails and import proceeds without it —
  // surfaced on the result step so the bypass is never silent.
  const [preflightWarning, setPreflightWarning] = useState(null);
  const [decisions, setDecisions] = useState({});        // existingId → 'skip' | 'move'

  // Whether the conflicts step applies: targeting a campaign, in insert mode,
  // with a preflight function available.
  const conflictsEnabled = !!campaignId && !!onPreflight && mode === 'insert';

  const fileRef = useRef();

  // ── Step 1: Upload ────────────────────────────────────────────────────────
  const handleFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Guard: csvParse runs on the main thread — a very large file freezes the
    // tab. 10MB is far above any realistic prospect/contact import.
    if (file.size > 10 * 1024 * 1024) {
      alert('File is too large (max 10MB). Split the CSV and import in batches.');
      e.target.value = '';
      return;
    }
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const { headers, rows } = csvParse(text);
      setCsvHeaders(headers);
      setCsvRows(rows);

      // Auto-map: try to match CSV headers to field labels / keys
      const autoMap = {};
      fields.forEach((f) => {
        const idx = headers.findIndex(h => {
          const hLower = h.toLowerCase().replace(/[^a-z0-9]/g, '');
          const lLower = f.label.toLowerCase().replace(/[^a-z0-9]/g, '');
          const kLower = f.key.toLowerCase().replace(/[^a-z0-9]/g, '');
          // Very short keys (e.g. "id") only match exactly — the substring
          // fallback would otherwise grab "paid", "candidate id", etc.
          if (kLower.length <= 3) return hLower === lLower || hLower === kLower;
          return hLower === lLower || hLower === kLower || hLower.includes(kLower) || kLower.includes(hLower);
        });
        if (idx >= 0) autoMap[f.key] = idx;
      });
      setMapping(autoMap);
      setStep('mapping');
    };
    reader.readAsText(file);
  }, [fields]);

  // ── Step 2: Validate mapping & build rows ─────────────────────────────────
  const handleValidate = useCallback(() => {
    const errors = [];
    const rows = [];

    // Build an account name→id lookup (case-insensitive). Guard against
    // accounts with a null/empty name — one bad record shouldn't kill validation.
    const acctMap = {};
    accounts.forEach(a => {
      if (a?.name) acctMap[a.name.toLowerCase()] = a.id;
      if (a?.domain) acctMap[a.domain.toLowerCase()] = a.id;
    });

    csvRows.forEach((csvRow, rowIdx) => {
      const obj = {};
      let hasData = false;

      fields.forEach(f => {
        const colIdx = mapping[f.key];
        let val = colIdx !== undefined && colIdx !== -1 ? (csvRow[colIdx] || '').trim() : '';

        if (f.required && !val) {
          errors.push({ row: rowIdx + 2, field: f.label, message: `"${f.label}" is required` });
        }

        if (val) hasData = true;

        // Account ID resolution: try numeric first, then name match
        if (f.key === 'accountId' && val) {
          const asNum = parseInt(val);
          if (!isNaN(asNum) && String(asNum) === val) {
            val = asNum;
          } else {
            const matched = acctMap[val.toLowerCase()];
            if (matched) {
              val = matched;
            } else {
              errors.push({ row: rowIdx + 2, field: f.label, message: `No matching account: "${val}"` });
              val = null;
            }
          }
        }

        // Numeric coercion for value/probability
        if (f.key === 'value' && val) {
          const n = parseFloat(String(val).replace(/[$,]/g, ''));
          if (isNaN(n)) {
            errors.push({ row: rowIdx + 2, field: f.label, message: `Invalid number: "${val}"` });
          } else {
            val = n;
          }
        }
        if (f.key === 'probability' && val) {
          const n = parseInt(String(val).replace('%', ''));
          if (isNaN(n)) {
            errors.push({ row: rowIdx + 2, field: f.label, message: `Invalid number: "${val}"` });
          } else {
            val = Math.min(100, Math.max(0, n));
          }
        }

        // Note: explicit empty/null check — `val || undefined` would also drop
        // legitimate numeric zeros (deal value 0, probability 0%).
        obj[f.key] = (val === '' || val === null || val === undefined) ? undefined : val;
      });

      if (hasData) rows.push(obj);
    });

    setValidationErrors(errors);
    setMappedRows(rows);
    setStep('preview');
  }, [csvRows, mapping, fields, accounts]);

  // ── Step 4: Import ────────────────────────────────────────────────────────
  const doImport = useCallback(async (opts) => {
    setStep('importing');
    try {
      const res = await onImport(mappedRows, { mode, ...opts });
      setResult(res);
      setStep('result');
    } catch (err) {
      setResult({ imported: 0, errors: [{ row: 0, message: err.message }] });
      setStep('result');
    }
  }, [mappedRows, onImport, mode]);

  // ── Optional Step 3.5: Conflicts preflight ───────────────────────────────
  // Runs when leaving preview if a campaign is targeted. Classifies each row
  // and lands on the conflicts step if any rows already exist in another
  // campaign or active sequence; otherwise proceeds straight to import.
  const runPreflight = useCallback(async () => {
    setPreflightLoading(true);
    try {
      const pf = await onPreflight(mappedRows, campaignId);
      setPreflight(pf);
      const conflictRows = (pf?.rows || []).filter(
        r => r.status === 'in_other_campaign' || (r.activeSequences && r.activeSequences.length > 0)
      );
      if (conflictRows.length === 0) {
        // Nothing to decide — go import.
        return doImport({});
      }
      // Default every conflict to "skip" (safe); user can flip to "move".
      const initial = {};
      for (const r of conflictRows) if (r.existingId) initial[r.existingId] = 'skip';
      setDecisions(initial);
      setStep('conflicts');
    } catch (err) {
      // Preflight failure shouldn't block import — fall back to plain import,
      // but tell the user the conflict check was skipped (result step banner).
      console.error('preflight failed, importing without conflict check:', err);
      setPreflightWarning(
        'The campaign/sequence conflict check could not run (' +
        (err.message || 'network error') +
        '). Rows were imported without checking whether they already belong to another campaign or active sequence.'
      );
      return doImport({});
    } finally {
      setPreflightLoading(false);
    }
  }, [mappedRows, campaignId, onPreflight, doImport]);

  const handleImport = useCallback(() => {
    if (conflictsEnabled) return runPreflight();
    return doImport({});
  }, [conflictsEnabled, runPreflight, doImport]);

  // Confirm from the conflicts step: collect ids marked 'move'.
  const confirmConflicts = useCallback(() => {
    const moveExistingIds = Object.entries(decisions)
      .filter(([, d]) => d === 'move')
      .map(([id]) => parseInt(id, 10));
    return doImport({ moveExistingIds });
  }, [decisions, doImport]);

  // ── Render ────────────────────────────────────────────────────────────────

  // While the bulk request is in flight, closing the modal would hide a
  // result the server will still produce — the user may then re-import and
  // create duplicates. Lock dismissal during the 'importing' step.
  const closable = step !== 'importing';
  const handleClose = () => { if (closable) onClose(); };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal csv-import-modal" onClick={e => e.stopPropagation()} style={{
        maxWidth: 720, width: '95vw', maxHeight: '85vh', overflow: 'auto',
        background: '#fff', borderRadius: 16, padding: '28px 32px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>📥 Import {entityLabel}</h2>
          <button onClick={handleClose} disabled={!closable} style={{
            background: 'none', border: 'none', fontSize: 22,
            cursor: closable ? 'pointer' : 'default', color: closable ? '#9ca3af' : '#e5e7eb',
          }}>×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {['Upload', 'Map Columns', 'Preview', 'Import'].map((s, i) => {
            const stepKeys = ['upload', 'mapping', 'preview', 'importing'];
            // 'conflicts' sits between preview and importing — show it as Preview-complete.
            const effStep = step === 'result' ? 'importing' : (step === 'conflicts' ? 'preview' : step);
            const current = stepKeys.indexOf(effStep);
            const active = i <= current;
            return (
              <div key={s} style={{
                flex: 1, padding: '6px 0', textAlign: 'center', fontSize: 12, fontWeight: 600,
                borderBottom: `3px solid ${active ? '#4f46e5' : '#e5e7eb'}`,
                color: active ? '#4f46e5' : '#9ca3af',
              }}>{s}</div>
            );
          })}
        </div>

        {/* ── STEP: Upload ─────────────────────────────────────── */}
        {step === 'upload' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
            <p style={{ color: '#6b7280', marginBottom: 20 }}>
              Upload a CSV file to import {entity}. The first row should contain column headers.
            </p>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" onChange={handleFile}
              style={{ display: 'none' }} />
            <button onClick={() => fileRef.current?.click()} style={{
              padding: '10px 28px', background: '#4f46e5', color: '#fff', border: 'none',
              borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>Choose CSV File</button>
            <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 12 }}>
              Required fields: {fields.filter(f => f.required).map(f => f.label).join(', ')}
            </p>
          </div>
        )}

        {/* ── STEP: Mapping ────────────────────────────────────── */}
        {step === 'mapping' && (
          <div>
            <p style={{ color: '#6b7280', marginBottom: 16, fontSize: 13 }}>
              <strong>{fileName}</strong> — {csvRows.length} rows detected. Map CSV columns to {entityLabel} fields:
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px' }}>
              {fields.map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
                    {f.label} {f.required && <span style={{ color: '#ef4444' }}>*</span>}
                  </label>
                  <select
                    value={mapping[f.key] ?? -1}
                    onChange={e => setMapping(m => ({ ...m, [f.key]: parseInt(e.target.value) }))}
                    style={{
                      width: '100%', padding: '7px 10px', borderRadius: 6,
                      border: '1px solid #d1d5db', fontSize: 13,
                    }}
                  >
                    <option value={-1}>— skip —</option>
                    {csvHeaders.map((h, i) => (
                      <option key={i} value={i}>{h}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
              <button onClick={() => setStep('upload')} style={{
                padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db',
                background: '#fff', fontSize: 13, cursor: 'pointer',
              }}>← Back</button>
              <button onClick={handleValidate} style={{
                padding: '8px 24px', borderRadius: 8, border: 'none',
                background: '#4f46e5', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>Validate & Preview →</button>
            </div>
          </div>
        )}

        {/* ── STEP: Preview ────────────────────────────────────── */}
        {step === 'preview' && (
          <div>
            <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
              <div style={{
                flex: 1, padding: '10px 14px', borderRadius: 8,
                background: '#f0fdf4', border: '1px solid #bbf7d0',
              }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#16a34a' }}>{mappedRows.length}</div>
                <div style={{ fontSize: 12, color: '#4ade80' }}>rows to import</div>
              </div>
              <div style={{
                flex: 1, padding: '10px 14px', borderRadius: 8,
                background: validationErrors.length ? '#fef2f2' : '#f9fafb',
                border: `1px solid ${validationErrors.length ? '#fecaca' : '#e5e7eb'}`,
              }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: validationErrors.length ? '#dc2626' : '#6b7280' }}>
                  {validationErrors.length}
                </div>
                <div style={{ fontSize: 12, color: validationErrors.length ? '#f87171' : '#9ca3af' }}>validation warnings</div>
              </div>
            </div>

            {/* Validation errors list */}
            {validationErrors.length > 0 && (
              <div style={{
                maxHeight: 150, overflow: 'auto', marginBottom: 16, padding: '10px 14px',
                background: '#fef2f2', borderRadius: 8, fontSize: 12, color: '#991b1b',
              }}>
                {validationErrors.slice(0, 50).map((e, i) => (
                  <div key={i}>Row {e.row}: {e.message}</div>
                ))}
                {validationErrors.length > 50 && <div>…and {validationErrors.length - 50} more</div>}
              </div>
            )}

            {/* Import mode — insert vs update-existing (prospects only) */}
            {supportsUpsert && (
              <div style={{
                marginBottom: 16, padding: '12px 14px', borderRadius: 8,
                background: '#f9fafb', border: '1px solid #e5e7eb',
              }}>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' }}>
                    <input type="radio" name="import-mode" checked={mode === 'insert'} onChange={() => setMode('insert')} />
                    <span>Add new only</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' }}>
                    <input type="radio" name="import-mode" checked={mode === 'upsert'} onChange={() => setMode('upsert')} />
                    <span>Update existing by {upsertMatchLabel}</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' }}>
                    <input type="radio" name="import-mode" checked={mode === 'update_by_id'} onChange={() => setMode('update_by_id')} />
                    <span>Update existing by ID (exported sheet)</span>
                  </label>
                </div>
                <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 6 }}>
                  {mode === 'upsert'
                    ? `Rows are matched to existing ${entity} by ${upsertMatchLabel}. Matches are updated in place (only non-empty cells overwrite); unmatched rows are added as new. Email is not used for matching, so a corrected email won't create a duplicate.`
                    : mode === 'update_by_id'
                    ? `For a sheet exported from here: rows are matched by their immutable id and verified against the read-only "do_not_edit_check" column before applying. Mismatches are flagged, not updated. Only non-empty cells overwrite; rows with an unknown id are skipped (never inserted). Leave the id and do_not_edit_check columns untouched.`
                    : `New ${entity} are added. Rows whose email already exists are skipped.`}
                </div>
                {mode === 'upsert' && mapping['linkedinUrl'] === undefined && (
                  <div style={{ fontSize: 11.5, color: '#991b1b', marginTop: 6 }}>
                    ⚠ Map a “LinkedIn URL” column to use update mode — it’s the match key.
                  </div>
                )}
                {mode === 'update_by_id' && (mapping['id'] === undefined || mapping['verifyCheck'] === undefined) && (
                  <div style={{ fontSize: 11.5, color: '#991b1b', marginTop: 6 }}>
                    ⚠ Map both the “id” and “do_not_edit_check” columns to use update-by-ID.
                  </div>
                )}
              </div>
            )}

            {/* Preview table */}
            <div style={{ maxHeight: 250, overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>#</th>
                    {fields.filter(f => mapping[f.key] !== undefined && mapping[f.key] !== -1).map(f => (
                      <th key={f.key} style={thStyle}>{f.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mappedRows.slice(0, 20).map((row, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>{i + 1}</td>
                      {fields.filter(f => mapping[f.key] !== undefined && mapping[f.key] !== -1).map(f => (
                        <td key={f.key} style={tdStyle}>{row[f.key] != null ? String(row[f.key]) : ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {mappedRows.length > 20 && (
                <div style={{ padding: 8, textAlign: 'center', fontSize: 12, color: '#9ca3af' }}>
                  …showing first 20 of {mappedRows.length} rows
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
              <button onClick={() => setStep('mapping')} style={{
                padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db',
                background: '#fff', fontSize: 13, cursor: 'pointer',
              }}>← Back</button>
              {(() => {
                const upsertBlocked = supportsUpsert && mode === 'upsert' && mapping['linkedinUrl'] === undefined;
                const byIdBlocked   = supportsUpsert && mode === 'update_by_id' && (mapping['id'] === undefined || mapping['verifyCheck'] === undefined);
                const blocked = mappedRows.length === 0 || upsertBlocked || byIdBlocked;
                const label = conflictsEnabled
                  ? (preflightLoading ? 'Checking…' : 'Check & continue')
                  : (mode === 'insert' ? 'Import' : 'Update / add');
                return (
                  <button
                    onClick={handleImport}
                    disabled={blocked || preflightLoading}
                    style={{
                      padding: '8px 24px', borderRadius: 8, border: 'none',
                      background: (blocked || preflightLoading) ? '#d1d5db' : '#16a34a',
                      color: '#fff', fontSize: 13, fontWeight: 600,
                      cursor: (blocked || preflightLoading) ? 'default' : 'pointer',
                    }}
                  >
                    {label}{conflictsEnabled ? '' : ` ${mappedRows.length} ${entityLabel}`} →
                  </button>
                );
              })()}
            </div>
          </div>
        )}

        {/* ── STEP: Conflicts (already in another campaign / sequence) ── */}
        {step === 'conflicts' && preflight && (() => {
          const rows = preflight.rows || [];
          const conflicts = rows.filter(r => r.status === 'in_other_campaign' || (r.activeSequences && r.activeSequences.length > 0));
          const newCount = rows.filter(r => r.status === 'new').length;
          const inThis   = rows.filter(r => r.status === 'in_this_campaign').length;
          const moveCount = Object.values(decisions).filter(d => d === 'move').length;
          return (
            <div>
              <div style={{ marginBottom: 14, fontSize: 13, color: '#374151' }}>
                <strong>{conflicts.length}</strong> of {rows.length} already belong to another campaign or an active sequence.
                Decide per contact. <span style={{ color: '#6b7280' }}>{newCount} new will be added{inThis ? `, ${inThis} already in this campaign (skipped)` : ''}.</span>
              </div>

              <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                {conflicts.map((r) => {
                  const d = decisions[r.existingId] || 'skip';
                  return (
                    <div key={r.existingId || r.index} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px', borderBottom: '1px solid #f1f5f9',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{r.name || `Row ${r.index + 1}`}</div>
                        <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 2 }}>
                          {r.currentCampaign && <span>In campaign: <strong style={{ color: '#c2410c' }}>{r.currentCampaign.name}</strong>. </span>}
                          {r.activeSequences && r.activeSequences.length > 0 && (
                            <span>In sequence{r.activeSequences.length > 1 ? 's' : ''}: <strong style={{ color: '#7c3aed' }}>{r.activeSequences.map(s => s.name).join(', ')}</strong>.</span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          onClick={() => setDecisions(prev => ({ ...prev, [r.existingId]: 'skip' }))}
                          style={{
                            padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            border: d === 'skip' ? '1px solid #94a3b8' : '1px solid #e5e7eb',
                            background: d === 'skip' ? '#f1f5f9' : '#fff', color: '#334155',
                          }}
                        >Skip</button>
                        <button
                          onClick={() => setDecisions(prev => ({ ...prev, [r.existingId]: 'move' }))}
                          style={{
                            padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            border: d === 'move' ? '1px solid #0F9D8E' : '1px solid #e5e7eb',
                            background: d === 'move' ? '#ecfdf5' : '#fff', color: d === 'move' ? '#065f46' : '#334155',
                          }}
                        >Move here</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 12, fontSize: 12 }}>
                <button onClick={() => { const all = {}; conflicts.forEach(r => { if (r.existingId) all[r.existingId] = 'skip'; }); setDecisions(all); }}
                  style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}>
                  Skip all
                </button>
                <button onClick={() => { const all = {}; conflicts.forEach(r => { if (r.existingId) all[r.existingId] = 'move'; }); setDecisions(all); }}
                  style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}>
                  Move all here
                </button>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
                <button onClick={() => setStep('preview')} style={{
                  padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db',
                  background: '#fff', fontSize: 13, cursor: 'pointer',
                }}>← Back</button>
                <button onClick={confirmConflicts} style={{
                  padding: '8px 24px', borderRadius: 8, border: 'none',
                  background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}>
                  Import {newCount} new{moveCount ? ` · move ${moveCount}` : ''} →
                </button>
              </div>
            </div>
          );
        })()}

        {/* ── STEP: Importing ──────────────────────────────────── */}
        {step === 'importing' && (
          <div style={{ textAlign: 'center', padding: '50px 0' }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>⏳</div>
            <p style={{ color: '#6b7280' }}>Importing {mappedRows.length} {entity}…</p>
          </div>
        )}

        {/* ── STEP: Result ─────────────────────────────────────── */}
        {step === 'result' && result && (
          <div style={{ textAlign: 'center', padding: '30px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>
              {(result.imported > 0 || result.updated > 0 || result.moved > 0) ? '✅' : '⚠️'}
            </div>
            <h3 style={{ marginBottom: 8 }}>
              {(result.imported > 0 || result.updated > 0 || result.moved > 0)
                ? [
                    result.imported ? `Added ${result.imported}` : null,
                    result.updated  ? `Updated ${result.updated}` : null,
                    result.moved    ? `Moved ${result.moved}` : null,
                  ].filter(Boolean).join(' · ') + ` ${entity}`
                : 'Import completed with issues'}
            </h3>
            {preflightWarning && (
              <div style={{
                textAlign: 'left', margin: '12px auto', maxWidth: 500, padding: '10px 14px',
                background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
                fontSize: 12, color: '#92400e',
              }}>
                ⚠ {preflightWarning}
              </div>
            )}
            {result.errors?.length > 0 && (
              <div style={{
                textAlign: 'left', maxHeight: 200, overflow: 'auto',
                margin: '16px auto', maxWidth: 500, padding: '10px 14px',
                background: '#fef2f2', borderRadius: 8, fontSize: 12, color: '#991b1b',
              }}>
                <strong>{result.errors.length} error(s):</strong>
                {result.errors.slice(0, 30).map((e, i) => (
                  <div key={i}>
                    {e.row ? `Row ${e.row}: ` : ''}{e.message || JSON.stringify(e)}
                  </div>
                ))}
              </div>
            )}
            <button onClick={onClose} style={{
              marginTop: 16, padding: '10px 28px', background: '#4f46e5', color: '#fff',
              border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

const thStyle = {
  padding: '8px 10px', textAlign: 'left', background: '#f9fafb',
  borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, whiteSpace: 'nowrap',
};
const tdStyle = {
  padding: '6px 10px', borderBottom: '1px solid #f3f4f6', maxWidth: 180,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
