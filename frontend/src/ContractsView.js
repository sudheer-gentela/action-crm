// ContractsView.js
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import ContractDetailPanel from './ContractDetailPanel';
import ContractCreateModal from './ContractCreateModal';
import './ContractsView.css';

const STATUS_OPTIONS = [
  { value:'', label:'All statuses' }, { value:'draft', label:'Draft' },
  { value:'in_legal_review', label:'In Legal Review' }, { value:'with_sales', label:'With Sales' },
  { value:'in_signatures', label:'In Signatures' }, { value:'signed', label:'Signed' },
  { value:'active', label:'Active' }, { value:'expired', label:'Expired' },
  { value:'void', label:'Void' },
];
const TYPE_OPTIONS = [
  { value:'', label:'All types' }, { value:'nda', label:'NDA' }, { value:'msa', label:'MSA' },
  { value:'sow', label:'SOW' }, { value:'order_form', label:'Order Form' },
  { value:'amendment', label:'Amendment' }, { value:'custom', label:'Custom' },
];
const STATUS_COLORS = {
  draft:{ bg:'#f1f5f9',text:'#475569' }, in_legal_review:{ bg:'#fef3c7',text:'#92400e' },
  with_sales:{ bg:'#dbeafe',text:'#1e40af' }, in_signatures:{ bg:'#ede9fe',text:'#5b21b6' },
  signed:{ bg:'#dcfce7',text:'#14532d' }, active:{ bg:'#d1fae5',text:'#065f46' },
  expired:{ bg:'#f3f4f6',text:'#6b7280' }, void:{ bg:'#fee2e2',text:'#991b1b' },
};
const TYPE_LABELS = { nda:'NDA',msa:'MSA',sow:'SOW',order_form:'Order Form',amendment:'Amendment',custom:'Custom' };

function Badge({ status }) {
  const col = STATUS_COLORS[status] || STATUS_COLORS.draft;
  const lbl = STATUS_OPTIONS.find(s => s.value === status)?.label || status;
  return <span className="cv-badge" style={{ background:col.bg, color:col.text }}>{lbl}</span>;
}

function ContractRow({ contract: c, selected, onClick }) {
  return (
    <div className={`cv-row ${selected ? 'cv-row--selected' : ''}`} onClick={() => onClick(c)}>
      <div className="cv-row-main">
        <div className="cv-row-title">{c.title}</div>
        <div className="cv-row-meta">
          <span className="cv-chip">{TYPE_LABELS[c.contractType] || c.contractType}</span>
          {c.dealName && <span className="cv-chip cv-chip--deal">📂 {c.dealName}</span>}
          {c.customerLegalName && <span className="cv-chip cv-chip--muted">{c.customerLegalName}</span>}
        </div>
      </div>
      <div className="cv-row-right">
        <Badge status={c.status} />
        {c.internalApprovalStatus && c.internalApprovalStatus !== 'not_started' && (
          <span className={`cv-appr cv-appr--${c.internalApprovalStatus}`}>
            {c.internalApprovalStatus === 'pending' ? 'Approval pending'
            : c.internalApprovalStatus === 'approved' ? 'Approved'
            : 'Approval rejected'}
          </span>
        )}
        {c.value && <span className="cv-value">{c.currency} {Number(c.value).toLocaleString()}</span>}
        <span className="cv-date">{new Date(c.updatedAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

export default function ContractsView() {
  const [activeTab, setActiveTab] = useState('mine');
  const [contracts, setContracts] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [selected, setSelected]   = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [isLegal, setIsLegal]     = useState(false);
  const [search, setSearch]       = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType]     = useState('');

  useEffect(() => {
    // Derive legal membership from user stored in localStorage — no extra API call needed.
    // Users with org_role 'legal', 'owner', or 'admin' get legal team access.
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const legalRoles = ['legal', 'owner', 'admin'];
    setIsLegal(legalRoles.includes(user.org_role) || user.is_legal_member === true);
  }, []);

  const TABS = [
    { id:'mine',     label:'My Contracts',        icon:'📋' },
    ...(isLegal ? [{ id:'legal_queue',    label:'Legal Queue',     icon:'⚖️' }] : []),
    ...(isLegal ? [{ id:'legal_assigned', label:'Assigned to Me',  icon:'📌' }] : []),
    { id:'pending',  label:'Pending My Approval', icon:'✅' },
    { id:'all',      label:'All Contracts',        icon:'🗂️' },
  ];

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      if (activeTab === 'legal_queue') {
        const r = await apiService.contracts.getLegalQueue();
        setContracts(r.data.contracts || []);
      } else if (activeTab === 'legal_assigned') {
        const r = await apiService.contracts.getLegalAssigned();
        setContracts(r.data.contracts || []);
      } else if (activeTab === 'pending') {
        const r = await apiService.contracts.getPendingApprovals();
        setContracts((r.data.approvals || []).map(a => ({
          id: a.contract_id, title: a.title, contractType: a.contract_type,
          status: a.contract_status, value: a.value, currency: a.currency,
          updatedAt: a.created_at, _isPending: true,
        })));
      } else {
        const scope = activeTab === 'all' ? 'org' : 'mine';
        const r = await apiService.contracts.getAll({ scope, status: filterStatus, contractType: filterType, search });
        setContracts(r.data.contracts || []);
      }
    } catch { setError('Failed to load contracts'); }
    finally { setLoading(false); }
  }, [activeTab, filterStatus, filterType, search]);

  useEffect(() => { load(); }, [load]);

  const openContract = async (c) => {
    try {
      const r = await apiService.contracts.getById(c.id);
      setSelected(r.data.contract);
    } catch { setSelected(c); }
  };

  const onUpdated = () => {
    load();
    if (selected) {
      apiService.contracts.getById(selected.id)
        .then(r => setSelected(r.data.contract))
        .catch(() => {});
    }
  };

  const filtered = contracts.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.title?.toLowerCase().includes(q) || c.customerLegalName?.toLowerCase().includes(q);
  });

  return (
    <div className="cv-wrap">
      {/* Left */}
      <div className="cv-left">
        <div className="cv-header">
          <h2 className="cv-title">Contracts</h2>
          <button className="cv-new-btn" onClick={() => setShowCreate(true)}>+ New</button>
        </div>

        <div className="cv-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`cv-tab ${activeTab===t.id?'cv-tab--active':''}`}
              onClick={() => { setActiveTab(t.id); setSelected(null); }}>
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>

        <div className="cv-filters">
          <input className="cv-search" placeholder="Search…" value={search}
            onChange={e => setSearch(e.target.value)} />
          <div className="cv-filter-row">
            <select className="cv-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="cv-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
              {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        <div className="cv-list">
          {loading && <div className="cv-loading"><div className="cv-spin" /></div>}
          {error && <div className="cv-error">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="cv-empty">
              No contracts found.
              {activeTab === 'mine' && (
                <button className="cv-link" onClick={() => setShowCreate(true)}>Create one</button>
              )}
            </div>
          )}
          {filtered.map(c => (
            <ContractRow key={c.id} contract={c} selected={selected?.id===c.id} onClick={openContract} />
          ))}
        </div>
      </div>

      {/* Right */}
      <div className={`cv-right ${selected ? 'cv-right--open' : ''}`}>
        {selected
          ? <ContractDetailPanel contract={selected} isLegalMember={isLegal}
              onClose={() => setSelected(null)} onUpdated={onUpdated} />
          : <div className="cv-empty-state"><div className="cv-empty-icon">📄</div>
              <div>Select a contract to view details</div></div>
        }
      </div>

      {showCreate && (
        <ContractCreateModal
          onClose={() => setShowCreate(false)}
          onSuccess={(c) => { setShowCreate(false); load(); setSelected(c); }}
        />
      )}
    </div>
  );
}
