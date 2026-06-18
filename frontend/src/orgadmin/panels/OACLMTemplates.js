/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OACLMTemplates. Includes co-located single-consumer constants/helpers. */
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const CONTRACT_TYPE_LABELS = {
  nda:        'NDA',
  msa:        'MSA',
  sow:        'SOW',
  order_form: 'Order Form',
  amendment:  'Amendment',
};

export default function OACLMTemplates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');
  const [uploading, setUploading] = useState(null); // contract_type being uploaded
  const [form, setForm]           = useState({ contractType: 'nda', name: '', description: '', fileUrl: '', fileName: '' });
  const [showForm, setShowForm]   = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.contracts.getTemplates();
      setTemplates(r.data.templates || []);
    } catch { setError('Failed to load templates'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name.trim() || !form.fileUrl.trim()) {
      setError('Name and file URL are required'); return;
    }
    try {
      setUploading(form.contractType);
      await apiService.contracts.createTemplate(form);
      setSuccess('Template added');
      setTimeout(() => setSuccess(''), 2500);
      setShowForm(false);
      setForm({ contractType: 'nda', name: '', description: '', fileUrl: '', fileName: '' });
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to add template');
    } finally { setUploading(null); }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Remove template "${name}"?`)) return;
    try {
      await apiService.contracts.deleteTemplate(id);
      setSuccess('Template removed');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch { setError('Failed to remove template'); }
  };

  const groupedByType = Object.keys(CONTRACT_TYPE_LABELS).reduce((acc, type) => {
    acc[type] = templates.filter(t => t.contract_type === type && t.is_active);
    return acc;
  }, {});

  return (
    <div className="sv-panel">
      <div className="sv-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>📄 CLM Contract Templates</h2>
          <p className="sv-panel-desc">
            Upload master templates for each contract type. Team members can download these,
            fill them in Word, and upload back into a contract as v1.0.
          </p>
        </div>
        <button
          className="sv-btn sv-btn-primary"
          onClick={() => setShowForm(true)}
          style={{ whiteSpace: 'nowrap', marginLeft: 16 }}
        >
          + Add Template
        </button>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {/* Add template form */}
      {showForm && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
          padding: 20, marginBottom: 20,
        }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>Add New Template</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label className="sv-label">Contract Type</label>
              <select
                className="sv-input"
                value={form.contractType}
                onChange={e => setForm(f => ({ ...f, contractType: e.target.value }))}
              >
                {Object.entries(CONTRACT_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="sv-label">Template Name</label>
              <input
                className="sv-input"
                placeholder="e.g. Standard NDA v3"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="sv-label">File URL (paste link from Google Drive / OneDrive / SharePoint)</label>
            <input
              className="sv-input"
              placeholder="https://docs.google.com/…"
              value={form.fileUrl}
              onChange={e => setForm(f => ({ ...f, fileUrl: e.target.value }))}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="sv-label">File Name (optional)</label>
            <input
              className="sv-input"
              placeholder="NDA_Template_v3.docx"
              value={form.fileName}
              onChange={e => setForm(f => ({ ...f, fileName: e.target.value }))}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="sv-label">Description (optional)</label>
            <input
              className="sv-input"
              placeholder="Use for standard mutual NDAs with US entities"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="sv-btn sv-btn-primary"
              onClick={handleCreate}
              disabled={!!uploading}
            >
              {uploading ? 'Adding…' : 'Add Template'}
            </button>
            <button className="sv-btn" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="sv-loading">Loading templates…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {Object.entries(CONTRACT_TYPE_LABELS).map(([type, label]) => (
            <div key={type}>
              <div style={{
                fontWeight: 600, fontSize: 13, color: '#374151',
                borderBottom: '1px solid #e5e7eb', paddingBottom: 8, marginBottom: 12,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                {label}
                <span style={{
                  fontSize: 11, background: '#f3f4f6', color: '#6b7280',
                  borderRadius: 10, padding: '1px 8px',
                }}>
                  {groupedByType[type]?.length || 0}
                </span>
              </div>
              {(!groupedByType[type] || groupedByType[type].length === 0) ? (
                <div style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic', paddingLeft: 4 }}>
                  No templates — click "Add Template" to upload one.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {groupedByType[type].map(t => (
                    <div key={t.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', background: '#fff', border: '1px solid #e5e7eb',
                      borderRadius: 8, gap: 12,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937' }}>
                          📄 {t.name}
                        </div>
                        {t.description && (
                          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.description}</div>
                        )}
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                          Added {new Date(t.created_at).toLocaleDateString()}
                          {t.file_name && ` · ${t.file_name}`}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        <a
                          href={t.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="sv-btn"
                          style={{ fontSize: 12, padding: '4px 12px', textDecoration: 'none' }}
                        >
                          ↓ Download
                        </a>
                        <button
                          className="oa-btn-remove"
                          style={{ fontSize: 12 }}
                          onClick={() => handleDelete(t.id, t.name)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
