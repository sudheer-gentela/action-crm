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
import CampaignConfigPanel from './CampaignConfigPanel';
import CampaignBriefWizard from './CampaignBriefWizard';
import PacingTile from './PacingTile';
import BatchActivateModal from './BatchActivateModal';
import EntityIdHint from '../EntityIdHint';
import SendingScheduleSettings from '../SendingScheduleSettings';
// Slice 4: preview drafts + sender visibility
import PreviewDraftsModal from './PreviewDraftsModal';
import SenderSummaryTile from './SenderSummaryTile';

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
  const [scope,       setScope]       = useState('mine');     // mine|team|org
  const [caps,        setCaps]        = useState({ isAdmin: false, hasSubordinates: false, userId: null });
  const [showCreate,  setShowCreate]  = useState(false);
  const [showWizard,  setShowWizard]  = useState(false);
  const [editing,     setEditing]     = useState(null);   // campaign being edited (or null)
  // Campaign id open in the detail drawer. Owns the THIRD hash segment
  // (#/prospecting/campaigns/14) — restored on mount so a browser refresh
  // reopens the same drawer. App.js owns segment 1, ProspectingView owns
  // segment 2; this component never rewrites those. Access is enforced
  // server-side on the drawer's fetch, so a deep link to a campaign the
  // user can't see just renders the drawer's error state.
  const [detailId,    setDetailId]    = useState(() => {
    const parts = (window.location.hash || '').replace(/^#\/?/, '').split('/');
    if (parts[0]?.toLowerCase() === 'prospecting' && parts[1]?.toLowerCase() === 'campaigns') {
      const id = parseInt(parts[2], 10);
      if (Number.isInteger(id) && id > 0) return id;
    }
    return null;
  });

  // Write the id segment whenever the drawer opens/closes/switches. Only
  // while the first two segments are ours — during a sub-view or tab
  // switch the parents rewrite the hash and this effect must not fight
  // them from a component that's about to unmount.
  useEffect(() => {
    const parts = (window.location.hash || '').replace(/^#\/?/, '').split('/');
    if (parts[0]?.toLowerCase() !== 'prospecting' || parts[1]?.toLowerCase() !== 'campaigns') return;
    const current = parseInt(parts[2], 10);
    const currentId = Number.isInteger(current) && current > 0 ? current : null;
    if (currentId === detailId) return;
    window.history.replaceState(
      null, '',
      detailId ? `#/prospecting/campaigns/${detailId}` : '#/prospecting/campaigns'
    );
  }, [detailId]);

  // Capability flags — server-authoritative (do NOT infer role client-side).
  // Drives which scope tabs are offered: Team when the user has reports, Org
  // when they're an admin/owner. Until this resolves, only "Mine" is shown.
  useEffect(() => {
    apiFetch('/prospecting-campaigns/me/context')
      .then(c => setCaps({
        isAdmin:         !!c?.isAdmin,
        hasSubordinates: !!c?.hasSubordinates,
        userId:          c?.userId ?? null,
      }))
      .catch(() => {});  // non-fatal — list still works in "Mine" scope
  }, []);

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const params = [`scope=${scope}`];
      if (statusFilter !== 'all') params.push(`status=${statusFilter}`);
      const r = await apiFetch(`/prospecting-campaigns?${params.join('&')}`);
      setCampaigns(r.campaigns || []);
      setError('');
    } catch (err) {
      setError('Failed to load campaigns: ' + (err.message || 'unknown error'));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, scope]);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  // Scope tabs offered to this user. "Mine" is always present; "Team" and
  // "Org" appear only when the server says the user has that capability.
  const scopeTabs = [{ key: 'mine', label: 'Mine' }];
  if (caps.hasSubordinates) scopeTabs.push({ key: 'team', label: 'Team' });
  if (caps.isAdmin)         scopeTabs.push({ key: 'org',  label: 'Org' });

  const handleSaved = () => {
    setShowCreate(false);
    setEditing(null);
    fetchCampaigns();
  };

  return (
    <div className="pv-campaigns">
      {/* Scope switcher — only shown when the user has more than one scope
          available (i.e. they're a manager and/or an admin). Lets a manager
          open a team member's campaign (Team) or an admin any campaign (Org)
          to use the per-campaign delete lock in the detail drawer. */}
      {scopeTabs.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            View
          </span>
          <div style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden' }}>
            {scopeTabs.map((s, i) => (
              <button
                key={s.key}
                onClick={() => setScope(s.key)}
                style={{
                  fontSize: 12, padding: '4px 14px', cursor: 'pointer', fontWeight: 600,
                  border: 'none',
                  borderLeft: i === 0 ? 'none' : '1px solid #e5e7eb',
                  background: scope === s.key ? EMBER : '#fff',
                  color: scope === s.key ? '#fff' : '#6b7280',
                }}
              >{s.label}</button>
            ))}
          </div>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {scope === 'mine' ? 'Your campaigns'
              : scope === 'team' ? "Your team's campaigns"
              : 'All campaigns in the org'}
          </span>
        </div>
      )}

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
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="pv-btn-primary"
            onClick={() => setShowWizard(true)}
            title="Guided campaign brief: audience, ICP, pitch, case studies, fallback sequence"
          >
            ✨ Guided Brief
          </button>
          <button className="pv-btn-primary" onClick={() => setShowCreate(true)}>
            + New Campaign
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
          padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 12,
        }}>{error}</div>
      )}

      {/* ── Campaign aggregates strip ─────────────────────────────────────────
          Replaces the global prospect-pool/LinkedIn strips (hidden by
          ProspectingView in campaigns mode). Summed CLIENT-SIDE from the
          rows currently listed, so it always agrees with what's on screen
          and follows the scope (Mine/Team/Org) and status filter for free.
          LinkedIn counts come from the list query's li_*_count aggregates. */}
      {!loading && campaigns.length > 0 && (() => {
        const agg = campaigns.reduce((a, c) => ({
          prospects:  a.prospects  + parseInt(c.prospect_count    || 0, 10),
          qualified:  a.qualified  + parseInt(c.qualified_count   || 0, 10),
          active:     a.active     + parseInt(c.active_count      || 0, 10),
          goal:       a.goal       + (parseInt(c.goal_qualified, 10) || 0),
          liSent:     a.liSent     + parseInt(c.li_sent_count     || 0, 10),
          liAccepted: a.liAccepted + parseInt(c.li_accepted_count || 0, 10),
        }), { prospects: 0, qualified: 0, active: 0, goal: 0, liSent: 0, liAccepted: 0 });
        const liRate = agg.liSent > 0 ? Math.round((agg.liAccepted / agg.liSent) * 100) : null;
        const Metric = ({ value, label, color }) => (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 76 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: color || '#1f2937' }}>{value}</span>
            <span style={{ fontSize: 10.5, color: '#9ca3af', whiteSpace: 'nowrap' }}>{label}</span>
          </div>
        );
        return (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
            background: '#f8fafc', border: '1px solid #e2e8f0',
            borderRadius: 8, padding: '8px 14px', marginBottom: 12,
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginRight: 10, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {statusFilter === 'all' ? 'All' : statusFilter} campaigns — totals
            </span>
            <Metric value={campaigns.length} label="campaigns" />
            <Metric value={agg.prospects}    label="prospects" />
            <Metric value={agg.active}       label="in motion" />
            <Metric value={agg.goal > 0 ? `${agg.qualified}/${agg.goal}` : agg.qualified}
                    label={agg.goal > 0 ? 'qualified / goal' : 'qualified'} color="#059669" />
            <div style={{ width: 1, height: 24, background: '#e2e8f0', margin: '0 8px' }} />
            <Metric value={agg.liSent > 0 ? `${agg.liAccepted}/${agg.liSent}` : '—'}
                    label="in accepted / sent" color={agg.liSent > 0 ? '#1d4ed8' : '#cbd5e1'} />
            {liRate != null && <Metric value={`${liRate}%`} label="acceptance" color="#1d4ed8" />}
          </div>
        );
      })()}

      {loading ? (
        <div className="pv-loading">Loading campaigns...</div>
      ) : campaigns.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '48px 20px', color: '#9ca3af', fontSize: 14,
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚀</div>
          {scope === 'mine'
            ? <>No {statusFilter !== 'all' ? statusFilter : ''} campaigns yet.</>
            : scope === 'team'
              ? <>No {statusFilter !== 'all' ? statusFilter : ''} campaigns in your team.</>
              : <>No {statusFilter !== 'all' ? statusFilter : ''} campaigns in your org.</>}
          {scope === 'mine' && (
            <div style={{ marginTop: 8 }}>
              <button className="pv-btn-secondary" onClick={() => setShowCreate(true)}>
                Create your first campaign
              </button>
            </div>
          )}
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
              currentUserId={caps.userId}
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

      {showWizard && (
        <CampaignBriefWizard
          onSaved={() => { setShowWizard(false); handleSaved(); }}
          onClose={() => setShowWizard(false)}
        />
      )}

      {detailId && (
        <CampaignDetailDrawer
          campaignId={detailId}
          scope={scope}
          currentUserId={caps.userId}
          onClose={() => setDetailId(null)}
          onChanged={fetchCampaigns}
          onEdit={(c) => { setDetailId(null); setEditing(c); }}
        />
      )}
    </div>
  );
}

// ── CampaignRow ──────────────────────────────────────────────────────────────
function CampaignRow({ campaign: c, isLast, onClick, currentUserId }) {
  const prospectCount = parseInt(c.prospect_count || 0, 10);
  const qualified     = parseInt(c.qualified_count || 0, 10);
  const goal          = c.goal_qualified || null;
  const pct = goal ? Math.min(100, Math.round((qualified / goal) * 100)) : 0;

  // LinkedIn connection funnel (all-time, from the list query's
  // li_sent_count / li_accepted_count FILTER aggregates). Rendered as one
  // compact "accepted / sent" stat; campaigns with no LinkedIn sends show a
  // muted dash rather than a misleading 0%.
  const liSent     = parseInt(c.li_sent_count     || 0, 10);
  const liAccepted = parseInt(c.li_accepted_count || 0, 10);
  const liRate     = liSent > 0 ? Math.round((liAccepted / liSent) * 100) : null;

  // Show the owner only when it isn't the current user (e.g. a manager viewing
  // a team member's campaign in Team/Org scope). Hidden until currentUserId
  // resolves so we never mislabel your own campaigns during load.
  const ownerName = [c.owner_first_name, c.owner_last_name].filter(Boolean).join(' ');
  const showOwner = currentUserId != null && c.owner_id !== currentUserId && ownerName;

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
          {showOwner && <span style={{ marginLeft: 10 }}>👤 {ownerName}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 20, textAlign: 'right', alignItems: 'center' }}>
        <Stat value={prospectCount} label="prospects" />
        <Stat value={qualified} label="qualified" color="#059669" />
        {/* LinkedIn connections — highlighted tile when there's data, muted
            dash otherwise. minWidth keeps the goal column aligned across
            rows whether or not a campaign has LinkedIn activity. */}
        <div style={{
          minWidth: 96,
          background: liSent > 0 ? '#eff6ff' : 'transparent',
          borderRadius: 8, padding: '5px 10px',
        }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: liSent > 0 ? '#1d4ed8' : '#cbd5e1' }}>
            {liSent > 0 ? `${liAccepted}/${liSent}` : '—'}
            {liRate != null && (
              <span style={{ fontSize: 12, fontWeight: 600, color: '#3b82f6', marginLeft: 5 }}>
                {liRate}%
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: liSent > 0 ? '#3b82f6' : '#9ca3af' }}>
            {liSent > 0 ? 'in accepted / sent' : 'in no sends'}
          </div>
        </div>
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

function CampaignDetailDrawer({ campaignId, onClose, onChanged, onEdit, scope, currentUserId }) {
  const [data,     setData]     = useState(null);   // { campaign, funnel, terminal, metrics }
  const [members,  setMembers]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [busy,     setBusy]     = useState(false);
  // Cascade-delete (campaign + prospects): two-step — dry-run preview, then
  // an explicit confirm that commits. deletePreview holds the dry-run counts.
  const [deletePreview, setDeletePreview] = useState(null);
  const [deleteBusy,    setDeleteBusy]    = useState(false);
  const [deleteErr,     setDeleteErr]     = useState('');
  const [deleteTypedName, setDeleteTypedName] = useState('');  // must match name to confirm
  // Per-campaign delete lock (set/cleared by admins/owners, or a manager for a
  // team campaign). Visibility driven by server flag data.campaign.can_set_lock.
  const [lockBusy, setLockBusy] = useState(false);
  const [lockErr,  setLockErr]  = useState('');
  const [showImport,   setShowImport]   = useState(false);
  const [showEnroll,   setShowEnroll]   = useState(false);
  // Slice 2: batch-activation modal + pacing-driven CTA.
  const [showBatchActivate, setShowBatchActivate] = useState(false);
  const [readyToActivate,   setReadyToActivate]   = useState(0);
  const [targetCount,       setTargetCount]       = useState(0);
  const [bulkPromoting,     setBulkPromoting]     = useState(false);

  // Slice 4: preview drafts modal + picker for which prospects to preview.
  const [showPreviewPicker, setShowPreviewPicker] = useState(false);
  const [previewProspectIds, setPreviewProspectIds] = useState([]);

  // Channel filter for the outreach metric cards. `null` = show all channels
  // side-by-side. A specific value collapses the cards to that channel only.
  // The filter is sent to the API so the server doesn't return data for
  // channels we won't display.
  const [channelFilter, setChannelFilter] = useState(null);
  // Time range for the BY CHANNEL cards: 'week' (Sunday-start, default) or
  // 'all' (lifetime). Sent to the API so the counts AND the drill-down lists
  // are computed over the same window.
  const [rangeFilter, setRangeFilter] = useState('week');
  // Drill-down modal state. null = closed. Otherwise one of:
  //   { type: 'events', channel, kind }  — byChannel number clicked
  //   { type: 'li', bucket }             — LinkedIn connections tile clicked
  const [drill, setDrill] = useState(null);
  // Read-only sequence-steps modal ("what does this campaign actually send?")
  const [showSequenceSteps, setShowSequenceSteps] = useState(false);
  // Default sequence's ai_enabled — loaded alongside campaign data below.
  const [seqAiEnabled, setSeqAiEnabled] = useState(true);

  const load = useCallback(async (chFilter) => {
    setLoading(true);
    try {
      const qp = new URLSearchParams();
      if (chFilter) qp.set('channel', chFilter);
      if (rangeFilter === 'all') qp.set('range', 'all');
      const qs = qp.toString() ? `?${qp.toString()}` : '';
      const r = await apiFetch(`/prospecting-campaigns/${campaignId}${qs}`);
      setData(r);
      // Whether the campaign's default sequence uses AI — drives visibility of
      // the AI skill config and the activate-time personalization toggle.
      // Defaults to true (and on any fetch failure) to preserve prior behavior.
      if (r?.campaign?.default_sequence_id) {
        try {
          const seq = await apiFetch(`/sequences/${r.campaign.default_sequence_id}`);
          setSeqAiEnabled(seq?.sequence?.ai_enabled !== false);
        } catch (_) { setSeqAiEnabled(true); }
      } else {
        setSeqAiEnabled(true);
      }
      // Member preview — up to 10. Scoped by campaign on the server, which
      // authorizes by campaign access (owner / manager / admin).
      const pr = await apiFetch(`/prospects?campaignId=${campaignId}`);
      setMembers((pr.prospects || []).slice(0, 10));
      // Slice 2: fetch pacing to drive the "Activate next N" button.
      try {
        const pc = await apiFetch(`/prospecting-campaigns/${campaignId}/pacing`);
        setReadyToActivate(pc?.pacing?.readyToActivate || 0);
        // Backend returns the per-stage breakdown under `stages`, not
        // `stageCounts` — earlier draft of this code had the wrong key
        // which silently zeroed out the bulk-promote button.
        setTargetCount(pc?.stages?.target || 0);
      } catch (_) { setReadyToActivate(0); setTargetCount(0); }
      setError('');
    } catch (err) {
      setError('Failed to load campaign: ' + (err.message || 'unknown error'));
    } finally {
      setLoading(false);
    }
  }, [campaignId, rangeFilter]);

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

  const handleImport = async (rows, opts = {}) => {
    // Reuse the bulk endpoint, scoped to this campaign. opts.moveExistingIds
    // carries any existing prospects the user chose (in the conflicts step) to
    // move into this campaign rather than skip.
    const res = await apiFetch('/prospects/bulk', {
      method: 'POST',
      body: JSON.stringify({
        prospects: rows,
        source: 'csv_import',
        campaignId,
        ...(opts.moveExistingIds?.length ? { moveExistingIds: opts.moveExistingIds } : {}),
      }),
    });
    await load(channelFilter);
    onChanged?.();
    return res;
  };

  const viewInPipeline = () => {
    if (!data) return;
    window.dispatchEvent(new CustomEvent('campaign-filter', {
      detail: { campaignId, campaignName: data.campaign.name, scope },
    }));
    onClose();
  };

  const totalProspects = data?.metrics?.totalProspects || 0;

  // ── Cascade delete: campaign + its prospects ────────────────────────────
  // Step 1 (startDelete): dry-run — fetch the counts, change nothing. The
  // admin-only gate fires here too, so a non-admin sees the message now.
  // Step 2 (confirmDelete): commit — stops enrollments, soft-deletes the
  // prospects (recoverable), hard-deletes the campaign, atomically.
  const startDelete = async () => {
    setDeleteErr('');
    setDeleteTypedName('');
    setDeleteBusy(true);
    try {
      const r = await apiFetch(
        `/prospecting-campaigns/${campaignId}?withProspects=true&hard=true&dryRun=true`,
        { method: 'DELETE' }
      );
      setDeletePreview(r.wouldDelete || {});
    } catch (err) {
      // The server returns a specific, user-facing reason (owner-delete off,
      // campaign locked, not the owner, …). Surface it as-is. The Delete
      // button is normally gated on can_delete so users rarely land here.
      setDeleteErr('Could not prepare delete: ' + (err.message || 'unknown error'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmDelete = async () => {
    setDeleteErr('');
    setDeleteBusy(true);
    try {
      await apiFetch(
        `/prospecting-campaigns/${campaignId}?withProspects=true&hard=true`,
        { method: 'DELETE' }
      );
      onChanged?.();
      onClose();
    } catch (err) {
      // Keep the panel open so the error is visible.
      setDeleteErr('Delete failed: ' + (err.message || 'unknown error'));
      setDeleteBusy(false);
    }
  };

  const cancelDelete = () => { setDeletePreview(null); setDeleteErr(''); setDeleteTypedName(''); };

  // ── Per-campaign delete lock ─────────────────────────────────────────────
  // Sets or clears delete_locked. Server enforces who may do this
  // (canSetCampaignLock); the control is only rendered when can_set_lock.
  const toggleLock = async () => {
    if (!data) return;
    const next = !(data.campaign?.delete_locked === true);
    setLockErr('');
    setLockBusy(true);
    try {
      await apiFetch(`/prospecting-campaigns/${campaignId}/delete-lock`, {
        method: 'PUT', body: JSON.stringify({ locked: next }),
      });
      // Cancel any in-flight delete preview — the gate may have just changed.
      setDeletePreview(null);
      setDeleteTypedName('');
      await load(channelFilter);
      onChanged?.();
    } catch (err) {
      setLockErr('Could not update lock: ' + (err.message || 'unknown error'));
    } finally {
      setLockBusy(false);
    }
  };

  const deleteNameMatch = !!data &&
    deleteTypedName.trim() === (data.campaign?.name || '').trim();

  return (
    <div className="pv-detail-overlay" onClick={onClose}>
      <div className="pv-detail-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="pv-detail-header">
          <div>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>← Campaigns</span>
            <h3 style={{ marginTop: 2 }}>
              {data?.campaign?.name || 'Campaign'}
              <EntityIdHint id={data?.campaign?.id} type="campaign" />
            </h3>
            {data && (
              <span className="pv-detail-title">
                <StatusPill status={data.campaign.status} />
                {data.campaign.solution && (
                  <span style={{ marginLeft: 8 }}>{data.campaign.solution}</span>
                )}
                {currentUserId != null && data.campaign.owner_id !== currentUserId &&
                  [data.campaign.owner_first_name, data.campaign.owner_last_name].filter(Boolean).length > 0 && (
                  <span style={{ marginLeft: 8, color: '#6b7280' }}>
                    · 👤 Owned by {[data.campaign.owner_first_name, data.campaign.owner_last_name].filter(Boolean).join(' ')}
                  </span>
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
            <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="pv-btn-secondary" disabled={busy}
                onClick={() => onEdit?.(data.campaign)}>✎ Edit</button>
              <button className="pv-btn-secondary" disabled={busy} onClick={togglePause}>
                {data.campaign.status === 'active' ? '⏸ Pause' : '▶ Resume'}
              </button>
              <button className="pv-btn-secondary" onClick={() => setShowImport(true)}>
                ⬆ Import prospects
              </button>

              {/* Lock / unlock deletion — only when the server says this user
                  may set the lock (admins/owners always; a manager for a team
                  campaign). The owner of the campaign does NOT see this. */}
              {data.campaign.can_set_lock && (
                <button className="pv-btn-secondary" disabled={busy || lockBusy}
                  style={{ marginLeft: 'auto' }}
                  title={data.campaign.delete_locked
                    ? 'Allow this campaign to be deleted'
                    : 'Prevent this campaign from being deleted'}
                  onClick={toggleLock}>
                  {lockBusy
                    ? 'Saving…'
                    : (data.campaign.delete_locked ? '🔓 Unlock deletion' : '🔒 Lock deletion')}
                </button>
              )}

              {/* Delete — gated on can_delete. When blocked, the button is
                  disabled and the server-provided reason is shown as a tooltip
                  (and inline below). If can_set_lock pushed nothing to the
                  right, this button keeps the auto margin so it right-aligns. */}
              <button className="pv-btn-secondary"
                disabled={busy || deleteBusy || !data.campaign.can_delete}
                style={{
                  color: data.campaign.can_delete ? '#b91c1c' : '#d1a3a3',
                  borderColor: data.campaign.can_delete ? '#fca5a5' : '#f0d4d4',
                  cursor: data.campaign.can_delete ? 'pointer' : 'not-allowed',
                  marginLeft: data.campaign.can_set_lock ? 0 : 'auto',
                }}
                title={data.campaign.can_delete
                  ? undefined
                  : (data.campaign.delete_blocked_reason || 'You cannot delete this campaign.')}
                onClick={startDelete}>
                🗑 Delete campaign
              </button>
            </div>

            {/* Lock error (if a lock/unlock attempt failed) */}
            {lockErr && (
              <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 14 }}>{lockErr}</div>
            )}

            {/* Why delete is blocked — shown inline so it's discoverable even
                on touch devices where the tooltip isn't available. */}
            {!data.campaign.can_delete && data.campaign.delete_blocked_reason && (
              <div style={{
                fontSize: 12, color: '#92400e', background: '#fffbeb',
                border: '1px solid #fde68a', borderRadius: 6,
                padding: '8px 10px', marginBottom: 14,
              }}>
                {data.campaign.delete_blocked_reason}
              </div>
            )}

            {/* Cascade-delete: pre-preview error (e.g. admin-required) */}
            {deleteErr && !deletePreview && (
              <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 14 }}>{deleteErr}</div>
            )}

            {/* Cascade-delete: confirm panel (shown after dry-run preview) */}
            {deletePreview && (
              <div style={{
                border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 8,
                padding: '12px 14px', marginBottom: 18,
              }}>
                <div style={{ fontWeight: 700, color: '#991b1b', fontSize: 13, marginBottom: 6 }}>
                  Delete this campaign and its prospects?
                </div>
                <div style={{ fontSize: 12, color: '#7f1d1d', marginBottom: 10, lineHeight: 1.5 }}>
                  This will stop <strong>{deletePreview.activeEnrollments ?? 0}</strong> active/paused
                  enrollment(s), delete <strong>{deletePreview.prospects ?? 0}</strong> prospect(s)
                  {' '}(recoverable), and permanently delete the campaign. The campaign itself cannot be recovered.
                </div>
                {deleteErr && (
                  <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 8 }}>{deleteErr}</div>
                )}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#7f1d1d', display: 'block', marginBottom: 4 }}>
                    Type the campaign name to confirm: <span style={{ fontWeight: 700 }}>{data.campaign.name}</span>
                  </label>
                  <input
                    type="text"
                    value={deleteTypedName}
                    onChange={e => setDeleteTypedName(e.target.value)}
                    placeholder={data.campaign.name}
                    autoFocus
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '7px 10px',
                      border: `1px solid ${deleteNameMatch ? '#16a34a' : '#fca5a5'}`,
                      borderRadius: 6, fontSize: 13,
                    }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="pv-btn-secondary" disabled={deleteBusy} onClick={cancelDelete}>
                    Cancel
                  </button>
                  <button
                    className="pv-btn-primary"
                    disabled={deleteBusy || !deleteNameMatch}
                    title={deleteNameMatch ? undefined : 'Type the exact campaign name to enable'}
                    style={{
                      background: deleteNameMatch ? '#b91c1c' : '#e5a3a3',
                      borderColor: deleteNameMatch ? '#b91c1c' : '#e5a3a3',
                      cursor: (deleteBusy || !deleteNameMatch) ? 'not-allowed' : 'pointer',
                    }}
                    onClick={confirmDelete}>
                    {deleteBusy ? 'Deleting…' : 'Permanently delete'}
                  </button>
                </div>
              </div>
            )}

            {/* Metric cards — top row: prospects + total touches + in-sequences */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12,
            }}>
              <MetricCard label="Prospects"      value={data.metrics.totalProspects} />
              <MetricCard label={rangeFilter === 'all' ? 'Outreach (all)' : 'Outreach / wk'}  value={data.metrics.outreachThisWeek} />
              <MetricCard label={rangeFilter === 'all' ? 'Responses (all)' : 'Responses / wk'} value={data.metrics.responsesThisWeek} />
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
                BY CHANNEL — {rangeFilter === 'all' ? 'ALL TIME' : 'THIS WEEK'}
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {/* Range pills — drive both the card counts and the
                    drill-down lists, so a clicked number always matches
                    the list it opens. */}
                {[
                  { key: 'week', label: 'This week' },
                  { key: 'all',  label: 'All time' },
                ].map(opt => {
                  const active = rangeFilter === opt.key;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => setRangeFilter(opt.key)}
                      style={{
                        padding: '3px 10px', fontSize: 11, fontWeight: 600,
                        background: active ? '#0F9D8E' : '#fff',
                        color:      active ? '#fff'    : '#374151',
                        border: `1px solid ${active ? '#0F9D8E' : '#d1d5db'}`,
                        borderRadius: 12, cursor: 'pointer',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
                <div style={{ width: 1, height: 16, background: '#e5e7eb', margin: '0 4px' }} />
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
                    // Clicking a card opens the drill-down list of the touches behind it.
                    <React.Fragment key={ch}>
                      <div style={{ cursor: 'pointer' }} title="Click to see who"
                           onClick={() => setDrill({ type: 'events', channel: ch, kind: 'outreach' })}>
                        <MetricCard label={`${chLabel} — outreach`}  value={stats.outreach} />
                      </div>
                      <div style={{ cursor: 'pointer' }} title="Click to see who"
                           onClick={() => setDrill({ type: 'events', channel: ch, kind: 'response' })}>
                        <MetricCard label={`${chLabel} — responses`} value={stats.responses} />
                      </div>
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
                        <div style={{ cursor: 'pointer' }} title="Click to see who"
                             onClick={() => setDrill({ type: 'events', channel: ch, kind: 'outreach' })}>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>{stats.outreach}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af' }}>outreach</div>
                        </div>
                        <div style={{ cursor: 'pointer' }} title="Click to see who"
                             onClick={() => setDrill({ type: 'events', channel: ch, kind: 'response' })}>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>{stats.responses}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af' }}>responses</div>
                        </div>
                      </div>
                    </div>
                  );
              })}
            </div>

            {/* LinkedIn connections — ALL-TIME state-based funnel for the
                connect step (requests sent → accepted), distinct from the
                event-based weekly cards above. Fed by channel_data.linkedin,
                which the extension's "Check & update" sync keeps accurate.
                Hidden entirely until the campaign has at least one tracked
                request, so email-only campaigns don't carry a dead section. */}
            {data.metrics.linkedinConnections?.requestsSent > 0 && (() => {
              const li = data.metrics.linkedinConnections;
              return (
                <div style={{ marginBottom: 20 }}>
                  <div style={{
                    fontSize: 11, color: '#6b7280', fontWeight: 600,
                    letterSpacing: 0.3, marginBottom: 8,
                  }}>
                    LINKEDIN CONNECTIONS — ALL TIME
                  </div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: 8, marginBottom: 10,
                  }}>
                    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 12px', cursor: 'pointer' }}
                         title="Click to see who"
                         onClick={() => setDrill({ type: 'li', bucket: 'sent' })}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#1A3A5C' }}>{li.requestsSent}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>requests sent</div>
                    </div>
                    <div style={{ background: '#ecfdf5', borderRadius: 8, padding: '10px 12px', cursor: 'pointer' }}
                         title="Click to see who"
                         onClick={() => setDrill({ type: 'li', bucket: 'accepted' })}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#047857' }}>{li.accepted}</div>
                      <div style={{ fontSize: 11, color: '#059669' }}>accepted</div>
                    </div>
                    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 12px', cursor: 'pointer' }}
                         title="Click to see who"
                         onClick={() => setDrill({ type: 'li', bucket: 'pending' })}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#1A3A5C' }}>{li.pending}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>pending</div>
                    </div>
                    <div style={{ background: '#eff6ff', borderRadius: 8, padding: '10px 12px' }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#1d4ed8' }}>
                        {li.acceptanceRate != null ? `${li.acceptanceRate}%` : '—'}
                      </div>
                      <div style={{ fontSize: 11, color: '#3b82f6' }}>acceptance</div>
                    </div>
                  </div>
                  <div style={{ height: 7, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden', marginBottom: 4 }}>
                    <div style={{
                      width: `${Math.min(100, Math.round((li.accepted / li.requestsSent) * 100))}%`,
                      height: '100%', background: '#059669',
                    }} />
                  </div>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: 11, color: '#9ca3af',
                  }}>
                    <span>{li.accepted} of {li.requestsSent} accepted</span>
                    <span>via extension sync</span>
                  </div>
                </div>
              );
            })()}

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
            {/* Read-only peek at what the default sequence actually sends —
                steps, channels, delays, templates — without leaving the
                campaign. Opens SequenceStepsModal (GET /sequences/:id). */}
            {data.campaign.default_sequence_id && (
              <button
                onClick={() => setShowSequenceSteps(true)}
                style={{
                  marginTop: 6, marginBottom: 14, padding: 0,
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600, color: '#0F9D8E',
                }}
              >
                View sequence steps →
              </button>
            )}

            {/* Slice 2: pacing tile — funnel + activation rate */}
            <PacingTile campaignId={campaignId} />

            {/* Slice 4: sender visibility — which email + LinkedIn account
                will fire this campaign's outreach. */}
            <SenderSummaryTile campaignId={campaignId} />

            {/* Bulk-promote: skip the per-prospect research step. For when
                the campaign is template-driven and per-prospect research
                isn't needed before outreach. Only shown when there are
                target-stage prospects sitting unprocessed. Confirms
                before firing — moving 396 prospects is hard to undo. */}
            {targetCount > 0 && (
              <div style={{ margin: '12px 0' }}>
                <button
                  className="pv-btn-secondary"
                  style={{ width: '100%' }}
                  disabled={busy || bulkPromoting}
                  onClick={async () => {
                    const ok = window.confirm(
                      `Move all ${targetCount} 'target' prospects in this campaign to 'research'?\n\n` +
                      `Skips per-prospect research. They'll be eligible for batch-activation immediately afterwards.\n\n` +
                      `This is not easily reversible.`
                    );
                    if (!ok) return;
                    setBulkPromoting(true);
                    try {
                      const r = await apiFetch('/prospects/bulk-stage', {
                        method: 'POST',
                        body: JSON.stringify({
                          fromStage:  'target',
                          toStage:    'research',
                          campaignId: parseInt(campaignId, 10),
                        }),
                      });
                      // Reload pacing so both counts refresh.
                      await load(channelFilter);
                      window.alert(`Moved ${r.moved} prospects from target → research.`);
                    } catch (err) {
                      window.alert('Failed to move prospects: ' + (err.message || 'unknown error'));
                    } finally {
                      setBulkPromoting(false);
                    }
                  }}
                >
                  {bulkPromoting
                    ? '⏳ Moving…'
                    : `⏩ Skip research: move all ${targetCount} target → research`}
                </button>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, textAlign: 'center' }}>
                  Use this when your campaign relies on templated outreach (no per-prospect research needed).
                </div>
              </div>
            )}

            {/* Slice 2 + 4: batch-activate button (primary) + preview button
                (secondary). The preview button lets the rep see all sequence
                steps for 1-5 prospects WITHOUT enrolling anyone — useful
                before committing to a real activation. */}
            {readyToActivate > 0 ? (
              <div style={{ margin: '18px 0' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="pv-btn-primary"
                    style={{ flex: 1 }}
                    disabled={busy || !data.campaign.default_sequence_id}
                    onClick={() => setShowBatchActivate(true)}
                  >
                    ⚡ Activate next batch ({readyToActivate} research-ready)
                  </button>
                  <button
                    className="pv-btn-secondary"
                    style={{ flex: '0 0 auto' }}
                    title="Preview personalised drafts for up to 5 prospects without enrolling them"
                    disabled={busy || !data.campaign.default_sequence_id}
                    onClick={() => setShowPreviewPicker(true)}
                  >
                    👁️ Preview drafts
                  </button>
                </div>
                {!data.campaign.default_sequence_id && (
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, textAlign: 'center' }}>
                    Set a default sequence on this campaign before activating.
                  </div>
                )}
              </div>
            ) : (
              <div style={{ margin: '18px 0' }}>
                {/* No research-approved prospects yet. Preview becomes the
                    primary action (it's safe, instructive, no commitment).
                    Legacy enroll-all is demoted to a small text link below
                    with a hover explainer so reps know what it's for. */}
                <button
                  className="pv-btn-primary"
                  style={{ width: '100%' }}
                  disabled={busy || !data.campaign.default_sequence_id || totalProspects === 0}
                  onClick={() => setShowPreviewPicker(true)}
                >
                  👁️ Preview drafts for some prospects
                </button>
                <div style={{
                  fontSize: 11, color: '#6b7280', marginTop: 4, textAlign: 'center',
                }}>
                  Approve research on prospects to unlock personalised batch activation.
                </div>
                {!data.campaign.default_sequence_id && (
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, textAlign: 'center' }}>
                    No default sequence set on this campaign.
                  </div>
                )}
                <div style={{
                  marginTop: 12, padding: '8px 10px', background: '#f8fafc', borderRadius: 6,
                  fontSize: 11, color: '#6b7280',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 3 }}>
                    Advanced: skip research, enrol everyone with templates only
                  </div>
                  <div style={{ marginBottom: 6 }}>
                    Bypasses per-prospect AI personalisation. Each enrollment uses the sequence template verbatim. Useful if you don't have or want signal-based research.
                  </div>
                  <button
                    onClick={() => setShowEnroll(true)}
                    disabled={busy || totalProspects === 0}
                    style={{
                      background: 'none', border: '1px solid #cbd5e1', borderRadius: 4,
                      padding: '4px 10px', fontSize: 11, color: '#475569',
                      cursor: 'pointer', fontWeight: 500,
                    }}
                  >
                    📨 Enroll all in sequence (template-only)
                  </button>
                </div>
              </div>
            )}

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

            {/* Slice 1 + Slice-5-fix: campaign-level prospecting_config override.
                Editable by org owner/admin OR by the campaign's owner / creator.
                The panel's GET /:id/config response also includes a server-side
                `can_edit` boolean that the panel prefers — this prop is the
                initial-render hint, with the server truth winning on load.

                Hidden entirely when the default sequence has AI off — this panel
                only configures the AI skill (hooks, products, guardrails), which
                a non-AI sequence never invokes. */}
            {seqAiEnabled && (
            <CampaignConfigPanel
              campaignId={campaignId}
              canEdit={(() => {
                try {
                  const u = JSON.parse(localStorage.getItem('user') || '{}');
                  if (u.role === 'owner' || u.role === 'admin') return true;
                  // Campaign-ownership check: data.campaign.owner_id (or
                  // created_by if owner_id is null) === current user id.
                  const camp = data?.campaign;
                  if (camp) {
                    const campOwner = camp.owner_id ?? camp.created_by;
                    if (campOwner && campOwner === u.id) return true;
                  }
                  return false;
                } catch (_) { return false; }
              })()}
            />
            )}
          </div>
        )}

        {showImport && (
          <CSVImportModal
            entity="prospects"
            onImport={handleImport}
            campaignId={campaignId}
            campaignName={data?.campaign?.name}
            onPreflight={async (rows, cid) => apiFetch('/prospects/bulk-preflight', {
              method: 'POST',
              body: JSON.stringify({ prospects: rows, campaignId: cid }),
            })}
            onClose={() => setShowImport(false)}
          />
        )}
        {drill && (
          <CampaignDrilldownModal
            campaignId={campaignId}
            drill={drill}
            range={rangeFilter}
            onClose={() => setDrill(null)}
          />
        )}
        {showSequenceSteps && data?.campaign?.default_sequence_id && (
          <SequenceStepsModal
            sequenceId={data.campaign.default_sequence_id}
            sequenceName={data.campaign.default_sequence_name}
            onClose={() => setShowSequenceSteps(false)}
          />
        )}
        {showEnroll && data && (
          <EnrollAllModal
            campaign={data.campaign}
            onClose={() => setShowEnroll(false)}
            onEnrolled={() => { setShowEnroll(false); load(channelFilter); onChanged?.(); }}
          />
        )}
        {showBatchActivate && data && (
          <BatchActivateModal
            campaign={data.campaign}
            readyCount={readyToActivate}
            aiEnabled={seqAiEnabled}
            onClose={() => setShowBatchActivate(false)}
            onActivated={() => { setShowBatchActivate(false); load(channelFilter); onChanged?.(); }}
          />
        )}
        {/* Slice 4: Preview-picker modal — pick 1-5 prospects, then opens
            PreviewDraftsModal with the selected IDs. */}
        {showPreviewPicker && data && (
          <PreviewPickerModal
            campaignId={campaignId}
            sequenceId={data.campaign.default_sequence_id}
            sequenceName={data.campaign.default_sequence_name}
            members={members}
            onClose={() => setShowPreviewPicker(false)}
            onPick={(ids) => {
              setPreviewProspectIds(ids);
              setShowPreviewPicker(false);
            }}
          />
        )}
        {previewProspectIds.length > 0 && data && data.campaign.default_sequence_id && (
          <PreviewDraftsModal
            sequenceId={data.campaign.default_sequence_id}
            prospectIds={previewProspectIds}
            runSkill={seqAiEnabled}
            onClose={() => setPreviewProspectIds([])}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PreviewPickerModal — Slice 4 helper. Lets the rep pick 1-5 prospects from
// the campaign before launching the actual preview. Reuses the campaign
// members list already loaded into the drawer.
// ─────────────────────────────────────────────────────────────────────────────
// ── SequenceStepsModal ───────────────────────────────────────────────────────
//
// Read-only view of the campaign's default sequence: every step with its
// channel, delay, intent, and templates — so a rep can see exactly what the
// campaign sends without navigating to the Sequences view. Templates render
// as-stored (with {{placeholders}}); per-prospect personalization happens at
// send time via the outreach skill, so this is the skeleton, not the final
// copy. Uses GET /sequences/:id (steps included in the payload).
function SequenceStepsModal({ sequenceId, sequenceName, onClose }) {
  const [seq,   setSeq]   = useState(null);   // null = loading
  const [error, setError] = useState('');
  const [openStep, setOpenStep] = useState(null);   // step id with template expanded

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/sequences/${sequenceId}`)
      .then(r => { if (!cancelled) setSeq(r.sequence || null); })
      .catch(err => { if (!cancelled) { setError(err.message || 'Failed to load sequence'); setSeq({ steps: [] }); } });
    return () => { cancelled = true; };
  }, [sequenceId]);

  const CHANNEL_META = {
    email:    { icon: '✉️', label: 'Email' },
    linkedin: { icon: '🔗', label: 'LinkedIn' },
    call:     { icon: '📞', label: 'Call' },
    task:     { icon: '📝', label: 'Task' },
  };

  const steps = seq?.steps || [];

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 'min(560px, 95vw)' }}>
        <div className="pv-modal-header">
          <h3>Sequence — {seq?.name || sequenceName || '…'}</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ maxHeight: '65vh', overflowY: 'auto', padding: '8px 0 12px' }}>
          {seq == null && (
            <div style={{ padding: 20, fontSize: 13, color: '#6b7280' }}>Loading…</div>
          )}
          {error && (
            <div style={{
              margin: 16, padding: 12, background: '#fef2f2', border: '1px solid #fecaca',
              color: '#991b1b', fontSize: 13, borderRadius: 6,
            }}>{error}</div>
          )}

          {steps.map((s, i) => {
            const meta = CHANNEL_META[s.channel] || { icon: '•', label: s.channel };
            const hasTemplate = !!(s.subject_template || s.body_template || s.task_note);
            const expanded = openStep === s.id;
            const delayLabel = i === 0
              ? (s.delay_days > 0 ? `day ${s.delay_days}` : 'on enrollment')
              : `+${s.delay_days} day${s.delay_days === 1 ? '' : 's'}`;
            return (
              <div key={s.id} style={{ padding: '10px 16px', borderBottom: '1px solid #f8fafc' }}>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: hasTemplate ? 'pointer' : 'default' }}
                  onClick={() => hasTemplate && setOpenStep(expanded ? null : s.id)}
                >
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                    background: '#f1f5f9', color: '#475569',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700,
                  }}>
                    {s.step_order}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>
                      {meta.icon} {meta.label}
                      {s.step_intent && (
                        <span style={{
                          marginLeft: 8, fontSize: 10, fontWeight: 600, color: '#6b7280',
                          background: '#f1f5f9', borderRadius: 8, padding: '1px 7px',
                        }}>
                          {String(s.step_intent).replace(/_/g, ' ')}
                        </span>
                      )}
                      {s.require_approval && (
                        <span style={{
                          marginLeft: 6, fontSize: 10, fontWeight: 600, color: '#92400e',
                          background: '#fffbeb', borderRadius: 8, padding: '1px 7px',
                        }}>
                          needs approval
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>
                      {delayLabel}
                      {s.subject_template ? ` · ${s.subject_template}` : ''}
                    </div>
                  </div>
                  {hasTemplate && (
                    <div style={{ fontSize: 11, color: '#0F9D8E', flexShrink: 0 }}>
                      {expanded ? 'hide' : 'view'} template
                    </div>
                  )}
                </div>
                {expanded && (
                  <div style={{
                    marginTop: 8, marginLeft: 32, padding: 10,
                    background: '#f8fafc', borderRadius: 6,
                    fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap',
                    maxHeight: 220, overflowY: 'auto',
                  }}>
                    {s.subject_template && <div style={{ fontWeight: 600, marginBottom: 6 }}>Subject: {s.subject_template}</div>}
                    {s.body_template || s.task_note || '(no template — generated per prospect at send time)'}
                  </div>
                )}
              </div>
            );
          })}

          {seq != null && !error && steps.length === 0 && (
            <div style={{ padding: 20, fontSize: 13, color: '#9ca3af' }}>This sequence has no steps yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── CampaignDrilldownModal ───────────────────────────────────────────────────
//
// "Who's behind this number?" — opened by clicking any BY CHANNEL count or a
// LINKEDIN CONNECTIONS tile in the campaign drawer. Two modes:
//
//   drill = { type: 'events', channel, kind }
//     → GET /:id/outreach-events?channel=&kind=&range=
//       One row per TOUCH (a prospect can appear multiple times — that's
//       correct, the count being explained is touches, not people).
//
//   drill = { type: 'li', bucket: 'sent' | 'accepted' | 'pending' }
//     → GET /:id/linkedin-connection-prospects?bucket=
//       One row per PROSPECT, with request/accept dates.
//
// Both endpoints use predicates identical to the counts they explain, so the
// list total always reconciles with the number that was clicked.
function CampaignDrilldownModal({ campaignId, drill, range, onClose }) {
  const [rows,    setRows]    = useState(null);   // null = loading
  const [total,   setTotal]   = useState(0);
  const [error,   setError]   = useState('');

  const isEvents = drill.type === 'events';

  // Sort for the LinkedIn-prospects mode (client-side — the payload carries
  // both dates, so no refetch needed). Defaults follow the bucket: the
  // accepted list opens sorted by acceptance recency, sent/pending by
  // request recency.
  const [sortKey, setSortKey] = useState(
    drill.type === 'li' && drill.bucket === 'accepted' ? 'accepted' : 'sent'
  );

  const sortedRows = React.useMemo(() => {
    if (!rows) return rows;
    if (isEvents) return rows;   // events arrive ts DESC from the server
    const ts = (v) => {
      const t = v ? new Date(v).getTime() : NaN;
      return Number.isNaN(t) ? -Infinity : t;   // undated rows sink to the bottom
    };
    const sorted = [...rows];
    if (sortKey === 'name') {
      sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortKey === 'accepted') {
      sorted.sort((a, b) => ts(b.connected_at) - ts(a.connected_at));
    } else {
      sorted.sort((a, b) => ts(b.request_sent_at) - ts(a.request_sent_at));
    }
    return sorted;
  }, [rows, sortKey, isEvents]);

  const chLabel  = drill.channel === 'email' ? 'Email'
                 : drill.channel === 'linkedin' ? 'LinkedIn'
                 : drill.channel === 'call' ? 'Call' : '';
  const title = isEvents
    ? `${chLabel} ${drill.kind === 'outreach' ? 'outreach' : 'responses'} — ${range === 'all' ? 'all time' : 'this week'}`
    : drill.bucket === 'sent'     ? 'LinkedIn — requests sent'
    : drill.bucket === 'accepted' ? 'LinkedIn — accepted'
    :                               'LinkedIn — pending';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isEvents) {
          const qs = `channel=${drill.channel}&kind=${drill.kind}${range === 'all' ? '&range=all' : ''}`;
          const r = await apiFetch(`/prospecting-campaigns/${campaignId}/outreach-events?${qs}`);
          if (cancelled) return;
          setRows(r.events || []);
          setTotal(r.total || 0);
        } else {
          const r = await apiFetch(`/prospecting-campaigns/${campaignId}/linkedin-connection-prospects?bucket=${drill.bucket}`);
          if (cancelled) return;
          setRows(r.prospects || []);
          setTotal(r.total || 0);
        }
      } catch (err) {
        if (!cancelled) { setError(err.message || 'Failed to load'); setRows([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId, drill, range, isEvents]);

  const fmtDate = (v) => {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 'min(520px, 95vw)' }}>
        <div className="pv-modal-header">
          <h3>{title}{rows != null && ` (${total})`}</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: '4px 0 8px' }}>
          {!isEvents && rows != null && rows.length > 1 && (
            <div style={{
              display: 'flex', gap: 4, alignItems: 'center',
              padding: '6px 16px 8px', borderBottom: '1px solid #f8fafc',
            }}>
              <span style={{ fontSize: 11, color: '#9ca3af', marginRight: 2 }}>Sort by</span>
              {[
                { key: 'sent',     label: 'Sent date' },
                { key: 'accepted', label: 'Accepted date' },
                { key: 'name',     label: 'Name' },
              ].map(opt => {
                const active = sortKey === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => setSortKey(opt.key)}
                    style={{
                      padding: '2px 9px', fontSize: 11, fontWeight: 600,
                      background: active ? '#111827' : '#fff',
                      color:      active ? '#fff'    : '#374151',
                      border: `1px solid ${active ? '#111827' : '#d1d5db'}`,
                      borderRadius: 11, cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
          {rows == null && (
            <div style={{ padding: 20, fontSize: 13, color: '#6b7280' }}>Loading…</div>
          )}
          {error && (
            <div style={{
              margin: 16, padding: 12, background: '#fef2f2', border: '1px solid #fecaca',
              color: '#991b1b', fontSize: 13, borderRadius: 6,
            }}>{error}</div>
          )}
          {rows != null && !error && rows.length === 0 && (
            <div style={{ padding: 20, fontSize: 13, color: '#9ca3af' }}>
              Nothing in this bucket{isEvents && range !== 'all' ? ' this week — try "All time"' : ''}.
            </div>
          )}

          {(sortedRows || []).map((r, i) => (
            <div key={isEvents ? i : r.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 16px',
              borderBottom: '1px solid #f8fafc',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {isEvents ? (r.prospect_name || '(unknown)') : (r.name || '(unknown)')}
                  {!isEvents && r.linkedin_url && (
                    <a
                      href={r.linkedin_url} target="_blank" rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      style={{ marginLeft: 6, fontSize: 11, color: '#2563eb', textDecoration: 'none' }}
                    >
                      in ↗
                    </a>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {isEvents
                    ? [r.company_name, r.detail].filter(Boolean).join(' · ')
                    : [r.title, r.company_name].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', flexShrink: 0 }}>
                {isEvents ? (
                  fmtDate(r.ts)
                ) : (
                  <>
                    {r.request_sent_at && <div>sent {fmtDate(r.request_sent_at)}</div>}
                    {r.connected_at    && <div style={{ color: '#047857' }}>accepted {fmtDate(r.connected_at)}</div>}
                  </>
                )}
              </div>
            </div>
          ))}

          {rows != null && total > rows.length && (
            <div style={{ padding: '10px 16px', fontSize: 11, color: '#9ca3af' }}>
              Showing first {rows.length} of {total}.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewPickerModal({ campaignId, sequenceId, sequenceName, members, onClose, onPick }) {
  const [selected, setSelected] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [allMembers, setAllMembers] = useState(members || []);
  const [loadingMore, setLoadingMore] = useState(false);

  // The drawer only loads the first 10 members for preview. For the picker,
  // fetch a larger batch so the rep can search across the campaign.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingMore(true);
      try {
        const r = await apiFetch(`/prospects?campaignId=${campaignId}&limit=200`);
        if (!cancelled) setAllMembers(r.prospects || []);
      } catch (_) {
        // Keep the 10 we already have
      } finally {
        if (!cancelled) setLoadingMore(false);
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId]);

  const filtered = allMembers.filter(m => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    // API returns snake_case from /api/prospects/. Read first_name, last_name,
    // company_name, email — the camelCase variants don't exist on this payload.
    return (
      (m.first_name || '').toLowerCase().includes(q) ||
      (m.last_name || '').toLowerCase().includes(q) ||
      (m.company_name || '').toLowerCase().includes(q) ||
      (m.email || '').toLowerCase().includes(q)
    );
  });

  const toggle = (id) => {
    if (selected.includes(id)) {
      setSelected(selected.filter(x => x !== id));
    } else if (selected.length < 5) {
      setSelected([...selected, id]);
    }
  };

  if (!sequenceId) {
    return (
      <div className="pv-modal-overlay" onClick={onClose}>
        <div className="pv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 'min(480px, 95vw)' }}>
          <div className="pv-modal-header">
            <h3>Preview drafts</h3>
            <button className="pv-modal-close" onClick={onClose}>×</button>
          </div>
          <div className="pv-form" style={{ padding: 20 }}>
            <div style={{
              padding: 14, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
              fontSize: 13, borderRadius: 6,
            }}>
              This campaign has no default sequence. Set one before previewing.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()}
           style={{ maxWidth: 'min(580px, 95vw)', display: 'flex', flexDirection: 'column', maxHeight: '85vh' }}>
        <div className="pv-modal-header">
          <h3>Preview drafts — pick prospects</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: 16, borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
            Pick up to 5 prospects to preview personalisation for sequence "{sequenceName || 'default'}".
            Nothing is enrolled or sent.
          </div>
          {/* Slice-6: surface data-readiness so users understand WHY their
              preview drafts might be generic. Skill quality depends on
              LinkedIn profile capture + research notes; this row legend
              tells them what each badge means. */}
          <div style={{
            fontSize: 11, color: '#475569', background: '#f8fafc', borderRadius: 6,
            padding: '8px 10px', marginBottom: 10, lineHeight: 1.5,
          }}>
            <strong>Data-readiness:</strong> <span style={{ color: '#166534' }}>✅ Ready</span> = LinkedIn captured + research notes.{' '}
            <span style={{ color: '#1e40af' }}>🔗 LinkedIn only</span> = headline/about captured, no research hook.{' '}
            <span style={{ color: '#92400e' }}>📝 Notes only</span> = no LinkedIn data yet.{' '}
            <span style={{ color: '#991b1b' }}>⚠</span> = personalisation will be sparse. Use "Open ↗" to visit a prospect's LinkedIn page; the Chrome extension auto-captures it.
          </div>
          <input
            type="text"
            placeholder="Search by name, company, or email…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: '100%', fontSize: 13, padding: '7px 10px',
              border: '1px solid #d1d5db', borderRadius: 6,
            }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loadingMore && allMembers.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
              Loading prospects…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
              No prospects match.
            </div>
          ) : (
            filtered.slice(0, 100).map(m => {
              const isSelected = selected.includes(m.id);
              const isDisabled = !isSelected && selected.length >= 5;
              // Slice-6: data-readiness indicators. The backend now returns
              // linkedin_profile_captured + has_research_notes per prospect.
              // Both contribute to personalisation quality:
              //   - LinkedIn captured → skill has headline/about/experience/activity
              //   - Research notes  → skill has a stated hook to lead with
              // We surface combined readiness as a colored pill, and offer a
              // "Capture LinkedIn" shortcut for prospects whose linkedin_url is
              // known but whose profile data hasn't been pulled by the extension.
              const liCaptured = m.linkedin_profile_captured === true;
              const hasResearch = m.has_research_notes === true;
              const hasLinkedinUrl = !!m.linkedin_url;
              const readiness =
                liCaptured && hasResearch  ? { label: '✅ Ready',           bg: '#dcfce7', fg: '#166534' } :
                liCaptured                 ? { label: '🔗 LinkedIn only',    bg: '#dbeafe', fg: '#1e40af' } :
                hasResearch                ? { label: '📝 Notes only',       bg: '#fef3c7', fg: '#92400e' } :
                hasLinkedinUrl             ? { label: '⚠ Capture first',     bg: '#fef2f2', fg: '#991b1b' } :
                                             { label: '⚠ No LinkedIn URL',   bg: '#fef2f2', fg: '#991b1b' };
              return (
                <div
                  key={m.id}
                  onClick={() => !isDisabled && toggle(m.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 16px',
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                    background: isSelected ? '#ecfdf5' : 'transparent',
                    opacity: isDisabled ? 0.4 : 1,
                    borderLeft: '3px solid ' + (isSelected ? '#10b981' : 'transparent'),
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isDisabled}
                    onChange={() => {}}
                    style={{ cursor: 'inherit' }}
                  />
                  <div style={{ flex: 1, fontSize: 13, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: '#1A3A5C' }}>
                      {m.first_name} {m.last_name}
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.title || '—'} · {m.company_name || '—'}
                    </div>
                  </div>
                  {/* Readiness pill */}
                  <span title={
                    liCaptured && hasResearch ? 'LinkedIn profile captured AND research notes written. Best personalisation quality.' :
                    liCaptured ? 'LinkedIn profile captured. Skill has the prospect\'s headline, about, experience. Quality improves with approved research notes.' :
                    hasResearch ? 'Research notes written but LinkedIn profile not captured yet. Skill is missing the prospect\'s LinkedIn data.' :
                    hasLinkedinUrl ? 'LinkedIn URL known but profile not captured. Visit their LinkedIn page with the Chrome extension to capture data.' :
                    'No LinkedIn URL on file. Personalisation will be very limited.'
                  } style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 10, fontWeight: 600,
                    background: readiness.bg, color: readiness.fg,
                    whiteSpace: 'nowrap', flexShrink: 0,
                  }}>
                    {readiness.label}
                  </span>
                  {/* "Capture LinkedIn" shortcut — opens the prospect's
                      LinkedIn page in a new tab so the user can visit it
                      with the Chrome extension installed, which auto-captures
                      headline/about/experience into linkedin_profiles. */}
                  {hasLinkedinUrl && !liCaptured && (
                    <a
                      href={m.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="Open in new tab and capture with the Chrome extension"
                      style={{
                        fontSize: 10, padding: '2px 7px', borderRadius: 10,
                        background: '#fff', border: '1px solid #cbd5e1',
                        color: '#0F9D8E', textDecoration: 'none', fontWeight: 600,
                        whiteSpace: 'nowrap', flexShrink: 0,
                      }}
                    >
                      Open ↗
                    </a>
                  )}
                  <span style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 10,
                    background: '#f3f4f6', color: '#6b7280',
                    whiteSpace: 'nowrap', flexShrink: 0,
                  }}>
                    {m.stage}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="pv-form-actions" style={{ padding: 14, borderTop: '1px solid #f0f0f0' }}>
          <div style={{ flex: 1, fontSize: 12, color: '#6b7280' }}>
            {selected.length} of 5 selected
          </div>
          <button className="pv-btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="pv-btn-primary"
            disabled={selected.length === 0}
            onClick={() => onPick(selected)}
          >
            Preview {selected.length} draft{selected.length === 1 ? '' : 's'}
          </button>
        </div>
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
      <div className="pv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 'min(460px, 95vw)' }}>
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
  // Schedule override state. Each field is null when the campaign inherits
  // the org default, or a value when it overrides. The campaign object from
  // the backend has snake_case column names; map them in here.
  const [schedule, setSchedule] = useState({
    startMode:             campaign?.start_mode               ?? null,
    pacingMode:            campaign?.pacing_mode              ?? null,
    cadenceMinutes:        campaign?.cadence_minutes          ?? null,
    sendWindowStartHour:   campaign?.send_window_start_hour   ?? null,
    sendWindowStartMinute: campaign?.send_window_start_minute ?? null,
    sendWindowEndHour:     campaign?.send_window_end_hour     ?? null,
    sendWindowDays:        campaign?.send_window_days         ?? null,
    sendWindowTimezone:    campaign?.send_window_timezone     ?? null,
    // daily_activation_cap is repurposed as the LinkedIn release cap.
    linkedinReleaseCap:    campaign?.daily_activation_cap     ?? null,
  });
  const [orgDefaults, setOrgDefaults] = useState(null);
  // Derived per-channel email capacity for the saved campaign (edit only) —
  // powers the read-only "N senders → X/day" line. Reflects the CURRENTLY
  // saved default sequence; refreshes after save.
  const [capacity, setCapacity] = useState(null);
  // Weighted-split context: org budget mode + the per-channel pool overview
  // (running totals across the user's active campaigns) for the share UI.
  const [budgetMode, setBudgetMode] = useState('shared');
  const [budgetAllocation, setBudgetAllocation] = useState(null);
  const [shareWeight, setShareWeight] = useState(
    campaign?.share_weight != null ? campaign.share_weight : ''
  );
  // Per-campaign sender selection (Phase 2). senders = the user's connected
  // sender accounts; selectedSenderIds = null/[] means "all senders" (default).
  const [senders, setSenders] = useState([]);
  const [selectedSenderIds, setSelectedSenderIds] = useState(
    Array.isArray(campaign?.sender_account_ids) && campaign.sender_account_ids.length
      ? campaign.sender_account_ids
      : null
  );
  // Section expanded by default if any overrides exist on the campaign.
  const hasAnyOverride = Object.values(schedule).some(v => v != null);
  const [scheduleOpen, setScheduleOpen] = useState(hasAnyOverride);
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
      // Sender accounts for the per-campaign sender picker (Phase 2).
      try {
        const sd = await apiFetch('/prospecting-senders');
        setSenders((sd.senders || []).filter(s => s.isActive));
      } catch { setSenders([]); }
      // Org defaults for the schedule section. Best-effort — if the user
      // isn't admin, the endpoint 403s and we just show "—" for defaults.
      try {
        const ol = await apiFetch('/org/outreach-limits');
        if (ol?.limits) {
          setOrgDefaults({
            startMode:             ol.limits.startMode      ?? 'fixed_or_now',
            pacingMode:            ol.limits.pacingMode      ?? 'cadence',
            cadenceMinutes:        ol.limits.cadenceMinutes  ?? 5,
            sendWindowStartHour:   ol.limits.sendWindowStartHour   ?? 8,
            sendWindowStartMinute: ol.limits.sendWindowStartMinute ?? 0,
            sendWindowEndHour:     ol.limits.sendWindowEndHour      ?? 18,
            sendWindowDays:        Array.isArray(ol.limits.sendWindowDays) ? ol.limits.sendWindowDays : [1,2,3,4,5],
            sendWindowTimezone:    ol.limits.sendWindowTimezone     ?? 'America/New_York',
            linkedinReleaseCap:    ol.limits.linkedinReleaseCap     ?? 25,
          });
          setBudgetMode(ol.limits.budgetMode ?? 'shared');
        }
      } catch { /* non-fatal */ }
      // Capacity hint (edit only) — the campaign-detail response carries the
      // computed per-channel capacity for the current user + saved sequence.
      if (campaign?.id) {
        try {
          const det = await apiFetch(`/prospecting-campaigns/${campaign.id}`);
          if (det?.schedule?.capacity) setCapacity(det.schedule.capacity);
        } catch { /* non-fatal */ }
      }
      // Budget allocation overview — running totals per channel pool, for the
      // weighted-split share UI.
      try {
        const ba = await apiFetch('/prospecting-campaigns/budget-allocation');
        if (ba) setBudgetAllocation(ba);
      } catch { /* non-fatal */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // Schedule overrides — backend treats null as "inherit from org".
      // We always send all fields so PUT can clear overrides cleanly.
      // linkedinReleaseCap persists into the repurposed daily_activation_cap.
      daily_activation_cap:     schedule.linkedinReleaseCap,
      send_window_start_hour:   schedule.sendWindowStartHour,
      send_window_start_minute: schedule.sendWindowStartMinute,
      send_window_end_hour:     schedule.sendWindowEndHour,
      send_window_days:         schedule.sendWindowDays,
      send_window_timezone:     schedule.sendWindowTimezone,
      start_mode:               schedule.startMode,
      pacing_mode:              schedule.pacingMode,
      cadence_minutes:          schedule.cadenceMinutes,
      // Weighted-split share (normalised within the leading channel pool).
      // Empty string → null = unset (excluded in weighted mode).
      share_weight:             shareWeight === '' ? null : parseInt(shareWeight, 10),
      // Per-campaign sender selection (Phase 2). Empty array → backend stores
      // NULL = "all senders". Always sent so a cleared selection persists.
      sender_account_ids:       Array.isArray(selectedSenderIds) ? selectedSenderIds : [],
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

          {/* Sending schedule overrides — collapsed by default unless the
              campaign already has any override set. Toggle expands a form
              where each field can independently override the org default. */}
          <div className="pv-form-section">
            <h4
              style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 8 }}
              onClick={() => setScheduleOpen(!scheduleOpen)}
            >
              <span style={{ fontSize: 13, color: '#6b7280', width: 12, display: 'inline-block' }}>
                {scheduleOpen ? '▾' : '▸'}
              </span>
              Sending Schedule
              {hasAnyOverride && (
                <span style={{
                  fontSize: 11, background: '#0F9D8E', color: '#fff',
                  padding: '2px 8px', borderRadius: 10, fontWeight: 600,
                }}>customised</span>
              )}
            </h4>
            {scheduleOpen ? (
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16, lineHeight: 1.5 }}>
                  Each field below can override the org default for this campaign only.
                  Leave the override unchecked to inherit.
                </p>
                <SendingScheduleSettings
                  mode="campaign"
                  value={schedule}
                  orgDefaults={orgDefaults}
                  onChange={setSchedule}
                  capacity={capacity}
                />

                {/* Per-campaign sender selection (Phase 2). Default = all senders.
                    Picking a subset restricts which mailboxes this campaign sends
                    from, and the capacity above reflects only the chosen senders'
                    limits. */}
                {senders.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                      Send from &amp; sender identity
                    </div>
                    <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, lineHeight: 1.5 }}>
                      Which connected mailbox this campaign sends from — and whose <strong>identity (name + signature)</strong> appears on every message.
                      With <strong>All senders</strong> (default), each rep sends from and signs as their own mailbox.
                      Picking a specific sender <strong>overrides the identity for this whole campaign</strong>: every draft and send uses that account's
                      name and signature, regardless of who runs it. Daily capacity above reflects the selected senders.
                    </p>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedSenderIds === null}
                        onChange={() => setSelectedSenderIds(null)}
                      />
                      <span><strong>All senders</strong> (default) — each rep uses their own identity · {senders.length} mailbox{senders.length === 1 ? '' : 'es'}</span>
                    </label>
                    {senders.map(s => {
                      const checked = Array.isArray(selectedSenderIds) && selectedSenderIds.includes(s.id);
                      return (
                        <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 4, marginLeft: 16, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedSenderIds(prev => {
                                const cur = Array.isArray(prev) ? prev : [];
                                const next = checked ? cur.filter(id => id !== s.id) : [...cur, s.id];
                                return next.length ? next : null; // none selected → back to "all"
                              });
                            }}
                          />
                          <span>
                            {s.email}{s.label ? ` — ${s.label}` : ''}
                            <span style={{ color: '#9ca3af' }}> · {s.dailyLimit != null ? `${s.dailyLimit}/day` : 'default limit'}</span>
                          </span>
                        </label>
                      );
                    })}
                    {Array.isArray(selectedSenderIds) && selectedSenderIds.length >= 1 && (
                      <div style={{ fontSize: 12, color: '#1A3A5C', marginTop: 8, marginLeft: 16, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '6px 10px' }}>
                        <strong>Identity override on:</strong> every message in this campaign will be sent and signed as
                        {selectedSenderIds.length === 1 ? ' this mailbox' : ' one of these mailboxes'}, even when another rep runs it.
                      </div>
                    )}
                    {Array.isArray(selectedSenderIds) && selectedSenderIds.length === 1 && (
                      <div style={{ fontSize: 12, color: '#b45309', marginTop: 6, marginLeft: 16 }}>
                        Sending from a single mailbox concentrates volume — watch that sender's daily limit and warmup.
                      </div>
                    )}
                  </div>
                )}

                {/* Weighted-split share % — only shown when org budget mode is
                    'weighted'. The campaign's slice of its leading channel's
                    daily budget. Unset = excluded (won't release). */}
                {budgetMode === 'weighted' && (() => {
                  // Which channel pool does this campaign belong to? Determined
                  // by its leading step channel. We infer from budgetAllocation
                  // (the campaign appears in exactly one channel pool once saved);
                  // before save we can't know, so we show a generic note.
                  let poolKey = null, pool = null;
                  if (budgetAllocation?.pools && campaign?.id) {
                    for (const k of Object.keys(budgetAllocation.pools)) {
                      const m = budgetAllocation.pools[k].members.find(x => x.id === campaign.id);
                      if (m) { poolKey = k; pool = budgetAllocation.pools[k]; break; }
                    }
                  }
                  const w = shareWeight === '' ? null : parseInt(shareWeight, 10);
                  // Live running total: other campaigns' weights in this pool + this one.
                  let otherWeight = 0, otherCount = 0;
                  if (pool) {
                    for (const m of pool.members) {
                      if (campaign?.id && m.id === campaign.id) continue;
                      if (m.weight != null && m.weight > 0) { otherWeight += m.weight; otherCount++; }
                    }
                  }
                  const liveTotal = otherWeight + (w && w > 0 ? w : 0);
                  const effPct = (w && w > 0 && liveTotal > 0) ? Math.round((w / liveTotal) * 100) : 0;
                  const channelTotal = pool?.channelTotalPerDay;
                  const allocatedPerDay = (channelTotal != null && effPct)
                    ? Math.floor(channelTotal * (w / liveTotal)) : null;

                  return (
                    <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                        Campaign share %{poolKey ? ` (${poolKey} pool)` : ''}
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                        Your org uses a weighted split. This campaign gets this % of its
                        channel's daily budget, divided against the other campaigns in the
                        same channel. Leave blank and the campaign won't release until you
                        set a value. Percentages don't have to add to exactly 100 — they're
                        normalised.
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="number" min="0" max="100" value={shareWeight}
                          placeholder="—"
                          onChange={(e) => setShareWeight(e.target.value)}
                          style={{ width: 90, padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13 }}
                        />
                        <span style={{ fontSize: 12, color: '#6b7280' }}>% share</span>
                      </div>
                      {(w && w > 0) ? (
                        <div style={{ fontSize: 12, color: '#0f766e', marginTop: 8 }}>
                          Effective: <strong>{effPct}%</strong>
                          {allocatedPerDay != null && <> → ~{allocatedPerDay}/day</>}
                          {pool && <span style={{ color: '#9ca3af' }}>
                            {' '}(sharing {poolKey} with {otherCount} other{otherCount === 1 ? '' : 's'})
                          </span>}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: '#b45309', marginTop: 8 }}>
                          ⚠ No share set — this campaign won't release in weighted mode.
                        </div>
                      )}
                      {pool && pool.unsetCount > 0 && (w && w > 0) && (
                        <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                          {pool.unsetCount} other campaign{pool.unsetCount === 1 ? '' : 's'} in the {poolKey} pool {pool.unsetCount === 1 ? 'has' : 'have'} no share and won't run.
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            ) : (
              <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0 20px' }}>
                {hasAnyOverride
                  ? 'This campaign has customised schedule settings. Click to view/edit.'
                  : 'Uses org defaults. Click to override for this campaign.'}
              </p>
            )}
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
