/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OACallSettings. */
import React, { useState, useEffect } from 'react';

export default function OACallSettings() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [outcomes,     setOutcomes]   = useState([]);
  const [editWindow,   setEditWindow] = useState(24);
  const [loading,      setLoading]    = useState(true);
  const [saving,       setSaving]     = useState(false);
  const [flash,        setFlash]      = useState(null);
  const [dirty,        setDirty]      = useState(false);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    fetch(`${API}/org/call-settings`, { headers })
      .then(r => r.json())
      .then(res => {
        const s = res.settings || {};
        setOutcomes(s.outcomes || []);
        setEditWindow(typeof s.edit_window_hours === 'number' ? s.edit_window_hours : 24);
      })
      .catch(() => showFlash('error', 'Failed to load call settings'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const GROUP_LABELS = {
    connected:  'Connected',
    no_contact: 'No contact',
    blocker:    'Blocker',
  };

  // Mutators — each marks the form dirty so the Save button activates.
  const updateOutcome = (index, field, value) => {
    setOutcomes(prev => prev.map((o, i) => i === index ? { ...o, [field]: value } : o));
    setDirty(true);
  };

  const moveOutcome = (index, dir) => {
    setOutcomes(prev => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      // Renumber so display order matches the new array order.
      return next.map((o, i) => ({ ...o, order: i + 1 }));
    });
    setDirty(true);
  };

  const removeOutcome = (index) => {
    setOutcomes(prev => prev.filter((_, i) => i !== index).map((o, i) => ({ ...o, order: i + 1 })));
    setDirty(true);
  };

  const addOutcome = () => {
    const baseKey = `custom_${Date.now()}`;
    setOutcomes(prev => [
      ...prev,
      {
        key:   baseKey,
        label: 'New outcome',
        group: 'connected',
        order: prev.length + 1,
      },
    ]);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/org/call-settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          outcomes,
          edit_window_hours: Number(editWindow),
        }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error?.message || 'Save failed');
      setOutcomes(res.settings.outcomes || outcomes);
      setEditWindow(res.settings.edit_window_hours);
      setDirty(false);
      showFlash('success', 'Call settings saved ✓');
    } catch (err) {
      showFlash('error', err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 20, color: '#6b7280' }}>Loading…</div>;

  return (
    <div style={{ marginTop: 8 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>📞 Call Settings</h3>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Customize the outcomes that appear in the "Log call" form, and how long reps can edit their own call logs.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          style={{
            padding: '7px 18px',
            background: dirty && !saving ? '#0F9D8E' : '#e5e7eb',
            color: dirty && !saving ? '#fff' : '#9ca3af',
            border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600,
            cursor: dirty && !saving ? 'pointer' : 'not-allowed', flexShrink: 0,
          }}
        >
          {saving ? '⏳ Saving…' : '💾 Save'}
        </button>
      </div>

      {flash && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: flash.type === 'success' ? '#d1fae5' : '#fef2f2',
          color:      flash.type === 'success' ? '#065f46' : '#991b1b',
          border:     `1px solid ${flash.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
        }}>
          {flash.msg}
        </div>
      )}

      {/* Edit window */}
      <div style={{ marginBottom: 24, padding: 16, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
          Edit window (hours)
        </label>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          How long after logging a call can the rep edit their own entry. Set to 0 to disable edits entirely. Maximum 720 (one month).
        </div>
        <input
          type="number"
          min="0" max="720" step="1"
          value={editWindow}
          onChange={e => { setEditWindow(e.target.value); setDirty(true); }}
          style={{
            width: 140, padding: '6px 10px', fontSize: 13,
            border: '1px solid #d1d5db', borderRadius: 6,
          }}
        />
      </div>

      {/* Outcomes list */}
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h4 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: '#111827' }}>Outcomes</h4>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            The full list of outcomes available in the "Log call" form. Order here drives display order in the dropdown.
          </div>
        </div>
        <button
          onClick={addOutcome}
          style={{
            padding: '5px 12px', background: '#fff', color: '#0F9D8E',
            border: '1px solid #0F9D8E', borderRadius: 6, fontSize: 12, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          + Add outcome
        </button>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        {/* Header row */}
        <div style={{
          display: 'grid', gridTemplateColumns: '40px 1fr 2fr 1fr 90px',
          gap: 12, padding: '10px 14px', fontSize: 11, fontWeight: 600,
          color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4,
          background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
        }}>
          <div>Order</div>
          <div>Key</div>
          <div>Label</div>
          <div>Group</div>
          <div></div>
        </div>

        {outcomes.length === 0 && (
          <div style={{ padding: '20px 14px', color: '#9ca3af', fontStyle: 'italic', textAlign: 'center', fontSize: 13 }}>
            No outcomes configured. Add one to get started.
          </div>
        )}

        {outcomes.map((o, i) => (
          <div key={`${o.key}-${i}`} style={{
            display: 'grid', gridTemplateColumns: '40px 1fr 2fr 1fr 90px',
            gap: 12, padding: '10px 14px', alignItems: 'center', fontSize: 13,
            borderBottom: i < outcomes.length - 1 ? '1px solid #f3f4f6' : 'none',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button
                onClick={() => moveOutcome(i, -1)}
                disabled={i === 0}
                style={{ background: 'none', border: 'none', cursor: i === 0 ? 'not-allowed' : 'pointer', color: i === 0 ? '#d1d5db' : '#6b7280', fontSize: 10, padding: 0 }}
                title="Move up"
              >▲</button>
              <button
                onClick={() => moveOutcome(i, 1)}
                disabled={i === outcomes.length - 1}
                style={{ background: 'none', border: 'none', cursor: i === outcomes.length - 1 ? 'not-allowed' : 'pointer', color: i === outcomes.length - 1 ? '#d1d5db' : '#6b7280', fontSize: 10, padding: 0 }}
                title="Move down"
              >▼</button>
            </div>
            <input
              value={o.key}
              onChange={e => updateOutcome(i, 'key', e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              title="Stable identifier stored on call rows. Lowercase letters, digits, underscores only."
            />
            <input
              value={o.label}
              onChange={e => updateOutcome(i, 'label', e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 12 }}
            />
            <select
              value={o.group}
              onChange={e => updateOutcome(i, 'group', e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 12, background: '#fff' }}
            >
              {Object.entries(GROUP_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <button
              onClick={() => removeOutcome(i)}
              style={{
                padding: '4px 8px', background: '#fff', color: '#991b1b',
                border: '1px solid #fecaca', borderRadius: 4, fontSize: 11, fontWeight: 500,
                cursor: 'pointer',
              }}
              title="Remove outcome (only allowed if no calls reference it)"
            >Remove</button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }}>
        Note: outcome keys are stable identifiers. You can rename labels freely, but you cannot remove an outcome key that's still referenced by past call logs.
      </div>
    </div>
  );
}
