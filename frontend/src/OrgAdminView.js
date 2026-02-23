import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './OrgAdminView.css';
import DealHealthSettings from './DealHealthSettings';

// ═══════════════════════════════════════════════════════════════════
// ORG ADMIN VIEW — per-organisation administration
// Accessible to org owners and admins only.
// The SettingsView handles AI/playbook/deal-health configuration —
// this view handles PEOPLE, ROLES, INVITATIONS, and ORG SETTINGS.
// ═══════════════════════════════════════════════════════════════════

const ORG_ADMIN_TABS = [
  { id: 'members',     label: 'Members',      icon: '👥' },
  { id: 'invitations', label: 'Invitations',  icon: '✉️' },
  { id: 'playbooks',   label: 'Playbooks',    icon: '📘' },
  { id: 'health',      label: 'Deal Health',  icon: '🏥' },
  { id: 'deal-stages', label: 'Deal Stages',  icon: '🏷️' },
  { id: 'deal-roles',  label: 'Deal Roles',   icon: '🎭' },
  { id: 'settings',    label: 'Org Settings', icon: '⚙️' },
];

export default function OrgAdminView() {
  const [tab, setTab]       = useState('members');
  const [stats, setStats]   = useState(null);
  const [orgName, setOrgName] = useState('');

  useEffect(() => {
    apiService.orgAdmin.getStats()
      .then(r => setStats(r.data))
      .catch(console.error);
    apiService.orgAdmin.getProfile()
      .then(r => setOrgName(r.data.org.name))
      .catch(console.error);
  }, []);

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

  return (
    <div className="oa-view">
      <div className="oa-header">
        <div>
          <h1>{orgName || 'Organisation'} Admin</h1>
          <p className="oa-subtitle">Manage your team, roles, and organisation settings</p>
        </div>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="oa-stats-strip">
          <div className="oa-stat">
            <span className="oa-stat-value">{stats.members.active}</span>
            <span className="oa-stat-label">Active Members</span>
          </div>
          <div className="oa-stat-divider" />
          <div className="oa-stat">
            <span className="oa-stat-value">{stats.invitations.total}</span>
            <span className="oa-stat-label">Pending Invites</span>
          </div>
          <div className="oa-stat-divider" />
          <div className="oa-stat">
            <span className="oa-stat-value">{stats.deals.total}</span>
            <span className="oa-stat-label">Total Deals</span>
          </div>
          <div className="oa-stat-divider" />
          <div className="oa-stat">
            <span className="oa-stat-value">{stats.actions.week}</span>
            <span className="oa-stat-label">Actions (7d)</span>
          </div>
        </div>
      )}

      <div className="settings-tabs">
        {ORG_ADMIN_TABS.map(t => (
          <button
            key={t.id}
            className={`settings-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="settings-tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-body">
        {tab === 'members'     && <OAMembers currentUserId={currentUser.id} />}
        {tab === 'invitations' && <OAInvitations />}
        {tab === 'playbooks'   && <OAPlaybooks />}
        {tab === 'health'      && <DealHealthSettings />}
        {tab === 'deal-stages' && <OADealStages />}
        {tab === 'deal-roles'  && <OADealRoles />}
        {tab === 'settings'    && <OASettings />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROLE DEFINITIONS — rendered as cards so users understand what each means
// ─────────────────────────────────────────────────────────────────

const ROLE_META = {
  owner:  { label: 'Owner',  color: 'purple', icon: '👑', desc: 'Full control — org settings, billing, all data. Cannot be removed.' },
  admin:  { label: 'Admin',  color: 'blue',   icon: '🔑', desc: 'Manage members, invitations, integrations, and all CRM data.' },
  member: { label: 'Member', color: 'green',  icon: '👤', desc: 'Full CRM access — deals, contacts, emails, AI. Cannot manage users.' },
  viewer: { label: 'Viewer', color: 'grey',   icon: '👁',  desc: 'Read-only access to all CRM data. Cannot create or edit records.' },
};

function RoleBadge({ role }) {
  const m = ROLE_META[role] || { label: role, color: 'grey', icon: '•' };
  return (
    <span className={`oa-role-badge oa-role-badge--${m.color}`}>
      {m.icon} {m.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────
// MEMBERS TAB
// ─────────────────────────────────────────────────────────────────

function OAMembers({ currentUserId }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [callerRole, setCallerRole] = useState('member');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.orgAdmin.getMembers();
      setMembers(r.data.members);
      const me = r.data.members.find(m => m.user_id === currentUserId);
      if (me) setCallerRole(me.role);
    } catch { setError('Failed to load members'); }
    finally { setLoading(false); }
  }, [currentUserId]);

  useEffect(() => { load(); }, [load]);

  const handleRoleChange = async (userId, role) => {
    try {
      await apiService.orgAdmin.updateMember(userId, { role });
      setSuccess('Role updated');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to update role');
    }
  };

  const handleRemove = async (userId, name) => {
    if (!window.confirm(`Remove ${name} from the organisation?`)) return;
    try {
      await apiService.orgAdmin.removeMember(userId);
      setSuccess(`${name} removed`);
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to remove member');
    }
  };

  const filtered = members.filter(m =>
    !search ||
    m.name?.toLowerCase().includes(search.toLowerCase()) ||
    m.email.toLowerCase().includes(search.toLowerCase())
  );

  const isOwner = callerRole === 'owner';

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>👥 Team Members</h2>
          <p className="sv-panel-desc">Manage who is in your organisation and what they can access.</p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        {/* Role legend */}
        <div className="oa-role-legend">
          {Object.entries(ROLE_META).map(([key, m]) => (
            <div key={key} className="oa-role-card">
              <div className="oa-role-card-header">
                <span className={`oa-role-badge oa-role-badge--${m.color}`}>{m.icon} {m.label}</span>
              </div>
              <p className="sv-hint">{m.desc}</p>
            </div>
          ))}
        </div>

        {/* Search */}
        <input
          className="oa-search"
          placeholder="Search members…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        {loading ? (
          <div className="sv-loading">Loading members…</div>
        ) : (
          <div className="oa-member-table">
            {filtered.length === 0 && <div className="sv-empty">No members found</div>}
            {filtered.map(m => {
              const isMe       = m.user_id === currentUserId;
              const canEdit    = !isMe && (isOwner || (callerRole === 'admin' && m.role !== 'owner'));
              const canChangeToOwner = isOwner && !isMe;

              return (
                <div key={m.user_id} className={`oa-member-row ${!m.is_active ? 'oa-member-row--inactive' : ''}`}>
                  <div className="oa-member-avatar">
                    {(m.name || m.email).charAt(0).toUpperCase()}
                  </div>
                  <div className="oa-member-info">
                    <div className="oa-member-name">
                      {m.name || m.email}
                      {isMe && <span className="oa-you-tag">you</span>}
                    </div>
                    <div className="oa-member-email">{m.email}</div>
                    <div className="oa-member-meta">
                      Joined {new Date(m.joined_at).toLocaleDateString()} ·{' '}
                      {m.action_count} actions
                    </div>
                  </div>
                  <div className="oa-member-role">
                    {canEdit ? (
                      <select
                        className="oa-role-select"
                        value={m.role}
                        onChange={e => handleRoleChange(m.user_id, e.target.value)}
                      >
                        {canChangeToOwner && <option value="owner">👑 Owner</option>}
                        <option value="admin">🔑 Admin</option>
                        <option value="member">👤 Member</option>
                        <option value="viewer">👁 Viewer</option>
                      </select>
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </div>
                  <div className="oa-member-actions">
                    {canEdit && (
                      <button
                        className="oa-btn-remove"
                        onClick={() => handleRemove(m.user_id, m.name || m.email)}
                        title="Remove from org"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// INVITATIONS TAB
// ─────────────────────────────────────────────────────────────────

function OAInvitations() {
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [form, setForm]               = useState({ email: '', role: 'member', message: '' });
  const [sending, setSending]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [showForm, setShowForm]       = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.orgAdmin.getInvitations();
      setInvitations(r.data.invitations);
    } catch { setError('Failed to load invitations'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSend = async () => {
    if (!form.email.trim()) { setError('Email is required'); return; }
    try {
      setSending(true); setError('');
      await apiService.orgAdmin.sendInvitation(form);
      setSuccess(`Invitation sent to ${form.email}`);
      setForm({ email: '', role: 'member', message: '' });
      setShowForm(false);
      setTimeout(() => setSuccess(''), 4000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to send invitation');
    } finally { setSending(false); }
  };

  const handleCancel = async (id, email) => {
    if (!window.confirm(`Cancel invitation to ${email}?`)) return;
    try {
      await apiService.orgAdmin.cancelInvitation(id);
      setSuccess('Invitation cancelled');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch { setError('Failed to cancel invitation'); }
  };

  const STATUS_COLORS = { pending: 'amber', accepted: 'green', cancelled: 'grey', expired: 'red' };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>✉️ Team Invitations</h2>
          <p className="sv-panel-desc">Invite people to join your organisation. Invitations expire after 7 days.</p>
        </div>
        <button className="sv-btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? '✕ Cancel' : '+ Invite Member'}
        </button>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        {/* Invite form */}
        {showForm && (
          <div className="sv-card oa-invite-form">
            <h3>New Invitation</h3>
            <div className="sa-form-grid">
              <div className="sa-form-field sa-form-field--full">
                <label>Email Address *</label>
                <input
                  autoFocus
                  type="email"
                  placeholder="colleague@company.com"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="sa-form-field">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                  <option value="admin">🔑 Admin</option>
                  <option value="member">👤 Member</option>
                  <option value="viewer">👁 Viewer</option>
                </select>
              </div>
              <div className="sa-form-field sa-form-field--full">
                <label>Personal Message (optional)</label>
                <textarea
                  placeholder="Hey, I'd like to invite you to our CRM…"
                  value={form.message}
                  onChange={e => setForm({ ...form, message: e.target.value })}
                  rows={2}
                />
              </div>
            </div>
            <div className="oa-invite-actions">
              <p className="sv-hint">They'll receive an email with a link to join. If they don't have an account, they'll be prompted to create one.</p>
              <button className="sv-btn-primary" onClick={handleSend} disabled={sending}>
                {sending ? '⏳ Sending…' : '📨 Send Invitation'}
              </button>
            </div>
          </div>
        )}

        {/* Invitations list */}
        {loading ? (
          <div className="sv-loading">Loading invitations…</div>
        ) : invitations.length === 0 ? (
          <div className="sv-empty">No invitations sent yet</div>
        ) : (
          <div className="oa-invite-list">
            {invitations.map(inv => (
              <div key={inv.id} className="oa-invite-row">
                <div className="oa-invite-info">
                  <div className="oa-member-name">{inv.email}</div>
                  <div className="oa-member-meta">
                    <RoleBadge role={inv.role} />
                    {' '}· Invited by {inv.invited_by_email || 'admin'}
                    {' '}· {new Date(inv.created_at).toLocaleDateString()}
                    {inv.expires_at && ` · Expires ${new Date(inv.expires_at).toLocaleDateString()}`}
                  </div>
                  {inv.message && <div className="oa-invite-message">"{inv.message}"</div>}
                </div>
                <div className="oa-invite-status">
                  <span className={`sa-badge-status sa-badge-status--${STATUS_COLORS[inv.status] || 'grey'}`}>
                    {inv.status}
                  </span>
                  {inv.status === 'pending' && (
                    <button className="oa-btn-remove" onClick={() => handleCancel(inv.id, inv.email)}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORG SETTINGS TAB
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// OAPlaybooks — full playbook management for org admins
// ─────────────────────────────────────────────────────────────
function OAPlaybooks() {
  const [playbooks, setPlaybooks]       = useState([]);
  const [selectedId, setSelectedId]     = useState(null);
  const [playbook, setPlaybook]         = useState(null);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState('');
  const [success, setSuccess]           = useState('');
  const [showNewForm, setShowNewForm]   = useState(false);
  const [newPbData, setNewPbData]       = useState({ name: '', type: 'custom', description: '' });
  const [editingStage, setEditingStage] = useState(null);
  const [creating, setCreating]         = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [showCompany, setShowCompany]   = useState(false);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3500);
  };

  useEffect(() => {
    (async () => {
      try {
        const r    = await apiService.playbooks.getAll();
        const list = r.data.playbooks || [];
        setPlaybooks(list);
        const def = list.find(p => p.is_default) || list[0];
        if (def) setSelectedId(def.id);
      } catch { setError('Failed to load playbooks'); }
      finally  { setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setPlaybook(null);
    setEditingStage(null);
    setShowCompany(false);
    (async () => {
      try {
        const r   = await apiService.playbooks.getById(selectedId);
        const raw = r.data.playbook;
        if (raw?.content?.stages && !raw.content.deal_stages) {
          raw.content.deal_stages = raw.content.stages;
          delete raw.content.stages;
        }
        setPlaybook(raw);
      } catch { setError('Failed to load playbook content'); }
    })();
  }, [selectedId]);

  const handleSave = async () => {
    if (!playbook) return;
    setSaving(true);
    try {
      await apiService.playbooks.update(selectedId, {
        name:        playbook.name,
        description: playbook.description,
        content:     playbook.content
      });
      setPlaybooks(prev => prev.map(p => p.id === selectedId ? { ...p, name: playbook.name, description: playbook.description } : p));
      flash('success', 'Playbook saved ✓');
    } catch { flash('error', 'Failed to save playbook'); }
    finally  { setSaving(false); }
  };

  const handleSetDefault = async (id) => {
    try {
      await apiService.playbooks.setDefault(id);
      setPlaybooks(prev => prev.map(p => ({ ...p, is_default: p.id === id })));
      if (playbook && playbook.id === id) setPlaybook({ ...playbook, is_default: true });
      flash('success', 'Default playbook updated ✓');
    } catch { flash('error', 'Failed to set default'); }
  };

  const handleCreate = async () => {
    if (!newPbData.name.trim()) { flash('error', 'Name is required'); return; }
    setCreating(true);
    try {
      const r  = await apiService.playbooks.create({ ...newPbData, content: { deal_stages: {}, company: {} } });
      const nb = r.data.playbook;
      setPlaybooks(prev => [...prev, nb]);
      setSelectedId(nb.id);
      setShowNewForm(false);
      setNewPbData({ name: '', type: 'custom', description: '' });
      flash('success', 'Playbook created ✓');
    } catch { flash('error', 'Failed to create playbook'); }
    finally  { setCreating(false); }
  };

  const handleDelete = async (id) => {
    const pb = playbooks.find(p => p.id === id);
    if (pb?.is_default) { flash('error', 'Set another playbook as default before deleting this one'); return; }
    if (!window.confirm(`Delete "${pb?.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await apiService.playbooks.delete(id);
      const remaining = playbooks.filter(p => p.id !== id);
      setPlaybooks(remaining);
      if (selectedId === id) setSelectedId(remaining[0]?.id || null);
      flash('success', 'Playbook deleted');
    } catch (e) { flash('error', e?.response?.data?.error?.message || 'Failed to delete playbook'); }
    finally     { setDeleting(false); }
  };

  const stagesSource = playbook?.content?.deal_stages || playbook?.content?.stages;
  const stagesArray  = stagesSource
    ? Array.isArray(stagesSource)
      ? stagesSource
      : Object.entries(stagesSource).map(([id, val]) => ({ id, ...val }))
    : [];

  const updateStageField = (stageId, fieldKey, value) => {
    const ds = playbook.content.deal_stages || playbook.content.stages || {};
    if (Array.isArray(ds)) {
      setPlaybook({ ...playbook, content: { ...playbook.content, deal_stages: ds.map(s => (s.id === stageId || s.name === stageId) ? { ...s, [fieldKey]: value } : s) } });
    } else {
      setPlaybook({ ...playbook, content: { ...playbook.content, deal_stages: { ...ds, [stageId]: { ...ds[stageId], [fieldKey]: value } } } });
    }
  };

  const TYPE_LABELS = { market: '🌍 Market', product: '📦 Product', custom: '⚙️ Custom' };
  const TYPE_COLORS = { market: '#3182ce', product: '#38a169', custom: '#718096' };

  if (loading) return <div className="sv-loading">Loading playbooks...</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📘 Sales Playbooks</h2>
          <p className="sv-panel-desc">Create and manage playbooks per market or product. Each deal can use a specific playbook; the default is used when none is selected.</p>
        </div>
        <button className="sv-btn-primary" onClick={() => setShowNewForm(true)}>+ New Playbook</button>
      </div>

      {error   && <div className="sv-alert sv-alert-error">{error}</div>}
      {success && <div className="sv-alert sv-alert-success">{success}</div>}

      {showNewForm && (
        <div className="sv-card oa-pb-new-form">
          <h4 style={{ marginTop: 0, marginBottom: 16 }}>New Playbook</h4>
          <div className="oa-pb-form-grid">
            <div className="sv-field">
              <label>Name</label>
              <input className="sv-input" placeholder="e.g. EMEA Enterprise"
                value={newPbData.name} onChange={e => setNewPbData(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="sv-field">
              <label>Type</label>
              <select className="sv-input" value={newPbData.type} onChange={e => setNewPbData(p => ({ ...p, type: e.target.value }))}>
                <option value="market">🌍 Market</option>
                <option value="product">📦 Product</option>
                <option value="custom">⚙️ Custom</option>
              </select>
            </div>
          </div>
          <div className="sv-field" style={{ marginTop: 12 }}>
            <label>Description (optional)</label>
            <input className="sv-input" placeholder="e.g. For deals in EMEA region"
              value={newPbData.description} onChange={e => setNewPbData(p => ({ ...p, description: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="sv-btn-primary" onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create Playbook'}
            </button>
            <button className="sv-btn sv-btn-secondary" onClick={() => setShowNewForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="oa-pb-layout">
        {/* Sidebar */}
        <div className="oa-pb-sidebar">
          {playbooks.length === 0
            ? <div className="sv-empty">No playbooks yet. Create one above.</div>
            : playbooks.map(pb => (
              <div key={pb.id}
                className={`oa-pb-list-item ${selectedId === pb.id ? 'active' : ''}`}
                onClick={() => setSelectedId(pb.id)}>
                <div className="oa-pb-list-main">
                  <span className="oa-pb-list-name">{pb.name}</span>
                  {pb.is_default && <span className="oa-pb-star" title="Default">★</span>}
                </div>
                <span style={{ fontSize: 11, color: TYPE_COLORS[pb.type], fontWeight: 600 }}>{TYPE_LABELS[pb.type]}</span>
                {selectedId === pb.id && (
                  <div className="oa-pb-item-actions">
                    {!pb.is_default && (
                      <button className="oa-pb-link" onClick={e => { e.stopPropagation(); handleSetDefault(pb.id); }}>
                        Set default
                      </button>
                    )}
                    {!pb.is_default && (
                      <button className="oa-pb-link oa-pb-link--danger" onClick={e => { e.stopPropagation(); handleDelete(pb.id); }} disabled={deleting}>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
          }
        </div>

        {/* Editor */}
        <div className="oa-pb-editor">
          {!playbook ? (
            <div className="sv-loading">Select a playbook to edit</div>
          ) : (
            <>
              {/* Header row with name/desc editable inline */}
              <div className="oa-pb-editor-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <input
                      className="oa-pb-name-input"
                      value={playbook.name}
                      onChange={e => setPlaybook({ ...playbook, name: e.target.value })}
                      placeholder="Playbook name"
                    />
                    {playbook.is_default && <span className="oa-pb-default-badge">Default</span>}
                    <span style={{ fontSize: 12, fontWeight: 600, color: TYPE_COLORS[playbook.type] }}>{TYPE_LABELS[playbook.type]}</span>
                  </div>
                  <input
                    className="oa-pb-desc-input"
                    value={playbook.description || ''}
                    onChange={e => setPlaybook({ ...playbook, description: e.target.value })}
                    placeholder="Description (optional)"
                  />
                </div>
                <button className="sv-btn-primary" onClick={handleSave} disabled={saving} style={{ flexShrink: 0 }}>
                  {saving ? '⏳ Saving...' : '💾 Save'}
                </button>
              </div>

              {/* Company context — collapsible */}
              {playbook.content && (
                <div className="sv-card" style={{ marginBottom: 16 }}>
                  <div className="oa-pb-section-header" onClick={() => setShowCompany(v => !v)}>
                    <span>🏢 Company Context</span>
                    {!showCompany && (playbook.content?.company?.name || playbook.content?.company?.industry || playbook.content?.company?.product) && (
                      <span className="oa-pb-summary">
                        {[playbook.content.company.name, playbook.content.company.industry, playbook.content.company.product].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', color: '#a0aec0' }}>{showCompany ? '▲' : '▼'}</span>
                  </div>
                  {showCompany && (
                    <div style={{ marginTop: 14 }}>
                      {['name', 'industry', 'product'].map(field => (
                        <div key={field} className="sv-field" style={{ marginBottom: 12 }}>
                          <label style={{ textTransform: 'capitalize' }}>{field}</label>
                          <input className="sv-input"
                            value={playbook.content?.company?.[field] || ''}
                            onChange={e => setPlaybook({ ...playbook, content: { ...playbook.content, company: { ...playbook.content.company, [field]: e.target.value } } })} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Deal stages */}
              <div className="sv-card">
                <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15 }}>📋 Deal Stages</h4>
                {stagesArray.length === 0 ? (
                  <div className="sv-empty">No stages in this playbook yet. Save after adding content.</div>
                ) : (
                  <div className="sv-stages-list">
                    {stagesArray.map((stage, i) => {
                      const stageId = stage.id || stage.name || String(i);
                      return (
                        <div key={stageId} className="sv-stage-row">
                          <div className="sv-stage-header"
                            onClick={() => setEditingStage(editingStage === stageId ? null : stageId)}>
                            <span className="sv-stage-num">{i + 1}</span>
                            <span className="sv-stage-name">{stage.name || stageId}</span>
                            <span className="sv-hint sv-stage-goal">
                              {stage.goal?.substring(0, 60)}{stage.goal?.length > 60 ? '…' : ''}
                            </span>
                            <span className="sv-expand-btn">{editingStage === stageId ? '▲' : '▼'}</span>
                          </div>
                          {editingStage === stageId && (
                            <div className="sv-stage-detail">
                              {Object.entries(stage)
                                .filter(([k]) => k !== 'id' && k !== 'key_actions' && k !== 'success_criteria')
                                .map(([key, val]) => (
                                  <div key={key} className="sv-field" style={{ marginBottom: 10 }}>
                                    <label style={{ textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</label>
                                    <input className="sv-input" value={val || ''}
                                      onChange={e => updateStageField(stageId, key, e.target.value)} />
                                  </div>
                                ))}
                              {Array.isArray(stage.key_actions) && (
                                <div className="sv-field" style={{ marginTop: 8 }}>
                                  <label>Key Actions</label>
                                  {stage.key_actions.map((action, ai) => (
                                    <div key={ai} className="oa-pb-action-row">
                                      <span className="oa-pb-action-num">{ai + 1}</span>
                                      <textarea
                                        className="sv-input oa-pb-action-textarea"
                                        value={action}
                                        rows={Math.max(1, Math.ceil(action.length / 60))}
                                        onChange={e => {
                                          const a = [...stage.key_actions];
                                          a[ai] = e.target.value;
                                          updateStageField(stageId, 'key_actions', a);
                                        }}
                                      />
                                      <button className="oa-pb-action-remove"
                                        onClick={() => updateStageField(stageId, 'key_actions', stage.key_actions.filter((_, idx) => idx !== ai))}
                                        title="Remove action">×</button>
                                    </div>
                                  ))}
                                  <button className="oa-pb-add-action"
                                    onClick={() => updateStageField(stageId, 'key_actions', [...stage.key_actions, ''])}>
                                    + Add action
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OASettings() {
  const [org, setOrg]       = useState(null);
  const [name, setName]     = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    apiService.orgAdmin.getProfile()
      .then(r => { setOrg(r.data.org); setName(r.data.org.name); })
      .catch(() => setError('Failed to load org'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!name.trim()) { setError('Name cannot be empty'); return; }
    try {
      setSaving(true); setError('');
      await apiService.orgAdmin.updateProfile({ name: name.trim() });
      setSuccess('Organisation name updated ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>⚙️ Organisation Settings</h2>
          <p className="sv-panel-desc">Settings that apply to all members of your organisation.</p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        <div className="sv-section">
          {/* Org name */}
          <div className="sv-card">
            <h3>Organisation Name</h3>
            <p className="sv-hint">This name appears throughout the application and in invitation emails.</p>
            <div className="oa-name-row">
              <input
                className="oa-input"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSave()}
              />
              <button className="sv-btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? '⏳ Saving…' : '💾 Save'}
              </button>
            </div>
          </div>

          {/* Read-only plan info */}
          {org && (
            <div className="sv-card">
              <h3>Plan & Limits</h3>
              <p className="sv-hint">To upgrade your plan or change seat limits, contact ActionCRM support.</p>
              <div className="oa-plan-grid">
                <div className="oa-plan-item">
                  <span className="oa-plan-label">Current plan</span>
                  <span className="sa-plan-pill">{org.plan}</span>
                </div>
                <div className="oa-plan-item">
                  <span className="oa-plan-label">Status</span>
                  <span className={`sa-badge-status sa-badge-status--${org.status === 'active' ? 'green' : 'red'}`}>{org.status}</span>
                </div>
                <div className="oa-plan-item">
                  <span className="oa-plan-label">User seats</span>
                  <span className="oa-plan-value">{org.max_users} seats</span>
                </div>
                <div className="oa-plan-item">
                  <span className="oa-plan-label">Member since</span>
                  <span className="oa-plan-value">{new Date(org.created_at).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          )}

          {/* Danger zone */}
          <div className="sv-card oa-danger-card">
            <h3>⚠️ Need to transfer ownership?</h3>
            <p className="sv-hint">
              To transfer the organisation to a new owner, go to the <strong>Members</strong> tab, select the new owner, and change their role to <strong>Owner</strong>. You will remain as an Admin.
              Only one user can hold the Owner role at a time.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── OADealRoles ───────────────────────────────────────────────────────────────
// Lets org admins manage which deal team roles are available in their org.
// System roles can be toggled active/inactive but not renamed or deleted.
// Custom roles can be created, renamed, and deleted.

const API_OA = process.env.REACT_APP_API_URL || '';

function apiFetchOA(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API_OA}${path}`, {
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

function OADealRoles() {
  const [roles,    setRoles]    = React.useState([]);
  const [loading,  setLoading]  = React.useState(true);
  const [error,    setError]    = React.useState('');
  const [success,  setSuccess]  = React.useState('');
  const [newName,  setNewName]  = React.useState('');
  const [adding,   setAdding]   = React.useState(false);
  const [editId,   setEditId]   = React.useState(null);
  const [editName, setEditName] = React.useState('');

  React.useEffect(() => {
    apiFetchOA('/deal-roles')
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
      const r = await apiFetchOA(`/deal-roles/${role.id}`, {
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
      const r = await apiFetchOA(`/deal-roles/${role.id}`, {
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
      await apiFetchOA(`/deal-roles/${role.id}`, { method: 'DELETE' });
      setRoles(prev => prev.filter(ro => ro.id !== role.id));
      flash('success', 'Role deleted');
    } catch (e) { flash('error', e.message); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const r = await apiFetchOA('/deal-roles', {
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
          <h2>🎭 Deal Team Roles</h2>
          <p className="sv-panel-desc">
            Define the roles available when adding members to a deal team.
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
            <p className="sv-hint">Built-in roles. Toggle to hide from the role picker — cannot be renamed or deleted.</p>
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
            <p className="sv-hint">Create roles specific to your organisation. Click a name to rename it.</p>

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


// ── OADealStages ──────────────────────────────────────────────────────────────
const STAGE_TYPES = [
  { value: 'discovery',     label: 'Discovery' },
  { value: 'qualification', label: 'Qualification' },
  { value: 'evaluation',    label: 'Evaluation' },
  { value: 'proposal',      label: 'Proposal' },
  { value: 'negotiation',   label: 'Negotiation' },
  { value: 'legal_review',  label: 'Legal Review' },
  { value: 'closed_won',    label: 'Closed Won' },
  { value: 'closed_lost',   label: 'Closed Lost' },
  { value: 'custom',        label: 'Custom' },
];

function OADealStages() {
  const [stages, setStages]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(null);
  const [error, setError]         = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName]   = useState('');
  const [showAdd, setShowAdd]     = useState(false);
  const [newStage, setNewStage]   = useState({ name: '', stage_type: 'custom', is_terminal: false });
  const [addError, setAddError]   = useState('');

  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const API   = process.env.REACT_APP_API_URL || '';

  const apiFetch = useCallback(async (path, options = {}) => {
    const res = await fetch(`${API}/api/deal-stages${path}`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...options,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || res.statusText);
    return data;
  }, [API, token]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('');
      setStages(data.stages || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  const saveStage = async (id, updates) => {
    setSaving(id);
    try {
      const data = await apiFetch(`/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      });
      setStages(prev => prev.map(s => s.id === id ? data.stage : s));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(null);
    }
  };

  const commitRename = async (id) => {
    if (editName.trim()) await saveStage(id, { name: editName.trim() });
    setEditingId(null);
  };

  const moveStage = async (id, direction) => {
    const idx     = stages.findIndex(s => s.id === id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= stages.length) return;

    const updated = [...stages];
    const orderA  = updated[idx].sort_order;
    const orderB  = updated[swapIdx].sort_order;

    // Optimistic update
    updated[idx]     = { ...updated[idx],     sort_order: orderB };
    updated[swapIdx] = { ...updated[swapIdx], sort_order: orderA };
    updated.sort((a, b) => a.sort_order - b.sort_order);
    setStages(updated);

    // Persist both
    await Promise.all([
      saveStage(id,                  { sort_order: orderB }),
      saveStage(stages[swapIdx].id,  { sort_order: orderA }),
    ]);
  };

  const toggleActive = async (stage) => {
    if (stage.is_system && stage.is_active) {
      if (!window.confirm(`Deactivating "${stage.name}" will hide it from deal forms. Continue?`)) return;
    }
    await saveStage(stage.id, { is_active: !stage.is_active });
  };

  const deleteStage = async (stage) => {
    if (!window.confirm(`Delete "${stage.name}"? This cannot be undone.`)) return;
    setSaving(stage.id);
    try {
      await apiFetch(`/${stage.id}`, { method: 'DELETE' });
      setStages(prev => prev.filter(s => s.id !== stage.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(null);
    }
  };

  const handleAdd = async () => {
    setAddError('');
    if (!newStage.name.trim()) { setAddError('Name is required'); return; }
    setSaving('new');
    try {
      const data = await apiFetch('', {
        method: 'POST',
        body: JSON.stringify(newStage),
      });
      setStages(prev => [...prev, data.stage]);
      setNewStage({ name: '', stage_type: 'custom', is_terminal: false });
      setShowAdd(false);
    } catch (e) {
      setAddError(e.message);
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <div style={{ padding: 32 }}>Loading stages…</div>;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 700 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: 0 }}>🏷️ Deal Stages</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
            Configure your pipeline stages. Rename or reorder freely — keys never change so existing deals are unaffected.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          style={{ padding: '8px 16px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
        >
          + Add Stage
        </button>
      </div>

      {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 6, marginBottom: 12 }}>⚠️ {error}</div>}

      {/* Add form */}
      {showAdd && (
        <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 12px' }}>New Stage</h4>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Name</label>
              <input
                value={newStage.name}
                onChange={e => setNewStage(s => ({ ...s, name: e.target.value }))}
                placeholder="e.g. Security Review"
                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, width: 200 }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Stage Type</label>
              <select
                value={newStage.stage_type}
                onChange={e => setNewStage(s => ({ ...s, stage_type: e.target.value }))}
                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
              >
                {STAGE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 2 }}>
              <input
                type="checkbox"
                id="is_terminal"
                checked={newStage.is_terminal}
                onChange={e => setNewStage(s => ({ ...s, is_terminal: e.target.checked }))}
              />
              <label htmlFor="is_terminal" style={{ fontSize: 13 }}>Terminal (won/lost)</label>
            </div>
            <button
              onClick={handleAdd}
              disabled={saving === 'new'}
              style={{ padding: '7px 16px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
            >
              {saving === 'new' ? 'Adding…' : 'Add'}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              style={{ padding: '7px 12px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
          {addError && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>⚠️ {addError}</div>}
        </div>
      )}

      {/* Stages list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {stages.map((stage, idx) => (
          <div
            key={stage.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: stage.is_active ? '#fff' : '#f9fafb',
              border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px',
              opacity: stage.is_active ? 1 : 0.6,
            }}
          >
            {/* Reorder */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button onClick={() => moveStage(stage.id, 'up')}   disabled={idx === 0 || !!saving} style={arrowBtn}>▲</button>
              <button onClick={() => moveStage(stage.id, 'down')} disabled={idx === stages.length - 1 || !!saving} style={arrowBtn}>▼</button>
            </div>

            {/* Name */}
            <div style={{ flex: 1 }}>
              {editingId === stage.id ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onBlur={() => commitRename(stage.id)}
                  onKeyDown={e => { if (e.key === 'Enter') commitRename(stage.id); if (e.key === 'Escape') setEditingId(null); }}
                  style={{ padding: '4px 8px', border: '1px solid #6366f1', borderRadius: 4, fontSize: 14, width: '100%' }}
                />
              ) : (
                <span
                  onClick={() => { setEditingId(stage.id); setEditName(stage.name); }}
                  style={{ fontWeight: 500, cursor: 'text' }}
                  title="Click to rename"
                >
                  {stage.name}
                  <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>✏️</span>
                </span>
              )}
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                key: <code>{stage.key}</code>
                {' · '}{STAGE_TYPES.find(t => t.value === stage.stage_type)?.label || stage.stage_type}
                {stage.is_terminal && ' · 🏁 terminal'}
                {stage.is_system   && ' · 🔒 system'}
              </div>
            </div>

            {/* Active toggle */}
            <button
              onClick={() => toggleActive(stage)}
              disabled={!!saving}
              title={stage.is_active ? 'Deactivate' : 'Activate'}
              style={{
                padding: '4px 10px', fontSize: 12, borderRadius: 12, cursor: 'pointer', border: 'none',
                background: stage.is_active ? '#dcfce7' : '#f3f4f6',
                color:      stage.is_active ? '#166534' : '#6b7280',
              }}
            >
              {stage.is_active ? '● Active' : '○ Inactive'}
            </button>

            {/* Delete (custom stages only) */}
            {!stage.is_system && (
              <button
                onClick={() => deleteStage(stage)}
                disabled={saving === stage.id}
                title="Delete stage"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#ef4444' }}
              >
                🗑️
              </button>
            )}

            {saving === stage.id && <span style={{ fontSize: 12, color: '#6b7280' }}>saving…</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const arrowBtn = {
  background: 'none', border: '1px solid #e5e7eb', borderRadius: 3,
  cursor: 'pointer', fontSize: 10, padding: '1px 4px', color: '#6b7280',
  lineHeight: 1,
};
