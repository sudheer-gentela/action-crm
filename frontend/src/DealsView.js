import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import DealForm from './DealForm';
import AIAnalyzeButton from './AIAnalyzeButton';
import TranscriptUpload from './TranscriptUpload';
import TranscriptAnalysis from './TranscriptAnalysis';
import './DealsView.css';

function DealsView() {
  const [deals, setDeals] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [emails, setEmails] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingDeal, setEditingDeal] = useState(null);
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [error, setError] = useState('');
  const [showTranscriptUpload, setShowTranscriptUpload] = useState(false);
  const [viewingTranscriptId, setViewingTranscriptId] = useState(null);

  useEffect(() => {
    fetchDeals();
  }, []);

  const fetchDeals = async () => {
    try {
      setLoading(true);
      setError('');

      const [dealsRes, accountsRes, contactsRes, emailsRes, meetingsRes] = await Promise.all([
        apiService.deals.getAll().catch(() => ({ data: { deals: mockData.deals } })),
        apiService.accounts.getAll().catch(() => ({ data: { accounts: mockData.accounts } })),
        apiService.contacts.getAll().catch(() => ({ data: { contacts: mockData.contacts } })),
        apiService.emails.getAll().catch(() => ({ data: { emails: mockData.emails } })),
        apiService.meetings.getAll().catch(() => ({ data: { meetings: mockData.meetings } }))
      ]);

      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        deals: dealsRes.data.deals || dealsRes.data || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        emails: emailsRes.data.emails || emailsRes.data || [],
        meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        actions: []
      });

      setDeals(enrichedData.deals);
      setAccounts(enrichedData.accounts);
      setContacts(enrichedData.contacts);
      setEmails(enrichedData.emails);
      setMeetings(enrichedData.meetings);

    } catch (err) {
      console.error('Error fetching deals:', err);
      setError('Failed to load deals. Using sample data.');
      
      const enrichedData = enrichData({
        ...mockData,
        actions: []
      });
      
      setDeals(enrichedData.deals);
      setAccounts(enrichedData.accounts);
      setContacts(enrichedData.contacts);
      setEmails(enrichedData.emails);
      setMeetings(enrichedData.meetings);
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

  const getDealContacts = (dealId) => {
    const deal = deals.find(d => d.id === dealId);
    if (!deal) return [];
    return contacts.filter(c => c.account_id === deal.account_id);
  };

  const getDealEmails = (dealId) => {
    return emails.filter(e => e.deal_id === dealId);
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
        <div className="info-banner">
          ℹ️ {error}
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
          <div className="deal-detail-panel">
            <div className="panel-header">
              <h2>{selectedDeal.name}</h2>
              <button className="close-panel" onClick={() => setSelectedDeal(null)}>×</button>
            </div>

            <div className="panel-content">
              {/* Deal Overview */}
              <div className="detail-section">
                <h3>Deal Information</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Value</span>
                    <span className="detail-value-large">
                      ${parseFloat(selectedDeal.value || 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Stage</span>
                    <span className="detail-badge stage-badge">
                      {stages.find(s => s.id === selectedDeal.stage)?.label || selectedDeal.stage}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Probability</span>
                    <span>{selectedDeal.probability || 50}%</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Health</span>
                    <span className={`detail-badge health-${selectedDeal.health}`}>
                      {selectedDeal.health === 'healthy' && '✅ Healthy'}
                      {selectedDeal.health === 'watch' && '⚠️ Watch'}
                      {selectedDeal.health === 'risk' && '🔴 At Risk'}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Expected Close</span>
                    <span>
                      {selectedDeal.expected_close_date 
                        ? new Date(selectedDeal.expected_close_date).toLocaleDateString()
                        : 'Not set'}
                    </span>
                  </div>
                  {selectedDeal.account && (
                    <div className="detail-item">
                      <span className="detail-label">Account</span>
                      <span>{selectedDeal.account.name}</span>
                    </div>
                  )}
                </div>
                {selectedDeal.notes && (
                  <div className="detail-description">
                    <span className="detail-label">Notes</span>
                    <p>{selectedDeal.notes}</p>
                  </div>
                )}
              </div>

              {/* Contacts */}
              <div className="detail-section">
                <h3>Contacts ({getDealContacts(selectedDeal.id).length})</h3>
                {getDealContacts(selectedDeal.id).length === 0 ? (
                  <p className="empty-message">No contacts linked to this deal</p>
                ) : (
                  <div className="linked-items-list">
                    {getDealContacts(selectedDeal.id).map(contact => (
                      <div key={contact.id} className="linked-item">
                        <span className="item-icon">👤</span>
                        <div className="item-info">
                          <div className="item-name">
                            {contact.first_name} {contact.last_name}
                          </div>
                          <div className="item-meta">
                            {contact.title} • {contact.role_type}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Emails */}
              <div className="detail-section">
                <h3>Email Activity ({getDealEmails(selectedDeal.id).length})</h3>
                {getDealEmails(selectedDeal.id).length === 0 ? (
                  <p className="empty-message">No emails for this deal</p>
                ) : (
                  <div className="linked-items-list">
                    {getDealEmails(selectedDeal.id).map(email => (
                      <div key={email.id} className="linked-item">
                        <span className="item-icon">
                          {email.direction === 'sent' ? '📤' : '📥'}
                        </span>
                        <div className="item-info">
                          <div className="item-name">{email.subject}</div>
                          <div className="item-meta">
                            {email.direction === 'sent' ? 'Sent to' : 'From'} {email.contact?.first_name} {email.contact?.last_name} •
                            {new Date(email.sent_at).toLocaleDateString()}
                            {email.opened_at && ' • Opened'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Meetings */}
              <div className="detail-section">
                <h3>Meetings ({getDealMeetings(selectedDeal.id).length})</h3>
                {getDealMeetings(selectedDeal.id).length === 0 ? (
                  <p className="empty-message">No meetings scheduled</p>
                ) : (
                  <div className="linked-items-list">
                    {getDealMeetings(selectedDeal.id).map(meeting => (
                      <div key={meeting.id} className="linked-item">
                        <span className="item-icon">📅</span>
                        <div className="item-info">
                          <div className="item-name">{meeting.title}</div>
                          <div className="item-meta">
                            {new Date(meeting.start_time).toLocaleString()} • {meeting.status}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Quick Actions */}
              <div className="detail-section">
                <h3>Quick Actions</h3>
                <div className="quick-actions">
                  <button 
                    className="btn-action"
                    onClick={() => setEditingDeal(selectedDeal)}
                  >
                    ✏️ Edit Deal
                  </button>
                  <button 
                    className="btn-action"
                    onClick={() => handleDeleteDeal(selectedDeal.id)}
                  >
                    🗑️ Delete Deal
                  </button>
                  <AIAnalyzeButton 
                    type="deal" 
                    id={selectedDeal.id}
                    onSuccess={() => {
                      alert('🎉 AI analysis complete! Check the Actions tab to see intelligent recommendations.');
                    }}
                  />
                </div>
              </div>

              {/* Meeting Intelligence */}
              <div className="detail-section">
                <h3>🤖 Meeting Intelligence</h3>
                <p className="section-description">
                  Upload a meeting transcript to extract insights, action items and deal health signals automatically.
                </p>
                <button
                  className="btn-action"
                  onClick={() => setShowTranscriptUpload(true)}
                >
                  📝 Upload Meeting Transcript
                </button>
              </div>
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
