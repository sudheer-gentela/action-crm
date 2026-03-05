// ─────────────────────────────────────────────────────────────────────────────
// OAProducts.js
//
// Product Catalog management — Org Admin → Products tab.
// Uses recursive product_groups tree (any depth).
// Pattern: matches OAStages.js — apiFetch helper, flash(), sv-panel, sv-card.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

// ── Constants ────────────────────────────────────────────────────────────────

const PRODUCT_TYPES    = [{ value: 'one_time', label: 'One-time' }, { value: 'recurring', label: 'Recurring' }];
const BILLING_FREQS    = [{ value: '', label: '— n/a —' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annual', label: 'Annual' }, { value: 'multi_year', label: 'Multi-year' }];
const FEE_TYPES        = [{ value: '', label: '— none —' }, { value: 'setup', label: 'Setup fee' }, { value: 'license', label: 'License fee' }, { value: 'service', label: 'Service fee' }];
const STATUS_OPTS      = [{ value: 'active', label: 'Active', color: '#059669' }, { value: 'deprecated', label: 'Deprecated', color: '#d97706' }, { value: 'sunset', label: 'Sunset', color: '#dc2626' }];
const DEPTH_COLORS     = ['#4338ca', '#0d9488', '#c2410c', '#7c3aed', '#0369a1', '#b91c1c', '#059669', '#d97706'];

const EMPTY_PRODUCT = {
  name: '', sku: '', description: '', group_id: '',
  product_type: 'one_time', billing_frequency: '', fee_type: '',
  list_price: '', is_taxable: false, status: 'active', sort_order: 0,
};

// ── Tree helpers ─────────────────────────────────────────────────────────────

function buildTree(flatGroups) {
  const map = {};
  const roots = [];
  flatGroups.forEach(g => { map[g.id] = { ...g, children: [] }; });
  flatGroups.forEach(g => {
    if (g.parent_id && map[g.parent_id]) {
      map[g.parent_id].children.push(map[g.id]);
    } else {
      roots.push(map[g.id]);
    }
  });
  return { roots, map };
}

function flattenTree(roots, depth = 0) {
  const result = [];
  roots.forEach(node => {
    result.push({ ...node, depth });
    if (node.children?.length) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  });
  return result;
}

function getAncestorPath(map, groupId) {
  const parts = [];
  let current = map[groupId];
  while (current) {
    parts.unshift(current.name);
    current = current.parent_id ? map[current.parent_id] : null;
  }
  return parts.join(' > ');
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════

export default function OAProducts() {
  const [products, setProducts]       = useState([]);
  const [groups, setGroups]           = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [editing, setEditing]         = useState(null);
  const [form, setForm]               = useState({ ...EMPTY_PRODUCT });
  const [saving, setSaving]           = useState(false);
  const [search, setSearch]           = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [collapsedGroups, setCollapsedGroups] = useState({});

  // Group management
  const [showGroupMgr, setShowGroupMgr]   = useState(false);
  const [groupForm, setGroupForm]         = useState({ name: '', description: '', parent_id: '', level_label: '' });
  const [editingGroup, setEditingGroup]   = useState(null);
  const [savingGroup, setSavingGroup]     = useState(false);

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [prodRes, grpRes] = await Promise.all([
        apiFetch(`/products${statusFilter ? '?status=' + statusFilter : ''}`),
        apiFetch('/products/groups'),
      ]);
      setProducts(prodRes.data?.products || []);
      setGroups(grpRes.data?.groups || []);
    } catch (e) { flash('error', e.message); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const { roots: treeRoots, map: groupMap } = buildTree(groups);
  const flatTree = flattenTree(treeRoots);

  // ── Product CRUD ───────────────────────────────────────────────────────

  const startNew = () => { setForm({ ...EMPTY_PRODUCT }); setEditing('new'); };
  const startEdit = (p) => {
    setForm({
      name: p.name, sku: p.sku || '', description: p.description || '',
      group_id: p.group_id || '', product_type: p.product_type,
      billing_frequency: p.billing_frequency || '', fee_type: p.fee_type || '',
      list_price: p.list_price, is_taxable: p.is_taxable, status: p.status, sort_order: p.sort_order,
    });
    setEditing(p.id);
  };
  const cancelEdit = () => { setEditing(null); setForm({ ...EMPTY_PRODUCT }); };

  const saveProduct = async () => {
    if (!form.name.trim()) { flash('error', 'Product name is required'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        list_price: parseFloat(form.list_price) || 0,
        group_id: form.group_id ? parseInt(form.group_id) : null,
        billing_frequency: form.product_type === 'recurring' ? form.billing_frequency || null : null,
      };
      if (editing === 'new') {
        await apiFetch('/products', { method: 'POST', body: JSON.stringify(payload) });
        flash('success', `"${form.name}" created`);
      } else {
        await apiFetch(`/products/${editing}`, { method: 'PUT', body: JSON.stringify(payload) });
        flash('success', `"${form.name}" updated`);
      }
      cancelEdit(); load();
    } catch (e) { flash('error', e.message); }
    finally { setSaving(false); }
  };

  const deleteProduct = async (p) => {
    if (!window.confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    try { await apiFetch(`/products/${p.id}`, { method: 'DELETE' }); flash('success', `"${p.name}" deleted`); load(); }
    catch (e) { flash('error', e.message); }
  };

  // ── Group CRUD ─────────────────────────────────────────────────────────

  const saveGroup = async () => {
    if (!groupForm.name.trim()) return;
    setSavingGroup(true);
    try {
      const payload = { ...groupForm, parent_id: groupForm.parent_id ? parseInt(groupForm.parent_id) : null };
      if (editingGroup) {
        await apiFetch(`/products/groups/${editingGroup}`, { method: 'PUT', body: JSON.stringify(payload) });
        flash('success', 'Group updated');
      } else {
        await apiFetch('/products/groups', { method: 'POST', body: JSON.stringify(payload) });
        flash('success', 'Group created');
      }
      setGroupForm({ name: '', description: '', parent_id: '', level_label: '' }); setEditingGroup(null);
      const r = await apiFetch('/products/groups'); setGroups(r.data?.groups || []);
    } catch (e) { flash('error', e.message); }
    finally { setSavingGroup(false); }
  };

  const deleteGroup = async (g) => {
    if (!window.confirm(`Delete "${g.name}"?`)) return;
    try {
      await apiFetch(`/products/groups/${g.id}`, { method: 'DELETE' });
      flash('success', 'Group deleted');
      const r = await apiFetch('/products/groups'); setGroups(r.data?.groups || []);
    } catch (e) { flash('error', e.message); }
  };

  // ── Filter & group products ────────────────────────────────────────────

  const filtered = products.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.sku || '').toLowerCase().includes(search.toLowerCase())
  );

  // Build map of group_id -> products
  const productsByGroup = {};
  const ungrouped = [];
  filtered.forEach(p => {
    if (p.group_id && groupMap[p.group_id]) {
      if (!productsByGroup[p.group_id]) productsByGroup[p.group_id] = [];
      productsByGroup[p.group_id].push(p);
    } else {
      ungrouped.push(p);
    }
  });

  // Count products under a group (including descendants)
  function countProducts(node) {
    let count = (productsByGroup[node.id] || []).length;
    (node.children || []).forEach(child => { count += countProducts(child); });
    return count;
  }

  const toggleGroup = (gid) => setCollapsedGroups(prev => ({ ...prev, [gid]: !prev[gid] }));

  // Check if a group or any of its descendants are collapsed
  function isGroupVisible(groupId) {
    let current = groupMap[groupId];
    while (current && current.parent_id) {
      if (collapsedGroups[current.parent_id]) return false;
      current = groupMap[current.parent_id];
    }
    return true;
  }

  if (loading) return <div className="sv-loading" style={{ padding: 24 }}>Loading product catalog…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📦 Product Catalog</h2>
          <p className="sv-panel-desc">
            Manage products grouped in a hierarchy (e.g. Product Line → Category → Product).
            Groups can be nested to any depth.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <div className="sv-panel-body">
        {/* ── Toolbar ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="oa-search" style={{ maxWidth: 240 }} placeholder="Search products…" value={search} onChange={e => setSearch(e.target.value)} />
            <select className="oa-select" style={{ maxWidth: 140 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="sv-btn-sm" onClick={() => setShowGroupMgr(!showGroupMgr)}>
              🗂️ Groups
            </button>
            <button className="sv-btn-primary" onClick={startNew}>+ Add Product</button>
          </div>
        </div>

        {/* ── Group manager ── */}
        {showGroupMgr && (
          <div className="sv-card" style={{ background: '#f8fafc', marginBottom: 16 }}>
            <h3>🗂️ Product Groups</h3>
            <p className="sv-hint">Create a hierarchy: e.g. Product Line → Category → Sub-category. Nest as deep as you need.</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Name</label>
                <input className="oa-input" style={{ width: 180 }} placeholder="Group name" value={groupForm.name}
                  onChange={e => setGroupForm({ ...groupForm, name: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter') saveGroup(); }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Parent</label>
                <select className="oa-select" style={{ width: 200 }} value={groupForm.parent_id} onChange={e => setGroupForm({ ...groupForm, parent_id: e.target.value })}>
                  <option value="">— root level —</option>
                  {flatTree.map(g => (
                    <option key={g.id} value={g.id}>{'  '.repeat(g.depth)}{g.level_label ? `[${g.level_label}] ` : ''}{g.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Level Label</label>
                <input className="oa-input" style={{ width: 140 }} placeholder="e.g. Product Line" value={groupForm.level_label}
                  onChange={e => setGroupForm({ ...groupForm, level_label: e.target.value })} />
              </div>
              <button className="sv-btn-primary" onClick={saveGroup} disabled={savingGroup}>
                {savingGroup ? '…' : editingGroup ? 'Update' : 'Add'}
              </button>
              {editingGroup && <button className="sv-btn-sm" onClick={() => { setEditingGroup(null); setGroupForm({ name: '', description: '', parent_id: '', level_label: '' }); }}>Cancel</button>}
            </div>

            {/* Tree display */}
            {groups.length === 0 ? (
              <p className="sv-empty">No groups yet. Create your first one above.</p>
            ) : (
              <div style={{ marginTop: 8 }}>
                {flatTree.map(g => (
                  <div key={g.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 8px', paddingLeft: 8 + g.depth * 24,
                    borderBottom: '1px solid #f3f4f6', fontSize: 13,
                  }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: DEPTH_COLORS[g.depth % DEPTH_COLORS.length], flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: '#374151' }}>{g.name}</span>
                    {g.level_label && g.level_label !== 'Category' && (
                      <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }}>{g.level_label}</span>
                    )}
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>({g.product_count || 0} products)</span>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                      <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#6b7280' }}
                        onClick={() => { setEditingGroup(g.id); setGroupForm({ name: g.name, description: g.description || '', parent_id: g.parent_id || '', level_label: g.level_label || '' }); }}>✏️</button>
                      <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#dc2626' }}
                        onClick={() => deleteGroup(g)}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Add / Edit product form ── */}
        {editing && (
          <div className="oa-stage-add-form" style={{ border: '2px solid #818cf8', background: '#faf5ff', marginBottom: 16, padding: 20, borderRadius: 10 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: '#4338ca' }}>
              {editing === 'new' ? '✨ New Product' : '✏️ Edit Product'}
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div><label className="oa-stage-label">Name *</label><input className="oa-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
              <div><label className="oa-stage-label">SKU</label><input className="oa-input" value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} /></div>
              <div>
                <label className="oa-stage-label">Group</label>
                <select className="oa-select" value={form.group_id} onChange={e => setForm({ ...form, group_id: e.target.value })}>
                  <option value="">— ungrouped —</option>
                  {flatTree.map(g => (
                    <option key={g.id} value={g.id}>{'  '.repeat(g.depth)}{g.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginTop: 12 }}><label className="oa-stage-label">Description</label><textarea className="oa-input" style={{ minHeight: 50 }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
              <div><label className="oa-stage-label">Type</label><select className="oa-select" value={form.product_type} onChange={e => setForm({ ...form, product_type: e.target.value })}>{PRODUCT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
              {form.product_type === 'recurring' && (
                <div><label className="oa-stage-label">Billing Frequency</label><select className="oa-select" value={form.billing_frequency} onChange={e => setForm({ ...form, billing_frequency: e.target.value })}>{BILLING_FREQS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}</select></div>
              )}
              <div><label className="oa-stage-label">Fee Type</label><select className="oa-select" value={form.fee_type} onChange={e => setForm({ ...form, fee_type: e.target.value })}>{FEE_TYPES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}</select></div>
              <div><label className="oa-stage-label">List Price</label><input className="oa-input" type="number" step="0.01" value={form.list_price} onChange={e => setForm({ ...form, list_price: e.target.value })} /></div>
              <div><label className="oa-stage-label">Status</label><select className="oa-select" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>{STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
            </div>

            <div className="oa-stage-add-row oa-stage-add-row--checkbox" style={{ marginTop: 12 }}>
              <label><input type="checkbox" checked={form.is_taxable} onChange={e => setForm({ ...form, is_taxable: e.target.checked })} /> Taxable</label>
            </div>

            <div className="oa-stage-add-row oa-stage-add-row--actions" style={{ marginTop: 16 }}>
              <button className="sv-btn-primary" onClick={saveProduct} disabled={saving || !form.name.trim()}>{saving ? '…' : 'Save Product'}</button>
              <button className="sv-btn-sm" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        )}

        {/* ── Grouped product table (recursive tree) ── */}
        {filtered.length === 0 && !editing ? (
          <div className="sv-empty" style={{ padding: 32, textAlign: 'center' }}>
            <p style={{ fontSize: 15, marginBottom: 8 }}>No products found.</p>
            <button className="sv-btn-primary" onClick={startNew}>+ Create your first product</button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                  {['Name', 'SKU', 'Type', 'Fee', 'Price', 'Status', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '10px 8px', fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Render tree recursively */}
                {treeRoots.map(root => (
                  <GroupSection key={root.id} node={root} depth={0} productsByGroup={productsByGroup}
                    collapsedGroups={collapsedGroups} toggleGroup={toggleGroup} groupMap={groupMap}
                    onEditProduct={startEdit} onDeleteProduct={deleteProduct} countProducts={countProducts} />
                ))}

                {/* Ungrouped */}
                {ungrouped.length > 0 && (
                  <React.Fragment>
                    <tr onClick={() => toggleGroup('ungrouped')} style={{ cursor: 'pointer', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                      <td colSpan={7} style={{ padding: '10px 8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ color: '#9ca3af', fontSize: 11, width: 16, textAlign: 'center', transition: 'transform 0.15s', transform: collapsedGroups['ungrouped'] ? 'rotate(-90deg)' : 'rotate(0)' }}>▼</span>
                          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#94a3b8', flexShrink: 0 }} />
                          <span style={{ fontWeight: 700, fontSize: 14, color: '#64748b' }}>Ungrouped</span>
                          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8' }}>{ungrouped.length} products</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedGroups['ungrouped'] && ungrouped.map(p => <ProductRow key={p.id} product={p} indent={1} onEdit={() => startEdit(p)} onDelete={() => deleteProduct(p)} />)}
                  </React.Fragment>
                )}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 13, color: '#9ca3af' }}>
            {groups.length} groups · {filtered.length} products
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Recursive Group Section
// ═══════════════════════════════════════════════════════════════════════════

function GroupSection({ node, depth, productsByGroup, collapsedGroups, toggleGroup, groupMap, onEditProduct, onDeleteProduct, countProducts }) {
  const isCollapsed = collapsedGroups[node.id];
  const color = DEPTH_COLORS[depth % DEPTH_COLORS.length];
  const totalProducts = countProducts(node);
  const directProducts = productsByGroup[node.id] || [];

  return (
    <React.Fragment>
      {/* Group header row */}
      <tr onClick={() => toggleGroup(node.id)} style={{ cursor: 'pointer', background: depth === 0 ? '#f8fafc' : '#fbfcfd', borderBottom: '1px solid #e5e7eb' }}>
        <td colSpan={7} style={{ padding: '10px 8px', paddingLeft: 8 + depth * 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#9ca3af', fontSize: 11, width: 16, textAlign: 'center', transition: 'transform 0.15s', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0)' }}>▼</span>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{node.name}</span>
            {node.level_label && node.level_label !== 'Category' && (
              <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }}>{node.level_label}</span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>
              {totalProducts} product{totalProducts !== 1 ? 's' : ''}
            </span>
          </div>
        </td>
      </tr>

      {/* Children groups + products (when expanded) */}
      {!isCollapsed && (
        <React.Fragment>
          {/* Child groups first */}
          {(node.children || []).map(child => (
            <GroupSection key={child.id} node={child} depth={depth + 1} productsByGroup={productsByGroup}
              collapsedGroups={collapsedGroups} toggleGroup={toggleGroup} groupMap={groupMap}
              onEditProduct={onEditProduct} onDeleteProduct={onDeleteProduct} countProducts={countProducts} />
          ))}
          {/* Then direct products */}
          {directProducts.map(p => (
            <ProductRow key={p.id} product={p} indent={depth + 1} onEdit={() => onEditProduct(p)} onDelete={() => onDeleteProduct(p)} />
          ))}
        </React.Fragment>
      )}
    </React.Fragment>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Product Row
// ═══════════════════════════════════════════════════════════════════════════

function ProductRow({ product: p, indent, onEdit, onDelete }) {
  const statusMeta = STATUS_OPTS.find(o => o.value === p.status) || STATUS_OPTS[0];
  return (
    <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
      <td style={{ padding: '10px 8px', paddingLeft: 8 + indent * 24 + 16 }}>
        <div style={{ fontWeight: 500, color: '#111827' }}>{p.name}</div>
        {p.description && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 1, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.description}</div>}
      </td>
      <td style={{ padding: '10px 8px', color: '#6b7280', fontFamily: 'monospace', fontSize: 13 }}>{p.sku || '—'}</td>
      <td style={{ padding: '10px 8px' }}>
        <span style={{ fontSize: 12, color: p.product_type === 'recurring' ? '#2563eb' : '#6b7280' }}>
          {p.product_type === 'recurring' ? `Recurring (${p.billing_frequency || '—'})` : 'One-time'}
        </span>
      </td>
      <td style={{ padding: '10px 8px', color: '#6b7280', fontSize: 12 }}>{p.fee_type || '—'}</td>
      <td style={{ padding: '10px 8px', fontWeight: 600, color: '#059669' }}>${parseFloat(p.list_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      <td style={{ padding: '10px 8px' }}>
        <span style={{ background: statusMeta.color, color: '#fff', borderRadius: 12, padding: '2px 10px', fontSize: 11, fontWeight: 600, display: 'inline-block' }}>
          {statusMeta.label}
        </span>
      </td>
      <td style={{ padding: '10px 8px', textAlign: 'right' }}>
        <button className="sv-btn-sm" style={{ marginRight: 4 }} onClick={onEdit}>Edit</button>
        <button className="sv-btn-sm sv-btn-sm--danger" onClick={onDelete}>Delete</button>
      </td>
    </tr>
  );
}
