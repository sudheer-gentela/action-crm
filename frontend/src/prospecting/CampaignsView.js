// CampaignsView.js — Campaigns tab for the Prospecting feature.
//
// A campaign is a project that runs while prospecting for a particular
// solution. This view has two parts:
//   • CampaignsView        — the campaign list (status-filtered)
//   • CampaignDetailDrawer — a right slide-out with funnel, metrics, member
//                            preview, and actions (import / enroll-all /
//                            view-in-pipeline / edit / pause).
//
// Reuses the pv-detail-* drawer styling from ProspectingView.css and the
// shared apiFetch (token-refresh aware). No new CSS file — inline styles for
// campaign-specific bits, matching the GoWarm palette (Ember/Navy/Teal).
//
// "View in Pipeline" dispatches a 'campaign-filter' window event that
// ProspectingView listens for; it switches to the Pipeline board with a
// dismissible campaign filter banner.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, DEFAULT_PROSPECT_STAGES } from './prospectingShared';
import CSVImportModal from '../CSVImportModal';

// Stage colors for the funnel — keyed to DEFAULT_PROSPECT_STAGES keys.
const STAGE_META = {
  target:         { label: 'Target',     color: '#6b7280' },
  research:       { label: 'Research',   color: '#8b5cf6' },
  outreach:       { label: 'Outreach',   color: '#3b82f6' },
  engaged:        { label: 'Engaged',    color: '#0F9D8E' },
  discovery_call: { label: 'Disc. call', color: '#f59e0b' },
  qualified_sal:  { label: 'SAL',        color: '#10b981' },
};

const STATUS_STYLE = {
  active:    { bg: '#ecfdf5', fg: '#059669', label: 'Active' },
  paused:    { bg: '#fffbeb', fg: '#b45309', label: 'Paused' },
  completed: { bg: '#eff6ff', fg: '#1d4ed8', label: 'Completed' },
  archived:  { bg: '#f3f4f6', fg: '#6b7280', label: 'Archived' },
};

const EMBER = '#E8630A';

// ─────────────────────────────────────────────────────────────────────────────
// SequenceHealthTile — surfaces draft/sent/failed counts per sequence for
// this campaign over the last 24h and 7d. Reads from
// /api/prospecting-campaigns/:id/sequence-health (Sprint 4).
//
// Display rules:
//   - If failed_24h > 0 → RED status pill ("Failing").
//   - Else if stalledEnrollments > 0 → AMBER pill ("Stalled").
//   - Else → GREEN pill ("Healthy"), or grey "Idle" if no recent activity.
//
// Reps see this on the campaign detail page so silent draft-generation
// failures don't go unnoticed. Before Sprint 4, errors only hit console.log.
// ─────────────────────────────────────────────────────────────────────────────
function SequenceHealthTile({ campaignId }) {
  const [health, setHealth]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/prospecting-campaigns/${campaignId}/sequence-health`)
      .then(r => { if (!cancelled) setHealth(r.health || []); })
      .catch(() => { if (!cancelled) setHealth([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [campaignId]);

  if (loading) {
    return (
      <div style={{ margin: '14px 0', fontSize: 11, color: '#9ca3af' }}>
        Loading sequence health…
      </div>
    );
  }
  if (!health || health.length === 0) return null;  // no sequences = no tile

  const statusFor = (h) => {
    if (h.last24h.failed > 0)       return { bg: '#fef2f2', fg: '#991b1b', label: 'Failing' };
    if (h.stalledEnrollments > 0)   return { bg: '#fffbeb', fg: '#b45309', label: 'Stalled' };
    if ((h.last7d.sent + h.last7d.drafts + h.last7d.replied) === 0)
      return { bg: '#f3f4f6', fg: '#6b7280', label: 'Idle' };
    return { bg: '#ecfdf5', fg: '#059669', label: 'Healthy' };
  };

  return (
    <div style={{ margin: '14px 0 18px' }}>
      <div style={{
        fontSize: 11, color: '#6b7280', fontWeight: 600,
        letterSpacing: 0.3, marginBottom: 6,
      }}>
        SEQUENCE HEALTH
      </div>
      <div style={{
        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
        overflow: 'hidden',
      }}>
        {health.map((h, idx) => {
          const status = statusFor(h);
          const isExpanded = !!expanded[h.sequenceId];
          return (
            <div key={h.sequenceId} style={{
              borderTop: idx === 0 ? 'none' : '1px solid #f3f4f6',
            }}>
              <button
                onClick={() => setExpanded(prev => ({ ...prev, [h.sequenceId]: !isExpanded }))}
                style={{
                  width: '100%', padding: '10px 12px', background: '#fff',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}
              >
                <span style={{
                  padding: '2px 8px', fontSize: 10, fontWeight: 700,
                  background: status.bg, color: status.fg, borderRadius: 10,
                }}>
                  {status.label}
                </span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{h.sequenceName}</span>
                <span style={{ fontSize: 11, color: '#6b7280' }}>
                  24h: <strong>{h.last24h.sent}</strong> sent
                  {h.last24h.failed > 0 && (
                    <>, <span style={{ color: '#dc2626' }}><strong>{h.last24h.failed}</strong> failed</span></>
                  )}
                  {h.last24h.drafts > 0 && <>, {h.last24h.drafts} drafts</>}
                </span>
                <span style={{ fontSize: 10, color: '#9ca3af' }}>
                  {isExpanded ? '▾' : '▸'}
                </span>
              </button>

              {isExpanded && (
                <div style={{ padding: '4px 12px 12px', fontSize: 12, color: '#374151' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>Last 7 days</div>
                      <div style={{ color: '#6b7280', fontSize: 11 }}>
                        {h.last7d.sent} sent · {h.last7d.replied} replied · {h.last7d.drafts} drafts
                        {h.last7d.failed > 0 && <span style={{ color: '#dc2626' }}> · {h.last7d.failed} failed</span>}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>Stalled enrollments</div>
                      <div style={{ color: h.stalledEnrollments > 0 ? '#b45309' : '#6b7280', fontSize: 11 }}>
                        {h.stalledEnrollments} active enrollment{h.stalledEnrollments === 1 ? '' : 's'} with no activity in 7d
                      </div>
                    </div>
                  </div>
                  {h.lastFiredAt && (
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>
                      Last activity: {new Date(h.lastFiredAt).toLocaleString()}
                    </div>
                  )}
                  {h.topErrors && h.topErrors.length > 0 && (
                    <div style={{
                      marginTop: 6, padding: 8,
                      background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6,
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#991b1b', marginBottom: 4 }}>
                        Top failure reasons (last 7d)
                      </div>
                      {h.topErrors.map((e, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#7f1d1d', fontFamily: 'ui-monospace, monospace' }}>
                          <strong>{e.count}×</strong> {e.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.active;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 8px',
      borderRadius: 6, background: s.bg, color: s.fg,
    }}>{s.label}</span>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CAMPAIGNS VIEW — list
// ═════════════════════════════════════════════════════════════════════════════

export default function CampaignsView() {
  const [campaigns,   setCampaigns]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // active|paused|completed|all
  const [showCreate,  setShowCreate]  = useState(false);
  const [editing,     setEditing]     = useState(null);   // campaign being edited (or null)
  const [detailId,    setDetailId]    = useState(null);   // campaign id open in drawer

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const qs = statusFilter === 'all' ? '' : `?status=${statusFilter}`;
      const r = await apiFetch(`/prospecting-campaigns${qs}`);
      setCampaigns(r.campaigns || []);
      setError('');
    } catch (err) {
      setError('Failed to load campaigns: ' + (err.message || 'unknown error'));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  const handleSaved = () => {
    setShowCreate(false);
    setEditing(null);
    fetchCampaigns();
  };

  return (
    <div className="pv-campaigns">
      {/* Sub-header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { key: 'active',    label: 'Active' },
            { key: 'paused',    label: 'Paused' },
            { key: 'completed', label: 'Completed' },
            { key: 'all',       label: 'All' },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              style={{
                fontSize: 12, padding: '4px 12px', borderRadius: 6,
                cursor: 'pointer', fontWeight: 600,
                border: '1px solid ' + (statusFilter === f.key ? EMBER : '#e5e7eb'),
                background: statusFilter === f.key ? '#fff8f0' : '#fff',
                color: statusFilter === f.key ? EMBER : '#6b7280',
              }}
            >{f.label}</button>
          ))}
        </div>
        <button className="pv-btn-primary" onClick={() => setShowCreate(true)}>
          + New Campaign
        </button>
      </div>

      {error && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
          padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 12,
        }}>{error}</div>
      )}

      {loading ? (
        <div className="pv-loading">Loading campaigns...</div>
      ) : campaigns.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '48px 20px', color: '#9ca3af', fontSize: 14,
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚀</div>
          No {statusFilter !== 'all' ? statusFilter : ''} campaigns yet.
          <div style={{ marginTop: 8 }}>
            <button className="pv-btn-secondary" onClick={() => setShowCreate(true)}>
              Create your first campaign
            </button>
          </div>
        </div>
      ) : (
        <div style={{
          border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden',
          background: '#fff',
        }}>
          {campaigns.map((c, idx) => (
            <CampaignRow
              key={c.id}
              campaign={c}
              isLast={idx === campaigns.length - 1}
              onClick={() => setDetailId(c.id)}
            />
          ))}
        </div>
      )}

      {(showCreate || editing) && (
        <CampaignFormModal
          campaign={editing}
          onSaved={handleSaved}
          onClose={() => { setShowCreate(false); setEditing(null); }}
        />
      )}

      {detailId && (
        <CampaignDetailDrawer
          campaignId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={fetchCampaigns}
          onEdit={(c) => { setDetailId(null); setEditing(c); }}
        />
      )}
    </div>
  );
}

// ── CampaignRow ──────────────────────────────────────────────────────────────
function CampaignRow({ campaign: c, isLast, onClick }) {
  const prospectCount = parseInt(c.prospect_count || 0, 10);
  const qualified     = parseInt(c.qualified_count || 0, 10);
  const goal          = c.goal_qualified || null;
  const pct = goal ? Math.min(100, Math.round((qualified / goal) * 100)) : 0;

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', padding: '14px 16px',
        borderBottom: isLast ? 'none' : '1px solid #f1f5f9', cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = '#fafafa'; }}
      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#1A3A5C' }}>{c.name}</span>
          <StatusPill status={c.status} />
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {c.solution && <span style={{ marginRight: 10 }}>💡 {c.solution}</span>}
          📋 {c.playbook_name || 'No playbook'}
          {'  ·  '}
          📨 {c.default_sequence_name || 'No default sequence'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 20, textAlign: 'right', alignItems: 'center' }}>
        <Stat value={prospectCount} label="prospects" />
        <Stat value={qualified} label="qualified" color="#059669" />
        <div style={{ width: 92 }}>
          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>
            {goal ? `goal ${goal}` : 'no goal'}
          </div>
          <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}>
            {goal > 0 && (
              <div style={{ width: `${pct}%`, height: '100%', background: '#059669' }} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, color }) {
  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 700, color: color || '#1f2937' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#9ca3af' }}>{label}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CAMPAIGN DETAIL DRAWER
// ═════════════════════════════════════════════════════════════════════════════

function CampaignDetailDrawer({ campaignId, onClose, onChanged, onEdit }) {
  const [data,     setData]     = useState(null);   // { campaign, funnel, terminal, metrics }
  const [members,  setMembers]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [busy,     setBusy]     = useState(false);
  const [showImport,   setShowImport]   = useState(false);
  const [showEnroll,   setShowEnroll]   = useState(false);

  // Channel filter for the outreach metric cards. `null` = show all channels
  // side-by-side. A specific value collapses the cards to that channel only.
  // The filter is sent to the API so the server doesn't return data for
  // channels we won't display.
  const [channelFilter, setChannelFilter] = useState(null);

  const load = useCallback(async (chFilter) => {
    setLoading(true);
    try {
      const qs = chFilter ? `?channel=${chFilter}` : '';
      const r = await apiFetch(`/prospecting-campaigns/${campaignId}${qs}`);
      setData(r);
      // Member preview — up to 10, via the prospects list scoped by campaign.
      const pr = await apiFetch(`/prospects?scope=org&campaignId=${campaignId}`);
      setMembers((pr.prospects || []).slice(0, 10));
      setError('');
    } catch (err) {
      setError('Failed to load campaign: ' + (err.message || 'unknown error'));
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(channelFilter); }, [load, channelFilter]);

  const togglePause = async () => {
    if (!data) return;
    const next = data.campaign.status === 'active' ? 'paused' : 'active';
    setBusy(true);
    try {
      await apiFetch(`/prospecting-campaigns/${campaignId}`, {
        method: 'PUT', body: JSON.stringify({ status: next }),
      });
      await load(channelFilter);
      onChanged?.();
    } catch (err) {
      setError('Could not update status: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (rows) => {
    // Reuse the bulk endpoint, scoped to this campaign.
    const res = await apiFetch('/prospects/bulk', {
      method: 'POST',
      body: JSON.stringify({ prospects: rows, source: 'csv_import', campaignId }),
    });
    await load(channelFilter);
    onChanged?.();
    return res;
  };

  const viewInPipeline = () => {
    if (!data) return;
    window.dispatchEvent(new CustomEvent('campaign-filter', {
      detail: { campaignId, campaignName: data.campaign.name },
    }));
    onClose();
  };

  const totalProspects = data?.metrics?.totalProspects || 0;

  return (
    <div className="pv-detail-overlay" onClick={onClose}>
      <div className="pv-detail-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="pv-detail-header">
          <div>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>← Campaigns</span>
            <h3 style={{ marginTop: 2 }}>
              {data?.campaign?.name || 'Campaign'}
            </h3>
            {data && (
              <span className="pv-detail-title">
                <StatusPill status={data.campaign.status} />
                {data.campaign.solution && (
                  <span style={{ marginLeft: 8 }}>{data.campaign.solution}</span>
                )}
              </span>
            )}
          </div>
          <button className="pv-detail-close" onClick={onClose}>×</button>
        </div>

        {loading ? (
          <div className="pv-loading" style={{ padding: 32 }}>Loading campaign...</div>
        ) : error ? (
          <div style={{ padding: 20, color: '#991b1b', fontSize: 13 }}>{error}</div>
        ) : !data ? null : (
          <div style={{ padding: 20, overflowY: 'auto' }}>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
              <button className="pv-btn-secondary" disabled={busy}
                onClick={() => onEdit?.(data.campaign)}>✎ Edit</button>
              <button className="pv-btn-secondary" disabled={busy} onClick={togglePause}>
                {data.campaign.status === 'active' ? '⏸ Pause' : '▶ Resume'}
              </button>
              <button className="pv-btn-secondary" onClick={() => setShowImport(true)}>
                ⬆ Import prospects
              </button>
            </div>

            {/* Metric cards — top row: prospects + total touches + in-sequences */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12,
            }}>
              <MetricCard label="Prospects"      value={data.metrics.totalProspects} />
              <MetricCard label="Outreach / wk"  value={data.metrics.outreachThisWeek} />
              <MetricCard label="Responses / wk" value={data.metrics.responsesThisWeek} />
              <MetricCard label="In sequences"   value={data.metrics.activeEnrollments} />
            </div>

            {/* Channel filter pills + per-channel cards. byChannel always
                returns exactly the channels the API decided to surface
                (filtered by ?channel= if set). When no filter, all three
                channels render side-by-side; when filtered, only one card. */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: 8,
            }}>
              <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, letterSpacing: 0.3 }}>
                BY CHANNEL — THIS WEEK
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[
                  { key: null,       label: 'All' },
                  { key: 'email',    label: '✉ Email' },
                  { key: 'linkedin', label: 'in LinkedIn' },
                  { key: 'call',     label: '☎ Call' },
                ].map(opt => {
                  const active = channelFilter === opt.key;
                  return (
                    <button
                      key={String(opt.key)}
                      onClick={() => setChannelFilter(opt.key)}
                      style={{
                        padding: '3px 10px', fontSize: 11, fontWeight: 600,
                        background: active ? '#111827' : '#fff',
                        color:      active ? '#fff'    : '#374151',
                        border: `1px solid ${active ? '#111827' : '#d1d5db'}`,
                        borderRadius: 12, cursor: 'pointer',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: channelFilter
                ? '1fr 1fr'
                : 'repeat(3, 1fr)',
              gap: 8, marginBottom: 20,
            }}>
              {Object.entries(data.metrics.byChannel || {}).map(([ch, stats]) => {
                const chLabel = ch === 'email' ? '✉ Email'
                             : ch === 'linkedin' ? 'in LinkedIn'
                             : ch === 'call' ? '☎ Call'
                             : ch;
                return channelFilter
                  ? (
                    // Filtered view: separate outreach + responses cards for the one channel.
                    <React.Fragment key={ch}>
                      <MetricCard label={`${chLabel} — outreach`}  value={stats.outreach} />
                      <MetricCard label={`${chLabel} — responses`} value={stats.responses} />
                    </React.Fragment>
                  )
                  : (
                    // All-channels view: one card per channel showing outreach / responses pair.
                    <div key={ch} style={{
                      background: '#fff', border: '1px solid #e5e7eb',
                      borderRadius: 8, padding: 12,
                    }}>
                      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>
                        {chLabel}
                      </div>
                      <div style={{ display: 'flex', gap: 16 }}>
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>{stats.outreach}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af' }}>outreach</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>{stats.responses}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af' }}>responses</div>
                        </div>
                      </div>
                    </div>
                  );
              })}
            </div>

            {/* Goal progress */}
            {data.campaign.goal_qualified && (
              <div style={{ marginBottom: 20 }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 12, color: '#6b7280', marginBottom: 5,
                }}>
                  <span>Qualified (SAL) goal</span>
                  <span style={{ fontWeight: 600 }}>
                    {data.metrics.qualified} / {data.campaign.goal_qualified}
                  </span>
                </div>
                <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(100, Math.round((data.metrics.qualified / data.campaign.goal_qualified) * 100))}%`,
                    height: '100%', background: '#059669',
                  }} />
                </div>
              </div>
            )}

            {/* Funnel */}
            <SectionTitle>Funnel</SectionTitle>
            <Funnel funnel={data.funnel} terminal={data.terminal} />

            {/* Prospects by source — small mini-card row. Only renders when
                we have at least one prospect, otherwise the empty pills look
                awkward against an empty campaign. */}
            {data.metrics.bySource && Object.keys(data.metrics.bySource).length > 0 && (
              <div style={{ margin: '14px 0 18px' }}>
                <div style={{
                  fontSize: 11, color: '#6b7280', fontWeight: 600,
                  letterSpacing: 0.3, marginBottom: 6,
                }}>
                  PROSPECTS BY SOURCE
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {Object.entries(data.metrics.bySource).map(([src, n]) => {
                    const label = src === 'csv_import' ? 'CSV'
                                : src === 'extension'  ? 'Extension'
                                : src === 'linkedin'   ? 'LinkedIn'
                                : src === 'manual'     ? 'Manual'
                                : src === 'referral'   ? 'Referral'
                                : src === 'event'      ? 'Event'
                                : src === 'inbound'    ? 'Inbound'
                                : src === 'import'     ? 'Import'
                                : src;
                    return (
                      <div key={src} style={{
                        padding: '4px 10px',
                        background: '#f3f4f6',
                        border: '1px solid #e5e7eb',
                        borderRadius: 6, fontSize: 12,
                      }}>
                        <span style={{ color: '#374151', fontWeight: 600 }}>{label}</span>
                        <span style={{ color: '#6b7280', marginLeft: 6 }}>{n}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sequence health — surfaces silent draft generation failures
                and stalled enrollments. Reads from the new
                /prospecting-campaigns/:id/sequence-health endpoint. */}
            <SequenceHealthTile campaignId={campaignId} />

            {/* Enroll-all */}
            <div style={{ margin: '18px 0' }}>
              <button
                className="pv-btn-primary"
                style={{ width: '100%' }}
                disabled={busy || totalProspects === 0}
                onClick={() => setShowEnroll(true)}
              >
                📨 Enroll all in sequence
              </button>
              {!data.campaign.default_sequence_id && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, textAlign: 'center' }}>
                  No default sequence set — you'll pick one.
                </div>
              )}
            </div>

            {/* Members preview */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginTop: 8, marginBottom: 8,
            }}>
              <SectionTitle noMargin>
                Members <span style={{ color: '#9ca3af', fontWeight: 400 }}>{totalProspects}</span>
              </SectionTitle>
              {totalProspects > 0 && (
                <button
                  onClick={viewInPipeline}
                  style={{
                    fontSize: 12, color: EMBER, background: 'none', border: 'none',
                    cursor: 'pointer', fontWeight: 600,
                  }}
                >View all in Pipeline →</button>
              )}
            </div>

            {members.length === 0 ? (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: '12px 0' }}>
                No prospects in this campaign yet. Use “Import prospects” above.
              </div>
            ) : (
              <div style={{ border: '1px solid #f1f5f9', borderRadius: 6 }}>
                {members.map((m, i) => (
                  <MemberRow key={m.id} member={m} isLast={i === members.length - 1} />
                ))}
                {totalProspects > members.length && (
                  <div style={{
                    padding: '8px 12px', fontSize: 12, color: '#9ca3af',
                    borderTop: '1px solid #f1f5f9', textAlign: 'center',
                  }}>
                    + {totalProspects - members.length} more — view all in Pipeline
                  </div>
                )}
              </div>
            )}

            {/* Settings line */}
            <div style={{
              marginTop: 20, paddingTop: 14, borderTop: '1px solid #f1f5f9',
              fontSize: 12, color: '#6b7280', lineHeight: 1.7,
            }}>
              <div>📋 Playbook: {data.campaign.playbook_name || '— none —'}</div>
              <div>📨 Default sequence: {data.campaign.default_sequence_name || '— none —'}</div>
              {(data.campaign.start_date || data.campaign.end_date) && (
                <div>📅 {data.campaign.start_date || '?'} → {data.campaign.end_date || '?'}</div>
              )}
            </div>
          </div>
        )}

        {showImport && (
          <CSVImportModal
            entity="prospects"
            onImport={handleImport}
            onClose={() => setShowImport(false)}
          />
        )}
        {showEnroll && data && (
          <EnrollAllModal
            campaign={data.campaign}
            onClose={() => setShowEnroll(false)}
            onEnrolled={() => { setShowEnroll(false); load(channelFilter); onChanged?.(); }}
          />
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value }) {
  return (
    <div style={{
      background: '#f8fafc', borderRadius: 8, padding: '10px 12px',
    }}>
      <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#1A3A5C' }}>{value}</div>
    </div>
  );
}

function SectionTitle({ children, noMargin }) {
  return (
    <div style={{
      fontSize: 13, fontWeight: 700, color: '#374151',
      marginBottom: noMargin ? 0 : 10,
    }}>{children}</div>
  );
}

// ── Funnel — compact horizontal bars ─────────────────────────────────────────
function Funnel({ funnel, terminal }) {
  const max = Math.max(1, ...funnel.map(f => f.count));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 90 }}>
        {funnel.map(f => {
          const meta = STAGE_META[f.stage] || { label: f.stage, color: '#9ca3af' };
          const h = Math.max(6, Math.round((f.count / max) * 72));
          return (
            <div key={f.stage} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{
                height: h, background: meta.color, borderRadius: '4px 4px 0 0',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                paddingTop: 3, color: '#fff', fontSize: 12, fontWeight: 700,
              }}>{f.count > 0 ? f.count : ''}</div>
              <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>{meta.label}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
        Disqualified {terminal.disqualified} · Nurture {terminal.nurture}
        {'  '}— shown separately, not in the funnel
      </div>
    </div>
  );
}

// ── MemberRow ────────────────────────────────────────────────────────────────
function MemberRow({ member: m, isLast }) {
  const initials = `${(m.first_name || '?')[0] || ''}${(m.last_name || '')[0] || ''}`.toUpperCase();
  const meta = STAGE_META[m.stage];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '9px 12px',
      borderBottom: isLast ? 'none' : '1px solid #f1f5f9',
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', background: '#eef2ff',
        color: '#4338ca', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, marginRight: 10,
      }}>{initials}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>
          {m.first_name} {m.last_name}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[m.title, m.company_name].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>
      {meta && (
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 6,
          background: '#f1f5f9', color: meta.color, fontWeight: 600,
        }}>{meta.label}</span>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ENROLL-ALL MODAL
// ═════════════════════════════════════════════════════════════════════════════

function EnrollAllModal({ campaign, onClose, onEnrolled }) {
  const [sequences, setSequences] = useState([]);
  const [seqId,     setSeqId]     = useState(campaign.default_sequence_id || '');
  const [onlyStage, setOnlyStage] = useState('');     // '' = all stages
  const [loading,   setLoading]   = useState(true);
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState('');
  const [result,    setResult]    = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/sequences');
        setSequences((r.sequences || []).filter(s => s.status === 'active'));
      } catch (err) {
        setError('Failed to load sequences: ' + err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleEnroll = async () => {
    if (!seqId) { setError('Please pick a sequence.'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(`/prospecting-campaigns/${campaign.id}/enroll-all`, {
        method: 'POST',
        body: JSON.stringify({
          sequenceId: parseInt(seqId, 10),
          onlyStage:  onlyStage || undefined,
        }),
      });
      setResult(r);
    } catch (err) {
      setError('Enroll failed: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="pv-modal-header">
          <h3>Enroll campaign in sequence</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="pv-form" style={{ padding: 20 }}>
          {result ? (
            <div>
              <div style={{
                background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46',
                padding: '12px 14px', borderRadius: 8, fontSize: 14,
              }}>
                ✓ Enrolled {result.enrolled} prospect{result.enrolled === 1 ? '' : 's'}
                {result.skipped?.length > 0 && (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    {result.skipped.length} skipped (already enrolled or ineligible).
                  </div>
                )}
              </div>
              <div className="pv-form-actions" style={{ marginTop: 16 }}>
                <button className="pv-btn-primary" onClick={onEnrolled}>Done</button>
              </div>
            </div>
          ) : loading ? (
            <div className="pv-loading">Loading sequences...</div>
          ) : (
            <>
              <div className="pv-form-section">
                <h4>Sequence</h4>
                <select value={seqId} onChange={e => setSeqId(e.target.value)}>
                  <option value="">— Pick a sequence —</option>
                  {sequences.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.id === campaign.default_sequence_id ? '  (campaign default)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="pv-form-section">
                <h4>Who to enroll</h4>
                <select value={onlyStage} onChange={e => setOnlyStage(e.target.value)}>
                  <option value="">All campaign members</option>
                  {DEFAULT_PROSPECT_STAGES.map(s => (
                    <option key={s.key} value={s.key}>Only “{s.label}” stage</option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                  Prospects already in an active enrollment of this sequence are skipped.
                </div>
              </div>

              {error && (
                <div style={{ color: '#991b1b', fontSize: 13, marginBottom: 10 }}>{error}</div>
              )}

              <div className="pv-form-actions">
                <button type="button" className="pv-btn-secondary" onClick={onClose}>Cancel</button>
                <button type="button" className="pv-btn-primary" disabled={busy} onClick={handleEnroll}>
                  {busy ? 'Enrolling...' : 'Enroll'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CAMPAIGN FORM MODAL — create / edit
// ═════════════════════════════════════════════════════════════════════════════

function CampaignFormModal({ campaign, onSaved, onClose }) {
  const isEdit = !!campaign;
  const [form, setForm] = useState({
    name:                campaign?.name || '',
    description:         campaign?.description || '',
    solution:            campaign?.solution || '',
    playbook_id:         campaign?.playbook_id || '',
    default_sequence_id: campaign?.default_sequence_id || '',
    goal_qualified:      campaign?.goal_qualified || '',
    start_date:          campaign?.start_date ? campaign.start_date.slice(0, 10) : '',
    end_date:            campaign?.end_date ? campaign.end_date.slice(0, 10) : '',
    status:              campaign?.status || 'active',
  });
  const [playbooks, setPlaybooks] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const pb = await apiFetch('/playbooks?type=prospecting');
        setPlaybooks(pb.playbooks || []);
      } catch { setPlaybooks([]); }
      try {
        const sq = await apiFetch('/sequences');
        setSequences((sq.sequences || []).filter(s => s.status === 'active'));
      } catch { setSequences([]); }
    })();
  }, []);

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleSubmit = async () => {
    if (!form.name.trim()) { setError('Campaign name is required.'); return; }
    setBusy(true);
    setError('');
    const payload = {
      name:                form.name.trim(),
      description:         form.description || null,
      solution:            form.solution || null,
      playbook_id:         form.playbook_id ? parseInt(form.playbook_id, 10) : null,
      default_sequence_id: form.default_sequence_id ? parseInt(form.default_sequence_id, 10) : null,
      goal_qualified:      form.goal_qualified ? parseInt(form.goal_qualified, 10) : null,
      start_date:          form.start_date || null,
      end_date:            form.end_date || null,
      status:              form.status,
    };
    try {
      if (isEdit) {
        await apiFetch(`/prospecting-campaigns/${campaign.id}`, {
          method: 'PUT', body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/prospecting-campaigns', {
          method: 'POST', body: JSON.stringify(payload),
        });
      }
      onSaved();
    } catch (err) {
      setError((isEdit ? 'Update' : 'Create') + ' failed: ' + err.message);
      setBusy(false);
    }
  };

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()}>
        <div className="pv-modal-header">
          <h3>{isEdit ? 'Edit Campaign' : 'New Campaign'}</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="pv-form">
          <div className="pv-form-section">
            <h4>Campaign</h4>
            <input
              placeholder="Campaign name *"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
            <input
              placeholder="Solution (e.g. SAP S/4HANA migration)"
              value={form.solution}
              onChange={e => set('solution', e.target.value)}
            />
            <textarea
              placeholder="Description (optional)"
              value={form.description}
              onChange={e => set('description', e.target.value)}
              rows={2}
            />
          </div>

          <div className="pv-form-section">
            <h4>Playbook &amp; sequence</h4>
            <select value={form.playbook_id} onChange={e => set('playbook_id', e.target.value)}>
              <option value="">No prospecting playbook</option>
              {playbooks.map(pb => (
                <option key={pb.id} value={pb.id}>
                  {pb.is_default ? '★ ' : ''}{pb.name}
                </option>
              ))}
            </select>
            <select value={form.default_sequence_id} onChange={e => set('default_sequence_id', e.target.value)}>
              <option value="">No default sequence</option>
              {sequences.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="pv-form-section">
            <h4>Goal &amp; schedule</h4>
            <input
              type="number" min="0"
              placeholder="Goal — qualified (SAL) count"
              value={form.goal_qualified}
              onChange={e => set('goal_qualified', e.target.value)}
            />
            <div className="pv-form-row">
              <input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
              <input type="date" value={form.end_date}   onChange={e => set('end_date', e.target.value)} />
            </div>
          </div>

          {isEdit && (
            <div className="pv-form-section">
              <h4>Status</h4>
              <select value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          )}

          {error && (
            <div style={{ color: '#991b1b', fontSize: 13, margin: '0 0 10px' }}>{error}</div>
          )}

          <div className="pv-form-actions">
            <button type="button" className="pv-btn-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="pv-btn-primary" disabled={busy} onClick={handleSubmit}>
              {busy ? 'Saving...' : isEdit ? 'Save changes' : 'Create campaign'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
