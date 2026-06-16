// prospecting/CustomFieldsImportModal.js
// CSV → durable custom field values for prospects / accounts / contacts.
// Parses the CSV client-side (dependency-free), lets the admin map columns,
// previews with a dry run, then commits. Mirrors the bulk-import flow.
//
//   <CustomFieldsImportModal targetEntity="prospect" onClose={fn} onDone={fn} />

import React, { useState } from 'react';
import * as CFApi from './customFieldsApi';
import './CustomFields.css';

// Minimal CSV parser: handles quoted fields, escaped quotes, commas, newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(x => x !== '')) rows.push(row); }
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map(r => {
    const o = {}; headers.forEach((h, idx) => { o[h] = r[idx] !== undefined ? r[idx] : ''; }); return o;
  });
  return { headers, records };
}

const slug = (h) => h.toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'field';

export default function CustomFieldsImportModal({ targetEntity: initialEntity = 'prospect', campaignId = null, onClose, onDone }) {
  const [targetEntity, setTargetEntity] = useState(initialEntity);
  const [text, setText]       = useState('');
  const [parsed, setParsed]   = useState(null);   // { headers, records }
  const [matchBy, setMatchBy] = useState(CFApi.MATCH_KEYS[initialEntity][0]);
  const [colMap, setColMap]   = useState([]);      // [{column, include, fieldKey, fieldType}]
  const [createDefs, setCreateDefs] = useState(true);
  const [preview, setPreview] = useState(null);
  const [result, setResult]   = useState(null);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  const onEntityChange = (e) => {
    setTargetEntity(e); setMatchBy(CFApi.MATCH_KEYS[e][0]); setPreview(null); setResult(null);
  };

  const doParse = (raw) => {
    const p = parseCsv(raw);
    setParsed(p);
    setColMap(p.headers.map(h => ({ column: h, include: true, fieldKey: slug(h), fieldType: 'text' })));
    setPreview(null); setResult(null); setError(null);
  };

  const onFile = (f) => { const rd = new FileReader(); rd.onload = () => { setText(rd.result); doParse(rd.result); }; rd.readAsText(f); };

  const buildPayload = (dryRun) => ({
    targetEntity, matchBy, dryRun, createDefs,
    campaignId: campaignId ?? undefined,
    rows: parsed.records,
    columnMap: colMap.filter(c => c.include && c.column !== matchBy)
      .map(c => ({ column: c.column, fieldKey: c.fieldKey, fieldType: c.fieldType, label: c.column })),
  });

  const run = async (dryRun) => {
    if (!parsed || parsed.records.length === 0) { setError('Paste or upload a CSV first'); return; }
    setBusy(true); setError(null);
    try {
      const r = await CFApi.importValues(buildPayload(dryRun));
      if (dryRun) { setPreview(r); setResult(null); }
      else { setResult(r); setPreview(null); if (onDone) onDone(r); }
    } catch (e) { setError(e.message || 'Import failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal cf-import-modal" onClick={e => e.stopPropagation()}>
        <div className="pv-modal-header">
          <h3>Import custom fields from CSV</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="cf-import-body">
          <div className="cf-import-controls">
            <label>Apply to&nbsp;
              <select className="cf-input" value={targetEntity} onChange={e => onEntityChange(e.target.value)}>
                {Object.keys(CFApi.ENTITY_LABEL).map(e => <option key={e} value={e}>{CFApi.ENTITY_LABEL[e]}s</option>)}
              </select>
            </label>
            <label>&nbsp;Match rows by&nbsp;
              <select className="cf-input" value={matchBy} onChange={e => setMatchBy(e.target.value)}>
                {CFApi.MATCH_KEYS[targetEntity].map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="cf-check">&nbsp;
              <input type="checkbox" checked={createDefs} onChange={e => setCreateDefs(e.target.checked)} />
              Create missing fields
            </label>
          </div>

          {!parsed && (
            <div className="cf-import-drop">
              <textarea className="cf-input cf-textarea" placeholder="Paste CSV here (first row = headers)…"
                value={text} onChange={e => setText(e.target.value)} />
              <div className="cf-import-actions">
                <input type="file" accept=".csv,text/csv" onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
                <button type="button" className="cf-btn cf-btn-primary" disabled={!text.trim()} onClick={() => doParse(text)}>Parse</button>
              </div>
            </div>
          )}

          {parsed && (
            <>
              <p className="cf-muted">{parsed.records.length} rows · matching on <strong>{matchBy}</strong>. The match column is not imported as a field.</p>
              <table className="cf-table cf-map-table">
                <thead><tr><th>Use</th><th>CSV column</th><th>Field key</th><th>Type</th></tr></thead>
                <tbody>
                  {colMap.map((c, i) => (
                    <tr key={c.column} className={c.column === matchBy ? 'cf-row-inactive' : ''}>
                      <td><input type="checkbox" checked={c.include && c.column !== matchBy} disabled={c.column === matchBy}
                        onChange={e => setColMap(m => m.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} /></td>
                      <td>{c.column}{c.column === matchBy && <span className="cf-badge">match key</span>}</td>
                      <td><input className="cf-input cf-mono" value={c.fieldKey}
                        onChange={e => setColMap(m => m.map((x, j) => j === i ? { ...x, fieldKey: slug(e.target.value) } : x))} /></td>
                      <td><select className="cf-input" value={c.fieldType}
                        onChange={e => setColMap(m => m.map((x, j) => j === i ? { ...x, fieldType: e.target.value } : x))}>
                        {CFApi.FIELD_TYPES.filter(t => t !== 'picklist').map(t => <option key={t} value={t}>{t}</option>)}
                      </select></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {error && <div className="cf-error">{error}</div>}

              {preview && (
                <div className="cf-preview">
                  <strong>Preview (nothing written):</strong>
                  <ul>
                    <li>{preview.matched} matched · {preview.unmatched} unmatched</li>
                    <li>{preview.valuesPlanned} values would be written</li>
                    {preview.defsResolved?.some(d => d.action === 'would_create') &&
                      <li>New fields to create: {preview.defsResolved.filter(d => d.action === 'would_create').map(d => d.fieldKey).join(', ')}</li>}
                    {preview.castWarnings?.length > 0 &&
                      <li className="cf-warn">{preview.castWarnings.length} value(s) won't cast cleanly (e.g. {preview.castWarnings[0].column} = “{preview.castWarnings[0].value}”)</li>}
                    {preview.unmatchedKeysSample?.length > 0 &&
                      <li className="cf-muted">Unmatched sample: {preview.unmatchedKeysSample.slice(0, 5).join(', ')}</li>}
                  </ul>
                </div>
              )}
              {result && (
                <div className="cf-preview cf-ok">
                  <strong>Imported.</strong> {result.valuesWritten} values written across {result.matched} matched {targetEntity}s.
                  {result.unmatched > 0 && <> {result.unmatched} rows didn’t match and were skipped.</>}
                </div>
              )}

              <div className="cf-import-actions">
                <button type="button" className="cf-btn" onClick={() => { setParsed(null); setPreview(null); setResult(null); }}>Start over</button>
                <button type="button" className="cf-btn" disabled={busy} onClick={() => run(true)}>Preview</button>
                <button type="button" className="cf-btn cf-btn-primary" disabled={busy} onClick={() => run(false)}>Import</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
