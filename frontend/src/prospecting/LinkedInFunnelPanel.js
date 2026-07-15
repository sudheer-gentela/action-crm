// LinkedInFunnelPanel — the P5b drill-through: request → accepted → followed
// up → replied, one row per attributed prospect (the caller's own — the
// endpoint is owner-scoped, mirroring how reps use the message sync).
//
// Rendered as the "LinkedIn funnel" tab inside TeamReportingView. Deliberately
// a TABLE, not a dashboard: at this denominator every row is readable, and
// drill-through catches what aggregates hide (design doc P0.1 decision).
// "Followed up" uses the F18 definition server-side — connection-request
// notes never count as follow-up.
//
// The caveats strip renders the endpoint's own honesty payload (Sales Nav /
// mobile invisibility, sync-bounded freshness — design doc §11/N6): the
// numbers must never look more complete than they are.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';
import './LinkedInFunnelPanel.css';

const STAGE_META = {
  requested:   { label: 'Requested',   color: '#6b7280' },
  accepted:    { label: 'Accepted',    color: '#3b82f6' },
  followed_up: { label: 'Followed up', color: '#0F9D8E' },
  replied:     { label: 'Replied',     color: '#16a34a' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return '—';
  const dDays = Math.floor(diff / 86400000);
  if (dDays < 1)  return 'today';
  if (dDays === 1) return '1d ago';
  if (dDays < 30) return `${dDays}d ago`;
  return fmtDate(iso);
}

export default function LinkedInFunnelPanel() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [genState, setGen]    = useState(null);   // null | 'running' | result string
  const [stageFilter, setStageFilter] = useState(null);   // null | stage key (cumulative)
  const [detail, setDetail]   = useState(null);           // { loading } | { prospect, messages, activities } | { error }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch('/linkedin-connections/funnel');
      setData(res);
    } catch (err) {
      setError(err.message || 'Failed to load funnel');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const generateActions = async () => {
    setGen('running');
    try {
      const res = await apiFetch('/linkedin-connections/generate-followup-actions', { method: 'POST' });
      const c = (res.result && res.result.created)   || {};
      const d = (res.result && res.result.completed) || {};
      const r = res.retro || {};
      setGen(
        `Created ${(c.reply_needs_response || 0) + (c.accepted_no_followup || 0)}, ` +
        `auto-completed ${(d.reply_needs_response || 0) + (d.accepted_no_followup || 0)}` +
        (r.recounted ? `, retro-counted ${r.recounted} message(s)` : '')
      );
      await load();   // retro-count may have changed rows
    } catch (err) {
      setGen('Failed: ' + (err.message || 'unknown'));
    }
  };

  // Cumulative stage membership — matches how the summary counts are built
  // (an "Accepted" card count includes followed_up and replied), so clicking
  // a card always shows exactly the number printed on it.
  const STAGE_RANK = { requested: 0, accepted: 1, followed_up: 2, replied: 3 };
  const matchesFilter = (r) => !stageFilter || STAGE_RANK[r.stage] >= STAGE_RANK[stageFilter];

  const openDetail = async (prospectId) => {
    setDetail({ loading: true });
    try {
      const res = await apiFetch(`/linkedin-connections/funnel/${prospectId}`);
      setDetail(res);
    } catch (err) {
      setDetail({ error: err.message || 'Failed to load prospect detail' });
    }
  };

  if (loading && !data) return <div className="lifp-status">Loading LinkedIn funnel…</div>;
  if (error)            return <div className="lifp-status lifp-error">{error}</div>;
  if (!data)            return null;

  const { summary, rows, caveats } = data;
  const pct = (n) => summary.requested ? Math.round((n / summary.requested) * 100) : 0;

  return (
    <div className="lifp-root">
      {/* Funnel summary strip */}
      <div className="lifp-summary">
        {['requested', 'accepted', 'followed_up', 'replied'].map((k, i) => (
          <React.Fragment key={k}>
            {i > 0 && <span className="lifp-arrow">→</span>}
            <div
              className={'lifp-stage lifp-stage-clickable' + (stageFilter === k ? ' lifp-stage-active' : '')}
              style={{ borderColor: STAGE_META[k].color,
                       boxShadow: stageFilter === k ? `0 0 0 2px ${STAGE_META[k].color}33` : undefined }}
              title={stageFilter === k ? 'Click to clear filter' : `Show ${STAGE_META[k].label.toLowerCase()}+`}
              onClick={() => setStageFilter(stageFilter === k ? null : k)}
            >
              <div className="lifp-stage-count" style={{ color: STAGE_META[k].color }}>
                {summary[k]}
              </div>
              <div className="lifp-stage-label">
                {STAGE_META[k].label}
                {k !== 'requested' && <span className="lifp-stage-pct"> · {pct(summary[k])}%</span>}
              </div>
            </div>
          </React.Fragment>
        ))}
        <div className="lifp-actions">
          <button className="lifp-btn" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="lifp-btn lifp-btn-primary" onClick={generateActions}
                  disabled={genState === 'running'}>
            {genState === 'running' ? 'Generating…' : 'Generate follow-up actions'}
          </button>
        </div>
      </div>
      {genState && genState !== 'running' && (
        <div className="lifp-genresult">{genState}</div>
      )}

      {/* Drill-through */}
      <table className="lifp-table">
        <thead>
          <tr>
            <th>Prospect</th><th>Company</th><th>Stage</th>
            <th>Requested</th><th>Accepted</th><th>Verified</th>
            <th>First follow-up</th><th>Last reply</th><th>Replies</th>
            <th>Identity</th><th>Thread</th>
          </tr>
        </thead>
        <tbody>
          {rows.filter(matchesFilter).map(r => (
            <tr key={r.prospectId} className="lifp-row-clickable"
                onClick={() => openDetail(r.prospectId)}>
              <td className="lifp-name">{r.name || '—'}</td>
              <td>{r.company || '—'}</td>
              <td>
                <span className="lifp-chip"
                      style={{ background: STAGE_META[r.stage].color }}>
                  {STAGE_META[r.stage].label}
                </span>
              </td>
              <td>{fmtDate(r.requestSentAt)}</td>
              <td>{fmtDate(r.connectedAt)}</td>
              <td title={r.verifiedAt || ''}>{r.verifiedAt ? relTime(r.verifiedAt) : '—'}</td>
              <td>{fmtDate(r.firstFollowupAt)}</td>
              <td>{r.lastReplyAt ? relTime(r.lastReplyAt) : '—'}</td>
              <td className="lifp-num">{r.replyCount || 0}</td>
              <td className="lifp-num" title={r.identityResolved ? 'member_urn resolved' : 'Run Resolve identities in the extension'}>
                {r.identityResolved ? '✓' : '—'}
              </td>
              <td>
                {r.threadUrl
                  ? <a href={r.threadUrl} target="_blank" rel="noopener noreferrer"
                       className="lifp-threadlink" onClick={e => e.stopPropagation()}>open ↗</a>
                  : '—'}
              </td>
            </tr>
          ))}
          {rows.length > 0 && rows.filter(matchesFilter).length === 0 && (
            <tr><td colSpan={11} className="lifp-empty">
              No prospects at this stage — click the highlighted card again to clear the filter.
            </td></tr>
          )}
          {rows.length === 0 && (
            <tr><td colSpan={11} className="lifp-empty">
              No attributed prospects yet — send LinkedIn connection requests through
              GoWarm and they will appear here.
            </td></tr>
          )}
        </tbody>
      </table>

      {/* Prospect detail drawer */}
      {detail && (
        <div className="lifp-drawer-backdrop" onClick={() => setDetail(null)}>
          <div className="lifp-drawer" onClick={e => e.stopPropagation()}>
            <button className="lifp-drawer-close" onClick={() => setDetail(null)}>×</button>
            {detail.loading && <div className="lifp-status">Loading…</div>}
            {detail.error && <div className="lifp-status lifp-error">{detail.error}</div>}
            {detail.prospect && (
              <>
                <div className="lifp-drawer-head">
                  <div>
                    <div className="lifp-drawer-name">{detail.prospect.name}</div>
                    <div className="lifp-drawer-company">{detail.prospect.company || ''}</div>
                  </div>
                  <div className="lifp-drawer-links">
                    {detail.prospect.linkedinUrl && (
                      <a href={detail.prospect.linkedinUrl} target="_blank" rel="noopener noreferrer"
                         className="lifp-btn">LinkedIn profile ↗</a>
                    )}
                    {(() => {
                      const t = (detail.messages || []).find(m => m.threadUrn);
                      return t ? (
                        <a href={'https://www.linkedin.com/messaging/thread/' +
                                 t.threadUrn.replace('urn:li:messagingThread:', '') + '/'}
                           target="_blank" rel="noopener noreferrer" className="lifp-btn">Conversation ↗</a>
                      ) : null;
                    })()}
                  </div>
                </div>

                <div className="lifp-drawer-facts">
                  <div><span>Requested</span>{fmtDate(detail.prospect.requestSentAt)}</div>
                  <div><span>Accepted</span>{fmtDate(detail.prospect.connectedAt)}</div>
                  <div><span>Verified</span>{detail.prospect.verifiedAt ? relTime(detail.prospect.verifiedAt) : '—'}</div>
                  <div><span>Status</span>{detail.prospect.liStatus || '—'}</div>
                  <div><span>Messages</span>{detail.prospect.messageCount}</div>
                  <div><span>Replies</span>{detail.prospect.replyCount}</div>
                </div>

                <div className="lifp-drawer-section">Message ledger</div>
                {(detail.messages || []).length === 0 && (
                  <div className="lifp-drawer-empty">No messages recorded — open the conversation in LinkedIn and click Sync in the extension.</div>
                )}
                {(detail.messages || []).map((m, i) => (
                  <div key={i} className="lifp-msg-row">
                    <span className={'lifp-msg-dir ' + (m.direction === 'inbound' ? 'lifp-in' : 'lifp-out')}>
                      {m.direction === 'inbound' ? '← reply' : '→ sent'}
                    </span>
                    <span className="lifp-msg-when" title={m.occurredAt}>{relTime(m.occurredAt)} · {fmtDate(m.occurredAt)}</span>
                    {!m.counted && <span className="lifp-msg-uncounted" title="Pre-acceptance (e.g. connection-request note) — recorded but not counted">not counted</span>}
                  </div>
                ))}
                <div className="lifp-drawer-note">
                  Message text is never stored — GoWarm records who messaged whom and when. Open the conversation for content.
                </div>

                <div className="lifp-drawer-section">Activity</div>
                {(detail.activities || []).map((a, i) => (
                  <div key={i} className="lifp-act-row">
                    <span className="lifp-act-desc">{a.description}</span>
                    <span className="lifp-msg-when">{fmtDate(a.createdAt)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Honesty strip — straight from the endpoint (design doc §11/N6) */}
      {caveats && caveats.length > 0 && (
        <div className="lifp-caveats">
          {caveats.map((c, i) => <div key={i}>ⓘ {c}</div>)}
        </div>
      )}
    </div>
  );
}
