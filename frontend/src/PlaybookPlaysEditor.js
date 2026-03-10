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
  const [unlocksPlayId, setUnlocksPlayId] = useState(play?.unlocks_play_id || null);
  const [dueOffsetDays, setDueOffsetDays] = useState(play?.due_offset_days ?? 3);
  const [selectedRoles, setSelectedRoles] = useState(
    (play?.roles || []).filter(r => r.ownership_type === 'co_owner').map(r => r.role_id)
  );
  const [dependsOn, setDependsOn]     = useState(play?.depends_on || []);
  const [fireConditions, setFireConditions] = useState(
    Array.isArray(play?.fire_conditions) ? play.fire_conditions : []
  );

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
      unlocksPlayId: isGate ? (unlocksPlayId || null) : null,
      dueOffsetDays: parseInt(dueOffsetDays) || 3,
      roleIds: selectedRoles,
      dependsOn: executionType === 'sequential' ? dependsOn : null,
      fireConditions,
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

      {/* Unlocks play — only visible when this play is marked as a gate */}
      {isGate && (
        <div className="ppe-form__group">
          <label>🔓 Unlocks play when completed</label>
          <select
            className="ppe-select"
            value={unlocksPlayId || ''}
            onChange={e => setUnlocksPlayId(e.target.value ? parseInt(e.target.value) : null)}
          >
            <option value="">— No unlock (gate only, no auto-next) —</option>
            {otherPlays.map(p => (
              <option key={p.id} value={p.id}>
                {p.title.length > 55 ? p.title.slice(0, 55) + '…' : p.title}
              </option>
            ))}
          </select>
          <div className="ppe-form__hint">
            When a rep completes this gate action, the selected play will be automatically generated as their next action.
          </div>
        </div>
      )}

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

      {/* Fire Conditions — controls when this play generates an action */}
      <FireConditionsBuilder
        conditions={fireConditions}
        onChange={setFireConditions}
      />

      <div className="ppe-form__actions">
        <button className="ppe-btn ppe-btn--primary" onClick={handleSubmit} disabled={saving || !title.trim()}>
          {saving ? 'Saving…' : (play ? 'Update Play' : 'Create Play')}
        </button>
        <button className="ppe-btn ppe-btn--secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── FireConditionsBuilder ─────────────────────────────────────────────────────
//
// Lets admins attach fire conditions to a play.
// Each condition is evaluated at action-generation time against deal context.
// Empty conditions = fire unconditionally (safe default).

const CONDITION_TYPES = [
  { value: 'no_meeting_this_stage',  label: '📅 No meeting yet this stage',        params: [] },
  { value: 'meeting_not_scheduled',  label: '📅 No meeting currently scheduled',   params: [] },
  { value: 'no_email_since_meeting', label: '✉️ No follow-up email after meeting', params: [] },
  { value: 'no_contact_role',        label: '👤 Missing contact role',             params: ['role'] },
  { value: 'no_file_matching',       label: '📄 No file matching pattern',         params: ['pattern'] },
  { value: 'days_in_stage',          label: '⏱ Days in stage',                    params: ['operator', 'value'] },
  { value: 'days_until_close',       label: '📆 Days until close date',            params: ['operator', 'value'] },
  { value: 'health_param_state',     label: '❤️ Health parameter state',           params: ['param', 'state'] },
];

const CONTACT_ROLES = [
  { value: 'decision_maker', label: 'Decision Maker' },
  { value: 'champion',       label: 'Champion' },
  { value: 'executive',      label: 'Executive' },
  { value: 'influencer',     label: 'Influencer' },
];

const OPERATORS = [
  { value: '>',  label: 'more than' },
  { value: '>=', label: 'at least' },
  { value: '<',  label: 'less than' },
  { value: '<=', label: 'at most' },
];

const HEALTH_PARAMS = [
  { value: '1a', label: '1a — Close date credibility' },
  { value: '1b', label: '1b — Close date slippage' },
  { value: '1c', label: '1c — Urgency driver' },
  { value: '2a', label: '2a — Economic buyer' },
  { value: '2b', label: '2b — Executive engagement' },
  { value: '2c', label: '2c — Stakeholder coverage' },
  { value: '3a', label: '3a — Legal / procurement' },
  { value: '3b', label: '3b — Security / IT review' },
  { value: '4a', label: '4a — Deal size' },
  { value: '4c', label: '4c — Scope sign-off' },
  { value: '5a', label: '5a — Competitive' },
  { value: '5b', label: '5b — Price sensitivity' },
  { value: '5c', label: '5c — Discount approval' },
  { value: '6a', label: '6a — Meeting cadence' },
  { value: '6b', label: '6b — Response time' },
];

const HEALTH_STATES = [
  { value: 'absent',    label: 'Absent' },
  { value: 'unknown',   label: 'Unknown' },
  { value: 'confirmed', label: 'Confirmed' },
];

function FireConditionsBuilder({ conditions, onChange }) {
  function addCondition() {
    onChange([...conditions, { type: 'no_meeting_this_stage' }]);
  }

  function removeCondition(idx) {
    onChange(conditions.filter((_, i) => i !== idx));
  }

  function updateCondition(idx, updates) {
    onChange(conditions.map((c, i) => i === idx ? { ...c, ...updates } : c));
  }

  const condMeta = (type) => CONDITION_TYPES.find(ct => ct.value === type) || CONDITION_TYPES[0];

  return (
    <div className="ppe-conditions">
      <div className="ppe-conditions__header">
        <label className="ppe-conditions__title">
          🎯 Fire Conditions
          <span className="ppe-conditions__hint">
            {conditions.length === 0
              ? ' — fires unconditionally'
              : ` — fires only when ALL ${conditions.length} condition${conditions.length > 1 ? 's' : ''} pass`}
          </span>
        </label>
        <button
          type="button"
          className="ppe-btn ppe-btn--sm ppe-btn--secondary"
          onClick={addCondition}
        >
          + Add Condition
        </button>
      </div>

      {conditions.length === 0 && (
        <p className="ppe-conditions__empty">
          No conditions set — this play will generate an action for every deal in this stage.
          Add conditions to make it context-aware.
        </p>
      )}

      {conditions.map((cond, idx) => {
        const meta = condMeta(cond.type);
        return (
          <div key={idx} className="ppe-condition-row">
            <select
              className="ppe-select ppe-select--condition-type"
              value={cond.type}
              onChange={e => updateCondition(idx, { type: e.target.value })}
            >
              {CONDITION_TYPES.map(ct => (
                <option key={ct.value} value={ct.value}>{ct.label}</option>
              ))}
            </select>

            {/* role param */}
            {meta.params.includes('role') && (
              <select
                className="ppe-select ppe-select--sm"
                value={cond.role || 'decision_maker'}
                onChange={e => updateCondition(idx, { role: e.target.value })}
              >
                {CONTACT_ROLES.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            )}

            {/* pattern param */}
            {meta.params.includes('pattern') && (
              <input
                className="ppe-input ppe-input--sm"
                placeholder="e.g. proposal|quote|pricing"
                value={cond.pattern || ''}
                onChange={e => updateCondition(idx, { pattern: e.target.value })}
              />
            )}

            {/* operator + value params */}
            {meta.params.includes('operator') && (
              <>
                <select
                  className="ppe-select ppe-select--sm"
                  value={cond.operator || '>'}
                  onChange={e => updateCondition(idx, { operator: e.target.value })}
                >
                  {OPERATORS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <input
                  className="ppe-input ppe-input--xs"
                  type="number"
                  min="0"
                  max="365"
                  placeholder="days"
                  value={cond.value ?? ''}
                  onChange={e => updateCondition(idx, { value: parseInt(e.target.value) || 0 })}
                />
                <span className="ppe-condition-unit">days</span>
              </>
            )}

            {/* health param + state */}
            {meta.params.includes('param') && (
              <>
                <select
                  className="ppe-select ppe-select--sm"
                  value={cond.param || '2a'}
                  onChange={e => updateCondition(idx, { param: e.target.value })}
                >
                  {HEALTH_PARAMS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                <span className="ppe-condition-unit">is</span>
                <select
                  className="ppe-select ppe-select--sm"
                  value={cond.state || 'absent'}
                  onChange={e => updateCondition(idx, { state: e.target.value })}
                >
                  {HEALTH_STATES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </>
            )}

            <button
              type="button"
              className="ppe-condition-remove"
              onClick={() => removeCondition(idx)}
              title="Remove condition"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Play Card (read-only view) ──────────────────────────────────────────────

function PlayCard({ play, index, canEdit, onEdit, onDelete, allPlays = [] }) {
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
          {play.is_gate && (
            <span className="ppe-card__gate-badge">
              🚧 GATE
              {play.unlocks_play_id && (
                <span className="ppe-card__gate-unlocks">
                  {' → 🔓 '}
                  {allPlays?.find(p => p.id === play.unlocks_play_id)?.title?.slice(0, 30) || `Play #${play.unlocks_play_id}`}
                </span>
              )}
            </span>
          )}
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

export default function PlaybookPlaysEditor({ playbookId, readOnly = false }) {
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
  const userOrgRole = currentUser.org_role || currentUser.role || currentUser.orgRole || '';
  const activeNavRole = sessionStorage.getItem('activeRole') || '';
  const isAdmin = !readOnly && (userOrgRole === 'owner' || userOrgRole === 'admin'
    || activeNavRole === 'org-admin' || activeNavRole === 'super-admin');

  const fetchData = useCallback(async () => {
    if (!playbookId) return;
    try {
      // First get playbook info to determine type
      const pbRes = await apiFetch(`/playbooks/${playbookId}`);
      const pb = pbRes.playbook || pbRes;
      const isProspecting = pb.type === 'prospecting';
      const isCLM = pb.type === 'clm';
      const isSalesType = !pb.type || ['sales', 'custom', 'market', 'product'].includes(pb.type);
      setPlaybookType(pb.type || 'sales');

      // Determine stage source based on playbook type
      let stagesPromise;
      if (isProspecting) {
        stagesPromise = apiFetch('/prospect-stages');
      } else if (isCLM) {
        // CLM stages live in pipeline_stages with pipeline='clm'
        stagesPromise = apiFetch('/pipeline-stages/clm');
      } else if (isSalesType) {
        stagesPromise = apiFetch('/deal-stages');
      } else {
        // Custom pipeline type — try pipeline-stages, fall back to deal-stages
        stagesPromise = apiFetch(`/pipeline-stages/${pb.type}`).catch(() => apiFetch('/deal-stages'));
      }

      // Fetch plays, playbook-specific roles, and correct stages in parallel
      const [playsRes, pbRolesRes, stagesRes] = await Promise.all([
        apiFetch(`/playbook-plays/playbook/${playbookId}/all`),
        apiFetch(`/playbook-plays/playbook/${playbookId}/roles`),
        stagesPromise,
      ]);

      // Roles: try /org-roles first, fall back to /deal-roles for backward compat
      let allRolesRes;
      try {
        allRolesRes = await apiFetch('/org-roles');
      } catch {
        allRolesRes = await apiFetch('/deal-roles');
      }

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

  const stageNoun = playbookType === 'prospecting' ? 'prospect stage'
    : playbookType === 'clm' ? 'contract stage'
    : 'stage';

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
                  allPlays={Object.values(playsByStage).flat()}
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
