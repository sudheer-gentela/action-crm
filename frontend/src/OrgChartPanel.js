// OrgChartPanel.js
// Full org chart tab for AccountsView + mini position widget for ContactsView.
// Exports: OrgChartPanel (full), ContactOrgPosition (mini)
//
// v2: confidence (confirmed|best_guess), dotted-line cross-account reporting, unplaced contacts

import React, { useState, useEffect, useCallback } from 'react';
import api from './apiService';
import './OrgChartPanel.css';

async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toLowerCase();
  const body   = options.body ? JSON.parse(options.body) : undefined;
  const response = await api[method](path, body);
  return response.data;
}

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
function getInitials(first, last) { return `${first?.[0] || ''}${last?.[0] || ''}`.toUpperCase(); }
function getAvatarColor(name) {
  const colors = [['#1e40af','#3b82f6'],['#065f46','#10b981'],['#6b21a8','#a78bfa'],['#92400e','#f59e0b'],['#1e3a5f','#0ea5e9'],['#7f1d1d','#f87171'],['#064e3b','#34d399'],['#3730a3','#818cf8']];
  return colors[(name?.charCodeAt(0) || 0) % colors.length];
}

// ── ContactNode ───────────────────────────────────────────────────────────────
function ContactNode({ contact, allContacts, onReportsToChange, onNavigate, depth = 0 }) {
  const [expanded,         setExpanded]         = useState(depth < 2);
  const [editingReportsTo, setEditingReportsTo] = useState(false);
  const [savingReportsTo,  setSavingReportsTo]  = useState(false);
  const [confidence,       setConfidence]       = useState(contact.reports_to_confidence || 'confirmed');
  const [showDotted,       setShowDotted]       = useState(false);
  const [addingDotted,     setAddingDotted]     = useState(false);
  const [dottedMgrId,      setDottedMgrId]      = useState('');
  const [dottedNotes,      setDottedNotes]      = useState('');
  const [savingDotted,     setSavingDotted]     = useState(false);

  const hasChildren    = contact.children?.length > 0;
  const dottedMgrs     = contact.dotted_line_managers || [];
  const hasDotted      = dottedMgrs.length > 0;
  const isBestGuess    = contact.reports_to_confidence === 'best_guess';
  const roleStyle      = getRoleStyle(contact.role_type);
  const [c1, c2]       = getAvatarColor(contact.first_name + contact.last_name);
  const displayTitle   = contact.org_chart_title || contact.title || '';

  const saveReportsTo = async (newMgrId, conf) => {
    setSavingReportsTo(true);
    try { await onReportsToChange(contact.id, newMgrId ? parseInt(newMgrId) : null, conf || confidence); }
    finally { setSavingReportsTo(false); setEditingReportsTo(false); }
  };

  const handleAddDotted = async () => {
    if (!dottedMgrId) return;
    setSavingDotted(true);
    try {
      await apiFetch(`/org-hierarchy/contacts/${contact.id}/dotted-lines`, {
        method: 'POST',
        body: JSON.stringify({ dottedManagerId: parseInt(dottedMgrId), notes: dottedNotes || undefined }),
      });
      setAddingDotted(false); setDottedMgrId(''); setDottedNotes('');
      await onReportsToChange(contact.id, contact.reports_to_contact_id, contact.reports_to_confidence);
    } catch (err) { alert(err.message); }
    finally { setSavingDotted(false); }
  };

  const handleRemoveDotted = async (mgrId) => {
    if (!window.confirm('Remove this dotted-line relationship?')) return;
    try {
      await apiFetch(`/org-hierarchy/contacts/${contact.id}/dotted-lines?dottedManagerId=${mgrId}`, { method: 'DELETE' });
      await onReportsToChange(contact.id, contact.reports_to_contact_id, contact.reports_to_confidence);
    } catch (err) { alert(err.message); }
  };

  // Available contacts for dotted-line dropdown (exclude self and existing dotted managers)
  const dottedMgrIds = new Set(dottedMgrs.map(d => d.id));
  const dottedCandidates = allContacts.filter(c => c.id !== contact.id && !dottedMgrIds.has(c.id));

  return (
    <div className="och-node-wrapper" style={{ '--depth': depth }}>
      <div className={`och-card${isBestGuess ? ' och-card--best-guess' : ''}`}>
        {/* Avatar */}
        <div className="och-avatar" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, position: 'relative' }}>
          {getInitials(contact.first_name, contact.last_name)}
          {hasDotted && <span className="och-avatar-dotted-badge" title="Has dotted-line reports">⋯</span>}
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
              <span className="och-badge" style={{ background: roleStyle.bg, color: roleStyle.color }}>{roleStyle.label}</span>
            )}
            {isBestGuess && <span className="och-badge och-badge--best-guess">~ best guess</span>}
            {contact.engagement_level && (
              <span className="och-engagement-dot"
                style={{ background: ENGAGEMENT_COLORS[contact.engagement_level] || '#94a3b8' }}
                title={`${contact.engagement_level} engagement`} />
            )}
          </div>

          {/* Reports-to editor */}
          {editingReportsTo ? (
            <div className="och-reports-edit">
              <select className="och-select"
                defaultValue={contact.reports_to_contact_id || ''}
                onChange={e => saveReportsTo(e.target.value || null, confidence)}
                disabled={savingReportsTo} autoFocus onBlur={() => setEditingReportsTo(false)}>
                <option value="">— Unplaced (no manager) —</option>
                {allContacts.filter(c => c.id !== contact.id).map(c => (
                  <option key={c.id} value={c.id}>{c.first_name} {c.last_name}{c.title ? ` (${c.title})` : ''}</option>
                ))}
              </select>
              {contact.reports_to_contact_id && (
                <select className="och-select och-select--confidence" value={confidence}
                  onChange={e => setConfidence(e.target.value)} disabled={savingReportsTo}>
                  <option value="confirmed">✓ Confirmed</option>
                  <option value="best_guess">~ Best guess</option>
                </select>
              )}
              {savingReportsTo && <span className="och-saving">Saving…</span>}
            </div>
          ) : (
            <button className="och-reports-to-btn" onClick={() => setEditingReportsTo(true)} title="Change reporting line">
              {contact.reports_to_contact_id
                ? `Reports to: ${allContacts.find(c => c.id === contact.reports_to_contact_id)?.first_name || '…'}`
                : 'Set manager'} ✏️
            </button>
          )}

          {/* Dotted-line section */}
          <div className="och-dotted-section">
            <button className="och-dotted-toggle" onClick={() => setShowDotted(v => !v)}>
              <span className="och-dotted-line-icon">╌</span>
              {hasDotted ? `${dottedMgrs.length} dotted-line report${dottedMgrs.length > 1 ? 's' : ''}` : 'Add dotted-line'}
              <span style={{ marginLeft: 3 }}>{showDotted ? '▲' : '▼'}</span>
            </button>

            {showDotted && (
              <div className="och-dotted-list">
                {dottedMgrs.map(mgr => {
                  const [dc1, dc2] = getAvatarColor(mgr.first_name + mgr.last_name);
                  return (
                    <div key={mgr.id} className="och-dotted-item">
                      <div className="och-dotted-avatar" style={{ background: `linear-gradient(135deg, ${dc1}, ${dc2})` }}>
                        {getInitials(mgr.first_name, mgr.last_name)}
                      </div>
                      <div className="och-dotted-info">
                        <div className="och-dotted-name">{mgr.first_name} {mgr.last_name}</div>
                        <div className="och-dotted-meta">
                          {mgr.title && <span>{mgr.title}</span>}
                          {mgr.account_name && <span className="och-dotted-account"> @ {mgr.account_name}</span>}
                        </div>
                        {mgr.notes && <div className="och-dotted-notes">{mgr.notes}</div>}
                      </div>
                      <button className="och-dotted-remove" onClick={() => handleRemoveDotted(mgr.id)} title="Remove">✕</button>
                    </div>
                  );
                })}

                {addingDotted ? (
                  <div className="och-dotted-add-form">
                    <select className="och-select" value={dottedMgrId} onChange={e => setDottedMgrId(e.target.value)} disabled={savingDotted}>
                      <option value="">Select contact…</option>
                      {dottedCandidates.map(c => (
                        <option key={c.id} value={c.id}>{c.first_name} {c.last_name}{c.title ? ` (${c.title})` : ''}</option>
                      ))}
                    </select>
                    <input className="och-dotted-notes-input" placeholder="Notes (optional)"
                      value={dottedNotes} onChange={e => setDottedNotes(e.target.value)} disabled={savingDotted} />
                    <div className="och-dotted-form-actions">
                      <button className="och-save-btn" onClick={handleAddDotted} disabled={savingDotted || !dottedMgrId}>
                        {savingDotted ? 'Saving…' : 'Add'}
                      </button>
                      <button className="och-cancel-btn" onClick={() => setAddingDotted(false)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button className="och-dotted-add-btn" onClick={() => setAddingDotted(true)}>+ Add dotted-line</button>
                )}
              </div>
            )}
          </div>
        </div>

        {hasChildren && (
          <button className={`och-toggle${expanded ? ' och-toggle--open' : ''}`}
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Collapse' : `Expand (${contact.children.length})`}>
            {contact.children.length}
          </button>
        )}
      </div>

      {hasChildren && expanded && (
        <div className="och-children">
          <div className={`och-branch-line${isBestGuess ? ' och-branch-line--dashed' : ''}`} />
          <div className="och-children-list">
            {contact.children.map(child => (
              <ContactNode key={child.id} contact={child} allContacts={allContacts}
                onReportsToChange={onReportsToChange} onNavigate={onNavigate} depth={depth + 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── UnplacedSection ───────────────────────────────────────────────────────────
function UnplacedSection({ contacts, allContacts, onReportsToChange, onNavigate }) {
  const [expanded, setExpanded] = useState(true);
  if (!contacts || contacts.length === 0) return null;
  return (
    <div className="och-unplaced-section">
      <button className="och-unplaced-header" onClick={() => setExpanded(v => !v)}>
        <span className="och-unplaced-icon">❓</span>
        <span className="och-unplaced-title">Unplaced contacts</span>
        <span className="och-unplaced-count">{contacts.length}</span>
        <span className="och-unplaced-hint">— reporting line unknown</span>
        <span className="och-unplaced-chevron">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="och-unplaced-list">
          {contacts.map(c => (
            <ContactNode key={c.id} contact={c} allContacts={allContacts}
              onReportsToChange={onReportsToChange} onNavigate={onNavigate} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── OrgChartPanel ─────────────────────────────────────────────────────────────
export function OrgChartPanel({ accountId, accountName, allAccountContacts, onNavigateToContact }) {
  const [tree,                 setTree]                 = useState([]);
  const [unplaced,             setUnplaced]             = useState([]);
  const [loading,              setLoading]              = useState(true);
  const [error,                setError]                = useState('');
  const [accountHierarchy,     setAccountHierarchy]     = useState(null);
  const [activeTab,            setActiveTab]            = useState('contacts');
  const [showAddRelationship,  setShowAddRelationship]  = useState(false);

  const loadOrgChart = useCallback(async () => {
    if (!accountId) return;
    setLoading(true); setError('');
    try {
      const [chartRes, hierarchyRes] = await Promise.all([
        apiFetch(`/org-hierarchy/contacts/account/${accountId}`),
        apiFetch(`/org-hierarchy/accounts/${accountId}`).catch(() => ({ hierarchy: null })),
      ]);
      setTree(chartRes.tree || []);
      setUnplaced(chartRes.unplaced || []);
      setAccountHierarchy(hierarchyRes.hierarchy || null);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { loadOrgChart(); }, [loadOrgChart]);

  const handleReportsToChange = async (contactId, newManagerId, confidence = 'confirmed') => {
    await apiFetch(`/org-hierarchy/contacts/${contactId}/reports-to`, {
      method: 'PATCH',
      body: JSON.stringify({ reportsToContactId: newManagerId, confidence }),
    });
    await loadOrgChart();
  };

  function flattenTree(nodes, result = []) {
    nodes.forEach(n => { result.push(n); if (n.children) flattenTree(n.children, result); });
    return result;
  }
  const flatContacts  = [...flattenTree(tree), ...unplaced];
  const totalContacts = flatContacts.length;

  if (loading) return (
    <div className="och-loading"><div className="och-spinner" /><span>Loading org chart…</span></div>
  );

  return (
    <div className="och-panel">
      <div className="och-subtabs">
        <button className={`och-subtab${activeTab === 'contacts' ? ' och-subtab--active' : ''}`} onClick={() => setActiveTab('contacts')}>
          🧑‍💼 Contact Reporting Structure
          <span className="och-subtab-count">{totalContacts}</span>
        </button>
        <button className={`och-subtab${activeTab === 'accounts' ? ' och-subtab--active' : ''}`} onClick={() => setActiveTab('accounts')}>
          🏢 Account Hierarchy
        </button>
      </div>

      {error && <div className="och-error">{error}</div>}

      {activeTab === 'contacts' && (
        <div className="och-tree-area">
          {totalContacts === 0 ? (
            <div className="och-empty">
              <div className="och-empty-icon">🌳</div>
              <p>No reporting structure set yet.</p>
              <p className="och-empty-hint">Open any contact and use "Set manager" to build the org chart.</p>
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
            <>
              <div className="och-legend">
                <span className="och-legend-item"><span className="och-legend-line och-legend-line--solid" /> Confirmed</span>
                <span className="och-legend-item"><span className="och-legend-line och-legend-line--dashed" /> Best guess</span>
                <span className="och-legend-item"><span className="och-legend-dotted-icon">╌</span> Dotted-line</span>
              </div>
              <div className="och-roots">
                {tree.map(node => (
                  <ContactNode key={node.id} contact={node} allContacts={flatContacts}
                    onReportsToChange={handleReportsToChange} onNavigate={onNavigateToContact} depth={0} />
                ))}
              </div>
              <UnplacedSection contacts={unplaced} allContacts={flatContacts}
                onReportsToChange={handleReportsToChange} onNavigate={onNavigateToContact} />
            </>
          )}
        </div>
      )}

      {activeTab === 'accounts' && (
        <AccountHierarchyView accountId={accountId} hierarchy={accountHierarchy}
          onRefresh={loadOrgChart} showAddRelationship={showAddRelationship}
          setShowAddRelationship={setShowAddRelationship} />
      )}
    </div>
  );
}

// ── AccountHierarchyView ──────────────────────────────────────────────────────
function AccountHierarchyView({ accountId, hierarchy, onRefresh, showAddRelationship, setShowAddRelationship }) {
  const [allAccounts, setAllAccounts] = useState([]);
  const [newParentId, setNewParentId] = useState('');
  const [newChildId,  setNewChildId]  = useState('');
  const [relType,     setRelType]     = useState('subsidiary');
  const [saving,      setSaving]      = useState(false);

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
      setShowAddRelationship(false); setNewParentId(''); setNewChildId('');
      onRefresh();
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const handleRemove = async (parentId, childId) => {
    if (!window.confirm('Remove this relationship?')) return;
    const pid = parseInt(parentId, 10);
    const cid = parseInt(childId, 10);
    if (isNaN(pid) || isNaN(cid)) { console.error('handleRemove: invalid IDs', { parentId, childId }); return; }
    await apiFetch(`/org-hierarchy/accounts/relationship?parentAccountId=${pid}&childAccountId=${cid}`, { method: 'DELETE' });
    onRefresh();
  };

  function renderAccountNode(node, depth = 0) {
    if (!node) return null;
    return (
      <div key={node.id} className="och-acct-node" style={{ '--depth': depth }}>
        <div className={`och-acct-card${node.id === accountId ? ' och-acct-card--current' : ''}`}>
          <div className="och-acct-logo">{node.name.substring(0,2).toUpperCase()}</div>
          <div className="och-acct-info">
            <div className="och-acct-name">{node.name}</div>
            {node.industry && <div className="och-acct-industry">{node.industry}</div>}
            <div className="och-acct-stats">
              {node.activeDeals > 0 && <span>{node.activeDeals} deals</span>}
              {node.totalArr > 0 && <span>${(node.totalArr/1000).toFixed(0)}K ARR</span>}
            </div>
          </div>
          {node.relationship_type && depth > 0 && <span className="och-rel-badge">{node.relationship_type}</span>}
          {node.id !== accountId && (
            <button className="och-remove-rel"
              onClick={() => {
                const isAncestor = !node.parent_id;
                handleRemove(
                  isAncestor ? node.id : node.parent_id,
                  isAncestor ? accountId : node.id
                );
              }}
              title="Remove relationship">✕</button>
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
        <button className="och-add-btn" onClick={() => setShowAddRelationship(v => !v)}>+ Add Relationship</button>
      </div>
      {showAddRelationship && (
        <div className="och-add-form">
          <div className="och-add-form-title">Link Two Accounts</div>
          <div className="och-add-form-row">
            <div className="och-add-form-field">
              <label>Parent Account</label>
              <select value={newParentId} onChange={e => setNewParentId(e.target.value)} className="och-select">
                <option value="">Select parent…</option>
                {allAccounts.filter(a => a.id !== parseInt(newChildId)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="och-add-form-field">
              <label>Child Account</label>
              <select value={newChildId} onChange={e => setNewChildId(e.target.value)} className="och-select">
                <option value="">Select child…</option>
                {allAccounts.filter(a => a.id !== parseInt(newParentId)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
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

// ── ContactOrgPosition — mini widget ─────────────────────────────────────────
export function ContactOrgPosition({ contactId, accountId, onNavigateToContact, onViewFullChart }) {
  const [position, setPosition] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');

  useEffect(() => {
    if (!contactId) return;
    setLoading(true); setError('');
    apiFetch(`/org-hierarchy/contacts/${contactId}/position`)
      .then(r => setPosition(r.position))
      .catch(err => { if (err.message?.includes('403')) setError('restricted'); else setError(err.message); })
      .finally(() => setLoading(false));
  }, [contactId]);

  if (loading) return <div className="och-mini-loading"><div className="och-spinner och-spinner--sm" /></div>;
  if (error === 'restricted') return null;
  if (error || !position) return null;

  const { contact, manager, directReports, dottedManagers = [], dottedReports = [] } = position;
  const [c1, c2]    = getAvatarColor(contact.first_name + contact.last_name);
  const isBestGuess = contact.reports_to_confidence === 'best_guess';

  return (
    <div className="och-mini">
      <div className="och-mini-header">
        <span className="och-mini-title">🌳 Position in Org</span>
        {onViewFullChart && <button className="och-mini-view-all" onClick={onViewFullChart}>View full chart →</button>}
      </div>
      <div className="och-mini-tree">
        {manager && (
          <>
            <MiniNode contact={manager} variant="manager" onClick={() => onNavigateToContact && onNavigateToContact(manager.id)} />
            <div className={`och-mini-vline${isBestGuess ? ' och-mini-vline--dashed' : ''}`} />
          </>
        )}
        <MiniNode contact={contact} variant="self" avatarColors={[c1, c2]} />
        {isBestGuess && <div className="och-mini-best-guess">~ best guess placement</div>}

        {dottedManagers.length > 0 && (
          <div className="och-mini-dotted-section">
            <div className="och-mini-dotted-label">╌ Dotted-line reports to</div>
            {dottedManagers.map(mgr => (
              <MiniNode key={mgr.id} contact={mgr} variant="dotted" accountName={mgr.account_name}
                onClick={() => onNavigateToContact && onNavigateToContact(mgr.id)} />
            ))}
          </div>
        )}

        {directReports.length > 0 && (
          <>
            <div className="och-mini-vline" />
            <div className="och-mini-reports">
              {directReports.slice(0, 4).map(r => (
                <MiniNode key={r.id} contact={r} variant="report"
                  onClick={() => onNavigateToContact && onNavigateToContact(r.id)} />
              ))}
              {directReports.length > 4 && <div className="och-mini-more">+{directReports.length - 4} more</div>}
            </div>
          </>
        )}

        {dottedReports.length > 0 && (
          <div className="och-mini-dotted-section">
            <div className="och-mini-dotted-label">╌ Dotted-line reports</div>
            {dottedReports.slice(0, 3).map(r => (
              <MiniNode key={r.id} contact={r} variant="dotted" accountName={r.account_name}
                onClick={() => onNavigateToContact && onNavigateToContact(r.id)} />
            ))}
            {dottedReports.length > 3 && <div className="och-mini-more">+{dottedReports.length - 3} more</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function MiniNode({ contact, variant, avatarColors, onClick, accountName }) {
  const [c1, c2] = avatarColors || getAvatarColor(contact.first_name + contact.last_name);
  const roleStyle = getRoleStyle(contact.role_type);
  const isSelf   = variant === 'self';
  const isDotted = variant === 'dotted';
  return (
    <div className={`och-mini-node och-mini-node--${variant}${onClick ? ' och-mini-node--clickable' : ''}`} onClick={onClick}>
      <div className="och-mini-avatar" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
        {getInitials(contact.first_name, contact.last_name)}
      </div>
      <div className="och-mini-node-info">
        <div className="och-mini-node-name">
          {contact.first_name} {contact.last_name}
          {isSelf && <span className="och-mini-you">you</span>}
        </div>
        <div className="och-mini-node-title">
          {contact.org_chart_title || contact.title || ''}
          {isDotted && accountName && <span className="och-mini-node-account"> @ {accountName}</span>}
        </div>
      </div>
      {contact.role_type && !isSelf && (
        <span className="och-mini-badge" style={{ background: roleStyle.bg, color: roleStyle.color }}>{roleStyle.label}</span>
      )}
    </div>
  );
}

export default OrgChartPanel;
