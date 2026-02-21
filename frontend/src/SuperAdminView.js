import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './SuperAdminView.css';

// ═══════════════════════════════════════════════════════════════════
// SUPER ADMIN VIEW — ActionCRM Platform Administration
// Only accessible to users in the super_admins table
// ═══════════════════════════════════════════════════════════════════

const SA_TABS = [
  { id: 'overview',   label: 'Overview',     icon: '📊' },
  { id: 'orgs',       label: 'Organisations', icon: '🏢' },
  { id: 'admins',     label: 'Super Admins',  icon: '🔐' },
  { id: 'audit',      label: 'Audit Log',     icon: '📋' },
];

export default function SuperAdminView() {
  const [tab, setTab] = useState('overview');

  return (
    <div className="sa-view">
      <div className="sa-header">
        <div className="sa-header-left">
          <div className="sa-badge">⚡ Super Admin</div>
          <h1>ActionCRM Platform</h1>
          <p className="sa-subtitle">Platform-level administration — changes affect all organisations</p>
        </div>
      </div>

      <div className="sa-tabs">
        {SA_TABS.map(t => (
          <button
            key={t.id}
            className={`sa-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      <div className="sa-body">
        {tab === 'overview' && <SAOverview />}
        {tab === 'orgs'     && <SAOrgs />}
        {tab === 'admins'   && <SAAdmins />}
        {tab === 'audit'    && <SAAuditLog />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// OVERVIEW — key platform metrics
// ─────────────────────────────────────────────────────────────────

function SAOverview() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiService.superAdmin.getStats()
      .then(r => setStats(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Loading platform stats...</div>;
  if (!stats)  return null;

  const cards = [
    { label: 'Total Orgs',        value: stats.orgs.total_orgs,       sub: `${stats.orgs.new_orgs_30d} new this month`,   icon: '🏢', color: 'blue' },
    { label: 'Active Orgs',       value: stats.orgs.active_orgs,      sub: `${stats.orgs.suspended_orgs} suspended`,      icon: '✅', color: 'green' },
    { label: 'Trial Orgs',        value: stats.orgs.trial_orgs,       sub: 'need conversion',                             icon: '⏰', color: 'amber' },
    { label: 'Total Users',       value: stats.users.total_users,     sub: `${stats.users.active_users} active`,          icon: '👥', color: 'purple' },
    { label: 'New Users (30d)',    value: stats.users.new_users_30d,   sub: 'recent signups',                              icon: '📈', color: 'teal' },
    { label: 'Actions (7d)',       value: stats.activity.actions_7d,   sub: `${stats.activity.actions_24h} today`,         icon: '⚡', color: 'indigo' },
  ];

  return (
    <div className="sa-overview">
      <div className="sa-stat-grid">
        {cards.map(c => (
          <div key={c.label} className={`sa-stat-card sa-stat-card--${c.color}`}>
            <div className="sa-stat-icon">{c.icon}</div>
            <div className="sa-stat-value">{Number(c.value).toLocaleString()}</div>
            <div className="sa-stat-label">{c.label}</div>
            <div className="sa-stat-sub">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="sa-info-banner">
        <span className="sa-info-icon">ℹ️</span>
        <span>Super admin actions are fully audited. Every org modification, user change, and impersonation session is logged in the Audit Log tab.</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORGS — list, create, edit, suspend, impersonate
// ─────────────────────────────────────────────────────────────────

function SAOrgs() {
  const [orgs, setOrgs]           = useState([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [statusFilter, setStatus] = useState('');
  const [planFilter, setPlan]     = useState('');
  const [page, setPage]           = useState(1);
  const [selectedOrg, setSelected] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');

  const LIMIT = 20;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.superAdmin.getOrgs({ search, status: statusFilter, plan: planFilter, page, limit: LIMIT });
      setOrgs(r.data.orgs);
      setTotal(r.data.total);
    } catch (e) {
      setError('Failed to load organisations');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, planFilter, page]);

  useEffect(() => { load(); }, [load]);

  const handleSuspend = async (org, suspend) => {
    const reason = suspend ? window.prompt(`Reason for suspending "${org.name}"?`) : null;
    if (suspend && reason === null) return; // cancelled
    try {
      await apiService.superAdmin.suspendOrg(org.id, { suspend, reason });
      setSuccess(suspend ? `${org.name} suspended` : `${org.name} reactivated`);
      setTimeout(() => setSuccess(''), 3000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Action failed');
    }
  };

  const handleImpersonate = async (org) => {
    if (!window.confirm(`You are about to enter support mode for "${org.name}". This will be logged. Continue?`)) return;
    try {
      const r = await apiService.superAdmin.impersonateOrg(org.id);
      setSuccess(`Support mode active: ${r.data.supportOrgName}`);
      // Store support context — org admin UI can read this
      sessionStorage.setItem('supportOrgId',   r.data.supportOrgId);
      sessionStorage.setItem('supportOrgName', r.data.supportOrgName);
      setTimeout(() => setSuccess(''), 4000);
    } catch (e) {
      setError('Impersonation failed');
    }
  };

  const STATUS_COLORS = { active: 'green', suspended: 'red', trial: 'amber', cancelled: 'grey' };
  const PLAN_LABELS   = { free: 'Free', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' };

  return (
    <div className="sa-panel">
      {error   && <div className="sa-alert sa-alert--error">⚠️ {error}<button onClick={() => setError('')}>✕</button></div>}
      {success && <div className="sa-alert sa-alert--success">✅ {success}</div>}

      {/* Toolbar */}
      <div className="sa-toolbar">
        <input
          className="sa-search"
          placeholder="Search organisations…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
        <select className="sa-select" value={statusFilter} onChange={e => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="trial">Trial</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select className="sa-select" value={planFilter} onChange={e => { setPlan(e.target.value); setPage(1); }}>
          <option value="">All plans</option>
          <option value="free">Free</option>
          <option value="starter">Starter</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
        <button className="sa-btn-primary" onClick={() => setShowCreate(true)}>
          + New Organisation
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="sa-loading">Loading…</div>
      ) : (
        <>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Status</th>
                  <th>Plan</th>
                  <th>Members</th>
                  <th>Owner</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orgs.length === 0 && (
                  <tr><td colSpan={7} className="sa-empty">No organisations found</td></tr>
                )}
                {orgs.map(org => (
                  <tr key={org.id} className={org.status === 'suspended' ? 'sa-row-suspended' : ''}>
                    <td>
                      <button className="sa-link" onClick={() => setSelected(org)}>
                        {org.name}
                      </button>
                      <div className="sa-sub-text">ID: {org.id}</div>
                    </td>
                    <td>
                      <span className={`sa-badge-status sa-badge-status--${STATUS_COLORS[org.status]}`}>
                        {org.status}
                      </span>
                    </td>
                    <td><span className="sa-plan-pill">{PLAN_LABELS[org.plan] || org.plan}</span></td>
                    <td>{org.member_count} / {org.max_users}</td>
                    <td className="sa-sub-text">{org.owner_email || '—'}</td>
                    <td className="sa-sub-text">{new Date(org.created_at).toLocaleDateString()}</td>
                    <td>
                      <div className="sa-action-btns">
                        <button className="sa-btn-sm" onClick={() => setSelected(org)} title="View details">
                          👁
                        </button>
                        <button className="sa-btn-sm sa-btn-sm--blue" onClick={() => handleImpersonate(org)} title="Support mode">
                          🔧
                        </button>
                        {org.status === 'suspended' ? (
                          <button className="sa-btn-sm sa-btn-sm--green" onClick={() => handleSuspend(org, false)} title="Reactivate">
                            ▶
                          </button>
                        ) : (
                          <button className="sa-btn-sm sa-btn-sm--red" onClick={() => handleSuspend(org, true)} title="Suspend">
                            ⏸
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="sa-pagination">
            <span className="sa-sub-text">{total} total</span>
            <div className="sa-page-btns">
              <button className="sa-btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
              <span className="sa-page-num">Page {page}</span>
              <button className="sa-btn-sm" disabled={page * LIMIT >= total} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          </div>
        </>
      )}

      {/* Org Detail Drawer */}
      {selectedOrg && (
        <SAOrgDetail
          orgId={selectedOrg.id}
          onClose={() => { setSelected(null); load(); }}
        />
      )}

      {/* Create Org Modal */}
      {showCreate && (
        <SACreateOrg
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); setSuccess('Organisation created'); setTimeout(() => setSuccess(''), 3000); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORG DETAIL DRAWER
// ─────────────────────────────────────────────────────────────────

function SAOrgDetail({ orgId, onClose }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm]     = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const [success, setSuccess] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole]   = useState('member');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.superAdmin.getOrg(orgId);
      setData(r.data);
      setForm({ name: r.data.org.name, plan: r.data.org.plan, max_users: r.data.org.max_users, notes: r.data.org.notes || '' });
    } catch { setError('Failed to load org'); }
    finally { setLoading(false); }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    try {
      setSaving(true);
      await apiService.superAdmin.updateOrg(orgId, form);
      setSuccess('Saved'); setEditing(false);
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleAddUser = async () => {
    if (!addEmail.trim()) return;
    try {
      await apiService.superAdmin.addUserToOrg(orgId, { email: addEmail.trim(), role: addRole });
      setAddEmail(''); setSuccess('User added');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to add user');
    }
  };

  const handleRoleChange = async (userId, role) => {
    try {
      await apiService.superAdmin.updateUserInOrg(orgId, userId, { role });
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to update role');
    }
  };

  const handleRemoveUser = async (userId) => {
    if (!window.confirm('Remove this user from the org?')) return;
    try {
      await apiService.superAdmin.removeUserFromOrg(orgId, userId);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to remove user');
    }
  };

  return (
    <div className="sa-drawer-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sa-drawer">
        <div className="sa-drawer-header">
          <h2>{data?.org.name || 'Organisation'}</h2>
          <button className="sa-drawer-close" onClick={onClose}>✕</button>
        </div>

        {loading && <div className="sa-loading">Loading…</div>}

        {!loading && data && (
          <div className="sa-drawer-body">
            {error   && <div className="sa-alert sa-alert--error">⚠️ {error}<button onClick={() => setError('')}>✕</button></div>}
            {success && <div className="sa-alert sa-alert--success">✅ {success}</div>}

            {/* Org info */}
            <section className="sa-drawer-section">
              <div className="sa-section-header">
                <h3>Organisation Details</h3>
                <button className="sa-btn-sm" onClick={() => setEditing(!editing)}>
                  {editing ? 'Cancel' : '✏️ Edit'}
                </button>
              </div>

              {editing ? (
                <div className="sa-form-grid">
                  <div className="sa-form-field">
                    <label>Name</label>
                    <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                  </div>
                  <div className="sa-form-field">
                    <label>Plan</label>
                    <select value={form.plan} onChange={e => setForm({ ...form, plan: e.target.value })}>
                      {['free','starter','pro','enterprise'].map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className="sa-form-field">
                    <label>Max Users</label>
                    <input type="number" value={form.max_users} onChange={e => setForm({ ...form, max_users: parseInt(e.target.value) })} />
                  </div>
                  <div className="sa-form-field sa-form-field--full">
                    <label>Notes</label>
                    <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={3} />
                  </div>
                  <button className="sa-btn-primary" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving…' : '💾 Save Changes'}
                  </button>
                </div>
              ) : (
                <div className="sa-info-grid">
                  <div className="sa-info-row"><span>ID</span><strong>{data.org.id}</strong></div>
                  <div className="sa-info-row"><span>Status</span><strong>{data.org.status}</strong></div>
                  <div className="sa-info-row"><span>Plan</span><strong>{data.org.plan}</strong></div>
                  <div className="sa-info-row"><span>Seats</span><strong>{data.members.filter(m => m.is_active).length} / {data.org.max_users}</strong></div>
                  <div className="sa-info-row"><span>Created</span><strong>{new Date(data.org.created_at).toLocaleDateString()}</strong></div>
                  {data.org.notes && <div className="sa-info-row"><span>Notes</span><strong>{data.org.notes}</strong></div>}
                </div>
              )}
            </section>

            {/* Members */}
            <section className="sa-drawer-section">
              <h3>Members ({data.members.length})</h3>

              {/* Add user */}
              <div className="sa-add-user-row">
                <input
                  className="sa-input-inline"
                  placeholder="user@email.com"
                  value={addEmail}
                  onChange={e => setAddEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddUser()}
                />
                <select className="sa-select-inline" value={addRole} onChange={e => setAddRole(e.target.value)}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button className="sa-btn-primary" onClick={handleAddUser}>Add</button>
              </div>

              <div className="sa-member-list">
                {data.members.map(m => (
                  <div key={m.user_id} className={`sa-member-row ${!m.is_active ? 'sa-member-row--inactive' : ''}`}>
                    <div className="sa-member-info">
                      <div className="sa-member-name">{m.name || m.email}</div>
                      <div className="sa-sub-text">{m.email}</div>
                    </div>
                    <select
                      className="sa-select-inline"
                      value={m.role}
                      onChange={e => handleRoleChange(m.user_id, e.target.value)}
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <span className={`sa-active-dot ${m.is_active ? 'active' : 'inactive'}`} title={m.is_active ? 'Active' : 'Inactive'} />
                    <button className="sa-btn-sm sa-btn-sm--red" onClick={() => handleRemoveUser(m.user_id)} title="Remove">✕</button>
                  </div>
                ))}
              </div>
            </section>

            {/* Integrations */}
            <section className="sa-drawer-section">
              <h3>Integrations</h3>
              {data.integrations.length === 0 ? (
                <p className="sa-sub-text">No integrations configured</p>
              ) : (
                <div className="sa-integration-chips">
                  {data.integrations.map((i, idx) => (
                    <span key={idx} className={`sa-chip ${i.is_active ? 'sa-chip--active' : 'sa-chip--inactive'}`}>
                      {i.provider} {i.is_active ? '✓' : '○'}
                    </span>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// CREATE ORG MODAL
// ─────────────────────────────────────────────────────────────────

function SACreateOrg({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', plan: 'free', max_users: 10, notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    try {
      setSaving(true);
      await apiService.superAdmin.createOrg(form);
      onCreated();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to create org');
    } finally { setSaving(false); }
  };

  return (
    <div className="sa-modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sa-modal">
        <div className="sa-modal-header">
          <h2>New Organisation</h2>
          <button className="sa-drawer-close" onClick={onClose}>✕</button>
        </div>
        {error && <div className="sa-alert sa-alert--error">⚠️ {error}</div>}
        <div className="sa-form-grid">
          <div className="sa-form-field sa-form-field--full">
            <label>Organisation Name *</label>
            <input
              autoFocus
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Acme Corp"
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <div className="sa-form-field">
            <label>Plan</label>
            <select value={form.plan} onChange={e => setForm({ ...form, plan: e.target.value })}>
              <option value="free">Free</option>
              <option value="starter">Starter</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div className="sa-form-field">
            <label>Max Users</label>
            <input type="number" min="1" value={form.max_users} onChange={e => setForm({ ...form, max_users: parseInt(e.target.value) })} />
          </div>
          <div className="sa-form-field sa-form-field--full">
            <label>Notes (internal)</label>
            <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="e.g. Enterprise pilot — Q3 deal" />
          </div>
        </div>
        <div className="sa-modal-footer">
          <button className="sa-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="sa-btn-primary" onClick={handleCreate} disabled={saving}>
            {saving ? 'Creating…' : 'Create Organisation'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SUPER ADMINS TAB — manage who has platform access
// ─────────────────────────────────────────────────────────────────

function SAAdmins() {
  const [admins, setAdmins]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail]     = useState('');
  const [notes, setNotes]     = useState('');
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

  const load = async () => {
    try {
      setLoading(true);
      const r = await apiService.superAdmin.getAdmins();
      setAdmins(r.data.admins);
    } catch { setError('Failed to load admins'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleGrant = async () => {
    if (!email.trim()) return;
    try {
      await apiService.superAdmin.grantAdmin({ email: email.trim(), notes });
      setEmail(''); setNotes('');
      setSuccess(`Super admin granted to ${email}`);
      setTimeout(() => setSuccess(''), 3000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to grant access');
    }
  };

  const handleRevoke = async (userId, userEmail) => {
    if (!window.confirm(`Revoke super admin access from ${userEmail}?`)) return;
    try {
      await apiService.superAdmin.revokeAdmin(userId);
      setSuccess(`Access revoked`);
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to revoke');
    }
  };

  return (
    <div className="sa-panel">
      {error   && <div className="sa-alert sa-alert--error">⚠️ {error}<button onClick={() => setError('')}>✕</button></div>}
      {success && <div className="sa-alert sa-alert--success">✅ {success}</div>}

      <div className="sa-warning-box">
        <strong>⚠️ Restricted</strong> — Super admins have unrestricted access to all organisations, all data, and all user accounts across the platform. Grant sparingly.
      </div>

      {/* Grant form */}
      <div className="sa-card">
        <h3>Grant Super Admin Access</h3>
        <div className="sa-inline-form">
          <input
            className="sa-input"
            placeholder="user@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          <input
            className="sa-input"
            placeholder="Notes (e.g. 'Founding engineer')"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleGrant()}
          />
          <button className="sa-btn-primary" onClick={handleGrant}>Grant Access</button>
        </div>
      </div>

      {/* Current admins */}
      <div className="sa-card">
        <h3>Current Super Admins</h3>
        {loading ? (
          <div className="sa-loading">Loading…</div>
        ) : (
          <div className="sa-member-list">
            {admins.map(a => (
              <div key={a.id} className={`sa-member-row ${a.revoked_at ? 'sa-member-row--inactive' : ''}`}>
                <div className="sa-member-info">
                  <div className="sa-member-name">
                    {a.name || a.email}
                    {a.user_id === currentUser.id && <span className="sa-you-badge">you</span>}
                  </div>
                  <div className="sa-sub-text">
                    {a.email} · Granted by {a.granted_by_email || 'system'} on {new Date(a.granted_at).toLocaleDateString()}
                    {a.notes && ` · ${a.notes}`}
                  </div>
                </div>
                {a.revoked_at ? (
                  <span className="sa-chip sa-chip--inactive">Revoked {new Date(a.revoked_at).toLocaleDateString()}</span>
                ) : (
                  <button
                    className="sa-btn-sm sa-btn-sm--red"
                    onClick={() => handleRevoke(a.user_id, a.email)}
                    disabled={a.user_id === currentUser.id}
                    title={a.user_id === currentUser.id ? 'Cannot revoke yourself' : 'Revoke access'}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────────────

function SAAuditLog() {
  const [logs, setLogs]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage]   = useState(1);

  const ACTION_ICONS = {
    create_org: '🏢', update_org: '✏️', suspend_org: '⏸', unsuspend_org: '▶',
    impersonate_org: '🔧', add_user_to_org: '➕', remove_user_from_org: '➖',
    update_user_in_org: '👤', grant_super_admin: '🔐', revoke_super_admin: '🔒',
  };

  useEffect(() => {
    setLoading(true);
    apiService.superAdmin.getAuditLog({ page, limit: 50 })
      .then(r => setLogs(r.data.logs))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page]);

  return (
    <div className="sa-panel">
      <div className="sa-panel-info">
        Platform audit trail — immutable record of all super admin actions.
      </div>

      {loading ? (
        <div className="sa-loading">Loading…</div>
      ) : (
        <>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Admin</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 && (
                  <tr><td colSpan={5} className="sa-empty">No audit entries yet</td></tr>
                )}
                {logs.map(log => (
                  <tr key={log.id}>
                    <td className="sa-sub-text">{new Date(log.created_at).toLocaleString()}</td>
                    <td>{log.admin_name || log.admin_email}</td>
                    <td>
                      <span className="sa-audit-action">
                        {ACTION_ICONS[log.action] || '•'} {log.action.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="sa-sub-text">{log.target_type} #{log.target_id}</td>
                    <td className="sa-sub-text">{log.ip_address || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sa-pagination">
            <button className="sa-btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span className="sa-sub-text">Page {page}</span>
            <button className="sa-btn-sm" disabled={logs.length < 50} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
