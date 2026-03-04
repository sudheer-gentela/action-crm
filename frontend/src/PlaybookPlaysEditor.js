import React, { useState, useEffect, useCallback } from 'react';
import './PlaybookPlaysEditor.css';

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

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNELS = [
  { value: '',              label: 'None' },
  { value: 'email',         label: '✉️ Email' },
  { value: 'call',          label: '📞 Call' },
  { value: 'meeting',       label: '🤝 Meeting' },
  { value: 'document',      label: '📄 Document' },
  { value: 'internal_task', label: '🏠 Internal Task' },
];

const PRIORITIES = ['high', 'medium', 'low'];

// ── PlayForm (create/edit) ──────────────────────────────────────────────────

function PlayForm({ play, roles, allPlays, onSave, onCancel, saving }) {
  const [title, setTitle]             = useState(play?.title || '');
  const [description, setDescription] = useState(play?.description || '');
  const [channel, setChannel]         = useState(play?.channel || '');
  const [priority, setPriority]       = useState(play?.priority || 'medium');
  const [executionType, setExecutionType] = useState(play?.execution_type || 'parallel');
  const [isGate, setIsGate]           = useState(play?.is_gate || false);
  const [dueOffsetDays, setDueOffsetDays] = useState(play?.due_offset_days ?? 3);
  const [selectedRoles, setSelectedRoles] = useState(
    (play?.roles || []).filter(r => r.ownership_type === 'co_owner').map(r => r.role_id)
  );
  const [dependsOn, setDependsOn]     = useState(play?.depends_on || []);

  function toggleRole(roleId) {
    setSelectedRoles(prev =>
      prev.includes(roleId) ? prev.filter(id => id !== roleId) : [...prev, roleId]
    );
  }

  function toggleDep(playId) {
    setDependsOn(prev =>
      prev.includes(playId) ? prev.filter(id => id !== playId) : [...prev, playId]
    );
  }

  function handleSubmit() {
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      description: description.trim() || null,
      channel: channel || null,
      priority,
      executionType,
      isGate,
      dueOffsetDays: parseInt(dueOffsetDays) || 3,
      roleIds: selectedRoles,
      dependsOn: executionType === 'sequential' ? dependsOn : null,
    });
  }

  // Other plays for dependency selection (exclude self)
  const otherPlays = allPlays.filter(p => p.id !== play?.id);

  return (
    <div className="ppe-form">
      <div className="ppe-form__group">
        <label>Title <span className="ppe-required">*</span></label>
        <input
          className="ppe-input"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="e.g., Schedule discovery call"
          autoFocus
        />
      </div>

      <div className="ppe-form__group">
        <label>Description</label>
        <textarea
          className="ppe-textarea"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Detailed guidance for this play…"
          rows={2}
        />
      </div>

      <div className="ppe-form__row">
        <div className="ppe-form__group ppe-form__group--sm">
          <label>Channel</label>
          <select className="ppe-select" value={channel} onChange={e => setChannel(e.target.value)}>
            {CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>

        <div className="ppe-form__group ppe-form__group--sm">
          <label>Priority</label>
          <select className="ppe-select" value={priority} onChange={e => setPriority(e.target.value)}>
            {PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
          </select>
        </div>

        <div className="ppe-form__group ppe-form__group--sm">
          <label>Due (days after stage entry)</label>
          <input
            className="ppe-input"
            type="number"
            min="1"
            max="90"
            value={dueOffsetDays}
            onChange={e => setDueOffsetDays(e.target.value)}
          />
        </div>
      </div>

      <div className="ppe-form__row">
        <div className="ppe-form__group ppe-form__group--sm">
          <label>Execution</label>
          <select className="ppe-select" value={executionType} onChange={e => setExecutionType(e.target.value)}>
            <option value="parallel">⚡ Parallel — starts immediately</option>
            <option value="sequential">🔗 Sequential — waits for dependencies</option>
          </select>
        </div>

        <div className="ppe-form__group ppe-form__group--sm">
          <label className="ppe-checkbox-label">
            <input type="checkbox" checked={isGate} onChange={e => setIsGate(e.target.checked)} />
            🚧 Gate — must complete to advance stage
          </label>
        </div>
      </div>

      {executionType === 'sequential' && otherPlays.length > 0 && (
        <div className="ppe-form__group">
          <label>Depends on (must complete before this play starts)</label>
          <div className="ppe-dep-list">
            {otherPlays.map(p => (
              <label key={p.id} className={`ppe-dep-chip ${dependsOn.includes(p.id) ? 'ppe-dep-chip--selected' : ''}`}>
                <input type="checkbox" checked={dependsOn.includes(p.id)} onChange={() => toggleDep(p.id)} />
                {p.title.length > 40 ? p.title.slice(0, 40) + '…' : p.title}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="ppe-form__group">
        <label>Role Co-Owners</label>
        <div className="ppe-role-grid">
          {roles.map(role => (
            <label
              key={role.id}
              className={`ppe-role-chip ${selectedRoles.includes(role.id) ? 'ppe-role-chip--selected' : ''}`}
            >
              <input type="checkbox" checked={selectedRoles.includes(role.id)} onChange={() => toggleRole(role.id)} />
              {role.name}
            </label>
          ))}
        </div>
        {selectedRoles.length === 0 && (
          <div className="ppe-form__hint">Select at least one role to own this play</div>
        )}
      </div>

      <div className="ppe-form__actions">
        <button className="ppe-btn ppe-btn--primary" onClick={handleSubmit} disabled={saving || !title.trim()}>
          {saving ? 'Saving…' : (play ? 'Update Play' : 'Create Play')}
        </button>
        <button className="ppe-btn ppe-btn--secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Play Card (read-only view) ──────────────────────────────────────────────

function PlayCard({ play, index, canEdit, onEdit, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const roles = (play.roles || []).filter(r => r.ownership_type === 'co_owner');

  async function handleDelete() {
    if (!window.confirm(`Delete "${play.title}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await onDelete(play.id);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={`ppe-card ${play.is_gate ? 'ppe-card--gate' : ''} ${!play.is_active ? 'ppe-card--inactive' : ''}`}>
      <div className="ppe-card__order">{index + 1}</div>

      <div className="ppe-card__body">
        <div className="ppe-card__title-row">
          {play.channel && <span className="ppe-card__channel">{CHANNELS.find(c => c.value === play.channel)?.label.split(' ')[0] || '📋'}</span>}
          <span className="ppe-card__title">{play.title}</span>
          {play.is_gate && <span className="ppe-card__gate-badge">🚧 GATE</span>}
          <span className={`ppe-card__exec-badge ppe-card__exec-badge--${play.execution_type}`}>
            {play.execution_type === 'sequential' ? '🔗 sequential' : '⚡ parallel'}
          </span>
        </div>

        {play.description && (
          <div className="ppe-card__desc">{play.description}</div>
        )}

        <div className="ppe-card__meta">
          <span className="ppe-card__priority" data-priority={play.priority}>{play.priority}</span>
          <span className="ppe-card__due">+{play.due_offset_days}d</span>
          {play.depends_on && play.depends_on.length > 0 && (
            <span className="ppe-card__deps">depends on {play.depends_on.length} play{play.depends_on.length !== 1 ? 's' : ''}</span>
          )}
        </div>

        {roles.length > 0 && (
          <div className="ppe-card__roles">
            {roles.map((r, i) => (
              <span key={r.role_id || i} className="ppe-card__role-pill">{r.role_name}</span>
            ))}
          </div>
        )}
      </div>

      {canEdit && (
        <div className="ppe-card__actions">
          <button className="ppe-btn ppe-btn--icon" onClick={() => onEdit(play)} title="Edit">✏️</button>
          <button className="ppe-btn ppe-btn--icon ppe-btn--danger" onClick={handleDelete} disabled={deleting} title="Delete">
            {deleting ? '…' : '🗑️'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Roles Config Panel ──────────────────────────────────────────────────────

function RolesConfigPanel({ allOrgRoles, currentRoleIds, rolesSource, onSave, onCancel, saving }) {
  const [selected, setSelected] = useState(
    currentRoleIds.length > 0 ? new Set(currentRoleIds) : new Set()
  );
  const isUsingDefaults = rolesSource === 'org_default' && selected.size === 0;

  function toggle(roleId) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(allOrgRoles.map(r => r.id)));
  }

  function clearAll() {
    setSelected(new Set());
  }

  return (
    <div className="ppe-roles-config">
      <div className="ppe-roles-config__header">
        <span className="ppe-roles-config__title">Configure Playbook Roles</span>
        <span className="ppe-roles-config__hint">
          {isUsingDefaults
            ? 'Currently using all org roles. Select specific roles to customize this playbook.'
            : `${selected.size} role${selected.size !== 1 ? 's' : ''} selected. Clear all to revert to org defaults.`}
        </span>
      </div>

      <div className="ppe-roles-config__grid">
        {allOrgRoles.map(role => (
          <label
            key={role.id}
            className={`ppe-role-chip ${selected.has(role.id) ? 'ppe-role-chip--selected' : ''}`}
          >
            <input type="checkbox" checked={selected.has(role.id)} onChange={() => toggle(role.id)} />
            {role.name}
            {role.is_system && <span className="ppe-roles-config__system">system</span>}
          </label>
        ))}
      </div>

      <div className="ppe-roles-config__actions">
        <button className="ppe-btn ppe-btn--primary" onClick={() => onSave([...selected])} disabled={saving}>
          {saving ? 'Saving…' : selected.size > 0 ? `Save ${selected.size} Roles` : 'Use All Org Roles'}
        </button>
        <button className="ppe-btn ppe-btn--secondary" onClick={onCancel}>Cancel</button>
        <div style={{ flex: 1 }} />
        <button className="ppe-btn ppe-btn--tiny-text" onClick={selectAll}>Select All</button>
        <button className="ppe-btn ppe-btn--tiny-text" onClick={clearAll}>Clear All</button>
      </div>
    </div>
  );
}

// ── Main: PlaybookPlaysEditor ───────────────────────────────────────────────

export default function PlaybookPlaysEditor({ playbookId }) {
  const [stages, setStages]         = useState([]);
  const [playsByStage, setPlaysByStage] = useState({});
  const [roles, setRoles]           = useState([]);         // roles available for this playbook
  const [allOrgRoles, setAllOrgRoles] = useState([]);       // all org roles (for config)
  const [rolesSource, setRolesSource] = useState('org_default'); // 'playbook' or 'org_default'
  const [playbookType, setPlaybookType] = useState(null);   // 'sales' or 'prospecting'
  const [activeStage, setActiveStage] = useState('');
  const [editingPlay, setEditingPlay] = useState(null);   // null | 'new' | play object
  const [filterRole, setFilterRole]   = useState('all');
  const [showRolesConfig, setShowRolesConfig] = useState(false);
  const [savingRoles, setSavingRoles] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = currentUser.orgRole === 'admin' || currentUser.orgRole === 'owner';

  const fetchData = useCallback(async () => {
    if (!playbookId) return;
    try {
      // First get playbook info to determine type
      const pbRes = await apiFetch(`/playbooks/${playbookId}`);
      const pb = pbRes.playbook || pbRes;
      const isProspecting = pb.type === 'prospecting';
      setPlaybookType(isProspecting ? 'prospecting' : 'sales');

      // Fetch plays, playbook-specific roles, all org roles, and correct stages in parallel
      const [playsRes, pbRolesRes, allRolesRes, stagesRes] = await Promise.all([
        apiFetch(`/playbook-plays/playbook/${playbookId}/all`),
        apiFetch(`/playbook-plays/playbook/${playbookId}/roles`),
        apiFetch('/org-roles'),
        isProspecting
          ? apiFetch('/prospect-stages')
          : apiFetch('/deal-stages'),
      ]);

      const allStages = (stagesRes.stages || []).filter(s => s.is_active && !s.is_terminal);
      setStages(allStages);
      setPlaysByStage(playsRes.plays || {});

      // Roles: use playbook-specific if configured, else all org roles
      const pbRoles = pbRolesRes.roles || [];
      const orgRoles = (allRolesRes.roles || []).filter(r => r.is_active);
      setAllOrgRoles(orgRoles);
      setRoles(pbRoles.length > 0 ? pbRoles : orgRoles);
      setRolesSource(pbRolesRes.source || 'org_default');

      if (!activeStage && allStages.length > 0) {
        setActiveStage(allStages[0].key);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [playbookId, activeStage]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const currentPlays = playsByStage[activeStage] || [];

  // ── Role filter ────────────────────────────────────────────────────────────
  const filteredPlays = filterRole === 'all'
    ? currentPlays
    : currentPlays.filter(p =>
        (p.roles || []).some(r => String(r.role_id) === String(filterRole))
      );

  // Collect unique roles across ALL plays in the active stage for the dropdown
  const stageRoles = [];
  const seenRoleIds = new Set();
  for (const p of currentPlays) {
    for (const r of (p.roles || [])) {
      if (r.role_id && !seenRoleIds.has(r.role_id)) {
        seenRoleIds.add(r.role_id);
        stageRoles.push({ id: r.role_id, name: r.role_name, key: r.role_key });
      }
    }
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async function handleSavePlay(data) {
    setSaving(true);
    setError('');
    try {
      if (editingPlay && editingPlay !== 'new') {
        // Update
        await apiFetch(`/playbook-plays/${editingPlay.id}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        });
        // Update roles separately
        await apiFetch(`/playbook-plays/${editingPlay.id}/roles`, {
          method: 'PUT',
          body: JSON.stringify({ roles: data.roleIds.map(id => ({ roleId: id, ownershipType: 'co_owner' })) }),
        });
      } else {
        // Create
        await apiFetch('/playbook-plays', {
          method: 'POST',
          body: JSON.stringify({ playbookId, stageKey: activeStage, ...data }),
        });
      }
      setEditingPlay(null);
      fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeletePlay(playId) {
    try {
      await apiFetch(`/playbook-plays/${playId}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  }

  // ── Save playbook roles config ─────────────────────────────────────────────

  async function handleSavePlaybookRoles(selectedRoleIds) {
    setSavingRoles(true);
    setError('');
    try {
      const res = await apiFetch(`/playbook-plays/playbook/${playbookId}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roleIds: selectedRoleIds }),
      });
      const newRoles = res.roles || [];
      setRoles(newRoles.length > 0 ? newRoles : allOrgRoles);
      setRolesSource(res.source || (newRoles.length > 0 ? 'playbook' : 'org_default'));
      setShowRolesConfig(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingRoles(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="ppe-loading">Loading playbook plays…</div>;
  }

  const stageNoun = playbookType === 'prospecting' ? 'prospect stage' : 'deal stage';

  return (
    <div className="ppe-root">
      <div className="ppe-header">
        <div>
          <h3 className="ppe-header__title">Plays by Stage</h3>
          <p className="ppe-header__subtitle">
            Define the plays each role executes at every {stageNoun}.
            {!isAdmin && ' You can view plays but only admins can edit.'}
          </p>
        </div>
        {isAdmin && (
          <button
            className={`ppe-btn ${showRolesConfig ? 'ppe-btn--secondary' : 'ppe-btn--roles'}`}
            onClick={() => setShowRolesConfig(v => !v)}
          >
            {showRolesConfig ? 'Close' : `⚙ Roles (${roles.length})`}
          </button>
        )}
      </div>

      {/* Roles config panel */}
      {showRolesConfig && isAdmin && (
        <RolesConfigPanel
          allOrgRoles={allOrgRoles}
          currentRoleIds={rolesSource === 'playbook' ? roles.map(r => r.id) : []}
          rolesSource={rolesSource}
          onSave={handleSavePlaybookRoles}
          onCancel={() => setShowRolesConfig(false)}
          saving={savingRoles}
        />
      )}

      {error && <div className="ppe-error">{error} <button onClick={() => setError('')}>✕</button></div>}

      {/* Stage tabs */}
      <div className="ppe-stage-tabs">
        {stages.map(stage => {
          const count = (playsByStage[stage.key] || []).length;
          const gateCount = (playsByStage[stage.key] || []).filter(p => p.is_gate).length;
          return (
            <button
              key={stage.key}
              className={`ppe-stage-tab ${activeStage === stage.key ? 'ppe-stage-tab--active' : ''}`}
              onClick={() => { setActiveStage(stage.key); setEditingPlay(null); setFilterRole('all'); }}
            >
              {stage.name}
              {count > 0 && (
                <span className="ppe-stage-tab__count">
                  {count}{gateCount > 0 ? ` · ${gateCount}🚧` : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Plays for active stage */}
      <div className="ppe-stage-content">
        {activeStage && (
          <>
            <div className="ppe-stage-content__header">
              <span className="ppe-stage-content__label">
                {filterRole === 'all'
                  ? `${currentPlays.length} play${currentPlays.length !== 1 ? 's' : ''} in ${stages.find(s => s.key === activeStage)?.name || activeStage}`
                  : `${filteredPlays.length} of ${currentPlays.length} plays for ${stageRoles.find(r => String(r.id) === String(filterRole))?.name || 'role'}`
                }
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {stageRoles.length > 1 && (
                  <select
                    className="ppe-select"
                    style={{ width: 'auto', minWidth: 160, fontSize: 12, padding: '5px 10px' }}
                    value={filterRole}
                    onChange={e => setFilterRole(e.target.value)}
                  >
                    <option value="all">All Roles ({currentPlays.length})</option>
                    {stageRoles.map(r => {
                      const count = currentPlays.filter(p => (p.roles || []).some(pr => String(pr.role_id) === String(r.id))).length;
                      return <option key={r.id} value={r.id}>{r.name} ({count})</option>;
                    })}
                  </select>
                )}
                {isAdmin && !editingPlay && (
                  <button className="ppe-btn ppe-btn--primary" onClick={() => setEditingPlay('new')}>
                    + Add Play
                  </button>
                )}
              </div>
            </div>

            {/* Play cards */}
            {filteredPlays.length === 0 && !editingPlay && (
              <div className="ppe-empty">
                {filterRole === 'all'
                  ? <>No plays defined for this stage.{isAdmin && ' Click "+ Add Play" to create one.'}</>
                  : <>No plays assigned to {stageRoles.find(r => String(r.id) === String(filterRole))?.name || 'this role'} in this stage.</>
                }
              </div>
            )}

            <div className="ppe-cards">
              {filteredPlays.map((play, idx) => (
                <PlayCard
                  key={play.id}
                  play={play}
                  index={idx}
                  canEdit={isAdmin}
                  onEdit={p => setEditingPlay(p)}
                  onDelete={handleDeletePlay}
                />
              ))}
            </div>

            {/* Create/Edit form */}
            {editingPlay && (
              <PlayForm
                play={editingPlay === 'new' ? null : editingPlay}
                roles={roles}
                allPlays={currentPlays}
                onSave={handleSavePlay}
                onCancel={() => setEditingPlay(null)}
                saving={saving}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
