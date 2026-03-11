// CaseCreateModal.js
// Modal form for creating a new support case.
// Props:
//   onClose    {fn}       — close without creating
//   onCreated  {fn(case)} — called with the new case object on success
//
// All API calls use apiService.support.*

import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { FormField } from './SupportShared';

export default function CaseCreateModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    subject:        '',
    description:    '',
    priority:       'medium',
    source:         'manual',
    accountId:      '',
    slaTierId:      '',
    assignedTeamId: '',
    assignedTo:     '',
  });
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  const [accounts, setAccounts]       = useState([]);
  const [slaTiers, setSlaTiers]       = useState([]);
  const [teams, setTeams]             = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);

  // Load reference data on mount
  useEffect(() => {
    Promise.all([
      apiService.accounts?.getAll?.({ limit: 500 }).catch(() => ({ data: { accounts: [] } })),
      apiService.support.getSlaTiers().catch(() => ({ data: { tiers: [] } })),
      apiService.support.getTeams().catch(() => ({ data: { teams: [] } })),
    ]).then(([accts, tiers, teamsData]) => {
      setAccounts(accts?.data?.accounts || []);
      setSlaTiers(tiers?.data?.tiers || []);
      setTeams(teamsData?.data?.teams || []);
    });
  }, []);

  // Reload team members when team selection changes
  useEffect(() => {
    if (!form.assignedTeamId) {
      setTeamMembers([]);
      setForm(f => ({ ...f, assignedTo: '' }));
      return;
    }
    apiService.support.getTeamMembers(form.assignedTeamId)
      .then(r => setTeamMembers(r.data.members || []))
      .catch(() => setTeamMembers([]));
  }, [form.assignedTeamId]);

  const set = (field, val) => setForm(f => ({ ...f, [field]: val }));

  const handleSubmit = async () => {
    if (!form.subject.trim()) { setError('Subject is required'); return; }
    setSaving(true); setError('');
    try {
      const r = await apiService.support.createCase({
        subject:        form.subject.trim(),
        description:    form.description || undefined,
        priority:       form.priority,
        source:         form.source,
        accountId:      form.accountId      ? parseInt(form.accountId)      : undefined,
        slaTierId:      form.slaTierId      ? parseInt(form.slaTierId)      : undefined,
        assignedTeamId: form.assignedTeamId ? parseInt(form.assignedTeamId) : undefined,
        assignedTo:     form.assignedTo     ? parseInt(form.assignedTo)     : undefined,
      });
      onCreated(r.data.case);
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to create case');
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = form.subject.trim() && !saving;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>

        {/* Header */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>New Case</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && (
            <div style={{ padding: '8px 12px', background: '#fee2e2', borderRadius: 7, fontSize: 13, color: '#ef4444' }}>
              ⚠️ {error}
            </div>
          )}

          <FormField label="Subject *">
            <input
              value={form.subject}
              onChange={e => set('subject', e.target.value)}
              placeholder="Brief description of the issue…"
              autoFocus
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
            />
          </FormField>

          <FormField label="Description">
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              rows={3}
              placeholder="More detail…"
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
            />
          </FormField>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Priority">
              <select value={form.priority} onChange={e => set('priority', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </FormField>
            <FormField label="Source">
              <select value={form.source} onChange={e => set('source', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="manual">Manual</option>
                <option value="email">Email</option>
                <option value="portal">Portal</option>
              </select>
            </FormField>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Account">
              <select value={form.accountId} onChange={e => set('accountId', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="">— None —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FormField>
            <FormField label="SLA Tier">
              <select value={form.slaTierId} onChange={e => set('slaTierId', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="">Inherit from account</option>
                {slaTiers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </FormField>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Assign to Team">
              <select value={form.assignedTeamId} onChange={e => set('assignedTeamId', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                <option value="">— Unassigned —</option>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </FormField>
            <FormField label="Assign to Person">
              <select
                value={form.assignedTo}
                onChange={e => set('assignedTo', e.target.value)}
                disabled={!form.assignedTeamId}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, opacity: form.assignedTeamId ? 1 : 0.5 }}
              >
                <option value="">— Unassigned —</option>
                {teamMembers.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
              </select>
            </FormField>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            onClick={onClose}
            style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              padding: '8px 24px', borderRadius: 8, border: 'none',
              background: canSubmit ? '#6366f1' : '#e5e7eb',
              color: canSubmit ? '#fff' : '#9ca3af',
              fontSize: 13, fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'default',
            }}
          >
            {saving ? 'Creating…' : 'Create Case'}
          </button>
        </div>
      </div>
    </div>
  );
}
