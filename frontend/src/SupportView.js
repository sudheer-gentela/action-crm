// SupportView.js — Service / Customer Support Module
//
// Root view — handles navigation state and the dashboard + case list.
// Heavy lifting is delegated to:
//   CaseDetailPanel  — full case detail, notes, plays, metadata
//   CaseCreateModal  — new case form
//   SupportShared    — shared constants + primitive components
//
// All API calls use apiService.support.*

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import CaseDetailPanel from './CaseDetailPanel';
import CaseCreateModal from './CaseCreateModal';
import {
  STATUS_CONFIG,
  StatusBadge,
  PriorityBadge,
  SLATimer,
  Spinner,
  EmptyState,
} from './SupportShared';

// ── Dashboard ─────────────────────────────────────────────────────────────────

function DashboardView({ scope, onViewCase }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    setLoading(true);
    apiService.support.getDashboard(scope)
      .then(r => { setData(r.data); setError(''); })
      .catch(e => setError(e.response?.data?.error?.message || e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) return <Spinner />;
  if (error)   return <div style={{ padding: 24, color: '#ef4444' }}>⚠️ {error}</div>;
  if (!data)   return null;

  const { stats, byAccount, byOwner, breachList } = data;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>

      {/* Stats bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
        {[
          { label: 'Total Open',          value: stats.totalOpen,          color: '#6366f1' },
          { label: 'Response Breaches',   value: stats.responseBreaches,   color: '#ef4444' },
          { label: 'Resolution Breaches', value: stats.resolutionBreaches, color: '#f59e0b' },
          { label: 'Resolved Today',      value: stats.resolvedToday,      color: '#10b981' },
        ].map(s => (
          <div key={s.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: s.value > 0 ? s.color : '#d1d5db', marginTop: 4 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Cases by status */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 14 }}>Cases by Status</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { key: 'open',             count: stats.countOpen },
            { key: 'in_progress',      count: stats.countInProgress },
            { key: 'pending_customer', count: stats.countPending },
            { key: 'resolved',         count: stats.countResolved },
          ].map(s => {
            const cfg = STATUS_CONFIG[s.key];
            return (
              <div key={s.key} style={{ flex: 1, minWidth: 100, padding: '10px 14px', borderRadius: 8, background: cfg.bg }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: cfg.color }}>{cfg.label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: cfg.color, marginTop: 2 }}>{s.count}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>

        {/* Open by account */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 12 }}>Open Cases by Account</div>
          {byAccount.length === 0
            ? <div style={{ fontSize: 13, color: '#9ca3af' }}>No open cases.</div>
            : byAccount.map(a => (
              <div key={a.accountId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#6366f1', flexShrink: 0 }}>
                  {(a.accountName || '?')[0].toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.accountName}
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#6366f1' }}>{a.openCount}</span>
                {a.breachCount > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', background: '#fee2e2', padding: '1px 6px', borderRadius: 10 }}>⚡{a.breachCount}</span>
                )}
              </div>
            ))
          }
        </div>

        {/* By owner */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 12 }}>Cases by Owner</div>
          {byOwner.length === 0
            ? <div style={{ fontSize: 13, color: '#9ca3af' }}>No assigned cases.</div>
            : byOwner.map(o => (
              <div key={o.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#10b981', flexShrink: 0 }}>
                  {(o.firstName || '?')[0].toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{o.firstName} {o.lastName}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{o.resolvedThisWeek} resolved this week</div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#6366f1' }}>{o.openCount} open</span>
              </div>
            ))
          }
        </div>
      </div>

      {/* SLA breach list */}
      {breachList.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #fca5a5', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', marginBottom: 12 }}>⚡ Active SLA Breaches ({breachList.length})</div>
          {breachList.map(c => (
            <div
              key={c.id}
              onClick={() => onViewCase(c.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid #fee2e2', cursor: 'pointer' }}
            >
              <span style={{ fontSize: 12, fontWeight: 700, color: '#6366f1', minWidth: 90 }}>{c.caseNumber}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.accountName}</div>
              </div>
              <PriorityBadge priority={c.priority} small />
              <StatusBadge status={c.status} small />
              <div style={{ display: 'flex', gap: 4 }}>
                {c.responseBreached   && <SLATimer dueAt={c.responseDueAt}   breached label="Response" />}
                {c.resolutionBreached && <SLATimer dueAt={c.resolutionDueAt} breached label="Resolution" />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Case list ─────────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { key: 'all',              label: 'All' },
  { key: 'open',             label: 'Open' },
  { key: 'in_progress',      label: 'In Progress' },
  { key: 'pending_customer', label: 'Pending' },
  { key: 'resolved',         label: 'Resolved' },
  { key: 'closed',           label: 'Closed' },
];

function CaseRow({ c, onClick }) {
  const hasResponseBreach   = c.responseBreached   || (!c.firstRespondedAt && c.responseDueAt   && new Date(c.responseDueAt)   < new Date());
  const hasResolutionBreach = c.resolutionBreached || (!c.resolvedAt       && c.resolutionDueAt && new Date(c.resolutionDueAt) < new Date());
  const anyBreach = hasResponseBreach || hasResolutionBreach;

  return (
    <div
      onClick={onClick}
      style={{ background: '#fff', borderRadius: 9, border: `1px solid ${anyBreach ? '#fca5a5' : '#e5e7eb'}`, padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, transition: 'box-shadow 0.15s' }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.07)'; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}
    >
      {anyBreach && <span style={{ fontSize: 14, flexShrink: 0 }}>⚡</span>}
      <div style={{ minWidth: 90, flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#6366f1' }}>{c.caseNumber}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
          {c.accountName && <span>{c.accountName} · </span>}
          {c.assigneeName
            ? <span>Assigned: {c.assigneeName}</span>
            : c.teamName
            ? <span>Team: {c.teamName}</span>
            : <span style={{ color: '#fbbf24' }}>Unassigned</span>
          }
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <PriorityBadge priority={c.priority} small />
        <StatusBadge status={c.status} small />
        {c.slaTierName && (
          <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', padding: '2px 7px', borderRadius: 10 }}>{c.slaTierName}</span>
        )}
        {hasResponseBreach  && <SLATimer dueAt={c.responseDueAt} breached={c.responseBreached} label="Resp" />}
        {!hasResponseBreach && c.responseDueAt && !c.firstRespondedAt && <SLATimer dueAt={c.responseDueAt} breached={false} label="Resp" />}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0, minWidth: 80, textAlign: 'right' }}>
        {new Date(c.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}

function CaseListView({ scope, onViewCase, onNewCase }) {
  const [cases, setCases]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [statusTab, setStatusTab] = useState('all');
  const [search, setSearch]       = useState('');
  const [priority, setPriority]   = useState('');
  const [breach, setBreach]       = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiService.support.getCases({
      scope,
      limit: 100,
      ...(statusTab !== 'all' && { status: statusTab }),
      ...(search   && { search }),
      ...(priority && { priority }),
      ...(breach   && { breach }),
    })
      .then(r => { setCases(r.data.cases || []); setError(''); })
      .catch(e => setError(e.response?.data?.error?.message || e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [scope, statusTab, search, priority, breach]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* Toolbar */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input
          placeholder="Search cases…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 180, padding: '7px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, outline: 'none' }}
        />
        <select value={priority} onChange={e => setPriority(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#374151' }}>
          <option value="">All Priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select value={breach} onChange={e => setBreach(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#374151' }}>
          <option value="">All SLA</option>
          <option value="any">Any Breach</option>
          <option value="response">Response Breach</option>
          <option value="resolution">Resolution Breach</option>
        </select>
        <button onClick={onNewCase}
          style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          + New Case
        </button>
      </div>

      {/* Status tabs */}
      <div style={{ display: 'flex', background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '0 20px' }}>
        {STATUS_TABS.map(tab => (
          <button key={tab.key} onClick={() => setStatusTab(tab.key)} style={{
            padding: '10px 16px', fontSize: 13,
            fontWeight: statusTab === tab.key ? 600 : 400,
            color: statusTab === tab.key ? '#6366f1' : '#6b7280',
            background: 'none', border: 'none',
            borderBottom: statusTab === tab.key ? '2px solid #6366f1' : '2px solid transparent',
            cursor: 'pointer', marginBottom: -1, whiteSpace: 'nowrap',
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: 'auto', background: '#f8fafc' }}>
        {loading ? <Spinner /> : error ? (
          <div style={{ padding: 24, color: '#ef4444' }}>⚠️ {error}</div>
        ) : cases.length === 0 ? (
          <EmptyState icon="🎧" title="No cases found" desc="Adjust your filters or create a new case." action="+ New Case" onAction={onNewCase} />
        ) : (
          <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {cases.map(c => (
              <CaseRow key={c.id} c={c} onClick={() => onViewCase(c.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function SupportView() {
  const [activeView, setActiveView]         = useState('dashboard'); // 'dashboard' | 'cases' | 'detail'
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [showNewCase, setShowNewCase]       = useState(false);
  const [scope, setScope]                   = useState('mine');
  const [hasTeam, setHasTeam]               = useState(false);

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if (user.teamId || user.team_id) setHasTeam(true);
  }, []);

  const handleViewCase = (id) => {
    setSelectedCaseId(id);
    setActiveView('detail');
  };

  const handleCaseCreated = (newCase) => {
    setShowNewCase(false);
    handleViewCase(newCase.id);
  };

  const isOnCases = activeView === 'cases' || activeView === 'detail';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {/* ── Header ── */}
      <div style={{ padding: '14px 24px', background: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#111827' }}>🎧 Service</h1>
          <p style={{ margin: 0, fontSize: 13, color: '#9ca3af', marginTop: 2 }}>Customer Support &amp; Case Management</p>
        </div>

        {/* View switcher */}
        <div style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb', fontSize: 13 }}>
          {[['dashboard', '📊 Dashboard'], ['cases', '📋 Cases']].map(([view, label]) => (
            <button key={view} onClick={() => setActiveView(view)} style={{
              padding: '7px 16px', border: 'none', cursor: 'pointer',
              background: (activeView === view || (view === 'cases' && isOnCases)) ? '#6366f1' : '#fff',
              color:      (activeView === view || (view === 'cases' && isOnCases)) ? '#fff'    : '#4b5563',
              fontWeight: activeView === view ? 600 : 400,
            }}>
              {label}
            </button>
          ))}
        </div>

        {/* Scope switcher */}
        {hasTeam && (
          <div style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb', fontSize: 13 }}>
            {[['mine', 'Mine'], ['team', 'Team'], ['all', 'All']].map(([s, label]) => (
              <button key={s} onClick={() => setScope(s)} style={{
                padding: '7px 14px', border: 'none', cursor: 'pointer',
                background: scope === s ? '#4f46e5' : '#fff',
                color:      scope === s ? '#fff'    : '#4b5563',
                fontWeight: scope === s ? 600 : 400,
              }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {activeView !== 'detail' && (
          <button
            onClick={() => setShowNewCase(true)}
            style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            + New Case
          </button>
        )}
      </div>

      {/* ── Sub-views ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeView === 'dashboard' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <DashboardView scope={scope} onViewCase={handleViewCase} />
          </div>
        )}
        {activeView === 'cases' && (
          <CaseListView
            scope={scope}
            onViewCase={handleViewCase}
            onNewCase={() => setShowNewCase(true)}
          />
        )}
        {activeView === 'detail' && selectedCaseId && (
          <CaseDetailPanel
            caseId={selectedCaseId}
            onBack={() => setActiveView('cases')}
            onUpdated={() => {}}
          />
        )}
      </div>

      {/* ── New case modal ── */}
      {showNewCase && (
        <CaseCreateModal
          onClose={() => setShowNewCase(false)}
          onCreated={handleCaseCreated}
        />
      )}
    </div>
  );
}
