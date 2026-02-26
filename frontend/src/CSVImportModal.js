import React, { useState, useRef, useCallback, useMemo } from 'react';
import { csvParse, IMPORT_FIELDS } from './csvUtils';

/**
 * CSVImportModal — shared 4-step import dialog for Accounts, Contacts, Deals
 *
 * Props:
 *   entity      — 'accounts' | 'contacts' | 'deals'
 *   onImport    — async (rows) => { imported, errors } — calls bulk API
 *   onClose     — () => void
 *   accounts    — array of existing accounts (for name→id matching in contacts/deals)
 */
export default function CSVImportModal({ entity, onImport, onClose, accounts = [] }) {
  const fields = useMemo(() => IMPORT_FIELDS[entity] || [], [entity]);
  const entityLabel = entity.charAt(0).toUpperCase() + entity.slice(1);

  // Steps: 'upload' → 'mapping' → 'preview' → 'importing' → 'result'
  const [step, setStep] = useState('upload');
  const [fileName, setFileName] = useState('');
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvRows, setCsvRows] = useState([]);
  const [mapping, setMapping] = useState({});       // fieldKey → csvColumnIndex
  const [validationErrors, setValidationErrors] = useState([]); // [{row, field, message}]
  const [mappedRows, setMappedRows] = useState([]);  // final objects
  const [result, setResult] = useState(null);        // { imported, errors }

  const fileRef = useRef();

  // ── Step 1: Upload ────────────────────────────────────────────────────────
  const handleFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
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

    // Build an account name→id lookup (case-insensitive)
    const acctMap = {};
    accounts.forEach(a => {
      acctMap[a.name.toLowerCase()] = a.id;
      if (a.domain) acctMap[a.domain.toLowerCase()] = a.id;
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

        obj[f.key] = val || undefined;
      });

      if (hasData) rows.push(obj);
    });

    setValidationErrors(errors);
    setMappedRows(rows);
    setStep('preview');
  }, [csvRows, mapping, fields, accounts]);

  // ── Step 3: Import ────────────────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    setStep('importing');
    try {
      const res = await onImport(mappedRows);
      setResult(res);
      setStep('result');
    } catch (err) {
      setResult({ imported: 0, errors: [{ row: 0, message: err.message }] });
      setStep('result');
    }
  }, [mappedRows, onImport]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal csv-import-modal" onClick={e => e.stopPropagation()} style={{
        maxWidth: 720, width: '95vw', maxHeight: '85vh', overflow: 'auto',
        background: '#fff', borderRadius: 16, padding: '28px 32px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>📥 Import {entityLabel}</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af',
          }}>×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {['Upload', 'Map Columns', 'Preview', 'Import'].map((s, i) => {
            const stepKeys = ['upload', 'mapping', 'preview', 'importing'];
            const current = stepKeys.indexOf(step === 'result' ? 'importing' : step);
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
              <button
                onClick={handleImport}
                disabled={mappedRows.length === 0}
                style={{
                  padding: '8px 24px', borderRadius: 8, border: 'none',
                  background: mappedRows.length > 0 ? '#16a34a' : '#d1d5db',
                  color: '#fff', fontSize: 13, fontWeight: 600, cursor: mappedRows.length > 0 ? 'pointer' : 'default',
                }}
              >
                Import {mappedRows.length} {entityLabel} →
              </button>
            </div>
          </div>
        )}

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
              {result.imported > 0 ? '✅' : '⚠️'}
            </div>
            <h3 style={{ marginBottom: 8 }}>
              {result.imported > 0
                ? `Successfully imported ${result.imported} ${entity}`
                : 'Import completed with issues'}
            </h3>
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
