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
            {proposal.mode === 'identity' && (
              <div style={{ fontSize: 12.5, color: WARN, marginBottom: 8 }}>
                Identity mode: this org has no playbook stages (assessment), so keys default to the CRM's own stage names.
              </div>
            )}
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>
                <th style={thS}>CRM stage</th><th style={thS}>Maps to key</th><th style={thS}>Confidence</th><th style={thS}>Why</th>
              </tr></thead>
              <tbody>
                {(proposal.proposals || []).map(p => (
                  <tr key={p.crmStage}>
                    <td style={tdS}>{p.crmLabel || p.crmStage}</td>
                    <td style={tdS}>
                      <input
                        style={{ ...btn, padding: '4px 8px', width: 180 }}
                        value={editMap[p.crmStage] ?? ''}
                        onChange={e => setEditMap(prev => ({ ...prev, [p.crmStage]: e.target.value }))}
                        placeholder="(unmapped)"
                      />
                    </td>
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
