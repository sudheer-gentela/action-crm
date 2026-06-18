/* Extracted from OrgAdminView.js — Phase 2 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OADealRoles. Includes co-located single-consumer constants/helpers. */
import React from 'react';
import { apiFetchOA } from '../helpers';

async function oaRolesApi(path, options) {
  try { return await apiFetchOA(`/org-roles${path}`, options); }
  catch { return await apiFetchOA(`/deal-roles${path}`, options); }
}

export default function OADealRoles() {
  const [roles,    setRoles]    = React.useState([]);
  const [loading,  setLoading]  = React.useState(true);
  const [error,    setError]    = React.useState('');
  const [success,  setSuccess]  = React.useState('');
  const [newName,  setNewName]  = React.useState('');
  const [adding,   setAdding]   = React.useState(false);
  const [editId,   setEditId]   = React.useState(null);
  const [editName, setEditName] = React.useState('');

  React.useEffect(() => {
    oaRolesApi('')
      .then(r => setRoles(r.roles || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  async function handleToggle(role) {
    try {
      const r = await oaRolesApi(`/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !role.is_active }),
      });
      setRoles(prev => prev.map(ro => ro.id === role.id ? r.role : ro));
      flash('success', `${role.name} ${r.role.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleRename(role) {
    if (!editName.trim() || editName.trim() === role.name) { setEditId(null); return; }
    try {
      const r = await oaRolesApi(`/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editName.trim() }),
      });
      setRoles(prev => prev.map(ro => ro.id === role.id ? r.role : ro));
      setEditId(null);
      flash('success', 'Role renamed');
    } catch (e) { flash('error', e.message); }
  }

  async function handleDelete(role) {
    if (!window.confirm(`Delete "${role.name}"? Team members with this role will have it cleared.`)) return;
    try {
      await oaRolesApi(`/${role.id}`, { method: 'DELETE' });
      setRoles(prev => prev.filter(ro => ro.id !== role.id));
      flash('success', 'Role deleted');
    } catch (e) { flash('error', e.message); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const r = await oaRolesApi('', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      setRoles(prev => [...prev, r.role]);
      setNewName('');
      flash('success', 'Role created');
    } catch (e) { flash('error', e.message); }
    finally { setAdding(false); }
  }

  if (loading) return <div className="sv-loading">Loading roles…</div>;

  const systemRoles = roles.filter(r => r.is_system);
  const customRoles = roles.filter(r => !r.is_system);

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🎭 Organization Roles</h2>
          <p className="sv-panel-desc">
            Roles are used across your entire organization — in deal teams, prospecting playbooks,
            and any future workflows. Each playbook selects which roles are relevant via its ⚙ Roles config.
            System roles can be activated or deactivated. Custom roles can be renamed or deleted.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <div className="sv-panel-body">

        {/* System roles */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>System Roles</h3>
            <p className="sv-hint">Built-in roles used across deals and prospecting. Toggle to hide from role pickers — cannot be renamed or deleted.</p>
            <div className="oa-roles-list">
              {systemRoles.map(role => (
                <div key={role.id} className={`oa-role-row ${!role.is_active ? 'oa-role-row--inactive' : ''}`}>
                  <div className="oa-role-row__info">
                    <span className="oa-role-row__name">{role.name}</span>
                    {!role.is_active && <span className="oa-role-row__tag">Inactive</span>}
                  </div>
                  <button
                    className={`sv-btn-sm ${role.is_active ? 'sv-btn-sm--danger' : 'sv-btn-sm--primary'}`}
                    onClick={() => handleToggle(role)}
                  >
                    {role.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Custom roles */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>Custom Roles</h3>
            <p className="sv-hint">Create roles specific to your organisation's workflows. Click a name to rename it.</p>

            {customRoles.length === 0 && (
              <p className="sv-empty">No custom roles yet. Add one below.</p>
            )}

            <div className="oa-roles-list">
              {customRoles.map(role => (
                <div key={role.id} className="oa-role-row">
                  <div className="oa-role-row__info">
                    {editId === role.id ? (
                      <input
                        className="oa-input oa-input--inline"
                        value={editName}
                        autoFocus
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter')  handleRename(role);
                          if (e.key === 'Escape') setEditId(null);
                        }}
                        onBlur={() => handleRename(role)}
                      />
                    ) : (
                      <span
                        className="oa-role-row__name oa-role-row__name--editable"
                        onClick={() => { setEditId(role.id); setEditName(role.name); }}
                        title="Click to rename"
                      >
                        {role.name} ✏️
                      </span>
                    )}
                  </div>
                  <button
                    className="sv-btn-sm sv-btn-sm--danger"
                    onClick={() => handleDelete(role)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>

            {/* Add new custom role */}
            <div className="oa-role-add-row">
              <input
                className="oa-input"
                placeholder="New role name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
              <button
                className="sv-btn-primary"
                onClick={handleAdd}
                disabled={adding || !newName.trim()}
              >
                {adding ? '…' : '+ Add Role'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
