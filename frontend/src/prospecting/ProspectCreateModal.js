// ProspectCreateModal.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';

function ProspectCreateModal({ onSave, onClose }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', linkedinUrl: '',
    title: '', location: '', companyName: '', companyDomain: '',
    companySize: '', companyIndustry: '', source: 'manual', tags: [],
    playbookId: '',
  });
  const [playbooks, setPlaybooks]         = useState([]);
  const [defaultPlaybook, setDefaultPlaybook] = useState(null);
  const [showMakeDefault, setShowMakeDefault] = useState(false);
  const [sfLockedFields, setSfLockedFields]   = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/playbooks?type=prospecting');
        const all = r.playbooks || [];
        setPlaybooks(all);
        setDefaultPlaybook(all.find(pb => pb.is_default) || null);
      } catch {
        setPlaybooks([]);
      }
      // Load SF locked fields for prospects (sf_primary mode)
      try {
        const sfr = await apiFetch('/salesforce/locked-fields/prospect');
        setSfLockedFields(sfr.data || []);
      } catch {
        // Not connected or not in sf_primary — no locks
      }
    })();
  }, []);

  const set = (field, val) => setForm(prev => ({ ...prev, [field]: val }));

  const handlePlaybookChange = (e) => {
    const id = e.target.value;
    set('playbookId', id);
    // Show "make default" prompt only if user picks a non-default playbook
    const picked = playbooks.find(pb => String(pb.id) === String(id));
    setShowMakeDefault(!!picked && !picked.is_default);
  };

  const handleMakeDefault = async (playbookId) => {
    try {
      await apiFetch(`/playbooks/${playbookId}/set-default`, { method: 'POST' });
      setPlaybooks(prev => prev.map(pb => ({ ...pb, is_default: pb.id === parseInt(playbookId) })));
      setDefaultPlaybook(playbooks.find(pb => pb.id === parseInt(playbookId)) || null);
      setShowMakeDefault(false);
    } catch (err) {
      alert('Could not update default playbook: ' + err.message);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) {
      alert('First and last name are required');
      return;
    }
    onSave(form);
  };

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()}>
        <div className="pv-modal-header">
          <h3>Add New Prospect</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} className="pv-form">
          <div className="pv-form-section">
            <h4>
              Person
              {sfLockedFields.length > 0 && <span style={{ fontSize: 11, color: '#0369a1', fontWeight: 400, marginLeft: 8 }}>🔒 Some fields managed by Salesforce</span>}
            </h4>
            <div className="pv-form-row">
              <input placeholder="First name *" value={form.firstName} onChange={e => set('firstName', e.target.value)} required
                disabled={sfLockedFields.includes('first_name')} title={sfLockedFields.includes('first_name') ? 'Managed by Salesforce' : undefined} />
              <input placeholder="Last name *" value={form.lastName} onChange={e => set('lastName', e.target.value)} required
                disabled={sfLockedFields.includes('last_name')} title={sfLockedFields.includes('last_name') ? 'Managed by Salesforce' : undefined} />
            </div>
            <input placeholder="Email" value={form.email} onChange={e => set('email', e.target.value)} type="email"
              disabled={sfLockedFields.includes('email')} title={sfLockedFields.includes('email') ? 'Managed by Salesforce' : undefined} />
            <input placeholder="Job title" value={form.title} onChange={e => set('title', e.target.value)}
              disabled={sfLockedFields.includes('title')} title={sfLockedFields.includes('title') ? 'Managed by Salesforce' : undefined} />
            <div className="pv-form-row">
              <input placeholder="Phone" value={form.phone} onChange={e => set('phone', e.target.value)}
                disabled={sfLockedFields.includes('phone')} title={sfLockedFields.includes('phone') ? 'Managed by Salesforce' : undefined} />
              <input placeholder="LinkedIn URL" value={form.linkedinUrl} onChange={e => set('linkedinUrl', e.target.value)} />
            </div>
            <input placeholder="Location" value={form.location} onChange={e => set('location', e.target.value)} />
          </div>

          <div className="pv-form-section">
            <h4>Company</h4>
            <div className="pv-form-row">
              <input placeholder="Company name" value={form.companyName} onChange={e => set('companyName', e.target.value)}
                disabled={sfLockedFields.includes('company_name')} title={sfLockedFields.includes('company_name') ? 'Managed by Salesforce' : undefined} />
              <input placeholder="Domain (e.g. acme.com)" value={form.companyDomain} onChange={e => set('companyDomain', e.target.value)}
                disabled={sfLockedFields.includes('company_domain')} title={sfLockedFields.includes('company_domain') ? 'Managed by Salesforce' : undefined} />
            </div>
            <div className="pv-form-row">
              <select value={form.companySize} onChange={e => set('companySize', e.target.value)}
                disabled={sfLockedFields.includes('company_size')}>
                <option value="">Company size</option>
                <option value="1-10">1–10</option>
                <option value="11-50">11–50</option>
                <option value="51-200">51–200</option>
                <option value="201-500">201–500</option>
                <option value="501-1000">501–1,000</option>
                <option value="1001-5000">1,001–5,000</option>
                <option value="5001+">5,001+</option>
              </select>
              <input placeholder="Industry" value={form.companyIndustry} onChange={e => set('companyIndustry', e.target.value)}
                disabled={sfLockedFields.includes('company_industry')} title={sfLockedFields.includes('company_industry') ? 'Managed by Salesforce' : undefined} />
            </div>
          </div>

          <div className="pv-form-section">
            <h4>Source</h4>
            <select value={form.source} onChange={e => set('source', e.target.value)}>
              <option value="manual">Manual</option>
              <option value="linkedin">LinkedIn</option>
              <option value="referral">Referral</option>
              <option value="event">Event</option>
              <option value="inbound">Inbound</option>
              <option value="import">Import</option>
            </select>
          </div>

          <div className="pv-form-section">
            <h4>Playbook</h4>
            <select value={form.playbookId} onChange={handlePlaybookChange}>
              <option value="">
                {defaultPlaybook ? `✓ Default: ${defaultPlaybook.name}` : 'Use org default playbook'}
              </option>
              {playbooks.map(pb => (
                <option key={pb.id} value={pb.id}>
                  {pb.is_default ? '★ ' : ''}{pb.name}
                </option>
              ))}
            </select>
            {showMakeDefault && (
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff8f0', border: '1px solid #FBCF9D', borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: '#92400e' }}>Make <strong>{playbooks.find(pb => String(pb.id) === String(form.playbookId))?.name}</strong> the default for all new prospects?</span>
                <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => handleMakeDefault(form.playbookId)}
                    style={{ padding: '3px 10px', background: '#E8630A', color: '#fff', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                    Yes, make default
                  </button>
                  <button type="button" onClick={() => setShowMakeDefault(false)}
                    style={{ padding: '3px 10px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
                    No, just this prospect
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="pv-form-actions">
            <button type="button" onClick={onClose} className="pv-btn-secondary">Cancel</button>
            <button type="submit" className="pv-btn-primary">Create Prospect</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PROSPECT DETAIL PANEL (slide-out)
// ═════════════════════════════════════════════════════════════════════════════


export default ProspectCreateModal;
