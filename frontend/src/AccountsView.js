import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import AccountForm from './AccountForm';
import AccountMergeBanner from './AccountMergeBanner';
import CoverageScorecard from './CoverageScorecard';
import { csvExport, EXPORT_COLUMNS } from './csvUtils';
import CSVImportModal from './CSVImportModal';
import StrapPanel from './StrapPanel';
import { OrgChartPanel } from './OrgChartPanel';
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
  const [detailTab, setDetailTab] = useState('overview'); // 'overview' | 'orgchart'

  // ── Scope toggle state ────────────────────────────────────────
  const [scope, setScope] = useState('mine');
  const [hasTeam, setHasTeam] = useState(false);

  // ── List filter tab ───────────────────────────────────────────
  // 'all' = every account in current scope
  // 'needs_review' = only accounts with needs_domain_review = TRUE
  const [filterTab, setFilterTab] = useState('all');
  const [counts, setCounts] = useState({ all: 0, needs_review: 0 });

  // ── Per-account enrichment state ──────────────────────────────
  // Map keyed by accountId with the most recent enrichment outcome.
  // Shape: { [id]: { status: 'loading'|'ok'|'error', message: string, ts: ms } }
  const [enrichState, setEnrichState] = useState({});

  useEffect(() => {
    apiService.orgAdmin.getMyTeam()
      .then(r => setHasTeam(r.data.hasTeam))
      .catch(() => setHasTeam(false));
  }, []);

  useEffect(() => { loadAccounts(); }, [scope, filterTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!openAccountId || accounts.length === 0) return;
    const target = accounts.find(a => a.id === openAccountId || a.id === parseInt(openAccountId));
    if (target) {
      setSelectedAccount(target);
      if (onAccountOpened) onAccountOpened();
    }
  }, [openAccountId, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setEditingField(null); setDetailTab('overview'); }, [selectedAccount?.id]);

  const loadAccounts = async () => {
    try {
      setLoading(true);
      setError('');
      const accountsCall = apiService.accounts.getAll({
        scope,
        needsReview: filterTab === 'needs_review',
      }).catch(() => ({ data: { accounts: mockData.accounts, counts: { all: 0, needs_review: 0 } } }));

      const [accountsRes, dealsRes, contactsRes] = await Promise.all([
        accountsCall,
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
      // Counts come back from the same API call so the tab labels stay
      // accurate without a second request. Defensive default keeps the
      // app working against older backends that haven't shipped counts yet.
      if (accountsRes.data.counts) {
        setCounts(accountsRes.data.counts);
      }
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

  // ── Per-account enrichment ───────────────────────────────────────────────
  //
  // Triggered from the "Enrich" button on cards in the Needs Review tab.
  // Posts to /accounts/:id/enrich-from-coresignal, which never overwrites
  // populated fields. On success the row's needs_domain_review flag is
  // typically cleared by the backend (when a real domain landed), so we
  // refresh the list to surface that state change.
  //
  // Failure reasons we surface as user-friendly text:
  //   not_found            - CoreSignal had no record for this company
  //   ambiguous            - multiple matches, can't safely pick
  //   no_identifier_on_account - row has neither LinkedIn URL nor real domain
  //   no_credits           - out of CoreSignal credits (operator concern)
  //   auth_failed          - API key issue (operator concern)
  //   *                    - generic transport/server error
  const handleEnrichAccount = async (accountId) => {
    setEnrichState(prev => ({ ...prev, [accountId]: { status: 'loading' } }));

    try {
      const response = await apiService.accounts.enrichFromCoresignal(accountId);
      const data = response.data || {};
      const fields = data.enriched ? Object.keys(data.enriched).filter(k => k !== 'needs_domain_review_cleared') : [];
      const cleared = data.enriched?.needs_domain_review_cleared;

      let message;
      if (fields.length === 0 && !cleared) {
        message = 'No new data — fields already populated.';
      } else {
        const fragments = [];
        if (cleared) fragments.push('domain resolved');
        if (fields.length > 0) fragments.push(`updated: ${fields.join(', ')}`);
        message = fragments.join(' · ');
      }

      setEnrichState(prev => ({
        ...prev,
        [accountId]: { status: 'ok', message, ts: Date.now() },
      }));
      // Reload to reflect cleared flag / new firmographics in the list and counts.
      loadAccounts();
    } catch (err) {
      const body = err?.response?.data || {};
      const reason = body.reason || 'unknown';
      const friendly = {
        not_found:                'CoreSignal had no match for this company.',
        ambiguous:                `Multiple candidates found${body.hit_count ? ` (${body.hit_count})` : ''}. Needs human review.`,
        no_identifier_on_account: 'No LinkedIn URL or real domain on this account.',
        no_credits:               'Out of CoreSignal credits.',
        auth_failed:              'CoreSignal auth failed — check API key.',
        rate_limited:             'CoreSignal rate-limited the request. Try again in a minute.',
        timeout:                  'CoreSignal timed out.',
        no_api_key:               'CoreSignal API key not configured.',
      }[reason] || `Enrichment failed: ${reason}`;
      setEnrichState(prev => ({
        ...prev,
        [accountId]: { status: 'error', message: friendly, ts: Date.now() },
      }));
    }
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

      {/* Filter tabs — All vs Needs Review.
          Counts come from the same API call as the list, so they stay
          accurate as enrichment clears the flag and rows drop out of
          the Needs Review bucket. */}
      <div style={{
        display: 'flex', gap: '0', marginBottom: '16px',
        borderBottom: '1px solid #e5e7eb',
      }}>
        {[
          { key: 'all',          label: 'All Accounts',  count: counts.all },
          { key: 'needs_review', label: 'Needs Review',  count: counts.needs_review },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setFilterTab(t.key)}
            style={{
              padding: '10px 16px',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${filterTab === t.key ? '#6366f1' : 'transparent'}`,
              color: filterTab === t.key ? '#6366f1' : '#64748b',
              fontWeight: filterTab === t.key ? 600 : 500,
              fontSize: '13px',
              cursor: 'pointer',
              marginBottom: '-1px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            {t.label}
            <span style={{
              padding: '1px 8px',
              borderRadius: '10px',
              background: filterTab === t.key ? '#eef2ff' : '#f1f5f9',
              color: filterTab === t.key ? '#6366f1' : '#64748b',
              fontSize: '11px',
              fontWeight: 600,
            }}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Accounts Container */}
      <div className="accounts-container">
        <div className="accounts-grid">
          {accounts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">{filterTab === 'needs_review' ? '✅' : '🏢'}</div>
              <h3>
                {filterTab === 'needs_review'
                  ? 'No accounts need review'
                  : 'No accounts yet'}
              </h3>
              <p>
                {filterTab === 'needs_review'
                  ? 'Every account in this scope has a real domain or has been resolved.'
                  : 'Create your first account to start managing deals and contacts'}
              </p>
              {filterTab !== 'needs_review' && (
                <button className="btn-primary" onClick={() => setShowForm(true)}>+ Create Account</button>
              )}
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
                onEnrich={() => handleEnrichAccount(account.id)}
                enrichState={enrichState[account.id]}
                showEnrich={filterTab === 'needs_review'}
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

            {/* ── Detail tab bar ──────────────────────────────────── */}
            <div style={{
              display: 'flex', borderBottom: '1px solid #e5e7eb',
              padding: '0 24px', background: '#fafafa', flexShrink: 0,
            }}>
              {[
                { key: 'overview', label: '📋 Overview' },
                { key: 'orgchart', label: '🌳 Org Chart' },
              ].map(t => (
                <button
                  key={t.key}
                  onClick={() => setDetailTab(t.key)}
                  style={{
                    padding: '10px 14px', background: 'none', border: 'none',
                    borderBottom: `2px solid ${detailTab === t.key ? '#6366f1' : 'transparent'}`,
                    color: detailTab === t.key ? '#6366f1' : '#64748b',
                    fontSize: '12px', fontWeight: detailTab === t.key ? 600 : 500,
                    cursor: 'pointer', marginBottom: '-1px', fontFamily: 'inherit',
                    transition: 'all 0.15s',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {detailTab === 'orgchart' ? (
              <OrgChartPanel
                accountId={selectedAccount.id}
                accountName={selectedAccount.name}
                allAccountContacts={getAccountContacts(selectedAccount.id)}
                onNavigateToContact={(contactId) => nav('contacts', { contactId })}
              />
            ) : (
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

              {/* ── 3. STRAP — Strategy & Action Plan ─────────── */}
              <div className="detail-section">
                <h3>🎯 STRAP — Strategy & Action Plan</h3>
                <StrapPanel entityType="account" entityId={selectedAccount.id} />
              </div>

              {/* ── 4. Active Deals (clickable → DealsView) ────────── */}
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

              {/* ── 5. Contacts (clickable → ContactsView) ─────────── */}
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

              {/* ── 6. Prospecting ─────────────────────────────────── */}
              <AccountProspectingSection accountId={selectedAccount.id} />

              {/* ── 7. Coverage Scorecard ──────────────────────────── */}
              <div className="detail-section">
                <CoverageScorecard accountId={selectedAccount.id} />
              </div>

              {/* ── 8. Quick Actions ────────────────────────────────── */}
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
            )} {/* end detailTab === 'overview' */}
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

function AccountCard({ account, deals, contacts, totalValue, onEdit, onDelete, onSelect, isSelected,
                       onEnrich, enrichState, showEnrich }) {
  const activeDeals = deals.filter(d => d.stage !== 'closed_won' && d.stage !== 'closed_lost');
  const isCatchall = account.domain === 'catchalldomain.com';

  // Status pill rendering — three states: 'loading', 'ok', 'error'.
  // Cleared after a successful reload (parent's loadAccounts) since the
  // row will either drop out of the Needs Review filter or get rerendered
  // with fresh data. We keep error states visible until the next attempt.
  const renderStatus = () => {
    if (!enrichState) return null;
    const palette = {
      loading: { bg: '#fef3c7', fg: '#92400e', text: 'Enriching…' },
      ok:      { bg: '#dcfce7', fg: '#166534', text: enrichState.message || 'Enriched' },
      error:   { bg: '#fee2e2', fg: '#991b1b', text: enrichState.message || 'Failed' },
    }[enrichState.status] || null;
    if (!palette) return null;
    return (
      <div style={{
        marginTop: '8px',
        padding: '6px 10px',
        background: palette.bg,
        color: palette.fg,
        borderRadius: '6px',
        fontSize: '11px',
        fontWeight: 500,
        lineHeight: 1.3,
      }}>
        {palette.text}
      </div>
    );
  };

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

      {/* Catchall domain badge — shown whenever the row is in placeholder
          state, regardless of which tab the user is on. Quick visual
          signal that this is unresolved data. */}
      {isCatchall && (
        <div style={{
          marginTop: '8px',
          padding: '4px 8px',
          background: '#fef3c7',
          color: '#92400e',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 500,
          display: 'inline-block',
        }}>
          ⚠ Domain unresolved
        </div>
      )}

      {/* Enrich button — only on the Needs Review tab to keep the All
          Accounts grid uncluttered. Once the row drops out of Needs
          Review (flag cleared), it stops showing this affordance. */}
      {showEnrich && onEnrich && (
        <button
          onClick={(e) => { e.stopPropagation(); onEnrich(); }}
          disabled={enrichState?.status === 'loading'}
          style={{
            marginTop: '10px',
            width: '100%',
            padding: '8px 12px',
            background: enrichState?.status === 'loading' ? '#e5e7eb' : '#6366f1',
            color: enrichState?.status === 'loading' ? '#6b7280' : '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            cursor: enrichState?.status === 'loading' ? 'not-allowed' : 'pointer',
          }}
        >
          {enrichState?.status === 'loading' ? 'Enriching…' : '✨ Enrich from CoreSignal'}
        </button>
      )}

      {renderStatus()}
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
    target: '#6b7280', research: '#8b5cf6', outreach: '#3b82f6',
    engaged: '#0F9D8E', discovery_call: '#f59e0b', qualified_sal: '#10b981',
    converted: '#059669', disqualified: '#ef4444', nurture: '#f59e0b',
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
