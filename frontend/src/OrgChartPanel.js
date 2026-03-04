// OrgChartPanel.js
// Full org chart tab for AccountsView + mini position widget for ContactsView.
// Exports: OrgChartPanel (full), ContactOrgPosition (mini)

import React, { useState, useEffect, useCallback } from 'react';
import api from './apiService';
import './OrgChartPanel.css';

// Thin wrapper — uses same axios instance (baseURL already = .../api) as the rest of the app.
async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toLowerCase();
  const body   = options.body ? JSON.parse(options.body) : undefined;
  const response = await api[method](path, body);
  return response.data;
}

// ── Role badge config ────────────────────────────────────────────────────────
const ROLE_STYLES = {
  champion:       { bg: '#dcfce7', color: '#166534', label: 'Champion' },
  economic_buyer: { bg: '#fef3c7', color: '#92400e', label: 'Econ. Buyer' },
  decision_maker: { bg: '#dbeafe', color: '#1e40af', label: 'Decision Maker' },
  blocker:        { bg: '#fee2e2', color: '#991b1b', label: 'Blocker' },
  influencer:     { bg: '#f3e8ff', color: '#6b21a8', label: 'Influencer' },
  end_user:       { bg: '#f1f5f9', color: '#475569', label: 'End User' },
  executive:      { bg: '#e0f2fe', color: '#0369a1', label: 'Executive' },
};

const ENGAGEMENT_COLORS = { high: '#059669', medium: '#d97706', low: '#dc2626' };

function getRoleStyle(role) {
  return ROLE_STYLES[role] || { bg: '#f1f5f9', color: '#64748b', label: role?.replace(/_/g, ' ') || '' };
}

function getInitials(first, last) {
  return `${first?.[0] || ''}${last?.[0] || ''}`.toUpperCase();
}

function getAvatarColor(name) {
  const colors = [
    ['#1e40af','#3b82f6'], ['#065f46','#10b981'], ['#6b21a8','#a78bfa'],
    ['#92400e','#f59e0b'], ['#1e3a5f','#0ea5e9'], ['#7f1d1d','#f87171'],
    ['#064e3b','#34d399'], ['#3730a3','#818cf8'],
  ];
  const idx = (name?.charCodeAt(0) || 0) % colors.length;
  return colors[idx];
}

// ═════════════════════════════════════════════════════════════════════════════
// ContactNode — single card in the tree
// ═════════════════════════════════════════════════════════════════════════════

function ContactNode({ contact, allContacts, onReportsToChange, onNavigate, depth = 0 }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [editingReportsTo, setEditingReportsTo] = useState(false);
  const [savingReportsTo, setSavingReportsTo] = useState(false);

  const hasChildren = contact.children?.length > 0;
  const roleStyle = getRoleStyle(contact.role_type);
  const [c1, c2] = getAvatarColor(contact.first_name + contact.last_name);
  const displayTitle = contact.org_chart_title || contact.title || '';

  const handleReportsToChange = async (newManagerId) => {
    setSavingReportsTo(true);
    try {
      await onReportsToChange(contact.id, newManagerId ? parseInt(newManagerId) : null);
    } finally {
      setSavingReportsTo(false);
      setEditingReportsTo(false);
    }
  };

  return (
    <div className="och-node-wrapper" style={{ '--depth': depth }}>
      <div className="och-card">
        {/* Avatar */}
        <div
          className="och-avatar"
          style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
        >
          {getInitials(contact.first_name, contact.last_name)}
        </div>

        {/* Info */}
        <div className="och-info">
          <div className="och-name" onClick={() => onNavigate && onNavigate(contact.id)}>
            {contact.first_name} {contact.last_name}
            {onNavigate && <span className="och-nav-arrow">→</span>}
          </div>
          {displayTitle && <div className="och-title">{displayTitle}</div>}

          <div className="och-badges">
            {contact.role_type && (
              <span className="och-badge" style={{ background: roleStyle.bg, color: roleStyle.color }}>
                {roleStyle.label}
              </span>
            )}
            {contact.engagement_level && (
              <span className="och-engagement-dot"
                style={{ background: ENGAGEMENT_COLORS[contact.engagement_level] || '#94a3b8' }}
                title={`${contact.engagement_level} engagement`}
              />
            )}
          </div>

          {/* Reports-to editor */}
          {editingReportsTo ? (
            <div className="och-reports-edit">
              <select
                className="och-select"
                defaultValue={contact.reports_to_contact_id || ''}
                onChange={e => handleReportsToChange(e.target.value || null)}
                disabled={savingReportsTo}
                autoFocus
                onBlur={() => setEditingReportsTo(false)}
              >
                <option value="">— No manager (root) —</option>
                {allContacts
                  .filter(c => c.id !== contact.id)
                  .map(c => (
                    <option key={c.id} value={c.id}>
                      {c.first_name} {c.last_name}{c.title ? ` (${c.title})` : ''}
                    </option>
                  ))
                }
              </select>
              {savingReportsTo && <span className="och-saving">Saving…</span>}
            </div>
          ) : (
            <button
              className="och-reports-to-btn"
              onClick={() => setEditingReportsTo(true)}
              title="Change reporting line"
            >
              {contact.reports_to_contact_id
                ? `Reports to: ${allContacts.find(c => c.id === contact.reports_to_contact_id)?.first_name || '…'}`
                : 'Set manager'
              } ✏️
            </button>
          )}
        </div>

        {/* Expand/collapse */}
        {hasChildren && (
          <button
            className={`och-toggle ${expanded ? 'och-toggle--open' : ''}`}
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Collapse' : `Expand (${contact.children.length})`}
          >
            {contact.children.length}
          </button>
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="och-children">
          <div className="och-branch-line" />
          <div className="och-children-list">
            {contact.children.map(child => (
              <ContactNode
                key={child.id}
                contact={child}
                allContacts={allContacts}
                onReportsToChange={onReportsToChange}
                onNavigate={onNavigate}
                depth={depth + 1}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// OrgChartPanel — full tab for AccountsView
// ═════════════════════════════════════════════════════════════════════════════

export function OrgChartPanel({ accountId, accountName, allAccountContacts, onNavigateToContact }) {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accountHierarchy, setAccountHierarchy] = useState(null);
  const [activeTab, setActiveTab] = useState('contacts'); // 'contacts' | 'accounts'
  const [showAddRelationship, setShowAddRelationship] = useState(false);

  const loadOrgChart = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError('');
    try {
      const [chartRes, hierarchyRes] = await Promise.all([
        apiFetch(`/org-hierarchy/contacts/account/${accountId}`),
        apiFetch(`/org-hierarchy/accounts/${accountId}`).catch(() => ({ hierarchy: null })),
      ]);
      setTree(chartRes.tree || []);
      setAccountHierarchy(hierarchyRes.hierarchy || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { loadOrgChart(); }, [loadOrgChart]);

  const handleReportsToChange = async (contactId, newManagerId) => {
    await apiFetch(`/org-hierarchy/contacts/${contactId}/reports-to`, {
      method: 'PATCH',
      body: JSON.stringify({ reportsToContactId: newManagerId }),
    });
    await loadOrgChart();
  };

  // Flatten tree for the "Reports to" dropdown
  function flattenTree(nodes, result = []) {
    nodes.forEach(n => { result.push(n); if (n.children) flattenTree(n.children, result); });
    return result;
  }
  const flatContacts = flattenTree(tree);

  if (loading) {
    return (
      <div className="och-loading">
        <div className="och-spinner" />
        <span>Loading org chart…</span>
      </div>
    );
  }

  return (
    <div className="och-panel">
      {/* Sub-tab bar */}
      <div className="och-subtabs">
        <button
          className={`och-subtab ${activeTab === 'contacts' ? 'och-subtab--active' : ''}`}
          onClick={() => setActiveTab('contacts')}
        >
          🧑‍💼 Contact Reporting Structure
          <span className="och-subtab-count">{flatContacts.length}</span>
        </button>
        <button
          className={`och-subtab ${activeTab === 'accounts' ? 'och-subtab--active' : ''}`}
          onClick={() => setActiveTab('accounts')}
        >
          🏢 Account Hierarchy
        </button>
      </div>

      {error && <div className="och-error">{error}</div>}

      {/* ── Contact tree ── */}
      {activeTab === 'contacts' && (
        <div className="och-tree-area">
          {flatContacts.length === 0 ? (
            <div className="och-empty">
              <div className="och-empty-icon">🌳</div>
              <p>No reporting structure set yet.</p>
              <p className="och-empty-hint">
                Open any contact below and use the "Set manager" button to start building the org chart.
              </p>
              {allAccountContacts?.length > 0 && (
                <div className="och-unlinked-list">
                  <div className="och-unlinked-label">Contacts in this account:</div>
                  {allAccountContacts.map(c => (
                    <div key={c.id} className="och-unlinked-item">
                      <div className="och-unlinked-avatar"
                        style={{ background: `linear-gradient(135deg, ${getAvatarColor(c.first_name)[0]}, ${getAvatarColor(c.first_name)[1]})` }}>
                        {getInitials(c.first_name, c.last_name)}
                      </div>
                      <div>
                        <div className="och-unlinked-name">{c.first_name} {c.last_name}</div>
                        {c.title && <div className="och-unlinked-title">{c.title}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="och-roots">
              {tree.map(node => (
                <ContactNode
                  key={node.id}
                  contact={node}
                  allContacts={flatContacts}
                  onReportsToChange={handleReportsToChange}
                  onNavigate={onNavigateToContact}
                  depth={0}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Account hierarchy ── */}
      {activeTab === 'accounts' && (
        <AccountHierarchyView
          accountId={accountId}
          hierarchy={accountHierarchy}
          onRefresh={loadOrgChart}
          showAddRelationship={showAddRelationship}
          setShowAddRelationship={setShowAddRelationship}
        />
      )}
    </div>
  );
}

// ── Account hierarchy sub-panel ──────────────────────────────────────────────

function AccountHierarchyView({ accountId, hierarchy, onRefresh, showAddRelationship, setShowAddRelationship }) {
  const [allAccounts, setAllAccounts] = useState([]);
  const [newParentId, setNewParentId] = useState('');
  const [newChildId, setNewChildId] = useState('');
  const [relType, setRelType] = useState('subsidiary');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/accounts').then(r => setAllAccounts(r.accounts || r.data?.accounts || [])).catch(() => {});
  }, []);

  const handleAddRelationship = async () => {
    if (!newParentId || !newChildId) return;
    setSaving(true);
    try {
      await apiFetch('/org-hierarchy/accounts/relationship', {
        method: 'POST',
        body: JSON.stringify({ parentAccountId: newParentId, childAccountId: newChildId, relationshipType: relType }),
      });
      setShowAddRelationship(false);
      setNewParentId(''); setNewChildId('');
      onRefresh();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (parentId, childId) => {
    if (!window.confirm('Remove this relationship?')) return;
    const pid = parseInt(parentId, 10);
    const cid = parseInt(childId, 10);
    if (isNaN(pid) || isNaN(cid)) {
      console.error('handleRemove: invalid IDs', { parentId, childId });
      return;
    }
    await apiFetch(`/org-hierarchy/accounts/relationship?parentAccountId=${pid}&childAccountId=${cid}`, {
      method: 'DELETE',
    });
    onRefresh();
  };

  function renderAccountNode(node, depth = 0) {
    if (!node) return null;
    return (
      <div key={node.id} className="och-acct-node" style={{ '--depth': depth }}>
        <div className={`och-acct-card ${node.id === accountId ? 'och-acct-card--current' : ''}`}>
          <div className="och-acct-logo">{node.name.substring(0,2).toUpperCase()}</div>
          <div className="och-acct-info">
            <div className="och-acct-name">{node.name}</div>
            {node.industry && <div className="och-acct-industry">{node.industry}</div>}
            <div className="och-acct-stats">
              {node.activeDeals > 0 && <span>{node.activeDeals} deals</span>}
              {node.totalArr > 0 && <span>${(node.totalArr/1000).toFixed(0)}K ARR</span>}
            </div>
          </div>
          {node.relationship_type && depth > 0 && (
            <span className="och-rel-badge">{node.relationship_type}</span>
          )}
          {node.id !== accountId && (
            <button
              className="och-remove-rel"
              onClick={() => handleRemove(parseInt(node.parent_id || accountId, 10), parseInt(node.id, 10))}
              title="Remove relationship"
            >✕</button>
          )}
        </div>
        {node.children?.length > 0 && (
          <div className="och-acct-children">
            {node.children.map(child => renderAccountNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="och-acct-area">
      <div className="och-acct-toolbar">
        <button className="och-add-btn" onClick={() => setShowAddRelationship(v => !v)}>
          + Add Relationship
        </button>
      </div>

      {showAddRelationship && (
        <div className="och-add-form">
          <div className="och-add-form-title">Link Two Accounts</div>
          <div className="och-add-form-row">
            <div className="och-add-form-field">
              <label>Parent Account</label>
              <select value={newParentId} onChange={e => setNewParentId(e.target.value)} className="och-select">
                <option value="">Select parent…</option>
                {allAccounts.filter(a => a.id !== parseInt(newChildId)).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="och-add-form-field">
              <label>Child Account</label>
              <select value={newChildId} onChange={e => setNewChildId(e.target.value)} className="och-select">
                <option value="">Select child…</option>
                {allAccounts.filter(a => a.id !== parseInt(newParentId)).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="och-add-form-field">
              <label>Relationship</label>
              <select value={relType} onChange={e => setRelType(e.target.value)} className="och-select">
                <option value="subsidiary">Subsidiary</option>
                <option value="division">Division</option>
                <option value="partner">Partner</option>
                <option value="acquired">Acquired</option>
              </select>
            </div>
            <button className="och-save-btn" onClick={handleAddRelationship} disabled={saving || !newParentId || !newChildId}>
              {saving ? 'Saving…' : 'Add'}
            </button>
            <button className="och-cancel-btn" onClick={() => setShowAddRelationship(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!hierarchy || !hierarchy.tree ? (
        <div className="och-empty">
          <div className="och-empty-icon">🏢</div>
          <p>No account hierarchy set up yet.</p>
          <p className="och-empty-hint">Use "Add Relationship" to link parent companies, subsidiaries, or divisions.</p>
        </div>
      ) : (
        <div className="och-acct-tree">
          {hierarchy.ancestors?.length > 0 && (
            <div className="och-ancestors">
              <div className="och-ancestors-label">↑ Parent chain</div>
              {hierarchy.ancestors.map((a, i) => (
                <div key={a.id} className="och-ancestor-chip" style={{ marginLeft: i * 16 }}>
                  {a.name} <span className="och-rel-badge">{a.relationship_type}</span>
                </div>
              ))}
            </div>
          )}
          {renderAccountNode(hierarchy.tree, 0)}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ContactOrgPosition — mini widget for ContactsView detail panel (Option B)
// ═════════════════════════════════════════════════════════════════════════════

export function ContactOrgPosition({ contactId, accountId, onNavigateToContact, onViewFullChart }) {
  const [position, setPosition] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!contactId) return;
    setLoading(true);
    setError('');
    apiFetch(`/org-hierarchy/contacts/${contactId}/position`)
      .then(r => setPosition(r.position))
      .catch(err => {
        if (err.message?.includes('403')) setError('restricted');
        else setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [contactId]);

  if (loading) return (
    <div className="och-mini-loading">
      <div className="och-spinner och-spinner--sm" />
    </div>
  );

  if (error === 'restricted') return null; // silently hide if not authorised
  if (error || !position) return null;

  const { contact, manager, directReports } = position;
  const [c1, c2] = getAvatarColor(contact.first_name + contact.last_name);

  return (
    <div className="och-mini">
      <div className="och-mini-header">
        <span className="och-mini-title">🌳 Position in Org</span>
        {onViewFullChart && (
          <button className="och-mini-view-all" onClick={onViewFullChart}>
            View full chart →
          </button>
        )}
      </div>

      <div className="och-mini-tree">
        {/* Manager */}
        {manager && (
          <>
            <MiniNode
              contact={manager}
              variant="manager"
              onClick={() => onNavigateToContact && onNavigateToContact(manager.id)}
            />
            <div className="och-mini-vline" />
          </>
        )}

        {/* Self */}
        <MiniNode contact={contact} variant="self" avatarColors={[c1, c2]} />

        {/* Direct reports */}
        {directReports.length > 0 && (
          <>
            <div className="och-mini-vline" />
            <div className="och-mini-reports">
              {directReports.slice(0, 4).map(r => (
                <MiniNode
                  key={r.id}
                  contact={r}
                  variant="report"
                  onClick={() => onNavigateToContact && onNavigateToContact(r.id)}
                />
              ))}
              {directReports.length > 4 && (
                <div className="och-mini-more">+{directReports.length - 4} more</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MiniNode({ contact, variant, avatarColors, onClick }) {
  const [c1, c2] = avatarColors || getAvatarColor(contact.first_name + contact.last_name);
  const roleStyle = getRoleStyle(contact.role_type);
  const isSelf = variant === 'self';

  return (
    <div
      className={`och-mini-node och-mini-node--${variant} ${onClick ? 'och-mini-node--clickable' : ''}`}
      onClick={onClick}
    >
      <div
        className="och-mini-avatar"
        style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
      >
        {getInitials(contact.first_name, contact.last_name)}
      </div>
      <div className="och-mini-node-info">
        <div className="och-mini-node-name">
          {contact.first_name} {contact.last_name}
          {isSelf && <span className="och-mini-you">you</span>}
        </div>
        <div className="och-mini-node-title">{contact.org_chart_title || contact.title || ''}</div>
      </div>
      {contact.role_type && !isSelf && (
        <span className="och-mini-badge" style={{ background: roleStyle.bg, color: roleStyle.color }}>
          {roleStyle.label}
        </span>
      )}
    </div>
  );
}

export default OrgChartPanel;
