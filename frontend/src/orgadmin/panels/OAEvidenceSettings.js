/* OAEvidenceSettings.js — 2026_118
 *
 * Org-wide default for whether closing a project task requires an evidence
 * reference. Stored in organizations.settings.evidence; a project can override
 * it via sales_handovers.evidence_config, so this panel reports how many
 * projects have done so rather than implying the setting is universal.
 *
 * The evidence REFERENCE is what satisfies the requirement, not the completion
 * note — a note is free text anyone can fill with anything, whereas the
 * evidence field points at the artefact that closed the task. The copy below
 * says so explicitly, because it is not obvious from the form.
 */
import React, { useState, useEffect, useCallback } from 'react';

export default function OAEvidenceSettings() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [config, setConfig]   = useState(null);
  const [overrides, setOverrides] = useState(0);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState('');
  const [err, setErr]         = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/org/admin/evidence-settings`, { headers });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Could not load settings');
      setConfig(data.config);
      setOverrides(data.overrides || 0);
    } catch (e) {
      setErr(e.message || 'Could not load settings');
    }
  }, []); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    setSaving(true); setErr(''); setMsg('');
    // Optimistic, then reconciled with the server's merged result — the PATCH
    // merges rather than replaces, so the response is authoritative.
    const previous = config;
    setConfig(c => ({ ...c, ...patch }));
    try {
      const r = await fetch(`${API}/org/admin/evidence-settings`, {
        method: 'PATCH', headers, body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Save failed');
      setConfig(data.config);
      setMsg('Saved ✓');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      setConfig(previous);
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (err && !config) {
    return <div style={{ fontSize: 13, color: '#991b1b', padding: 16 }}>{err}</div>;
  }
  if (!config) {
    return <div style={{ fontSize: 13, color: '#6b7280', padding: 16 }}>Loading…</div>;
  }

  const Row = ({ title, desc, value, onToggle, disabled }) => (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 16, padding: '16px 0',
      borderBottom: '1px solid #f1f5f9',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{title}</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3, lineHeight: 1.55 }}>{desc}</div>
      </div>
      <button
        onClick={() => onToggle(!value)}
        disabled={saving || disabled}
        style={{
          flexShrink: 0, minWidth: 96, fontSize: 12, fontWeight: 600,
          padding: '8px 16px', borderRadius: 6, border: 'none',
          background: value ? '#0369a1' : '#fff',
          color: value ? '#fff' : '#374151',
          boxShadow: value ? 'none' : 'inset 0 0 0 1px #d1d5db',
          cursor: (saving || disabled) ? 'default' : 'pointer',
          opacity: (saving || disabled) ? 0.6 : 1,
        }}>
        {value ? 'Required' : 'Optional'}
      </button>
    </div>
  );

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{
        fontSize: 12, color: '#6b7280', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px',
        marginBottom: 4, lineHeight: 1.6,
      }}>
        When evidence is required, the person closing a task must paste a
        reference — the WhatsApp message, email, meeting or document that closed
        it. A note on its own does not count: it is free text, whereas the
        evidence field points at the artefact.
      </div>

      <Row
        title="Require evidence on gate tasks"
        desc="Gate tasks block go-live, so this is on by default. Closing one without a reference is refused."
        value={config.requiredForGates}
        onToggle={v => save({ requiredForGates: v })}
      />

      <Row
        title="Require evidence on every task"
        desc="Applies the same rule to ordinary checklist items, not just gates. Off by default — turning it on adds friction to routine work."
        value={config.required}
        onToggle={v => save({ required: v })}
      />

      {overrides > 0 && (
        <div style={{
          fontSize: 12, color: '#92400e', background: '#fffbeb',
          border: '1px solid #fde68a', borderRadius: 8,
          padding: '10px 14px', marginTop: 16, lineHeight: 1.55,
        }}>
          {overrides} project{overrides === 1 ? ' has' : 's have'} their own evidence setting and
          will ignore these defaults. Clear a project's override to bring it back in line.
        </div>
      )}

      <div style={{ marginTop: 14, minHeight: 18 }}>
        {msg && <span style={{ fontSize: 12, color: '#059669' }}>{msg}</span>}
        {err && <span style={{ fontSize: 12, color: '#991b1b' }}>{err}</span>}
      </div>
    </div>
  );
}
