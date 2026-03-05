// ─────────────────────────────────────────────────────────────────────────────
// OAProducts.js
//
// Product Catalog management — Org Admin → Products tab.
// Grouped by category with collapsible sections.
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

const PRODUCT_TYPES = [
  { value: 'one_time',  label: 'One-time' },
  { value: 'recurring', label: 'Recurring' },
];

const BILLING_FREQS = [
  { value: '',           label: '— n/a —' },
  { value: 'monthly',    label: 'Monthly' },
  { value: 'quarterly',  label: 'Quarterly' },
  { value: 'annual',     label: 'Annual' },
  { value: 'multi_year', label: 'Multi-year' },
];

const FEE_TYPES = [
  { value: '',        label: '— none —' },
  { value: 'setup',   label: 'Setup fee' },
  { value: 'license', label: 'License fee' },
  { value: 'service', label: 'Service fee' },
];

const STATUS_OPTS = [
  { value: 'active',     label: 'Active',     color: '#059669' },
  { value: 'deprecated', label: 'Deprecated', color: '#d97706' },
  { value: 'sunset',     label: 'Sunset',     color: '#dc2626' },
];

const CAT_COLORS = ['#4338ca', '#0d9488', '#c2410c', '#7c3aed', '#0369a1', '#b91c1c', '#4f46e5', '#059669'];

const EMPTY_PRODUCT = {
  name: '', sku: '', description: '', category_id: '',
  product_type: 'one_time', billing_frequency: '', fee_type: '',
  list_price: '', is_taxable: false, status: 'active', sort_order: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════

export default function OAProducts() {
  const [products, setProducts]       = useState([]);
  const [categories, setCategories]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [editing, setEditing]         = useState(null);   // product id or 'new'
  const [form, setForm]               = useState({ ...EMPTY_PRODUCT });
  const [saving, setSaving]           = useState(false);
  const [search, setSearch]           = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [collapsedCats, setCollapsedCats] = useState({});

  // Category management
  const [showCatMgr, setShowCatMgr]     = useState(false);
  const [catForm, setCatForm]           = useState({ name: '', description: '' });
  const [editingCat, setEditingCat]     = useState(null);
  const [savingCat, setSavingCat]       = useState(false);

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [prodRes, catRes] = await Promise.all([
        apiFetch(`/products${statusFilter ? '?status=' + statusFilter : ''}`),
        apiFetch('/products/categories'),
      ]);
      setProducts(prodRes.data?.products || []);
      setCategories(catRes.data?.categories || []);
    } catch (e) { flash('error', e.message); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  // ── Product CRUD ───────────────────────────────────────────────────────

  const startNew = () => { setForm({ ...EMPTY_PRODUCT }); setEditing('new'); };
  const startEdit = (p) => {
    setForm({
      name: p.name, sku: p.sku || '', description: p.description || '',
      category_id: p.category_id || '', product_type: p.product_type,
      billing_frequency: p.billing_frequency || '', fee_type: p.fee_type || '',
      list_price: p.list_price, is_taxable: p.is_taxable, status: p.status,
      sort_order: p.sort_order,
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
        category_id: form.category_id ? parseInt(form.category_id) : null,
        billing_frequency: form.product_type === 'recurring' ? form.billing_frequency || null : null,
      };
      if (editing === 'new') {
        await apiFetch('/products', { method: 'POST', body: JSON.stringify(payload) });
        flash('success', `"${form.name}" created`);
      } else {
        await apiFetch(`/products/${editing}`, { method: 'PUT', body: JSON.stringify(payload) });
        flash('success', `"${form.name}" updated`);
      }
      cancelEdit();
      load();
    } catch (e) { flash('error', e.message); }
    finally { setSaving(false); }
  };

  const deleteProduct = async (p) => {
    if (!window.confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/products/${p.id}`, { method: 'DELETE' });
      flash('success', `"${p.name}" deleted`);
      load();
    } catch (e) { flash('error', e.message); }
  };

  // ── Category CRUD ──────────────────────────────────────────────────────

  const saveCat = async () => {
    if (!catForm.name.trim()) return;
    setSavingCat(true);
    try {
      if (editingCat) {
        await apiFetch(`/products/categories/${editingCat}`, { method: 'PUT', body: JSON.stringify(catForm) });
        flash('success', 'Category updated');
      } else {
        await apiFetch('/products/categories', { method: 'POST', body: JSON.stringify(catForm) });
        flash('success', 'Category created');
      }
      setCatForm({ name: '', description: '' }); setEditingCat(null);
      const r = await apiFetch('/products/categories');
      setCategories(r.data?.categories || []);
    } catch (e) { flash('error', e.message); }
    finally { setSavingCat(false); }
  };

  const deleteCat = async (c) => {
    if (!window.confirm(`Delete category "${c.name}"?`)) return;
    try {
      await apiFetch(`/products/categories/${c.id}`, { method: 'DELETE' });
      flash('success', 'Category deleted');
      const r = await apiFetch('/products/categories');
      setCategories(r.data?.categories || []);
    } catch (e) { flash('error', e.message); }
  };

  // ── Filter & group ─────────────────────────────────────────────────────

  const filtered = products.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.sku || '').toLowerCase().includes(search.toLowerCase())
  );

  const grouped = {};
  const uncategorized = [];
  filtered.forEach(p => {
    if (p.category_id) {
      if (!grouped[p.category_id]) grouped[p.category_id] = { category: categories.find(c => c.id === p.category_id) || { id: p.category_id, name: p.category_name || 'Unknown' }, products: [] };
      grouped[p.category_id].products.push(p);
    } else {
      uncategorized.push(p);
    }
  });
  const catGroups = Object.values(grouped).sort((a, b) => (a.category?.name || '').localeCompare(b.category?.name || ''));

  const toggleCat = (catId) => setCollapsedCats(prev => ({ ...prev, [catId]: !prev[catId] }));

  if (loading) return <div className="sv-loading" style={{ padding: 24 }}>Loading product catalog…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📦 Product Catalog</h2>
          <p className="sv-panel-desc">
            Manage products and services grouped by category. Products added here become available as line items on any deal.
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
            <button className="sv-btn-sm" onClick={() => setShowCatMgr(!showCatMgr)}>
              🏷️ Categories
            </button>
            <button className="sv-btn-primary" onClick={startNew}>+ Add Product</button>
          </div>
        </div>

        {/* ── Category manager ── */}
        {showCatMgr && (
          <div className="sv-card" style={{ background: '#f8fafc', marginBottom: 16 }}>
            <h3>🏷️ Product Categories</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <input className="oa-input" style={{ maxWidth: 200 }} placeholder="Category name" value={catForm.name}
                onChange={e => setCatForm({ ...catForm, name: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') saveCat(); }} />
              <input className="oa-input" style={{ maxWidth: 260 }} placeholder="Description (optional)" value={catForm.description}
                onChange={e => setCatForm({ ...catForm, description: e.target.value })} />
              <button className="sv-btn-primary" onClick={saveCat} disabled={savingCat}>
                {savingCat ? '…' : editingCat ? 'Update' : 'Add'}
              </button>
              {editingCat && <button className="sv-btn-sm" onClick={() => { setEditingCat(null); setCatForm({ name: '', description: '' }); }}>Cancel</button>}
            </div>
            {categories.length === 0 ? (
              <p className="sv-empty">No categories yet.</p>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {categories.map((c, i) => (
                  <span key={c.id} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 14px',
                    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 20, fontSize: 13,
                  }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_COLORS[i % CAT_COLORS.length], flexShrink: 0 }} />
                    <span style={{ fontWeight: 500, color: '#374151' }}>{c.name}</span>
                    {c.description && <span style={{ color: '#9ca3af', fontSize: 11 }}>{c.description}</span>}
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#6b7280', padding: 0 }}
                      onClick={() => { setEditingCat(c.id); setCatForm({ name: c.name, description: c.description || '' }); }}>✏️</button>
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#dc2626', padding: 0 }}
                      onClick={() => deleteCat(c)}>×</button>
                  </span>
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

            <div className="oa-stage-add-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div>
                <label className="oa-stage-label">Name *</label>
                <input className="oa-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <label className="oa-stage-label">SKU / Product Code</label>
                <input className="oa-input" value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} />
              </div>
              <div>
                <label className="oa-stage-label">Category</label>
                <select className="oa-select" value={form.category_id} onChange={e => setForm({ ...form, category_id: e.target.value })}>
                  <option value="">— uncategorised —</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>

            <div className="oa-stage-add-row" style={{ marginTop: 12 }}>
              <label className="oa-stage-label">Description</label>
              <textarea className="oa-input" style={{ minHeight: 50 }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </div>

            <div className="oa-stage-add-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
              <div>
                <label className="oa-stage-label">Type</label>
                <select className="oa-select" value={form.product_type} onChange={e => setForm({ ...form, product_type: e.target.value })}>
                  {PRODUCT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {form.product_type === 'recurring' && (
                <div>
                  <label className="oa-stage-label">Billing Frequency</label>
                  <select className="oa-select" value={form.billing_frequency} onChange={e => setForm({ ...form, billing_frequency: e.target.value })}>
                    {BILLING_FREQS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="oa-stage-label">Fee Type</label>
                <select className="oa-select" value={form.fee_type} onChange={e => setForm({ ...form, fee_type: e.target.value })}>
                  {FEE_TYPES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div>
                <label className="oa-stage-label">List Price</label>
                <input className="oa-input" type="number" step="0.01" value={form.list_price} onChange={e => setForm({ ...form, list_price: e.target.value })} />
              </div>
              <div>
                <label className="oa-stage-label">Status</label>
                <select className="oa-select" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                  {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>

            <div className="oa-stage-add-row oa-stage-add-row--checkbox" style={{ marginTop: 12 }}>
              <label><input type="checkbox" checked={form.is_taxable} onChange={e => setForm({ ...form, is_taxable: e.target.checked })} /> Taxable</label>
            </div>

            <div className="oa-stage-add-row oa-stage-add-row--actions" style={{ marginTop: 16 }}>
              <button className="sv-btn-primary" onClick={saveProduct} disabled={saving || !form.name.trim()}>
                {saving ? '…' : 'Save Product'}
              </button>
              <button className="sv-btn-sm" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        )}

        {/* ── Grouped product table ── */}
        {filtered.length === 0 && !editing ? (
          <div className="sv-empty" style={{ padding: 32, textAlign: 'center' }}>
            <p style={{ fontSize: 15, marginBottom: 8 }}>No products found.</p>
            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
              Add products to your catalog so they can be attached to deals as line items.
            </p>
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
                {catGroups.map((group, gi) => {
                  const cat = group.category;
                  const isCollapsed = collapsedCats[cat.id];
                  const catColor = CAT_COLORS[gi % CAT_COLORS.length];
                  return (
                    <React.Fragment key={`cat-${cat.id}`}>
                      <tr onClick={() => toggleCat(cat.id)} style={{ cursor: 'pointer', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                        <td colSpan={7} style={{ padding: '10px 8px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ color: '#9ca3af', fontSize: 11, width: 16, textAlign: 'center', transition: 'transform 0.15s', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0)' }}>▼</span>
                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
                            <span style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{cat.name}</span>
                            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>
                              {group.products.length} product{group.products.length !== 1 ? 's' : ''}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {!isCollapsed && group.products.map(p => (
                        <ProductRow key={p.id} product={p} onEdit={() => startEdit(p)} onDelete={() => deleteProduct(p)} />
                      ))}
                    </React.Fragment>
                  );
                })}

                {uncategorized.length > 0 && (
                  <React.Fragment>
                    <tr onClick={() => toggleCat('uncat')} style={{ cursor: 'pointer', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                      <td colSpan={7} style={{ padding: '10px 8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ color: '#9ca3af', fontSize: 11, width: 16, textAlign: 'center', transition: 'transform 0.15s', transform: collapsedCats['uncat'] ? 'rotate(-90deg)' : 'rotate(0)' }}>▼</span>
                          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#94a3b8', flexShrink: 0 }} />
                          <span style={{ fontWeight: 700, fontSize: 14, color: '#64748b' }}>Uncategorised</span>
                          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>
                            {uncategorized.length} product{uncategorized.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedCats['uncat'] && uncategorized.map(p => (
                      <ProductRow key={p.id} product={p} onEdit={() => startEdit(p)} onDelete={() => deleteProduct(p)} />
                    ))}
                  </React.Fragment>
                )}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 13, color: '#9ca3af' }}>
            {catGroups.length + (uncategorized.length > 0 ? 1 : 0)} categories · {filtered.length} products
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Product Row
// ═══════════════════════════════════════════════════════════════════════════

function ProductRow({ product: p, onEdit, onDelete }) {
  const statusMeta = STATUS_OPTS.find(o => o.value === p.status) || STATUS_OPTS[0];
  return (
    <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
      <td style={{ padding: '10px 8px 10px 32px' }}>
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
        <span className={`oa-role-row__tag ${p.status === 'active' ? '' : 'oa-role-row__tag--terminal'}`}
          style={{ background: statusMeta.color, color: '#fff', borderRadius: 12, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}>
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

const STATUS_OPTS_REF = STATUS_OPTS; // keep lint happy
