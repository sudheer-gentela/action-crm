import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import AccountForm from './AccountForm';
import './AccountsView.css';

function AccountsView() {
  const [accounts, setAccounts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      setLoading(true);
      setError('');

      const [accountsRes, dealsRes, contactsRes] = await Promise.all([
        apiService.accounts.getAll().catch(() => ({ data: { accounts: mockData.accounts } })),
        apiService.deals.getAll().catch(() => ({ data: { deals: mockData.deals } })),
        apiService.contacts.getAll().catch(() => ({ data: { contacts: mockData.contacts } }))
      ]);

      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        deals: dealsRes.data.deals || dealsRes.data || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        emails: [],
        meetings: [],
        actions: []
      });

      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);

    } catch (err) {
      console.error('Error loading accounts:', err);
      setError('Failed to load accounts. Using sample data.');
      
      const enrichedData = enrichData({
        ...mockData,
        emails: [],
        meetings: [],
        actions: []
      });
      
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAccount = async (accountData) => {
    try {
      const response = await apiService.accounts.create(accountData);
      setAccounts([...accounts, response.data.account || response.data]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error creating account:', err);
      const newAccount = { 
        ...accountData, 
        id: Date.now(),
        created_at: new Date().toISOString()
      };
      setAccounts([...accounts, newAccount]);
      setShowForm(false);
    }
  };

  const handleUpdateAccount = async (accountData) => {
    try {
      const response = await apiService.accounts.update(editingAccount.id, accountData);
      setAccounts(accounts.map(a => 
        a.id === editingAccount.id ? (response.data.account || response.data) : a
      ));
      setEditingAccount(null);
      setError('');
    } catch (err) {
      console.error('Error updating account:', err);
      setAccounts(accounts.map(a => 
        a.id === editingAccount.id ? { ...a, ...accountData } : a
      ));
      setEditingAccount(null);
    }
  };

  const handleDeleteAccount = async (accountId) => {
    if (!window.confirm('Are you sure you want to delete this account? All associated deals and contacts will be affected.')) {
      return;
    }

    try {
      await apiService.accounts.delete(accountId);
      setAccounts(accounts.filter(a => a.id !== accountId));
      if (selectedAccount?.id === accountId) {
        setSelectedAccount(null);
      }
      setError('');
    } catch (err) {
      console.error('Error deleting account:', err);
      setAccounts(accounts.filter(a => a.id !== accountId));
      if (selectedAccount?.id === accountId) {
        setSelectedAccount(null);
      }
    }
  };

  const getAccountDeals = (accountId) => {
    return deals.filter(d => d.account_id === accountId && d.stage !== 'closed_lost');
  };

  const getAccountContacts = (accountId) => {
    return contacts.filter(c => c.account_id === accountId);
  };

  const calculateAccountValue = (accountId) => {
    const accountDeals = getAccountDeals(accountId);
    return accountDeals.reduce((sum, d) => sum + parseFloat(d.value || 0), 0);
  };

  if (loading) {
    return (
      <div className="accounts-view">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading accounts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="accounts-view">
      {/* Header */}
      <div className="accounts-header">
        <div>
          <h1>Accounts</h1>
          <p className="accounts-subtitle">
            {accounts.length} compan{accounts.length !== 1 ? 'ies' : 'y'} in your CRM
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>
          + New Account
        </button>
      </div>

      {error && (
        <div className="info-banner">
          ℹ️ {error}
        </div>
      )}

      {/* Accounts Grid */}
      <div className="accounts-container">
        <div className="accounts-grid">
          {accounts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🏢</div>
              <h3>No accounts yet</h3>
              <p>Create your first account to start managing deals and contacts</p>
              <button className="btn-primary" onClick={() => setShowForm(true)}>
                + Create Account
              </button>
            </div>
          ) : (
            accounts.map(account => (
              <AccountCard
                key={account.id}
                account={account}
                deals={getAccountDeals(account.id)}
                contacts={getAccountContacts(account.id)}
                totalValue={calculateAccountValue(account.id)}
                onEdit={() => setEditingAccount(account)}
                onDelete={() => handleDeleteAccount(account.id)}
                onSelect={() => setSelectedAccount(account)}
                isSelected={selectedAccount?.id === account.id}
              />
            ))
          )}
        </div>

        {/* Account Detail Panel */}
        {selectedAccount && (
          <div className="account-detail-panel">
            <div className="panel-header">
              <h2>{selectedAccount.name}</h2>
              <button className="close-panel" onClick={() => setSelectedAccount(null)}>×</button>
            </div>

            <div className="panel-content">
              {/* Basic Info */}
              <div className="detail-section">
                <h3>Company Information</h3>
                <div className="detail-grid">
                  {selectedAccount.domain && (
                    <div className="detail-item">
                      <span className="detail-label">Website</span>
                      <a href={`https://${selectedAccount.domain}`} target="_blank" rel="noopener noreferrer">
                        {selectedAccount.domain}
                      </a>
                    </div>
                  )}
                  {selectedAccount.industry && (
                    <div className="detail-item">
                      <span className="detail-label">Industry</span>
                      <span>{selectedAccount.industry}</span>
                    </div>
                  )}
                  {selectedAccount.size && (
                    <div className="detail-item">
                      <span className="detail-label">Size</span>
                      <span>{selectedAccount.size} employees</span>
                    </div>
                  )}
                  {selectedAccount.location && (
                    <div className="detail-item">
                      <span className="detail-label">Location</span>
                      <span>{selectedAccount.location}</span>
                    </div>
                  )}
                </div>
                {selectedAccount.description && (
                  <div className="detail-description">
                    <span className="detail-label">Description</span>
                    <p>{selectedAccount.description}</p>
                  </div>
                )}
              </div>

              {/* Deals */}
              <div className="detail-section">
                <h3>Active Deals ({getAccountDeals(selectedAccount.id).length})</h3>
                {getAccountDeals(selectedAccount.id).length === 0 ? (
                  <p className="empty-message">No active deals</p>
                ) : (
                  <div className="linked-items-list">
                    {getAccountDeals(selectedAccount.id).map(deal => (
                      <div key={deal.id} className="linked-item">
                        <span className="item-icon">💼</span>
                        <div className="item-info">
                          <div className="item-name">{deal.name}</div>
                          <div className="item-meta">
                            ${parseFloat(deal.value).toLocaleString()} • {deal.stage}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Contacts */}
              <div className="detail-section">
                <h3>Contacts ({getAccountContacts(selectedAccount.id).length})</h3>
                {getAccountContacts(selectedAccount.id).length === 0 ? (
                  <p className="empty-message">No contacts</p>
                ) : (
                  <div className="linked-items-list">
                    {getAccountContacts(selectedAccount.id).map(contact => (
                      <div key={contact.id} className="linked-item">
                        <span className="item-icon">👤</span>
                        <div className="item-info">
                          <div className="item-name">
                            {contact.first_name} {contact.last_name}
                          </div>
                          <div className="item-meta">{contact.title}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Account Form Modal */}
      {(showForm || editingAccount) && (
        <AccountForm
          account={editingAccount}
          onSubmit={editingAccount ? handleUpdateAccount : handleCreateAccount}
          onClose={() => {
            setShowForm(false);
            setEditingAccount(null);
          }}
        />
      )}
    </div>
  );
}

function AccountCard({ account, deals, contacts, totalValue, onEdit, onDelete, onSelect, isSelected }) {
  const activeDeals = deals.filter(d => d.stage !== 'closed_won' && d.stage !== 'closed_lost');
  
  return (
    <div 
      className={`account-card ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <div className="account-card-header">
        <div className="account-icon">
          {account.name.substring(0, 2).toUpperCase()}
        </div>
        <div className="account-actions">
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

      <h3 className="account-name">{account.name}</h3>
      
      {account.industry && (
        <p className="account-industry">{account.industry}</p>
      )}

      <div className="account-stats">
        <div className="stat-item">
          <span className="stat-value">{activeDeals.length}</span>
          <span className="stat-label">Active Deals</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{contacts.length}</span>
          <span className="stat-label">Contacts</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">${(totalValue / 1000).toFixed(0)}K</span>
          <span className="stat-label">Pipeline</span>
        </div>
      </div>

      {account.location && (
        <p className="account-location">📍 {account.location}</p>
      )}
    </div>
  );
}

export default AccountsView;
