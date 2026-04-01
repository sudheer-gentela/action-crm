/**
 * DealsView.js — DROP-IN REPLACEMENT
 *
 * CHANGES from original:
 *   1. Import: DealStrapPanel → StrapPanel
 *   2. Usage: <DealStrapPanel deal={selectedDeal} /> → <StrapPanel entityType="deal" entityId={selectedDeal.id} />
 *
 * Everything else is IDENTICAL.
 */

import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { enrichData } from './mockData';
import DealForm from './DealForm';
import AIAnalyzeButton from './AIAnalyzeButton';
import TranscriptUpload from './TranscriptUpload';
import TranscriptAnalysis from './TranscriptAnalysis';
import DealActionsPanel from './DealActionsPanel';
import StrapPanel from './StrapPanel';               // ← CHANGED: was DealStrapPanel
import DealTeamPanel from './DealTeamPanel';
import DealPlaysPanel from './DealPlaysPanel';
import DealProductsPanel from './DealProductsPanel';
import DealContactsPanel from './DealContactsPanel';
import DealEmailHistory from './DealEmailHistory';
import DealFilesPanel from './DealFilesPanel';
import { csvExport, EXPORT_COLUMNS } from './csvUtils';
import CSVImportModal from './CSVImportModal';
import ContractCreateModal from './ContractCreateModal';
import ContractDetailPanel from './ContractDetailPanel';
import './DealsView.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

const FALLBACK_STAGES = [
  { key: 'qualified',   name: 'Qualified',   is_terminal: false },
  { key: 'demo',        name: 'Demo',        is_terminal: false },
  { key: 'proposal',    name: 'Proposal',    is_terminal: false },
  { key: 'negotiation', name: 'Negotiation', is_terminal: false },
  { key: 'closed_won',  name: 'Closed Won',  is_terminal: true  },
];

function DealsView({ openDealId = null, onDealOpened = null }) {
  const [deals, setDeals]             = useState([]);
  const [accounts, setAccounts]       = useState([]);
  const [meetings, setMeetings]       = useState([]);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [editingDeal, setEditingDeal] = useState(null);
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [error, setError]             = useState('');
  const [showTranscriptUpload, setShowTranscriptUpload] = useState(false);
  const [viewingTranscriptId, setViewingTranscriptId]   = useState(null);
  const [scoringDealId, setScoringDealId] = useState(null);
  const [editingField, setEditingField]   = useState(null);
  const [savingField, setSavingField]     = useState(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showContractModal, setShowContractModal] = useState(false);
  const [dealContracts, setDealContracts]         = useState([]);
  const [dealContractsLoading, setDealContractsLoading] = useState(false);
  const [selectedContract, setSelectedContract]   = useState(null);

  // Derive isLegalMember from the stored user object — same pattern as apiService.js line 528
  const currentUser    = JSON.parse(localStorage.getItem('user') || '{}');
  const isLegalMember  = currentUser.department === 'legal' || currentUser.role === 'legal';
  const [orgStages, setOrgStages] = useState(FALLBACK_STAGES);
  const [playbookGuide, setPlaybookGuide]   = useState(null);
  const [guideExpanded, setGuideExpanded]   = useState(false);
  const [guideLoading, setGuideLoading]     = useState(false);
  const [orgPlaybooks, setOrgPlaybooks]     = useState([]);
  const [scope, setScope] = useState('mine');
  const [hasTeam, setHasTeam] = useState(false);

  useEffect(() => { apiService.playbooks.getAll().then(r => setOrgPlaybooks(r.data.playbooks || [])).catch(() => {}); }, []);

  useEffect(() => {
    if (!selectedDeal?.id) { setPlaybookGuide(null); return; }
    setGuideLoading(true); setGuideExpanded(false);
    apiService.deals.getPlaybookGuide(selectedDeal.id)
      .then(r => setPlaybookGuide(r.data.guide || null))
      .catch(() => setPlaybookGuide(null))
      .finally(() => setGuideLoading(false));
  }, [selectedDeal?.id, selectedDeal?.stage]);

  // Load contracts linked to this deal whenever the selected deal changes
  useEffect(() => {
    if (!selectedDeal?.id) { setDealContracts([]); return; }
    setDealContractsLoading(true);
    apiService.contracts.getAll({ dealId: selectedDeal.id })
      .then(r => setDealContracts(r.data?.contracts || r.data || []))
      .catch(() => setDealContracts([]))
      .finally(() => setDealContractsLoading(false));
  }, [selectedDeal?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { apiService.orgAdmin.getMyTeam().then(r => setHasTeam(r.data.hasTeam)).catch(() => setHasTeam(false)); }, []);

  useEffect(() => {
    const token = localStorage.getItem('token') || localStorage.getItem('authToken');
    fetch(`${API_BASE}/pipeline-stages/sales`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(data => { if (data.stages?.length) setOrgStages(data.stages.map(s => ({ key: s.key, name: s.name, is_terminal: s.is_terminal, sort_order: s.sort_order }))); })
      .catch(() => console.warn('DealsView: could not load org stages, using defaults'));
  }, []);

  useEffect(() => { fetchDeals(); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!openDealId || deals.length === 0) return;
    const target = deals.find(d => d.id === openDealId || d.id === parseInt(openDealId));
    if (target) { setSelectedDeal(target); if (onDealOpened) onDealOpened(); }
  }, [openDealId, deals]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchDeals = async () => {
    try {
      setLoading(true); setError('');
      const [dealsRes, accountsRes, meetingsRes] = await Promise.all([
        apiService.deals.getAll(scope), apiService.accounts.getAll(scope), apiService.meetings.getAll()
      ]);
      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        deals: dealsRes.data.deals || dealsRes.data || [],
        contacts: [], meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        emails: [], actions: []
      });
      setDeals(enrichedData.deals); setAccounts(enrichedData.accounts); setMeetings(enrichedData.meetings);
    } catch (err) { console.error('Error fetching deals:', err); setError(`Failed to load deals: ${err.message}`); }
    finally { setLoading(false); }
  };

  const handleCreateDeal = async (dealData) => {
    try {
      const response = await apiService.deals.create(dealData);
      const newDeal = response.data.deal || response.data;
      const account = accounts.find(a => a.id === newDeal.account_id);
      setDeals([...deals, { ...newDeal, account }]); setShowForm(false); setError('');
    } catch (err) {
      console.error('Error creating deal:', err);
      const newDeal = { ...dealData, id: Date.now(), account: accounts.find(a => a.id === dealData.account_id) };
      setDeals([...deals, newDeal]); setShowForm(false);
    }
  };

  const handleUpdateDeal = async (dealData) => {
    try {
      const response = await apiService.deals.update(editingDeal.id, dealData);
      const updatedDeal = response.data.deal || response.data;
      const account = accounts.find(a => a.id === updatedDeal.account_id);
      setDeals(deals.map(d => d.id === editingDeal.id ? { ...updatedDeal, account } : d));
      setEditingDeal(null); setError('');
    } catch (err) {
      console.error('Error updating deal:', err);
      const account = accounts.find(a => a.id === dealData.account_id);
      setDeals(deals.map(d => d.id === editingDeal.id ? { ...d, ...dealData, account } : d)); setEditingDeal(null);
    }
  };

  const handleDeleteDeal = async (dealId) => {
    if (!window.confirm('Are you sure you want to delete this deal?')) return;
    try {
      await apiService.deals.delete(dealId);
      setDeals(deals.filter(d => d.id !== dealId));
      if (selectedDeal?.id === dealId) setSelectedDeal(null); setError('');
    } catch (err) {
      console.error('Error deleting deal:', err);
      setDeals(deals.filter(d => d.id !== dealId));
      if (selectedDeal?.id === dealId) setSelectedDeal(null);
    }
  };

  const handleScoreDeal = async (dealId) => {
    try {
      setScoringDealId(dealId);
      const response = await apiService.health.scoreDeal(dealId);
      const { score, health, breakdown } = response.data.result;
      const update = { health, health_score: score, health_score_breakdown: breakdown, health_score_updated_at: new Date().toISOString() };
      setDeals(deals.map(d => d.id === dealId ? { ...d, ...update } : d));
      if (selectedDeal?.id === dealId) setSelectedDeal(prev => ({ ...prev, ...update }));
    } catch (err) { console.error('Score deal error:', err); }
    finally { setScoringDealId(null); }
  };

  const handleExportCSV = () => { csvExport(deals, EXPORT_COLUMNS.deals, `deals-${scope}-${new Date().toISOString().slice(0,10)}.csv`); };
  const handleImportDeals = async (rows) => { const response = await apiService.deals.bulk(rows); const result = response.data; if (result.imported > 0) fetchDeals(); return result; };

  const handleInlineFieldSave = async (field, value) => {
    if (!selectedDeal) return;
    setSavingField(field);
    try {
      const payload = { [field]: value };
      if (field === 'value') payload.value = parseFloat(value);
      if (field === 'probability') payload.probability = parseInt(value);
      if (field === 'account_id') payload.account_id = parseInt(value);
      if (field === 'playbook_id') payload.playbookId = value ? parseInt(value) : null;
      const response = await apiService.deals.update(selectedDeal.id, payload);
      const updated = response.data.deal || response.data;
      const account = accounts.find(a => a.id === (updated.account_id || payload.account_id));
      const enriched = { ...selectedDeal, ...updated, account };
      setDeals(prev => prev.map(d => d.id === selectedDeal.id ? enriched : d));
      setSelectedDeal(enriched);
    } catch (err) { console.error('Inline save error:', err); }
    finally { setSavingField(null); setEditingField(null); }
  };

  const getDealMeetings = (dealId) => meetings.filter(m => m.deal_id === dealId);

  const pipelineStages = orgStages.filter(s => !s.is_terminal);
  const terminalStages = orgStages.filter(s => s.is_terminal);
  const allBoardStages = [...pipelineStages, ...terminalStages.slice(0, 1)];

  const groupedDeals = {};
  orgStages.forEach(s => { groupedDeals[s.key] = deals.filter(d => d.stage === s.key); });
  const knownKeys = new Set(orgStages.map(s => s.key));
  const unknownDeals = deals.filter(d => !knownKeys.has(d.stage));

  if (loading) {
    return (<div className="deals-view"><div className="loading-state"><div className="loading-spinner"></div><p>Loading deals...</p></div></div>);
  }

  return (
    <div className="deals-view">
      {/* Header */}
      <div className="deals-header">
        <div>
          <h1>Deal Pipeline</h1>
          <p className="deals-subtitle">
            {deals.length} active opportunit{deals.length !== 1 ? 'ies' : 'y'}
            {scope !== 'mine' && <span style={{ color: '#6366f1', fontWeight: 600 }}> · {scope === 'team' ? 'Team' : 'All Org'}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {hasTeam && (
            <div style={{ display: 'inline-flex', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e4ea', fontSize: '13px' }}>
              {['mine', 'team', 'org'].map(s => (
                <button key={s} onClick={() => setScope(s)} style={{ padding: '6px 14px', border: 'none', cursor: 'pointer', background: scope === s ? '#4f46e5' : '#fff', color: scope === s ? '#fff' : '#4b5563', fontWeight: scope === s ? 600 : 400, transition: 'all 0.15s' }}>
                  {s === 'mine' ? 'My Deals' : s === 'team' ? 'My Team' : 'All Org'}
                </button>
              ))}
            </div>
          )}
          <button className="btn-primary" onClick={() => setShowForm(true)}>+ New Deal</button>
          <button onClick={handleExportCSV} title="Export CSV" style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer' }}>Export</button>
          <button onClick={() => setShowImportModal(true)} title="Import CSV" style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer' }}>Import</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Pipeline Stats */}
      <div className="pipeline-stats">
        <div className="stat-card"><div className="stat-value">{deals.length}</div><div className="stat-label">Active Deals</div></div>
        <div className="stat-card"><div className="stat-value">${deals.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0).toLocaleString()}</div><div className="stat-label">Total Pipeline</div></div>
        <div className="stat-card"><div className="stat-value">{deals.length > 0 ? Math.round(deals.reduce((sum, d) => sum + (d.probability || 0), 0) / deals.length) : 0}%</div><div className="stat-label">Avg Probability</div></div>
      </div>

      {/* Deals Container */}
      <div className={`deals-container ${selectedDeal ? 'with-panel' : ''}`}>
        {/* Pipeline Board */}
        <div className="pipeline-board">
          {allBoardStages.map(stage => (
            <div key={stage.key} className="pipeline-stage">
              <div className="stage-header"><h3>{stage.name}</h3><span className="stage-count">{(groupedDeals[stage.key] || []).length}</span></div>
              <div className="stage-content">
                {(groupedDeals[stage.key] || []).length === 0 ? (
                  <div className="empty-stage">No deals</div>
                ) : (groupedDeals[stage.key] || []).map(deal => (
                  <DealCard key={deal.id} deal={deal} onEdit={() => setEditingDeal(deal)} onDelete={() => handleDeleteDeal(deal.id)} onSelect={() => setSelectedDeal(deal)} isSelected={selectedDeal?.id === deal.id} />
                ))}
              </div>
            </div>
          ))}
          {unknownDeals.length > 0 && (
            <div className="pipeline-stage">
              <div className="stage-header"><h3>Other</h3><span className="stage-count">{unknownDeals.length}</span></div>
              <div className="stage-content">
                {unknownDeals.map(deal => (<DealCard key={deal.id} deal={deal} onEdit={() => setEditingDeal(deal)} onDelete={() => handleDeleteDeal(deal.id)} onSelect={() => setSelectedDeal(deal)} isSelected={selectedDeal?.id === deal.id} />))}
              </div>
            </div>
          )}
        </div>

        {/* Deal Detail Panel */}
        {selectedDeal && (
          <div className="deal-detail-panel panel-fullscreen">
            <div className="panel-header">
              <h2>{selectedDeal.name}</h2>
              <div className="panel-header-actions"><button className="close-panel" onClick={() => setSelectedDeal(null)}>&times;</button></div>
            </div>
            <div className="panel-content">
              {/* 1. Deal Information */}
              <div className="detail-section">
                <div className="detail-section-header">
                  <h3>Deal Information</h3>
                  <div className="detail-section-actions"><AIAnalyzeButton type="deal" id={selectedDeal.id} onSuccess={() => alert('AI analysis complete! Check Actions below.')} /></div>
                </div>
                <div className="detail-grid">
                  {/* Value */}
                  <div className="detail-item">
                    <span className="detail-label">Value</span>
                    {editingField?.field === 'value' ? (
                      <div className="inline-edit-row">
                        <input className="inline-edit-input" type="number" autoFocus value={editingField.value} onChange={e => setEditingField(f => ({ ...f, value: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') handleInlineFieldSave('value', editingField.value); if (e.key === 'Escape') setEditingField(null); }} />
                        <button className="inline-save-btn" disabled={savingField === 'value'} onClick={() => handleInlineFieldSave('value', editingField.value)}>&#10003;</button>
                        <button className="inline-cancel-btn" onClick={() => setEditingField(null)}>&#10005;</button>
                      </div>
                    ) : (<span className="detail-value-large detail-value--editable" onClick={() => setEditingField({ field: 'value', value: selectedDeal.value || '' })} title="Click to edit">${parseFloat(selectedDeal.value || 0).toLocaleString()}</span>)}
                  </div>
                  {/* Stage */}
                  <div className="detail-item">
                    <span className="detail-label">Stage</span>
                    {editingField?.field === 'stage' ? (
                      <select className="inline-edit-select" autoFocus value={editingField.value} onChange={e => handleInlineFieldSave('stage', e.target.value)} onBlur={() => setEditingField(null)} onKeyDown={e => e.key === 'Escape' && setEditingField(null)}>
                        {orgStages.map(s => (<option key={s.key} value={s.key}>{s.name}</option>))}
                      </select>
                    ) : (<span className="detail-badge stage-badge detail-value--editable" onClick={() => setEditingField({ field: 'stage', value: selectedDeal.stage })} title="Click to edit">{orgStages.find(s => s.key === selectedDeal.stage)?.name || selectedDeal.stage}</span>)}
                  </div>
                  {/* Probability */}
                  <div className="detail-item">
                    <span className="detail-label">Probability</span>
                    {editingField?.field === 'probability' ? (
                      <div className="inline-edit-row">
                        <input className="inline-edit-input" type="number" min="0" max="100" autoFocus value={editingField.value} onChange={e => setEditingField(f => ({ ...f, value: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') handleInlineFieldSave('probability', editingField.value); if (e.key === 'Escape') setEditingField(null); }} />
                        <button className="inline-save-btn" disabled={savingField === 'probability'} onClick={() => handleInlineFieldSave('probability', editingField.value)}>&#10003;</button>
                        <button className="inline-cancel-btn" onClick={() => setEditingField(null)}>&#10005;</button>
                      </div>
                    ) : (<span className="detail-value--editable" onClick={() => setEditingField({ field: 'probability', value: selectedDeal.probability || 50 })} title="Click to edit">{selectedDeal.probability || 50}%</span>)}
                  </div>
                  {/* Health */}
                  <div className="detail-item">
                    <span className="detail-label">Health</span>
                    <div className="health-rescore-row">
                      <span className={`detail-badge health-${selectedDeal.health}`}>
                        {selectedDeal.health === 'healthy' && 'Healthy'}{selectedDeal.health === 'watch' && 'Watch'}{selectedDeal.health === 'risk' && 'At Risk'}
                      </span>
                      <button className="rescore-btn" onClick={() => handleScoreDeal(selectedDeal.id)} disabled={scoringDealId === selectedDeal.id} title="Re-score deal health">
                        {scoringDealId === selectedDeal.id ? 'Scoring...' : 'ReScore'}
                      </button>
                    </div>
                  </div>
                  {/* Expected Close Date */}
                  <div className="detail-item">
                    <span className="detail-label">Expected Close</span>
                    {editingField?.field === 'expected_close_date' ? (
                      <div className="inline-edit-row">
                        <input className="inline-edit-input" type="date" autoFocus value={editingField.value} onChange={e => setEditingField(f => ({ ...f, value: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') handleInlineFieldSave('expected_close_date', editingField.value); if (e.key === 'Escape') setEditingField(null); }} />
                        <button className="inline-save-btn" disabled={savingField === 'expected_close_date'} onClick={() => handleInlineFieldSave('expected_close_date', editingField.value)}>&#10003;</button>
                        <button className="inline-cancel-btn" onClick={() => setEditingField(null)}>&#10005;</button>
                      </div>
                    ) : (<span className="detail-value--editable" onClick={() => setEditingField({ field: 'expected_close_date', value: selectedDeal.expected_close_date ? selectedDeal.expected_close_date.split('T')[0] : '' })} title="Click to edit">{selectedDeal.expected_close_date ? new Date(selectedDeal.expected_close_date).toLocaleDateString() : 'Not set'}</span>)}
                  </div>
                  {/* Account */}
                  <div className="detail-item">
                    <span className="detail-label">Account</span>
                    {editingField?.field === 'account_id' ? (
                      <select className="inline-edit-select" autoFocus value={editingField.value} onChange={e => handleInlineFieldSave('account_id', e.target.value)} onBlur={() => setEditingField(null)} onKeyDown={e => e.key === 'Escape' && setEditingField(null)}>
                        {accounts.map(a => (<option key={a.id} value={a.id}>{a.name}</option>))}
                      </select>
                    ) : selectedDeal.account ? (
                      <div className="account-edit-row">
                        <span className="detail-value--link" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'accounts', accountId: selectedDeal.account_id } }))} title="Open account">{selectedDeal.account.name} &rarr;</span>
                        <button className="inline-edit-trigger" onClick={() => setEditingField({ field: 'account_id', value: selectedDeal.account_id })} title="Change account">change</button>
                      </div>
                    ) : (<span className="detail-value--editable" onClick={() => setEditingField({ field: 'account_id', value: '' })}>Not set</span>)}
                  </div>
                  {/* Playbook */}
                  <div className="detail-item">
                    <span className="detail-label">Playbook</span>
                    {editingField?.field === 'playbook_id' ? (
                      <select className="inline-edit-select" autoFocus value={editingField.value || ''} onChange={async (e) => { const pbId = e.target.value ? parseInt(e.target.value) : null; setEditingField(null); await handleInlineFieldSave('playbook_id', pbId); }} onBlur={() => setEditingField(null)} onKeyDown={e => e.key === 'Escape' && setEditingField(null)}>
                        <option value="">None</option>
                        {orgPlaybooks.map(pb => (<option key={pb.id} value={pb.id}>{pb.name}{pb.is_default ? ' (default)' : ''}</option>))}
                      </select>
                    ) : (<span className="detail-value--editable" onClick={() => setEditingField({ field: 'playbook_id', value: selectedDeal.playbook_id || '' })} title="Click to change playbook">{playbookGuide?.playbook?.name || (selectedDeal.playbook_id ? `Playbook #${selectedDeal.playbook_id}` : 'Not set')}</span>)}
                  </div>
                </div>
              </div>

              {/* 1b. Playbook Guide (unchanged) */}
              {!guideLoading && playbookGuide && (
                <div className="detail-section" style={{ background: '#f0f7ff', border: '1px solid #bee3f8', borderRadius: 10, padding: 0, overflow: 'hidden' }}>
                  <div onClick={() => setGuideExpanded(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', cursor: 'pointer', userSelect: 'none' }}>
                    <span style={{ fontSize: 18 }}>Playbook</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#2b6cb0' }}>{playbookGuide.playbook.name}<span style={{ fontWeight: 400, color: '#4a7ab5', marginLeft: 8 }}> &mdash; {orgStages.find(s => s.key === playbookGuide.stage)?.name || playbookGuide.stage}</span></div>
                      {playbookGuide.guidance?.goal && (<div style={{ fontSize: 13, color: '#3a6fa0', marginTop: 2, whiteSpace: guideExpanded ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{playbookGuide.guidance.goal}</div>)}
                    </div>
                    <span style={{ color: '#4a7ab5', fontSize: 12 }}>{guideExpanded ? '\u25B2' : '\u25BC'}</span>
                  </div>
                  {guideExpanded && playbookGuide.guidance && (
                    <div style={{ padding: '0 16px 16px', borderTop: '1px solid #bee3f8' }}>
                      {Array.isArray(playbookGuide.guidance.key_actions) && playbookGuide.guidance.key_actions.length > 0 && (
                        <div style={{ marginTop: 12 }}><div style={{ fontSize: 12, fontWeight: 600, color: '#2b6cb0', marginBottom: 6 }}>Key Actions</div>
                          {playbookGuide.guidance.key_actions.map((a, i) => (<div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 13, color: '#2d4a6f' }}><span style={{ color: '#4a7ab5' }}>&bull;</span><span>{a}</span></div>))}
                        </div>
                      )}
                      {Array.isArray(playbookGuide.guidance.success_criteria) && playbookGuide.guidance.success_criteria.length > 0 && (
                        <div style={{ marginTop: 12 }}><div style={{ fontSize: 12, fontWeight: 600, color: '#2b6cb0', marginBottom: 6 }}>Success Criteria</div>
                          {playbookGuide.guidance.success_criteria.map((c, i) => (<div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 13, color: '#2d4a6f' }}><span style={{ color: '#38a169' }}>&check;</span><span>{c}</span></div>))}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
                        {playbookGuide.guidance.timeline && (<div style={{ fontSize: 13 }}><span style={{ fontWeight: 600, color: '#2b6cb0' }}>Timeline: </span><span style={{ color: '#2d4a6f' }}>{playbookGuide.guidance.timeline}</span></div>)}
                        {playbookGuide.guidance.next_step && (<div style={{ fontSize: 13 }}><span style={{ fontWeight: 600, color: '#2b6cb0' }}>Next: </span><span style={{ color: '#2d4a6f' }}>{playbookGuide.guidance.next_step}</span></div>)}
                      </div>
                    </div>
                  )}
                  {guideExpanded && !playbookGuide.guidance && (<div style={{ padding: '8px 16px 16px', color: '#718096', fontSize: 13, borderTop: '1px solid #bee3f8' }}>No stage guidance configured for this stage yet.</div>)}
                </div>
              )}

              {!guideLoading && !playbookGuide && selectedDeal && (
                <div className="detail-section" style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, color: '#718096' }}>
                    No playbook assigned &mdash;
                    {orgPlaybooks.length > 0 ? (
                      <select style={{ marginLeft: 6, fontSize: 13, border: '1px solid #cbd5e0', borderRadius: 6, padding: '4px 8px', color: '#4a5568' }} value="" onChange={async (e) => { const pbId = parseInt(e.target.value); if (!pbId) return; try { await apiService.deals.update(selectedDeal.id, { playbookId: pbId }); const enriched = { ...selectedDeal, playbook_id: pbId }; setDeals(prev => prev.map(d => d.id === selectedDeal.id ? enriched : d)); setSelectedDeal(enriched); } catch {} }}>
                        <option value="">assign one</option>
                        {orgPlaybooks.map(pb => (<option key={pb.id} value={pb.id}>{pb.name}{pb.is_default ? ' (default)' : ''}</option>))}
                      </select>
                    ) : ' ask an org admin to create a playbook.'}
                  </span>
                </div>
              )}

              {/* ══════════════════════════════════════════════════
                  2. STRAP — CHANGED: StrapPanel with entityType
                  ══════════════════════════════════════════════════ */}
              <div className="detail-section">
                <h3>STRAP &mdash; Strategy &amp; Action Plan</h3>
                <StrapPanel entityType="deal" entityId={selectedDeal.id} />
              </div>

              {/* ══════════════════════════════════════════════════
                  2b. PLAYS — Role-based playbook plays
                  ══════════════════════════════════════════════════ */}
              <div className="detail-section">
                <h3>Plays &mdash; Playbook Execution</h3>
                <DealPlaysPanel deal={selectedDeal} stageKey={selectedDeal.stage} />
              </div>

              {/* 3. Actions */}
              <div className="detail-section"><h3>Products &amp; Line Items</h3><DealProductsPanel deal={selectedDeal} /></div>

              {/* 4. Actions */}
              <div className="detail-section"><h3>Actions &amp; Tasks</h3><DealActionsPanel deal={selectedDeal} /></div>

              {/* 4. Email History */}
              <div className="detail-section"><h3>Email History</h3><DealEmailHistory deal={selectedDeal} /></div>

              {/* 5. Meeting History */}
              <div className="detail-section">
                <h3>Meeting History ({getDealMeetings(selectedDeal.id).length})</h3>
                {getDealMeetings(selectedDeal.id).length === 0 ? (
                  <p className="empty-message">No meetings recorded for this deal</p>
                ) : (<div className="linked-items-list">
                  {getDealMeetings(selectedDeal.id).map(meeting => (
                    <div key={meeting.id} className="linked-item linked-item--clickable" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'calendar', meetingId: meeting.id } }))} title="View in Calendar">
                      <span className="item-icon">cal</span>
                      <div className="item-info"><div className="item-name">{meeting.title}</div><div className="item-meta">{new Date(meeting.start_time).toLocaleString()} &middot; {meeting.status}</div></div>
                      <span className="item-arrow">&rarr;</span>
                    </div>
                  ))}
                </div>)}
              </div>

              {/* 6-9: Deal Team, Contacts, Files, Modify, Notes */}
              {/* 6. Contracts */}
              <div className="detail-section">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ margin: 0 }}>
                    Contracts {dealContracts.length > 0 && `(${dealContracts.length})`}
                  </h3>
                  <button
                    onClick={() => setShowContractModal(true)}
                    style={{ padding: '5px 13px', borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    + Create Contract
                  </button>
                </div>
                {dealContractsLoading ? (
                  <p className="empty-message">Loading contracts…</p>
                ) : dealContracts.length === 0 ? (
                  <p className="empty-message">No contracts yet for this deal.</p>
                ) : (
                  <div className="linked-items-list">
                    {dealContracts.map(contract => {
                      const STATUS_COLORS = {
                        draft: { bg: '#f1f5f9', text: '#475569' },
                        in_review: { bg: '#fef3c7', text: '#92400e' },
                        in_signatures: { bg: '#ede9fe', text: '#5b21b6' },
                        pending_booking: { bg: '#fce7f3', text: '#9d174d' },
                        signed: { bg: '#dcfce7', text: '#14532d' },
                        active: { bg: '#d1fae5', text: '#065f46' },
                        expired: { bg: '#f3f4f6', text: '#6b7280' },
                        terminated: { bg: '#fee2e2', text: '#7f1d1d' },
                        cancelled: { bg: '#f3f4f6', text: '#374151' },
                        void: { bg: '#fee2e2', text: '#991b1b' },
                        amended: { bg: '#fef9c3', text: '#713f12' },
                      };
                      const sc = STATUS_COLORS[contract.status] || STATUS_COLORS.draft;
                      const subLabel = contract.status === 'in_review' && contract.review_sub_status
                        ? ` · ${contract.review_sub_status.replace('_', ' ')}`
                        : '';
                      return (
                        <div key={contract.id} className="linked-item linked-item--clickable"
                          onClick={() => setSelectedContract(contract)}>
                          <span style={{ fontSize: 16 }}>📄</span>
                          <div className="item-info">
                            <div className="item-name">{contract.title}</div>
                            <div className="item-meta">
                              {contract.contract_type?.toUpperCase()}
                              {contract.value ? ` · $${Number(contract.value).toLocaleString()}` : ''}
                            </div>
                          </div>
                          <span style={{
                            fontSize: 11, fontWeight: 600, padding: '2px 8px',
                            borderRadius: 8, background: sc.bg, color: sc.text,
                            whiteSpace: 'nowrap', flexShrink: 0,
                          }}>
                            {contract.status.replace('_', ' ')}{subLabel}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 7-10: Deal Team, Contacts, Files, Modify, Notes */}
              <div className="detail-section"><h3>Deal Team</h3><DealTeamPanel deal={selectedDeal} /></div>
              <div className="detail-section"><h3>Contacts</h3><DealContactsPanel deal={selectedDeal} /></div>
              <div className="detail-section"><h3>Files</h3><DealFilesPanel deal={selectedDeal} /></div>
              <div className="detail-section">
                <h3>Modify Deal Details</h3>
                <div className="quick-actions">
                  <button className="btn-action" onClick={() => setEditingDeal(selectedDeal)}>Edit Deal</button>
                  <button className="btn-action btn-action--danger" onClick={() => handleDeleteDeal(selectedDeal.id)}>Delete Deal</button>
                  <button className="btn-action" onClick={() => setShowTranscriptUpload(true)}>Upload Transcript</button>
                </div>
              </div>
              {selectedDeal.notes && (<div className="detail-section"><h3>Notes</h3><p className="deal-notes-text">{selectedDeal.notes}</p></div>)}
            </div>
          </div>
        )}
      </div>

      {(showForm || editingDeal) && (<DealForm deal={editingDeal} accounts={accounts} onSubmit={editingDeal ? handleUpdateDeal : handleCreateDeal} onClose={() => { setShowForm(false); setEditingDeal(null); }} />)}
      {showTranscriptUpload && (<TranscriptUpload dealId={selectedDeal?.id} onSuccess={(result) => { setShowTranscriptUpload(false); setViewingTranscriptId(result.transcriptId); }} onClose={() => setShowTranscriptUpload(false)} />)}
      {viewingTranscriptId && (<TranscriptAnalysis transcriptId={viewingTranscriptId} onClose={() => setViewingTranscriptId(null)} />)}
      {showImportModal && (<CSVImportModal entity="deals" accounts={accounts} onImport={handleImportDeals} onClose={() => setShowImportModal(false)} />)}

      {/* Contract create — pre-filled with this deal's ID */}
      {showContractModal && selectedDeal && (
        <ContractCreateModal
          prefillDealId={selectedDeal.id}
          onClose={() => setShowContractModal(false)}
          onSuccess={(newContract) => {
            setShowContractModal(false);
            setDealContracts(prev => [newContract, ...prev]);
            setSelectedContract(newContract);
          }}
        />
      )}

      {/* Contract detail panel — slide-in overlay */}
      {selectedContract && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          zIndex: 900, display: 'flex', justifyContent: 'flex-end',
        }}
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedContract(null); }}>
          <div style={{ width: '100%', maxWidth: 640, height: '100%', background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', overflow: 'hidden' }}>
            <ContractDetailPanel
              contract={selectedContract}
              isLegalMember={isLegalMember}
              onClose={() => setSelectedContract(null)}
              onUpdated={() => {
                // Refresh contract in the list
                apiService.contracts.getById(selectedContract.id)
                  .then(r => {
                    const updated = r.data?.contract || r.data;
                    setSelectedContract(updated);
                    setDealContracts(prev => prev.map(c => c.id === updated.id ? updated : c));
                  })
                  .catch(() => {});
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function DealCard({ deal, onEdit, onDelete, onSelect, isSelected }) {
  const account = deal.account || { name: 'Unknown Account' };
  return (
    <div className={`deal-card ${isSelected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="deal-card-header">
        <h4>{deal.name}</h4>
        <div className="deal-actions">
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="icon-btn" title="Edit">edit</button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="icon-btn" title="Delete">del</button>
        </div>
      </div>
      <p className="deal-company">{account.name}</p>
      <p className="deal-value">${parseFloat(deal.value || 0).toLocaleString()}</p>
      <div className={`deal-health ${deal.health}`}>{deal.health}</div>
      <p className="deal-date">Close: {deal.expected_close_date ? new Date(deal.expected_close_date).toLocaleDateString() : 'Not set'}</p>
      <div className="deal-probability">{deal.probability || 50}% likely</div>
    </div>
  );
}

export default DealsView;
