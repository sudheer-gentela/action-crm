/**
 * OAAssessment — Assessment & Baseline cockpit (Org Admin panel)
 *
 * DROP-IN LOCATION: frontend/src/orgadmin/panels/OAAssessment.js
 *
 * The full assessment flow in one panel, driving the Phase 1 backend:
 *
 *   1. Connection   — pick a crm_connections row (usually one)
 *   2. Discovery    — POST /baseline/connections/:id/discover; shows latest
 *                     frozen schema snapshot status
 *   3. Stage map    — GET mapping-proposal → review/edit → PATCH stage-map.
 *                     Identity mode (unseeded assessment orgs) is flagged.
 *   4. Baselines    — POST capture (202 + poll to frozen), snapshot list
 *   5. Report       — generate, view in-app (auth fetch → iframe srcDoc,
 *                     since a browser tab can't send the Bearer token),
 *                     share link mint/copy/revoke
 *
 * Mount in OrgAdminView.js:
 *   import OAAssessment from './orgadmin/panels/OAAssessment';
 *   {tab === 'assessment' && <OAAssessment />}
 * Nav item + TAB_META live in orgadmin/constants.js.
 */
import React from 'react';

const OK    = '#0a7d3c';
const BAD   = '#c0392b';
const WARN  = '#b9770e';
const MUTED = '#6b7280';
const BLUE  = '#1d4ed8';

const card  = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 16, background: '#fff' };
const h3    = { margin: '0 0 4px', fontSize: 15 };
const sub   = { color: MUTED, fontSize: 12.5, margin: '0 0 12px' };
const btn   = { padding: '7px 14px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 };
const btnP  = { ...btn, background: '#111827', color: '#fff', border: '1px solid #111827' };
const chip  = (c) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 11, color: '#fff', background: c, textTransform: 'uppercase', letterSpacing: '.03em' });
const tdS   = { padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 13, verticalAlign: 'top' };
const thS   = { ...tdS, fontWeight: 600, color: MUTED, fontSize: 12, textTransform: 'uppercase' };

const STATUS_COLOR = { frozen: OK, computing: WARN, pending: WARN, failed: BAD };
const CONF_COLOR   = { high: OK, medium: WARN, low: BAD, none: MUTED };

/** Tabbed viewer over the frozen schema snapshot (GET /crm-connections/:id/schema). */
/** Tabbed viewer over the frozen schema snapshot, with drill navigation:
 * object lists (standard + custom) -> field detail with a back arrow that
 * returns to the originating tab. fieldView overlays the tab body; switching
 * tabs clears it, so navigation always continues from where you were. */
function DiscoveryViewer({ schema, warnings, capturedAt, onClose }) {
  const [tab, setTab] = React.useState('objects');
  const [fieldView, setFieldView] = React.useState(null); // { objName, fromLabel }
  const [customOnly, setCustomOnly] = React.useState(false);
  const [lowFillOnly, setLowFillOnly] = React.useState(false);

  const objects = schema.objects || [];
  const fields = schema.fields || {};
  const standardObjects = objects.filter(o => !o.custom);
  const customObjects = objects.filter(o => o.custom);

  const fillBar = (f) => {
    if (f.fillRateSkipReason === 'boolean') return <span style={{ color: MUTED, fontSize: 12 }}>n/a — checkbox (always set)</span>;
    if (f.fillRateSkipReason === 'not_measurable') return <span style={{ color: MUTED, fontSize: 12 }}>not measurable (type)</span>;
    if (f.fillRate == null) return <span style={{ color: MUTED }}>—</span>;
    return (
      <span title={`${(f.fillRate * 100).toFixed(1)}%${f.fillRateSampled ? ' (sampled)' : ''}`}>
        <span style={{ display: 'inline-block', width: 60, height: 8, background: '#f3f4f6', borderRadius: 4, marginRight: 6, verticalAlign: 'middle' }}>
          <span style={{ display: 'block', width: `${Math.round(f.fillRate * 60)}px`, height: 8, borderRadius: 4, background: f.fillRate < 0.1 ? BAD : f.fillRate < 0.3 ? WARN : OK }} />
        </span>
        {(f.fillRate * 100).toFixed(0)}%{f.fillRateSampled ? '*' : ''}
      </span>
    );
  };

  const tabBtn = (id, label) => (
    <button key={id} style={{ ...btn, ...(tab === id && !fieldView ? { background: '#111827', color: '#fff', borderColor: '#111827' } : {}) }}
      onClick={() => { setFieldView(null); setTab(id); }}>{label}</button>
  );

  const openFields = (objName, fromLabel) => setFieldView({ objName, fromLabel });

  const objectTable = (list, emptyText) => list.length === 0
    ? <div style={{ color: MUTED, fontSize: 13 }}>{emptyText}</div>
    : (
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr><th style={thS}>Object</th><th style={thS}>API name</th><th style={thS}>~Records</th><th style={thS}>Fields</th><th style={thS}></th></tr></thead>
        <tbody>{list.map(o => {
          const described = (fields[o.name] || []).length;
          const shell = o.custom && o.recordCount === 0;
          return (
            <tr key={o.name} style={shell ? { background: '#FFFBEB' } : undefined}>
              <td style={tdS}><b>{o.label || o.name}</b>{shell && <span style={{ ...chip(WARN), marginLeft: 6 }}>zero records</span>}</td>
              <td style={{ ...tdS, color: MUTED }}>{o.name}</td>
              <td style={tdS}>{o.recordCount != null ? o.recordCount.toLocaleString() : '—'}</td>
              <td style={tdS}>{described > 0 ? described : <span style={{ color: MUTED }}>not described</span>}</td>
              <td style={tdS}>
                {described > 0 && (
                  <button style={{ ...btn, padding: '3px 10px', fontSize: 12 }}
                    onClick={() => openFields(o.name, o.custom ? 'Custom Objects' : 'Objects')}>
                    View fields →
                  </button>
                )}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    );

  const allWarnings = [...(warnings || []), ...((schema.limits_notes || []).map(n => ({ kind: 'limit', detail: n })))];

  const fieldRows = fieldView
    ? (fields[fieldView.objName] || []).filter(f =>
        (!customOnly || f.custom) && (!lowFillOnly || (f.fillRate != null && f.fillRate < 0.1)))
    : [];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#fff', borderRadius: 10, width: 'min(1000px, 96vw)', height: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap', gap: 6 }}>
          <div>
            <strong style={{ fontSize: 14 }}>Discovery results</strong>
            <span style={{ color: MUTED, fontSize: 12, marginLeft: 8 }}>frozen {capturedAt ? new Date(capturedAt).toLocaleString() : ''}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {tabBtn('objects', `Objects (${standardObjects.length})`)}
            {tabBtn('custom', `Custom Objects (${customObjects.length})`)}
            {tabBtn('stages', `Stages (${(schema.stage_defs || []).length})`)}
            {tabBtn('automation', 'Automation & Rules')}
            {tabBtn('caveats', `Caveats (${allWarnings.length})`)}
            <button style={btn} onClick={onClose}>Close</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {fieldView ? (
            <div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                <button style={btn} onClick={() => setFieldView(null)}>← Back to {fieldView.fromLabel}</button>
                <strong style={{ fontSize: 14 }}>{fieldView.objName}</strong>
                <span style={{ color: MUTED, fontSize: 12.5 }}>{fieldRows.length} of {(fields[fieldView.objName] || []).length} fields</span>
                <label style={{ fontSize: 13 }}><input type="checkbox" checked={customOnly} onChange={e => setCustomOnly(e.target.checked)} /> custom only</label>
                <label style={{ fontSize: 13 }}><input type="checkbox" checked={lowFillOnly} onChange={e => setLowFillOnly(e.target.checked)} /> low fill (&lt;10%)</label>
              </div>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={thS}>Field</th><th style={thS}>Type</th><th style={thS}>Flags</th><th style={thS}>Fill rate</th><th style={thS}>Picklist values</th></tr></thead>
                <tbody>{fieldRows.map(f => (
                  <tr key={f.name} style={f.fillRate != null && f.fillRate < 0.1 && f.custom ? { background: '#FEF2F2' } : undefined}>
                    <td style={tdS}><b>{f.label || f.name}</b><div style={{ color: MUTED, fontSize: 11.5 }}>{f.name}</div></td>
                    <td style={tdS}>{f.type}</td>
                    <td style={{ ...tdS, fontSize: 12 }}>
                      {f.custom && <span style={chip(BLUE)}>custom</span>}{' '}
                      {f.required && <span style={chip(WARN)}>required</span>}{' '}
                      {f.historyTracked && <span style={chip(MUTED)}>history</span>}{' '}
                      {f.calculated && <span style={chip(MUTED)}>formula</span>}
                    </td>
                    <td style={tdS}>{fillBar(f)}</td>
                    <td style={{ ...tdS, fontSize: 12, color: MUTED, maxWidth: 260 }}>{(f.picklistValues || []).slice(0, 8).join(', ')}{(f.picklistValues || []).length > 8 ? '…' : ''}</td>
                  </tr>
                ))}</tbody>
              </table>
              <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6 }}>* sampled fill rate (HubSpot). Red rows: custom fields under 10% populated — config-debt candidates.</div>
            </div>
          ) : tab === 'objects' ? (
            <div>
              {objectTable(standardObjects, 'No standard objects discovered.')}
              <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
                Core CRM objects the assessment reads. Fill rates are computed for Opportunity and Account fields; record counts give scale context.
              </div>
            </div>
          ) : tab === 'custom' ? (
            <div>
              {objectTable(customObjects, 'No custom objects related to deals or accounts were discovered.')}
              <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
                Custom objects with a relationship to Opportunity or Account — where custom process (territories, teams, implementations, approvals) usually lives.
                Zero-record objects are config-debt shells.
              </div>
            </div>
          ) : tab === 'stages' ? (
            <div>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={thS}>Stage</th><th style={thS}>Probability</th><th style={thS}>Closed</th><th style={thS}>Won</th><th style={thS}>Order</th><th style={thS}>Pipeline</th></tr></thead>
                <tbody>{(schema.stage_defs || []).map((st, i) => (
                  <tr key={i}>
                    <td style={tdS}><b>{st.label}</b></td>
                    <td style={tdS}>{st.defaultProbability != null ? `${st.defaultProbability}%` : '—'}</td>
                    <td style={tdS}>{st.isClosed ? 'yes' : ''}</td>
                    <td style={tdS}>{st.isWon ? 'yes' : ''}</td>
                    <td style={tdS}>{st.sortOrder ?? ''}</td>
                    <td style={{ ...tdS, color: MUTED }}>{st.pipelineLabel || ''}</td>
                  </tr>
                ))}</tbody>
              </table>
              {(schema.pipelines || []).length > 1 && (
                <div style={{ color: WARN, fontSize: 12.5, marginTop: 8 }}>
                  {schema.pipelines.length} pipelines / record types detected — aggregate metrics blend them where the stage map merges; per-pipeline splits are the recommended follow-up cut.
                </div>
              )}
            </div>
          ) : tab === 'automation' ? (
            <div>
              <h4 style={{ margin: '0 0 6px' }}>Validation rules ({(schema.validation_rules || []).length})</h4>
              {(schema.validation_rules || []).length === 0 ? <div style={{ color: MUTED, fontSize: 13 }}>None readable.</div> : (
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={thS}>Object</th><th style={thS}>Rule</th><th style={thS}>Active</th><th style={thS}>Error message shown to reps</th></tr></thead>
                  <tbody>{(schema.validation_rules || []).map((v, i) => (
                    <tr key={i}><td style={tdS}>{v.object}</td><td style={tdS}>{v.name}</td><td style={tdS}>{v.active ? 'yes' : 'no'}</td><td style={{ ...tdS, color: MUTED }}>{v.errorMessage || ''}</td></tr>
                  ))}</tbody>
                </table>
              )}
              <h4 style={{ margin: '14px 0 6px' }}>Active flows ({schema.automation?.flows ?? 'not readable'})</h4>
              {(schema.automation?.flowList || []).length === 0 ? (
                <div style={{ color: MUTED, fontSize: 13 }}>None active (or not readable — see caveats).</div>
              ) : (
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={thS}>Flow</th><th style={thS}>Type</th><th style={thS}>Trigger</th></tr></thead>
                  <tbody>{(schema.automation.flowList || []).map((f, i) => (
                    <tr key={i}><td style={tdS}><b>{f.label}</b><div style={{ color: MUTED, fontSize: 11.5 }}>{f.apiName}</div></td>
                      <td style={tdS}>{f.processType || ''}</td>
                      <td style={tdS}>{f.triggerType || 'screen / manual'}</td></tr>
                  ))}</tbody>
                </table>
              )}
              <h4 style={{ margin: '14px 0 6px' }}>Workflow rules ({schema.automation?.workflowRules ?? 'not readable'})</h4>
              {(schema.automation?.workflowRuleList || []).length === 0 ? (
                <div style={{ color: MUTED, fontSize: 13 }}>None (legacy automation retired, or not readable).</div>
              ) : (
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={thS}>Rule</th><th style={thS}>Object</th></tr></thead>
                  <tbody>{(schema.automation.workflowRuleList || []).map((w, i) => (
                    <tr key={i}><td style={tdS}>{w.name}</td><td style={tdS}>{w.object || ''}</td></tr>
                  ))}</tbody>
                </table>
              )}
              {schema.ownership && (
                <div style={{ fontSize: 13, marginTop: 14 }}>
                  <h4 style={{ margin: '0 0 6px' }}>Ownership context</h4>
                  Queues: <b>{(schema.ownership.queues || []).length}</b>
                  {(schema.ownership.queues || []).length > 0 && <span style={{ color: MUTED }}> ({schema.ownership.queues.slice(0, 8).join(', ')}{schema.ownership.queues.length > 8 ? '…' : ''})</span>}
                  {' '}· Roles: <b>{schema.ownership.roleCount ?? '—'}</b>
                  {schema.ownership.roleDepth != null && <span> (hierarchy depth {schema.ownership.roleDepth})</span>}
                </div>
              )}
            </div>
          ) : (
            allWarnings.length === 0 ? <div style={{ color: MUTED, fontSize: 13 }}>None — discovery read everything it asked for.</div> : (
              <ul style={{ fontSize: 13, lineHeight: 1.7 }}>
                {allWarnings.map((w, i) => (
                  <li key={i}><b>{w.kind}</b>{w.object ? ` (${w.object}${w.field ? '.' + w.field : ''})` : ''}: {typeof w.detail === 'string' ? w.detail : JSON.stringify(w.detail)}</li>
                ))}
              </ul>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default function OAAssessment() {
  const API = process.env.REACT_APP_API_URL;
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = React.useMemo(
    () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    [token]
  );

  const [connections, setConnections] = React.useState([]);
  const [connId, setConnId]           = React.useState(null);
  const [detail, setDetail]           = React.useState(null);   // GET /crm-connections/:id
  const [proposal, setProposal]       = React.useState(null);   // mapping proposal
  const [editMap, setEditMap]         = React.useState({});     // crmStage → key (editable)
  const [snapshots, setSnapshots]     = React.useState([]);
  const [reports, setReports]         = React.useState({});     // snapshotId → report meta
  const [viewer, setViewer]           = React.useState(null);   // { html }
  const [schemaView, setSchemaView]   = React.useState(null);   // { schema, warnings, capturedAt }
  const [seeding, setSeeding]         = React.useState(false);
  const [busy, setBusy]               = React.useState('');     // which action is running
  const [error, setError]             = React.useState('');
  const [notice, setNotice]           = React.useState('');
  const pollRef = React.useRef(null);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };
  const fail  = (e, fallback) => setError(e?.message || fallback);

  const jfetch = React.useCallback(async (path, opts = {}) => {
    const res = await fetch(`${API}${path}`, { headers, ...opts });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new Error(body.error || `${res.status} on ${path}`);
    }
    return body;
  }, [API, headers]);

  // ── loaders ────────────────────────────────────────────────────────────────

  const loadConnections = React.useCallback(async () => {
    try {
      const b = await jfetch('/crm-connections');
      setConnections(b.connections || []);
      if (!connId && b.connections?.length) setConnId(b.connections[0].id);
    } catch (e) { fail(e, 'Failed to load connections'); }
  }, [jfetch, connId]);

  const loadDetail = React.useCallback(async (id) => {
    if (!id) return;
    try {
      const b = await jfetch(`/crm-connections/${id}`);
      setDetail(b);
    } catch (e) { fail(e, 'Failed to load connection'); }
  }, [jfetch]);

  const loadSnapshots = React.useCallback(async (id) => {
    if (!id) return;
    try {
      const b = await jfetch(`/baseline/snapshots?connection_id=${id}`);
      setSnapshots(b.snapshots || []);
      // fetch report meta for frozen snapshots (best-effort, sequential is fine)
      for (const s of (b.snapshots || []).filter(x => x.status === 'frozen')) {
        try {
          const r = await jfetch(`/baseline/snapshots/${s.id}/report`);
          setReports(prev => ({ ...prev, [s.id]: r.report }));
        } catch { /* no report yet */ }
      }
    } catch (e) { fail(e, 'Failed to load snapshots'); }
  }, [jfetch]);

  React.useEffect(() => { loadConnections(); }, [loadConnections]);
  React.useEffect(() => {
    if (connId) { setProposal(null); setEditMap({}); loadDetail(connId); loadSnapshots(connId); }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [connId, loadDetail, loadSnapshots]);

  // ── actions ────────────────────────────────────────────────────────────────

  const openSchemaViewer = async () => {
    setBusy('schema'); setError('');
    try {
      const b = await jfetch(`/crm-connections/${connId}/schema`);
      setSchemaView({ schema: b.snapshot.schema, warnings: b.snapshot.warnings, capturedAt: b.snapshot.captured_at });
    } catch (e) { fail(e, 'Failed to load discovery results'); }
    finally { setBusy(''); }
  };

  const adoptDefaultStages = async () => {
    if (!window.confirm('Adopt GoWarm default sales stages for this org?\n\nStages ONLY are created (no playbooks) — the mapping proposal will then map the CRM stages onto them.')) return;
    setSeeding(true); setError('');
    try {
      const b = await jfetch('/crm-connections/seed-default-stages', { method: 'POST' });
      flash(`Seeded ${b.seeded} default stages`);
      await loadProposal();
    } catch (e) { fail(e, 'Seeding failed'); }
    finally { setSeeding(false); }
  };

  const runDiscovery = async () => {
    setBusy('discover'); setError('');
    try {
      const b = await jfetch(`/baseline/connections/${connId}/discover`, { method: 'POST' });
      flash(`Discovery frozen (snapshot #${b.schemaSnapshotId}${b.warnings?.length ? `, ${b.warnings.length} warnings` : ''})`);
      await loadDetail(connId);
    } catch (e) { fail(e, 'Discovery failed'); }
    finally { setBusy(''); }
  };

  const loadProposal = async () => {
    setBusy('proposal'); setError('');
    try {
      const b = await jfetch(`/crm-connections/${connId}/mapping-proposal`);
      setProposal(b);
      const seed = {};
      for (const p of (b.proposals || [])) seed[p.crmStage] = p.proposedKey || '';
      // pre-existing approved map wins over proposal
      for (const [k, v] of Object.entries(b.currentStageMap || {})) seed[k] = v;
      setEditMap(seed);
    } catch (e) { fail(e, 'Failed to load mapping proposal'); }
    finally { setBusy(''); }
  };

  const approveMap = async () => {
    const stage_map = Object.fromEntries(
      Object.entries(editMap).filter(([, v]) => v && v.trim())
        .map(([k, v]) => [k, v.trim()])
    );
    if (!Object.keys(stage_map).length) { setError('Map at least one stage before approving'); return; }
    setBusy('approve'); setError('');
    try {
      await jfetch(`/crm-connections/${connId}/stage-map`, {
        method: 'PATCH', body: JSON.stringify({ stage_map }),
      });
      flash('Stage map approved');
      // Refresh BOTH: detail (drives the approved chip) and the connections
      // list (drives the capture gate) — the gate read a stale list before.
      await loadDetail(connId);
      await loadConnections();
    } catch (e) { fail(e, 'Approval failed'); }
    finally { setBusy(''); }
  };

  const startCapture = async () => {
    setBusy('capture'); setError('');
    try {
      const b = await jfetch(`/baseline/connections/${connId}/capture`, { method: 'POST' });
      flash(`Capture started (snapshot #${b.snapshotId}) — polling…`);
      await loadSnapshots(connId);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const s = await jfetch(`/baseline/snapshots/${b.snapshotId}`);
          if (s.snapshot.status === 'frozen' || s.snapshot.status === 'failed') {
            clearInterval(pollRef.current); pollRef.current = null;
            flash(s.snapshot.status === 'frozen'
              ? `Baseline #${b.snapshotId} frozen`
              : `Capture failed: ${s.snapshot.error_detail || 'see snapshot'}`);
            await loadSnapshots(connId);
          }
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e) { fail(e, 'Capture failed to start'); }
    finally { setBusy(''); }
  };

  const generateReport = async (snapId) => {
    setBusy(`report-${snapId}`); setError('');
    try {
      const b = await jfetch(`/baseline/snapshots/${snapId}/report`, { method: 'POST' });
      flash(`Report generated (${b.findingsCount} findings, narrative: ${b.narrativeStatus})`);
      const r = await jfetch(`/baseline/snapshots/${snapId}/report`);
      setReports(prev => ({ ...prev, [snapId]: r.report }));
    } catch (e) { fail(e, 'Report generation failed'); }
    finally { setBusy(''); }
  };

  const viewReport = async (reportId) => {
    setBusy(`view-${reportId}`); setError('');
    try {
      const res = await fetch(`${API}/baseline/reports/${reportId}/html`, { headers });
      if (!res.ok) throw new Error(`Failed to load report (${res.status})`);
      setViewer({ html: await res.text() });
    } catch (e) { fail(e, 'Failed to load report'); }
    finally { setBusy(''); }
  };

  const shareReport = async (snapId, reportId) => {
    setBusy(`share-${reportId}`); setError('');
    try {
      const b = await jfetch(`/baseline/reports/${reportId}/share`, { method: 'POST' });
      const full = `${API}/baseline/reports/shared/${b.shareToken}`;
      setReports(prev => ({ ...prev, [snapId]: { ...prev[snapId], shared: true, shareUrl: full } }));
      try { await navigator.clipboard.writeText(full); flash('Share link copied to clipboard'); }
      catch { flash('Share link created (copy below)'); }
    } catch (e) { fail(e, 'Share failed'); }
    finally { setBusy(''); }
  };

  const revokeShare = async (snapId, reportId) => {
    setBusy(`revoke-${reportId}`); setError('');
    try {
      await jfetch(`/baseline/reports/${reportId}/revoke-share`, { method: 'POST' });
      setReports(prev => ({ ...prev, [snapId]: { ...prev[snapId], shared: false, shareUrl: null } }));
      flash('Share link revoked');
    } catch (e) { fail(e, 'Revoke failed'); }
    finally { setBusy(''); }
  };

  // ── render ─────────────────────────────────────────────────────────────────

  const conn = connections.find(c => c.id === connId);
  const schemaSnap = detail?.latestSchemaSnapshot;
  const hasFrozenSchema = schemaSnap?.status === 'frozen';
  const detailStageMap = detail?.connection?.settings?.stage_map;
  const hasStageMap =
    (detailStageMap && Object.keys(detailStageMap).length > 0) ||
    (conn && conn.stage_map && Object.keys(conn.stage_map).length > 0);

  return (
    <div>
      {error  && <div style={{ ...card, borderColor: BAD, color: BAD }}>⚠️ {error} <button style={{ ...btn, marginLeft: 8 }} onClick={() => setError('')}>✕</button></div>}
      {notice && <div style={{ ...card, borderColor: OK, color: OK }}>✅ {notice}</div>}

      {/* 1 — Connection */}
      <div style={card}>
        <h3 style={h3}>1 · CRM connection</h3>
        <p style={sub}>Assessment runs read-only against this connection. Connect Salesforce/HubSpot from their pages first.</p>
        {connections.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13 }}>No connections found — connect Salesforce or HubSpot, then reload.</div>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={connId || ''} onChange={e => setConnId(Number(e.target.value))} style={{ ...btn, minWidth: 260 }}>
              {connections.map(c => (
                <option key={c.id} value={c.id}>
                  #{c.id} · {c.crm_type}{c.client_name ? ` · ${c.client_name}` : ''} · {c.purpose}
                </option>
              ))}
            </select>
            {conn && <span style={{ fontSize: 12.5, color: MUTED }}>{conn.instance_url || ''}</span>}
            {conn && <span style={chip(conn.purpose === 'assessment' ? WARN : BLUE)}>{conn.purpose}</span>}
          </div>
        )}
      </div>

      {/* 2 — Discovery */}
      <div style={card}>
        <h3 style={h3}>2 · Schema discovery</h3>
        <p style={sub}>Reads objects, custom fields with fill rates, stage definitions, validation rules. Frozen alongside the baseline — the config-debt findings come from here.</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button style={btnP} disabled={!connId || busy === 'discover'} onClick={runDiscovery}>
            {busy === 'discover' ? 'Discovering…' : hasFrozenSchema ? 'Re-run discovery' : 'Run discovery'}
          </button>
          {hasFrozenSchema && (
            <button style={btn} disabled={busy === 'schema'} onClick={openSchemaViewer}>
              {busy === 'schema' ? 'Loading…' : 'View discovery results'}
            </button>
          )}
          {schemaSnap && (
            <span style={{ fontSize: 13 }}>
              Latest: <span style={chip(STATUS_COLOR[schemaSnap.status] || MUTED)}>{schemaSnap.status}</span>
              <span style={{ color: MUTED, marginLeft: 6 }}>{new Date(schemaSnap.captured_at).toLocaleString()}</span>
              {schemaSnap.error_detail && <span style={{ color: BAD, marginLeft: 6 }}>{schemaSnap.error_detail}</span>}
            </span>
          )}
        </div>
      </div>

      {/* 3 — Stage mapping */}
      <div style={card}>
        <h3 style={h3}>3 · Stage mapping {hasStageMap && <span style={chip(OK)}>approved</span>}</h3>
        <p style={sub}>Human-approved mapping from the CRM's stages (their own won/lost metadata) to canonical keys. On unseeded assessment orgs this is an identity map in the CRM's own language.</p>
        <button style={btn} disabled={!hasFrozenSchema || busy === 'proposal'} onClick={loadProposal}>
          {busy === 'proposal' ? 'Loading…' : proposal ? 'Reload proposal' : 'Load mapping proposal'}
        </button>
        {!hasFrozenSchema && <span style={{ fontSize: 12.5, color: MUTED, marginLeft: 8 }}>Run discovery first.</span>}

        {proposal && (
          <div style={{ marginTop: 12 }}>
            {proposal.mode === 'identity' && (!proposal.orgStages || proposal.orgStages.length === 0) && (
              <div style={{ border: '1px solid #FDE68A', background: '#FFFBEB', borderRadius: 8, padding: 12, marginBottom: 10, fontSize: 13 }}>
                <b>This org has no canonical stages yet.</b> Choose how the assessment's stage keys are defined:
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button style={btn} disabled title="Current mode">✓ Use the CRM's own stages (identity — active)</button>
                  <button style={btn} disabled={seeding} onClick={adoptDefaultStages}>
                    {seeding ? 'Seeding…' : 'Adopt GoWarm default stages'}
                  </button>
                  <a href="#/org-admin/stages" style={{ ...btn, textDecoration: 'none', display: 'inline-block' }}>Define my own stages →</a>
                </div>
                <div style={{ color: MUTED, fontSize: 12, marginTop: 8 }}>
                  <b>What these keys do:</b> in identity mode they only name the rows of the baseline report — the org is measured in its own stage language.
                  Adopting or defining canonical stages maps the CRM onto a stage model that GoWarm playbooks, diagnostic rules, and deal health can later attach to
                  (stages only are created now; playbooks arrive if/when the org converts to a full customer).
                </div>
              </div>
            )}
            {proposal.orgStages && proposal.orgStages.length > 0 && (
              <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 8 }}>
                Mapping onto this org's <b>{proposal.orgStages.length} canonical stages</b> — each key is a stage that GoWarm playbooks attach to. Pick from the dropdown; leave blank to exclude a CRM stage.
                {proposal.orgLevelContext && (
                  <span> Org-level engines on top: {proposal.orgLevelContext.diagnosticOverrides > 0
                    ? `${proposal.orgLevelContext.diagnosticOverrides} diagnostic threshold overrides`
                    : 'diagnostic thresholds at defaults'}
                    {proposal.orgLevelContext.dealHealthConfigured ? ' · deal-health scoring configured' : ''} (these apply across all stages, not per stage).
                  </span>
                )}
              </div>
            )}
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>
                <th style={thS}>CRM stage</th><th style={thS}>Maps to key</th>
                {proposal.orgStages && proposal.orgStages.length > 0 && <th style={thS}>What attaches</th>}
                <th style={thS}>Confidence</th><th style={thS}>Why</th>
              </tr></thead>
              <tbody>
                {(proposal.proposals || []).map(p => (
                  <tr key={p.crmStage}>
                    <td style={tdS}>{p.crmLabel || p.crmStage}</td>
                    <td style={tdS}>
                      {proposal.orgStages && proposal.orgStages.length > 0 ? (
                        <select
                          style={{ ...btn, padding: '4px 8px', width: 200 }}
                          value={editMap[p.crmStage] ?? ''}
                          onChange={e => setEditMap(prev => ({ ...prev, [p.crmStage]: e.target.value }))}
                        >
                          <option value="">(unmapped — exclude)</option>
                          {proposal.orgStages.map(st => (
                            <option key={st.key} value={st.key}>{st.name} ({st.key}{st.stage_type !== 'active' ? ` · ${st.stage_type}` : ''})</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          style={{ ...btn, padding: '4px 8px', width: 180 }}
                          value={editMap[p.crmStage] ?? ''}
                          onChange={e => setEditMap(prev => ({ ...prev, [p.crmStage]: e.target.value }))}
                          placeholder="(unmapped)"
                        />
                      )}
                    </td>
                    {proposal.orgStages && proposal.orgStages.length > 0 && (
                      <td style={{ ...tdS, fontSize: 12 }}>
                        {(() => {
                          const key = editMap[p.crmStage];
                          if (!key) return <span style={{ color: MUTED }}>excluded — nothing fires</span>;
                          const c = (proposal.stageConsequences || {})[key];
                          if (!c) return <span style={{ color: MUTED }}>—</span>;
                          return (
                            <span>
                              <b>{c.plays}</b> play{c.plays === 1 ? '' : 's'}
                              {c.playbooks > 0 && <span style={{ color: MUTED }}> in {c.playbooks} playbook{c.playbooks === 1 ? '' : 's'}</span>}
                              {c.hasGuidance && <span> · guidance ✓</span>}
                              {c.plays === 0 && !c.hasGuidance && <span style={{ color: WARN }}> — stage defined but nothing attached yet</span>}
                            </span>
                          );
                        })()}
                      </td>
                    )}
                    <td style={tdS}><span style={chip(CONF_COLOR[p.confidence] || MUTED)}>{p.confidence}</span></td>
                    <td style={{ ...tdS, color: MUTED, fontSize: 12 }}>{p.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button style={{ ...btnP, marginTop: 10 }} disabled={busy === 'approve'} onClick={approveMap}>
              {busy === 'approve' ? 'Approving…' : 'Approve stage map'}
            </button>
          </div>
        )}
      </div>

      {/* 4 — Baselines */}
      <div style={card}>
        <h3 style={h3}>4 · Baseline capture</h3>
        <p style={sub}>Pulls stage history + open deals, computes the six metric families, freezes an immutable snapshot. Runs in the background; large orgs take minutes.</p>
        <button style={btnP} disabled={!hasStageMap || busy === 'capture'} onClick={startCapture}>
          {busy === 'capture' ? 'Starting…' : 'Capture baseline'}
        </button>
        {!hasStageMap && <span style={{ fontSize: 12.5, color: MUTED, marginLeft: 8 }}>Approve the stage map first.</span>}

        {snapshots.length > 0 && (
          <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12 }}>
            <thead><tr>
              <th style={thS}>#</th><th style={thS}>Status</th><th style={thS}>Captured</th><th style={thS}>Window</th><th style={thS}>Report</th>
            </tr></thead>
            <tbody>
              {snapshots.map(s => {
                const rep = reports[s.id];
                return (
                  <tr key={s.id}>
                    <td style={tdS}>{s.id}</td>
                    <td style={tdS}>
                      <span style={chip(STATUS_COLOR[s.status] || MUTED)}>{s.status}</span>
                      {s.error_detail && <div style={{ color: BAD, fontSize: 12 }}>{s.error_detail}</div>}
                    </td>
                    <td style={tdS}>{new Date(s.captured_at).toLocaleString()}</td>
                    <td style={{ ...tdS, color: MUTED }}>{s.history_from?.slice(0, 10)} → {s.history_to?.slice(0, 10)}</td>
                    <td style={tdS}>
                      {s.status !== 'frozen' ? <span style={{ color: MUTED }}>—</span> : !rep ? (
                        <button style={btn} disabled={busy === `report-${s.id}`} onClick={() => generateReport(s.id)}>
                          {busy === `report-${s.id}` ? 'Generating…' : 'Generate report'}
                        </button>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <button style={btn} onClick={() => viewReport(rep.id)}>View</button>
                          {!rep.shared ? (
                            <button style={btn} onClick={() => shareReport(s.id, rep.id)}>Share</button>
                          ) : (
                            <>
                              <button style={btn} onClick={() => revokeShare(s.id, rep.id)}>Revoke link</button>
                              {rep.shareUrl && <code style={{ fontSize: 11 }}>{rep.shareUrl}</code>}
                            </>
                          )}
                          <button style={btn} disabled={busy === `report-${s.id}`} onClick={() => generateReport(s.id)}>Regenerate</button>
                          <span style={{ fontSize: 11.5, color: MUTED }}>narrative: {rep.narrative_status}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {schemaView && (
        <DiscoveryViewer
          schema={schemaView.schema}
          warnings={schemaView.warnings}
          capturedAt={schemaView.capturedAt}
          onClose={() => setSchemaView(null)}
        />
      )}

      {/* Report viewer modal */}
      {viewer && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => e.target === e.currentTarget && setViewer(null)}
        >
          <div style={{ background: '#fff', borderRadius: 10, width: 'min(920px, 94vw)', height: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #e5e7eb' }}>
              <strong style={{ fontSize: 14 }}>Assessment report</strong>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={btn} onClick={() => {
                  const w = window.open('', '_blank');
                  w.document.write(viewer.html); w.document.close(); w.focus(); w.print();
                }}>Print / PDF</button>
                <button style={btn} onClick={() => setViewer(null)}>Close</button>
              </div>
            </div>
            <iframe title="assessment-report" srcDoc={viewer.html} style={{ border: 0, flex: 1, width: '100%' }} />
          </div>
        </div>
      )}
    </div>
  );
}
