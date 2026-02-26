import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './OrgAdminView.css';
import DealHealthSettings from './DealHealthSettings';
import OAProspectStages from './OAProspectStages';

// ═══════════════════════════════════════════════════════════════════
// ORG ADMIN VIEW — per-organisation administration
// Accessible to org owners and admins only.
// The SettingsView handles AI/playbook/deal-health configuration —
// this view handles PEOPLE, ROLES, INVITATIONS, and ORG SETTINGS.
// ═══════════════════════════════════════════════════════════════════

const NAV_GROUPS = [
  {
    label: 'Team',
    items: [
      { id: 'members',     icon: '👥', label: 'Members' },
      { id: 'hierarchy',   icon: '🏢', label: 'Hierarchy' },
      { id: 'invitations', icon: '✉️', label: 'Invitations' },
    ],
  },
  {
    label: 'Sales Process',
    items: [
      { id: 'playbooks',   icon: '📘', label: 'Playbooks' },
      { id: 'deal-stages', icon: '🏷️', label: 'Deal Stages' },
      { id: 'deal-roles',  icon: '🎭', label: 'Deal Roles' },
      { id: 'prospect-stages', icon: '🔬', label: 'Prospect Stages' },
    ],
  },
  {
    label: 'Sales Execution Insights',
    items: [
      { id: 'health',      icon: '🏥', label: 'Deal Health' },
    ],
  },
  {
    label: 'Auto Action Execution',
    items: [
      { id: 'ai-agent',    icon: '🤖', label: 'AI Agent' },
    ],
  },
  {
    label: 'Data Quality',
    items: [
      { id: 'duplicates',  icon: '🔍', label: 'Duplicates' },
    ],
  },
  {
    label: 'General',
    items: [
      { id: 'integrations', icon: '🔌', label: 'Integrations' },
      { id: 'settings',    icon: '⚙️', label: 'Org Settings' },
    ],
  },
];

// Content descriptions for the top bar
const TAB_META = {
  members:       { title: 'Members',       desc: 'Manage team members, roles, and permissions' },
  hierarchy:     { title: 'Hierarchy',     desc: 'Reporting structure and team visibility' },
  invitations:   { title: 'Invitations',   desc: 'Invite new members to your organisation' },
  playbooks:     { title: 'Playbooks',     desc: 'Configure deal playbooks and templates' },
  'deal-stages': { title: 'Deal Stages',   desc: 'Customise your pipeline stages' },
  'deal-roles':  { title: 'Deal Roles',    desc: 'Define contact roles in deals' },
  'prospect-stages': { title: 'Prospect Stages', desc: 'Customise your prospecting lifecycle stages' },
  health:        { title: 'Deal Health',   desc: 'Configure health scoring parameters' },
  duplicates:    { title: 'Duplicates',    desc: 'Duplicate detection rules and visibility' },
  'ai-agent':    { title: 'AI Agent',      desc: 'Agentic framework settings and token usage' },
  integrations:  { title: 'Integrations',  desc: 'Manage org-wide email, calendar, and cloud connections' },
  settings:      { title: 'Org Settings',  desc: 'Organisation name, plan, and preferences' },
};

export default function OrgAdminView() {
  const [tab, setTab]       = useState('members');
  const [stats, setStats]   = useState(null);
  const [orgName, setOrgName] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    apiService.orgAdmin.getStats()
      .then(r => setStats(r.data))
      .catch(console.error);
    apiService.orgAdmin.getProfile()
      .then(r => setOrgName(r.data.org.name))
      .catch(console.error);
  }, []);

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
  const meta = TAB_META[tab] || TAB_META.members;

  return (
    <div className="oa-layout">
      {/* ── Sidebar ── */}
      <nav className={`oa-sidebar ${sidebarCollapsed ? 'oa-sidebar--collapsed' : ''}`}>
        <div className="oa-sidebar-header">
          {!sidebarCollapsed && <span className="oa-sidebar-title">{orgName || 'Admin'}</span>}
          <button
            className="oa-sidebar-toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>

        <div className="oa-sidebar-nav">
          {NAV_GROUPS.map(group => (
            <div key={group.label} className="oa-nav-group">
              {!sidebarCollapsed && <div className="oa-nav-group-label">{group.label}</div>}
              {group.items.map(item => (
                <button
                  key={item.id}
                  className={`oa-nav-item ${tab === item.id ? 'oa-nav-item--active' : ''}`}
                  onClick={() => setTab(item.id)}
                  title={sidebarCollapsed ? item.label : undefined}
                >
                  <span className="oa-nav-icon">{item.icon}</span>
                  {!sidebarCollapsed && <span className="oa-nav-label">{item.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        {!sidebarCollapsed && (
          <div className="oa-sidebar-footer">Organisation Admin</div>
        )}
      </nav>

      {/* ── Main Content ── */}
      <main className="oa-main">
        <div className="oa-topbar">
          <h1 className="oa-topbar-title">{meta.title}</h1>
          <p className="oa-topbar-desc">{meta.desc}</p>
        </div>

        <div className="oa-content">
          {/* Stats cards — show on members tab */}
          {tab === 'members' && stats && (
            <div className="oa-stats-grid">
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Active Members</div>
                <div className="oa-stat-card-value" style={{ color: '#059669' }}>{stats.members.active}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Pending Invites</div>
                <div className="oa-stat-card-value" style={{ color: '#d97706' }}>{stats.invitations.total}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Total Deals</div>
                <div className="oa-stat-card-value" style={{ color: '#4338ca' }}>{stats.deals.total}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Actions (7d)</div>
                <div className="oa-stat-card-value" style={{ color: '#0284c7' }}>{stats.actions.week}</div>
              </div>
            </div>
          )}

          <div className="oa-tab-content">
            {tab === 'members'     && <OAMembers currentUserId={currentUser.id} />}
            {tab === 'hierarchy'   && <OAHierarchy />}
            {tab === 'invitations' && <OAInvitations />}
            {tab === 'playbooks'   && <OAPlaybooks />}
            {tab === 'health'      && <DealHealthSettings />}
            {tab === 'deal-stages' && <OADealStages />}
            {tab === 'deal-roles'  && <OADealRoles />}
            {tab === 'prospect-stages' && <OAProspectStages />}
            {tab === 'ai-agent'    && <OAAgentSettings />}
            {tab === 'duplicates'  && <OADuplicateSettings />}
            {tab === 'integrations' && <OAIntegrations />}
            {tab === 'settings'    && <OASettings />}
          </div>
        </div>
      </main>
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
// HIERARCHY TAB — visual org tree with drag-drop & matrix reporting
// ─────────────────────────────────────────────────────────────────

const HIERARCHY_ROLES = [
  { value: 'vp',       label: 'VP',       color: '#7c3aed' },
  { value: 'director', label: 'Director', color: '#2563eb' },
  { value: 'manager',  label: 'Manager',  color: '#059669' },
  { value: 'rep',      label: 'Rep',      color: '#64748b' },
];

function HierarchyRoleBadge({ role }) {
  const r = HIERARCHY_ROLES.find(h => h.value === role) || { label: role || 'Rep', color: '#64748b' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: '12px',
      fontSize: '11px', fontWeight: 600, color: '#fff',
      background: r.color, letterSpacing: '0.02em',
    }}>
      {r.label}
    </span>
  );
}

function OAHierarchy() {
  const [tree, setTree]         = useState([]);
  const [members, setMembers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [editing, setEditing]   = useState(null);
  const [editForm, setEditForm] = useState({ reportsTo: '', hierarchyRole: 'rep', relationshipType: 'solid' });
  const [saving, setSaving]     = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [dragUserId, setDragUserId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [showDotted, setShowDotted] = useState(true);
  const [addingDotted, setAddingDotted] = useState(null); // userId to add dotted line to

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [hierRes, membersRes] = await Promise.all([
        apiService.orgAdmin.getHierarchy(),
        apiService.orgAdmin.getMembers(),
      ]);
      setTree(hierRes.data.hierarchy || []);
      setMembers(membersRes.data.members || []);
    } catch { setError('Failed to load hierarchy'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Build tree from flat list ────────────────────────────
  const buildTreeNodes = (flatList, allMembers) => {
    // Separate solid and dotted relationships
    const solidRows = flatList.filter(r => r.relationship_type !== 'dotted');
    const dottedRows = flatList.filter(r => r.relationship_type === 'dotted');

    const map = {};
    const roots = [];

    // Create nodes from solid rows
    const solidUserIds = new Set();
    for (const node of solidRows) {
      solidUserIds.add(node.user_id);
      if (!map[node.user_id]) {
        map[node.user_id] = { ...node, children: [], dottedManagers: [], dottedReports: [] };
      } else {
        Object.assign(map[node.user_id], node);
      }
    }

    // Build parent-child from solid lines
    for (const node of solidRows) {
      if (node.reports_to && map[node.reports_to]) {
        map[node.reports_to].children.push(map[node.user_id]);
      } else {
        roots.push(map[node.user_id]);
      }
    }

    // Attach dotted-line metadata
    for (const d of dottedRows) {
      if (map[d.user_id]) {
        map[d.user_id].dottedManagers.push({
          managerId: d.reports_to,
          managerName: flatList.find(n => n.user_id === d.reports_to)
            ? `${flatList.find(n => n.user_id === d.reports_to).first_name || ''} ${flatList.find(n => n.user_id === d.reports_to).last_name || ''}`.trim()
            : `User #${d.reports_to}`,
        });
      }
      if (map[d.reports_to]) {
        map[d.reports_to].dottedReports.push({
          userId: d.user_id,
          userName: map[d.user_id]
            ? `${map[d.user_id].first_name || ''} ${map[d.user_id].last_name || ''}`.trim()
            : `User #${d.user_id}`,
        });
      }
    }

    const inHierarchy = solidUserIds;
    const unassigned = allMembers.filter(m => !inHierarchy.has(m.user_id) && m.is_active);

    return { roots, unassigned, map, dottedRows };
  };

  const { roots, unassigned, map: nodeMap, dottedRows } = buildTreeNodes(tree, members);

  const toggleCollapse = (userId) => setCollapsed(p => ({ ...p, [userId]: !p[userId] }));

  // ── Editing ────────────────────────────────────────────────
  const startEdit = (node) => {
    setEditing(node.user_id);
    setEditForm({
      reportsTo: node.reports_to || '',
      hierarchyRole: node.hierarchy_role || 'rep',
      relationshipType: 'solid',
    });
  };
  const cancelEdit = () => { setEditing(null); setAddingDotted(null); };

  const saveEdit = async (userId) => {
    try {
      setSaving(true);
      await apiService.orgAdmin.updateHierarchy(userId, {
        reportsTo: editForm.reportsTo ? parseInt(editForm.reportsTo) : null,
        hierarchyRole: editForm.hierarchyRole,
        relationshipType: editForm.relationshipType || 'solid',
      });
      setSuccess('Hierarchy updated');
      setTimeout(() => setSuccess(''), 2500);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update');
      setTimeout(() => setError(''), 3000);
    } finally { setSaving(false); }
  };

  const addToHierarchy = async (userId) => {
    try {
      await apiService.orgAdmin.updateHierarchy(userId, { reportsTo: null, hierarchyRole: 'rep' });
      setSuccess('Added to hierarchy');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) { setError(err.response?.data?.error?.message || 'Failed to add'); }
  };

  const removeFromHierarchy = async (userId, name) => {
    if (!window.confirm(`Remove ${name} from the hierarchy? Their direct reports will be re-parented.`)) return;
    try {
      await apiService.orgAdmin.removeFromHierarchy(userId);
      setSuccess('Removed');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) { setError(err.response?.data?.error?.message || 'Failed to remove'); }
  };

  // ── Dotted line management ────────────────────────────────
  const saveDottedLine = async (userId) => {
    if (!editForm.reportsTo) return;
    try {
      setSaving(true);
      await apiService.orgAdmin.updateHierarchy(userId, {
        reportsTo: parseInt(editForm.reportsTo),
        hierarchyRole: editForm.hierarchyRole,
        relationshipType: 'dotted',
      });
      setSuccess('Dotted line added');
      setTimeout(() => setSuccess(''), 2000);
      setAddingDotted(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to add dotted line');
      setTimeout(() => setError(''), 3000);
    } finally { setSaving(false); }
  };

  const removeDottedLine = async (userId, managerId) => {
    try {
      await apiService.orgAdmin.removeDottedLine(userId, managerId);
      setSuccess('Dotted line removed');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) { setError('Failed to remove dotted line'); }
  };

  // ── Drag & Drop ────────────────────────────────────────────
  const handleDragStart = (e, userId) => {
    setDragUserId(userId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(userId));
  };

  const handleDragOver = (e, targetUserId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (targetUserId !== dragUserId) {
      setDropTarget(targetUserId);
    }
  };

  const handleDragLeave = () => setDropTarget(null);

  const handleDrop = async (e, newManagerId) => {
    e.preventDefault();
    setDropTarget(null);
    const userId = parseInt(e.dataTransfer.getData('text/plain'));
    if (!userId || userId === newManagerId) return;

    try {
      await apiService.orgAdmin.updateHierarchy(userId, {
        reportsTo: newManagerId || null,
        hierarchyRole: nodeMap[userId]?.hierarchy_role || 'rep',
        relationshipType: 'solid',
      });
      setSuccess('Moved successfully');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to move');
      setTimeout(() => setError(''), 3000);
    }
    setDragUserId(null);
  };

  const handleDropToRoot = async (e) => {
    e.preventDefault();
    setDropTarget(null);
    const userId = parseInt(e.dataTransfer.getData('text/plain'));
    if (!userId) return;
    try {
      await apiService.orgAdmin.updateHierarchy(userId, {
        reportsTo: null,
        hierarchyRole: nodeMap[userId]?.hierarchy_role || 'rep',
        relationshipType: 'solid',
      });
      setSuccess('Moved to top level');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) { setError(err.response?.data?.error?.message || 'Move failed'); }
    setDragUserId(null);
  };

  // Available managers for dropdowns
  const solidNodes = tree.filter(r => r.relationship_type !== 'dotted');
  const availableManagers = solidNodes.filter(n => n.user_id !== editing && n.user_id !== addingDotted);

  // ── Connector styles ────────────────────────────────────────
  const connectorStyle = (depth) => ({
    position: 'relative',
    marginLeft: depth > 0 ? 28 : 0,
    paddingLeft: depth > 0 ? 20 : 0,
    borderLeft: depth > 0 ? '2px solid #c7d2fe' : 'none',
  });

  // ── Render a tree node ─────────────────────────────────────
  const renderNode = (node, depth = 0) => {
    const isEditing = editing === node.user_id;
    const isAddingDotted = addingDotted === node.user_id;
    const isCollapsed = collapsed[node.user_id];
    const hasChildren = node.children?.length > 0;
    const isDragOver = dropTarget === node.user_id;
    const name = `${node.first_name || ''} ${node.last_name || ''}`.trim() || node.email;

    return (
      <div key={node.user_id} style={connectorStyle(depth)}>
        {/* Horizontal connector tick */}
        {depth > 0 && <div style={{
          position: 'absolute', left: '-2px', top: '22px',
          width: '20px', height: '0', borderTop: '2px solid #c7d2fe',
        }} />}

        {/* Node card */}
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, node.user_id)}
          onDragOver={(e) => handleDragOver(e, node.user_id)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, node.user_id)}
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 14px', margin: '3px 0', borderRadius: '10px',
            background: isDragOver ? '#e0e7ff' : isEditing ? '#f0f0ff' : '#fff',
            border: isDragOver ? '2px dashed #818cf8' : isEditing ? '1.5px solid #818cf8' : '1px solid #e8e9ee',
            cursor: 'grab', transition: 'all 0.15s',
            boxShadow: isDragOver ? '0 0 0 3px rgba(99,102,241,0.15)' : 'none',
          }}
        >
          {/* Expand/collapse */}
          <button
            onClick={(e) => { e.stopPropagation(); hasChildren && toggleCollapse(node.user_id); }}
            style={{
              width: '22px', height: '22px', border: 'none', background: hasChildren ? '#f0f0ff' : 'none',
              borderRadius: '4px', cursor: hasChildren ? 'pointer' : 'default',
              fontSize: '11px', color: hasChildren ? '#4338ca' : '#d1d5db', fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {hasChildren ? (isCollapsed ? '▸' : '▾') : '·'}
          </button>

          {/* Avatar */}
          <div style={{
            width: '34px', height: '34px', borderRadius: '50%',
            background: depth === 0 ? '#ddd6fe' : '#e0e7ff',
            color: depth === 0 ? '#5b21b6' : '#4338ca', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', flexShrink: 0,
          }}>
            {(node.first_name?.[0] || '?').toUpperCase()}
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '13px', color: '#1a1a2e', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {name}
              {/* Dotted-line indicators */}
              {showDotted && node.dottedManagers?.length > 0 && (
                <span title={`Dotted to: ${node.dottedManagers.map(d => d.managerName).join(', ')}`}
                  style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', background: '#fef3c7', color: '#92400e', border: '1px dashed #f59e0b' }}>
                  ⤴ {node.dottedManagers.length} dotted
                </span>
              )}
              {showDotted && node.dottedReports?.length > 0 && (
                <span title={`Dotted reports: ${node.dottedReports.map(d => d.userName).join(', ')}`}
                  style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', background: '#ecfdf5', color: '#065f46', border: '1px dashed #10b981' }}>
                  ⤵ {node.dottedReports.length} matrix
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af' }}>{node.email}</div>
          </div>

          <HierarchyRoleBadge role={node.hierarchy_role} />

          {node.org_role && (
            <span style={{ fontSize: '10px', color: '#94a3b8', padding: '2px 6px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
              {node.org_role}
            </span>
          )}

          {hasChildren && (
            <span style={{ fontSize: '11px', color: '#6366f1', fontWeight: 500 }}>
              {node.children.length} report{node.children.length !== 1 ? 's' : ''}
            </span>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={(e) => { e.stopPropagation(); isEditing ? cancelEdit() : startEdit(node); }}
              style={{ padding: '4px 10px', fontSize: '11px', borderRadius: '6px', border: '1px solid #e2e4ea', background: '#fff', cursor: 'pointer', color: '#4b5563' }}>
              {isEditing ? 'Cancel' : '✎'}
            </button>
            <button onClick={(e) => { e.stopPropagation(); setAddingDotted(addingDotted === node.user_id ? null : node.user_id); setEditing(null); }}
              title="Add dotted line"
              style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '6px', border: '1px dashed #f59e0b', background: addingDotted === node.user_id ? '#fef3c7' : '#fff', cursor: 'pointer', color: '#92400e' }}>
              ⤴
            </button>
            <button onClick={(e) => { e.stopPropagation(); removeFromHierarchy(node.user_id, name); }}
              style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '6px', border: '1px solid #fecaca', background: '#fff', cursor: 'pointer', color: '#dc2626' }}>
              ✕
            </button>
          </div>
        </div>

        {/* Solid edit form */}
        {isEditing && (
          <div style={{
            marginLeft: '48px', padding: '12px 16px', margin: '4px 0 8px',
            background: '#f8f7ff', borderRadius: '8px', border: '1px solid #e0e7ff',
            display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: '180px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: '#4b5563', display: 'block', marginBottom: '4px' }}>Reports To (Solid Line)</label>
              <select value={editForm.reportsTo} onChange={e => setEditForm(p => ({ ...p, reportsTo: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}>
                <option value="">— None (top of tree) —</option>
                {availableManagers.map(m => (
                  <option key={m.user_id} value={m.user_id}>{m.first_name} {m.last_name} ({m.email})</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '11px', fontWeight: 600, color: '#4b5563', display: 'block', marginBottom: '4px' }}>Role</label>
              <select value={editForm.hierarchyRole} onChange={e => setEditForm(p => ({ ...p, hierarchyRole: e.target.value }))}
                style={{ padding: '7px 10px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}>
                {HIERARCHY_ROLES.map(r => (<option key={r.value} value={r.value}>{r.label}</option>))}
              </select>
            </div>
            <button onClick={() => saveEdit(node.user_id)} disabled={saving}
              style={{ padding: '7px 18px', fontSize: '13px', borderRadius: '6px', border: 'none', background: '#4f46e5', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontWeight: 600 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}

        {/* Dotted-line add form */}
        {isAddingDotted && (
          <div style={{
            marginLeft: '48px', padding: '12px 16px', margin: '4px 0 8px',
            background: '#fffbeb', borderRadius: '8px', border: '1px dashed #f59e0b',
            display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: '180px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: '#92400e', display: 'block', marginBottom: '4px' }}>
                Add Dotted-Line Manager
              </label>
              <select value={editForm.reportsTo} onChange={e => setEditForm(p => ({ ...p, reportsTo: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}>
                <option value="">— Select manager —</option>
                {availableManagers.filter(m => m.user_id !== node.reports_to).map(m => (
                  <option key={m.user_id} value={m.user_id}>{m.first_name} {m.last_name} ({m.email})</option>
                ))}
              </select>
            </div>
            <button onClick={() => saveDottedLine(node.user_id)} disabled={saving || !editForm.reportsTo}
              style={{ padding: '7px 18px', fontSize: '13px', borderRadius: '6px', border: 'none', background: '#f59e0b', color: '#fff', cursor: (saving || !editForm.reportsTo) ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: editForm.reportsTo ? 1 : 0.5 }}>
              {saving ? 'Adding…' : 'Add Dotted Line'}
            </button>
            <button onClick={() => setAddingDotted(null)}
              style={{ padding: '7px 14px', fontSize: '13px', borderRadius: '6px', border: '1px solid #e2e4ea', background: '#fff', cursor: 'pointer', color: '#6b7280' }}>
              Cancel
            </button>
          </div>
        )}

        {/* Dotted-line list for this node */}
        {showDotted && node.dottedManagers?.length > 0 && (
          <div style={{ marginLeft: '56px', marginBottom: '4px' }}>
            {node.dottedManagers.map(d => (
              <div key={d.managerId} style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '3px 10px', margin: '2px 4px 2px 0', borderRadius: '14px',
                border: '1px dashed #f59e0b', background: '#fffbeb', fontSize: '11px', color: '#92400e',
              }}>
                <span style={{ borderBottom: '1px dashed #f59e0b' }}>⤴ {d.managerName}</span>
                <button onClick={() => removeDottedLine(node.user_id, d.managerId)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: '11px', padding: '0 2px' }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Children */}
        {!isCollapsed && node.children?.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  if (loading) return <div className="oa-loading">Loading hierarchy…</div>;

  return (
    <div>
      {error && <div className="oa-error-banner">{error}</div>}
      {success && <div className="oa-success-banner">{success}</div>}

      {/* Stats */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <div className="oa-stat-card" style={{ flex: '1 1 120px' }}>
          <div className="oa-stat-card-label">In Hierarchy</div>
          <div className="oa-stat-card-value" style={{ color: '#4338ca' }}>{new Set(tree.filter(r => r.relationship_type !== 'dotted').map(r => r.user_id)).size}</div>
        </div>
        <div className="oa-stat-card" style={{ flex: '1 1 120px' }}>
          <div className="oa-stat-card-label">Top-Level</div>
          <div className="oa-stat-card-value" style={{ color: '#059669' }}>{roots.length}</div>
        </div>
        <div className="oa-stat-card" style={{ flex: '1 1 120px' }}>
          <div className="oa-stat-card-label">Dotted Lines</div>
          <div className="oa-stat-card-value" style={{ color: '#d97706' }}>{dottedRows.length}</div>
        </div>
        <div className="oa-stat-card" style={{ flex: '1 1 120px' }}>
          <div className="oa-stat-card-label">Unassigned</div>
          <div className="oa-stat-card-value" style={{ color: '#94a3b8' }}>{unassigned.length}</div>
        </div>
      </div>

      {/* Info + controls */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px',
        padding: '14px 18px', borderRadius: '10px', marginBottom: '20px',
        background: '#f0f0ff', border: '1px solid #e0e7ff', fontSize: '13px', color: '#4338ca',
      }}>
        <div>
          <strong>Drag & drop</strong> cards to reassign reporting lines. Use <strong>⤴</strong> to add dotted (matrix) lines.
          Hierarchy controls data visibility; admin access is still via org roles.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
          <input type="checkbox" checked={showDotted} onChange={e => setShowDotted(e.target.checked)}
            style={{ accentColor: '#f59e0b' }} />
          Show dotted lines
        </label>
      </div>

      {/* Drop zone: root level */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDropTarget('root'); }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={handleDropToRoot}
        style={{
          padding: dropTarget === 'root' ? '12px' : '0',
          marginBottom: '8px', borderRadius: '8px',
          border: dropTarget === 'root' ? '2px dashed #818cf8' : 'none',
          background: dropTarget === 'root' ? '#eef2ff' : 'transparent',
          textAlign: 'center', fontSize: '12px', color: '#6366f1',
          transition: 'all 0.15s', minHeight: dropTarget === 'root' ? '40px' : '0',
        }}
      >
        {dropTarget === 'root' && 'Drop here to make top-level'}
      </div>

      {/* Tree */}
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px', color: '#1a1a2e' }}>
          Reporting Structure
        </h3>
        {roots.length === 0 && tree.length === 0 ? (
          <div style={{
            padding: '40px 20px', textAlign: 'center', color: '#9ca3af',
            border: '2px dashed #e8e9ee', borderRadius: '12px',
          }}>
            <p style={{ fontSize: '15px', fontWeight: 500 }}>No hierarchy set up yet</p>
            <p style={{ fontSize: '13px', marginTop: '6px' }}>
              Add members from the list below, then drag to arrange.
            </p>
          </div>
        ) : (
          roots.map(root => renderNode(root, 0))
        )}
      </div>

      {/* Unassigned */}
      {unassigned.length > 0 && (
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px', color: '#1a1a2e' }}>
            Members Not in Hierarchy ({unassigned.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {unassigned.map(m => (
              <div key={m.user_id}
                draggable
                onDragStart={(e) => handleDragStart(e, m.user_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '10px 14px', borderRadius: '10px',
                  background: '#fff', border: '1px solid #e8e9ee', cursor: 'grab',
                }}>
                <div style={{
                  width: '32px', height: '32px', borderRadius: '50%',
                  background: '#fef3c7', color: '#92400e', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '13px', flexShrink: 0,
                }}>
                  {(m.name?.[0] || m.email?.[0] || '?').toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>{m.name || m.email}</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af' }}>{m.email}</div>
                </div>
                <span style={{ fontSize: '10px', color: '#94a3b8', padding: '2px 6px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                  {m.role}
                </span>
                <button onClick={() => addToHierarchy(m.user_id)}
                  style={{
                    padding: '5px 14px', fontSize: '12px', borderRadius: '6px',
                    border: '1px solid #c7d2fe', background: '#eef2ff',
                    cursor: 'pointer', color: '#4338ca', fontWeight: 600,
                  }}>
                  + Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
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
// ─────────────────────────────────────────────────────────────────
// OAPlaybooks — wired to deal_stages + stage_guidance
// ─────────────────────────────────────────────────────────────────
function OAPlaybooks() {
  const [playbooks,    setPlaybooks]    = useState([]);
  const [selectedId,   setSelectedId]   = useState(null);
  const [playbook,     setPlaybook]     = useState(null);   // full playbook row incl. stage_guidance
  const [liveStages,   setLiveStages]   = useState([]);    // from deal_stages table
  const [guidance,     setGuidance]     = useState({});    // { stage_type: { goal, key_actions, ... } }
  const [loading,      setLoading]      = useState(true);
  const [stagesLoading,setStagesLoading]= useState(true);
  const [saving,       setSaving]       = useState(null);   // null | 'meta' | stage_type string
  const [error,        setError]        = useState('');
  const [success,      setSuccess]      = useState('');
  const [showNewForm,  setShowNewForm]  = useState(false);
  const [newPbData,    setNewPbData]    = useState({ name: '', type: 'custom', description: '' });
  const [editingStage, setEditingStage] = useState(null);   // stage_type being expanded
  const [creating,     setCreating]     = useState(false);
  const [deleting,     setDeleting]     = useState(false);
  const [showCompany,  setShowCompany]  = useState(false);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3500);
  };

  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const API    = process.env.REACT_APP_API_URL || '';

  // ── Fetch live deal stages once on mount ──────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(`${API}/deal-stages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        // Only active non-terminal stages are meaningful for playbook guidance
        const active = (data.stages || [])
          .filter(s => s.is_active && !s.is_terminal)
          .sort((a, b) => a.sort_order - b.sort_order);
        setLiveStages(active);
      } catch {
        // Non-fatal — editor degrades gracefully
      } finally {
        setStagesLoading(false);
      }
    })();
  }, [API, token]);

  // ── Load playbook list ────────────────────────────────────────────────────
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

  // ── Load selected playbook + extract stage_guidance ──────────────────────
  useEffect(() => {
    if (!selectedId) return;
    setPlaybook(null);
    setGuidance({});
    setEditingStage(null);
    setShowCompany(false);
    (async () => {
      try {
        const r   = await apiService.playbooks.getById(selectedId);
        const raw = r.data.playbook;
        setPlaybook(raw);
        // stage_guidance is keyed by stage key: { qualified: {...}, demo: {...} }
        setGuidance(raw.stage_guidance || {});
      } catch { setError('Failed to load playbook content'); }
    })();
  }, [selectedId]);

  // ── Save playbook name / description / company context ───────────────────
  const handleSaveMeta = async () => {
    if (!playbook) return;
    setSaving('meta');
    try {
      await apiService.playbooks.update(selectedId, {
        name:        playbook.name,
        description: playbook.description,
        content:     playbook.content,   // company context lives here
      });
      setPlaybooks(prev => prev.map(p =>
        p.id === selectedId ? { ...p, name: playbook.name, description: playbook.description } : p
      ));
      flash('success', 'Playbook saved ✓');
    } catch { flash('error', 'Failed to save playbook'); }
    finally  { setSaving(null); }
  };

  // ── Save guidance for a single stage_type ────────────────────────────────
  // Uses the dedicated PUT /api/playbooks/:id/stages/:stageType endpoint
  // so we never clobber other stages' guidance.
  const handleSaveStage = async (stageKey, stageType) => {
    if (!playbook) return;
    setSaving(stageKey);
    const stageGuidance = guidance[stageKey] || {};
    try {
      const res = await fetch(`${API}/api/playbooks/${selectedId}/stages/${stageKey}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          goal:                  stageGuidance.goal                || null,
          next_step:             stageGuidance.next_step           || null,
          timeline:              stageGuidance.timeline            || null,
          key_actions:           Array.isArray(stageGuidance.key_actions) ? stageGuidance.key_actions : [],
          email_response_time:   stageGuidance.email_response_time || null,
          success_criteria:      Array.isArray(stageGuidance.success_criteria) ? stageGuidance.success_criteria : [],
          requires_proposal_doc: !!stageGuidance.requires_proposal_doc,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err?.error?.message || res.statusText);
      }
      flash('success', `Stage guidance saved ✓`);
    } catch (e) {
      flash('error', e.message || 'Failed to save stage guidance');
    } finally {
      setSaving(null);
    }
  };

  // ── Helpers to mutate local guidance state ────────────────────────────────
  const updateGuidanceField = (stageKey, field, value) => {
    setGuidance(prev => ({
      ...prev,
      [stageKey]: { ...(prev[stageKey] || {}), [field]: value },
    }));
  };

  const updateKeyAction = (stageKey, idx, value) => {
    const actions = [...(guidance[stageKey]?.key_actions || [])];
    actions[idx]  = value;
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const addKeyAction = (stageKey) => {
    const actions = [...(guidance[stageKey]?.key_actions || []), ''];
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const removeKeyAction = (stageKey, idx) => {
    const actions = (guidance[stageKey]?.key_actions || []).filter((_, i) => i !== idx);
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const TYPE_LABELS = { market: '🌍 Market', product: '📦 Product', custom: '⚙️ Custom' };
  const TYPE_COLORS = { market: '#3182ce', product: '#38a169', custom: '#718096' };

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
      const r  = await apiService.playbooks.create({ ...newPbData, content: { company: {} }, stage_guidance: {} });
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

  if (loading) return <div className="sv-loading">Loading playbooks...</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📘 Sales Playbooks</h2>
          <p className="sv-panel-desc">
            Stage names and order come from the Deal Stages tab. Edit guidance here to tell the
            AI what actions to generate for each stage.
          </p>
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
              {/* Header — name / description / save meta */}
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
                <button className="sv-btn-primary" onClick={handleSaveMeta} disabled={!!saving} style={{ flexShrink: 0 }}>
                  {saving === 'meta' ? '⏳ Saving...' : '💾 Save'}
                </button>
              </div>

              {/* Company context */}
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

              {/* Stage guidance — driven by live deal_stages */}
              <div className="sv-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <h4 style={{ margin: 0, fontSize: 15 }}>📋 Stage Guidance</h4>
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>
                    Stages from Deal Stages tab · save each stage individually
                  </span>
                </div>

                {stagesLoading ? (
                  <div className="sv-loading" style={{ padding: 16 }}>Loading stages…</div>
                ) : liveStages.length === 0 ? (
                  <div className="sv-empty">
                    No active pipeline stages found. Add stages in the Deal Stages tab first.
                  </div>
                ) : (
                  <div className="sv-stages-list">
                    {liveStages.map((stage, i) => {
                      const stageType = stage.stage_type;  // semantic label for display only
                      const stageKey  = stage.key;              // guidance lookup key
                      const g         = guidance[stageKey] || {};
                      const isOpen    = editingStage === stage.id;
                      const isSaving  = saving === stageKey;
                      const hasGuidance = !!(g.goal || (g.key_actions?.length));

                      return (
                        <div key={stage.id} className="sv-stage-row">
                          <div className="sv-stage-header"
                            onClick={() => setEditingStage(isOpen ? null : stage.id)}>
                            <span className="sv-stage-num">{i + 1}</span>
                            <span className="sv-stage-name">{stage.name}</span>
                            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>
                              {stageType}
                            </span>
                            {hasGuidance && (
                              <span style={{ fontSize: 11, color: '#10b981', marginLeft: 8 }}>● guided</span>
                            )}
                            <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 8, flex: 1 }}>
                              {g.goal?.substring(0, 55)}{g.goal?.length > 55 ? '…' : ''}
                            </span>
                            <span className="sv-expand-btn">{isOpen ? '▲' : '▼'}</span>
                          </div>

                          {isOpen && (
                            <div className="sv-stage-detail">
                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Goal</label>
                                <input className="sv-input"
                                  placeholder="What should the rep achieve in this stage?"
                                  value={g.goal || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'goal', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Timeline</label>
                                <input className="sv-input"
                                  placeholder="e.g. 1-2 weeks"
                                  value={g.timeline || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'timeline', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Email Response Time</label>
                                <input className="sv-input"
                                  placeholder="e.g. within 4 hours"
                                  value={g.email_response_time || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'email_response_time', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Next Step</label>
                                <input className="sv-input"
                                  placeholder="e.g. Schedule technical deep-dive"
                                  value={g.next_step || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'next_step', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>
                                  <input type="checkbox"
                                    checked={!!g.requires_proposal_doc}
                                    onChange={e => updateGuidanceField(stageKey, 'requires_proposal_doc', e.target.checked)}
                                    style={{ marginRight: 6 }} />
                                  Requires proposal document
                                </label>
                              </div>

                              {/* Key actions */}
                              <div className="sv-field" style={{ marginTop: 8 }}>
                                <label>Key Actions</label>
                                {(g.key_actions || []).map((action, ai) => (
                                  <div key={ai} className="oa-pb-action-row">
                                    <span className="oa-pb-action-num">{ai + 1}</span>
                                    <textarea
                                      className="sv-input oa-pb-action-textarea"
                                      value={action}
                                      rows={Math.max(1, Math.ceil(action.length / 60))}
                                      onChange={e => updateKeyAction(stageKey, ai, e.target.value)}
                                    />
                                    <button className="oa-pb-action-remove"
                                      onClick={() => removeKeyAction(stageKey, ai)}
                                      title="Remove">×</button>
                                  </div>
                                ))}
                                <button className="oa-pb-add-action" onClick={() => addKeyAction(stageKey)}>
                                  + Add action
                                </button>
                              </div>

                              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                                <button
                                  className="sv-btn-primary"
                                  onClick={() => handleSaveStage(stageKey, stageType)}
                                  disabled={!!saving}
                                >
                                  {isSaving ? '⏳ Saving…' : `💾 Save ${stage.name} guidance`}
                                </button>
                              </div>
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
  const [stages,    setStages]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(null);
  const [error,     setError]     = useState('');
  const [editingId, setEditingId] = useState(null);
  // editFields holds { name, key } while a row is being edited
  const [editFields, setEditFields] = useState({ name: '', key: '' });
  const [showAdd,   setShowAdd]   = useState(false);
  const [newStage,  setNewStage]  = useState({ name: '', stage_type: 'custom', is_terminal: false });
  const [addError,  setAddError]  = useState('');

  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const API   = process.env.REACT_APP_API_URL || '';

  const apiFetch = useCallback(async (path, options = {}) => {
    const res = await fetch(`${API}/deal-stages${path}`, {
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
      return data.stage;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setSaving(null);
    }
  };

  // Opens inline editor for a row
  const startEdit = (stage) => {
    setEditingId(stage.id);
    setEditFields({ name: stage.name, key: stage.key });
  };

  // Commits name + key together in one PUT
  const commitEdit = async (stage) => {
    const nameChanged = editFields.name.trim() && editFields.name.trim() !== stage.name;
    const keyChanged  = editFields.key.trim()  && editFields.key.trim()  !== stage.key;

    if (nameChanged || keyChanged) {
      const updates = {};
      if (nameChanged) updates.name = editFields.name.trim();
      if (keyChanged)  updates.key  = editFields.key.trim();
      try {
        await saveStage(stage.id, updates);
      } catch {
        // error already set in saveStage; keep editor open
        return;
      }
    }
    setEditingId(null);
  };

  const moveStage = async (id, direction) => {
    const sorted  = [...stages].sort((a, b) => a.sort_order - b.sort_order);
    const idx     = sorted.findIndex(s => s.id === id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const orderA = sorted[idx].sort_order;
    const orderB = sorted[swapIdx].sort_order;

    // Optimistic update
    const updated = sorted.map((s, i) => {
      if (i === idx)     return { ...s, sort_order: orderB };
      if (i === swapIdx) return { ...s, sort_order: orderA };
      return s;
    });
    setStages(updated);

    await Promise.all([
      saveStage(id,                   { sort_order: orderB }),
      saveStage(sorted[swapIdx].id,   { sort_order: orderA }),
    ]);
  };

  const toggleActive = async (stage) => {
    await saveStage(stage.id, { is_active: !stage.is_active });
  };

  const deleteStage = async (stage) => {
    if (!window.confirm(`Delete "${stage.name}"?\n\nIf active deals are in this stage the server will reject the request and ask you to move them first.`)) return;
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

  const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div style={{ padding: '24px 32px', maxWidth: 700 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: 0 }}>🏷️ Deal Stages</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
            Configure your pipeline stages. Click a name or key to edit — renaming a key
            cascades automatically to all deals so nothing is orphaned.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          style={{ padding: '8px 16px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap', marginLeft: 16 }}
        >
          + Add Stage
        </button>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 6, marginBottom: 12 }}>
          ⚠️ {error}
          <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626' }}>✕</button>
        </div>
      )}

      {/* ── Add form ──────────────────────────────────────────────────────────── */}
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
                id="is_terminal_new"
                checked={newStage.is_terminal}
                onChange={e => setNewStage(s => ({ ...s, is_terminal: e.target.checked }))}
              />
              <label htmlFor="is_terminal_new" style={{ fontSize: 13 }}>Terminal (won/lost)</label>
            </div>
            <button
              onClick={handleAdd}
              disabled={saving === 'new'}
              style={{ padding: '7px 16px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
            >
              {saving === 'new' ? 'Adding…' : 'Add'}
            </button>
            <button
              onClick={() => { setShowAdd(false); setAddError(''); }}
              style={{ padding: '7px 12px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
          {addError && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>⚠️ {addError}</div>}
        </div>
      )}

      {/* ── Stages list ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map((stage, idx) => {
          const isEditing = editingId === stage.id;
          return (
            <div
              key={stage.id}
              style={{
                background: stage.is_active ? '#fff' : '#f9fafb',
                border: `1px solid ${isEditing ? '#6366f1' : '#e5e7eb'}`,
                borderRadius: 8,
                padding: '10px 14px',
                opacity: stage.is_active ? 1 : 0.7,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* Reorder arrows */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <button onClick={() => moveStage(stage.id, 'up')}   disabled={idx === 0 || !!saving} style={arrowBtn}>▲</button>
                  <button onClick={() => moveStage(stage.id, 'down')} disabled={idx === sorted.length - 1 || !!saving} style={arrowBtn}>▼</button>
                </div>

                {/* Name + key — view or edit mode */}
                <div style={{ flex: 1 }}>
                  {isEditing ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 2 }}>Name</label>
                          <input
                            autoFocus
                            value={editFields.name}
                            onChange={e => setEditFields(f => ({ ...f, name: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') commitEdit(stage); if (e.key === 'Escape') setEditingId(null); }}
                            style={{ padding: '5px 8px', border: '1px solid #6366f1', borderRadius: 4, fontSize: 14, width: '100%' }}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 2 }}>
                            Key <span style={{ color: '#9ca3af' }}>(lowercase, underscores only)</span>
                          </label>
                          <input
                            value={editFields.key}
                            onChange={e => setEditFields(f => ({ ...f, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))}
                            onKeyDown={e => { if (e.key === 'Enter') commitEdit(stage); if (e.key === 'Escape') setEditingId(null); }}
                            style={{ padding: '5px 8px', border: '1px solid #6366f1', borderRadius: 4, fontSize: 13, fontFamily: 'monospace', width: '100%' }}
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => commitEdit(stage)}
                          disabled={!!saving}
                          style={{ padding: '4px 12px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                        >
                          {saving === stage.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          style={{ padding: '4px 10px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                        >
                          Cancel
                        </button>
                        {stage.is_terminal && (
                          <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>🏁 terminal</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div
                      onClick={() => startEdit(stage)}
                      style={{ cursor: 'text' }}
                      title="Click to edit name or key"
                    >
                      <span style={{ fontWeight: 500 }}>
                        {stage.name}
                        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>✏️</span>
                      </span>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                        key: <code style={{ background: '#f3f4f6', padding: '1px 4px', borderRadius: 3 }}>{stage.key}</code>
                        {' · '}{STAGE_TYPES.find(t => t.value === stage.stage_type)?.label || stage.stage_type}
                        {stage.is_terminal && ' · 🏁 terminal'}
                        {!stage.is_active  && ' · inactive'}
                      </div>
                    </div>
                  )}
                </div>

                {/* Active pill */}
                <button
                  onClick={() => toggleActive(stage)}
                  disabled={!!saving}
                  title={stage.is_active ? 'Click to deactivate' : 'Click to activate'}
                  style={{
                    padding: '4px 10px', fontSize: 12, borderRadius: 12, cursor: 'pointer', border: 'none',
                    background: stage.is_active ? '#dcfce7' : '#f3f4f6',
                    color:      stage.is_active ? '#166534' : '#6b7280',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {stage.is_active ? '● Active' : '○ Inactive'}
                </button>

                {/* Delete — available on all stages, server enforces safety */}
                <button
                  onClick={() => deleteStage(stage)}
                  disabled={saving === stage.id}
                  title="Delete stage"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#ef4444', opacity: saving === stage.id ? 0.4 : 1 }}
                >
                  🗑️
                </button>

                {saving === stage.id && (
                  <span style={{ fontSize: 12, color: '#6b7280' }}>saving…</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {stages.length === 0 && (
        <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 32 }}>
          No stages yet. Add your first stage above.
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// AI AGENT TAB — org-level toggle, proposal stats, token usage
// ─────────────────────────────────────────────────────────────────

function OAAgentSettings() {
  const [enabled, setEnabled]               = useState(false);
  const [autoExpireDays, setAutoExpireDays] = useState(7);
  const [maxPerDeal, setMaxPerDeal]         = useState(10);
  const [minConfidence, setMinConfidence]   = useState(0.40);
  const [loading, setLoading]               = useState(true);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState('');
  const [success, setSuccess]               = useState('');
  const [stats, setStats]                   = useState(null);
  const [tokenUsage, setTokenUsage]         = useState(null);
  const [period, setPeriod]                 = useState(30);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3500);
  };

  useEffect(() => {
    (async () => {
      try {
        const statusRes = await apiService.agent.getStatus();
        setEnabled(statusRes.data?.enabled || false);
        if (statusRes.data?.settings) {
          setMaxPerDeal(statusRes.data.settings.max_proposals_per_deal || 10);
          setMinConfidence(statusRes.data.settings.min_confidence ?? 0.40);
          setAutoExpireDays(statusRes.data.settings.auto_expire_days || 7);
        }

        const statsRes = await apiService.agent.admin.getStats(period);
        setStats(statsRes.data?.stats || null);

        const usageRes = await apiService.agent.admin.getTokenUsage(period);
        setTokenUsage(usageRes.data || null);
      } catch (e) {
        console.log('Agent settings load:', e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [period]);

  const handleToggle = async () => {
    setSaving(true);
    try {
      await apiService.agent.admin.updateSettings({
        agentic_framework_enabled: !enabled,
        agentic_auto_expire_days: autoExpireDays,
      });
      setEnabled(!enabled);
      flash('success', `AI Agent ${!enabled ? 'enabled' : 'disabled'} ✓`);
    } catch (e) {
      flash('error', e.message || 'Failed to update settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveExpiry = async () => {
    setSaving(true);
    try {
      await apiService.agent.admin.updateSettings({ agentic_auto_expire_days: autoExpireDays });
      flash('success', 'Auto-expire setting saved ✓');
    } catch (e) {
      flash('error', e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 32, color: '#6b7280' }}>Loading AI Agent settings…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>🤖 AI Agent Framework</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Enable the AI agent to propose CRM actions that require team member approval before execution.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error" style={{ margin: '12px 0' }}>⚠️ {error}</div>}
      {success && <div className="sv-success" style={{ margin: '12px 0' }}>{success}</div>}

      <div className="sv-panel-body">
        {/* Toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
              {enabled ? '🟢 AI Agent is Enabled' : '⚪ AI Agent is Disabled'}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {enabled
                ? 'The agent is actively generating proposals for your team. All proposals require human approval.'
                : 'Enable to let the AI agent propose CRM actions. No changes are made without approval.'}
            </div>
          </div>
          <button onClick={handleToggle} disabled={saving} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 13, cursor: 'pointer',
            background: enabled ? '#fee2e2' : '#d1fae5', color: enabled ? '#dc2626' : '#059669',
          }}>
            {saving ? '⏳…' : enabled ? 'Disable' : 'Enable'}
          </button>
        </div>

        {/* Auto-expire */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Auto-expire pending proposals after:</label>
          <select value={autoExpireDays} onChange={e => setAutoExpireDays(parseInt(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={0}>Never</option>
          </select>
          <button onClick={handleSaveExpiry} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
        </div>

        {/* Max proposals per deal per day */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Max proposals per deal/day:</label>
          <select value={maxPerDeal} onChange={e => setMaxPerDeal(parseInt(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={3}>3 (conservative)</option>
            <option value={5}>5</option>
            <option value={10}>10 (default)</option>
            <option value={15}>15</option>
            <option value={25}>25</option>
            <option value={50}>50 (max)</option>
          </select>
          <button onClick={async () => {
            setSaving(true);
            try { await apiService.agent.admin.updateSettings({ agentic_max_proposals_per_deal: maxPerDeal }); flash('success', 'Daily cap saved ✓'); }
            catch (e) { flash('error', e.message); }
            finally { setSaving(false); }
          }} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>Lower = less noise, higher = more proposals to review</span>
        </div>

        {/* Confidence floor */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Min. confidence threshold:</label>
          <select value={minConfidence} onChange={e => setMinConfidence(parseFloat(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={0}>0% (show all)</option>
            <option value={0.25}>25%</option>
            <option value={0.40}>40% (default)</option>
            <option value={0.50}>50%</option>
            <option value={0.60}>60%</option>
            <option value={0.75}>75% (high only)</option>
          </select>
          <button onClick={async () => {
            setSaving(true);
            try { await apiService.agent.admin.updateSettings({ agentic_min_confidence: minConfidence }); flash('success', 'Confidence threshold saved ✓'); }
            catch (e) { flash('error', e.message); }
            finally { setSaving(false); }
          }} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>Proposals below this confidence are discarded automatically</span>
        </div>

        {/* Proposal Stats */}
        {stats && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 10 }}>📊 Proposal Stats (last {period} days)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
              {[
                { label: 'Pending',  value: stats.pending,  color: '#f59e0b' },
                { label: 'Executed', value: stats.executed,  color: '#059669' },
                { label: 'Rejected', value: stats.rejected,  color: '#ef4444' },
                { label: 'Failed',   value: stats.failed,    color: '#dc2626' },
                { label: 'Expired',  value: stats.expired,   color: '#6b7280' },
                { label: 'Total',    value: stats.total,     color: '#374151' },
              ].map(s => (
                <div key={s.label} style={{ padding: '12px 14px', textAlign: 'center', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value || 0}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Token Usage */}
        {tokenUsage && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 10 }}>
              🔢 AI Token Usage (last {period} days)
              <select value={period} onChange={e => setPeriod(parseInt(e.target.value))}
                style={{ marginLeft: 12, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }}>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </h3>
            <div style={{ padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Total Tokens</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  {parseInt(tokenUsage.totals?.total_tokens || 0).toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Est. Cost</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  ${parseFloat(tokenUsage.totals?.estimated_cost || 0).toFixed(4)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>API Calls</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  {parseInt(tokenUsage.totals?.call_count || 0).toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const arrowBtn = {
  background: 'none', border: '1px solid #e5e7eb', borderRadius: 3,
  cursor: 'pointer', fontSize: 10, padding: '1px 4px', color: '#6b7280',
  lineHeight: 1,
};

// ═══════════════════════════════════════════════════════════════
// Duplicate Detection Settings (Org Admin)
// ═══════════════════════════════════════════════════════════════
function OADuplicateSettings() {
  const [config, setConfig]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 4000);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await apiService.orgAdmin.getDuplicateSettings();
        setConfig(res.data.duplicate_detection);
      } catch (e) {
        setError('Failed to load settings');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleToggle = async (key, value) => {
    setSaving(true);
    try {
      const res = await apiService.orgAdmin.updateDuplicateSettings({ [key]: value });
      setConfig(prev => ({ ...prev, ...res.data.duplicate_detection }));
      flash('success', 'Setting saved ✓');
    } catch (e) {
      flash('error', e.response?.data?.error?.message || e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sv-loading">Loading duplicate settings…</div>;

  const sectionStyle = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
    padding: '20px 24px', marginBottom: 16,
  };
  const headingStyle = { fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 12 };
  const rowStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 0', borderBottom: '1px solid #f3f4f6',
  };
  const labelStyle = { fontSize: 13, fontWeight: 500, color: '#374151' };
  const descStyle = { fontSize: 12, color: '#9ca3af', marginTop: 2 };
  const toggleStyle = (on) => ({
    width: 44, height: 24, borderRadius: 12, border: 'none', cursor: saving ? 'wait' : 'pointer',
    background: on ? '#4f46e5' : '#d1d5db', position: 'relative', transition: 'background 0.2s',
  });
  const dotStyle = (on) => ({
    width: 18, height: 18, borderRadius: '50%', background: '#fff',
    position: 'absolute', top: 3, left: on ? 23 : 3, transition: 'left 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  });
  const selectStyle = {
    padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13,
  };

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 0' }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, color: '#111827' }}>🔍 Duplicate Detection</h2>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>Configure which rules detect duplicates and who can see them.</p>

      {error   && <div className="sv-error" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
      {success && <div className="sv-success" style={{ marginBottom: 12 }}>{success}</div>}

      {/* ── Contact Duplicate Rules ─────────────────── */}
      <div style={sectionStyle}>
        <div style={headingStyle}>👤 Contact Duplicate Rules</div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Email match</div>
            <div style={descStyle}>Flag contacts with the same email address as duplicates</div>
          </div>
          <button style={toggleStyle(config?.contact_email_match)} disabled={saving}
            onClick={() => handleToggle('contact_email_match', !config?.contact_email_match)}>
            <div style={dotStyle(config?.contact_email_match)} />
          </button>
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Name + Account match</div>
            <div style={descStyle}>Flag contacts with the same first name, last name, and account</div>
          </div>
          <button style={toggleStyle(config?.contact_name_account_match)} disabled={saving}
            onClick={() => handleToggle('contact_name_account_match', !config?.contact_name_account_match)}>
            <div style={dotStyle(config?.contact_name_account_match)} />
          </button>
        </div>

        <div style={{ ...rowStyle, borderBottom: 'none' }}>
          <div>
            <div style={labelStyle}>Who can see contact duplicates?</div>
            <div style={descStyle}>
              {config?.contact_visibility === 'org'
                ? 'All members see duplicates across the entire org (default)'
                : 'Members only see duplicates within their own contacts'}
            </div>
          </div>
          <select style={selectStyle} value={config?.contact_visibility || 'org'} disabled={saving}
            onChange={e => handleToggle('contact_visibility', e.target.value)}>
            <option value="org">Entire org (default)</option>
            <option value="own">Own contacts only</option>
          </select>
        </div>
      </div>

      {/* ── Account Duplicate Rules ─────────────────── */}
      <div style={sectionStyle}>
        <div style={headingStyle}>🏢 Account Duplicate Rules</div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Domain match</div>
            <div style={descStyle}>Flag accounts with the same website domain as duplicates</div>
          </div>
          <button style={toggleStyle(config?.account_domain_match)} disabled={saving}
            onClick={() => handleToggle('account_domain_match', !config?.account_domain_match)}>
            <div style={dotStyle(config?.account_domain_match)} />
          </button>
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Name match</div>
            <div style={descStyle}>Flag accounts with the same name (case-insensitive)</div>
          </div>
          <button style={toggleStyle(config?.account_name_match)} disabled={saving}
            onClick={() => handleToggle('account_name_match', !config?.account_name_match)}>
            <div style={dotStyle(config?.account_name_match)} />
          </button>
        </div>

        <div style={{ ...rowStyle, borderBottom: 'none' }}>
          <div>
            <div style={labelStyle}>Who can see account duplicates?</div>
            <div style={descStyle}>
              {config?.account_visibility === 'org'
                ? 'All members see duplicates across the entire org (default)'
                : 'Members only see duplicates within their own accounts'}
            </div>
          </div>
          <select style={selectStyle} value={config?.account_visibility || 'org'} disabled={saving}
            onChange={e => handleToggle('account_visibility', e.target.value)}>
            <option value="org">Entire org (default)</option>
            <option value="own">Own accounts only</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ── Integrations (org-level) ──────────────────────────────────────────────────

function OAIntegrations() {
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(null);
  const [flash, setFlash]       = useState(null);

  const PROVIDERS = [
    {
      type: 'microsoft',
      label: 'Microsoft (Outlook + OneDrive)',
      icon: '📧',
      desc: 'Enable Outlook email sync, calendar, and OneDrive file access for all org members.',
      envHint: 'MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID',
      scopes: ['Mail.Read', 'Mail.Send', 'Calendars.Read', 'Files.Read', 'User.Read'],
    },
    {
      type: 'google',
      label: 'Google (Gmail + Drive + Calendar)',
      icon: '🟢',
      desc: 'Enable Gmail sync, Google Calendar events, and Google Drive file access for all org members.',
      envHint: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET',
      scopes: ['Gmail', 'Calendar', 'Drive', 'Profile'],
    },
  ];

  useEffect(() => {
    apiService.orgAdmin.getIntegrations()
      .then(r => { setIntegrations(r.data.integrations || []); })
      .catch(() => { setIntegrations([]); })
      .finally(() => setLoading(false));
  }, []);

  const getStatus = (type) => {
    const found = integrations.find(i => i.integration_type === type);
    return found?.status || 'inactive';
  };

  const getLastSynced = (type) => {
    const found = integrations.find(i => i.integration_type === type);
    return found?.last_synced_at;
  };

  const handleToggle = async (type, newStatus) => {
    setSaving(type);
    setFlash(null);
    try {
      const r = await apiService.orgAdmin.updateIntegration(type, { status: newStatus });
      setIntegrations(prev => {
        const others = prev.filter(i => i.integration_type !== type);
        return [...others, r.data.integration];
      });
      setFlash({ type: 'success', message: `${type === 'microsoft' ? 'Microsoft' : 'Google'} integration ${newStatus === 'active' ? 'enabled' : 'disabled'}.` });
    } catch (err) {
      setFlash({ type: 'error', message: err?.response?.data?.error?.message || 'Failed to update integration.' });
    } finally {
      setSaving(null);
    }
  };

  const cardStyle = {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: 24,
    marginBottom: 16,
  };

  const headerRow = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
  };

  const toggleBtn = (active, disabled) => ({
    padding: '8px 18px',
    borderRadius: 8,
    border: active ? '1px solid #dcfce7' : '1px solid #e5e7eb',
    background: active ? '#dcfce7' : '#f3f4f6',
    color: active ? '#166534' : '#6b7280',
    fontWeight: 600,
    fontSize: 13,
    cursor: disabled ? 'wait' : 'pointer',
    transition: 'all 0.15s',
  });

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading integrations...</div>;

  return (
    <div>
      {flash && (
        <div style={{
          padding: '10px 16px',
          borderRadius: 8,
          marginBottom: 16,
          background: flash.type === 'success' ? '#dcfce7' : '#fef2f2',
          color: flash.type === 'success' ? '#166534' : '#991b1b',
          fontSize: 14,
          fontWeight: 500,
        }}>
          {flash.message}
        </div>
      )}

      <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 20, lineHeight: 1.6 }}>
        Enable or disable third-party integrations for your organisation. When enabled, individual
        team members can connect their personal accounts from <strong>Settings → Integrations</strong>.
      </p>

      {PROVIDERS.map(provider => {
        const active = getStatus(provider.type) === 'active';
        const lastSync = getLastSynced(provider.type);
        const isSaving = saving === provider.type;
        return (
          <div key={provider.type} style={cardStyle}>
            <div style={headerRow}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1 }}>
                <span style={{ fontSize: 28 }}>{provider.icon}</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#1a202c' }}>
                    {provider.label}
                  </h3>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
                    {provider.desc}
                  </p>
                </div>
              </div>

              <button
                style={toggleBtn(active, isSaving)}
                disabled={isSaving}
                onClick={() => handleToggle(provider.type, active ? 'inactive' : 'active')}
              >
                {isSaving ? '...' : active ? '✓ Enabled' : 'Enable'}
              </button>
            </div>

            {/* Status details */}
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Status</div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: active ? '#059669' : '#6b7280', marginTop: 2 }}>
                    {active ? 'Active' : 'Inactive'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Scopes</div>
                  <div style={{ fontSize: 13, color: '#4b5563', marginTop: 2 }}>
                    {provider.scopes.join(', ')}
                  </div>
                </div>
                {lastSync && (
                  <div>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Last synced</div>
                    <div style={{ fontSize: 13, color: '#4b5563', marginTop: 2 }}>
                      {new Date(lastSync).toLocaleString()}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Env hint for admin */}
            <div style={{ marginTop: 12, padding: '8px 12px', background: '#f8fafc', borderRadius: 6, fontSize: 12, color: '#94a3b8' }}>
              💡 Requires environment variables: <code style={{ background: '#e5e7eb', padding: '1px 4px', borderRadius: 3 }}>{provider.envHint}</code>
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 20, padding: 16, background: '#fffbeb', borderRadius: 8, border: '1px solid #fde68a', fontSize: 13, color: '#92400e', lineHeight: 1.6 }}>
        <strong>How org integrations work:</strong><br />
        Enabling an integration here allows members to connect their personal accounts.
        Each member still authorises individually via Settings → Integrations — you are not
        granting access to a shared mailbox. This switch controls whether the option is <em>available</em> to your team.
      </div>
    </div>
  );
}
