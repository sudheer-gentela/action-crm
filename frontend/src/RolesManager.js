import React, { useState, useEffect, useCallback } from 'react';
import './RolesManager.css';

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

// Helper: try /org-roles, fall back to /deal-roles for backward compat
async function rolesApi(path, options) {
  try {
    return await apiFetch(`/org-roles${path}`, options);
  } catch {
    return await apiFetch(`/deal-roles${path}`, options);
  }
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function RolesManager() {
  const [roles, setRoles]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editingId, setEditingId]   = useState(null);
  const [editName, setEditName]     = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  const [creating, setCreating]     = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else { setError(msg); setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3000);
  };

  const fetchRoles = useCallback(async () => {
    try {
      const res = await rolesApi('/all');
      setRoles(res.roles || []);
    } catch {
      try {
        const res = await rolesApi('');
        setRoles(res.roles || []);
      } catch (e) {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRoles(); }, [fetchRoles]);

  // ── Create ─────────────────────────────────────────────────────────────────

  async function handleCreate() {
    if (!newRoleName.trim()) { flash('error', 'Role name is required'); return; }
    setCreating(true);
    try {
      await rolesApi('', {
        method: 'POST',
        body: JSON.stringify({ name: newRoleName.trim() }),
      });
      setNewRoleName('');
      setShowAddForm(false);
      flash('success', 'Role created');
      fetchRoles();
    } catch (err) {
      flash('error', err.message);
    } finally {
      setCreating(false);
    }
  }

  // ── Rename ─────────────────────────────────────────────────────────────────

  async function handleRename(roleId) {
    if (!editName.trim()) return;
    try {
      await rolesApi(`/${roleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editName.trim() }),
      });
      setEditingId(null);
      flash('success', 'Role renamed');
      fetchRoles();
    } catch (err) {
      flash('error', err.message);
    }
  }

  // ── Toggle active ─────────────────────────────────────────────────────────

  async function handleToggleActive(role) {
    try {
      await rolesApi(`/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !role.is_active }),
      });
      flash('success', role.is_active ? 'Role deactivated' : 'Role reactivated');
      fetchRoles();
    } catch (err) {
      flash('error', err.message);
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function handleDelete(role) {
    const msg = role.is_system
      ? `"${role.name}" is a system role. It will be deactivated, not deleted. Continue?`
      : `Delete "${role.name}"? If it's in use, it will be deactivated instead.`;
    if (!window.confirm(msg)) return;
    try {
      const res = await rolesApi(`/${role.id}`, { method: 'DELETE' });
      if (res.soft_deleted) {
        flash('success', res.message);
      } else {
        flash('success', 'Role deleted');
      }
      fetchRoles();
    } catch (err) {
      flash('error', err.message);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const activeRoles = roles.filter(r => r.is_active);
  const inactiveRoles = roles.filter(r => !r.is_active);
  const displayRoles = showInactive ? roles : activeRoles;

  if (loading) {
    return <div className="rm-loading">Loading roles...</div>;
  }

  return (
    <div className="rm-root">
      <div className="rm-header">
        <div>
          <h3 className="rm-title">Organization Roles</h3>
          <p className="rm-subtitle">
            Roles define who does what across your organization. They are used in deal teams,
            prospecting playbooks, and any future workflows. Each playbook selects which roles
            are relevant to it.
            {' '}{activeRoles.length} active{inactiveRoles.length > 0 ? `, ${inactiveRoles.length} inactive` : ''}.
          </p>
        </div>
        <div className="rm-header__actions">
          {inactiveRoles.length > 0 && (
            <label className="rm-toggle-label">
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
          )}
          <button className="rm-btn rm-btn--primary" onClick={() => setShowAddForm(v => !v)}>
            {showAddForm ? 'Cancel' : '+ New Role'}
          </button>
        </div>
      </div>

      {error && <div className="rm-alert rm-alert--error">{error}</div>}
      {success && <div className="rm-alert rm-alert--success">{success}</div>}

      {/* Add form */}
      {showAddForm && (
        <div className="rm-add-form">
          <input
            className="rm-input"
            placeholder="Role name, e.g. Product Specialist"
            value={newRoleName}
            onChange={e => setNewRoleName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowAddForm(false); }}
            autoFocus
          />
          <button className="rm-btn rm-btn--primary" onClick={handleCreate} disabled={creating || !newRoleName.trim()}>
            {creating ? 'Creating...' : 'Create'}
          </button>
          <span className="rm-add-form__hint">
            Key will be auto-generated from the name (e.g. "Product Specialist" → product_specialist)
          </span>
        </div>
      )}

      {/* Roles list */}
      <div className="rm-list">
        {displayRoles.map((role, idx) => {
          const isEditing = editingId === role.id;
          const memberCount = parseInt(role.member_count || 0);
          const playCount = parseInt(role.play_count || 0);
          const playbookCount = parseInt(role.playbook_count || 0);
          const isInUse = memberCount > 0 || playCount > 0 || playbookCount > 0;

          return (
            <div key={role.id} className={`rm-role ${!role.is_active ? 'rm-role--inactive' : ''}`}>
              <div className="rm-role__order">{idx + 1}</div>

              <div className="rm-role__body">
                {isEditing ? (
                  <div className="rm-role__edit-row">
                    <input
                      className="rm-input rm-input--inline"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRename(role.id); if (e.key === 'Escape') setEditingId(null); }}
                      autoFocus
                    />
                    <button className="rm-btn rm-btn--sm rm-btn--primary" onClick={() => handleRename(role.id)}>Save</button>
                    <button className="rm-btn rm-btn--sm" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="rm-role__info">
                    <span className="rm-role__name">{role.name}</span>
                    <span className="rm-role__key">{role.key}</span>
                    {role.is_system && <span className="rm-role__badge rm-role__badge--system">system</span>}
                    {!role.is_active && <span className="rm-role__badge rm-role__badge--inactive">inactive</span>}
                  </div>
                )}

                <div className="rm-role__meta">
                  {playbookCount > 0 && (
                    <span className="rm-role__usage rm-role__usage--playbook">
                      {playbookCount} playbook{playbookCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {playCount > 0 && (
                    <span className="rm-role__usage">
                      {playCount} play{playCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {memberCount > 0 && (
                    <span className="rm-role__usage">
                      {memberCount} team member{memberCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {!isInUse && role.is_active && (
                    <span className="rm-role__usage rm-role__usage--unused">not assigned to any playbook</span>
                  )}
                </div>
              </div>

              <div className="rm-role__actions">
                {!isEditing && (
                  <>
                    <button
                      className="rm-btn rm-btn--icon"
                      onClick={() => { setEditingId(role.id); setEditName(role.name); }}
                      title="Rename"
                    >✏️</button>
                    {role.is_active ? (
                      <button
                        className="rm-btn rm-btn--icon"
                        onClick={() => handleToggleActive(role)}
                        title="Deactivate"
                      >⏸️</button>
                    ) : (
                      <button
                        className="rm-btn rm-btn--icon"
                        onClick={() => handleToggleActive(role)}
                        title="Reactivate"
                      >▶️</button>
                    )}
                    {!role.is_system && (
                      <button
                        className="rm-btn rm-btn--icon rm-btn--danger"
                        onClick={() => handleDelete(role)}
                        title="Delete"
                      >🗑️</button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {displayRoles.length === 0 && (
        <div className="rm-empty">No roles found. Create one to get started.</div>
      )}
    </div>
  );
}
