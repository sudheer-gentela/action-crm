/* Extracted from OrgAdminView.js — Phase 1 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAHierarchy. Rendered by the OrgAdmin shell. */
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';
import { HIERARCHY_ROLES } from '../constants';
import { HierarchyRoleBadge } from '../shared';

export default function OAHierarchy() {
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
  const [importing, setImporting]       = useState(false);
  const [importResult, setImportResult] = useState(null); // summary from last import

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

  const handleCsvImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    setError('');
    try {
      const res = await apiService.orgAdmin.importHierarchy(file);
      setImportResult(res.summary);
      if (res.summary.imported > 0) {
        setSuccess(`Imported ${res.summary.imported} row${res.summary.imported !== 1 ? 's' : ''} successfully`);
        load(); // refresh tree
      } else {
        setError('No rows were imported — check the warnings below');
      }
    } catch (err) {
      setError(err.message || 'CSV import failed');
    } finally {
      setImporting(false);
      e.target.value = ''; // reset so same file can be re-uploaded after a fix
    }
  };

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
            <input type="checkbox" checked={showDotted} onChange={e => setShowDotted(e.target.checked)}
              style={{ accentColor: '#f59e0b' }} />
            Show dotted lines
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
            <input
              type="file"
              accept=".csv"
              style={{ display: 'none' }}
              onChange={handleCsvImport}
              disabled={importing}
            />
            <button
              style={{
                fontSize: '12px', fontWeight: 600, padding: '5px 12px',
                borderRadius: '6px', border: '1px solid #c7d2fe', cursor: importing ? 'wait' : 'pointer',
                background: '#eef2ff', color: '#4338ca',
                opacity: importing ? 0.6 : 1,
              }}
              onClick={e => e.currentTarget.previousSibling.click()}
              disabled={importing}
              title="Upload a CSV with columns: email, manager_email, hierarchy_role, team_name"
            >
              {importing ? '⏳ Importing…' : '⬆ Import CSV'}
            </button>
          </label>
        </div>
      </div>

      {/* CSV import result summary */}
      {importResult && (
        <div style={{
          background: importResult.imported > 0 ? '#f0fdf4' : '#fffbeb',
          border: `1px solid ${importResult.imported > 0 ? '#bbf7d0' : '#fde68a'}`,
          borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', fontSize: '13px',
        }}>
          <div style={{ fontWeight: 600, marginBottom: importResult.errors.length > 0 ? 6 : 0 }}>
            Import complete — {importResult.imported} imported, {importResult.skipped} skipped
            {importResult.teams > 0 && `, ${importResult.teams} team${importResult.teams !== 1 ? 's' : ''} updated`}
          </div>
          {importResult.errors.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', color: '#b45309', fontSize: '12px' }}>
                {importResult.errors.length} warning{importResult.errors.length !== 1 ? 's' : ''}
              </summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: '20px', color: '#92400e', fontSize: '12px' }}>
                {importResult.errors.map((msg, i) => <li key={i}>{msg}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

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
              Add members from the list below, drag to arrange, or use <strong>⬆ Import CSV</strong> to bulk-load from a spreadsheet.
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
