import React, { useState, useEffect, useCallback } from 'react';
import './DealPlaysPanel.css';

const API = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  pending:   { icon: '🔒', label: 'Waiting',    color: '#94a3b8', bg: '#f1f5f9' },
  active:    { icon: '○',  label: 'Ready',      color: '#3b82f6', bg: '#eff6ff' },
  completed: { icon: '✓',  label: 'Completed',  color: '#16a34a', bg: '#f0fdf4' },
  skipped:   { icon: '⏭',  label: 'Skipped',    color: '#9ca3af', bg: '#f9fafb' },
};

const CHANNEL_ICONS = {
  email: '✉️', call: '📞', meeting: '🤝', document: '📄', internal_task: '🏠',
};

const PRIORITY_COLORS = {
  high:   { color: '#dc2626', bg: '#fef2f2' },
  medium: { color: '#d97706', bg: '#fffbeb' },
  low:    { color: '#6b7280', bg: '#f9fafb' },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isOverdue(dueDate, status) {
  if (!dueDate || status === 'completed' || status === 'skipped') return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}

// ── Sub-components ───────────────────────────────────────────────────────────

function PlayStatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.active;
  return (
    <span className="dpp-status-badge" style={{ color: cfg.color, background: cfg.bg }}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

function AssigneePills({ assignees }) {
  if (!assignees || assignees.length === 0) {
    return <span className="dpp-no-assignee">Unassigned</span>;
  }
  return (
    <div className="dpp-assignees">
      {assignees.map((a, i) => (
        <span key={a.user_id || i} className="dpp-assignee-pill" title={a.role_name || ''}>
          {a.name?.split(' ').map(n => n[0]).join('').toUpperCase()}
          <span className="dpp-assignee-name">{a.name}</span>
          {a.role_name && <span className="dpp-assignee-role">{a.role_name}</span>}
        </span>
      ))}
    </div>
  );
}

function DependencyTag({ instance, allInstances }) {
  if (instance.status !== 'pending' || instance.execution_type !== 'sequential') return null;
  return (
    <span className="dpp-dep-tag">⏳ Waiting on earlier plays</span>
  );
}

// ── Add Play Modal ──────────────────────────────────────────────────────────

function AddPlayForm({ dealId, teamMembers, onAdd, onCancel }) {
  const [title, setTitle] = useState('');
  const [channel, setChannel] = useState('');
  const [priority, setPriority] = useState('medium');
  const [isGate, setIsGate] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [assigneeIds, setAssigneeIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!title.trim()) { setError('Title is required'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(`/deal-plays/${dealId}/manual`, {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), channel: channel || null, priority, isGate, dueDate: dueDate || null, assigneeIds }),
      });
      onAdd(res.instance);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function toggleAssignee(uid) {
    setAssigneeIds(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]);
  }

  return (
    <div className="dpp-add-form">
      <div className="dpp-add-form__title">Add Custom Play</div>
      <input className="dpp-input" placeholder="Play title…" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
      <div className="dpp-add-form__row">
        <select className="dpp-select" value={channel} onChange={e => setChannel(e.target.value)}>
          <option value="">Channel…</option>
          <option value="email">✉️ Email</option>
          <option value="call">📞 Call</option>
          <option value="meeting">🤝 Meeting</option>
          <option value="document">📄 Document</option>
          <option value="internal_task">🏠 Internal</option>
        </select>
        <select className="dpp-select" value={priority} onChange={e => setPriority(e.target.value)}>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <input className="dpp-input dpp-input--date" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
        <label className="dpp-checkbox-label">
          <input type="checkbox" checked={isGate} onChange={e => setIsGate(e.target.checked)} />
          🚧 Gate
        </label>
      </div>
      {teamMembers.length > 0 && (
        <div className="dpp-add-form__assignees">
          <div className="dpp-add-form__assignees-label">Assign to:</div>
          <div className="dpp-add-form__assignees-list">
            {teamMembers.map(m => (
              <label key={m.userId} className={`dpp-assignee-check ${assigneeIds.includes(m.userId) ? 'dpp-assignee-check--selected' : ''}`}>
                <input type="checkbox" checked={assigneeIds.includes(m.userId)} onChange={() => toggleAssignee(m.userId)} />
                {m.name} {m.roleName ? `(${m.roleName})` : ''}
              </label>
            ))}
          </div>
        </div>
      )}
      {error && <div className="dpp-error">{error}</div>}
      <div className="dpp-add-form__actions">
        <button className="dpp-btn dpp-btn--save" onClick={handleSubmit} disabled={saving}>{saving ? '…' : 'Add Play'}</button>
        <button className="dpp-btn dpp-btn--cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Reassign Dropdown ───────────────────────────────────────────────────────

function ReassignDropdown({ instance, teamMembers, dealId, onReassigned }) {
  const [open, setOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);

  async function handleAssign(userId) {
    setAssigning(true);
    try {
      const member = teamMembers.find(m => m.userId === userId);
      await apiFetch(`/deal-plays/${dealId}/instances/${instance.id}/assignees`, {
        method: 'POST',
        body: JSON.stringify({ userId, roleId: member?.roleId || null }),
      });
      onReassigned();
    } catch (err) {
      console.error('Reassign failed:', err);
    } finally {
      setAssigning(false);
      setOpen(false);
    }
  }

  const currentIds = new Set((instance.assignees || []).map(a => a.user_id));
  const available = teamMembers.filter(m => !currentIds.has(m.userId));

  if (available.length === 0) return null;

  return (
    <div className="dpp-reassign">
      <button className="dpp-btn dpp-btn--tiny" onClick={() => setOpen(!open)} title="Add assignee">
        {assigning ? '…' : '+ Assign'}
      </button>
      {open && (
        <div className="dpp-reassign-dropdown">
          {available.map(m => (
            <button key={m.userId} className="dpp-reassign-option" onClick={() => handleAssign(m.userId)}>
              {m.name} {m.roleName ? `— ${m.roleName}` : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────────

export default function DealPlaysPanel({ deal, stageKey }) {
  const [instances, setInstances]     = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);
  const [gateStatus, setGateStatus]   = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [filterRole, setFilterRole]   = useState('all');
  const [viewMode, setViewMode]       = useState('all'); // 'all' or 'mine'

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
  const userOrgRole = currentUser.org_role || currentUser.role || currentUser.orgRole || '';
  const activeNavRole = sessionStorage.getItem('activeRole') || '';
  const isAdmin = userOrgRole === 'owner' || userOrgRole === 'admin'
    || activeNavRole === 'org-admin' || activeNavRole === 'super-admin';
  const isDealOwner = deal?.user_id === currentUser.id;
  const canManage = isAdmin || isDealOwner;

  const fetchData = useCallback(async () => {
    if (!deal?.id) return;
    try {
      const sk = stageKey || deal.stage_key || '';
      const [playsRes, teamRes] = await Promise.all([
        apiFetch(`/deal-plays/${deal.id}${sk ? `?stageKey=${sk}` : ''}`),
        apiFetch(`/deal-team/${deal.id}/members`),
      ]);
      setInstances(playsRes.instances || []);
      setTeamMembers((teamRes.members || []).map(m => ({
        userId: m.userId, name: m.name, roleId: m.roleId, roleName: m.roleName, roleKey: m.roleKey,
      })));

      // Gate check
      if (sk) {
        try {
          const gateRes = await apiFetch(`/deal-plays/${deal.id}/gate-check?stageKey=${sk}`);
          setGateStatus(gateRes);
        } catch (_) {}
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deal?.id, stageKey, deal?.stage_key]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleComplete(instance) {
    try {
      await apiFetch(`/deal-plays/${deal.id}/instances/${instance.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'completed' }),
      });
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSkip(instance) {
    if (!window.confirm(`Skip "${instance.title}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/deal-plays/${deal.id}/instances/${instance.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'skipped' }),
      });
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleActivate() {
    const sk = stageKey || deal.stage_key;
    if (!sk) return;
    try {
      setLoading(true);
      const res = await apiFetch(`/deal-plays/${deal.id}/activate`, {
        method: 'POST', body: JSON.stringify({ stageKey: sk }),
      });
      if (res.warnings?.length > 0) {
        setError('⚠️ ' + res.warnings.join('; '));
      }
      fetchData();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  // ── Filter ─────────────────────────────────────────────────────────────────

  const uniqueRoles = [...new Map(
    instances.flatMap(i => (i.assignees || []).map(a => [a.role_key, a.role_name]))
  ).entries()].filter(([k]) => k);

  let filtered = instances;
  if (viewMode === 'mine') {
    filtered = filtered.filter(i => (i.assignees || []).some(a => a.user_id === currentUser.id));
  }
  if (filterRole !== 'all') {
    filtered = filtered.filter(i => (i.assignees || []).some(a => a.role_key === filterRole));
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  const total     = instances.length;
  const completed = instances.filter(i => i.status === 'completed').length;
  const gates     = instances.filter(i => i.is_gate && i.status !== 'completed' && i.status !== 'skipped').length;
  const pct       = total > 0 ? Math.round((completed / total) * 100) : 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="dpp-loading"><span className="dpp-spinner" /> Loading plays…</div>;
  }

  return (
    <div className="dpp-root">

      {/* Header */}
      <div className="dpp-header">
        <div className="dpp-header__left">
          <span className="dpp-header__title">Plays</span>
          {total > 0 && (
            <span className="dpp-header__stats">
              {completed}/{total} done ({pct}%)
              {gates > 0 && <span className="dpp-gate-count"> · 🚧 {gates} gate{gates !== 1 ? 's' : ''} remaining</span>}
            </span>
          )}
        </div>
        <div className="dpp-header__right">
          {/* View mode toggle */}
          <div className="dpp-view-toggle">
            <button className={`dpp-view-btn ${viewMode === 'all' ? 'dpp-view-btn--active' : ''}`} onClick={() => setViewMode('all')}>All</button>
            <button className={`dpp-view-btn ${viewMode === 'mine' ? 'dpp-view-btn--active' : ''}`} onClick={() => setViewMode('mine')}>My Plays</button>
          </div>
          {/* Role filter */}
          {uniqueRoles.length > 1 && (
            <select className="dpp-role-filter" value={filterRole} onChange={e => setFilterRole(e.target.value)}>
              <option value="all">All Roles</option>
              {uniqueRoles.map(([key, name]) => (
                <option key={key} value={key}>{name}</option>
              ))}
            </select>
          )}
          {canManage && (
            <button className="dpp-btn dpp-btn--add" onClick={() => setShowAddForm(v => !v)}>
              {showAddForm ? 'Cancel' : '+ Add Play'}
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="dpp-progress">
          <div className="dpp-progress__bar" style={{ width: `${pct}%` }} />
        </div>
      )}

      {error && <div className="dpp-error">{error} <button className="dpp-error-dismiss" onClick={() => setError('')}>✕</button></div>}

      {/* Gate warning */}
      {gateStatus && !gateStatus.canAdvance && gateStatus.enforcement === 'strict' && (
        <div className="dpp-gate-warning dpp-gate-warning--strict">
          🚧 <strong>Stage advancement blocked</strong> — {gateStatus.incompleteGates.length} gate{gateStatus.incompleteGates.length !== 1 ? 's' : ''} must be completed:
          {gateStatus.incompleteGates.map(g => (
            <span key={g.id} className="dpp-gate-warning__item">{g.title}</span>
          ))}
        </div>
      )}
      {gateStatus && gateStatus.incompleteGates?.length > 0 && gateStatus.enforcement === 'advisory' && (
        <div className="dpp-gate-warning dpp-gate-warning--advisory">
          ⚠️ {gateStatus.incompleteGates.length} gate{gateStatus.incompleteGates.length !== 1 ? 's' : ''} not yet completed — you can still advance, but consider completing:
          {gateStatus.incompleteGates.map(g => (
            <span key={g.id} className="dpp-gate-warning__item">{g.title}</span>
          ))}
        </div>
      )}

      {/* Add form */}
      {showAddForm && (
        <AddPlayForm
          dealId={deal.id}
          teamMembers={teamMembers}
          onAdd={(inst) => { setInstances(prev => [...prev, inst]); setShowAddForm(false); }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Empty state */}
      {total === 0 && (
        <div className="dpp-empty">
          <p>No plays activated for this stage yet.</p>
          {canManage && (
            <button className="dpp-btn dpp-btn--activate" onClick={handleActivate}>
              ▶ Activate Playbook Plays
            </button>
          )}
        </div>
      )}

      {/* Play list */}
      <div className="dpp-plays">
        {filtered.map((instance, idx) => {
          const overdue = isOverdue(instance.due_date, instance.status);
          const isMyPlay = (instance.assignees || []).some(a => a.user_id === currentUser.id);
          const canAct = canManage || isMyPlay;
          const prCfg = PRIORITY_COLORS[instance.priority] || PRIORITY_COLORS.medium;

          return (
            <div
              key={instance.id}
              className={`dpp-play ${instance.status === 'completed' ? 'dpp-play--completed' : ''} ${instance.status === 'skipped' ? 'dpp-play--skipped' : ''} ${overdue ? 'dpp-play--overdue' : ''}`}
            >
              {/* Left: status + sequence indicator */}
              <div className="dpp-play__left">
                <div className="dpp-play__order">{idx + 1}</div>
                {instance.execution_type === 'sequential' && (
                  <div className="dpp-play__seq-line" />
                )}
              </div>

              {/* Center: content */}
              <div className="dpp-play__content">
                <div className="dpp-play__title-row">
                  {instance.channel && (
                    <span className="dpp-play__channel">{CHANNEL_ICONS[instance.channel] || '📋'}</span>
                  )}
                  <span className={`dpp-play__title ${instance.status === 'completed' ? 'dpp-play__title--done' : ''}`}>
                    {instance.title}
                  </span>
                  {instance.is_gate && <span className="dpp-play__gate">🚧 GATE</span>}
                  {instance.is_manual && <span className="dpp-play__manual">✏️ Custom</span>}
                </div>

                {instance.description && instance.status === 'active' && (
                  <div className="dpp-play__desc">{instance.description}</div>
                )}

                <div className="dpp-play__meta">
                  <PlayStatusBadge status={instance.status} />
                  <span className="dpp-play__priority" style={{ color: prCfg.color, background: prCfg.bg }}>
                    {instance.priority}
                  </span>
                  {instance.due_date && (
                    <span className={`dpp-play__due ${overdue ? 'dpp-play__due--overdue' : ''}`}>
                      {overdue ? '🔴 ' : '📅 '}{formatDate(instance.due_date)}
                    </span>
                  )}
                  <DependencyTag instance={instance} allInstances={instances} />
                </div>

                <div className="dpp-play__assignee-row">
                  <AssigneePills assignees={instance.assignees} />
                  {canManage && instance.status === 'active' && (
                    <ReassignDropdown
                      instance={instance}
                      teamMembers={teamMembers}
                      dealId={deal.id}
                      onReassigned={fetchData}
                    />
                  )}
                </div>
              </div>

              {/* Right: actions */}
              <div className="dpp-play__actions">
                {canAct && instance.status === 'active' && (
                  <>
                    <button className="dpp-btn dpp-btn--complete" onClick={() => handleComplete(instance)} title="Mark complete">
                      ✓ Complete
                    </button>
                    {canManage && (
                      <button className="dpp-btn dpp-btn--skip" onClick={() => handleSkip(instance)} title="Skip this play">
                        Skip
                      </button>
                    )}
                  </>
                )}
                {instance.status === 'completed' && (
                  <span className="dpp-play__done-label">✓ Done</span>
                )}
                {instance.status === 'skipped' && (
                  <span className="dpp-play__skipped-label">Skipped</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer: activate button if plays exist but might have new ones */}
      {total > 0 && canManage && (
        <div className="dpp-footer">
          <button className="dpp-btn dpp-btn--subtle" onClick={handleActivate} title="Re-sync plays from playbook">
            🔄 Sync from Playbook
          </button>
        </div>
      )}
    </div>
  );
}
