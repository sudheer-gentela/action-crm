// DealContractsPanel.js
// Drop into DealsView detail section: <DealContractsPanel deal={selectedDeal} />
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import ContractCreateModal from './ContractCreateModal';

const STATUS_COLORS = {
  draft:           { bg: '#f1f5f9', text: '#475569' },
  in_legal_review: { bg: '#fef3c7', text: '#92400e' },
  with_sales:      { bg: '#dbeafe', text: '#1e40af' },
  in_signatures:   { bg: '#ede9fe', text: '#5b21b6' },
  signed:          { bg: '#dcfce7', text: '#14532d' },
  active:          { bg: '#d1fae5', text: '#065f46' },
  expired:         { bg: '#f3f4f6', text: '#6b7280' },
  void:            { bg: '#fee2e2', text: '#991b1b' },
};

const TYPE_LABELS = {
  nda: 'NDA', msa: 'MSA', sow: 'SOW',
  order_form: 'Order Form', amendment: 'Amendment', custom: 'Custom',
};

export default function DealContractsPanel({ deal }) {
  const [contracts, setContracts] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    if (!deal?.id) return;
    setLoading(true);
    try {
      const r = await apiService.contracts.getAll({ dealId: deal.id, scope: 'org' });
      setContracts(r.data.contracts || []);
    } catch {
      setContracts([]);
    } finally {
      setLoading(false);
    }
  }, [deal?.id]);

  useEffect(() => { load(); }, [load]);

  function openContract(id) {
    // Open in the contracts tab — dispatch a custom event that App.js can listen to
    window.dispatchEvent(new CustomEvent('open-contract', { detail: { contractId: id } }));
  }

  if (!deal) return null;

  return (
    <div className="dcp-wrap">
      <div className="dcp-header">
        <span className="dcp-count">
          {contracts.length > 0 ? `${contracts.length} contract${contracts.length > 1 ? 's' : ''}` : 'No contracts'}
        </span>
        <button className="dcp-new-btn" onClick={() => setShowCreate(true)}>+ New</button>
      </div>

      {loading && <div className="dcp-loading"><div className="dcp-spin" /></div>}

      {!loading && contracts.length === 0 && (
        <div className="dcp-empty">
          No contracts linked to this deal.
          <button className="dcp-link" onClick={() => setShowCreate(true)}>Create one</button>
        </div>
      )}

      {!loading && contracts.map(c => {
        const sc = STATUS_COLORS[c.status] || STATUS_COLORS.draft;
        return (
          <div key={c.id} className="dcp-row" onClick={() => openContract(c.id)}>
            <div className="dcp-row-left">
              <div className="dcp-row-title">{c.title}</div>
              <div className="dcp-row-meta">
                <span className="dcp-chip">{TYPE_LABELS[c.contractType] || c.contractType}</span>
                {c.value && (
                  <span className="dcp-chip dcp-chip--value">
                    {c.currency} {Number(c.value).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
            <div className="dcp-row-right">
              <span className="dcp-badge" style={{ background: sc.bg, color: sc.text }}>
                {c.status.replace(/_/g, ' ')}
              </span>
              {c.internalApprovalStatus && c.internalApprovalStatus !== 'not_started' && (
                <span className={`dcp-appr dcp-appr--${c.internalApprovalStatus}`}>
                  {c.internalApprovalStatus === 'pending'   ? '⏳ Approval'
                   : c.internalApprovalStatus === 'approved' ? '✅ Approved'
                   : '❌ Rejected'}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {showCreate && (
        <ContractCreateModal
          prefillDealId={deal.id}
          onClose={() => setShowCreate(false)}
          onSuccess={() => { setShowCreate(false); load(); }}
        />
      )}

      <style>{`
        .dcp-wrap { display:flex; flex-direction:column; gap:5px; }
        .dcp-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
        .dcp-count { font-size:12px; color:#64748b; font-weight:500; }
        .dcp-new-btn { padding:4px 11px; border-radius:7px; border:none; background:#6366f1; color:#fff; font-size:12px; font-weight:600; cursor:pointer; }
        .dcp-new-btn:hover { background:#4f46e5; }
        .dcp-loading { display:flex; justify-content:center; padding:14px; }
        .dcp-spin { width:16px; height:16px; border:2px solid #e5e7eb; border-top-color:#6366f1; border-radius:50%; animation:dcp-s .6s linear infinite; }
        @keyframes dcp-s { to { transform:rotate(360deg); } }
        .dcp-empty { font-size:12px; color:#94a3b8; display:flex; flex-direction:column; align-items:flex-start; gap:5px; padding:8px 0; }
        .dcp-link { background:none; border:none; color:#6366f1; font-size:12px; font-weight:600; cursor:pointer; padding:0; }
        .dcp-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 10px; border:1.5px solid #e2e8f0; border-radius:9px; cursor:pointer; transition:background .1s; background:#fff; }
        .dcp-row:hover { background:#f8fafc; border-color:#c7d2fe; }
        .dcp-row-left { flex:1; min-width:0; }
        .dcp-row-title { font-size:13px; font-weight:600; color:#0f172a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:3px; }
        .dcp-row-meta { display:flex; gap:5px; flex-wrap:wrap; }
        .dcp-chip { font-size:10px; font-weight:600; background:#f1f5f9; color:#64748b; padding:1px 6px; border-radius:4px; }
        .dcp-chip--value { background:#eef2ff; color:#4f46e5; }
        .dcp-row-right { display:flex; flex-direction:column; align-items:flex-end; gap:3px; flex-shrink:0; }
        .dcp-badge { font-size:10px; font-weight:700; padding:2px 8px; border-radius:8px; white-space:nowrap; text-transform:capitalize; }
        .dcp-appr { font-size:10px; font-weight:600; }
        .dcp-appr--pending  { color:#92400e; }
        .dcp-appr--approved { color:#065f46; }
        .dcp-appr--rejected { color:#991b1b; }
      `}</style>
    </div>
  );
}
