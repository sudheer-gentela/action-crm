import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import AccountForm from './AccountForm';
import AccountMergeBanner from './AccountMergeBanner';
import CoverageScorecard from './CoverageScorecard';
import { csvExport, EXPORT_COLUMNS } from './csvUtils';
import CSVImportModal from './CSVImportModal';
import './AccountsView.css';

const EDITABLE_FIELDS = {
  name:        { label: 'Company Name', type: 'text', required: true },
  domain:      { label: 'Website',      type: 'url' },
  industry:    { label: 'Industry',     type: 'text' },
  size:        { label: 'Size',         type: 'number' },
  location:    { label: 'Location',     type: 'text' },
  description: { label: 'Description',  type: 'textarea' },
};

function AccountsView({ openAccountId = null, onAccountOpened = null }) {
  const [accounts, setAccounts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [error, setError] = useState('');

  // Inline editing
  const [editingField, setEditingField] = useState(null);
  const [savingField, setSavingField] = useState(null);
  const [showImportModal, setShowImportModal] = useState(false);

  // ── Scope toggle state ────────────────────────────────────────
  const [scope, setScope] = useState('mine');
  const [hasTeam, setHasTeam] = useState(false);

  useEffect(() => {
    apiService.orgAdmin.getMyTeam()
      .then(r => setHasTeam(r.data.hasTeam))
      .catch(() => setHasTeam(false));
  }, []);

  useEffect(() => { loadAccounts(); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!openAccountId || accounts.length === 0) return;
    const target = accounts.find(a => a.id === openAccountId || a.id === parseInt(openAccountId));
    if (target) {
      setSelectedAccount(target);
      if (onAccountOpened) onAccountOpened();
    }
  }, [openAccountId, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setEditingField(null); }, [selectedAccount?.id]);

  const loadAccounts = async () => {
    try {
      setLoading(true);
      setError('');
      const [accountsRes, dealsRes, contactsRes] = await Promise.all([
        apiService.accounts.getAll(scope).catch(() => ({ data: { accounts: mockData.accounts } })),
        apiService.deals.getAll(scope).catch(() => ({ data: { deals: mockData.deals } })),
        apiService.contacts.getAll(scope).catch(() => ({ data: { contacts: mockData.contacts } }))
      ]);
      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        deals:    dealsRes.data.deals       || dealsRes.data || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        emails: [], meetings: [], actions: []
      });
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);
    } catch (err) {
      console.error('Error loading accounts:', err);
      setError('Failed to load accounts. Using sample data.');
      const enrichedData = enrichData({ ...mockData, emails: [], meetings: [], actions: [] });
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);
      setContacts(enrichedData.contacts);
    } finally {
      setLoading(false);
    }
  };

  // ── CRUD ────────────────────────────────────────────────────────────────

  const handleCreateAccount = async (accountData) => {
    try {
      const response = await apiService.accounts.create(accountData);
      setAccounts([...accounts, response.data.account || response.data]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error creating account:', err);
      if (err.response?.status === 409) {
        setError(err.response.data.error.message);
      } else {
        setError(`Failed to create account: ${err.response?.data?.error?.message || err.message}`);
      }
    }
  };

  const handleUpdateAccount = async (accountData) => {
    try {
      const response = await apiService.accounts.update(editingAccount.id, accountData);
      const updated = response.data.account || response.data;
      setAccounts(accounts.map(a => a.id === editingAccount.id ? updated : a));
      if (selectedAccount?.id === editingAccount.id) setSelectedAccount(updated);
      setEditingAccount(null);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error updating account:', err);
      setError(`Failed to update: ${err.response?.data?.error?.message || err.message}`);
    }
  };

  const handleDeleteAccount = async (accountId) => {
    if (!window.confirm('Are you sure you want to delete this account? All associated deals and contacts will be affected.')) return;
    try {
      await apiService.accounts.delete(accountId);
    } catch {}
    setAccounts(accounts.filter(a => a.id !== accountId));
    if (selectedAccount?.id === accountId) setSelectedAccount(null);
  };

  // ── Inline field save ───────────────────────────────────────────────────

  const handleInlineFieldSave = async (field, value) => {
    if (!selectedAccount) return;
    setSavingField(field);
    try {
      const response = await apiService.accounts.update(selectedAccount.id, { [field]: value });
      const updated = response.data.account || response.data;
      setAccounts(prev => prev.map(a => a.id === selectedAccount.id ? updated : a));
      setSelectedAccount(updated);
    } catch (err) {
      console.error('Inline save error:', err);
      setError(`Failed to save: ${err.response?.data?.error?.message || err.message}`);
    } finally {
      setSavingField(null);
      setEditingField(null);
    }
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  const getAccountDeals = (accountId) =>
    deals.filter(d => d.account_id === accountId && d.stage !== 'closed_lost');

  const getAccountContacts = (accountId) =>
    contacts.filter(c => c.account_id === accountId);

  const calculateAccountValue = (accountId) =>
    getAccountDeals(accountId).reduce((sum, d) => sum + parseFloat(d.value || 0), 0);

  // ── Navigation ──────────────────────────────────────────────────────────

  const nav = (tab, extra) =>
    window.dispatchEvent(new CustomEvent('navigate', { detail: { tab, ...extra } }));

  const handleExportCSV = () => {
    csvExport(accounts, EXPORT_COLUMNS.accounts, `accounts-${scope}-${new Date().toISOString().slice(0,10)}.csv`);
  };

  const handleImportAccounts = async (rows) => {
    const response = await apiService.accounts.bulk(rows);
    const result = response.data;
    if (result.imported > 0) loadAccounts();
    return result;
  };

  // ── Render editable field ───────────────────────────────────────────────

  const renderEditableField = (field, account) => {
    const cfg = EDITABLE_FIELDS[field];
    if (!cfg) return null;
    const currentValue = account[field] || '';
    const isEditing = editingField?.field === field;

    // Textarea
    if (cfg.type === 'textarea') {
      if (isEditing) {
        return (
          <div className="inline-edit-row inline-edit-row--vertical">
            <textarea
              className="inline-edit-textarea"
              autoFocus
              value={editingField.value}
              onChange={e => setEditingField(f => ({ ...f, value: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Escape') setEditingField(null); }}
              rows={3}
            />
            <div className="inline-edit-actions">
              <button className="inline-save-btn" disabled={savingField === field}
                onClick={() => handleInlineFieldSave(field, editingField.value)}>✓ Save</button>
              <button className="inline-cancel-btn" onClick={() => setEditingField(null)}>✕</button>
            </div>
          </div>
        );
      }
      return (
        <span
          className="detail-value--editable acct-description-text"
          onClick={() => setEditingField({ field, value: currentValue })}
          title="Click to edit"
        >
          {currentValue || 'Add description…'} ✏️
        </span>
      );
    }

    // Text / url / number
    if (isEditing) {
      return (
        <div className="inline-edit-row">
          <input
            className="inline-edit-input"
            type={cfg.type === 'url' ? 'text' : cfg.type}
            autoFocus
            value={editingField.value}
            onChange={e => setEditingField(f => ({ ...f, value: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Enter')  handleInlineFieldSave(field, editingField.value);
              if (e.key === 'Escape') setEditingField(null);
            }}
          />
          <button className="inline-save-btn" disabled={savingField === field}
            onClick={() => handleInlineFieldSave(field, editingField.value)}>✓</button>
          <button className="inline-cancel-btn" onClick={() => setEditingField(null)}>✕</button>
        </div>
      );
    }

    // Display — special for domain (show as link)
    if (field === 'domain' && currentValue) {
      return (
        <span className="inline-display-row">
          <a href={`https://${currentValue}`} target="_blank" rel="noopener noreferrer">{currentValue}</a>
          <button className="inline-edit-trigger" onClick={() => setEditingField({ field, value: currentValue })} title="Edit">✏️</button>
        </span>
      );
    }
    if (field === 'size' && currentValue) {
      return (
        <span
          className="detail-value--editable"
          onClick={() => setEditingField({ field, value: currentValue })}
          title="Click to edit"
        >
          {parseInt(currentValue).toLocaleString()} employees ✏️
        </span>
      );
    }

    return (
      <span
        className="detail-value--editable"
        onClick={() => setEditingField({ field, value: currentValue })}
        title="Click to edit"
      >
        {currentValue || 'Not set'} ✏️
      </span>
    );
  };

  // ── Loading ─────────────────────────────────────────────────────────────

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

  // ── Main render ─────────────────────────────────────────────────────────

  return (
    <div className="accounts-view">
      {/* Header */}
      <div className="accounts-header">
        <div>
          <h1>Accounts</h1>
          <p className="accounts-subtitle">
            {accounts.length} compan{accounts.length !== 1 ? 'ies' : 'y'} in your CRM
            {scope !== 'mine' && <span style={{ color: '#6366f1', fontWeight: 600 }}> · {scope === 'team' ? 'Team' : 'All Org'}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {hasTeam && (
            <div style={{
              display: 'inline-flex', borderRadius: '8px', overflow: 'hidden',
              border: '1px solid #e2e4ea', fontSize: '13px'
            }}>
              {['mine', 'team', 'org'].map(s => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  style={{
                    padding: '6px 14px', border: 'none', cursor: 'pointer',
                    background: scope === s ? '#4f46e5' : '#fff',
                    color: scope === s ? '#fff' : '#4b5563',
                    fontWeight: scope === s ? 600 : 400,
                    transition: 'all 0.15s',
                  }}
                >
                  {s === 'mine' ? 'My Accounts' : s === 'team' ? 'My Team' : 'All Org'}
                </button>
              ))}
            </div>
          )}
          <button className="btn-primary" onClick={() => setShowForm(true)}>
            + New Account
          </button>
          <button onClick={handleExportCSV} title="Export CSV"
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #d1d5db',
                     background: '#fff', fontSize: 13, cursor: 'pointer' }}>
            📤 Export
          </button>
          <button onClick={() => setShowImportModal(true)} title="Import CSV"
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #d1d5db',
                     background: '#fff', fontSize: 13, cursor: 'pointer' }}>
            📥 Import
          </button>
        </div>
      </div>

      {error && <div className="info-banner">ℹ️ {error}</div>}

      {/* Duplicate Accounts Banner */}
      <AccountMergeBanner onMergeComplete={loadAccounts} />

      {/* Accounts Container */}
      <div className="accounts-container">
        <div className="accounts-grid">
          {accounts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🏢</div>
              <h3>No accounts yet</h3>
              <p>Create your first account to start managing deals and contacts</p>
              <button className="btn-primary" onClick={() => setShowForm(true)}>+ Create Account</button>
            </div>
          ) : (
            accounts.map(account => (
              <AccountCard
                key={account.id}
                account={account}
                deals={getAccountDeals(account.id)}
                contacts={getAccountContacts(account.id)}
                totalValue={calculateAccountValue(account.id)}
                onEdit={() => { setEditingAccount(account); setShowForm(true); }}
                onDelete={() => handleDeleteAccount(account.id)}
                onSelect={() => setSelectedAccount(account)}
                isSelected={selectedAccount?.id === account.id}
              />
            ))
          )}
        </div>

        {/* Account Detail Panel — fullscreen overlay */}
        {selectedAccount && (
          <div className="account-detail-panel panel-fullscreen">
            <div className="panel-header">
              <h2>{selectedAccount.name}</h2>
              <div className="panel-header-actions">
                <button className="close-panel" onClick={() => setSelectedAccount(null)}>×</button>
              </div>
            </div>

            <div className="panel-content">

              {/* ── 1. Company Information (inline-editable) ──────── */}
              <div className="detail-section">
                <h3>🏢 Company Information</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Company Name</span>
                    {renderEditableField('name', selectedAccount)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Website</span>
                    {renderEditableField('domain', selectedAccount)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Industry</span>
                    {renderEditableField('industry', selectedAccount)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Size</span>
                    {renderEditableField('size', selectedAccount)}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Location</span>
                    {renderEditableField('location', selectedAccount)}
                  </div>
                </div>
              </div>

              {/* ── 2. Description (inline-editable) ──────────────── */}
              <div className="detail-section">
                <h3>📝 Description</h3>
                {renderEditableField('description', selectedAccount)}
              </div>

              {/* ── 3. Active Deals (clickable → DealsView) ────────── */}
              <div className="detail-section">
                <h3>💼 Active Deals ({getAccountDeals(selectedAccount.id).length})</h3>
                {getAccountDeals(selectedAccount.id).length === 0 ? (
                  <p className="empty-message">No active deals</p>
                ) : (
                  <div className="linked-items-list">
                    {getAccountDeals(selectedAccount.id).map(deal => (
                      <div
                        key={deal.id}
                        className="linked-item linked-item--clickable"
                        onClick={() => nav('deals', { dealId: deal.id })}
                        title="Open deal"
                      >
                        <span className="item-icon">💼</span>
                        <div className="item-info">
                          <div className="item-name">{deal.name}</div>
                          <div className="item-meta">
                            ${parseFloat(deal.value || 0).toLocaleString()} · {deal.stage}
                            {deal.health && (
                              <span className={`acct-deal-health acct-deal-health--${deal.health}`}>
                                {deal.health}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="item-arrow">→</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── 4. Contacts (clickable → ContactsView) ─────────── */}
              <div className="detail-section">
                <h3>👤 Contacts ({getAccountContacts(selectedAccount.id).length})</h3>
                {getAccountContacts(selectedAccount.id).length === 0 ? (
                  <p className="empty-message">No contacts</p>
                ) : (
                  <div className="linked-items-list">
                    {getAccountContacts(selectedAccount.id).map(contact => (
                      <div
                        key={contact.id}
                        className="linked-item linked-item--clickable"
                        onClick={() => nav('contacts', { contactId: contact.id })}
                        title="Open contact"
                      >
                        <span className="item-icon">👤</span>
                        <div className="item-info">
                          <div className="item-name">
                            {contact.first_name} {contact.last_name}
                          </div>
                          <div className="item-meta">
                            {[contact.title, contact.email].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <span className="item-arrow">→</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── 5. Prospecting ─────────────────────────────────── */}
              <AccountProspectingSection accountId={selectedAccount.id} />

              {/* ── 6. Coverage Scorecard ──────────────────────────── */}
              <div className="detail-section">
                <CoverageScorecard accountId={selectedAccount.id} />
              </div>

              {/* ── 6. Quick Actions ────────────────────────────────── */}
              <div className="detail-section">
                <h3>⚡ Quick Actions</h3>
                <div className="quick-actions">
                  {selectedAccount.domain && (
                    <a href={`https://${selectedAccount.domain}`} target="_blank" rel="noopener noreferrer" className="btn-action">
                      🌐 Visit Website
                    </a>
                  )}
                  <button className="btn-action" onClick={() => { setEditingAccount(selectedAccount); setShowForm(true); }}>
                    ✏️ Edit in Form
                  </button>
                  <button className="btn-action btn-action--danger" onClick={() => handleDeleteAccount(selectedAccount.id)}>
                    🗑️ Delete Account
                  </button>
                </div>
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
          onClose={() => { setShowForm(false); setEditingAccount(null); }}
        />
      )}

      {/* CSV Import Modal */}
      {showImportModal && (
        <CSVImportModal
          entity="accounts"
          onImport={handleImportAccounts}
          onClose={() => setShowImportModal(false)}
        />
      )}
    </div>
  );
}

// ── Account Card ──────────────────────────────────────────────────────────────

function AccountCard({ account, deals, contacts, totalValue, onEdit, onDelete, onSelect, isSelected }) {
  const activeDeals = deals.filter(d => d.stage !== 'closed_won' && d.stage !== 'closed_lost');

  return (
    <div className={`account-card ${isSelected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="account-card-header">
        <div className="account-icon">
          {account.name.substring(0, 2).toUpperCase()}
        </div>
        <div className="account-actions">
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="icon-btn" title="Edit">✏️</button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="icon-btn" title="Delete">🗑️</button>
        </div>
      </div>
      <h3 className="account-name">{account.name}</h3>
      {account.industry && <p className="account-industry">{account.industry}</p>}
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
      {account.location && <p className="account-location">📍 {account.location}</p>}
    </div>
  );
}

// ── Account Prospecting Section ───────────────────────────────────────────────

function AccountProspectingSection({ accountId }) {
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    apiService.accountProspecting.getOverview(accountId)
      .then(res => {
        setProspects(res.data?.prospects || []);
      })
      .catch(() => setProspects([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  if (loading) return null;
  if (prospects.length === 0) return null;

  const STAGE_COLORS = {
    target: '#6b7280', researched: '#8b5cf6', contacted: '#3b82f6',
    engaged: '#0F9D8E', qualified: '#10b981', converted: '#059669',
    disqualified: '#ef4444', nurture: '#f59e0b',
  };

  return (
    <div className="detail-section">
      <h3>🎯 Prospecting ({prospects.length})</h3>
      <div className="linked-items-list">
        {prospects.map(p => (
          <div
            key={p.id}
            className="linked-item"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'prospecting' } }));
            }}
            style={{ cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600, fontSize: '13px' }}>{p.first_name} {p.last_name}</span>
              {p.title && <span style={{ fontSize: '11px', color: '#6b7280' }}>{p.title}</span>}
            </div>
            <span style={{
              fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
              background: (STAGE_COLORS[p.stage] || '#6b7280') + '20',
              color: STAGE_COLORS[p.stage] || '#6b7280',
            }}>
              {p.stage}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AccountsView;
