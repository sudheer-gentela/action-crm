// ─────────────────────────────────────────────────────────────────────────────
// DealProductsPanel.js — Deal line items (products/services)
//
// Pattern: matches DealTeamPanel.js / DealPlaysPanel.js — apiFetch helper,
// CSS classes with dpp-* prefix, deal prop, loading/error states.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import './DealProductsPanel.css';

const API = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
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

const CAT_COLORS = ['#4338ca', '#0d9488', '#c2410c', '#7c3aed', '#0369a1', '#b91c1c'];

const EMPTY_ITEM = {
  product_id: '', product_name: '', quantity: 1, unit_price: '',
  discount_pct: 0, contract_term: '', effective_date: '', renewal_date: '',
  revenue_type: 'one_time', notes: '',
};

export default function DealProductsPanel({ deal }) {
  const [items, setItems]         = useState([]);
  const [totals, setTotals]       = useState({ total: 0, one_time: 0, recurring: 0 });
  const [catalog, setCatalog]     = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [editing, setEditing]     = useState(null);
  const [form, setForm]           = useState({ ...EMPTY_ITEM });
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  const loadItems = useCallback(async () => {
    if (!deal?.id) return;
    try {
      setLoading(true);
      const [itemsRes, catRes, catsRes] = await Promise.all([
        apiFetch(`/products/deals/${deal.id}/items`),
        apiFetch('/products?status=active'),
        apiFetch('/products/categories'),
      ]);
      setItems(itemsRes.data?.items || []);
      setTotals(itemsRes.data?.totals || { total: 0, one_time: 0, recurring: 0 });
      setCatalog(catRes.data?.products || []);
      setCategories(catsRes.data?.categories || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [deal?.id]);

  useEffect(() => { loadItems(); }, [loadItems]);

  // When user picks a catalog product, pre-fill fields
  const handleProductSelect = (productId) => {
    const pid = parseInt(productId);
    if (!pid) { setForm({ ...form, product_id: '', product_name: '', unit_price: '', revenue_type: 'one_time' }); return; }
    const p = catalog.find(c => c.id === pid);
    if (p) {
      setForm({
        ...form, product_id: p.id, product_name: p.name,
        unit_price: p.list_price, revenue_type: p.product_type || 'one_time',
      });
    }
  };

  const startAdd = () => { setForm({ ...EMPTY_ITEM }); setEditing('new'); };
  const startEdit = (item) => {
    setForm({
      product_id: item.product_id || '', product_name: item.product_name,
      quantity: item.quantity, unit_price: item.unit_price,
      discount_pct: item.discount_pct,
      contract_term: item.contract_term || '', effective_date: item.effective_date ? item.effective_date.slice(0, 10) : '',
      renewal_date: item.renewal_date ? item.renewal_date.slice(0, 10) : '',
      revenue_type: item.revenue_type, notes: item.notes || '',
    });
    setEditing(item.id);
  };
  const cancelEdit = () => { setEditing(null); setForm({ ...EMPTY_ITEM }); };

  const saveItem = async () => {
    if (!form.product_name.trim() && !form.product_id) { setError('Select a product or enter a name'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        quantity: parseFloat(form.quantity) || 1,
        unit_price: parseFloat(form.unit_price) || 0,
        discount_pct: parseFloat(form.discount_pct) || 0,
        contract_term: form.contract_term ? parseInt(form.contract_term) : null,
        product_id: form.product_id ? parseInt(form.product_id) : null,
      };
      if (editing === 'new') {
        await apiFetch(`/products/deals/${deal.id}/items`, { method: 'POST', body: JSON.stringify(payload) });
      } else {
        await apiFetch(`/products/deals/${deal.id}/items/${editing}`, { method: 'PUT', body: JSON.stringify(payload) });
      }
      cancelEdit();
      loadItems();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const deleteItem = async (item) => {
    if (!window.confirm(`Remove "${item.product_name}" from this deal?`)) return;
    try {
      await apiFetch(`/products/deals/${deal.id}/items/${item.id}`, { method: 'DELETE' });
      loadItems();
    } catch (e) { setError(e.message); }
  };

  const syncDealValue = async () => {
    try {
      const r = await apiFetch(`/products/deals/${deal.id}/items/sync-value`, { method: 'POST' });
      setError('');
      alert(`Deal value updated to $${parseFloat(r.data.deal_value).toLocaleString()}`);
    } catch (e) { setError(e.message); }
  };

  const previewTotal = () => {
    const q = parseFloat(form.quantity) || 0;
    const p = parseFloat(form.unit_price) || 0;
    const d = parseFloat(form.discount_pct) || 0;
    return (q * p * (1 - d / 100)).toFixed(2);
  };

  // Group items by category
  const grouped = {};
  const uncategorized = [];
  items.forEach(item => {
    if (item.category_name) {
      if (!grouped[item.category_name]) grouped[item.category_name] = [];
      grouped[item.category_name].push(item);
    } else {
      uncategorized.push(item);
    }
  });

  if (!deal?.id) return null;

  if (loading) {
    return <div className="dprod-loading"><span className="dprod-spinner" /> Loading line items…</div>;
  }

  return (
    <div className="dprod-root">

      {/* Header */}
      <div className="dprod-header">
        <span className="dprod-count">
          {items.length === 0
            ? 'No line items yet'
            : `${items.length} item${items.length !== 1 ? 's' : ''}`}
        </span>
        <div className="dprod-header__right">
          {totals.total > 0 && (
            <span className="dprod-total">${parseFloat(totals.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          )}
          <button className="dprod-btn dprod-btn--add" onClick={() => { editing ? cancelEdit() : startAdd(); }}>
            {editing ? 'Cancel' : '+ Add Product'}
          </button>
        </div>
      </div>

      {error && <div className="dprod-error">⚠️ {error} <button className="dprod-error-dismiss" onClick={() => setError('')}>✕</button></div>}

      {/* Totals bar */}
      {items.length > 0 && (
        <div className="dprod-totals">
          <span className="dprod-totals__item"><span className="dprod-totals__label">Total:</span> <span className="dprod-totals__val">${parseFloat(totals.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></span>
          <span className="dprod-totals__item"><span className="dprod-totals__label">One-time:</span> ${parseFloat(totals.one_time).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          <span className="dprod-totals__item"><span className="dprod-totals__label">Recurring:</span> <span className="dprod-totals__recurring">${parseFloat(totals.recurring).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></span>
          <button className="dprod-btn dprod-btn--tiny" onClick={syncDealValue} title="Update deal value from line items">↻ Sync deal value</button>
        </div>
      )}

      {/* Add / edit form */}
      {editing && (
        <div className="dprod-add-form">
          <div className="dprod-add-form__title">{editing === 'new' ? '+ Add Line Item' : 'Edit Line Item'}</div>

          <div className="dprod-form-row dprod-form-row--2">
            <div>
              <label className="dprod-label">From Catalog</label>
              <select className="dprod-select" value={form.product_id} onChange={e => handleProductSelect(e.target.value)}>
                <option value="">— custom / manual —</option>
                {categories.map((cat, ci) => {
                  const catProducts = catalog.filter(p => p.category_id === cat.id);
                  if (!catProducts.length) return null;
                  return (
                    <optgroup key={cat.id} label={cat.name}>
                      {catProducts.map(p => <option key={p.id} value={p.id}>{p.name} (${parseFloat(p.list_price).toLocaleString()})</option>)}
                    </optgroup>
                  );
                })}
                {(() => { const uncatProds = catalog.filter(p => !p.category_id); return uncatProds.length > 0 ? (
                  <optgroup label="Uncategorised">{uncatProds.map(p => <option key={p.id} value={p.id}>{p.name} (${parseFloat(p.list_price).toLocaleString()})</option>)}</optgroup>
                ) : null; })()}
              </select>
            </div>
            <div>
              <label className="dprod-label">Product Name *</label>
              <input className="dprod-input" value={form.product_name} onChange={e => setForm({ ...form, product_name: e.target.value })} placeholder="Or type a custom name" />
            </div>
          </div>

          <div className="dprod-form-row dprod-form-row--4">
            <div><label className="dprod-label">Quantity</label><input className="dprod-input" type="number" step="0.01" min="0" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} /></div>
            <div><label className="dprod-label">Unit Price</label><input className="dprod-input" type="number" step="0.01" min="0" value={form.unit_price} onChange={e => setForm({ ...form, unit_price: e.target.value })} /></div>
            <div><label className="dprod-label">Discount %</label><input className="dprod-input" type="number" step="0.5" min="0" max="100" value={form.discount_pct} onChange={e => setForm({ ...form, discount_pct: e.target.value })} /></div>
            <div><label className="dprod-label">Line Total</label><div className="dprod-preview-total">${parseFloat(previewTotal()).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
          </div>

          <div className="dprod-form-row dprod-form-row--3">
            <div>
              <label className="dprod-label">Revenue Type</label>
              <select className="dprod-select" value={form.revenue_type} onChange={e => setForm({ ...form, revenue_type: e.target.value })}>
                <option value="one_time">One-time</option>
                <option value="recurring">Recurring</option>
              </select>
            </div>
            <div><label className="dprod-label">Contract Term (months)</label><input className="dprod-input" type="number" min="0" value={form.contract_term} onChange={e => setForm({ ...form, contract_term: e.target.value })} /></div>
            <div><label className="dprod-label">Effective Date</label><input className="dprod-input dprod-input--date" type="date" value={form.effective_date} onChange={e => setForm({ ...form, effective_date: e.target.value })} /></div>
          </div>

          <div className="dprod-form-row dprod-form-row--2">
            <div><label className="dprod-label">Renewal Date</label><input className="dprod-input dprod-input--date" type="date" value={form.renewal_date} onChange={e => setForm({ ...form, renewal_date: e.target.value })} /></div>
            <div><label className="dprod-label">Notes</label><input className="dprod-input" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Optional notes" /></div>
          </div>

          <div className="dprod-add-form__actions">
            <button className="dprod-btn dprod-btn--save" onClick={saveItem} disabled={saving}>{saving ? '…' : 'Save'}</button>
            <button className="dprod-btn dprod-btn--cancel" onClick={cancelEdit}>Cancel</button>
          </div>
        </div>
      )}

      {/* Line items — grouped by category */}
      {items.length === 0 && !editing && (
        <p className="dprod-empty">Add products to track deal value and contract details.</p>
      )}

      {Object.entries(grouped).map(([catName, catItems], gi) => {
        const catColor = CAT_COLORS[gi % CAT_COLORS.length];
        const catTotal = catItems.reduce((sum, i) => sum + parseFloat(i.total_value || 0), 0);
        return (
          <div key={catName} className="dprod-category-group">
            <div className="dprod-category-header">
              <span className="dprod-category-dot" style={{ background: catColor }} />
              <span className="dprod-category-name">{catName}</span>
              <span className="dprod-category-count">({catItems.length})</span>
              <span className="dprod-category-total">${catTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
            {catItems.map(item => (
              <LineItemCard key={item.id} item={item} catColor={catColor} onEdit={() => startEdit(item)} onDelete={() => deleteItem(item)} />
            ))}
          </div>
        );
      })}

      {uncategorized.length > 0 && (
        <div className="dprod-category-group">
          {Object.keys(grouped).length > 0 && (
            <div className="dprod-category-header">
              <span className="dprod-category-dot" style={{ background: '#94a3b8' }} />
              <span className="dprod-category-name" style={{ color: '#64748b' }}>Uncategorised</span>
              <span className="dprod-category-count">({uncategorized.length})</span>
            </div>
          )}
          {uncategorized.map(item => (
            <LineItemCard key={item.id} item={item} catColor="#94a3b8" onEdit={() => startEdit(item)} onDelete={() => deleteItem(item)} />
          ))}
        </div>
      )}
    </div>
  );
}

function LineItemCard({ item, catColor, onEdit, onDelete }) {
  return (
    <div className="dprod-item" style={{ borderLeftColor: catColor }}>
      <div className="dprod-item__content">
        <div className="dprod-item__name">{item.product_name}</div>
        <div className="dprod-item__pricing">
          <span>Qty: {item.quantity}</span>
          <span>@ ${parseFloat(item.unit_price).toLocaleString()}</span>
          {parseFloat(item.discount_pct) > 0 && <span className="dprod-item__discount">-{item.discount_pct}%</span>}
          <span className="dprod-item__line-total">= ${parseFloat(item.total_value).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>
        <div className="dprod-item__meta">
          <span className={item.revenue_type === 'recurring' ? 'dprod-item__recurring' : ''}>{item.revenue_type === 'recurring' ? '↻ Recurring' : 'One-time'}</span>
          {item.contract_term && <span>{item.contract_term}mo term</span>}
          {item.effective_date && <span>Eff: {new Date(item.effective_date).toLocaleDateString()}</span>}
          {item.renewal_date && <span>Renew: {new Date(item.renewal_date).toLocaleDateString()}</span>}
        </div>
        {item.notes && <div className="dprod-item__notes">{item.notes}</div>}
      </div>
      <div className="dprod-item__actions">
        <button className="dprod-btn dprod-btn--tiny" onClick={onEdit}>Edit</button>
        <button className="dprod-btn dprod-btn--remove" onClick={onDelete} title="Remove">✕</button>
      </div>
    </div>
  );
}
