/* Extracted from OrgAdminView.js — Phase 0 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Small shared UI components for OrgAdmin panels. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../apiService';
import { ROLE_META, HIERARCHY_ROLES } from './constants';

export function UsageBar({ value, max, color = '#0F9D8E' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ background: '#f3f4f6', borderRadius: 4, height: 6, overflow: 'hidden', flex: 1, minWidth: 60 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.4s' }} />
    </div>
  );
}

export function RoleBadge({ role }) {
  const m = ROLE_META[role] || { label: role, color: 'grey', icon: '•' };
  return (
    <span className={`oa-role-badge oa-role-badge--${m.color}`}>
      {m.icon} {m.label}
    </span>
  );
}

export function HierarchyRoleBadge({ role }) {
  const r = HIERARCHY_ROLES.find(h => h.value === role) || { label: role || 'Rep', color: '#64748b' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: '12px',
      fontSize: '11px', fontWeight: 600, color: '#fff',
      background: r.color, letterSpacing: '0.02em',
    }}>
      {r.label}
    </span>
  );
}

export function ToggleSwitch({ on, onChange, color = '#6366f1' }) {
  return (
    <div
      onClick={onChange}
      style={{
        flexShrink: 0, width: 44, height: 24, borderRadius: 12,
        background: on ? color : '#d1d5db',
        position: 'relative', cursor: 'pointer', transition: 'background .2s',
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        position: 'absolute', top: 3,
        left: on ? 23 : 3,
        transition: 'left .2s',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </div>
  );
}

export function ModuleSubTabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', marginBottom: 24 }}>
      {tabs.map(([key, label]) => (
        <button key={key} onClick={() => onChange(key)} style={{
          padding: '9px 20px', fontSize: 13,
          fontWeight: active === key ? 600 : 400,
          color: active === key ? '#6366f1' : '#6b7280',
          background: 'none', border: 'none',
          borderBottom: active === key ? '2px solid #6366f1' : '2px solid transparent',
          cursor: 'pointer', marginBottom: -1,
        }}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function OAModuleSeedPanel({ seedDone, seeding, seedMsg, onSeed, color, playbookName, playbookDesc }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Info card */}
      <div style={{
        background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
        padding: '20px 22px',
      }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 6 }}>
          🌱 GoWarm Sample Playbook
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px', lineHeight: 1.6 }}>
          Seed the <strong>{playbookName}</strong> — a pre-built set of plays built by the GoWarm team
          to give your org a running start. {playbookDesc}
        </p>
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 18px', lineHeight: 1.5 }}>
          This is a <strong>one-time action</strong>. The playbook will appear in your Playbooks list where
          you can edit, rename, or clone it. Existing playbooks are not affected.
        </p>

        {seedDone ? (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 8,
            background: color + '15', border: `1px solid ${color}40`,
            color, fontSize: 13, fontWeight: 600,
          }}>
            ✓ Sample playbook already seeded — find it in Playbooks
          </div>
        ) : (
          <button
            disabled={seeding}
            onClick={onSeed}
            style={{
              padding: '9px 22px', borderRadius: 8, border: 'none',
              background: color, color: '#fff',
              fontSize: 13, fontWeight: 600,
              cursor: seeding ? 'not-allowed' : 'pointer',
              opacity: seeding ? 0.7 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {seeding ? '⏳ Seeding…' : '🌱 Seed GoWarm Sample Playbook'}
          </button>
        )}

        {seedMsg && (
          <div style={{
            marginTop: 12, padding: '8px 14px', borderRadius: 7, fontSize: 13,
            background: seedMsg.startsWith('Error') ? '#fef2f2' : '#f0fdf4',
            color:      seedMsg.startsWith('Error') ? '#991b1b'  : '#166534',
            border:     `1px solid ${seedMsg.startsWith('Error') ? '#fecaca' : '#bbf7d0'}`,
          }}>
            {seedMsg}
          </div>
        )}
      </div>
    </div>
  );
}

export function OAModuleGeneral({ moduleKey, icon, label, desc, toggleFn }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    apiService.orgAdmin.getProfile()
      .then(r => {
        const mods = r.data.org?.settings?.modules || {};
        setEnabled(mods[moduleKey] || false);
      })
      .catch(() => setError('Failed to load settings'))
      .finally(() => setLoading(false));
  }, [moduleKey]);

  const handleToggle = async (newVal) => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await toggleFn(newVal);
      setEnabled(newVal);
      setSuccess(`${label} ${newVal ? 'enabled' : 'disabled'} ✓`);
      setTimeout(() => setSuccess(''), 3000);
      window.dispatchEvent(new CustomEvent('moduleToggle', { detail: { module: moduleKey, enabled: newVal } }));
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ fontSize: 28 }}>{icon}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Enable {label}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3 }}>{desc}</div>
          </div>
        </div>
        <div
          onClick={() => !saving && handleToggle(!enabled)}
          style={{
            flexShrink: 0, width: 44, height: 24, borderRadius: 12,
            background: enabled ? '#6366f1' : '#d1d5db',
            position: 'relative', cursor: saving ? 'not-allowed' : 'pointer',
            transition: 'background .2s', opacity: saving ? 0.7 : 1,
          }}
        >
          <div style={{
            width: 18, height: 18, borderRadius: '50%', background: '#fff',
            position: 'absolute', top: 3,
            left: enabled ? 23 : 3,
            transition: 'left .2s',
            boxShadow: '0 1px 3px rgba(0,0,0,.2)',
          }} />
        </div>
      </div>

      {enabled ? (
        <div style={{ padding: '12px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 9, fontSize: 13, color: '#166534' }}>
          ✅ Module is active and visible to all members.
          {/* If module has extra sub-tabs, a hint to switch tabs */}
        </div>
      ) : (
        <div style={{ padding: '12px 16px', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 9, fontSize: 13, color: '#6b7280' }}>
          Module is disabled. Enable it above to make it visible to your team.
          Existing data is preserved when re-enabled.
        </div>
      )}
    </div>
  );
}
