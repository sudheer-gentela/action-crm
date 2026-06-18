/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAServiceSLATiers. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';

export default function OAServiceSLATiers() {
  const [tiers, setTiers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [editing, setEditing] = useState(null);   // null | 'new' | tier object
  const [saving, setSaving]   = useState(false);
  const [form, setForm]       = useState({});

  const load = () => {
    setLoading(true);
    apiService.support.getSlaTiers()
      .then(r => { setTiers(r.data?.tiers || []); setError(''); })
      .catch(e => setError(e.response?.data?.error?.message || e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    setForm({ name: '', description: '', responseTargetHours: 4, resolutionTargetHours: 24 });
    setEditing('new');
  };

  const openEdit = (tier) => {
    setForm({
      name:                  tier.name,
      description:           tier.description || '',
      responseTargetHours:   tier.responseTargetHours,
      resolutionTargetHours: tier.resolutionTargetHours,
      isActive:              tier.isActive,
    });
    setEditing(tier);
  };

  const handleSave = async () => {
    if (!form.name?.trim()) { setError('Tier name is required'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      if (editing === 'new') {
        await apiService.support.createSlaTier({
          name:                  form.name.trim(),
          description:           form.description || undefined,
          responseTargetHours:   parseFloat(form.responseTargetHours) || 4,
          resolutionTargetHours: parseFloat(form.resolutionTargetHours) || 24,
        });
        setSuccess('SLA tier created ✓');
      } else {
        await apiService.support.updateSlaTier(editing.id, {
          name:                  form.name.trim(),
          description:           form.description || undefined,
          responseTargetHours:   parseFloat(form.responseTargetHours),
          resolutionTargetHours: parseFloat(form.resolutionTargetHours),
          isActive:              form.isActive,
        });
        setSuccess('SLA tier updated ✓');
      }
      setTimeout(() => setSuccess(''), 3000);
      setEditing(null);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (tier) => {
    try {
      await apiService.support.updateSlaTier(tier.id, { isActive: !tier.isActive });
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to update');
    }
  };

  if (loading) return <div className="sv-loading">Loading SLA tiers…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          Define response and resolution targets for different customer tiers. Accounts are assigned a tier, and cases inherit it.
        </div>
        {!editing && (
          <button onClick={openNew} style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0, marginLeft: 16 }}>
            + New Tier
          </button>
        )}
      </div>

      {/* New / edit form */}
      {editing && (
        <div style={{ background: '#f8fafc', border: '1px solid #c7d2fe', borderRadius: 10, padding: '18px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 14 }}>
            {editing === 'new' ? 'New SLA Tier' : `Edit — ${editing.name}`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Gold, Platinum"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Response Target (hours)</label>
              <input type="number" min="0.5" step="0.5" value={form.responseTargetHours} onChange={e => setForm(f => ({ ...f, responseTargetHours: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Resolution Target (hours)</label>
              <input type="number" min="1" step="1" value={form.resolutionTargetHours} onChange={e => setForm(f => ({ ...f, resolutionTargetHours: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
          </div>
          {editing !== 'new' && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} />
                Active (visible for assignment)
              </label>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving} style={{ padding: '7px 20px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {saving ? 'Saving…' : editing === 'new' ? 'Create Tier' : 'Save Changes'}
            </button>
            <button onClick={() => { setEditing(null); setError(''); }} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tier list */}
      {tiers.length === 0 ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          No SLA tiers yet. The default tiers (Platinum, Gold, Standard) are created automatically when the module is first enabled.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tiers.map(tier => (
            <div key={tier.id} style={{ background: '#fff', border: `1px solid ${tier.isActive ? '#e5e7eb' : '#f3f4f6'}`, borderRadius: 9, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, opacity: tier.isActive ? 1 : 0.6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{tier.name}</span>
                  {!tier.isActive && <span style={{ fontSize: 10, background: '#f3f4f6', color: '#9ca3af', padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>Inactive</span>}
                </div>
                {tier.description && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{tier.description}</div>}
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#6b7280', flexShrink: 0 }}>
                <span>⏱ Response: <strong style={{ color: '#374151' }}>{tier.responseTargetHours}h</strong></span>
                <span>✅ Resolution: <strong style={{ color: '#374151' }}>{tier.resolutionTargetHours}h</strong></span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={() => openEdit(tier)} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151' }}>Edit</button>
                <button onClick={() => handleToggleActive(tier)} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12, cursor: 'pointer', color: tier.isActive ? '#9ca3af' : '#059669' }}>
                  {tier.isActive ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
