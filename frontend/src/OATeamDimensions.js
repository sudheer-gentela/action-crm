import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './OATeamDimensions.css';

// ─────────────────────────────────────────────────────────────────────────────
// OATeamDimensions
//
// OrgAdmin panel for managing the team dimension vocabulary.
// Two columns: Internal/Both dimensions | Customer dimensions.
// System dimensions can be renamed and toggled but not deleted.
// Custom dimensions can be fully managed.
// ─────────────────────────────────────────────────────────────────────────────

const APPLIES_TO_OPTIONS = [
  { value: 'internal', label: 'Internal only' },
  { value: 'customer', label: 'Customer only' },
  { value: 'both',     label: 'Both' },
];

export default function OATeamDimensions() {
  const [dimensions, setDimensions]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [editingId, setEditingId]     = useState(null);
  const [editName, setEditName]       = useState('');
  const [editAppliesTo, setEditAppliesTo] = useState('both');
  const [saving, setSaving]           = useState(false);
  const [showAdd, setShowAdd]         = useState(false);
  const [newKey, setNewKey]           = useState('');
  const [newName, setNewName]         = useState('');
  const [newAppliesTo, setNewAppliesTo] = useState('both');
  const [addError, setAddError]       = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiService.teamDimensions.list({ activeOnly: false });
      setDimensions(res.data.dimensions || []);
    } catch (err) {
      setError('Failed to load team dimensions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (d) => {
    setEditingId(d.id);
    setEditName(d.name);
    setEditAppliesTo(d.appliesTo);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditAppliesTo('both');
  };

  const saveEdit = async (id) => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      await apiService.teamDimensions.update(id, { name: editName.trim(), appliesTo: editAppliesTo });
      await load();
      cancelEdit();
    } catch {
      setError('Failed to update dimension');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (d) => {
    try {
      await apiService.teamDimensions.toggle(d.id, !d.isActive);
      await load();
    } catch {
      setError('Failed to toggle dimension');
    }
  };

  const remove = async (d) => {
    if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    try {
      await apiService.teamDimensions.remove(d.id);
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete dimension');
    }
  };

  const addDimension = async () => {
    setAddError('');
    if (!newKey.trim()) return setAddError('Key is required');
    if (!newName.trim()) return setAddError('Name is required');
    setSaving(true);
    try {
      await apiService.teamDimensions.create({ key: newKey.trim(), name: newName.trim(), appliesTo: newAppliesTo });
      setShowAdd(false);
      setNewKey('');
      setNewName('');
      setNewAppliesTo('both');
      await load();
    } catch (err) {
      setAddError(err.response?.data?.error?.message || 'Failed to create dimension');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="oa-loading">Loading team dimensions…</div>;

  const internal = dimensions.filter(d => d.appliesTo === 'internal' || d.appliesTo === 'both');
  const customer = dimensions.filter(d => d.appliesTo === 'customer' || d.appliesTo === 'both');

  return (
    <div className="oa-team-dims">
      {error && (
        <div className="oa-error-banner">
          {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div className="oa-team-dims__header">
        <div>
          <h3 className="oa-section-title">Team Dimensions</h3>
          <p className="oa-section-subtitle">
            Dimensions are labels that categorise both internal teams and customer-side account teams.
            System dimensions (🔒) can be renamed but not deleted.
          </p>
        </div>
        <button className="oa-btn oa-btn--primary" onClick={() => { setShowAdd(true); setAddError(''); }}>
          + Add Dimension
        </button>
      </div>

      {showAdd && (
        <div className="oa-add-dim-form">
          <h4>New Dimension</h4>
          <div className="oa-add-dim-form__row">
            <div className="oa-field">
              <label>Key <span className="oa-hint">(lowercase, underscores, immutable)</span></label>
              <input
                className="oa-input"
                value={newKey}
                onChange={e => setNewKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                placeholder="e.g. product_area"
              />
            </div>
            <div className="oa-field">
              <label>Display Name</label>
              <input
                className="oa-input"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Product Area"
              />
            </div>
            <div className="oa-field">
              <label>Applies To</label>
              <select className="oa-input" value={newAppliesTo} onChange={e => setNewAppliesTo(e.target.value)}>
                {APPLIES_TO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          {addError && <div className="oa-field-error">{addError}</div>}
          <div className="oa-add-dim-form__actions">
            <button className="oa-btn oa-btn--ghost" onClick={() => { setShowAdd(false); setAddError(''); }}>Cancel</button>
            <button className="oa-btn oa-btn--primary" onClick={addDimension} disabled={saving}>
              {saving ? 'Saving…' : 'Add Dimension'}
            </button>
          </div>
        </div>
      )}

      <div className="oa-team-dims__columns">
        <DimColumn
          title="Internal Teams"
          subtitle="Used in your org's internal team structure"
          icon="🏢"
          items={internal}
          editingId={editingId}
          editName={editName}
          editAppliesTo={editAppliesTo}
          saving={saving}
          onStartEdit={startEdit}
          onCancelEdit={cancelEdit}
          onSaveEdit={saveEdit}
          onToggle={toggle}
          onRemove={remove}
          setEditName={setEditName}
          setEditAppliesTo={setEditAppliesTo}
        />
        <DimColumn
          title="Customer Teams"
          subtitle="Used when mapping customer-side account teams"
          icon="👥"
          items={customer}
          editingId={editingId}
          editName={editName}
          editAppliesTo={editAppliesTo}
          saving={saving}
          onStartEdit={startEdit}
          onCancelEdit={cancelEdit}
          onSaveEdit={saveEdit}
          onToggle={toggle}
          onRemove={remove}
          setEditName={setEditName}
          setEditAppliesTo={setEditAppliesTo}
        />
      </div>
    </div>
  );
}

// ── Column sub-component ──────────────────────────────────────────────────────

function DimColumn({ title, subtitle, icon, items, editingId, editName, editAppliesTo, saving,
  onStartEdit, onCancelEdit, onSaveEdit, onToggle, onRemove, setEditName, setEditAppliesTo }) {

  return (
    <div className="oa-dim-col">
      <div className="oa-dim-col__header">
        <span className="oa-dim-col__icon">{icon}</span>
        <div>
          <div className="oa-dim-col__title">{title}</div>
          <div className="oa-dim-col__subtitle">{subtitle}</div>
        </div>
      </div>

      <div className="oa-dim-list">
        {items.length === 0 && (
          <div className="oa-dim-empty">No dimensions for this scope yet.</div>
        )}
        {items.map(d => (
          <div key={d.id} className={`oa-dim-item ${!d.isActive ? 'oa-dim-item--inactive' : ''}`}>
            {editingId === d.id ? (
              <div className="oa-dim-item__edit">
                <input
                  className="oa-input oa-input--sm"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  autoFocus
                />
                <select
                  className="oa-input oa-input--sm"
                  value={editAppliesTo}
                  onChange={e => setEditAppliesTo(e.target.value)}
                >
                  {APPLIES_TO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <div className="oa-dim-item__edit-actions">
                  <button className="oa-btn oa-btn--ghost oa-btn--xs" onClick={onCancelEdit}>Cancel</button>
                  <button
                    className="oa-btn oa-btn--primary oa-btn--xs"
                    onClick={() => onSaveEdit(d.id)}
                    disabled={saving}
                  >
                    {saving ? '…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="oa-dim-item__view">
                <div className="oa-dim-item__info">
                  <span className="oa-dim-item__name">
                    {d.isSystem && <span className="oa-dim-item__lock" title="System dimension">🔒</span>}
                    {d.name}
                  </span>
                  <span className="oa-dim-item__key">{d.key}</span>
                  <span className={`oa-dim-item__scope oa-dim-item__scope--${d.appliesTo}`}>
                    {d.appliesTo}
                  </span>
                  {!d.isActive && <span className="oa-dim-item__inactive-badge">Inactive</span>}
                </div>
                <div className="oa-dim-item__actions">
                  <button
                    className="oa-btn oa-btn--ghost oa-btn--xs"
                    onClick={() => onStartEdit(d)}
                    title="Rename"
                  >
                    ✏️
                  </button>
                  <button
                    className={`oa-btn oa-btn--xs ${d.isActive ? 'oa-btn--ghost' : 'oa-btn--success'}`}
                    onClick={() => onToggle(d)}
                    title={d.isActive ? 'Deactivate' : 'Activate'}
                  >
                    {d.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  {!d.isSystem && (
                    <button
                      className="oa-btn oa-btn--danger oa-btn--xs"
                      onClick={() => onRemove(d)}
                      title="Delete"
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
