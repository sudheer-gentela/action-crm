import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { enrichData } from './mockData';
import DealForm from './DealForm';
import AIAnalyzeButton from './AIAnalyzeButton';
import TranscriptUpload from './TranscriptUpload';
import TranscriptAnalysis from './TranscriptAnalysis';
import DealActionsPanel from './DealActionsPanel';
import DealTeamPanel from './DealTeamPanel';
import DealContactsPanel from './DealContactsPanel';
import DealEmailHistory from './DealEmailHistory';
import './DealsView.css';

function DealsView({ openDealId = null, onDealOpened = null }) {
  const [deals, setDeals] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingDeal, setEditingDeal] = useState(null);
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [error, setError] = useState('');
  const [showTranscriptUpload, setShowTranscriptUpload] = useState(false);
  const [viewingTranscriptId, setViewingTranscriptId] = useState(null);
  const [scoringDealId, setScoringDealId] = useState(null);
  const [editingField, setEditingField] = useState(null); // { field, value } for inline editing
  const [savingField, setSavingField] = useState(null);

  useEffect(() => {
    fetchDeals();
  }, []);

  // When App.js passes an openDealId (from "Go there" in ActionContextPanel),
  // find that deal in state and open its detail panel automatically
  useEffect(() => {
    if (!openDealId || deals.length === 0) return;
    const target = deals.find(d => d.id === openDealId || d.id === parseInt(openDealId));
    if (target) {
      setSelectedDeal(target);
      // Tell App.js we've consumed this so it doesn't re-trigger on re-renders
      if (onDealOpened) onDealOpened();
    }
  }, [openDealId, deals]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchDeals = async () => {
    try {
      setLoading(true);
      setError('');

      // ✅ FIX 1: Removed .catch() fallbacks so real API errors are visible
      // If this fails, check browser console for the actual error (401, 404, CORS, etc.)
      const [dealsRes, accountsRes, meetingsRes] = await Promise.all([
        apiService.deals.getAll(),
        apiService.accounts.getAll(),
        apiService.meetings.getAll()
      ]);

      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        deals:    dealsRes.data.deals       || dealsRes.data    || [],
        contacts: [],
        meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        emails:   [],
        actions:  []
      });

      setDeals(enrichedData.deals);
      setAccounts(enrichedData.accounts);
      setMeetings(enrichedData.meetings);

    } catch (err) {
      console.error('Error fetching deals:', err);
      // Show the real error message so you can diagnose it
      setError(`Failed to load deals: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDeal = async (dealData) => {
    try {
      const response = await apiService.deals.create(dealData);
      const newDeal = response.data.deal || response.data;
      
      // Enrich the new deal
      const account = accounts.find(a => a.id === newDeal.account_id);
      const enrichedDeal = { ...newDeal, account };
      
      setDeals([...deals, enrichedDeal]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error creating deal:', err);
      const newDeal = { 
        ...dealData, 
        id: Date.now(),
        account: accounts.find(a => a.id === dealData.account_id)
      };
      setDeals([...deals, newDeal]);
      setShowForm(false);
    }
  };

  const handleUpdateDeal = async (dealData) => {
    try {
      const response = await apiService.deals.update(editingDeal.id, dealData);
      const updatedDeal = response.data.deal || response.data;
      
      // Enrich the updated deal
      const account = accounts.find(a => a.id === updatedDeal.account_id);
      const enrichedDeal = { ...updatedDeal, account };
      
      setDeals(deals.map(d => d.id === editingDeal.id ? enrichedDeal : d));
      setEditingDeal(null);
      setError('');
    } catch (err) {
      console.error('Error updating deal:', err);
      const account = accounts.find(a => a.id === dealData.account_id);
      setDeals(deals.map(d => 
        d.id === editingDeal.id ? { ...d, ...dealData, account } : d
      ));
      setEditingDeal(null);
    }
  };

  const handleDeleteDeal = async (dealId) => {
    if (!window.confirm('Are you sure you want to delete this deal?')) {
      return;
    }

    try {
      await apiService.deals.delete(dealId);
      setDeals(deals.filter(d => d.id !== dealId));
      if (selectedDeal?.id === dealId) {
        setSelectedDeal(null);
      }
      setError('');
    } catch (err) {
      console.error('Error deleting deal:', err);
      setDeals(deals.filter(d => d.id !== dealId));
      if (selectedDeal?.id === dealId) {
        setSelectedDeal(null);
      }
    }
  };

  const handleScoreDeal = async (dealId) => {
    try {
      setScoringDealId(dealId);
      const response = await apiService.health.scoreDeal(dealId);
      const { score, health, breakdown } = response.data.result;
      // Update the deal in state with new score
      const update = { health, health_score: score, health_score_breakdown: breakdown, health_score_updated_at: new Date().toISOString() };
      setDeals(deals.map(d => d.id === dealId ? { ...d, ...update } : d));
      if (selectedDeal?.id === dealId) setSelectedDeal(prev => ({ ...prev, ...update }));
    } catch (err) {
      console.error('Score deal error:', err);
    } finally {
      setScoringDealId(null);
    }
  };


  const handleInlineFieldSave = async (field, value) => {
    if (!selectedDeal) return;
    setSavingField(field);
    try {
      const payload = { [field]: value };
      // Coerce types
      if (field === 'value')       payload.value       = parseFloat(value);
      if (field === 'probability') payload.probability = parseInt(value);
      if (field === 'account_id')  payload.account_id  = parseInt(value);

      const response = await apiService.deals.update(selectedDeal.id, payload);
      const updated = response.data.deal || response.data;
      const account = accounts.find(a => a.id === (updated.account_id || payload.account_id));
      const enriched = { ...selectedDeal, ...updated, account };
      setDeals(prev => prev.map(d => d.id === selectedDeal.id ? enriched : d));
      setSelectedDeal(enriched);
    } catch (err) {
      console.error('Inline save error:', err);
    } finally {
      setSavingField(null);
      setEditingField(null);
    }
  };

  const getDealMeetings = (dealId) => {
    return meetings.filter(m => m.deal_id === dealId);
  };

  const groupedDeals = {
    qualified: deals.filter(d => d.stage === 'qualified'),
    demo: deals.filter(d => d.stage === 'demo'),
    proposal: deals.filter(d => d.stage === 'proposal'),
    negotiation: deals.filter(d => d.stage === 'negotiation'),
    closed_won: deals.filter(d => d.stage === 'closed_won')
  };

  const stages = [
    { id: 'qualified', label: 'Qualified' },
    { id: 'demo', label: 'Demo' },
    { id: 'proposal', label: 'Proposal' },
    { id: 'negotiation', label: 'Negotiation' },
    { id: 'closed_won', label: 'Closed Won' }
  ];

  if (loading) {
    return (
      <div className="deals-view">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading deals...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="deals-view">
      {/* Header */}
      <div className="deals-header">
        <div>
          <h1>Deal Pipeline</h1>
          <p className="deals-subtitle">
            {deals.length} active opportunit{deals.length !== 1 ? 'ies' : 'y'}
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>
          + New Deal
        </button>
      </div>

      {error && (
        <div className="error-banner">
          ⚠️ {error}
        </div>
      )}

      {/* Pipeline Stats */}
      <div className="pipeline-stats">
        <div className="stat-card">
          <div className="stat-value">{deals.length}</div>
          <div className="stat-label">Active Deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            ${deals.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0).toLocaleString()}
          </div>
          <div className="stat-label">Total Pipeline</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {deals.length > 0 
              ? Math.round(deals.reduce((sum, d) => sum + (d.probability || 0), 0) / deals.length)
              : 0}%
          </div>
          <div className="stat-label">Avg Probability</div>
        </div>
      </div>

      {/* Deals Container with Pipeline and Detail Panel */}
      <div className={`deals-container ${selectedDeal ? 'with-panel' : ''}`}>
        {/* Pipeline View */}
        <div className="pipeline-board">
          {stages.map(stage => (
            <div key={stage.id} className="pipeline-stage">
              <div className="stage-header">
                <h3>{stage.label}</h3>
                <span className="stage-count">{groupedDeals[stage.id].length}</span>
              </div>
              <div className="stage-content">
                {groupedDeals[stage.id].length === 0 ? (
                  <div className="empty-stage">No deals</div>
                ) : (
                  groupedDeals[stage.id].map(deal => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      onEdit={() => setEditingDeal(deal)}
                      onDelete={() => handleDeleteDeal(deal.id)}
                      onSelect={() => setSelectedDeal(deal)}
                      isSelected={selectedDeal?.id === deal.id}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Deal Detail Panel */}
        {selectedDeal && (
          <div className="deal-detail-panel panel-fullscreen">
            <div className="panel-header">
              <h2>{selectedDeal.name}</h2>
              <div className="panel-header-actions">
                <button className="close-panel" onClick={() => setSelectedDeal(null)}>×</button>
              </div>
            </div>

            <div className="panel-content">

              {/* ── 1. Deal Information ─────────────────────────── */}
              <div className="detail-section">
                <div className="detail-section-header">
                  <h3>📋 Deal Information</h3>
                  <div className="detail-section-actions">
                    <AIAnalyzeButton
                      type="deal"
                      id={selectedDeal.id}
                      onSuccess={() => alert('🎉 AI analysis complete! Check Actions below.')}
                    />
                  </div>
                </div>

                <div className="detail-grid">
                  {/* Value — inline edit */}
                  <div className="detail-item">
                    <span className="detail-label">Value</span>
                    {editingField?.field === 'value' ? (
                      <div className="inline-edit-row">
                        <input
                          className="inline-edit-input"
                          type="number"
                          autoFocus
                          value={editingField.value}
                          onChange={e => setEditingField(f => ({ ...f, value: e.target.value }))}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  handleInlineFieldSave('value', editingField.value);
                            if (e.key === 'Escape') setEditingField(null);
                          }}
                        />
                        <button className="inline-save-btn" disabled={savingField === 'value'} onClick={() => handleInlineFieldSave('value', editingField.value)}>✓</button>
                        <button className="inline-cancel-btn" onClick={() => setEditingField(null)}>✕</button>
                      </div>
                    ) : (
                      <span
                        className="detail-value-large detail-value--editable"
                        onClick={() => setEditingField({ field: 'value', value: selectedDeal.value || '' })}
                        title="Click to edit"
                      >
                        ${parseFloat(selectedDeal.value || 0).toLocaleString()} ✏️
                      </span>
                    )}
                  </div>

                  {/* Stage — inline select */}
                  <div className="detail-item">
                    <span className="detail-label">Stage</span>
                    {editingField?.field === 'stage' ? (
                      <select
                        className="inline-edit-select"
                        autoFocus
                        value={editingField.value}
                        onChange={e => handleInlineFieldSave('stage', e.target.value)}
                        onBlur={() => setEditingField(null)}
                        onKeyDown={e => e.key === 'Escape' && setEditingField(null)}
                      >
                        <option value="qualified">Qualified</option>
                        <option value="demo">Demo</option>
                        <option value="proposal">Proposal</option>
                        <option value="negotiation">Negotiation</option>
                        <option value="closed_won">Closed Won</option>
                        <option value="closed_lost">Closed Lost</option>
                      </select>
                    ) : (
                      <span
                        className="detail-badge stage-badge detail-value--editable"
                        onClick={() => setEditingField({ field: 'stage', value: selectedDeal.stage })}
                        title="Click to edit"
                      >
                        {stages.find(s => s.id === selectedDeal.stage)?.label || selectedDeal.stage} ✏️
                      </span>
                    )}
                  </div>

                  {/* Probability — inline edit */}
                  <div className="detail-item">
                    <span className="detail-label">Probability</span>
                    {editingField?.field === 'probability' ? (
                      <div className="inline-edit-row">
                        <input
                          className="inline-edit-input"
                          type="number"
                          min="0" max="100"
                          autoFocus
                          value={editingField.value}
                          onChange={e => setEditingField(f => ({ ...f, value: e.target.value }))}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  handleInlineFieldSave('probability', editingField.value);
                            if (e.key === 'Escape') setEditingField(null);
                          }}
                        />
                        <button className="inline-save-btn" disabled={savingField === 'probability'} onClick={() => handleInlineFieldSave('probability', editingField.value)}>✓</button>
                        <button className="inline-cancel-btn" onClick={() => setEditingField(null)}>✕</button>
                      </div>
                    ) : (
                      <span
                        className="detail-value--editable"
                        onClick={() => setEditingField({ field: 'probability', value: selectedDeal.probability || 50 })}
                        title="Click to edit"
                      >
                        {selectedDeal.probability || 50}% ✏️
                      </span>
                    )}
                  </div>

                  {/* Health + ReScore */}
                  <div className="detail-item">
                    <span className="detail-label">Health</span>
                    <div className="health-rescore-row">
                      <span className={`detail-badge health-${selectedDeal.health}`}>
                        {selectedDeal.health === 'healthy' && '✅ Healthy'}
                        {selectedDeal.health === 'watch'   && '⚠️ Watch'}
                        {selectedDeal.health === 'risk'    && '🔴 At Risk'}
                      </span>
                      <button
                        className="rescore-btn"
                        onClick={() => handleScoreDeal(selectedDeal.id)}
                        disabled={scoringDealId === selectedDeal.id}
                        title="Re-score deal health"
                      >
                        {scoringDealId === selectedDeal.id ? '⏳' : '🔄'} ReScore
                      </button>
                    </div>
                  </div>

                  {/* Expected Close Date — inline date */}
                  <div className="detail-item">
                    <span className="detail-label">Expected Close</span>
                    {editingField?.field === 'expected_close_date' ? (
                      <div className="inline-edit-row">
                        <input
                          className="inline-edit-input"
                          type="date"
                          autoFocus
                          value={editingField.value}
                          onChange={e => setEditingField(f => ({ ...f, value: e.target.value }))}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  handleInlineFieldSave('expected_close_date', editingField.value);
                            if (e.key === 'Escape') setEditingField(null);
                          }}
                        />
                        <button className="inline-save-btn" disabled={savingField === 'expected_close_date'} onClick={() => handleInlineFieldSave('expected_close_date', editingField.value)}>✓</button>
                        <button className="inline-cancel-btn" onClick={() => setEditingField(null)}>✕</button>
                      </div>
                    ) : (
                      <span
                        className="detail-value--editable"
                        onClick={() => setEditingField({ field: 'expected_close_date', value: selectedDeal.expected_close_date ? selectedDeal.expected_close_date.split('T')[0] : '' })}
                        title="Click to edit"
                      >
                        {selectedDeal.expected_close_date
                          ? new Date(selectedDeal.expected_close_date).toLocaleDateString()
                          : 'Not set'} ✏️
                      </span>
                    )}
                  </div>

                  {/* Account — inline select */}
                  <div className="detail-item">
                    <span className="detail-label">Account</span>
                    {editingField?.field === 'account_id' ? (
                      <select
                        className="inline-edit-select"
                        autoFocus
                        value={editingField.value}
                        onChange={e => handleInlineFieldSave('account_id', e.target.value)}
                        onBlur={() => setEditingField(null)}
                        onKeyDown={e => e.key === 'Escape' && setEditingField(null)}
                      >
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    ) : selectedDeal.account ? (
                      <div className="account-edit-row">
                        <span
                          className="detail-value--link"
                          onClick={() => window.dispatchEvent(new CustomEvent('navigate', {
                            detail: { tab: 'accounts', accountId: selectedDeal.account_id }
                          }))}
                          title="Open account"
                        >
                          {selectedDeal.account.name} →
                        </span>
                        <button
                          className="inline-edit-trigger"
                          onClick={() => setEditingField({ field: 'account_id', value: selectedDeal.account_id })}
                          title="Change account"
                        >✏️</button>
                      </div>
                    ) : (
                      <span
                        className="detail-value--editable"
                        onClick={() => setEditingField({ field: 'account_id', value: '' })}
                      >
                        Not set ✏️
                      </span>
                    )}
                  </div>
                </div>

              </div>

              {/* ── 2. Actions / Tasks ──────────────────────────── */}
              <div className="detail-section">
                <h3>⚡ Actions & Tasks</h3>
                <DealActionsPanel deal={selectedDeal} />
              </div>

              {/* ── 3. Email History ────────────────────────────── */}
              <div className="detail-section">
                <h3>📧 Email History</h3>
                <DealEmailHistory deal={selectedDeal} />
              </div>

              {/* ── 4. Meeting History ──────────────────────────── */}
              <div className="detail-section">
                <h3>📅 Meeting History ({getDealMeetings(selectedDeal.id).length})</h3>
                {getDealMeetings(selectedDeal.id).length === 0 ? (
                  <p className="empty-message">No meetings recorded for this deal</p>
                ) : (
                  <div className="linked-items-list">
                    {getDealMeetings(selectedDeal.id).map(meeting => (
                      <div
                        key={meeting.id}
                        className="linked-item linked-item--clickable"
                        onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'calendar', meetingId: meeting.id } }))}
                        title="View in Calendar"
                      >
                        <span className="item-icon">📅</span>
                        <div className="item-info">
                          <div className="item-name">{meeting.title}</div>
                          <div className="item-meta">
                            {new Date(meeting.start_time).toLocaleString()} · {meeting.status}
                          </div>
                        </div>
                        <span className="item-arrow">→</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── 5. Deal Team ────────────────────────────────── */}
              <div className="detail-section">
                <h3>👥 Deal Team</h3>
                <DealTeamPanel deal={selectedDeal} />
              </div>

              {/* ── 6. Contacts ─────────────────────────────────── */}
              <div className="detail-section">
                <h3>👤 Contacts</h3>
                <DealContactsPanel deal={selectedDeal} />
              </div>

              {/* ── 7. Modify Deal Details ──────────────────────── */}
              <div className="detail-section">
                <h3>🛠️ Modify Deal Details</h3>
                <div className="quick-actions">
                  <button
                    className="btn-action"
                    onClick={() => setEditingDeal(selectedDeal)}
                  >
                    ✏️ Edit Deal
                  </button>
                  <button
                    className="btn-action btn-action--danger"
                    onClick={() => handleDeleteDeal(selectedDeal.id)}
                  >
                    🗑️ Delete Deal
                  </button>
                  <button
                    className="btn-action"
                    onClick={() => setShowTranscriptUpload(true)}
                  >
                    📝 Upload Meeting Transcript
                  </button>
                </div>
              </div>

              {/* ── 8. Notes ────────────────────────────────────── */}
              {selectedDeal.notes && (
                <div className="detail-section">
                  <h3>📝 Notes</h3>
                  <p className="deal-notes-text">{selectedDeal.notes}</p>
                </div>
              )}

            </div>
          </div>
        )}
      </div>

      {/* Deal Form Modal */}
      {(showForm || editingDeal) && (
        <DealForm
          deal={editingDeal}
          accounts={accounts}
          onSubmit={editingDeal ? handleUpdateDeal : handleCreateDeal}
          onClose={() => {
            setShowForm(false);
            setEditingDeal(null);
          }}
        />
      )}

      {/* Transcript Upload Modal */}
      {showTranscriptUpload && (
        <TranscriptUpload
          dealId={selectedDeal?.id}
          onSuccess={(result) => {
            setShowTranscriptUpload(false);
            setViewingTranscriptId(result.transcriptId);
          }}
          onClose={() => setShowTranscriptUpload(false)}
        />
      )}

      {/* Transcript Analysis Modal */}
      {viewingTranscriptId && (
        <TranscriptAnalysis
          transcriptId={viewingTranscriptId}
          onClose={() => setViewingTranscriptId(null)}
        />
      )}

      {/* Health Config moved to Settings → Deal Health */}
    </div>
  );
}

function DealCard({ deal, onEdit, onDelete, onSelect, isSelected }) {
  const account = deal.account || { name: 'Unknown Account' };
  
  return (
    <div 
      className={`deal-card ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <div className="deal-card-header">
        <h4>{deal.name}</h4>
        <div className="deal-actions">
          <button 
            onClick={(e) => { e.stopPropagation(); onEdit(); }} 
            className="icon-btn" 
            title="Edit"
          >
            ✏️
          </button>
          <button 
            onClick={(e) => { e.stopPropagation(); onDelete(); }} 
            className="icon-btn" 
            title="Delete"
          >
            🗑️
          </button>
        </div>
      </div>
      <p className="deal-company">{account.name}</p>
      <p className="deal-value">${parseFloat(deal.value || 0).toLocaleString()}</p>
      <div className={`deal-health ${deal.health}`}>
        ● {deal.health}
      </div>
      <p className="deal-date">
        Close: {deal.expected_close_date ? new Date(deal.expected_close_date).toLocaleDateString() : 'Not set'}
      </p>
      <div className="deal-probability">
        {deal.probability || 50}% likely
      </div>
    </div>
  );
}

export default DealsView;
