/**
 * ProspectPhonesPanel.js
 *
 * Lists a prospect's phone numbers (from /api/prospect-phones), lets the rep
 * pick which one to dial, and manage them (add / label / set-primary / delete).
 * The selected phone id is lifted to the parent via onSelectedPhoneChange so
 * the "Call via Twilio" button can pass it to /prospect-calls/prepare.
 *
 * Props:
 *   prospectId               (int, required)
 *   onSelectedPhoneChange(id) — fires with the chosen phone id (or null)
 *   onPhonesChanged()         — fires after add/edit/delete so the parent can
 *                               refresh the prospect (prospects.phone mirror)
 *
 * Drop-in location: frontend/src/prospecting/ProspectPhonesPanel.js
 */

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';

export default function ProspectPhonesPanel({ prospectId, onSelectedPhoneChange, onPhonesChanged, phoneValidation = 'lenient' }) {
  const [phones, setPhones]       = useState([]);
  const [selectedId, setSelected] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [adding, setAdding]       = useState(false);
  const [newPhone, setNewPhone]   = useState('');
  const [newLabel, setNewLabel]   = useState('');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState(null);

  const load = async () => {
    try {
      const r = await apiFetch(`/prospect-phones?prospect_id=${prospectId}`);
      const list = r.phones || [];
      setPhones(list);
      const primary = list.find(p => p.is_primary) || list[0];
      const sel = primary ? primary.id : null;
      setSelected(sel);
      onSelectedPhoneChange?.(sel);
    } catch (e) {
      setErr(e.message || 'Failed to load numbers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!prospectId) return;
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prospectId]);

  const select = (id) => { setSelected(id); onSelectedPhoneChange?.(id); };

  const addPhone = async () => {
    const phone = newPhone.trim();
    if (!phone || busy) return;
    // Instant feedback in strict mode; the server re-validates authoritatively.
    if (phoneValidation === 'strict' && !/^\+[1-9]\d{7,14}$/.test(phone)) {
      setErr('This org requires E.164 format, e.g. +14155551234.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      await apiFetch('/prospect-phones', {
        method: 'POST',
        body: JSON.stringify({ prospect_id: prospectId, phone, label: newLabel.trim() || null }),
      });
      setNewPhone(''); setNewLabel(''); setAdding(false);
      await load();
      onPhonesChanged?.();
    } catch (e) {
      setErr(e.message || 'Failed to add number');
    } finally {
      setBusy(false);
    }
  };

  const makePrimary = async (id) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await apiFetch(`/prospect-phones/${id}`, { method: 'PATCH', body: JSON.stringify({ is_primary: true }) });
      await load();
      onPhonesChanged?.();
    } catch (e) {
      setErr(e.message || 'Failed to set primary');
    } finally {
      setBusy(false);
    }
  };

  const removePhone = async (id) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await apiFetch(`/prospect-phones/${id}`, { method: 'DELETE' });
      await load();
      onPhonesChanged?.();
    } catch (e) {
      setErr(e.message || 'Failed to delete number');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div style={{ fontSize: 12, color: '#9ca3af', padding: '4px 0' }}>Loading numbers…</div>;
  }

  return (
    <div style={{ margin: '6px 0 10px', fontSize: 13 }}>
      {phones.length === 0 && (
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>
          No phone numbers yet. Add one to enable calling.
        </div>
      )}

      {phones.map((p) => (
        <label
          key={p.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer',
          }}
        >
          <input
            type="radio"
            name={`pphone-${prospectId}`}
            checked={selectedId === p.id}
            onChange={() => select(p.id)}
          />
          <span style={{ fontFamily: 'monospace' }}>{p.phone}</span>
          {p.label && <span style={{ fontSize: 11, color: '#6b7280' }}>· {p.label}</span>}
          {p.is_primary
            ? <span style={{ fontSize: 10, color: '#065f46', background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 4, padding: '0 5px' }}>primary</span>
            : <button type="button" onClick={() => makePrimary(p.id)} disabled={busy}
                style={miniBtn}>Make primary</button>}
          <button type="button" onClick={() => removePhone(p.id)} disabled={busy}
            style={{ ...miniBtn, color: '#b91c1c', borderColor: '#fecaca' }}>Remove</button>
        </label>
      ))}

      {adding ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <input
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            placeholder={phoneValidation === 'strict' ? '+14155551234 (E.164)' : '+1 415 555 1234'}
            style={inputStyle}
          />
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="label (mobile, office…)"
            style={{ ...inputStyle, width: 150 }}
          />
          <button type="button" onClick={addPhone} disabled={busy || !newPhone.trim()} style={{ ...miniBtn, background: '#ecfdf5', borderColor: '#6ee7b7', color: '#065f46' }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => { setAdding(false); setNewPhone(''); setNewLabel(''); }} style={miniBtn}>Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} style={{ ...miniBtn, marginTop: 6 }}>
          + Add number
        </button>
      )}

      {err && <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

const miniBtn = {
  fontSize: 11, padding: '2px 8px', background: '#f3f4f6', border: '1px solid #e5e7eb',
  borderRadius: 4, cursor: 'pointer', color: '#374151',
};
const inputStyle = {
  fontSize: 13, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 160,
};
