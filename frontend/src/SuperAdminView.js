import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './SuperAdminView.css';
import WorkflowCanvas from './WorkflowCanvas';
import ExecutionLog from './ExecutionLog';

// ═══════════════════════════════════════════════════════════════════
// SUPER ADMIN VIEW — ActionCRM Platform Administration
// Only accessible to users in the super_admins table
// ═══════════════════════════════════════════════════════════════════

const SA_TABS = [
  { id: 'overview',          label: 'Overview',          icon: '📊' },
  { id: 'orgs',              label: 'Organisations',     icon: '🏢' },
  { id: 'admins',            label: 'Super Admins',      icon: '🔐' },
  { id: 'audit',             label: 'Audit Log',         icon: '📋' },
  { id: 'workflows',         label: 'Workflows',         icon: '⚙️'  },
  { id: 'platform-settings', label: 'Platform Settings', icon: '🛠️'  },
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
        {tab === 'overview'          && <SAOverview />}
        {tab === 'orgs'              && <SAOrgs />}
        {tab === 'admins'            && <SAAdmins />}
        {tab === 'audit'             && <SAAuditLog />}
        {tab === 'workflows'         && <SAWorkflows />}
        {tab === 'platform-settings' && <SAPlatformSettings />}
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

  // Create user state
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [createForm, setCreateForm] = useState({ email: '', first_name: '', last_name: '', password: '', role: 'member' });
  const [creatingUser, setCreatingUser] = useState(false);

  // Invite state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [sendingInvite, setSendingInvite] = useState(false);
  const [invites, setInvites] = useState([]);
  const [lastInviteUrl, setLastInviteUrl] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.superAdmin.getOrg(orgId);
      setData(r.data);
      setForm({ name: r.data.org.name, plan: r.data.org.plan, max_users: r.data.org.max_users, notes: r.data.org.notes || '' });
      // Load invites
      try {
        const invR = await apiService.superAdmin.getInvites(orgId);
        setInvites(invR.data.invites || []);
      } catch { /* invites table might not exist yet */ }
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
      setAddEmail(''); setError(''); setSuccess('User added');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to add user');
    }
  };

  const handleCreateUser = async () => {
    if (!createForm.email.trim() || !createForm.first_name.trim() || !createForm.last_name.trim()) {
      setError('Email, first name, and last name are required'); return;
    }
    if (createForm.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    try {
      setCreatingUser(true);
      setError('');
      await apiService.superAdmin.createUserForOrg(orgId, createForm);
      setCreateForm({ email: '', first_name: '', last_name: '', password: '', role: 'member' });
      setShowCreateUser(false);
      setSuccess('User created and added to org');
      setTimeout(() => setSuccess(''), 3000);
      load();
    } catch (e) {
      const msg = e.response?.data?.error?.message || 'Failed to create user';
      // If user already exists, offer to add them directly
      if (e.response?.status === 409) {
        const email = createForm.email.trim();
        setError(`${msg} — Would you like to add them?`);
        setAddEmail(email);
        setAddRole(createForm.role);
        setShowCreateUser(false);
      } else {
        setError(msg);
      }
    } finally { setCreatingUser(false); }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    try {
      setSendingInvite(true);
      const r = await apiService.superAdmin.inviteUserToOrg(orgId, { email: inviteEmail.trim(), role: inviteRole });
      setLastInviteUrl(r.data.inviteUrl || '');
      setInviteEmail('');
      setSuccess('Invite created — copy the link below to share');
      setTimeout(() => setSuccess(''), 5000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to create invite');
    } finally { setSendingInvite(false); }
  };

  const handleCancelInvite = async (inviteId) => {
    try {
      await apiService.superAdmin.cancelInvite(orgId, inviteId);
      load();
    } catch (e) {
      setError('Failed to cancel invite');
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
      setError('');
      await apiService.superAdmin.removeUserFromOrg(orgId, userId);
      setSuccess('User removed');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to remove user');
    }
  };

  const generateTempPassword = () => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
    let pw = '';
    for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    setCreateForm(f => ({ ...f, password: pw }));
  };

  const pendingInvites = invites.filter(i => !i.accepted_at && new Date(i.expires_at) > new Date());
  const expiredInvites = invites.filter(i => !i.accepted_at && new Date(i.expires_at) <= new Date());

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
              <div className="sa-section-header">
                <h3>Members ({data.members.length})</h3>
                <div className="sa-section-header-actions">
                  <button className="sa-btn-sm sa-btn-sm--blue" onClick={() => { setShowCreateUser(!showCreateUser); setShowInvite(false); }}>
                    {showCreateUser ? '✕ Close' : '➕ Create User'}
                  </button>
                  <button className="sa-btn-sm sa-btn-sm--green" onClick={() => { setShowInvite(!showInvite); setShowCreateUser(false); }}>
                    {showInvite ? '✕ Close' : '📧 Invite'}
                  </button>
                </div>
              </div>

              {/* Create User Form */}
              {showCreateUser && (
                <div className="sa-create-user-form">
                  <div className="sa-form-section-title">Create New User Account</div>
                  <div className="sa-form-grid">
                    <div className="sa-form-field">
                      <label>First Name *</label>
                      <input
                        value={createForm.first_name}
                        onChange={e => setCreateForm({ ...createForm, first_name: e.target.value })}
                        placeholder="John"
                      />
                    </div>
                    <div className="sa-form-field">
                      <label>Last Name *</label>
                      <input
                        value={createForm.last_name}
                        onChange={e => setCreateForm({ ...createForm, last_name: e.target.value })}
                        placeholder="Doe"
                      />
                    </div>
                    <div className="sa-form-field sa-form-field--full">
                      <label>Email *</label>
                      <input
                        type="email"
                        value={createForm.email}
                        onChange={e => setCreateForm({ ...createForm, email: e.target.value })}
                        placeholder="user@company.com"
                      />
                    </div>
                    <div className="sa-form-field">
                      <label>Temp Password *</label>
                      <div className="sa-password-row">
                        <input
                          value={createForm.password}
                          onChange={e => setCreateForm({ ...createForm, password: e.target.value })}
                          placeholder="Min 8 characters"
                        />
                        <button className="sa-btn-sm" onClick={generateTempPassword} title="Generate password">🎲</button>
                      </div>
                    </div>
                    <div className="sa-form-field">
                      <label>Role</label>
                      <select value={createForm.role} onChange={e => setCreateForm({ ...createForm, role: e.target.value })}>
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </div>
                  </div>
                  <div className="sa-form-actions">
                    <button className="sa-btn-primary" onClick={handleCreateUser} disabled={creatingUser}>
                      {creatingUser ? 'Creating…' : '✅ Create & Add to Org'}
                    </button>
                    <span className="sa-form-hint">User will be prompted to change password on first login</span>
                  </div>
                </div>
              )}

              {/* Invite Form */}
              {showInvite && (
                <div className="sa-invite-form">
                  <div className="sa-form-section-title">Send Invite Link</div>
                  <div className="sa-add-user-row">
                    <input
                      className="sa-input-inline"
                      placeholder="user@company.com"
                      value={inviteEmail}
                      onChange={e => setInviteEmail(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleInvite()}
                    />
                    <select className="sa-select-inline" value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button className="sa-btn-primary" onClick={handleInvite} disabled={sendingInvite}>
                      {sendingInvite ? 'Sending…' : '📧 Invite'}
                    </button>
                  </div>
                  {lastInviteUrl && (
                    <div className="sa-invite-url-box">
                      <label>Invite Link (share with user):</label>
                      <div className="sa-invite-url-row">
                        <code className="sa-invite-url">{lastInviteUrl}</code>
                        <button className="sa-btn-sm" onClick={() => { navigator.clipboard.writeText(lastInviteUrl); setSuccess('Link copied!'); setTimeout(() => setSuccess(''), 2000); }}>
                          📋 Copy
                        </button>
                      </div>
                      <span className="sa-form-hint">Expires in 7 days. User will register via this link and auto-join the org.</span>
                    </div>
                  )}
                  {pendingInvites.length > 0 && (
                    <div className="sa-pending-invites">
                      <div className="sa-form-section-title" style={{ marginTop: 12 }}>Pending Invites</div>
                      {pendingInvites.map(inv => (
                        <div key={inv.id} className="sa-invite-row">
                          <div className="sa-member-info">
                            <div className="sa-member-name">{inv.email}</div>
                            <div className="sa-sub-text">
                              {inv.role} · Expires {new Date(inv.expires_at).toLocaleDateString()}
                            </div>
                          </div>
                          <button className="sa-btn-sm sa-btn-sm--red" onClick={() => handleCancelInvite(inv.id)} title="Cancel invite">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {expiredInvites.length > 0 && (
                    <div className="sa-sub-text" style={{ marginTop: 8, fontStyle: 'italic' }}>
                      {expiredInvites.length} expired invite{expiredInvites.length !== 1 ? 's' : ''}
                    </div>
                  )}
                </div>
              )}

              {/* Add existing user */}
              <div className="sa-add-user-row" style={{ marginTop: showCreateUser || showInvite ? 16 : 0 }}>
                <input
                  className="sa-input-inline"
                  placeholder="Add existing user by email…"
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

            {/* Module Provisioning */}
            <section className="sa-drawer-section">
              <h3>Module Provisioning</h3>
              <SAOrgModules orgId={orgId} />
            </section>

          </div>
        )}
      </div>
    </div>
  );
}



// ═════════════════════════════════════════════════════════════════════════════
// CHANGE 1 — NEW COMPONENT: SAOrgModules
//
// Paste this as a new function anywhere after the SAOrgDetail function,
// before SACreateOrg.
// ═════════════════════════════════════════════════════════════════════════════

const MODULE_DEFS_SA = [
  {
    key:   'prospecting',
    icon:  '🎯',
    label: 'Prospecting',
    desc:  'Prospect pipeline, outreach sequences, ICP scoring, sender accounts.',
  },
  {
    key:   'contracts',
    icon:  '📄',
    label: 'Contract Lifecycle Management',
    desc:  'CLM workflow — create contracts, legal review, e-signature, versioning.',
  },
  {
    key:   'handovers',
    icon:  '🤝',
    label: 'Sales → Implementation Handover',
    desc:  'Structured handover workflow on deal close — checklist, stakeholders, commitments.',
  },
  {
    key:   'service',
    icon:  '🎧',
    label: 'Customer Support & Service',
    desc:  'Case management, SLA tiers, playbook-driven workflows, team assignment.',
  },
  {
    key:   'agency',
    icon:  '🏢',
    label: 'Agency Client Management',
    desc:  'Manage client accounts — portals, team scoping, outreach tracking.',
  },
];

/**
 * SAOrgModules — module provisioning panel inside the org detail drawer.
 *
 * Shows all five modules. For each:
 *   - Allowed toggle: controlled by super admin (platform provisioning)
 *   - Enabled indicator: read-only view of what the org admin has turned on
 *
 * Disallowing a module automatically forces its enabled state to false
 * (enforced on the backend; reflected here immediately in the UI).
 */
function SAOrgModules({ orgId }) {
  const [modules, setModules]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(null); // key of module being saved
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await apiService.superAdmin.getOrgModules(orgId);
      setModules(r.data.modules);
    } catch (e) {
      setError('Failed to load module settings');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const handleToggleAllowed = async (moduleKey, newAllowed) => {
    setSaving(moduleKey);
    setError('');
    try {
      const r = await apiService.superAdmin.updateOrgModules(orgId, { [moduleKey]: newAllowed });
      setModules(r.data.modules);
      const label = MODULE_DEFS_SA.find(m => m.key === moduleKey)?.label || moduleKey;
      setSuccess(`${label} ${newAllowed ? 'provisioned ✓' : 'removed from org'}`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to update module');
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <div className="sa-loading" style={{ padding: '12px 0' }}>Loading modules…</div>;

  return (
    <div>
      {error   && <div className="sa-alert sa-alert--error" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
      {success && <div className="sa-alert sa-alert--success" style={{ marginBottom: 12 }}>✅ {success}</div>}

      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14, lineHeight: 1.5 }}>
        <strong>Allowed</strong> controls whether the org can activate a module.
        Org admins can only turn on modules that are provisioned here.
        Removing access immediately disables the module for the org.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {MODULE_DEFS_SA.map(def => {
          const state      = modules?.[def.key] || { allowed: false, enabled: false };
          const isSaving   = saving === def.key;
          const isAllowed  = state.allowed;
          const isEnabled  = state.enabled;

          return (
            <div
              key={def.key}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                border: `1px solid ${isAllowed ? '#d1fae5' : '#e5e7eb'}`,
                background: isAllowed ? '#f0fdf4' : '#fafafa',
                transition: 'all 0.15s',
              }}
            >
              {/* Icon + label */}
              <div style={{ fontSize: 20, marginTop: 1 }}>{def.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 2 }}>
                  {def.label}
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.4 }}>{def.desc}</div>
                {/* Enabled indicator — read-only, set by org admin */}
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: isEnabled ? '#059669' : '#d1d5db',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 11, color: isEnabled ? '#059669' : '#9ca3af' }}>
                    {isEnabled ? 'Active — org has turned this on' : 'Inactive — org has not enabled this'}
                  </span>
                </div>
              </div>

              {/* Allowed toggle */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <button
                  disabled={isSaving}
                  onClick={() => handleToggleAllowed(def.key, !isAllowed)}
                  title={isAllowed ? 'Remove access' : 'Provision access'}
                  style={{
                    position: 'relative', width: 42, height: 24, borderRadius: 12,
                    border: 'none',
                    background: isAllowed ? '#059669' : '#d1d5db',
                    cursor: isSaving ? 'not-allowed' : 'pointer',
                    opacity: isSaving ? 0.6 : 1,
                    transition: 'background 0.2s',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 4,
                    left: isAllowed ? 21 : 4,
                    width: 16, height: 16, borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </button>
                <span style={{ fontSize: 10, fontWeight: 600, color: isAllowed ? '#059669' : '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                  {isSaving ? '…' : (isAllowed ? 'Allowed' : 'Locked')}
                </span>
              </div>
            </div>
          );
        })}
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

// ─────────────────────────────────────────────────────────────────
// WORKFLOWS TAB — platform-scoped workflow + rule management
// Fifth flat tab, after Audit Log.
// Renders two sub-tabs:
//   Workflows   — WorkflowCanvas (super scope)
//   Exec Log    — ExecutionLog across all orgs (super scope)
// ─────────────────────────────────────────────────────────────────

function SAWorkflows() {
  const [subTab, setSubTab] = useState('canvas');

  const SUB_TABS = [
    { id: 'canvas', label: '⚙️ Workflows & Rules' },
    { id: 'log',    label: '📋 Execution Log'     },
  ];

  return (
    <div className="sa-panel">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: '#111827' }}>
          ⚙️ Platform Workflows
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
          Platform-scoped workflows and standalone rules are inherited by all organisations.
          Mark rules as <strong>is_locked = true</strong> to prevent org admins from modifying them.
        </p>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '7px 16px',
              borderRadius: '7px 7px 0 0',
              border: '1px solid transparent',
              borderBottom: 'none',
              background: subTab === t.id ? '#fff' : 'transparent',
              borderColor: subTab === t.id ? '#e5e7eb' : 'transparent',
              borderBottomColor: subTab === t.id ? '#fff' : 'transparent',
              fontSize: 13,
              fontWeight: subTab === t.id ? 600 : 500,
              color: subTab === t.id ? '#111827' : '#6b7280',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'canvas' && <WorkflowCanvas scope="super" />}
      {subTab === 'log'    && <ExecutionLog   scope="super" />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SETTINGS TAB
// Manages platform-wide configuration stored in the platform_settings table.
// Super admins edit here; org admins see read-only platform defaults in their
// own OrgAdmin → Data Quality → Email Settings page.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tag list editor (reused from OAEmailSettings pattern) ─────────────────────

function SATagListEditor({ items, onAdd, onRemove, placeholder, disabled }) {
  const [input, setInput] = React.useState('');

  const handleAdd = () => {
    const val = input.trim().toLowerCase();
    if (!val || items.includes(val)) { setInput(''); return; }
    onAdd(val);
    setInput('');
  };

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, minHeight: 32 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', lineHeight: '28px' }}>
            No entries — org admins must configure their own
          </span>
        )}
        {items.map(item => (
          <span key={item} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 12, padding: '3px 8px', borderRadius: 5,
            background: '#f3f4f6', border: '1px solid #e5e7eb', color: '#374151',
          }}>
            {item}
            {!disabled && (
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14, lineHeight: 1, padding: 0 }}
                onClick={() => onRemove(item)}
              >×</button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={{ flex: 1, padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 12 }}
            placeholder={placeholder}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <button
            style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151' }}
            onClick={handleAdd}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main SAPlatformSettings component ─────────────────────────────────────────

function SAPlatformSettings() {
  const [subTab, setSubTab]         = React.useState('email-filter');
  return (
    <div className="sa-panel">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: '#111827' }}>
          🛠️ Platform Settings
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
          Platform-wide configuration that cascades to all organisations.
          Org admins can add their own settings on top but cannot remove platform defaults.
        </p>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 24 }}>
        {[
          { id: 'email-filter', label: '📧 Email Filter Defaults' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '7px 16px',
              borderRadius: '7px 7px 0 0',
              border: '1px solid transparent',
              borderBottom: 'none',
              background: subTab === t.id ? '#fff' : 'transparent',
              borderColor: subTab === t.id ? '#e5e7eb' : 'transparent',
              borderBottomColor: subTab === t.id ? '#fff' : 'transparent',
              fontSize: 13,
              fontWeight: subTab === t.id ? 600 : 500,
              color: subTab === t.id ? '#111827' : '#6b7280',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'email-filter' && <SAEmailFilterSettings />}
    </div>
  );
}

// ── SAEmailFilterSettings ─────────────────────────────────────────────────────

function SAEmailFilterSettings() {
  const [domains,   setDomains]   = React.useState([]);
  const [patterns,  setPatterns]  = React.useState([]);
  const [loading,   setLoading]   = React.useState(true);
  const [saving,    setSaving]    = React.useState(false);
  const [dirty,     setDirty]     = React.useState(false);
  const [error,     setError]     = React.useState('');
  const [success,   setSuccess]   = React.useState('');

  React.useEffect(() => {
    setLoading(true);
    apiService.superAdmin.getPlatformSetting('email_filter')
      .then(r => {
        const val = r.data.value || {};
        setDomains(val.blocked_domains        || []);
        setPatterns(val.blocked_local_patterns || []);
        setDirty(false);
      })
      .catch(e => setError(e.response?.data?.error?.message || 'Failed to load platform email filter'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await apiService.superAdmin.updatePlatformSetting('email_filter', {
        blocked_domains:        domains,
        blocked_local_patterns: patterns,
      });
      setSuccess('Platform email filter saved ✓ — will apply on next email sync for all orgs');
      setTimeout(() => setSuccess(''), 5000);
      setDirty(false);
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to save');
    } finally { setSaving(false); }
  };

  const addDomain  = d => { setDomains(prev => [...prev, d]);   setDirty(true); };
  const rmDomain   = d => { setDomains(prev => prev.filter(x => x !== d)); setDirty(true); };
  const addPattern = p => { setPatterns(prev => [...prev, p]);  setDirty(true); };
  const rmPattern  = p => { setPatterns(prev => prev.filter(x => x !== p)); setDirty(true); };

  const clearAll = () => {
    if (!window.confirm('Clear all platform defaults? Org admins will need to configure their own filters from scratch.')) return;
    setDomains([]);
    setPatterns([]);
    setDirty(true);
  };

  if (loading) return <div className="sa-loading">Loading platform email filter…</div>;

  return (
    <div>
      {/* Warning banner */}
      <div className="sa-warning-box" style={{ marginBottom: 20 }}>
        <strong>⚠️ Platform-wide effect</strong> — Changes here apply to all organisations on the next email sync.
        Leaving both lists empty means org admins must configure their own filters from scratch.
        Org-specific additions are always merged on top of these defaults.
      </div>

      {error   && <div className="sa-alert sa-alert--error">⚠️ {error}<button onClick={() => setError('')}>✕</button></div>}
      {success && <div className="sa-alert sa-alert--success">✅ {success}</div>}

      {/* Blocked domains */}
      <div className="sa-card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 4 }}>Blocked domains</h3>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
          Emails from these domains are dropped before matching. Applies to the sender address
          for received emails, and the recipient for sent emails.
        </p>
        <SATagListEditor
          items={domains}
          onAdd={addDomain}
          onRemove={rmDomain}
          placeholder="e.g. microsoft.com or mail.onedrive.com"
        />
      </div>

      {/* Blocked sender patterns */}
      <div className="sa-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Blocked sender patterns</h3>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
          Emails where the local part (before @) contains any of these patterns are dropped.
          E.g. adding <code style={{ background: '#f3f4f6', padding: '1px 5px', borderRadius: 4, fontSize: 12 }}>noreply</code> blocks
          noreply@anycompany.com, no-reply@anycompany.com etc.
        </p>
        <SATagListEditor
          items={patterns}
          onAdd={addPattern}
          onRemove={rmPattern}
          placeholder="e.g. noreply or mailer-daemon"
        />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          className="sa-btn-primary"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save platform defaults'}
        </button>
        <button
          className="sa-btn-secondary"
          onClick={() => {
            apiService.superAdmin.getPlatformSetting('email_filter').then(r => {
              const val = r.data.value || {};
              setDomains(val.blocked_domains        || []);
              setPatterns(val.blocked_local_patterns || []);
              setDirty(false);
            });
          }}
          disabled={saving || !dirty}
        >
          Discard changes
        </button>
        <button
          style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 7, border: '1px solid #fca5a5', background: '#fff', fontSize: 13, color: '#dc2626', cursor: 'pointer' }}
          onClick={clearAll}
          disabled={saving}
        >
          Clear all defaults
        </button>
      </div>

      {/* How it stacks */}
      <div style={{ marginTop: 24, padding: '14px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 9 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          How filtering stacks
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, fontSize: 12, color: '#374151' }}>
          {[
            { label: 'Platform defaults', sub: 'set here', color: '#6366f1', bg: '#eef2ff' },
            { label: '+', sub: '', color: '#9ca3af', bg: 'transparent' },
            { label: 'Org additions', sub: 'set by org admin', color: '#059669', bg: '#f0fdf4' },
            { label: '=', sub: '', color: '#9ca3af', bg: 'transparent' },
            { label: 'Effective filter', sub: 'applied at sync time', color: '#374151', bg: '#f3f4f6' },
          ].map((item, i) => (
            <div key={i} style={{
              padding: item.bg === 'transparent' ? '0 8px' : '8px 14px',
              borderRadius: 7,
              background: item.bg,
              textAlign: 'center',
            }}>
              {item.bg !== 'transparent' && (
                <>
                  <div style={{ fontWeight: 600, color: item.color, fontSize: 12 }}>{item.label}</div>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{item.sub}</div>
                </>
              )}
              {item.bg === 'transparent' && (
                <span style={{ fontSize: 18, color: '#9ca3af', fontWeight: 300 }}>{item.label}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
