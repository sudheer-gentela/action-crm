import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

// ═══════════════════════════════════════════════════════════════════
// SupportView.js — Service / Customer Support Module
//
// State-driven sub-views (same pattern as DealsView):
//   activeView: 'dashboard' | 'cases' | 'detail'
//
// Three logical sections:
//   1. Dashboard  — stats bar, SLA breaches, open by account, by owner
//   2. Case List  — filterable list with status tabs + scope switcher
//   3. Case Detail — metadata, status transitions, plays, activity log
//
// API calls use apiService.support.* (added in Phase 4 apiService update)
// ═══════════════════════════════════════════════════════════════════

const API_BASE = process.env.REACT_APP_API_URL || '';

// ── Helpers ───────────────────────────────────────────────────

function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}/api/support${path}`, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

// ── Status config ─────────────────────────────────────────────

const STATUS_CONFIG = {
  open:             { label: 'Open',             color: '#3b82f6', bg: '#dbeafe' },
  in_progress:      { label: 'In Progress',      color: '#8b5cf6', bg: '#ede9fe' },
  pending_customer: { label: 'Pending Customer', color: '#f59e0b', bg: '#fef3c7' },
  resolved:         { label: 'Resolved',         color: '#10b981', bg: '#d1fae5' },
  closed:           { label: 'Closed',           color: '#6b7280', bg: '#f3f4f6' },
};

const PRIORITY_CONFIG = {
  low:      { label: 'Low',      color: '#6b7280', bg: '#f3f4f6' },
  medium:   { label: 'Medium',   color: '#3b82f6', bg: '#dbeafe' },
  high:     { label: 'High',     color: '#f59e0b', bg: '#fef3c7' },
  critical: { label: 'Critical', color: '#ef4444', bg: '#fee2e2' },
};

// Valid next transitions — mirrors supportService.js TRANSITIONS
const TRANSITIONS = {
  open:             ['in_progress'],
  in_progress:      ['pending_customer', 'resolved'],
  pending_customer: ['in_progress', 'resolved'],
  resolved:         ['closed', 'in_progress'],
  closed:           [],
};

// ── Shared small components ───────────────────────────────────

function StatusBadge({ status, small }) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{
      display: 'inline-block',
      padding: small ? '2px 7px' : '3px 10px',
      borderRadius: 20,
      fontSize: small ? 11 : 12,
      fontWeight: 600,
      color: cfg.color,
      background: cfg.bg,
      whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

function PriorityBadge({ priority, small }) {
  const cfg = PRIORITY_CONFIG[priority] || { label: priority, color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{
      display: 'inline-block',
      padding: small ? '2px 7px' : '3px 10px',
      borderRadius: 4,
      fontSize: small ? 11 : 12,
      fontWeight: 700,
      color: cfg.color,
      background: cfg.bg,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

function SLATimer({ dueAt, breached, label }) {
  if (!dueAt) return null;
  const due     = new Date(dueAt);
  const now     = new Date();
  const diffMs  = due - now;
  const overdue = diffMs < 0;
  const absMs   = Math.abs(diffMs);
  const hours   = Math.floor(absMs / 3_600_000);
  const mins    = Math.floor((absMs % 3_600_000) / 60_000);
  const display = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  const color = breached || overdue ? '#ef4444' : diffMs < 3_600_000 ? '#f59e0b' : '#10b981';
  const bg    = breached || overdue ? '#fee2e2' : diffMs < 3_600_000 ? '#fef3c7' : '#d1fae5';

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 6,
      fontSize: 11, fontWeight: 600, color, background: bg,
    }}>
      {(breached || overdue) ? '⚡' : '⏱'} {label}: {overdue || breached ? `${display} overdue` : `${display} left`}
    </span>
  );
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        border: '3px solid #e5e7eb', borderTopColor: '#6366f1',
        animation: 'spin 0.7s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function EmptyState({ icon, title, desc, action, onAction }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: 10, color: '#94a3b8' }}>
      <div style={{ fontSize: 40 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#475569' }}>{title}</div>
      {desc && <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', maxWidth: 320 }}>{desc}</div>}
      {action && onAction && (
        <button onClick={onAction} style={{ marginTop: 8, padding: '8px 20px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {action}
        </button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// 1. DASHBOARD VIEW
// ══════════════════════════════════════════════════════════════

function DashboardView({ scope, onViewCase }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    setLoading(true);
    apiFetch(`/dashboard?scope=${scope}`)
      .then(d => setData(d))
      .catch(e => setError(e.message))
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
          { label: 'Total Open',         value: stats.totalOpen,          color: '#6366f1', bg: '#eef2ff' },
          { label: 'Response Breaches',  value: stats.responseBreaches,   color: '#ef4444', bg: '#fee2e2' },
          { label: 'Resolution Breaches',value: stats.resolutionBreaches, color: '#f59e0b', bg: '#fef3c7' },
          { label: 'Resolved Today',     value: stats.resolvedToday,      color: '#10b981', bg: '#d1fae5' },
        ].map(s => (
          <div key={s.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: s.value > 0 ? s.color : '#d1d5db' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Status breakdown */}
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
              <div key={s.key} style={{ flex: 1, minWidth: 100, padding: '10px 14px', borderRadius: 8, background: cfg.bg, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: cfg.color }}>{cfg.label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: cfg.color }}>{s.count}</div>
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
            ? <div style={{ fontSize: 13, color: '#9ca3af', padding: '8px 0' }}>No open cases.</div>
            : byAccount.map(a => (
              <div key={a.accountId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#6366f1', flexShrink: 0 }}>
                  {(a.accountName || '?')[0].toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.accountName}</div>
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
            ? <div style={{ fontSize: 13, color: '#9ca3af', padding: '8px 0' }}>No assigned cases.</div>
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

      {/* Active SLA breaches */}
      {breachList.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #fca5a5', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', marginBottom: 12 }}>⚡ Active SLA Breaches ({breachList.length})</div>
          {breachList.map(c => (
            <div key={c.id} onClick={() => onViewCase(c.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid #fee2e2', cursor: 'pointer' }}>
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

// ══════════════════════════════════════════════════════════════
// 2. CASE LIST VIEW
// ══════════════════════════════════════════════════════════════

const STATUS_TABS = [
  { key: 'all',             label: 'All' },
  { key: 'open',            label: 'Open' },
  { key: 'in_progress',     label: 'In Progress' },
  { key: 'pending_customer',label: 'Pending' },
  { key: 'resolved',        label: 'Resolved' },
  { key: 'closed',          label: 'Closed' },
];

function CaseListView({ scope, hasTeam, onViewCase, onNewCase }) {
  const [cases, setCases]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [statusTab, setStatusTab] = useState('all');
  const [search, setSearch]       = useState('');
  const [breach, setBreach]       = useState('');
  const [priority, setPriority]   = useState('');

  const fetchCases = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ scope, limit: 100 });
    if (statusTab !== 'all') params.set('status', statusTab);
    if (search)   params.set('search', search);
    if (breach)   params.set('breach', breach);
    if (priority) params.set('priority', priority);
    apiFetch(`/cases?${params}`)
      .then(d => { setCases(d.cases || []); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [scope, statusTab, search, breach, priority]);

  useEffect(() => { fetchCases(); }, [fetchCases]);

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
        <select value={priority} onChange={e => setPriority(e.target.value)} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#374151' }}>
          <option value="">All Priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select value={breach} onChange={e => setBreach(e.target.value)} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#374151' }}>
          <option value="">All SLA</option>
          <option value="any">Any Breach</option>
          <option value="response">Response Breach</option>
          <option value="resolution">Resolution Breach</option>
        </select>
        <button onClick={onNewCase} style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
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

      {/* Case rows */}
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

function CaseRow({ c, onClick }) {
  const hasResponseBreach   = c.responseBreached   || (!c.firstRespondedAt && c.responseDueAt   && new Date(c.responseDueAt)   < new Date());
  const hasResolutionBreach = c.resolutionBreached || (!c.resolvedAt       && c.resolutionDueAt && new Date(c.resolutionDueAt) < new Date());
  const anyBreach = hasResponseBreach || hasResolutionBreach;

  return (
    <div onClick={onClick} style={{
      background: '#fff', borderRadius: 9,
      border: `1px solid ${anyBreach ? '#fca5a5' : '#e5e7eb'}`,
      padding: '12px 16px', cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 14,
      transition: 'box-shadow 0.15s',
    }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.07)'}
      onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
    >
      {anyBreach && <span style={{ fontSize: 14, flexShrink: 0 }}>⚡</span>}
      <div style={{ minWidth: 90, flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#6366f1' }}>{c.caseNumber}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
          {c.accountName && <span>{c.accountName} · </span>}
          {c.assigneeName ? <span>Assigned: {c.assigneeName}</span> : c.teamName ? <span>Team: {c.teamName}</span> : <span style={{ color: '#fbbf24' }}>Unassigned</span>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <PriorityBadge priority={c.priority} small />
        <StatusBadge status={c.status} small />
        {c.slaTierName && (
          <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', padding: '2px 7px', borderRadius: 10 }}>{c.slaTierName}</span>
        )}
        {hasResponseBreach   && <SLATimer dueAt={c.responseDueAt}   breached={c.responseBreached}   label="Resp" />}
        {!hasResponseBreach  && c.responseDueAt && !c.firstRespondedAt && <SLATimer dueAt={c.responseDueAt} breached={false} label="Resp" />}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0, minWidth: 80, textAlign: 'right' }}>
        {new Date(c.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// 3. CASE DETAIL VIEW
// ══════════════════════════════════════════════════════════════

function CaseDetailView({ caseId, onBack, onCaseUpdated }) {
  const [caseData, setCaseData]   = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [saving, setSaving]       = useState(false);
  const [noteBody, setNoteBody]   = useState('');
  const [noteInternal, setNoteInternal] = useState(false);
  const [addingNote, setAddingNote]     = useState(false);
  const [teams, setTeams]         = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);
  const [slaTiers, setSlaTiers]   = useState([]);
  const [playsExpanded, setPlaysExpanded] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch(`/cases/${caseId}`)
      .then(d => { setCaseData(d.case); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [caseId]);

  useEffect(() => {
    load();
    // Load teams + SLA tiers for pickers
    apiFetch('/teams').then(d => setTeams(d.teams || [])).catch(() => {});
    apiFetch('/sla-tiers').then(d => setSlaTiers(d.tiers || [])).catch(() => {});
  }, [load]);

  // When team changes, load its members
  useEffect(() => {
    if (!caseData?.assignedTeamId) { setTeamMembers([]); return; }
    apiFetch(`/teams/${caseData.assignedTeamId}/members`)
      .then(d => setTeamMembers(d.members || []))
      .catch(() => setTeamMembers([]));
  }, [caseData?.assignedTeamId]);

  const patch = async (payload) => {
    setSaving(true);
    try {
      const d = await apiFetch(`/cases/${caseId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setCaseData(d.case);
      if (onCaseUpdated) onCaseUpdated(d.case);
      // Reload team members if team changed
      if (payload.assignedTeamId !== undefined) {
        const tid = payload.assignedTeamId;
        if (tid) {
          apiFetch(`/teams/${tid}/members`).then(d => setTeamMembers(d.members || [])).catch(() => {});
        } else {
          setTeamMembers([]);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = (newStatus) => patch({ status: newStatus });
  const handlePlayUpdate   = async (playId, status) => {
    try {
      await apiFetch(`/cases/${caseId}/plays/${playId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      load();
    } catch (e) { setError(e.message); }
  };

  const handleAddNote = async () => {
    if (!noteBody.trim()) return;
    setAddingNote(true);
    try {
      await apiFetch(`/cases/${caseId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: noteBody.trim(), isInternal: noteInternal }),
      });
      setNoteBody('');
      setNoteInternal(false);
      load();
    } catch (e) { setError(e.message); }
    finally { setAddingNote(false); }
  };

  if (loading) return <Spinner />;
  if (error && !caseData) return <div style={{ padding: 24, color: '#ef4444' }}>⚠️ {error}</div>;
  if (!caseData) return null;

  const c = caseData;
  const nextStatuses = TRANSITIONS[c.status] || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* Header */}
      <div style={{ padding: '14px 20px', background: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#6b7280' }}>
          ← Back
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#6366f1' }}>{c.caseNumber}</span>
            <PriorityBadge priority={c.priority} small />
            <StatusBadge status={c.status} small />
            {c.responseBreached   && <SLATimer dueAt={c.responseDueAt}   breached label="Response" />}
            {c.resolutionBreached && <SLATimer dueAt={c.resolutionDueAt} breached label="Resolution" />}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</div>
        </div>
        {saving && <span style={{ fontSize: 12, color: '#9ca3af' }}>Saving…</span>}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', background: '#f8fafc' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 0, minHeight: '100%' }}>

          {/* ── Left: Activity + Notes ── */}
          <div style={{ padding: 20, borderRight: '1px solid #e5e7eb' }}>

            {error && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fee2e2', borderRadius: 7, fontSize: 13, color: '#ef4444' }}>⚠️ {error}</div>}

            {/* Status transition buttons */}
            {nextStatuses.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: '14px 16px', marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Move to</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {nextStatuses.map(s => {
                    const cfg = STATUS_CONFIG[s];
                    return (
                      <button key={s} onClick={() => handleStatusChange(s)} disabled={saving} style={{
                        padding: '7px 16px', borderRadius: 7,
                        border: `1.5px solid ${cfg.color}`,
                        background: '#fff', color: cfg.color,
                        fontSize: 13, fontWeight: 600, cursor: 'pointer',
                        transition: 'all 0.15s',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.background = cfg.bg; }}
                        onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Plays panel */}
            {c.plays?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, marginBottom: 16, overflow: 'hidden' }}>
                <div onClick={() => setPlaysExpanded(v => !v)} style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', borderBottom: playsExpanded ? '1px solid #e5e7eb' : 'none' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
                    Playbook Plays
                    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: '#9ca3af' }}>
                      {c.plays.filter(p => p.status === 'completed').length}/{c.plays.length} complete
                    </span>
                  </div>
                  <span style={{ color: '#9ca3af', fontSize: 12 }}>{playsExpanded ? '▲' : '▼'}</span>
                </div>
                {playsExpanded && (
                  <div style={{ padding: '8px 0' }}>
                    {c.plays.map(p => (
                      <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '9px 16px', borderBottom: '1px solid #f9fafb' }}>
                        <div style={{ marginTop: 2, flexShrink: 0 }}>
                          {p.status === 'completed'
                            ? <span style={{ fontSize: 16, color: '#10b981' }}>✓</span>
                            : p.status === 'skipped'
                            ? <span style={{ fontSize: 16, color: '#9ca3af' }}>–</span>
                            : <div style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid #d1d5db' }} />
                          }
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: p.status === 'completed' ? '#9ca3af' : '#111827', textDecoration: p.status === 'completed' ? 'line-through' : 'none' }}>
                            {p.play.title}
                          </div>
                          {p.play.description && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{p.play.description}</div>}
                          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                            {p.play.channel  && <span style={{ fontSize: 10, background: '#f3f4f6', color: '#6b7280', padding: '1px 6px', borderRadius: 4 }}>{p.play.channel}</span>}
                            {p.play.priority && <span style={{ fontSize: 10, background: '#f3f4f6', color: '#6b7280', padding: '1px 6px', borderRadius: 4 }}>{p.play.priority}</span>}
                            {p.roleName      && <span style={{ fontSize: 10, background: '#eef2ff', color: '#6366f1', padding: '1px 6px', borderRadius: 4 }}>{p.roleName}</span>}
                            {p.dueAt && <span style={{ fontSize: 10, color: '#9ca3af' }}>Due {new Date(p.dueAt).toLocaleDateString()}</span>}
                          </div>
                        </div>
                        {p.status === 'pending' && (
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <button onClick={() => handlePlayUpdate(p.id, 'completed')} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #10b981', background: '#fff', color: '#10b981', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Done</button>
                            <button onClick={() => handlePlayUpdate(p.id, 'skipped')} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#9ca3af', fontSize: 11, cursor: 'pointer' }}>Skip</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Activity log */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, marginBottom: 16 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', fontSize: 13, fontWeight: 700, color: '#111827' }}>Activity</div>
              <div style={{ padding: '8px 0', maxHeight: 360, overflowY: 'auto' }}>
                {(!c.notes || c.notes.length === 0) ? (
                  <div style={{ padding: '16px', fontSize: 13, color: '#9ca3af' }}>No activity yet.</div>
                ) : c.notes.map(n => (
                  <div key={n.id} style={{ padding: '10px 16px', borderBottom: '1px solid #f9fafb' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <div style={{ width: 26, height: 26, borderRadius: '50%', background: n.noteType === 'status_change' ? '#ede9fe' : n.noteType === 'assignment' ? '#fef3c7' : '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#6b7280', flexShrink: 0 }}>
                        {n.noteType === 'status_change' ? '↔' : n.noteType === 'assignment' ? '→' : n.author ? (n.author.firstName || '?')[0].toUpperCase() : '🤖'}
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                        {n.author ? `${n.author.firstName} ${n.author.lastName}` : 'System'}
                      </span>
                      {n.isInternal && (
                        <span style={{ fontSize: 10, background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 10, fontWeight: 600 }}>Internal</span>
                      )}
                      <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>{new Date(n.createdAt).toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: 13, color: n.noteType === 'comment' ? '#374151' : '#6b7280', marginLeft: 34, fontStyle: n.noteType !== 'comment' ? 'italic' : 'normal' }}>
                      {n.body}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Add note */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 }}>Add Note</div>
              <textarea
                value={noteBody}
                onChange={e => setNoteBody(e.target.value)}
                placeholder="Write a note or comment…"
                rows={3}
                style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                  <input type="checkbox" checked={noteInternal} onChange={e => setNoteInternal(e.target.checked)} />
                  Internal note (not visible to customer)
                </label>
                <button onClick={handleAddNote} disabled={addingNote || !noteBody.trim()} style={{
                  padding: '7px 20px', borderRadius: 8, border: 'none',
                  background: noteBody.trim() ? '#6366f1' : '#e5e7eb',
                  color: noteBody.trim() ? '#fff' : '#9ca3af',
                  fontSize: 13, fontWeight: 600, cursor: noteBody.trim() ? 'pointer' : 'default',
                }}>
                  {addingNote ? 'Saving…' : 'Add Note'}
                </button>
              </div>
            </div>
          </div>

          {/* ── Right: Metadata panel ── */}
          <div style={{ padding: 20, background: '#fff' }}>

            {/* Description */}
            {c.description && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Description</div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{c.description}</div>
              </div>
            )}

            <MetaSection title="Details">
              {/* Priority */}
              <MetaRow label="Priority">
                <select value={c.priority} onChange={e => patch({ priority: e.target.value })} disabled={saving}
                  style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', color: '#374151' }}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </MetaRow>

              {/* SLA Tier */}
              <MetaRow label="SLA Tier">
                <select value={c.slaTierId || ''} onChange={e => patch({ slaTierId: e.target.value || null })} disabled={saving}
                  style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', color: '#374151' }}>
                  <option value="">None</option>
                  {slaTiers.map(t => <option key={t.id} value={t.id}>{t.name} ({t.responseTargetHours}h / {t.resolutionTargetHours}h)</option>)}
                </select>
              </MetaRow>

              {/* Account */}
              <MetaRow label="Account">
                {c.accountName
                  ? <span className="detail-value--link" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'accounts', accountId: c.accountId } }))} style={{ fontSize: 13, color: '#6366f1', cursor: 'pointer' }}>{c.accountName} →</span>
                  : <span style={{ fontSize: 13, color: '#9ca3af' }}>Not linked</span>
                }
              </MetaRow>

              {/* Contact */}
              <MetaRow label="Contact">
                <span style={{ fontSize: 13, color: '#374151' }}>{c.contactName || '—'}</span>
              </MetaRow>

              {/* Deal */}
              <MetaRow label="Deal">
                {c.dealName
                  ? <span onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'deals', dealId: c.dealId } }))} style={{ fontSize: 13, color: '#6366f1', cursor: 'pointer' }}>{c.dealName} →</span>
                  : <span style={{ fontSize: 13, color: '#9ca3af' }}>Not linked</span>
                }
              </MetaRow>

              {/* Source */}
              <MetaRow label="Source">
                <span style={{ fontSize: 12, background: '#f3f4f6', color: '#6b7280', padding: '2px 8px', borderRadius: 4, textTransform: 'capitalize' }}>{c.source}</span>
              </MetaRow>
            </MetaSection>

            <MetaSection title="Assignment">
              {/* Team */}
              <MetaRow label="Team">
                <select value={c.assignedTeamId || ''} onChange={e => patch({ assignedTeamId: e.target.value || null, assignedTo: null })} disabled={saving}
                  style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', color: '#374151', maxWidth: 160 }}>
                  <option value="">Unassigned</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </MetaRow>

              {/* Individual */}
              <MetaRow label="Assignee">
                <select value={c.assignedTo || ''} onChange={e => patch({ assignedTo: e.target.value || null })} disabled={saving || !c.assignedTeamId}
                  style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', color: '#374151', maxWidth: 160 }}>
                  <option value="">Unassigned</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
                </select>
                {!c.assignedTeamId && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Select a team first</div>}
              </MetaRow>

              {/* Creator */}
              <MetaRow label="Created by">
                <span style={{ fontSize: 13, color: '#374151' }}>{c.creatorName || '—'}</span>
              </MetaRow>
            </MetaSection>

            <MetaSection title="SLA">
              <MetaRow label="Response due">
                {c.responseDueAt
                  ? <SLATimer dueAt={c.responseDueAt} breached={c.responseBreached} label="" />
                  : <span style={{ fontSize: 13, color: '#9ca3af' }}>—</span>}
              </MetaRow>
              <MetaRow label="Resolution due">
                {c.resolutionDueAt
                  ? <SLATimer dueAt={c.resolutionDueAt} breached={c.resolutionBreached} label="" />
                  : <span style={{ fontSize: 13, color: '#9ca3af' }}>—</span>}
              </MetaRow>
              {c.firstRespondedAt && (
                <MetaRow label="First response"><span style={{ fontSize: 12, color: '#10b981' }}>{new Date(c.firstRespondedAt).toLocaleString()}</span></MetaRow>
              )}
              {c.resolvedAt && (
                <MetaRow label="Resolved"><span style={{ fontSize: 12, color: '#10b981' }}>{new Date(c.resolvedAt).toLocaleString()}</span></MetaRow>
              )}
            </MetaSection>

            <MetaSection title="Dates">
              <MetaRow label="Created"><span style={{ fontSize: 12, color: '#6b7280' }}>{new Date(c.createdAt).toLocaleString()}</span></MetaRow>
              <MetaRow label="Updated"><span style={{ fontSize: 12, color: '#6b7280' }}>{new Date(c.updatedAt).toLocaleString()}</span></MetaRow>
            </MetaSection>

          </div>
        </div>
      </div>
    </div>
  );
}

function MetaSection({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function MetaRow({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <span style={{ fontSize: 12, color: '#9ca3af', minWidth: 100, flexShrink: 0, paddingTop: 2 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// 4. NEW CASE MODAL
// ══════════════════════════════════════════════════════════════

function NewCaseModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    subject: '', description: '', priority: 'medium',
    accountId: '', contactId: '', dealId: '',
    slaTierId: '', assignedTeamId: '', assignedTo: '',
    source: 'manual',
  });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [accounts, setAccounts] = useState([]);
  const [slaTiers, setSlaTiers] = useState([]);
  const [teams, setTeams]       = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);

  useEffect(() => {
    // Load reference data
    Promise.all([
      fetch(`${API_BASE}/api/accounts`, { headers: authHeaders() }).then(r => r.json()),
      apiFetch('/sla-tiers'),
      apiFetch('/teams'),
    ]).then(([accts, tiers, teamsData]) => {
      setAccounts(accts.accounts || accts || []);
      setSlaTiers(tiers.tiers || []);
      setTeams(teamsData.teams || []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!form.assignedTeamId) { setTeamMembers([]); setForm(f => ({ ...f, assignedTo: '' })); return; }
    apiFetch(`/teams/${form.assignedTeamId}/members`).then(d => setTeamMembers(d.members || [])).catch(() => {});
  }, [form.assignedTeamId]);

  const set = (field, val) => setForm(f => ({ ...f, [field]: val }));

  const handleSubmit = async () => {
    if (!form.subject.trim()) { setError('Subject is required'); return; }
    setSaving(true); setError('');
    try {
      const d = await apiFetch('/cases', {
        method: 'POST',
        body: JSON.stringify({
          subject:        form.subject.trim(),
          description:    form.description || undefined,
          priority:       form.priority,
          accountId:      form.accountId      ? parseInt(form.accountId)      : undefined,
          contactId:      form.contactId      ? parseInt(form.contactId)      : undefined,
          dealId:         form.dealId         ? parseInt(form.dealId)         : undefined,
          slaTierId:      form.slaTierId      ? parseInt(form.slaTierId)      : undefined,
          assignedTeamId: form.assignedTeamId ? parseInt(form.assignedTeamId) : undefined,
          assignedTo:     form.assignedTo     ? parseInt(form.assignedTo)     : undefined,
          source:         form.source,
        }),
      });
      onCreated(d.case);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>New Case</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}>×</button>
        </div>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && <div style={{ padding: '8px 12px', background: '#fee2e2', borderRadius: 7, fontSize: 13, color: '#ef4444' }}>⚠️ {error}</div>}

          <FormField label="Subject *">
            <input value={form.subject} onChange={e => set('subject', e.target.value)} placeholder="Brief description of the issue…"
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
          </FormField>

          <FormField label="Description">
            <textarea value={form.description} onChange={e => set('description', e.target.value)} rows={3} placeholder="More detail…"
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
          </FormField>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Priority">
              <select value={form.priority} onChange={e => set('priority', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </FormField>
            <FormField label="Source">
              <select value={form.source} onChange={e => set('source', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="manual">Manual</option>
                <option value="email">Email</option>
                <option value="portal">Portal</option>
              </select>
            </FormField>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Account">
              <select value={form.accountId} onChange={e => set('accountId', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="">— None —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
            <FormField label="SLA Tier">
              <select value={form.slaTierId} onChange={e => set('slaTierId', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="">Inherit from account</option>
                {slaTiers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </FormField>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Assign to Team">
              <select value={form.assignedTeamId} onChange={e => set('assignedTeamId', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="">— Unassigned —</option>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </FormField>
            <FormField label="Assign to Person">
              <select value={form.assignedTo} onChange={e => set('assignedTo', e.target.value)} disabled={!form.assignedTeamId}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, opacity: form.assignedTeamId ? 1 : 0.5 }}>
                <option value="">— Unassigned —</option>
                {teamMembers.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
              </select>
            </FormField>
          </div>
        </div>

        <div style={{ padding: '14px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !form.subject.trim()} style={{
            padding: '8px 24px', borderRadius: 8, border: 'none',
            background: form.subject.trim() ? '#6366f1' : '#e5e7eb',
            color: form.subject.trim() ? '#fff' : '#9ca3af',
            fontSize: 13, fontWeight: 600,
            cursor: form.subject.trim() ? 'pointer' : 'default',
          }}>
            {saving ? 'Creating…' : 'Create Case'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ROOT — SupportView
// ══════════════════════════════════════════════════════════════

export default function SupportView() {
  const [activeView, setActiveView] = useState('dashboard'); // 'dashboard' | 'cases' | 'detail'
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [showNewCase, setShowNewCase]       = useState(false);
  const [scope, setScope]                   = useState('mine');
  const [hasTeam, setHasTeam]               = useState(false);

  useEffect(() => {
    // Check if user has a team for scope switcher
    try {
      const { apiService: api } = require('./apiService');
      api.orgAdmin?.getMyTeam?.()
        .then(r => setHasTeam(r.data?.hasTeam || false))
        .catch(() => {});
    } catch { /* apiService.orgAdmin may not exist yet */ }
  }, []);

  const handleViewCase = (id) => {
    setSelectedCaseId(id);
    setActiveView('detail');
  };

  const handleNewCase = () => setShowNewCase(true);

  const handleCaseCreated = (newCase) => {
    setShowNewCase(false);
    handleViewCase(newCase.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {/* ── Module header ── */}
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
              background: activeView === view || (activeView === 'detail' && view === 'cases') ? '#6366f1' : '#fff',
              color: activeView === view || (activeView === 'detail' && view === 'cases') ? '#fff' : '#4b5563',
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
                color: scope === s ? '#fff' : '#4b5563',
                fontWeight: scope === s ? 600 : 400,
              }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {activeView !== 'detail' && (
          <button onClick={handleNewCase} style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
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
            hasTeam={hasTeam}
            onViewCase={handleViewCase}
            onNewCase={handleNewCase}
          />
        )}
        {activeView === 'detail' && selectedCaseId && (
          <CaseDetailView
            caseId={selectedCaseId}
            onBack={() => setActiveView('cases')}
            onCaseUpdated={() => {}}
          />
        )}
      </div>

      {/* ── New Case Modal ── */}
      {showNewCase && (
        <NewCaseModal
          onClose={() => setShowNewCase(false)}
          onCreated={handleCaseCreated}
        />
      )}
    </div>
  );
}
