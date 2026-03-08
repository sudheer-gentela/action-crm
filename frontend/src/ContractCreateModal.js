// ContractCreateModal.js — v2
// Chunk 2 additions:
//   • Standalone mode — NDA / Amendment can be created without a deal
//   • All 8 new metadata fields: customerLegalName, companyEntity, includeFullDpa,
//     terminationForConvenience, tfcStartDate, tfcEndDate, specialTerms, agreementEndDate
//   • Template download button — fetches templates by contract type
//   • Legal assignee dropdown — optional direct assignment at create time
//   • Amendment subtype selector (expansion / reduction / scope / other)
//   • legalAssigneeId forwarded in payload

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

// Types that commonly don't need a deal
const STANDALONE_TYPES = ['nda', 'amendment'];

const AMENDMENT_SUBTYPES = [
  { value: 'expansion',  label: 'Expansion — adds seats / ARR' },
  { value: 'reduction',  label: 'Reduction — removes seats / ARR' },
  { value: 'scope',      label: 'Scope change — adds/removes products' },
  { value: 'other',      label: 'Other amendment' },
];

const COMPANY_ENTITIES = [
  { value: '',   label: 'Select entity…' },
  { value: 'us', label: '🇺🇸 Action CRM Inc (US)' },
  { value: 'uk', label: '🇬🇧 Action CRM Ltd (UK)' },
  { value: 'de', label: '🇩🇪 Action CRM GmbH (DE)' },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'INR'];

const PROVIDERS = [
  { value: 'google_drive', label: '🔵 Google Drive' },
  { value: 'onedrive',     label: '🟦 OneDrive' },
  { value: 'other',        label: '🔗 Other link' },
];

function autoTitle(deal, standaloneCustomerName, type, date) {
  const typeLabel = CONTRACT_TYPES.find(t => t.value === type)?.label.split(' — ')[0] || type;
  const subject = deal?.name || standaloneCustomerName || null;
  if (!subject || !type) return '';
  const d = date || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${subject} — ${typeLabel} — ${d}`;
}

export default function ContractCreateModal({ onClose, onSuccess, prefillDealId }) {
  const [deals, setDeals]             = useState([]);
  const [legalMembers, setLegalMembers] = useState([]);
  const [templates, setTemplates]     = useState([]);
  const [form, setForm] = useState({
    contractType:              'nda',
    dealId:                    prefillDealId || '',
    title:                     '',
    customerLegalName:         '',
    companyEntity:             '',
    includeFullDpa:            false,
    terminationForConvenience: false,
    tfcStartDate:              '',
    tfcEndDate:                '',
    specialTerms:              '',
    agreementEndDate:          '',
    value:                     '',
    currency:                  'USD',
    effectiveDate:             '',
    expiryDate:                '',
    arrImpact:                 false,
    amendmentSubtype:          '',
    legalAssigneeId:           '',
    documentUrl:               '',
    documentProvider:          'google_drive',
    documentComment:           '',
  });
  const [autoTitled, setAutoTitled]   = useState(true);
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState('');
  const [templateLoading, setTemplateLoading] = useState(false);

  // Load deals + legal members + templates for the initial type
  useEffect(() => {
    apiService.deals.getAll?.()
      .then(r => setDeals(r.data?.deals || r.data || []))
      .catch(() => {});
    apiService.contracts.getLegalMembers()
      .then(r => setLegalMembers(r.data?.members || []))
      .catch(() => {});
  }, []);

  // Reload templates when contract type changes
  useEffect(() => {
    setTemplates([]);
    setTemplateLoading(true);
    apiService.contracts.getTemplatesByType(form.contractType)
      .then(r => setTemplates(r.data?.templates || []))
      .catch(() => {})
      .finally(() => setTemplateLoading(false));
  }, [form.contractType]);

  // Auto-generate title from deal OR standalone customer name
  useEffect(() => {
    if (!autoTitled) return;
    const deal = deals.find(d => String(d.id) === String(form.dealId));
    const generated = autoTitle(deal, form.customerLegalName, form.contractType);
    if (generated) setForm(f => ({ ...f, title: generated }));
  }, [form.dealId, form.contractType, form.customerLegalName, deals, autoTitled]);

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  // Is this a standalone contract (no deal required)?
  const isStandalone = !form.dealId;
  const isAmendment  = form.contractType === 'amendment';
  const showTfcDates = form.terminationForConvenience;

  async function downloadTemplate(tpl) {
    window.open(tpl.document_url, '_blank', 'noopener,noreferrer');
  }

  async function submit() {
    if (!form.title.trim()) { setErr('Title is required'); return; }
    setSaving(true); setErr('');
    try {
      const payload = {
        contractType:              form.contractType,
        dealId:                    form.dealId ? parseInt(form.dealId, 10) : null,
        title:                     form.title.trim(),
        customerLegalName:         form.customerLegalName  || undefined,
        companyEntity:             form.companyEntity      || undefined,
        includeFullDpa:            form.includeFullDpa,
        terminationForConvenience: form.terminationForConvenience,
        tfcStartDate:              form.tfcStartDate       || undefined,
        tfcEndDate:                form.tfcEndDate         || undefined,
        specialTerms:              form.specialTerms       || undefined,
        agreementEndDate:          form.agreementEndDate   || undefined,
        value:                     form.value ? parseFloat(form.value) : null,
        currency:                  form.currency,
        effectiveDate:             form.effectiveDate      || undefined,
        expiryDate:                form.expiryDate         || undefined,
        arrImpact:                 form.arrImpact,
        amendmentSubtype:          form.amendmentSubtype   || undefined,
        legalAssigneeId:           form.legalAssigneeId ? parseInt(form.legalAssigneeId, 10) : undefined,
        documentUrl:               form.documentUrl        || undefined,
        documentProvider:          form.documentUrl ? form.documentProvider : undefined,
        documentComment:           form.documentUrl ? (form.documentComment || undefined) : undefined,
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
        {/* ── Header ── */}
        <div className="ccm-header">
          <div className="ccm-title">New Contract</div>
          <button className="ccm-close" onClick={onClose}>✕</button>
        </div>

        <div className="ccm-body">
          {err && <div className="ccm-err">{err}</div>}

          {/* ── Contract Type ── */}
          <label className="ccm-lbl">Contract Type
            <select className="ccm-inp" value={form.contractType}
              onChange={e => set('contractType', e.target.value)}>
              {CONTRACT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>

          {/* ── Template download banner ── */}
          {!templateLoading && templates.length > 0 && (
            <div className="ccm-templates">
              <div className="ccm-tmpl-label">📄 Templates for this type</div>
              {templates.map(tpl => (
                <button key={tpl.id} className="ccm-tmpl-btn"
                  onClick={() => downloadTemplate(tpl)}
                  title={tpl.description || ''}>
                  ⬇ {tpl.name}
                  {tpl.version_label && <span className="ccm-tmpl-ver">v{tpl.version_label}</span>}
                </button>
              ))}
            </div>
          )}

          {/* ── Amendment subtype (amendment only) ── */}
          {isAmendment && (
            <label className="ccm-lbl">Amendment Type
              <select className="ccm-inp" value={form.amendmentSubtype}
                onChange={e => set('amendmentSubtype', e.target.value)}>
                <option value="">Select…</option>
                {AMENDMENT_SUBTYPES.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </label>
          )}

          {/* ── Linked Deal (optional) ── */}
          <label className="ccm-lbl">
            Linked Deal
            {STANDALONE_TYPES.includes(form.contractType) && (
              <span className="ccm-opt-tag"> — optional for {form.contractType.toUpperCase()}</span>
            )}
            <select className="ccm-inp" value={form.dealId}
              onChange={e => set('dealId', e.target.value)}>
              <option value="">No deal (standalone)</option>
              {deals.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>

          {/* ── Standalone notice ── */}
          {isStandalone && (
            <div className="ccm-notice ccm-notice--info">
              ℹ️ Standalone contract — not linked to any deal. You can link it to a deal later.
            </div>
          )}

          {/* ── Title ── */}
          <label className="ccm-lbl">Title
            <input className="ccm-inp" value={form.title}
              onChange={e => { setAutoTitled(false); set('title', e.target.value); }}
              placeholder="Contract title" />
            {autoTitled && form.title && (
              <span className="ccm-hint">Auto-generated — edit to customise</span>
            )}
          </label>

          {/* ══ Parties ═════════════════════════════════════════════ */}
          <div className="ccm-section-title">Parties</div>

          <div className="ccm-row2">
            <label className="ccm-lbl">Customer Legal Name
              <input className="ccm-inp" value={form.customerLegalName}
                onChange={e => set('customerLegalName', e.target.value)}
                placeholder="Acme Corp Ltd" />
            </label>
            <label className="ccm-lbl">Your Company Entity
              <select className="ccm-inp" value={form.companyEntity}
                onChange={e => set('companyEntity', e.target.value)}>
                {COMPANY_ENTITIES.map(e => (
                  <option key={e.value} value={e.value}>{e.label}</option>
                ))}
              </select>
            </label>
          </div>

          {/* ══ Contract Terms ══════════════════════════════════════ */}
          <div className="ccm-section-title">Contract Terms</div>

          {/* DPA + TFC checkboxes */}
          <div className="ccm-check-row">
            <label className="ccm-check">
              <input type="checkbox" checked={form.includeFullDpa}
                onChange={e => set('includeFullDpa', e.target.checked)} />
              Include full DPA
            </label>
            <label className="ccm-check">
              <input type="checkbox" checked={form.terminationForConvenience}
                onChange={e => set('terminationForConvenience', e.target.checked)} />
              Termination for convenience
            </label>
          </div>

          {/* TFC dates — only shown when TFC is checked */}
          {showTfcDates && (
            <div className="ccm-row2 ccm-indent">
              <label className="ccm-lbl">TFC Start Date
                <input className="ccm-inp" type="date" value={form.tfcStartDate}
                  onChange={e => set('tfcStartDate', e.target.value)} />
              </label>
              <label className="ccm-lbl">TFC End Date
                <input className="ccm-inp" type="date" value={form.tfcEndDate}
                  onChange={e => set('tfcEndDate', e.target.value)} />
              </label>
            </div>
          )}

          {/* Special terms */}
          <label className="ccm-lbl">Special Terms <span className="ccm-opt">(optional)</span>
            <textarea className="ccm-inp ccm-textarea" rows={2}
              value={form.specialTerms}
              onChange={e => set('specialTerms', e.target.value)}
              placeholder="Any non-standard terms or notes for legal…" />
          </label>

          {/* ══ Value & Dates ════════════════════════════════════════ */}
          <div className="ccm-section-title">Value & Dates</div>

          <div className="ccm-row2">
            <label className="ccm-lbl">Contract Value
              <input className="ccm-inp" type="number" min="0" value={form.value}
                onChange={e => set('value', e.target.value)} placeholder="0" />
            </label>
            <label className="ccm-lbl">Currency
              <select className="ccm-inp" value={form.currency}
                onChange={e => set('currency', e.target.value)}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>

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

          <label className="ccm-lbl">Agreement End Date <span className="ccm-opt">(optional — overrides expiry)</span>
            <input className="ccm-inp" type="date" value={form.agreementEndDate}
              onChange={e => set('agreementEndDate', e.target.value)} />
          </label>

          {/* ARR impact (amendment only) */}
          {isAmendment && (
            <label className="ccm-check">
              <input type="checkbox" checked={form.arrImpact}
                onChange={e => set('arrImpact', e.target.checked)} />
              This amendment changes ARR
            </label>
          )}

          {/* ══ Legal Assignment ════════════════════════════════════ */}
          <div className="ccm-section-title">Legal Assignment <span className="ccm-opt">(optional)</span></div>
          <label className="ccm-lbl">Assign to Legal Team Member
            <select className="ccm-inp" value={form.legalAssigneeId}
              onChange={e => set('legalAssigneeId', e.target.value)}>
              <option value="">Unassigned — goes to legal queue</option>
              {legalMembers.map(m => (
                <option key={m.id} value={m.id}>
                  {m.first_name} {m.last_name}{m.email ? ` (${m.email})` : ''}
                </option>
              ))}
            </select>
            <span className="ccm-hint">
              {form.legalAssigneeId
                ? 'Contract will be directly assigned when submitted to legal.'
                : 'Contract will appear in the shared legal queue.'}
            </span>
          </label>

          {/* ══ Initial Document ═══════════════════════════════════ */}
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
              <label className="ccm-lbl">Version Comment
                <input className="ccm-inp" value={form.documentComment}
                  onChange={e => set('documentComment', e.target.value)}
                  placeholder="e.g. Initial draft" />
              </label>
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="ccm-footer">
          <button className="ccm-cancel" onClick={onClose}>Cancel</button>
          <button className="ccm-submit" onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create Contract'}
          </button>
        </div>
      </div>

      <style>{`
        .ccm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
        .ccm-modal{background:#fff;border-radius:14px;width:100%;max-width:580px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.2)}
        .ccm-header{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 14px;border-bottom:1px solid #f1f5f9;flex-shrink:0}
        .ccm-title{font-size:16px;font-weight:800;color:#0f172a}
        .ccm-close{background:none;border:none;font-size:18px;cursor:pointer;color:#94a3b8;padding:4px 8px;border-radius:6px}
        .ccm-close:hover{background:#f1f5f9}
        .ccm-body{overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px}
        .ccm-err{font-size:12px;color:#991b1b;background:#fef2f2;padding:8px 12px;border-radius:8px}
        .ccm-notice{font-size:12px;padding:8px 12px;border-radius:8px}
        .ccm-notice--info{background:#dbeafe;color:#1e40af}
        .ccm-lbl{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:#475569}
        .ccm-opt-tag{font-size:11px;font-weight:400;color:#94a3b8}
        .ccm-inp{padding:8px 11px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;font-family:inherit;outline:none;background:#fff;color:#0f172a}
        .ccm-inp:focus{border-color:#6366f1}
        .ccm-textarea{resize:vertical;min-height:60px;line-height:1.5}
        .ccm-hint{font-size:10px;color:#94a3b8;font-weight:400}
        .ccm-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .ccm-indent{margin-left:16px;border-left:2px solid #e2e8f0;padding-left:12px}
        .ccm-check-row{display:flex;gap:20px;flex-wrap:wrap}
        .ccm-check{display:flex;align-items:center;gap:7px;font-size:13px;color:#475569;cursor:pointer;user-select:none}
        .ccm-check input[type=checkbox]{width:15px;height:15px;accent-color:#6366f1;cursor:pointer}
        .ccm-section-title{font-size:11px;font-weight:700;color:#6366f1;text-transform:uppercase;letter-spacing:.5px;padding-top:6px;border-top:1px solid #f1f5f9;margin-top:2px}
        .ccm-opt{font-weight:400;color:#94a3b8;font-size:11px;text-transform:none}
        .ccm-templates{background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:7px}
        .ccm-tmpl-label{font-size:11px;font-weight:700;color:#065f46}
        .ccm-tmpl-btn{display:flex;align-items:center;gap:8px;padding:7px 12px;border:1.5px solid #6ee7b7;border-radius:7px;background:#fff;color:#059669;font-size:12px;font-weight:600;cursor:pointer;text-align:left}
        .ccm-tmpl-btn:hover{background:#f0fdf4}
        .ccm-tmpl-ver{font-size:10px;color:#94a3b8;font-weight:400;margin-left:auto}
        .ccm-footer{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid #f1f5f9;flex-shrink:0}
        .ccm-cancel{padding:9px 18px;border-radius:8px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;font-size:13px;font-weight:600;cursor:pointer}
        .ccm-cancel:hover{background:#f8fafc}
        .ccm-submit{padding:9px 22px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:13px;font-weight:700;cursor:pointer}
        .ccm-submit:hover:not(:disabled){background:#4f46e5}
        .ccm-submit:disabled{opacity:.5;cursor:not-allowed}
      `}</style>
    </div>
  );
}
