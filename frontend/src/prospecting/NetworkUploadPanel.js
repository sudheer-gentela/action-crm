// src/prospecting/NetworkUploadPanel.js
//
// Upload a LinkedIn "Connections.csv" export → snapshot → job-change detection.
// Parses client-side (skipping LinkedIn's 3-line "Notes:" preamble), previews,
// then POSTs to /network-connections/snapshot. Shows the payoff (what changed)
// and the most recent detected moves. Matches GoWarmCRM's palette + card pattern.

import React, { useState, useEffect, useCallback } from 'react';
import { csvParse } from '../csvUtils';
import { apiFetch } from './prospectingShared';
import './NetworkUploadPanel.css';

// Strip the LinkedIn preamble (Notes: / quoted note / blank) and parse from the
// real header row. Returns connection objects in the API's camelCase shape.
function parseConnectionsCsv(text) {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^"?\s*First Name\s*"?\s*,/i.test(l));
  if (headerIdx === -1) {
    throw new Error("This doesn't look like a LinkedIn Connections export — no \"First Name\" header row found.");
  }
  const { headers, rows } = csvParse(lines.slice(headerIdx).join('\n'));
  const col = (name) => headers.findIndex((h) => (h || '').trim().toLowerCase() === name.toLowerCase());
  const ci = {
    firstName: col('First Name'), lastName: col('Last Name'), url: col('URL'),
    email: col('Email Address'), company: col('Company'), position: col('Position'),
    connectedOn: col('Connected On'),
  };
  const at = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  // Keep every data row (including privacy-blanked ones) so the row count stays
  // stable across exports — the server skips unkeyable rows itself.
  return rows.map((r) => ({
    firstName: at(r, ci.firstName), lastName: at(r, ci.lastName),
    linkedinUrl: at(r, ci.url), email: at(r, ci.email),
    company: at(r, ci.company), position: at(r, ci.position),
    connectedOn: at(r, ci.connectedOn),
  }));
}

function Card({ label, value, sub, accent }) {
  return (
    <div className={`nup-card ${accent ? 'nup-card-accent' : ''}`}>
      <div className="nup-card-label">{label}</div>
      <div className="nup-card-value">{value}</div>
      {sub != null && <div className="nup-card-sub">{sub}</div>}
    </div>
  );
}

const TYPE_LABEL = {
  company_change: 'Changed company',
  role_change: 'New role',
  new_connection: 'New connection',
  disconnect_confirmed: 'Disconnected',
};

function MoveBadges({ ev }) {
  const badges = [];
  if (ev.is_from_customer_account) badges.push(['Champion left', 'nup-badge-warn']);
  if (ev.is_into_target_account) badges.push(['Into target', 'nup-badge-good']);
  if (ev.is_into_icp_role) badges.push(['ICP role', 'nup-badge-info']);
  return (
    <span className="nup-badges">
      {badges.map(([t, c]) => <span key={t} className={`nup-badge ${c}`}>{t}</span>)}
    </span>
  );
}

export default function NetworkUploadPanel() {
  const [fileName, setFileName]   = useState('');
  const [connections, setConns]   = useState(null);  // parsed rows pending upload
  const [parseError, setParseErr] = useState('');
  const [uploading, setUploading] = useState(false);
  const [result, setResult]       = useState(null);  // { ingest, diff, plays, inbound, icp }
  const [uploadError, setUpErr]   = useState('');

  const [events, setEvents]       = useState([]);
  const [loadingEvents, setLE]    = useState(true);
  const [dragOver, setDragOver]   = useState(false);

  const loadEvents = useCallback(async () => {
    setLE(true);
    try {
      const r = await apiFetch('/network-connections/events?limit=50');
      setEvents(r.events || []);
    } catch (_) {
      setEvents([]);
    } finally {
      setLE(false);
    }
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const handleFile = (file) => {
    setParseErr(''); setUpErr(''); setResult(null); setConns(null); setFileName(file?.name || '');
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseConnectionsCsv(String(reader.result || ''));
        if (parsed.length === 0) throw new Error('No connection rows found in this file.');
        setConns(parsed);
      } catch (e) {
        setParseErr(e.message || 'Could not read this file.');
      }
    };
    reader.onerror = () => setParseErr('Could not read this file.');
    reader.readAsText(file);
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    handleFile(e.dataTransfer?.files?.[0]);
  };

  const upload = async () => {
    if (!connections) return;
    setUploading(true); setUpErr('');
    try {
      const r = await apiFetch('/network-connections/snapshot', {
        method: 'POST',
        body: JSON.stringify({ source: 'csv_export', connections }),
      });
      setResult(r);
      setConns(null); setFileName('');
      loadEvents();
    } catch (e) {
      setUpErr(e.message || 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  // Preview stats
  const stats = connections && {
    total: connections.length,
    withUrl: connections.filter((c) => c.linkedinUrl).length,
    withName: connections.filter((c) => c.firstName || c.lastName).length,
  };

  // Result-derived counts
  let summary = null;
  if (result) {
    const d = result.diff || {}, p = result.plays || {}, inb = result.inbound || {}, icp = result.icp || {};
    const bt = d.byType || {};
    summary = {
      baseline: !!d.baseline,
      ingested: result.ingest?.rows ?? 0,
      added: result.ingest?.inserted ?? 0,
      incomplete: result.ingest?.isComplete === false,
      jobChanges: (bt.company_change || 0) + (bt.role_change || 0),
      newConns: bt.new_connection || 0,
      disconnects: d.disconnected || 0,
      championLeft: p.championLeft || 0,
      intoTarget: inb.intoTarget || 0,
      icpMoves: icp.icpMoves || 0,
      promoted: (p.promoted || 0) + (inb.promoted || 0) + (icp.promoted || 0),
    };
  }

  return (
    <div className="nup-root">
      <header className="nup-head">
        <h2 className="nup-title">Network job changes</h2>
        <p className="nup-lede">
          Upload your LinkedIn connections export. We snapshot it, compare it to your last upload,
          and surface who changed jobs — so you can act on warm moves into your accounts.
        </p>
      </header>

      {/* Uploader */}
      <div
        className={`nup-drop ${dragOver ? 'nup-drop-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="nup-drop-icon" aria-hidden>🕸️</div>
        <div className="nup-drop-main">
          <label className="nup-file-btn">
            Choose Connections.csv
            <input
              type="file" accept=".csv,text/csv" className="nup-file-input"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </label>
          <span className="nup-drop-hint">or drag the file here</span>
        </div>
        <details className="nup-how">
          <summary>How do I export it?</summary>
          <ol>
            <li>On LinkedIn: <b>Settings &amp; Privacy → Data privacy → Get a copy of your data</b>.</li>
            <li>Pick <b>Connections</b>, request the archive, and download the email link.</li>
            <li>Upload the <code>Connections.csv</code> from that archive here.</li>
          </ol>
        </details>
      </div>

      {parseError && <div className="nup-alert nup-alert-err">{parseError}</div>}

      {/* Preview before upload */}
      {stats && (
        <div className="nup-preview">
          <div className="nup-preview-head">
            <span className="nup-file-name">{fileName}</span>
            <span className="nup-preview-sub">Ready to upload</span>
          </div>
          <div className="nup-cards">
            <Card label="Connections" value={stats.total.toLocaleString()} />
            <Card label="With profile URL" value={stats.withUrl.toLocaleString()}
                  sub={`${Math.round((stats.withUrl / stats.total) * 100)}% matchable`} />
            <Card label="Named" value={stats.withName.toLocaleString()} />
          </div>
          <div className="nup-actions">
            <button className="nup-primary" onClick={upload} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload snapshot'}
            </button>
            <button className="nup-ghost" onClick={() => { setConns(null); setFileName(''); }} disabled={uploading}>
              Cancel
            </button>
          </div>
          {uploadError && <div className="nup-alert nup-alert-err">{uploadError}</div>}
        </div>
      )}

      {/* Result / payoff */}
      {summary && (
        <div className="nup-result">
          {summary.baseline ? (
            <div className="nup-alert nup-alert-ok">
              Baseline saved — {summary.ingested.toLocaleString()} connections recorded.
              Upload again next week and we'll show you what changed.
            </div>
          ) : (
            <>
              <div className="nup-result-head">Snapshot processed</div>
              <div className="nup-cards">
                <Card label="Job changes" value={summary.jobChanges} accent />
                <Card label="Champions left a customer" value={summary.championLeft} />
                <Card label="Into target accounts" value={summary.intoTarget} />
                <Card label="Into ICP roles" value={summary.icpMoves} />
                <Card label="Promoted to prospects" value={summary.promoted} />
                <Card label="New connections" value={summary.newConns} />
              </div>
            </>
          )}
          {summary.incomplete && (
            <div className="nup-alert nup-alert-warn">
              This upload was noticeably smaller than your last one, so disconnects are held back
              until your next upload confirms them. Job changes were still processed.
            </div>
          )}
        </div>
      )}

      {/* Detected moves */}
      <section className="nup-feed">
        <div className="nup-feed-head">Recent moves</div>
        {loadingEvents ? (
          <div className="nup-muted">Loading…</div>
        ) : events.length === 0 ? (
          <div className="nup-empty">
            No job changes detected yet. Upload a second snapshot after some time has passed to see moves here.
          </div>
        ) : (
          <div className="nup-table-wrap">
            <table className="nup-table">
              <thead>
                <tr><th>Person</th><th>Move</th><th>From → To</th><th>When</th></tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td>
                      {ev.linkedin_url
                        ? <a href={ev.linkedin_url} target="_blank" rel="noreferrer" className="nup-link">{ev.full_name || '—'}</a>
                        : (ev.full_name || '—')}
                      <MoveBadges ev={ev} />
                    </td>
                    <td>{TYPE_LABEL[ev.event_type] || ev.event_type}</td>
                    <td className="nup-fromto">
                      {ev.event_type === 'role_change'
                        ? <span>{ev.from_title || '—'} → <b>{ev.to_title || '—'}</b></span>
                        : <span>{ev.from_company || '—'} → <b>{ev.to_company || '—'}</b></span>}
                    </td>
                    <td className="nup-muted">{ev.detected_at ? new Date(ev.detected_at).toLocaleDateString() : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
