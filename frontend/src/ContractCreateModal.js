// ContractCreateModal.js
import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';

const CONTRACT_TYPES = [
  { value: 'nda',        label: 'NDA — Non-Disclosure Agreement' },
  { value: 'msa',        label: 'MSA — Master Service Agreement' },
  { value: 'sow',        label: 'SOW — Statement of Work' },
  { value: 'order_form', label: 'Order Form' },
  { value: 'amendment',  label: 'Amendment' },
  { value: 'custom',     label: 'Custom' },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'INR'];

const PROVIDERS = [
  { value: 'google_drive', label: '🔵 Google Drive' },
  { value: 'onedrive',     label: '🟦 OneDrive' },
  { value: 'other',        label: '🔗 Other link' },
];

function autoTitle(deal, type, date) {
  if (!deal || !type) return '';
  const typeLabel = CONTRACT_TYPES.find(t => t.value === type)?.label.split(' — ')[0] || type;
  const d = date || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${deal.name} — ${typeLabel} — ${d}`;
}

export default function ContractCreateModal({ onClose, onSuccess, prefillDealId }) {
  const [deals, setDeals]   = useState([]);
  const [form, setForm]     = useState({
    contractType:     'nda',
    dealId:           prefillDealId || '',
    title:            '',
    customerLegalName:'',
    companyEntity:    '',
    value:            '',
    currency:         'USD',
    effectiveDate:    '',
    expiryDate:       '',
    arrImpact:        false,
    documentUrl:      '',
    documentProvider: 'google_drive',
    documentComment:  '',
  });
  const [autoTitled, setAutoTitled] = useState(true);
  const [saving, setSaving]         = useState(false);
  const [err, setErr]               = useState('');

  useEffect(() => {
    apiService.deals.getAll?.()
      .then(r => setDeals(r.data?.deals || r.data || []))
      .catch(() => {});
  }, []);

  // Auto-generate title when deal or type changes
  useEffect(() => {
    if (!autoTitled) return;
    const deal = deals.find(d => String(d.id) === String(form.dealId));
    const generated = autoTitle(deal, form.contractType);
    if (generated) setForm(f => ({ ...f, title: generated }));
  }, [form.dealId, form.contractType, deals, autoTitled]);

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function submit() {
    if (!form.title.trim()) { setErr('Title is required'); return; }
    setSaving(true); setErr('');
    try {
      const payload = {
        ...form,
        dealId:   form.dealId ? parseInt(form.dealId, 10) : null,
        value:    form.value  ? parseFloat(form.value)   : null,
        documentUrl:     form.documentUrl     || undefined,
        documentProvider:form.documentProvider|| undefined,
        documentComment: form.documentComment || undefined,
      };
      const r = await apiService.contracts.create(payload);
      onSuccess(r.data.contract);
    } catch (e) {
      setErr(e.response?.data?.error?.message || e.message || 'Failed to create contract');
    } finally { setSaving(false); }
  }



  return (
    <div className="ccm-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ccm-modal">
        {/* Header */}
        <div className="ccm-header">
          <div className="ccm-title">New Contract</div>
          <button className="ccm-close" onClick={onClose}>✕</button>
        </div>

        <div className="ccm-body">
          {err && <div className="ccm-err">{err}</div>}

          {/* Type */}
          <label className="ccm-lbl">Contract Type
            <select className="ccm-inp" value={form.contractType}
              onChange={e => set('contractType', e.target.value)}>
              {CONTRACT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>

          {/* Deal (optional) */}
          <label className="ccm-lbl">Linked Deal
            <select className="ccm-inp" value={form.dealId}
              onChange={e => set('dealId', e.target.value)}>
              <option value="">No deal (standalone)</option>
              {deals.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>

          {/* Title */}
          <label className="ccm-lbl">Title
            <input className="ccm-inp" value={form.title}
              onChange={e => { setAutoTitled(false); set('title', e.target.value); }}
              placeholder="Contract title" />
            {autoTitled && form.title && (
              <span className="ccm-hint">Auto-generated — edit to customise</span>
            )}
          </label>

          {/* Customer / Entity */}
          <div className="ccm-row2">
            <label className="ccm-lbl">Customer Legal Name
              <input className="ccm-inp" value={form.customerLegalName}
                onChange={e => set('customerLegalName', e.target.value)}
                placeholder="Acme Corp Ltd" />
            </label>
            <label className="ccm-lbl">Your Company Entity
              <input className="ccm-inp" value={form.companyEntity}
                onChange={e => set('companyEntity', e.target.value)}
                placeholder="Action CRM Inc" />
            </label>
          </div>

          {/* Value */}
          <div className="ccm-row2">
            <label className="ccm-lbl">Contract Value
              <input className="ccm-inp" type="number" min="0" value={form.value}
                onChange={e => set('value', e.target.value)}
                placeholder="0" />
            </label>
            <label className="ccm-lbl">Currency
              <select className="ccm-inp" value={form.currency}
                onChange={e => set('currency', e.target.value)}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>

          {/* Dates */}
          <div className="ccm-row2">
            <label className="ccm-lbl">Effective Date
              <input className="ccm-inp" type="date" value={form.effectiveDate}
                onChange={e => set('effectiveDate', e.target.value)} />
            </label>
            <label className="ccm-lbl">Expiry Date
              <input className="ccm-inp" type="date" value={form.expiryDate}
                onChange={e => set('expiryDate', e.target.value)} />
            </label>
          </div>

          {/* ARR impact (amendment only) */}
          {form.contractType === 'amendment' && (
            <label className="ccm-check">
              <input type="checkbox" checked={form.arrImpact}
                onChange={e => set('arrImpact', e.target.checked)} />
              This amendment changes ARR
            </label>
          )}

          {/* Initial document (optional) */}
          <div className="ccm-section-title">Initial Document <span className="ccm-opt">(optional)</span></div>
          <label className="ccm-lbl">Document URL
            <input className="ccm-inp" value={form.documentUrl}
              onChange={e => set('documentUrl', e.target.value)}
              placeholder="Paste Google Drive / OneDrive link" />
          </label>

          {form.documentUrl && (
            <>
              <label className="ccm-lbl">Provider
                <select className="ccm-inp" value={form.documentProvider}
                  onChange={e => set('documentProvider', e.target.value)}>
                  {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
              <label className="ccm-lbl">Comment
                <input className="ccm-inp" value={form.documentComment}
                  onChange={e => set('documentComment', e.target.value)}
                  placeholder="e.g. Initial draft" />
              </label>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="ccm-footer">
          <button className="ccm-cancel" onClick={onClose}>Cancel</button>
          <button className="ccm-submit" onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create Contract'}
          </button>
        </div>
      </div>

      <style>{`
        .ccm-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:1000; display:flex; align-items:center; justify-content:center; padding:16px; }
        .ccm-modal { background:#fff; border-radius:14px; width:100%; max-width:560px; max-height:90vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,.2); }
        .ccm-header { display:flex; align-items:center; justify-content:space-between; padding:18px 20px 14px; border-bottom:1px solid #f1f5f9; flex-shrink:0; }
        .ccm-title { font-size:16px; font-weight:800; color:#0f172a; }
        .ccm-close { background:none; border:none; font-size:18px; cursor:pointer; color:#94a3b8; padding:4px 8px; border-radius:6px; }
        .ccm-close:hover { background:#f1f5f9; }
        .ccm-body { overflow-y:auto; padding:18px 20px; display:flex; flex-direction:column; gap:12px; }
        .ccm-err { font-size:12px; color:#991b1b; background:#fef2f2; padding:8px 12px; border-radius:8px; }
        .ccm-lbl { display:flex; flex-direction:column; gap:4px; font-size:12px; font-weight:600; color:#475569; }
        .ccm-inp { padding:8px 11px; border:1.5px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; outline:none; background:#fff; color:#0f172a; }
        .ccm-inp:focus { border-color:#6366f1; }
        .ccm-hint { font-size:10px; color:#94a3b8; font-weight:400; }
        .ccm-row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .ccm-check { display:flex; align-items:center; gap:8px; font-size:13px; color:#475569; cursor:pointer; }
        .ccm-section-title { font-size:12px; font-weight:700; color:#0f172a; padding-top:4px; border-top:1px solid #f1f5f9; margin-top:4px; }
        .ccm-opt { font-weight:400; color:#94a3b8; }
        .ccm-footer { display:flex; justify-content:flex-end; gap:10px; padding:14px 20px; border-top:1px solid #f1f5f9; flex-shrink:0; }
        .ccm-cancel { padding:9px 18px; border-radius:8px; border:1.5px solid #e2e8f0; background:#fff; color:#475569; font-size:13px; font-weight:600; cursor:pointer; }
        .ccm-cancel:hover { background:#f8fafc; }
        .ccm-submit { padding:9px 22px; border-radius:8px; border:none; background:#6366f1; color:#fff; font-size:13px; font-weight:700; cursor:pointer; }
        .ccm-submit:hover:not(:disabled) { background:#4f46e5; }
        .ccm-submit:disabled { opacity:.5; cursor:not-allowed; }
      `}</style>
    </div>
  );
}
