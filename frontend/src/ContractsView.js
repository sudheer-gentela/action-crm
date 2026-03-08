// ContractsView.js — v2
// Chunk 2 additions:
//   • "Standalone" tab — shows contracts with no deal_id
//   • Bulk-select checkboxes on contract rows (all tabs except pending / legal detail tabs)
//   • Bulk toolbar: assign to legal team member + submit all
//   • v2 status labels: terminated, cancelled, amended, pending_booking
//   • ContractCreateModal opened in standalone mode when triggered from the Standalone tab

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import ContractDetailPanel from './ContractDetailPanel';
import ContractCreateModal from './ContractCreateModal';
import './ContractsView.css';

// ── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: '',                label: 'All statuses' },
  { value: 'draft',           label: 'Draft' },
  { value: 'in_legal_review', label: 'In Legal Review' },
  { value: 'with_sales',      label: 'With Sales' },
  { value: 'in_signatures',   label: 'In Signatures' },
  { value: 'pending_booking', label: 'Pending Booking' },
  { value: 'signed',          label: 'Signed' },
  { value: 'active',          label: 'Active' },
  { value: 'expired',         label: 'Expired' },
  { value: 'amended',         label: 'Amended' },
  { value: 'terminated',      label: 'Terminated' },
  { value: 'cancelled',       label: 'Cancelled' },
  { value: 'void',            label: 'Void' },
];

const TYPE_OPTIONS = [
  { value: '',           label: 'All types' },
  { value: 'nda',        label: 'NDA' },
  { value: 'msa',        label: 'MSA' },
  { value: 'sow',        label: 'SOW' },
  { value: 'order_form', label: 'Order Form' },
  { value: 'amendment',  label: 'Amendment' },
  { value: 'custom',     label: 'Custom' },
];

const STATUS_COLORS = {
  draft:           { bg: '#f1f5f9', text: '#475569' },
  in_legal_review: { bg: '#fef3c7', text: '#92400e' },
  with_sales:      { bg: '#dbeafe', text: '#1e40af' },
  in_signatures:   { bg: '#ede9fe', text: '#5b21b6' },
  pending_booking: { bg: '#fce7f3', text: '#9d174d' },
  signed:          { bg: '#dcfce7', text: '#14532d' },
  active:          { bg: '#d1fae5', text: '#065f46' },
  expired:         { bg: '#f3f4f6', text: '#6b7280' },
  amended:         { bg: '#fef9c3', text: '#713f12' },
  terminated:      { bg: '#fee2e2', text: '#7f1d1d' },
  cancelled:       { bg: '#f3f4f6', text: '#374151' },
  void:            { bg: '#fee2e2', text: '#991b1b' },
};

const TYPE_LABELS = {
  nda: 'NDA', msa: 'MSA', sow: 'SOW',
  order_form: 'Order Form', amendment: 'Amendment', custom: 'Custom',
};

// Tabs that support bulk selection
const BULK_ELIGIBLE_TABS = ['mine', 'all', 'standalone'];

// ── Sub-components ───────────────────────────────────────────────────────────

function Badge({ status }) {
  const col = STATUS_COLORS[status] || STATUS_COLORS.draft;
  const lbl = STATUS_OPTIONS.find(s => s.value === status)?.label || status;
  return (
    <span className="cv-badge" style={{ background: col.bg, color: col.text }}>{lbl}</span>
  );
}

function ContractRow({ contract: c, selected, onSelect, onOpen, bulkMode, checked }) {
  return (
    <div
      className={`cv-row ${selected ? 'cv-row--selected' : ''}`}
      onClick={() => onOpen(c)}
    >
      {/* Bulk checkbox */}
      {bulkMode && (
        <div className="cv-row-check" onClick={e => { e.stopPropagation(); onSelect(c.id); }}>
          <input
            type="checkbox"
            className="cv-checkbox"
            checked={!!checked}
            onChange={() => onSelect(c.id)}
          />
        </div>
      )}

      <div className="cv-row-main">
        <div className="cv-row-title">{c.title}</div>
        <div className="cv-row-meta">
          <span className="cv-chip">{TYPE_LABELS[c.contractType] || c.contractType}</span>
          {c.dealName
            ? <span className="cv-chip cv-chip--deal">📂 {c.dealName}</span>
            : <span className="cv-chip cv-chip--standalone">🔖 Standalone</span>
          }
          {c.customerLegalName && (
            <span className="cv-chip cv-chip--muted">{c.customerLegalName}</span>
          )}
        </div>
      </div>

      <div className="cv-row-right">
        <Badge status={c.status} />
        {c.internalApprovalStatus && c.internalApprovalStatus !== 'not_started' && (
          <span className={`cv-appr cv-appr--${c.internalApprovalStatus}`}>
            {c.internalApprovalStatus === 'pending'   ? 'Approval pending'
            : c.internalApprovalStatus === 'approved' ? 'Approved'
            : 'Approval rejected'}
          </span>
        )}
        {c.legalAssigneeName && (
          <span className="cv-chip cv-chip--legal" title="Legal assignee">
            ⚖️ {c.legalAssigneeName}
          </span>
        )}
        {c.value != null && (
          <span className="cv-value">{c.currency} {Number(c.value).toLocaleString()}</span>
        )}
        <span className="cv-date">{new Date(c.updatedAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

// ── Bulk toolbar ─────────────────────────────────────────────────────────────

function BulkToolbar({ selectedIds, legalMembers, onAssign, onClear, loading }) {
  const [assigneeId, setAssigneeId] = useState('');

  async function handleAssign() {
    if (selectedIds.length === 0) return;
    await onAssign(selectedIds, assigneeId ? parseInt(assigneeId, 10) : null);
    setAssigneeId('');
  }

  return (
    <div className="cv-bulk-bar">
      <span className="cv-bulk-count">{selectedIds.length} selected</span>

      <select className="cv-bulk-select" value={assigneeId}
        onChange={e => setAssigneeId(e.target.value)}>
        <option value="">Legal queue (unassigned)</option>
        {legalMembers.map(m => (
          <option key={m.id} value={m.id}>
            {m.first_name} {m.last_name}
          </option>
        ))}
      </select>

      <button className="cv-bulk-submit" onClick={handleAssign} disabled={loading}>
        {loading ? 'Submitting…' : `Submit ${selectedIds.length} to Legal`}
      </button>

      <button className="cv-bulk-clear" onClick={onClear}>✕ Clear</button>
    </div>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────

export default function ContractsView() {
  const [activeTab, setActiveTab]       = useState('mine');
  const [contracts, setContracts]       = useState([]);
  const [loading, setLoading]           = useState(false);
  const [bulkLoading, setBulkLoading]   = useState(false);
  const [error, setError]               = useState('');
  const [selected, setSelected]         = useState(null);
  const [showCreate, setShowCreate]     = useState(false);
  const [isLegal, setIsLegal]           = useState(false);
  const [legalMembers, setLegalMembers] = useState([]);
  const [search, setSearch]             = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType]     = useState('');

  // Bulk selection state
  const [bulkMode, setBulkMode]         = useState(false);
  const [checkedIds, setCheckedIds]     = useState(new Set());

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const legalRoles = ['legal', 'owner', 'admin'];
    const isLegalUser = legalRoles.includes(user.org_role) || user.is_legal_member === true;
    setIsLegal(isLegalUser);

    if (isLegalUser) {
      apiService.contracts.getLegalMembers()
        .then(r => setLegalMembers(r.data?.members || []))
        .catch(() => {});
    }
  }, []);

  const TABS = [
    { id: 'mine',          label: 'My Contracts',        icon: '📋' },
    { id: 'standalone',    label: 'Standalone',          icon: '🔖' },
    ...(isLegal ? [{ id: 'legal_queue',    label: 'Legal Queue',     icon: '⚖️' }] : []),
    ...(isLegal ? [{ id: 'legal_assigned', label: 'Assigned to Me',  icon: '📌' }] : []),
    { id: 'pending',       label: 'Pending My Approval', icon: '✅' },
    { id: 'all',           label: 'All Contracts',       icon: '🗂️' },
  ];

  const load = useCallback(async () => {
    setLoading(true); setError(''); setCheckedIds(new Set());
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
          id:           a.contract_id,
          title:        a.title,
          contractType: a.contract_type,
          status:       a.contract_status,
          value:        a.value,
          currency:     a.currency,
          updatedAt:    a.created_at,
          _isPending:   true,
        })));
      } else if (activeTab === 'standalone') {
        // Standalone = all org contracts without a deal_id
        const r = await apiService.contracts.getAll({
          scope: 'org', status: filterStatus, contractType: filterType, search,
        });
        setContracts((r.data.contracts || []).filter(c => !c.dealId));
      } else {
        const scope = activeTab === 'all' ? 'org' : 'mine';
        const r = await apiService.contracts.getAll({
          scope, status: filterStatus, contractType: filterType, search,
        });
        setContracts(r.data.contracts || []);
      }
    } catch (e) {
      const status = e.response?.status;
      if (status === 403) setError('You do not have access to the legal queue. Contact your org admin.');
      else setError('Failed to load contracts');
    } finally { setLoading(false); }
  }, [activeTab, filterStatus, filterType, search]);

  useEffect(() => { load(); }, [load]);

  // Turn off bulk mode when switching tabs
  useEffect(() => {
    setBulkMode(false);
    setCheckedIds(new Set());
  }, [activeTab]);

  const openContract = async (c) => {
    if (bulkMode) return; // clicks are handled by checkbox in bulk mode
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

  // Bulk selection handlers
  function toggleCheck(id) {
    setCheckedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (checkedIds.size === filtered.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(filtered.map(c => c.id)));
    }
  }

  async function handleBulkSubmit(ids, assigneeUserId) {
    setBulkLoading(true);
    try {
      const r = await apiService.contracts.bulkSubmitLegal(ids, assigneeUserId || undefined);
      const { summary } = r.data;
      const msg = `Submitted ${summary.succeeded}/${summary.total} contracts to legal${summary.failed > 0 ? ` (${summary.failed} failed)` : ''}.`;
      // Use a simple alert — replace with your toast system if available
      window.alert(msg);
      setBulkMode(false);
      setCheckedIds(new Set());
      load();
    } catch (e) {
      window.alert(e.response?.data?.error?.message || 'Bulk submit failed');
    } finally { setBulkLoading(false); }
  }

  // Client-side search filter (server already filters by status/type)
  const filtered = contracts.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.title?.toLowerCase().includes(q) ||
      c.customerLegalName?.toLowerCase().includes(q) ||
      c.dealName?.toLowerCase().includes(q)
    );
  });

  const showBulkBar  = bulkMode && checkedIds.size > 0;
  const canBulk      = BULK_ELIGIBLE_TABS.includes(activeTab);
  const allSelected  = filtered.length > 0 && checkedIds.size === filtered.length;

  return (
    <div className="cv-wrap">
      {/* ── Left panel ── */}
      <div className="cv-left">
        <div className="cv-header">
          <h2 className="cv-title">Contracts</h2>
          <div className="cv-header-btns">
            {canBulk && filtered.length > 0 && (
              <button
                className={`cv-bulk-toggle ${bulkMode ? 'cv-bulk-toggle--on' : ''}`}
                onClick={() => { setBulkMode(m => !m); setCheckedIds(new Set()); }}
                title="Toggle bulk selection">
                {bulkMode ? '✕ Exit Bulk' : '☑ Bulk'}
              </button>
            )}
            <button className="cv-new-btn" onClick={() => setShowCreate(true)}>+ New</button>
          </div>
        </div>

        {/* Bulk toolbar */}
        {showBulkBar && (
          <BulkToolbar
            selectedIds={[...checkedIds]}
            legalMembers={legalMembers}
            loading={bulkLoading}
            onAssign={handleBulkSubmit}
            onClear={() => { setBulkMode(false); setCheckedIds(new Set()); }}
          />
        )}

        <div className="cv-tabs">
          {TABS.map(t => (
            <button key={t.id}
              className={`cv-tab ${activeTab === t.id ? 'cv-tab--active' : ''}`}
              onClick={() => { setActiveTab(t.id); setSelected(null); }}>
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>

        <div className="cv-filters">
          <input className="cv-search" placeholder="Search…" value={search}
            onChange={e => setSearch(e.target.value)} />
          <div className="cv-filter-row">
            <select className="cv-select" value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}>
              {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="cv-select" value={filterType}
              onChange={e => setFilterType(e.target.value)}>
              {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {/* Select-all row when bulk mode is active */}
        {bulkMode && filtered.length > 0 && (
          <div className="cv-select-all">
            <label className="cv-check-all">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              {allSelected ? 'Deselect all' : `Select all (${filtered.length})`}
            </label>
          </div>
        )}

        <div className="cv-list">
          {loading && <div className="cv-loading"><div className="cv-spin" /></div>}
          {error && <div className="cv-error">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="cv-empty">
              {activeTab === 'standalone'
                ? 'No standalone contracts found.'
                : 'No contracts found.'}
              {(activeTab === 'mine' || activeTab === 'standalone') && (
                <button className="cv-link" onClick={() => setShowCreate(true)}>
                  Create one
                </button>
              )}
            </div>
          )}
          {filtered.map(c => (
            <ContractRow
              key={c.id}
              contract={c}
              selected={selected?.id === c.id}
              bulkMode={bulkMode}
              checked={checkedIds.has(c.id)}
              onSelect={toggleCheck}
              onOpen={openContract}
            />
          ))}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className={`cv-right ${selected ? 'cv-right--open' : ''}`}>
        {selected
          ? <ContractDetailPanel
              contract={selected}
              isLegalMember={isLegal}
              onClose={() => setSelected(null)}
              onUpdated={onUpdated}
            />
          : <div className="cv-empty-state">
              <div className="cv-empty-icon">📄</div>
              <div>Select a contract to view details</div>
            </div>
        }
      </div>

      {/* ── Create modal ── */}
      {showCreate && (
        <ContractCreateModal
          onClose={() => setShowCreate(false)}
          onSuccess={(c) => { setShowCreate(false); load(); setSelected(c); }}
          // If we're on the standalone tab, don't pre-fill any deal
          prefillDealId={activeTab === 'standalone' ? undefined : undefined}
        />
      )}

      <style>{`
        /* Bulk toggle button */
        .cv-header-btns{display:flex;gap:8px;align-items:center}
        .cv-bulk-toggle{padding:7px 13px;border-radius:7px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;font-size:12px;font-weight:600;cursor:pointer}
        .cv-bulk-toggle--on{background:#f1f5f9;border-color:#6366f1;color:#4f46e5}
        .cv-bulk-toggle:hover{background:#f1f5f9}

        /* Bulk toolbar */
        .cv-bulk-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;background:#eef2ff;border-bottom:1px solid #c7d2fe;flex-wrap:wrap}
        .cv-bulk-count{font-size:12px;font-weight:700;color:#4f46e5}
        .cv-bulk-select{padding:5px 8px;border:1.5px solid #c7d2fe;border-radius:7px;font-size:12px;background:#fff;font-family:inherit;outline:none}
        .cv-bulk-submit{padding:6px 14px;border-radius:7px;border:none;background:#6366f1;color:#fff;font-size:12px;font-weight:700;cursor:pointer}
        .cv-bulk-submit:hover:not(:disabled){background:#4f46e5}
        .cv-bulk-submit:disabled{opacity:.5;cursor:not-allowed}
        .cv-bulk-clear{padding:5px 10px;border-radius:7px;border:1px solid #c7d2fe;background:#fff;color:#64748b;font-size:12px;cursor:pointer;margin-left:auto}

        /* Select all row */
        .cv-select-all{padding:6px 14px;border-bottom:1px solid #f1f5f9;background:#f8fafc}
        .cv-check-all{display:flex;align-items:center;gap:7px;font-size:12px;color:#475569;cursor:pointer;user-select:none}
        .cv-check-all input{accent-color:#6366f1}

        /* Checkbox in row */
        .cv-row-check{padding-right:4px;display:flex;align-items:center}
        .cv-checkbox{width:15px;height:15px;accent-color:#6366f1;cursor:pointer}

        /* Standalone chip */
        .cv-chip--standalone{background:#f0fdf4;color:#065f46}
        .cv-chip--legal{background:#ede9fe;color:#5b21b6}
      `}</style>
    </div>
  );
}
